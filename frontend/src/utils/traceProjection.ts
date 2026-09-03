import type { DemoEdge, DemoMessage } from './modelBridge';
import { isTraceTextLikeMessage } from './modelBridge';

export interface TraceProjectionInput {
  messages: DemoMessage[];
  edges: DemoEdge[];
  startIds: string[];
  distance: number;
}

export interface TraceProjection {
  messages: DemoMessage[];
  edges: DemoEdge[];
}

function addAdjacency(adjacency: Map<string, Set<string>>, left: string, right: string): void {
  if (!adjacency.has(left)) adjacency.set(left, new Set());
  if (!adjacency.has(right)) adjacency.set(right, new Set());
  adjacency.get(left)!.add(right);
  adjacency.get(right)!.add(left);
}

/**
 * Builds the ordinary GraphView input for a trace window.
 * Only card-like messages consume distance. Other relation messages are
 * transparent connections and are projected when their endpoints are visible.
 */
export function buildTraceProjection(input: TraceProjectionInput): TraceProjection {
  const { messages, edges, startIds, distance } = input;
  const messageMap = new Map(messages.map(message => [message.id, message]));
  const adjacency = new Map<string, Set<string>>();

  for (const edge of edges) {
    const endpoints = [edge.from.messageId, edge.to.messageId]
      .filter(id => !id.startsWith('anon:') && id !== edge.relationMessageId && messageMap.has(id));
    for (const endpointId of endpoints) addAdjacency(adjacency, edge.relationMessageId, endpointId);
  }

  const distances = new Map<string, number>();
  const queue = startIds.filter(id => messageMap.has(id));
  for (const id of queue) distances.set(id, 0);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const currentDistance = distances.get(current)!;
    for (const next of adjacency.get(current) ?? []) {
      const nextDistance = currentDistance + (isTraceTextLikeMessage(messageMap.get(next)) ? 1 : 0);
      if (nextDistance > distance || nextDistance >= (distances.get(next) ?? Number.POSITIVE_INFINITY)) continue;
      distances.set(next, nextDistance);
      queue.push(next);
    }
  }

  const visibleIds = new Set<string>(
    [...distances]
      .filter(([id, value]) => value <= distance && isTraceTextLikeMessage(messageMap.get(id)))
      .map(([id]) => id),
  );
  for (const startId of startIds) if (messageMap.has(startId)) visibleIds.add(startId);

  // Complete the display dependencies without feeding them back into distance
  // traversal. Inline frames need every member; other relations need their
  // source card when an in-range target depends on it.
  const nonCardRelationIds = new Set(
    messages
      .filter(message => message.kind === 'relation' && !isTraceTextLikeMessage(message))
      .map(message => message.id),
  );
  let addedRelation = true;
  while (addedRelation) {
    addedRelation = false;
    for (const relationId of nonCardRelationIds) {
      const ownedEdges = edges.filter(edge => edge.relationMessageId === relationId);
      const relationType = messageMap.get(relationId)?.relationType?.toLowerCase();
      const sourceIds = new Set(ownedEdges.map(edge => edge.from.messageId)
        .filter(id => !id.startsWith('anon:') && id !== relationId && messageMap.has(id)));
      const targetIds = new Set(ownedEdges.map(edge => edge.to.messageId)
        .filter(id => !id.startsWith('anon:') && id !== relationId && messageMap.has(id)));
      const isInlineFrame = relationType === 'merge' || relationType === 'arrange';
      const shouldComplete = isInlineFrame
        ? visibleIds.has(relationId) || [...targetIds].some(id => visibleIds.has(id))
        : [...targetIds].some(id => visibleIds.has(id));
      const allEndpointsVisible = [...sourceIds, ...targetIds].every(id => visibleIds.has(id));
      if (!shouldComplete && !allEndpointsVisible) continue;

      const dependencyIds = isInlineFrame
        ? [relationId, ...sourceIds, ...targetIds]
        : [relationId, ...sourceIds];
      for (const id of dependencyIds) {
        if (visibleIds.has(id)) continue;
        visibleIds.add(id);
        addedRelation = true;
      }
    }
  }

  const projectedMessages = messages.filter(message => visibleIds.has(message.id));
  const projectedMessageIds = new Set(projectedMessages.map(message => message.id));
  const projectedEdges = edges.filter(edge => {
    const owner = edge.relationMessageId;
    if (isTraceTextLikeMessage(messageMap.get(owner))) {
      // Visible container cards keep all owned edges for target counts. The
      // renderer decides card versus frame from the trace expansion state.
      return projectedMessageIds.has(owner);
    }
    if (!projectedMessageIds.has(owner)) return false;
    const fromVisible = edge.from.messageId.startsWith('anon:') || projectedMessageIds.has(edge.from.messageId);
    const toVisible = edge.to.messageId.startsWith('anon:') || projectedMessageIds.has(edge.to.messageId);
    return fromVisible && toVisible;
  });

  // Relation labels are ordinary messages. Include them only when their edge
  // survived the same projection, without reintroducing hidden descendants.
  const relationIds = new Set(projectedEdges.map(edge => edge.relationMessageId));
  for (const relationId of relationIds) {
    if (!projectedMessageIds.has(relationId) && messageMap.has(relationId)) {
      projectedMessages.push(messageMap.get(relationId)!);
    }
  }

  return { messages: projectedMessages, edges: projectedEdges };
}

export function applyTraceFrameVisibility(
  projection: TraceProjection,
  expandedContainerIds: ReadonlySet<string>,
): TraceProjection {
  const messageMap = new Map(projection.messages.map(message => [message.id, message]));
  const visibleIds = new Set(messageMap.keys());
  const childrenByRelation = new Map<string, Set<string>>();
  for (const edge of projection.edges) {
    const children = childrenByRelation.get(edge.relationMessageId) ?? new Set<string>();
    for (const id of [edge.from.messageId, edge.to.messageId]) {
      if (!id.startsWith('anon:') && id !== edge.relationMessageId && messageMap.has(id)) children.add(id);
    }
    childrenByRelation.set(edge.relationMessageId, children);
  }
  const hideNonCardSubtree = (relationId: string, visited = new Set<string>()): void => {
    if (visited.has(relationId)) return;
    visited.add(relationId);
    for (const childId of childrenByRelation.get(relationId) ?? []) {
      const child = messageMap.get(childId);
      if (child?.kind === 'relation' && isTraceTextLikeMessage(child)) continue;
      visibleIds.delete(childId);
      if (child?.kind === 'relation') hideNonCardSubtree(childId, visited);
    }
  };
  for (const message of projection.messages) {
    if (expandedContainerIds.has(message.id)) continue;
    const relationType = message.relationType?.toLowerCase();
    if (relationType === 'classify' || relationType === 'summary') hideNonCardSubtree(message.id);
  }

  const messages = projection.messages.filter(message => visibleIds.has(message.id));
  const edges = projection.edges.filter(edge => {
    if (isTraceTextLikeMessage(messageMap.get(edge.relationMessageId))) return visibleIds.has(edge.relationMessageId);
    return visibleIds.has(edge.relationMessageId)
      && (edge.from.messageId.startsWith('anon:') || visibleIds.has(edge.from.messageId))
      && (edge.to.messageId.startsWith('anon:') || visibleIds.has(edge.to.messageId));
  });
  return { messages, edges };
}