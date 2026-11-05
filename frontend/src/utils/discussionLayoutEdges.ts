import type { DemoEdge, DemoMessage } from './modelBridge';
import { projectStanceLayoutEdges } from './stanceLayout';
import { hasDiscussionText } from './discussionTypes';
import { chronologicalOrder } from './discussionOrder';

const containerType = (value?: string) => ['classify', 'summary', 'merge', 'arrange'].includes(value ?? '');

/** Endorsements refresh placement only; original records and dates remain evidence. */
function endorsedRelationOrder(messages: DemoMessage[], edges: DemoEdge[]) {
  const catalog = new Map(messages.map(message => [message.id, message]));
  const active = new Set(edges.filter(edge => !edge.proposalOnly).map(edge => edge.relationMessageId));
  const approvals = new Map<string, Set<string>>();
  for (const edge of edges) {
    const approval = catalog.get(edge.relationMessageId), target = catalog.get(edge.to.messageId), ref = edge.to.reference;
    if (edge.relationType !== 'agree' || edge.proposalOnly || !approval || approval.state?.suppressed
      || target?.kind !== 'relation' || target.state?.suppressed || !active.has(target.id)
      || ref?.range || ref?.memberId || ref?.path?.some(value => value !== 'relation')
      || ref?.revision !== undefined && ref.revision !== (target.revision ?? 1)) continue;
    const part = ref?.partId ? target.parts?.find(part => part.id === ref.partId) : undefined;
    if ((ref?.partId || edge.to.selection.kind !== 'whole') && part?.type !== 'relation') continue;
    const targets = approvals.get(approval.id) ?? new Set<string>();
    targets.add(target.id); approvals.set(approval.id, targets);
  }
  const promoted = new Map<string, DemoMessage>();
  // Descending publication order bounds propagation through shared chains and cycles.
  for (const publication of messages.filter(message => approvals.has(message.id)).sort((a,b) => chronologicalOrder(b,a))) {
    const queue = [publication.id];
    for (let index = 0; index < queue.length; index++) for (const target of approvals.get(queue[index]) ?? []) {
      const previous = promoted.get(target) ?? catalog.get(target)!;
      if (chronologicalOrder(publication, previous) <= 0) continue;
      promoted.set(target, publication); queue.push(target);
    }
  }
  return promoted;
}

/** Layout-only anchors for relationship cards; never source evidence or selectable edge IDs. */
export function projectDiscussionLayoutEdges(messages: DemoMessage[], edges: DemoEdge[], relationCardTargetIds: ReadonlySet<string>): DemoEdge[] {
  const byId = new Map(messages.map(message => [message.id, message]));
  const endorsed = endorsedRelationOrder(messages, edges);
  const placements = projectStanceLayoutEdges(messages, edges), result: DemoEdge[] = [];
  const usedIds = new Set(edges.map(edge => edge.id)), anchors = new Set<string>();
  for (let index = 0; index < edges.length; index++) {
    const original = edges[index], record = byId.get(original.relationMessageId);
    let placement = placements[index];
    const publication = endorsed.get(original.relationMessageId);
    if (publication) placement = { ...placement, discussionOrder: { createdAt: publication.createdAt, sequence: publication.sequence } };
    const card = record?.kind === 'relation' && !containerType(record.relationType)
      && (relationCardTargetIds.has(record.id) || hasDiscussionText(record));
    if (card && placement.from.messageId.startsWith('anon:')) {
      placement = { ...placement, from: { messageId: record.id, selection: { kind: 'whole' } } };
    }
    result.push(placement);
    if (!card || !byId.has(original.to.messageId) || original.to.messageId === record.id
      || placement.from.messageId === record.id && placement.to.messageId === original.to.messageId) continue;
    const key = JSON.stringify([record.id, original.to.messageId, original.relationType]);
    if (anchors.has(key)) continue;
    anchors.add(key);
    const prefix = `discussion-record:${JSON.stringify([record.id, original.id])}`;
    let id = prefix, suffix = 0;
    while (usedIds.has(id)) id = `${prefix}:${++suffix}`;
    usedIds.add(id);
    result.push({ ...original, ...(placement.discussionOrder ? { discussionOrder: placement.discussionOrder } : {}), id, from: { messageId: record.id, selection: { kind: 'whole' } } });
  }
  return result;
}
