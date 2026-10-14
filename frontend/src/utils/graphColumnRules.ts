import type { DemoMessage, DemoEdge } from './modelBridge';
import { hasActiveDisplayEffect } from './messageDisplay';
import { convergeGroupingAndRightConstraints } from './layout';
import { isAnyFrameRel, isCorrectionBadgeRel } from './graphPresentationGeometry';

export function computeMinColumnsForAnnoRefRule1(normalIds: string[], edges: DemoEdge[], relIds: Set<string>) {
  const normalSet = new Set(normalIds);
  const relevant = edges.filter(
    (e) => (e.relationType === "annotation" || e.relationType === "reference" || e.relationType === "notify") &&
      normalSet.has(e.from.messageId) && normalSet.has(e.to.messageId)
  );
  const toRelEdges = edges.filter(
    (e) => (e.relationType === "annotation" || e.relationType === "reference" || e.relationType === "notify") &&
      normalSet.has(e.from.messageId) && relIds.has(e.to.messageId)
  );
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
    for (const e of relevant) {
      const need = (col[e.to.messageId] ?? 0) + 1;
      if ((col[e.from.messageId] ?? 0) < need) { col[e.from.messageId] = need; changed = true; }
    }
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
  if (iter >= 5000) { console.warn("Anno/Ref cycle; fallback."); for (const id of normalIds) col[id] = 0; }
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
  const minCol = Math.min(...Object.values(col));
  if (minCol !== 0) for (const id of normalIds) col[id] -= minCol;
  return { col, maxCol: Math.max(...Object.values(col)) };
}

