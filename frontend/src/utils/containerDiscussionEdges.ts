import type { DemoEdge, DemoMessage } from './modelBridge';
import { chronologicalOrder } from './discussionOrder';
import { isDiscussionType } from './discussionTypes';

/** A frame is one layout atom, but its members are independent speakers.
 * Preserve their native relationships for rendering; only a uniform set of
 * effective member relationships may place the whole frame in a typed region.
 */
export function projectContainerDiscussionEdges(edges: readonly DemoEdge[], originals: ReadonlyMap<string, DemoEdge>,
  catalog: ReadonlyMap<string, DemoMessage>): DemoEdge[] {
  const groups = new Map<string, DemoEdge[]>();
  for (const edge of edges) if (isDiscussionType(edge.relationType)) {
    const key = JSON.stringify([edge.from.messageId, edge.to.messageId]);
    const group = groups.get(key) ?? [];
    group.push(edge); groups.set(key, group);
  }
  const neutral = new Set<DemoEdge>();
  const order = (edge: DemoEdge) => ({ id: edge.relationMessageId, createdAt: '',
    ...(edge.discussionOrder ?? catalog.get(edge.relationMessageId)) });
  for (const group of groups.values()) {
    const lifted = group.filter(edge => originals.get(edge.id)!.from.messageId !== edge.from.messageId);
    if (!lifted.length) continue;
    // The container's own statement is authoritative for its position, even
    // when an individual member has a newer statement on the same target.
    if (lifted.length !== group.length) {
      for (const edge of lifted) neutral.add(edge);
      continue;
    }
    const latest = new Map<string, DemoEdge>();
    for (const edge of group) {
      const original = originals.get(edge.id)!;
      const key = JSON.stringify([original.from.messageId, original.to.messageId]);
      const previous = latest.get(key);
      if (!previous || chronologicalOrder(order(previous), order(edge)) < 0) latest.set(key, edge);
    }
    const effective = new Set(latest.values());
    const mixed = new Set([...effective].map(edge => edge.relationType)).size > 1;
    for (const edge of group) if (mixed || !effective.has(edge)) neutral.add(edge);
  }
  // A reference is only a neutral right-hand placement anchor here. It never
  // creates a new message, arrow, summary record, or claim about the content.
  return edges.map(edge => neutral.has(edge) ? { ...edge, relationType: 'reference' } : edge);
}
