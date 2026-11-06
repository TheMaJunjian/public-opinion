import { getPresentationSpec } from '../../../types';
import { chronologicalOrder } from '../../../utils/discussionOrder';
import { isCardMessage, isSettlementRecord, type DemoEdge, type DemoMessage } from '../../../utils/modelBridge';
import { nextReadingVisit, type ReadingTask } from './readingTasks';

export type ReadingStructureDirection = 'up' | 'peer' | 'down';
export type ReadingNavigationMode = 'auto' | ReadingStructureDirection;
export const readingStructureDirections: readonly ReadingStructureDirection[] = ['up', 'peer', 'down'];
export const readingStructureLabels: Record<ReadingStructureDirection, string> = {
  up: '上层 · 前因／依据', peer: '同层 · 同一分支', down: '下层 · 回复／后续',
};
export interface ReadingNeighbor { id: string; relationTypes: string[]; viaIds: string[] }
export type ReadingNeighbors = Record<ReadingStructureDirection, ReadingNeighbor[]>;
type Links = Map<string, Map<string, Set<string>>>;

/** Discussion adjacency is independent of frame membership and screen position. */
export function indexReadingStructure(messages: readonly DemoMessage[], edges: readonly DemoEdge[], suppressedIds?: ReadonlySet<string>) {
  const messagesById = new Map(messages.map(message => [message.id, message]));
  const up: Links = new Map(), down: Links = new Map();
  const add = (links: Links, from: string, to: string, type: string) => {
    const targets = links.get(from) ?? new Map<string, Set<string>>();
    const types = targets.get(to) ?? new Set<string>();
    types.add(type); targets.set(to, types); links.set(from, targets);
  };
  const connect = (from: string, to: string, type: string) => {
    if (from === to || !messagesById.has(from) || !messagesById.has(to)) return;
    add(up, from, to, type); add(down, to, from, type);
  };
  for (const edge of edges) {
    const owner = messagesById.get(edge.relationMessageId), type = edge.relationType;
    if (getPresentationSpec(type).isContainer || ['read', 'unread', 'join'].includes(type)
      || owner?.kind === 'join' || suppressedIds?.has(edge.relationMessageId)
      || [owner, messagesById.get(edge.from.messageId), messagesById.get(edge.to.messageId)].some(isSettlementRecord)) continue;
    const source = edge.from.messageId.startsWith('anon:') ? edge.relationMessageId : edge.from.messageId;
    connect(source, edge.to.messageId, type);
    if (source !== edge.relationMessageId) {
      connect(edge.relationMessageId, source, type);
      connect(edge.relationMessageId, edge.to.messageId, type);
    }
  }
  return { messagesById, up, down };
}

export function readingNeighbors(index: ReturnType<typeof indexReadingStructure>, focusIds: readonly string[], orderedIds: readonly string[] = []): ReadingNeighbors {
  const focus = new Set(focusIds), ranks = new Map(orderedIds.map((id, at) => [id, at]));
  const groups = { up: new Map<string, ReadingNeighbor>(), peer: new Map<string, ReadingNeighbor>(), down: new Map<string, ReadingNeighbor>() };
  const add = (direction: ReadingStructureDirection, id: string, types: ReadonlySet<string>, via?: string) => {
    const message = index.messagesById.get(id);
    // Bodyless relation records remain available through the message's influence details.
    if (!message || focus.has(id) || !(isCardMessage(message) || ['classify', 'summary', 'merge', 'arrange', 'correct'].includes(message.relationType ?? ''))) return;
    const previous = groups[direction].get(id);
    groups[direction].set(id, { id, relationTypes: [...new Set([...(previous?.relationTypes ?? []), ...types])],
      viaIds: [...new Set([...(previous?.viaIds ?? []), ...(via ? [via] : [])])] });
  };
  for (const id of focus) {
    for (const [target, types] of index.up.get(id) ?? []) add('up', target, types);
    for (const [source, types] of index.down.get(id) ?? []) add('down', source, types);
  }
  for (const id of focus) for (const parent of index.up.get(id)?.keys() ?? []) {
    for (const [peer, types] of index.down.get(parent) ?? []) {
      if (!groups.up.has(peer) && !groups.down.has(peer)) add('peer', peer, types, parent);
    }
  }
  const sorted = (direction: ReadingStructureDirection) => [...groups[direction].values()].sort((a, b) =>
    (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity)
    || chronologicalOrder(index.messagesById.get(a.id)!, index.messagesById.get(b.id)!));
  return { up: sorted('up'), peer: sorted('peer'), down: sorted('down') };
}

/** Explicit directions never fall back to a different branch or expand the trace scope. */
export function nextStructuredReadingVisit(queue: Parameters<typeof nextReadingVisit>[0], currentTasks: readonly ReadingTask[], mode: ReadingNavigationMode, neighbors: ReadingNeighbors) {
  if (mode === 'auto') return nextReadingVisit(queue, currentTasks);
  const ids = new Set(neighbors[mode].map(message => message.id));
  return nextReadingVisit({ ...queue, pending: queue.pending.filter(visit => ids.has(visit.id)) }, currentTasks);
}