export function applyReplyLayoutAdjustmentsWithConstraints(params: {
  normals: DemoMessage[]; edges: DemoEdge[]; baseCol: Record<string, number>; baseMaxCol: number; relIds: Set<string>;
}) {
  const { normals, edges, baseCol, baseMaxCol, relIds } = params;
  const col: Record<string, number> = { ...baseCol };
  let maxCol = baseMaxCol;
  const normalSet = new Set(normals.map(m => m.id));
  const msgById = new Map(normals.map(m => [m.id, m]));
  const minAllowed: Record<string, number> = {};
  for (const m of normals) minAllowed[m.id] = baseCol[m.id] ?? 0;
  const relEdgesByRelMsgForReply = new Map<string, DemoEdge[]>();
  for (const e of edges) {
    const arr = relEdgesByRelMsgForReply.get(e.relationMessageId) ?? [];
    arr.push(e);
    relEdgesByRelMsgForReply.set(e.relationMessageId, arr);
  }
  for (const e of edges) {
    if (!(e.relationType === "annotation" || e.relationType === "reference" || e.relationType === "notify")) continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    const need = (col[e.to.messageId] ?? 0) + 1;
    minAllowed[e.from.messageId] = Math.max(minAllowed[e.from.messageId] ?? 0, need);
  }
  for (const e of edges) {
    if (e.relationType !== "reply") continue;
    if (!normalSet.has(e.from.messageId)) continue;
    if (!relIds.has(e.to.messageId)) continue;
    const targetRelEdges = relEdgesByRelMsgForReply.get(e.to.messageId) ?? [];
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
  const replyTargetsByFrom = new Map<string, string[]>();
  for (const e of edges.filter(e => e.relationType === "reply")) {
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    if (!replyTargetsByFrom.has(e.from.messageId)) replyTargetsByFrom.set(e.from.messageId, []);
    replyTargetsByFrom.get(e.from.messageId)!.push(e.to.messageId);
  }
  function mode(nums: number[]) {
    const cnt = new Map<number, number>();
    for (const n of nums) cnt.set(n, (cnt.get(n) ?? 0) + 1);
    let best = nums[0] ?? 0, bestC = -1;
    for (const [k, c] of cnt) if (c > bestC || (c === bestC && k < best)) { best = k; bestC = c; }
    return best;
  }
  const byAuthor = new Map<string, number[]>();
  for (const m of normals) {
    const arr = byAuthor.get(m.author) ?? [];
    arr.push(baseCol[m.id] ?? 0);
    byAuthor.set(m.author, arr);
  }
  const authorAnchor: Record<string, number> = {};
  for (const [author, colsArr] of byAuthor) authorAnchor[author] = mode(colsArr);
  const authorPrevLane: Record<string, number | null> = {};
  for (const a of Object.keys(authorAnchor)) authorPrevLane[a] = null;
  const replyFromIds = Array.from(replyTargetsByFrom.keys());
  replyFromIds.sort((a, b) => {
    const ta = new Date(msgById.get(a)?.createdAt ?? 0).getTime();
    const tb = new Date(msgById.get(b)?.createdAt ?? 0).getTime();
    return ta !== tb ? ta - tb : a.localeCompare(b);
  });
  function better(a: any, b: any) {
    if (!b) return true; if (!a) return false;
    for (const k of ["incMax","maxDist","sumDist","inLane","stable","c"]) {
      if (a[k] < b[k]) return true; if (a[k] > b[k]) return false;
    }
    return false;
  }
  for (const fromId of replyFromIds) {
    const fromMsg = msgById.get(fromId); if (!fromMsg) continue;
    const targets = replyTargetsByFrom.get(fromId) ?? [];
    const targetCols = targets.filter(t => normalSet.has(t)).map(t => col[t] ?? baseCol[t] ?? 0);
    const forbidden = new Set<number>(targetCols);
    const baseMin = minAllowed[fromId] ?? baseCol[fromId] ?? 0;
    const anchor = authorAnchor[fromMsg.author] ?? baseMin;
    const prevLane = authorPrevLane[fromMsg.author] ?? null;
    const candidates: number[] = [];
    if (prevLane !== null) candidates.push(Math.max(baseMin, prevLane));
    candidates.push(Math.max(baseMin, anchor), Math.max(baseMin, anchor + 1));
    if (targetCols.length > 0) {
      const med = [...targetCols].sort((a,b)=>a-b)[Math.floor(targetCols.length/2)];
      candidates.push(Math.max(baseMin,med), Math.max(baseMin,med+1), Math.max(baseMin,med-1));
    }
    for (let d = 0; d <= 6; d++) candidates.push(Math.max(baseMin,anchor-d), Math.max(baseMin,anchor+d), baseMin+d);
    const uniq: number[] = [];
    const seen = new Set<number>();
    for (const c0 of candidates) { const c = Math.max(baseMin,c0); if (!seen.has(c)) { seen.add(c); uniq.push(c); } }
    const scoreCandidate = (c: number) => {
      if (c < baseMin || forbidden.has(c)) return null;
      const maxDist = targetCols.length === 0 ? 0 : Math.max(...targetCols.map(a => Math.abs(c-a)));
      const sumDist = targetCols.reduce((s,t) => s+Math.abs(c-t), 0);
      const inLane = (c===anchor||c===anchor+1) ? 0 : 1;
      const stable = (prevLane!==null && c===prevLane) ? 0 : 1;
      const incMax = c > maxCol ? c-maxCol : 0;
      return { incMax, maxDist, sumDist, inLane, stable, c };
    };
    let bestScore: any = null, bestC: number | null = null;
    for (const c of uniq) { const sc = scoreCandidate(c); if (sc && better(sc, bestScore)) { bestScore = sc; bestC = c; } }
    if (bestC === null) { let c = Math.max(baseMin, maxCol+1); while (forbidden.has(c)) c++; bestC = c; }
    col[fromId] = bestC; maxCol = Math.max(maxCol, bestC); authorPrevLane[fromMsg.author] = bestC;
  }

  // Propagate right-shift constraints after reply placement.
  // Annotation/reference/notify sources must remain at least target+1;
  // reply edges do not cascade so same-author reply chains can return to one lane.
  const sourcesByTarget = new Map<string, string[]>();
  for (const e of edges) {
    if (e.relationType !== "annotation" && e.relationType !== "reference" && e.relationType !== "notify") continue;
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
  const groupSourceToTarget = new Map<string, string>();
  for (const e of edges) {
    if (!hasActiveDisplayEffect(e, msgById)) continue;
    if (!isAnyFrameRel(e.relationType) && !isCorrectionBadgeRel(e.relationType)) continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    if (!groupSourceToTarget.has(e.from.messageId)) {
      groupSourceToTarget.set(e.from.messageId, e.to.messageId);
    }
  }
  const frameTargetsByRelMsg = new Map<string, { targetIds: string[]; relationType: string }>();
  for (const e of edges) {
    if (!hasActiveDisplayEffect(e, msgById)) continue;
    if (!isAnyFrameRel(e.relationType) && !isCorrectionBadgeRel(e.relationType)) continue;
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

  // Restore reply author lanes after structural convergence. Explicit grouping
  // and non-reply right-side constraints keep their higher priority.
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

  const rightMinCol: Record<string, number> = {};
  const rightSourcesByTarget = new Map<string, string[]>();
  for (const e of edges) {
    if (
      e.relationType !== "annotation" &&
      e.relationType !== "reference" &&
      e.relationType !== "notify" &&
      e.relationType !== "reply" &&
      e.relationType !== "disagree"
    ) continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    const need = (col[e.to.messageId] ?? 0) + 1;
    rightMinCol[e.from.messageId] = Math.max(rightMinCol[e.from.messageId] ?? 0, need);
    const arr = rightSourcesByTarget.get(e.to.messageId) ?? [];
    arr.push(e.from.messageId);
    rightSourcesByTarget.set(e.to.messageId, arr);
  }

  // A later support edge may move the target right to make room on its left.
  // Move existing objections with that target even when snapshots list them first.
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

  const stanceEdges = edges.filter(e => e.relationType === "agree" || e.relationType === "disagree");
  for (const e of stanceEdges) {
    const fromId = e.from.messageId, toId = e.to.messageId;
    if (!normalSet.has(fromId) || !normalSet.has(toId)) continue;

    if (e.relationType === "agree") {
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
