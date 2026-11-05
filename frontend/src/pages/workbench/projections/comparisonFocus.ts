import type { DemoEdge, DemoMessage } from '../../../utils/modelBridge';
import { isContainerType } from '../model/containerEffect';

type Side = { messages: DemoMessage[]; edges: DemoEdge[] };

/** Reduce an already computed comparison without changing either side's effect.
 * Share the enclosing paths so a moved message still has both old/new frames. */
export function focusComparisonDifference(pair: { agree: Side; disagree: Side }, targetId: string, fallbackIds: string[] = []) {
  const sides = [pair.agree, pair.disagree];
  const records = new Map<string, DemoMessage[]>(), ownedEdges = new Map<string, DemoEdge[]>(), parents = new Map<string, Set<string>>();
  for (const side of sides) {
    for (const message of side.messages) records.set(message.id, [...records.get(message.id) ?? [], message]);
    for (const edge of side.edges) {
      ownedEdges.set(edge.relationMessageId, [...ownedEdges.get(edge.relationMessageId) ?? [], edge]);
      if (isContainerType(edge.relationType)) {
        const owners = parents.get(edge.to.messageId) ?? new Set<string>();
        owners.add(edge.relationMessageId); parents.set(edge.to.messageId, owners);
      }
    }
  }
  const ids = new Set([targetId, ...fallbackIds]);
  // A container may stay in the same place while one of its members moves.
  // Keep the endpoints of changed incident edges, otherwise focusing that
  // container would erase the very difference the chooser is reporting.
  const incident = sides.map(side => new Map(side.edges.filter(edge => edge.relationMessageId === targetId
    || edge.from.messageId === targetId || edge.to.messageId === targetId)
    .map(edge => [JSON.stringify([edge.relationType, edge.relationMessageId, edge.from, edge.to]), edge])));
  for (let index = 0; index < incident.length; index++) for (const [key, edge] of incident[index]) {
    if (incident[1 - index].has(key)) continue;
    for (const id of [edge.relationMessageId, edge.from.messageId, edge.to.messageId]) if (records.has(id)) ids.add(id);
  }
  // An edge or decoration needs its actual anchors. Do not expand all members
  // of a selected container or pull in unchanged siblings of its frames.
  for (const id of ids) for (const message of records.get(id) ?? []) {
    if (message.kind !== 'relation' || isContainerType(message.relationType)) continue;
    const anchors = [message.sourceMessageId, ...(message.targetRefs ?? []).map(ref => ref.kind === 'relation' ? ref.relationId : ref.messageId),
      ...(ownedEdges.get(id) ?? []).flatMap(edge => [edge.from.messageId, edge.to.messageId])];
    for (const anchor of anchors) if (anchor && records.has(anchor)) ids.add(anchor);
  }
  for (const id of ids) for (const parent of parents.get(id) ?? []) ids.add(parent);

  const project = (side: Side) => {
    const visible = new Set(side.messages.filter(message => ids.has(message.id)).map(message => message.id));
    const byRelation = new Map<string, DemoEdge[]>();
    for (const edge of side.edges) byRelation.set(edge.relationMessageId, [...byRelation.get(edge.relationMessageId) ?? [], edge]);
    // Keep decorations/connections wholly attached to the retained context,
    // without letting an unrelated reply reintroduce its source card.
    let changed = true;
    while (changed) {
      changed = false;
      for (const message of side.messages) {
        if (visible.has(message.id) || message.kind !== 'relation' || isContainerType(message.relationType)) continue;
        const edges = byRelation.get(message.id);
        if (!edges?.length || !edges.every(edge => visible.has(edge.to.messageId)
          && (edge.from.messageId.startsWith('anon:') || visible.has(edge.from.messageId)))) continue;
        visible.add(message.id); changed = true;
      }
    }
    return {
      messages: side.messages.filter(message => visible.has(message.id)),
      edges: side.edges.filter(edge => visible.has(edge.relationMessageId) && visible.has(edge.to.messageId)
        && (edge.from.messageId.startsWith('anon:') || visible.has(edge.from.messageId))),
    };
  };
  return { agree: project(pair.agree), disagree: project(pair.disagree) };
}
