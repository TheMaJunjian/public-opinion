import { displayDependencyRole, messageDisplayDependency, type Part, type Reference, type TargetRef } from '@gonglun/core';

type DisplayMessage = {
  id: string; parts?: Part[]; relationType?: string; sourceMessageId?: string | null;
  sourceRefs?: Reference[]; targetRefs?: TargetRef[];
};

/** null means independent; an empty list is a dependent message with no valid host. */
export function displayDependencyIds(message: DisplayMessage): string[] | null {
  if (message.parts?.length) {
    const refs = messageDisplayDependency({ id: message.id, parts: message.parts });
    return refs === null ? null : refs.map(ref => ref.messageId).filter(id => id !== message.id);
  }
  const role = displayDependencyRole(message.relationType ?? '');
  if (!role) return null;
  if (role === 'source' || role === 'parent') {
    return [...new Set([...(message.sourceRefs ?? []).map(ref => ref.messageId),
      ...(message.sourceMessageId ? [message.sourceMessageId] : [])])].filter(id => id !== message.id);
  }
  return (message.targetRefs ?? []).map(ref => ref.kind === 'relation' ? ref.relationId : ref.messageId).filter(id => id !== message.id);
}

export function edgeDisplayDependencyIds(message: DisplayMessage | undefined,
  edges: { relationType: string; from: { messageId: string }; to: { messageId: string } }[]): string[] | null {
  // Placement records remain inspectable from either end, including a temporary JOIN view.
  if (displayDependencyRole(message?.relationType ?? edges[0]?.relationType ?? '') === 'parent') return null;
  if (message?.parts?.length || message?.sourceMessageId || message?.sourceRefs?.length || message?.targetRefs?.length)
    return displayDependencyIds(message);
  const role = displayDependencyRole(message?.relationType ?? edges[0]?.relationType ?? '');
  if (!role) return null;
  return [...new Set(edges.map(edge => role === 'target' ? edge.to.messageId : edge.from.messageId))];
}
