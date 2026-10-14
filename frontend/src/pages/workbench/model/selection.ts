import type { TargetRef } from '../../../types';
import { isWholeMessageSelection } from '../../../utils/messageElementSelection';
import type { DemoEdge, DemoMessage, UnitSelection } from '../../../utils/modelBridge';
import { unitSelectionToTargetRef } from '../../../utils/modelBridge';

export function selKey(u: UnitSelection): string {
  if (isWholeMessageSelection(u, u.messageId) && u.reference?.revision === undefined) return `${u.messageId}::whole`;
  if (u.reference) return JSON.stringify([u.reference.messageId, u.reference.revision ?? null, u.reference.partId ?? null, u.reference.memberId ?? null, u.reference.path ?? null, u.reference.range ?? null]);
  const s = u.selection;
  if (s.kind === 'whole') return `${u.messageId}::whole`;
  if (s.kind === 'edge') return `${u.messageId}::edge:${s.edgeId}`;
  return `${u.messageId}::text:${s.start}:${s.len}:${s.text}`;
}

export function unitEquals(a: UnitSelection, b: UnitSelection) {
  return selKey(a) === selKey(b);
}

export function mergeUnits(base: UnitSelection[], added: UnitSelection[]) {
  const set = new Set(base.map(selKey));
  const res = [...base];
  for (const u of added) {
    const k = selKey(u);
    if (!set.has(k)) { set.add(k); res.push(u); }
  }
  return res;
}

let nextIdCounter = 1;

export function nextId(prefix: string): string {
  return `${prefix}-local-${Date.now()}-${nextIdCounter++}`;
}

export function targetRefDisplayId(r: TargetRef): string {
  if (r.kind === 'message' || r.kind === 'text-fragment') return r.messageId;
  return r.relationId;
}

export function uniqueTargetRefsFromEdges(
  relEdges: DemoEdge[],
  msgMap: Map<string, DemoMessage>
): TargetRef[] {
  const seen = new Set<string>();
  const refs: TargetRef[] = [];
  for (const e of relEdges) {
    const key = selKey(e.to);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(unitSelectionToTargetRef(e.to, msgMap));
  }
  return refs;
}
