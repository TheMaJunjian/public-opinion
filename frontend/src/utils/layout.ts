/**
 * layout.ts — Core layout engine for the non-linear graph view.
 *
 * Extracted from GraphView.tsx to enable unit testing of the column-assignment
 * pipeline and 2D no-overlap layout algorithm.
 *
 * Exported functions (public API):
 *   computeMinColumnsForAnnoRefRule1    – Stage 1-①: ANNOTATION/REFERENCE column constraints
 *   applyReplyLayoutAdjustments         – Stage 1-②: REPLY column preferences + author-lane optimization
 *   applyAgreeDisagreeColumnOverride    – Stage 1-③: AGREE/DISAGREE column constraints
 *   applyGroupingColumnOverride         – Stage 1-④: ARRANGE/MERGE/CORRECT grouping column rules
 *
 * Internal helpers (exported for testing only):
 *   colX, unionBoxes, rectsOverlapX
 */

import type { DemoMessage, DemoEdge } from './modelBridge';
import type { PresentationKind } from '../types';
import { getPresentationSpec, PRESENTATION_SPECS } from '../types';

// ============================================================
// Layout Constants (canonical source — imported by GraphView.tsx)
// ============================================================

export const CARD_W = 320;
export const MIN_CARD_H = 86;
export const GRID_LEFT = 18;
export const GRID_TOP = 48;
export const COL_GAP = 100;
export const ROW_GAP = 38;
export const FRAME_PAD = 16;
export const CANVAS_BOTTOM_PAD = 120;
export const CANVAS_RIGHT_PAD = 120;
export const MERGE_CARD_H = 36;

