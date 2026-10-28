/** Shared graph dimensions, rectangle helpers and grouping constraints. */

import type { DemoMessage, DemoEdge } from './modelBridge';
import type { PresentationKind } from '../types';
import { getPresentationSpec } from '../types';

// ============================================================
// Layout Constants (canonical source — imported by GraphView.tsx)
// ============================================================

export const CARD_W = 320;
export const MIN_CARD_H = 86;
export const GRID_LEFT = 18;
export const GRID_TOP = 24;
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
  const sorted = [...normals].sort((a,b)=>(Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0)
    ||(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id));

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
