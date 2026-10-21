import type { DemoEdge } from './modelBridge';
import { getPresentationSpec } from '../types';

interface DeriveCrossCanvasRelationsInput {
  edges: DemoEdge[];
  visibleMessageIds: Set<string>;
  renderedEdges?: DemoEdge[];
}

export interface CrossCanvasRelationGroups { outgoing: Record<string, string[]>; incoming: Record<string, string[]> }

/** Attach each missing directed connection to whichever endpoints this canvas displays. */
export function deriveCrossCanvasRelations(input: DeriveCrossCanvasRelationsInput): Map<string, CrossCanvasRelationGroups> {
  const { edges, visibleMessageIds, renderedEdges = edges } = input;
  const completeEdges = new Set(renderedEdges.filter(edge =>
    visibleMessageIds.has(edge.from.messageId) && visibleMessageIds.has(edge.to.messageId)).map(edge => edge.id));
  const raw = new Map<string, { outgoing: Record<string, Set<string>>; incoming: Record<string, Set<string>> }>();
  for (const e of edges) {
    const presentation = getPresentationSpec(e.relationType);
    const stance = e.relationType === 'agree' || e.relationType === 'disagree';
    // JOINs have their own membership-history controls.
    // A stance with a content source remains discoverable when its endpoints live in different scopes.
    if ((presentation.kind !== 'edge-label' && !stance) || String(e.relationType).toLowerCase() === 'join' || e.from.messageId.startsWith('anon:')) continue;
    if (completeEdges.has(e.id)) continue;
    const fromVisible = visibleMessageIds.has(e.from.messageId);
    const toVisible = visibleMessageIds.has(e.to.messageId);
    const lbl = presentation.label;
    if (fromVisible) {
      let entry = raw.get(e.from.messageId);
      if (!entry) { entry = { outgoing: {}, incoming: {} }; raw.set(e.from.messageId, entry); }
      (entry.outgoing[lbl] ??= new Set()).add(e.relationMessageId);
    }
    if (toVisible) {
      let entry = raw.get(e.to.messageId);
      if (!entry) { entry = { outgoing: {}, incoming: {} }; raw.set(e.to.messageId, entry); }
      (entry.incoming[lbl] ??= new Set()).add(e.relationMessageId);
    }
  }
  // 转换 Set → array 用于 props 传递
  const result = new Map<string, { outgoing: Record<string, string[]>; incoming: Record<string, string[]> }>();
  for (const [msgId, entry] of raw) {
    const out: Record<string, string[]> = {};
    for (const [lbl, ids] of Object.entries(entry.outgoing)) out[lbl] = Array.from(ids);
    const inc: Record<string, string[]> = {};
    for (const [lbl, ids] of Object.entries(entry.incoming)) inc[lbl] = Array.from(ids);
    result.set(msgId, { outgoing: out, incoming: inc });
  }
  return result;
}
