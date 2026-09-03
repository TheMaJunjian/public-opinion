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
  distanceMessageIds?: ReadonlySet<string>;
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
  const distanceMessageIds = new Set(visibleIds);

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
      const isCorrect = relationType === 'correct';
      const shouldComplete = isInlineFrame
        ? visibleIds.has(relationId) || [...targetIds].some(id => visibleIds.has(id))
        : isCorrect
          ? [...sourceIds, ...targetIds].some(id => visibleIds.has(id))
          : [...targetIds].some(id => visibleIds.has(id));
      const allEndpointsVisible = [...sourceIds, ...targetIds].every(id => visibleIds.has(id));
      if (!shouldComplete && !allEndpointsVisible) continue;

      const dependencyIds = isInlineFrame
        ? [relationId, ...sourceIds, ...targetIds]
        : isCorrect
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

  return { messages: projectedMessages, edges: projectedEdges, distanceMessageIds };
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

  const containerIds = new Set(
    projection.messages
      .filter(message => message.kind === 'relation'
        && ['classify', 'summary'].includes(message.relationType?.toLowerCase() ?? ''))
      .map(message => message.id),
  );
  const parentByContainer = new Map<string, string>();
  for (const [parentId, children] of childrenByRelation) {
    if (!containerIds.has(parentId)) continue;
    for (const childId of children) {
      if (containerIds.has(childId) && !parentByContainer.has(childId)) {
        parentByContainer.set(childId, parentId);
      }
    }
  }

  const pruneDescendants = (relationId: string, visited: Set<string>): void => {
    if (visited.has(relationId)) return;
    const nextVisited = new Set(visited).add(relationId);
    for (const childId of childrenByRelation.get(relationId) ?? []) {
      visibleIds.delete(childId);
      if (childrenByRelation.has(childId)) pruneDescendants(childId, nextVisited);
    }
  };
  const resolveContainer = (containerId: string, visited: Set<string>): void => {
    if (visited.has(containerId)) return;
    const nextVisited = new Set(visited).add(containerId);
    for (const childId of childrenByRelation.get(containerId) ?? []) {
      if (!expandedContainerIds.has(containerId)) {
        visibleIds.delete(childId);
        if (childrenByRelation.has(childId)) pruneDescendants(childId, nextVisited);
      } else {
        visibleIds.add(childId);
        if (containerIds.has(childId)) {
          resolveContainer(childId, nextVisited);
        } else if (childrenByRelation.has(childId)) {
          for (const nestedId of childrenByRelation.get(childId) ?? []) visibleIds.add(nestedId);
        }
      }
    }
  };
  for (const containerId of projection.messages.map(message => message.id).filter(id => containerIds.has(id))) {
    const parentId = parentByContainer.get(containerId);
    if (!parentId || !visibleIds.has(parentId)) resolveContainer(containerId, new Set());
  }

  let removedDependency = true;
  while (removedDependency) {
    removedDependency = false;
    for (const edge of projection.edges) {
      if (!visibleIds.has(edge.relationMessageId) || isTraceTextLikeMessage(messageMap.get(edge.relationMessageId))) continue;
      const relationType = messageMap.get(edge.relationMessageId)?.relationType?.toLowerCase();
      const sourceVisible = edge.from.messageId.startsWith('anon:') || visibleIds.has(edge.from.messageId);
      const targetVisible = edge.to.messageId.startsWith('anon:') || visibleIds.has(edge.to.messageId);
      if (relationType === 'correct' ? sourceVisible && targetVisible : targetVisible) continue;
      visibleIds.delete(edge.relationMessageId);
      const dependencyIds = relationType === 'correct'
        ? [edge.from.messageId, edge.to.messageId]
        : [edge.from.messageId];
      for (const dependencyId of dependencyIds) {
        if (dependencyId.startsWith('anon:') || projection.distanceMessageIds?.has(dependencyId)) continue;
        visibleIds.delete(dependencyId);
      }
      removedDependency = true;
    }
  }

  const messages = projection.messages.filter(message => visibleIds.has(message.id));
  const edges = projection.edges.filter(edge => {
    if (isTraceTextLikeMessage(messageMap.get(edge.relationMessageId))) return visibleIds.has(edge.relationMessageId);
    return visibleIds.has(edge.relationMessageId)
      && (edge.from.messageId.startsWith('anon:') || visibleIds.has(edge.from.messageId))
      && (edge.to.messageId.startsWith('anon:') || visibleIds.has(edge.to.messageId));
  });
  return { messages, edges, distanceMessageIds: projection.distanceMessageIds };
}