export type LayoutBox = { x: number; y: number; width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

// ============================================================
// Shared helpers
// ============================================================

export function colX(col: number): number {
  return GRID_LEFT + col * (CARD_W + COL_GAP);
}

export function unionBoxes(boxes: LayoutBox[]): LayoutBox | null {
  if (boxes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function rectsOverlapX(a: Rect, b: Rect): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x);
}

function getRelKind(relType: string): PresentationKind {
  return getPresentationSpec(relType).kind;
}

function isDirectedEdgeRel(relType: string): boolean {
  return getRelKind(relType) === 'edge-label';
}

function isRightConstrainedEdgeRel(relType: string): boolean {
  return isDirectedEdgeRel(relType) && relType !== 'reply';
}

function isAnyFrameRel(relType: string): boolean {
  const k = getRelKind(relType);
  return k === 'arrange-frame' || k === 'frame-group' || k === 'replace-overlay';
}

function isCorrectionBadgeRel(relType: string): boolean {
  return getRelKind(relType) === 'correction-badge';
}

/**
 * Converge grouping-equality and right-of constraints on top of current columns.
 *
 * Priority model:
 *   1) Messages linked by groupSourceToTarget stay in the same column.
 *   2) annotation/reference/notify keep source >= target + 1.
 *
 * When an edge's source and target are already in the same grouping component,
 * its right-of constraint is skipped as contradictory.
 */
export function convergeGroupingAndRightConstraints(params: {
  normals: DemoMessage[];
  edges: DemoEdge[];
  col: Record<string, number>;
  groupSourceToTarget: Map<string, string>;
}): { col: Record<string, number>; maxCol: number } {
  const { normals, edges, groupSourceToTarget } = params;
  const col: Record<string, number> = { ...params.col };
  const normalSet = new Set(normals.map(m => m.id));

  const parent: Record<string, string> = {};
  for (const m of normals) parent[m.id] = m.id;
  const find = (x: string): string => {
    let p = parent[x] ?? x;
    while (p !== (parent[p] ?? p)) p = parent[p] ?? p;
    let cur = x;
    while ((parent[cur] ?? cur) !== p) {
      const next = parent[cur] ?? cur;
      parent[cur] = p;
      cur = next;
    }
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (const [srcId, tgtId] of groupSourceToTarget) {
    if (!normalSet.has(srcId) || !normalSet.has(tgtId)) continue;
    union(srcId, tgtId);
  }

  const equalNeighbors = new Map<string, string[]>();
  for (const [srcId, tgtId] of groupSourceToTarget) {
    if (!normalSet.has(srcId) || !normalSet.has(tgtId)) continue;
    const a = equalNeighbors.get(srcId) ?? [];
    a.push(tgtId);
    equalNeighbors.set(srcId, a);
    const b = equalNeighbors.get(tgtId) ?? [];
    b.push(srcId);
    equalNeighbors.set(tgtId, b);
  }

  const sourcesByTarget = new Map<string, string[]>();
  for (const e of edges) {
    const isRightConstraint =
      e.relationType === 'annotation' ||
      e.relationType === 'reference' ||
      e.relationType === 'notify';
    if (!isRightConstraint) continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    if (find(e.from.messageId) === find(e.to.messageId)) continue;
    const arr = sourcesByTarget.get(e.to.messageId) ?? [];
    arr.push(e.from.messageId);
    sourcesByTarget.set(e.to.messageId, arr);
  }

  const queue: string[] = normals.map(m => m.id);
  const queued = new Set(queue);
  let qi = 0;
  while (qi < queue.length) {
    const targetId = queue[qi++];
    const targetCol = col[targetId] ?? 0;

    const peers = equalNeighbors.get(targetId) ?? [];
    for (const peerId of peers) {
      if ((col[peerId] ?? 0) !== targetCol) {
        col[peerId] = targetCol;
        if (!queued.has(peerId)) {
          queued.add(peerId);
          queue.push(peerId);
        }
      }
    }

    const sources = sourcesByTarget.get(targetId) ?? [];
    for (const fromId of sources) {
      const need = targetCol + 1;
      if ((col[fromId] ?? 0) < need) {
        col[fromId] = need;
        if (!queued.has(fromId)) {
          queued.add(fromId);
          queue.push(fromId);
        }
      }
    }
  }

  const maxCol = Math.max(0, ...(Object.values(col).length ? Object.values(col) : [0]));
  return { col, maxCol };
}

// ============================================================
// Stage 1-①: ANNOTATION / REFERENCE column constraints
// ============================================================

/**
 * Compute minimum column assignments for annotation/reference/notify relations.
 *
 * Rules:
 *   - ANNOTATION source must be ≥ target col + 1 (source to the right of target)
 *   - REFERENCE source must be ≥ target col + 1
 *   - NOTIFY source must be ≥ target col + 1 (same spatial rule as REFERENCE)
 *   - When targeting a relation message, source must be to the right of the
 *     relation's rightmost normal-message endpoint.
 *
 * This is a fixed-point iteration because constraints can cascade:
 *   A → B (A right of B) ∧ B → C (B right of C) ⇒ A right of C.
 */
export function computeMinColumnsForAnnoRefRule1(
  normalIds: string[],
  edges: DemoEdge[],
  relIds: Set<string>,
): { col: Record<string, number>; maxCol: number } {
  const normalSet = new Set(normalIds);

  // annotation/reference/notify edges between two normal messages
  const relevant = edges.filter(
    (e) => isRightConstrainedEdgeRel(e.relationType) &&
      normalSet.has(e.from.messageId) && normalSet.has(e.to.messageId),
  );

  // annotation/reference/notify edges where target is a relation message
  const toRelEdges = edges.filter(
    (e) => isRightConstrainedEdgeRel(e.relationType) &&
      normalSet.has(e.from.messageId) && relIds.has(e.to.messageId),
  );

  // Pre-build relEdgesByRelMsg for relation-message endpoint lookup
  const relEdgesByRelMsg = new Map<string, DemoEdge[]>();
  for (const e of edges) {
    const arr = relEdgesByRelMsg.get(e.relationMessageId) ?? [];
    arr.push(e);
    relEdgesByRelMsg.set(e.relationMessageId, arr);
  }

  const col: Record<string, number> = {};
  for (const id of normalIds) col[id] = 0;

  let changed = true, iter = 0;
  while (changed && iter < 5000) {
    iter++; changed = false;

    // Constraint: source col ≥ target col + 1 for normal→normal edges
    for (const e of relevant) {
      const need = (col[e.to.messageId] ?? 0) + 1;
      if ((col[e.from.messageId] ?? 0) < need) { col[e.from.messageId] = need; changed = true; }
    }

    // Constraint: source targeting relation message must be right of relation's rightmost normal endpoint
    for (const e of toRelEdges) {
      const targetRelEdges = relEdgesByRelMsg.get(e.to.messageId) ?? [];
      let maxEndpointCol = -1;
      for (const te of targetRelEdges) {
        if (normalSet.has(te.from.messageId)) maxEndpointCol = Math.max(maxEndpointCol, col[te.from.messageId] ?? 0);
        if (normalSet.has(te.to.messageId)) maxEndpointCol = Math.max(maxEndpointCol, col[te.to.messageId] ?? 0);
      }
      if (maxEndpointCol < 0) continue;
      const need = maxEndpointCol + 1;
      if ((col[e.from.messageId] ?? 0) < need) { col[e.from.messageId] = need; changed = true; }
    }
  }

  if (iter >= 5000) {
    console.warn('Anno/Ref cycle detected; resetting all columns to 0.');
    for (const id of normalIds) col[id] = 0;
  }

  // Final pass: ensure every source is strictly right of its targets
  const targetsByFrom = new Map<string, string[]>();
  for (const e of relevant) {
    const arr = targetsByFrom.get(e.from.messageId) ?? [];
    arr.push(e.to.messageId);
    targetsByFrom.set(e.from.messageId, arr);
  }
  for (const e of toRelEdges) {
    const arr = targetsByFrom.get(e.from.messageId) ?? [];
    targetsByFrom.set(e.from.messageId, arr);
    const targetRelEdges = relEdgesByRelMsg.get(e.to.messageId) ?? [];
    for (const te of targetRelEdges) {
      if (normalSet.has(te.from.messageId) && !arr.includes(te.from.messageId)) arr.push(te.from.messageId);
      if (normalSet.has(te.to.messageId) && !arr.includes(te.to.messageId)) arr.push(te.to.messageId);
    }
  }
  for (const [fromId, toArr] of targetsByFrom) {
    let maxTarget = -Infinity;
    for (const t of toArr) maxTarget = Math.max(maxTarget, col[t] ?? 0);
    const need = maxTarget === -Infinity ? 0 : maxTarget + 1;
    if ((col[fromId] ?? 0) < need) col[fromId] = need;
  }

  // Normalize: shift all columns so the minimum is 0
  const minCol = Math.min(...Object.values(col));
  if (minCol !== 0) for (const id of normalIds) col[id] -= minCol;

  return { col, maxCol: Math.max(...Object.values(col)) };
}

// ============================================================
// Stage 1-②: REPLY column pref + author-lane optimization
// ============================================================

/**
 * Apply REPLY layout adjustments with author-lane optimization.
 *
 * Rules:
 *   - REPLY source col ≥ target col + 1 (same as anno/ref constraint)
 *   - Same-author replies prefer the same or adjacent column (author-lane)
 *   - Reply-to-relation constraints: source must be right of the relation's endpoints
 *
 * The author-lane optimization scores candidate columns by:
 *   1. Whether it increases maxCol
 *   2. Maximum distance to any target
 *   3. Sum of distances to all targets
 *   4. Whether it's the author's preferred lane
 *   5. Whether it matches the author's previous lane
 */
export function applyReplyLayoutAdjustments(params: {
  normals: DemoMessage[];
  edges: DemoEdge[];
  baseCol: Record<string, number>;
  baseMaxCol: number;
  relIds: Set<string>;
}): { col: Record<string, number>; maxCol: number } {
  const { normals, edges, baseCol, baseMaxCol, relIds } = params;
  const col: Record<string, number> = { ...baseCol };
  let maxCol = baseMaxCol;
  const normalSet = new Set(normals.map(m => m.id));
  const msgById = new Map(normals.map(m => [m.id, m]));

  // Minimum allowed column per message (anno/ref constraints carry over)
  const minAllowed: Record<string, number> = {};
  for (const m of normals) minAllowed[m.id] = baseCol[m.id] ?? 0;

  // Enforce anno/ref minimums
  for (const e of edges) {
    if (!(e.relationType === 'annotation' || e.relationType === 'reference')) continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    const need = (col[e.to.messageId] ?? 0) + 1;
    minAllowed[e.from.messageId] = Math.max(minAllowed[e.from.messageId] ?? 0, need);
  }

  // Reply-to-relation constraint
  const relEdgesByRelMsg = new Map<string, DemoEdge[]>();
  for (const e of edges) {
    const arr = relEdgesByRelMsg.get(e.relationMessageId) ?? [];
    arr.push(e);
    relEdgesByRelMsg.set(e.relationMessageId, arr);
  }
  for (const e of edges) {
    if (e.relationType !== 'reply') continue;
    if (!normalSet.has(e.from.messageId)) continue;
    if (!relIds.has(e.to.messageId)) continue;
    const targetRelEdges = relEdgesByRelMsg.get(e.to.messageId) ?? [];
    for (const te of targetRelEdges) {
      if (normalSet.has(te.from.messageId)) {
        const need = (col[te.from.messageId] ?? 0) + 1;
        minAllowed[e.from.messageId] = Math.max(minAllowed[e.from.messageId] ?? 0, need);
      }
      if (normalSet.has(te.to.messageId)) {
        const need = (col[te.to.messageId] ?? 0) + 1;
        minAllowed[e.from.messageId] = Math.max(minAllowed[e.from.messageId] ?? 0, need);
      }
    }
  }

  // Build reply target map
  const replyTargetsByFrom = new Map<string, string[]>();
  for (const e of edges.filter(e => e.relationType === 'reply')) {
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    if (!replyTargetsByFrom.has(e.from.messageId)) replyTargetsByFrom.set(e.from.messageId, []);
    replyTargetsByFrom.get(e.from.messageId)!.push(e.to.messageId);
  }

  // Mode function — most frequent value
  function mode(nums: number[]): number {
    const cnt = new Map<number, number>();
    for (const n of nums) cnt.set(n, (cnt.get(n) ?? 0) + 1);
    let best = nums[0] ?? 0, bestC = -1;
    for (const [k, c] of cnt) if (c > bestC || (c === bestC && k < best)) { best = k; bestC = c; }
    return best;
  }

  // Author anchor: the mode column for each author
  const byAuthor = new Map<string, number[]>();
  for (const m of normals) {
    const arr = byAuthor.get(m.author) ?? [];
    arr.push(baseCol[m.id] ?? 0);
    byAuthor.set(m.author, arr);
  }
  const authorAnchor: Record<string, number> = {};
  for (const [author, colsArr] of byAuthor) authorAnchor[author] = mode(colsArr);

  // Track previous lane per author
  const authorPrevLane: Record<string, number | null> = {};
  for (const a of Object.keys(authorAnchor)) authorPrevLane[a] = null;

  // Process reply sources in creation-time order
  const replyFromIds = Array.from(replyTargetsByFrom.keys());
  replyFromIds.sort((a, b) => {
    const ta = new Date(msgById.get(a)?.createdAt ?? 0).getTime();
    const tb = new Date(msgById.get(b)?.createdAt ?? 0).getTime();
    return ta !== tb ? ta - tb : a.localeCompare(b);
  });

  // Scoring comparator: lower is better
  function better(a: any, b: any): boolean {
    if (!b) return true; if (!a) return false;
    for (const k of ['incMax', 'maxDist', 'sumDist', 'inLane', 'stable', 'c']) {
      if (a[k] < b[k]) return true; if (a[k] > b[k]) return false;
    }
    return false;
  }

  for (const fromId of replyFromIds) {
    const fromMsg = msgById.get(fromId);
    if (!fromMsg) continue;
    const targets = replyTargetsByFrom.get(fromId) ?? [];
    const targetCols = targets.filter(t => normalSet.has(t)).map(t => col[t] ?? baseCol[t] ?? 0);
    const forbidden = new Set<number>(targetCols);
    const baseMin = minAllowed[fromId] ?? baseCol[fromId] ?? 0;
    const anchor = authorAnchor[fromMsg.author] ?? baseMin;
    const prevLane = authorPrevLane[fromMsg.author] ?? null;

    // Generate candidate columns
    const candidates: number[] = [];
    if (prevLane !== null) candidates.push(Math.max(baseMin, prevLane));
    candidates.push(Math.max(baseMin, anchor), Math.max(baseMin, anchor + 1));
    if (targetCols.length > 0) {
      const med = [...targetCols].sort((a, b) => a - b)[Math.floor(targetCols.length / 2)];
      candidates.push(Math.max(baseMin, med), Math.max(baseMin, med + 1), Math.max(baseMin, med - 1));
    }
    for (let d = 0; d <= 6; d++) candidates.push(Math.max(baseMin, anchor - d), Math.max(baseMin, anchor + d), baseMin + d);

    const uniq: number[] = [];
    const seen = new Set<number>();
    for (const c0 of candidates) {
      const c = Math.max(baseMin, c0);
      if (!seen.has(c)) { seen.add(c); uniq.push(c); }
    }

    const scoreCandidate = (c: number) => {
      if (c < baseMin || forbidden.has(c)) return null;
      const maxDist = targetCols.length === 0 ? 0 : Math.max(...targetCols.map(a => Math.abs(c - a)));
      const sumDist = targetCols.reduce((s, t) => s + Math.abs(c - t), 0);
      const inLane = (c === anchor || c === anchor + 1) ? 0 : 1;
      const stable = (prevLane !== null && c === prevLane) ? 0 : 1;
      const incMax = c > maxCol ? c - maxCol : 0;
      return { incMax, maxDist, sumDist, inLane, stable, c };
    };

    let bestScore: any = null, bestC: number | null = null;
    for (const c of uniq) {
      const sc = scoreCandidate(c);
      if (sc && better(sc, bestScore)) { bestScore = sc; bestC = c; }
    }
    if (bestC === null) {
      let c = Math.max(baseMin, maxCol + 1);
      while (forbidden.has(c)) c++;
      bestC = c;
    }
    col[fromId] = bestC;
    maxCol = Math.max(maxCol, bestC);
    authorPrevLane[fromMsg.author] = bestC;
  }

  // If an annotation or reference source moved right, dependent sources must
  // also stay to its right. Reply edges intentionally do not cascade here:
  // a later reply by the same author may return to that author's lane.
  const sourcesByTarget = new Map<string, string[]>();
  for (const e of edges) {
    if (!isRightConstrainedEdgeRel(e.relationType)) continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    const arr = sourcesByTarget.get(e.to.messageId) ?? [];
    arr.push(e.from.messageId);
    sourcesByTarget.set(e.to.messageId, arr);
  }

  const queue: string[] = [];
  const queued = new Set<string>();
  for (const m of normals) {
    const id = m.id;
    if ((col[id] ?? 0) > (baseCol[id] ?? 0)) {
      queue.push(id);
      queued.add(id);
    }
  }

  let qi = 0;
  while (qi < queue.length) {
    const targetId = queue[qi++];
    const targetCol = col[targetId] ?? 0;
    const sources = sourcesByTarget.get(targetId) ?? [];
    for (const fromId of sources) {
      const need = targetCol + 1;
      if ((col[fromId] ?? 0) < need) {
        col[fromId] = need;
        maxCol = Math.max(maxCol, need);
        if (!queued.has(fromId)) {
          queued.add(fromId);
          queue.push(fromId);
        }
      }
    }
  }

  return { col, maxCol };
}

// ============================================================
// Stage 1-③: AGREE / DISAGREE column constraints
// ============================================================

/**
 * Apply AGREE/DISAGREE column override.
 *
 * Rules:
 *   - AGREE source → target col - 1 (support source stays on target's left)
 *   - DISAGREE source → target col + 1 (visually contrasted, "I oppose")
 *   - If AGREE target is too far left to host a left-side source, shift target right
 *     and cascade that shift to right-constrained dependents (anno/ref/notify/reply)
 *   - Right-side constraints are respected (source cannot be left of its right-constrained targets)
 *   - Pure-stance (anon: source) and relation-message targets are skipped
 */
export function applyAgreeDisagreeColumnOverride(params: {
  normals: DemoMessage[];
  edges: DemoEdge[];
  col: Record<string, number>;
  maxCol: number;
}): { col: Record<string, number>; maxCol: number } {
  const { normals, edges } = params;
  const col = { ...params.col };
  let maxCol = params.maxCol;
  const normalSet = new Set(normals.map(m => m.id));

  // Pre-compute right-side minimum column for each message.
  // For x -> y in anno/ref/notify/reply, x must be >= y + 1.
  const rightMinCol: Record<string, number> = {};
  const rightSourcesByTarget = new Map<string, string[]>();
  for (const e of edges) {
    if (!isDirectedEdgeRel(e.relationType)) continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    const need = (col[e.to.messageId] ?? 0) + 1;
    rightMinCol[e.from.messageId] = Math.max(rightMinCol[e.from.messageId] ?? 0, need);
    const arr = rightSourcesByTarget.get(e.to.messageId) ?? [];
    arr.push(e.from.messageId);
    rightSourcesByTarget.set(e.to.messageId, arr);
  }

  // If a target moves right, all right-constrained sources that point to it
  // must stay on its right; propagate transitively.
  const propagateRightDependents = (startTargetIds: string[]) => {
    const queue = [...startTargetIds];
    const queued = new Set(queue);
    let qi = 0;
    while (qi < queue.length) {
      const targetId = queue[qi++];
      const targetCol = col[targetId] ?? 0;
      const sources = rightSourcesByTarget.get(targetId) ?? [];
      for (const fromId of sources) {
        const need = targetCol + 1;
        if ((col[fromId] ?? 0) < need) {
          col[fromId] = need;
          maxCol = Math.max(maxCol, need);
          if (!queued.has(fromId)) {
            queued.add(fromId);
            queue.push(fromId);
          }
        }
      }
    }
  };

  const stanceEdges = edges.filter(e => e.relationType === 'agree' || e.relationType === 'disagree');
  for (const e of stanceEdges) {
    const fromId = e.from.messageId, toId = e.to.messageId;
    if (!normalSet.has(fromId) || !normalSet.has(toId)) continue;

    if (e.relationType === 'agree') {
      // AGREE source must stay exactly one column left of target.
      // If target is too far left (or source has right-min constraints),
      // move target right first and cascade dependent right-side constraints.
      const minFrom = rightMinCol[fromId] ?? 0;
      const requiredTargetCol = minFrom + 1;
      const currentTargetCol = col[toId] ?? 0;
      if (currentTargetCol < requiredTargetCol) {
        col[toId] = requiredTargetCol;
        maxCol = Math.max(maxCol, requiredTargetCol);
        propagateRightDependents([toId]);
      }

      const finalTargetCol = col[toId] ?? 0;
      const newFromCol = Math.max(0, finalTargetCol - 1);
      const prevFromCol = col[fromId] ?? 0;
      col[fromId] = newFromCol;
      if (newFromCol > prevFromCol) {
        maxCol = Math.max(maxCol, newFromCol);
        propagateRightDependents([fromId]);
      }
      continue;
    }

    // DISAGREE source stays one column right of target.
    const tgtCol = col[toId] ?? 0;
    const desired = tgtCol + 1;
    const prevFromCol = col[fromId] ?? 0;
    col[fromId] = Math.max(desired, rightMinCol[fromId] ?? 0);
    maxCol = Math.max(maxCol, col[fromId]);
    if (col[fromId] > prevFromCol) {
      propagateRightDependents([fromId]);
    }
  }

  return { col, maxCol };
}

// ============================================================
// Stage 1-④: Grouping column override (ARRANGE / MERGE / CORRECT)
// ============================================================

/**
 * Apply high-priority grouping column rules.
 *
 * Applies to: ARRANGE (arrange-frame), MERGE (frame-group), CORRECT (correction-badge).
 *
 * Rules:
 *   - Source message → same column as its first target (zero-gap stacking)
 *   - Multi-target framing (no source): targets chain to the same column (except MERGE)
 *   - CORRECT: source-replacement stacks directly on top of the corrected target
 *
 * Merge frames are excluded from target chaining — they preserve natural multi-column layout.
 */
export function applyGroupingColumnOverride(params: {
  normals: DemoMessage[];
  edges: DemoEdge[];
  col: Record<string, number>;
  maxCol: number;
}): { col: Record<string, number>; maxCol: number; groupSourceToTarget: Map<string, string> } {
  const { normals, edges } = params;
  const col = { ...params.col };
  const normalSet = new Set(normals.map(m => m.id));
  const msgById = new Map(normals.map(m => [m.id, m]));

  const createdAtMs = (messageId: string): number => {
    const raw = msgById.get(messageId)?.createdAt;
    if (!raw) return Number.POSITIVE_INFINITY;
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };

  // Map: "child" message → "parent" message it should stack below
  const groupSourceToTarget = new Map<string, string>();

  // Source → first target (for arrange, correct with real source)
  for (const e of edges) {
    if (!isAnyFrameRel(e.relationType) && !isCorrectionBadgeRel(e.relationType)) {
      // Also group targets for custom relation types (e.g. 'supp').
      // These form frames but aren't in PRESENTATION_SPECS.
      const isCustomType = !(e.relationType in PRESENTATION_SPECS || e.relationType.toUpperCase() in PRESENTATION_SPECS);
      if (!isCustomType || !normalSet.has(e.to.messageId)) continue;
      // Custom types that target text messages → group like arrange
      if (!normalSet.has(e.from.messageId) && !e.from.messageId.startsWith('anon:')) continue;
    }
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    if (!groupSourceToTarget.has(e.from.messageId)) {
      groupSourceToTarget.set(e.from.messageId, e.to.messageId);
    }
  }

  // Frame targets chain: target[i] → target[i-1] (except merge)
  const frameTargetsByRelMsg = new Map<string, { targetIds: string[]; relationType: string }>();
  for (const e of edges) {
    if (!isAnyFrameRel(e.relationType) && !isCorrectionBadgeRel(e.relationType)) {
      const isCustomType = !(e.relationType in PRESENTATION_SPECS || e.relationType.toUpperCase() in PRESENTATION_SPECS);
      if (!isCustomType) continue;
    }
    if (!normalSet.has(e.to.messageId)) continue;
    const entry = frameTargetsByRelMsg.get(e.relationMessageId) ?? { targetIds: [], relationType: e.relationType };
    entry.targetIds.push(e.to.messageId);
    frameTargetsByRelMsg.set(e.relationMessageId, entry);
  }
  for (const [, { targetIds, relationType }] of frameTargetsByRelMsg) {
    if (relationType === 'merge') continue;
    if (targetIds.length < 2) continue;
    targetIds.sort((a, b) => createdAtMs(a) - createdAtMs(b));
    for (let i = 1; i < targetIds.length; i++) {
      if (!groupSourceToTarget.has(targetIds[i])) {
        groupSourceToTarget.set(targetIds[i], targetIds[i - 1]);
      }
    }
  }

  // Propagate columns: each chained message gets the same column as its anchor
  let changed = true, iter = 0;
  while (changed && iter < 1000) {
    changed = false; iter++;
    for (const [srcId, tgtId] of groupSourceToTarget) {
      const tgtCol = col[tgtId] ?? 0;
      if ((col[srcId] ?? 0) !== tgtCol) { col[srcId] = tgtCol; changed = true; }
    }
  }

  const converged = convergeGroupingAndRightConstraints({
    normals,
    edges,
    col,
    groupSourceToTarget,
  });

  // A later grouping pass may have pushed a reply source along the edge chain.
  // Restore the author's lane after structural convergence, while preserving
  // explicit grouping and non-reply right-side constraints.
  const replySources = new Set<string>();
  const replyTargetsBySource = new Map<string, number[]>();
  for (const e of edges) {
    if (e.relationType !== 'reply' || !normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    replySources.add(e.from.messageId);
    const targets = replyTargetsBySource.get(e.from.messageId) ?? [];
    targets.push(converged.col[e.to.messageId] ?? 0);
    replyTargetsBySource.set(e.from.messageId, targets);
  }
  const authorColumns = new Map<string, number[]>();
  for (const message of normals) {
    const columns = authorColumns.get(message.author) ?? [];
    columns.push(converged.col[message.id] ?? 0);
    authorColumns.set(message.author, columns);
  }
  const authorLane = (columns: number[]): number => {
    const counts = new Map<number, number>();
    for (const column of columns) counts.set(column, (counts.get(column) ?? 0) + 1);
    let best = columns[0] ?? 0;
    for (const [column, count] of counts) {
      if (count > (counts.get(best) ?? 0) || (count === (counts.get(best) ?? 0) && column < best)) best = column;
    }
    return best;
  };
  for (const message of normals) {
    if (!replySources.has(message.id) || groupSourceToTarget.has(message.id)) continue;
    const targetColumns = replyTargetsBySource.get(message.id) ?? [];
    const forbidden = new Set(targetColumns);
    const lane = authorLane(authorColumns.get(message.author) ?? [0]);
    if (forbidden.has(lane)) continue;
    let preferred = lane;
    while (forbidden.has(preferred)) preferred++;
    const minColumn = edges
      .filter(e => (e.relationType === 'annotation' || e.relationType === 'reference' || e.relationType === 'notify') && e.from.messageId === message.id && normalSet.has(e.to.messageId))
      .reduce((min, e) => Math.max(min, (converged.col[e.to.messageId] ?? 0) + 1), 0);
    converged.col[message.id] = Math.max(preferred, minColumn);
  }
  const maxCol = Math.max(0, ...Object.values(converged.col));
  return { col: converged.col, maxCol, groupSourceToTarget };
}

// ============================================================
// Stage 2: 2D no-overlap layout (standalone cards, no frames)
// ============================================================

/**
 * Compute no-overlap (x, y) positions for standalone message cards.
 *
 * This is a simplified extract from computeNoOverlapLayout in GraphView.tsx,
 * handling only cards without frame blocks. It captures the essential
 * collision-avoidance algorithm.
 *
 * Each card's actual width is taken from measuredWidths (falls back to CARD_W).
 * The column lane pitch (colX spacing) remains CARD_W + COL_GAP regardless of
 * individual card widths — wider cards simply use more of their lane, narrower
 * cards leave more gap.  This keeps the discrete-column pipeline (Stage 1)
 * unchanged while allowing per-card width variation in Stage 2.
 *
 * Algorithm:
 *   1. Sort cards by creation time (oldest first — "meeting order")
 *   2. For each card, find the first y position in its assigned column
 *      that doesn't overlap with any previously placed card
 *   3. Two cards overlap if their x-ranges intersect
 *
 * Returns layout positions and canvas dimensions.
 */
export function computeSimpleNoOverlapLayout(params: {
  normals: DemoMessage[];
  colOf: Record<string, number>;
  maxCol: number;
  measuredHeights?: Record<string, number>;
  measuredWidths?: Record<string, number>;
}): { layout: Record<string, LayoutBox>; canvasWidth: number; canvasHeight: number } {
  const { normals, colOf, maxCol } = params;
  const measuredHeights = params.measuredHeights ?? {};
  const measuredWidths = params.measuredWidths ?? {};

  const layout: Record<string, LayoutBox> = {};
  const placedRects: Rect[] = [];

  function cardHeight(id: string): number {
    return Math.max(MIN_CARD_H, measuredHeights[id] ?? MIN_CARD_H);
  }

  function cardWidth(id: string): number {
    return Math.max(CARD_W, measuredWidths[id] ?? CARD_W);
  }

  function findY(x: number, w: number): number {
    let y = GRID_TOP;
    for (const r of placedRects) {
      // Skip rects that don't overlap horizontally
      if (x + w <= r.x || r.x + r.width <= x) continue;
      y = Math.max(y, r.y + r.height + ROW_GAP);
    }
    return y;
  }

  // Sort by creation time (oldest at top — meeting-speak-order)
  const sorted = [...normals].sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    return ta !== tb ? ta - tb : a.id.localeCompare(b.id);
  });

  let maxBottom = GRID_TOP;

  for (const m of sorted) {
    const col = colOf[m.id] ?? 0;
    const h = cardHeight(m.id);
    const w = cardWidth(m.id);
    const x = colX(col);
    const y = findY(x, w);
    layout[m.id] = { x, y, width: w, height: h };
    placedRects.push({ x, y, width: w, height: h });
    maxBottom = Math.max(maxBottom, y + h);
  }

  // Canvas width uses lane pitch (CARD_W + COL_GAP), not max card width,
  // because colX positions are based on the fixed grid.  Individual cards
  // may be wider or narrower without changing the grid structure.
  const canvasWidth = GRID_LEFT + (maxCol + 1) * CARD_W + maxCol * COL_GAP + CANVAS_RIGHT_PAD;
  const canvasHeight = maxBottom + CANVAS_BOTTOM_PAD;

  return { layout, canvasWidth, canvasHeight };
}

/**
 * Verify that no two cards in the layout overlap (intersect both x and y axes).
 * Returns a list of overlapping pairs, or empty array if layout is valid.
 */
export function findOverlaps(layout: Record<string, LayoutBox>): { id1: string; id2: string }[] {
  const entries = Object.entries(layout);
  const overlaps: { id1: string; id2: string }[] = [];

  for (let i = 0; i < entries.length; i++) {
    const [id1, a] = entries[i];
    for (let j = i + 1; j < entries.length; j++) {
      const [id2, b] = entries[j];
      const overlapX = !(a.x + a.width <= b.x || b.x + b.width <= a.x);
      const overlapY = !(a.y + a.height <= b.y || b.y + b.height <= a.y);
      if (overlapX && overlapY) {
        overlaps.push({ id1, id2 });
      }
    }
  }

  return overlaps;
}

/**
 * Verify same-column cards are stacked in chronological order (oldest on top).
 */
export function verifyColumnOrder(
  layout: Record<string, LayoutBox>,
  normals: DemoMessage[],
  colOf: Record<string, number>,
): { col: number; violations: string[] }[] {
  const byCol = new Map<number, { id: string; y: number; createdAt: number }[]>();
  for (const m of normals) {
    const box = layout[m.id];
    if (!box) continue;
    const col = colOf[m.id] ?? 0;
    const arr = byCol.get(col) ?? [];
    arr.push({ id: m.id, y: box.y, createdAt: new Date(m.createdAt).getTime() });
    byCol.set(col, arr);
  }

  const issues: { col: number; violations: string[] }[] = [];
  for (const [col, cards] of byCol) {
    cards.sort((a, b) => a.y - b.y);
    const violations: string[] = [];
    for (let i = 1; i < cards.length; i++) {
      // Earlier (higher up) card should have earlier creation time
      // But allow same-time (e.g., batch operations)
      if (cards[i].createdAt < cards[i - 1].createdAt - 1000) { // 1s tolerance
        violations.push(
          `${cards[i - 1].id}(t=${cards[i - 1].createdAt},y=${cards[i - 1].y}) above ` +
          `${cards[i].id}(t=${cards[i].createdAt},y=${cards[i].y})`,
        );
      }
    }
    if (violations.length > 0) {
      issues.push({ col, violations });
    }
  }

  return issues;
}

// ============================================================
// Stage 1½: Frame-aware column correction (two-pass layout)
// ============================================================

/**
 * After the first layout pass produces frame rects, correct column assignments
 * for sources that annotate/reference/notify/reply-to relation messages (frames).
 *
 * Problem: Stage 1 column pipeline uses discrete column numbers derived from
 * frame endpoints (e.g. m5, m6 for frame r10). But the actual frame may be much
 * wider than a single lane — e.g. a horizontal arrange frame spans 2+ columns.
 * A source that targets this frame must be placed strictly to the right of the
 * frame's visual right edge, not just to the right of its rightmost endpoint.
 *
 * CRITICAL: This function does NOT re-apply all anno/ref constraints from
 * scratch.  Stage 1 already resolved those (including cycle detection).
 * We ONLY propagate from messages whose columns changed due to frame-based
 * corrections — never from messages that were unaffected.
 *
 * Algorithm:
 *   1. For each anno/ref/notify/reply edge targeting a relation message with a frame rect,
 *      compute minCol = ⌈(frame.right + COL_GAP - GRID_LEFT) / (CARD_W + COL_GAP)⌉
 *   2. Apply frame-based minimums; track which sources changed → dirty set
 *   3. Propagate ONLY from dirty sources: if B.col increased, any A with
 *      A→B (anno/ref/reply text→text) must be ≥ B.col+1
 *   4. Repeat until stable
 */
export function computeFrameAwareColumnCorrection(params: {
  normals: DemoMessage[];
  edges: DemoEdge[];
  colOf: Record<string, number>;
  maxCol: number;
  frameRects: Record<string, Rect>;
}): { col: Record<string, number>; maxCol: number } {
  const { normals, edges, maxCol, frameRects } = params;
  const normalSet = new Set(normals.map(m => m.id));
  const col: Record<string, number> = { ...params.colOf };

  // ── Step 1: compute frame-based minimum columns ──
  const frameMinCol: Record<string, number> = {};
  for (const e of edges) {
    const isRelevantRel =
      e.relationType === 'annotation' ||
      e.relationType === 'reference' ||
      e.relationType === 'notify' ||
      e.relationType === 'reply';
    if (!isRelevantRel) continue;
    if (!normalSet.has(e.from.messageId)) continue;
    const fr = frameRects[e.to.messageId];
    if (!fr) continue;

    // Source card's left edge must be ≥ frame right edge (colX guarantees non-overlap)
    const minX = fr.x + fr.width;
    const minC = Math.ceil((minX - GRID_LEFT) / (CARD_W + COL_GAP));
    frameMinCol[e.from.messageId] = Math.max(frameMinCol[e.from.messageId] ?? 0, minC);
  }

  // ── Step 2: apply frame-based mins, track dirty sources ──
  const dirty = new Set<string>();
  for (const [id, minC] of Object.entries(frameMinCol)) {
    if ((col[id] ?? 0) < minC) { col[id] = minC; dirty.add(id); }
  }

  if (dirty.size === 0) {
    return { col: { ...params.colOf }, maxCol: params.maxCol };
  }

  // ── Step 3: propagate only from dirty sources ──
  // Build reverse index: targetId → list of edges where from→target
  // Only for anno/ref/notify/reply edges where both ends are normal text messages.
  const sourcesByTarget = new Map<string, { fromId: string; edge: DemoEdge }[]>();
  for (const e of edges) {
    const isRelevant =
      e.relationType === 'annotation' ||
      e.relationType === 'reference' ||
      e.relationType === 'notify' ||
      e.relationType === 'reply';
    if (!isRelevant) continue;
    if (!normalSet.has(e.from.messageId)) continue;
    if (!normalSet.has(e.to.messageId)) continue;
    const arr = sourcesByTarget.get(e.to.messageId) ?? [];
    arr.push({ fromId: e.from.messageId, edge: e });
    sourcesByTarget.set(e.to.messageId, arr);
  }

  // BFS-style propagation: when a target's column increases,
  // all sources pointing to it must be ≥ target+1
  const queue = [...dirty];
  let qi = 0;
  while (qi < queue.length) {
    const targetId = queue[qi++];
    const targetCol = col[targetId] ?? 0;
    const sources = sourcesByTarget.get(targetId) ?? [];
    for (const { fromId } of sources) {
      const need = targetCol + 1;
      if ((col[fromId] ?? 0) < need) {
        col[fromId] = need;
        if (!dirty.has(fromId)) {
          dirty.add(fromId);
          queue.push(fromId);
        }
      }
    }
  }

  const newMaxCol = Math.max(maxCol, 0, ...Object.values(col));
  return { col, maxCol: newMaxCol };
}

// ============================================================
// Stage 2½: Compact anno/ref source clusters toward targets
// ============================================================

/**
 * After layout, shift anno/ref source clusters vertically toward their targets.
 *
 * Goal: sources annotating/referencing the same target should form a tight
 * vertical cluster aligned with the target's top edge, minimizing the visual
 * distance between the target and all its annotations.
 *
 * Algorithm per cluster (same column, same target):
 *   1. Sort sources by current y (preserving chronological order)
 *   2. Compute total cluster height (cards + gaps)
 *   3. Position middle card's top = targetY; cards above/below stack accordingly
 *   4. Constrain: can't go above GRID_TOP or above unrelated cards in same column
 *   5. If the source is blocked below, move a movable target and its followers
 *      by the same amount instead of leaving a long vertical edge
 *   6. Apply the shift — compact toward target regardless of direction
 */
export function compactAnnoRefClusters(params: {
  layout: Record<string, LayoutBox>;
  normals: DemoMessage[];
  colOf: Record<string, number>;
  edges: DemoEdge[];
  allFrameRects: Record<string, Rect>;
  frameMemberIds?: Set<string>;
  canvasHeight: number;
}): { layout: Record<string, LayoutBox>; canvasHeight: number } {
  const { normals, colOf, edges, allFrameRects, frameMemberIds = new Set<string>() } = params;
  const nextLayout: Record<string, LayoutBox> = {};
  for (const [id, box] of Object.entries(params.layout)) nextLayout[id] = { ...box };

  const normalSet = new Set(normals.map(m => m.id));
  const normalIds = normals.map(m => m.id);

  // ── Collect anno/ref edges targeting text messages or frames ──
  // Skip sources that are inside any frame — their positions are managed
  // by the frame's internal layout, not by standalone compaction.
  // Group: targetId → { sources: {messageId, edge}[], isFrameTarget: bool }
  const targetGroups = new Map<string, { sources: { messageId: string; edge: DemoEdge }[]; isFrame: boolean }>();
  for (const e of edges) {
    if (!isDirectedEdgeRel(e.relationType)) continue;
    if (!normalSet.has(e.from.messageId)) continue;
    const tgtIsNormal = normalSet.has(e.to.messageId);
    const tgtIsFrame = !!allFrameRects[e.to.messageId];
    if (!tgtIsNormal && !tgtIsFrame) continue;

    // Skip sources inside frames — frame membership is authoritative even if
    // a transient layout pass has placed the card outside the frame rect.
    if (frameMemberIds.has(e.from.messageId)) continue;
    const srcBox = nextLayout[e.from.messageId];
    if (srcBox) {
      let insideFrame = false;
      for (const fr of Object.values(allFrameRects)) {
        if (srcBox.x + srcBox.width <= fr.x || fr.x + fr.width <= srcBox.x) continue;
        if (srcBox.y + srcBox.height <= fr.y || fr.y + fr.height <= srcBox.y) continue;
        insideFrame = true; break;
      }
      if (insideFrame) continue;
    }

    const group = targetGroups.get(e.to.messageId) ?? { sources: [], isFrame: tgtIsFrame };
    group.sources.push({ messageId: e.from.messageId, edge: e });
    targetGroups.set(e.to.messageId, group);
  }

  if (targetGroups.size === 0) return { layout: nextLayout, canvasHeight: params.canvasHeight };

  const relatedIds = new Set<string>();
  for (const [targetId, group] of targetGroups) {
    if (normalSet.has(targetId)) relatedIds.add(targetId);
    for (const source of group.sources) relatedIds.add(source.messageId);
  }

  const overlaps = (box: LayoutBox, rect: Rect) =>
    box.x + box.width > rect.x && rect.x + rect.width > box.x &&
    box.y + box.height > rect.y && rect.y + rect.height > box.y;
  const isMovable = (id: string) => {
    const box = nextLayout[id];
    if (!box || !relatedIds.has(id) || frameMemberIds.has(id)) return false;
    return !Object.values(allFrameRects).some(rect => overlaps(box, rect));
  };
  const centerOf = (id: string): number | null => {
    const box = nextLayout[id];
    if (box) return box.y + box.height / 2;
    const rect = allFrameRects[id];
    return rect ? rect.y + rect.height / 2 : null;
  };

  // Preserve the original vertical order, but let every movable card shift
  // up or down within that order. This avoids chronological packing winning
  // over the directed-edge objective after the initial layout pass.
  const columnIds = new Map<number, string[]>();
  for (const id of normalIds) {
    if (!nextLayout[id]) continue;
    const column = colOf[id] ?? 0;
    const ids = columnIds.get(column) ?? [];
    ids.push(id);
    columnIds.set(column, ids);
  }
  for (const ids of columnIds.values()) {
    ids.sort((a, b) => nextLayout[a].y - nextLayout[b].y || a.localeCompare(b));
  }

  // A source can point at several targets. Give it one desired position that
  // represents all of them, instead of letting the last processed edge win.
  // Sources sharing a target are assigned consecutive positions around the
  // target center, keeping related cards together.
  for (let pass = 0; pass < 8; pass++) {
    const desiredSum = new Map<string, number>();
    const desiredCount = new Map<string, number>();
    const addDesired = (id: string, y: number) => {
      desiredSum.set(id, (desiredSum.get(id) ?? 0) + y);
      desiredCount.set(id, (desiredCount.get(id) ?? 0) + 1);
    };

    for (const [targetId, group] of targetGroups) {
      const targetCenter = centerOf(targetId);
      if (targetCenter === null) continue;
      const sourceIds = [...new Set(group.sources.map(source => source.messageId))]
        .filter(id => nextLayout[id])
        .sort((a, b) => nextLayout[a].y - nextLayout[b].y || a.localeCompare(b));
      const middleIndex = Math.floor(sourceIds.length / 2);
      const middleBox = nextLayout[sourceIds[middleIndex]];
      const middleTop = targetCenter - middleBox.height / 2;
      const desiredTops: number[] = new Array(sourceIds.length);
      desiredTops[middleIndex] = middleTop;
      for (let index = middleIndex - 1; index >= 0; index--) {
        const box = nextLayout[sourceIds[index]];
        desiredTops[index] = desiredTops[index + 1] - box.height - ROW_GAP;
      }
      for (let index = middleIndex + 1; index < sourceIds.length; index++) {
        const previousBox = nextLayout[sourceIds[index - 1]];
        desiredTops[index] = desiredTops[index - 1] + previousBox.height + ROW_GAP;
      }
      for (let index = 0; index < sourceIds.length; index++) {
        const id = sourceIds[index];
        const box = nextLayout[id];
        if (!box || !isMovable(id)) continue;
        addDesired(id, desiredTops[index]);
      }
    }

    for (const ids of columnIds.values()) {
      let segment: string[] = [];
      const flushSegment = () => {
        if (segment.length === 0) return;
        const heights = segment.map(id => nextLayout[id].height);
        const totalHeight = heights.reduce((sum, height, index) => sum + height + (index ? ROW_GAP : 0), 0);
        const segmentIndex = ids.indexOf(segment[0]);
        const previous = segmentIndex > 0 ? nextLayout[ids[segmentIndex - 1]] : undefined;
        const nextIndex = segmentIndex + segment.length;
        const next = nextIndex < ids.length ? nextLayout[ids[nextIndex]] : undefined;
        const minTop = previous ? previous.y + previous.height + ROW_GAP : GRID_TOP;
        const maxTop = next ? next.y - ROW_GAP - totalHeight : Infinity;
        let cursor = minTop;
        const positions: number[] = [];
        for (const id of segment) {
          const box = nextLayout[id];
          const desiredTop = desiredCount.has(id)
            ? (desiredSum.get(id) ?? box.y) / (desiredCount.get(id) ?? 1)
            : box.y;
          cursor = Math.max(cursor, desiredTop);
          positions.push(cursor);
          cursor += box.height + ROW_GAP;
        }
        let segmentTop = positions[0];
        const segmentBottom = positions[positions.length - 1] + heights[heights.length - 1];
        for (const rect of Object.values(allFrameRects)) {
          const segmentBox = nextLayout[segment[0]];
          if (!segmentBox) continue;
          if (segmentBox.x + segmentBox.width <= rect.x || rect.x + rect.width <= segmentBox.x) continue;
          if (segmentTop < rect.y + rect.height && segmentBottom > rect.y) {
            segmentTop = Math.max(segmentTop, rect.y + rect.height + ROW_GAP);
          }
        }
        const frameShift = segmentTop - positions[0];
        const overflow = Number.isFinite(maxTop)
          ? segmentBottom + frameShift - maxTop
          : 0;
        let shift = overflow > 0 ? frameShift - overflow : frameShift;

        // If the desired cluster belongs below the next fixed card, compare
        // that slot too. This allows a related source to cross an unrelated
        // obstacle when doing so is materially closer to its target.
        if (next && Number.isFinite(maxTop)) {
          const belowTop = next.y + next.height + ROW_GAP;
          const following = nextIndex + 1 < ids.length ? nextLayout[ids[nextIndex + 1]] : undefined;
          const belowMax = following ? following.y - ROW_GAP - totalHeight : Infinity;
          const desiredFirst = desiredCount.has(segment[0])
            ? (desiredSum.get(segment[0]) ?? nextLayout[segment[0]].y) / (desiredCount.get(segment[0]) ?? 1)
            : nextLayout[segment[0]].y;
          if (desiredFirst > maxTop && belowTop <= belowMax) {
            shift = belowTop - positions[0];
          }
        }
        for (let index = 0; index < segment.length; index++) {
          const box = nextLayout[segment[index]];
          nextLayout[segment[index]] = { ...box, y: Math.max(minTop, positions[index] + shift) };
        }
        segment = [];
      };
      for (const id of ids) {
        if (isMovable(id)) segment.push(id);
        else flushSegment();
      }
      flushSegment();
    }

    // Targets are anchors.  Do not move a target or the messages below it to
    // improve an annotation edge: otherwise a long right-side annotation can
    // make the left column drift vertically on every compaction pass.
  }

  // Final hard-constraint pass. Iterative edge compaction can move a target
  // after its source column was processed, so validate the resulting layout
  // again instead of trusting each local candidate check.
  for (let pass = 0; pass < normalIds.length * 2; pass++) {
    let changed = false;
    for (const ids of columnIds.values()) {
      const ordered = [...ids].sort((a, b) => nextLayout[a].y - nextLayout[b].y || a.localeCompare(b));
      for (let index = 0; index < ordered.length - 1; index++) {
        const firstId = ordered[index];
        const secondId = ordered[index + 1];
        const first = nextLayout[firstId];
        const second = nextLayout[secondId];
        if (first.y + first.height <= second.y) continue;
        if (isMovable(secondId)) {
          nextLayout[secondId] = { ...second, y: first.y + first.height + ROW_GAP };
          changed = true;
        } else if (isMovable(firstId)) {
          nextLayout[firstId] = { ...first, y: Math.max(GRID_TOP, second.y - first.height - ROW_GAP) };
          changed = true;
        }
      }
    }
    for (const id of normalIds) {
      if (!isMovable(id)) continue;
      const box = nextLayout[id];
      for (const rect of Object.values(allFrameRects)) {
        if (!overlaps(box, rect)) continue;
        nextLayout[id] = { ...box, y: rect.y + rect.height + ROW_GAP };
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  // Recompute canvas height
  let maxBottom = GRID_TOP;
  for (const box of Object.values(nextLayout)) maxBottom = Math.max(maxBottom, box.y + box.height);

  return { layout: nextLayout, canvasHeight: Math.max(params.canvasHeight, maxBottom + CANVAS_BOTTOM_PAD) };
}
