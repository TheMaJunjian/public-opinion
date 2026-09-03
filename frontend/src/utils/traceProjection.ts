import type { DemoEdge, DemoMessage } from './modelBridge';
import { isTraceTextLikeMessage } from './modelBridge';

const TRACE_CONTAINERS = new Set(['classify', 'summary']);

export interface TraceProjectionInput {
  messages: DemoMessage[];
  edges: DemoEdge[];
  startIds: string[];
  distance: number;
  expandedContainerIds?: ReadonlySet<string>;
}

export interface TraceProjection {
  messages: DemoMessage[];
  edges: DemoEdge[];
}

function isTraceContainerType(type: string | undefined): boolean {
  return !!type && TRACE_CONTAINERS.has(type.toLowerCase());
}

function isContainerEdge(edge: DemoEdge): boolean {
  return isTraceContainerType(edge.relationType);
}

function addAdjacency(adjacency: Map<string, Set<string>>, left: string, right: string): void {
  if (!adjacency.has(left)) adjacency.set(left, new Set());
  if (!adjacency.has(right)) adjacency.set(right, new Set());
  adjacency.get(left)!.add(right);
  adjacency.get(right)!.add(left);
}

/**
 * Builds the ordinary GraphView input for a trace window.
 * Distance selects candidates; expansion changes only which container edges
 * survive, so GraphView can use its existing frame/card rendering unchanged.
 */
export function buildTraceProjection(input: TraceProjectionInput): TraceProjection {
  const { messages, edges, startIds, distance } = input;
  const messageMap = new Map(messages.map(message => [message.id, message]));
  const expanded = new Set(input.expandedContainerIds ?? []);
  const containerChildren = new Map<string, Set<string>>();
  const adjacency = new Map<string, Set<string>>();

  for (const edge of edges) {
    if (isContainerEdge(edge)) {
      const children = containerChildren.get(edge.relationMessageId) ?? new Set<string>();
      for (const id of [edge.from.messageId, edge.to.messageId]) {
        if (!id.startsWith('anon:') && id !== edge.relationMessageId) children.add(id);
      }
      containerChildren.set(edge.relationMessageId, children);
      continue;
    }

    const from = messageMap.get(edge.from.messageId);
    const to = messageMap.get(edge.to.messageId);
    const relation = messageMap.get(edge.relationMessageId);
    if (isTraceTextLikeMessage(from) || isTraceTextLikeMessage(to)) {
      addAdjacency(adjacency, edge.from.messageId, edge.to.messageId);
    }
    if (isTraceTextLikeMessage(relation)) {
      addAdjacency(adjacency, edge.relationMessageId, edge.from.messageId);
      addAdjacency(adjacency, edge.relationMessageId, edge.to.messageId);
    }
  }

  const distances = new Map<string, number>();
  const queue = startIds.filter(id => messageMap.has(id));
  for (const id of queue) distances.set(id, 0);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const currentDistance = distances.get(current)!;
    if (currentDistance >= distance) continue;
    for (const next of adjacency.get(current) ?? []) {
      if (distances.has(next)) continue;
      distances.set(next, currentDistance + 1);
      queue.push(next);
    }
  }

  const containerDistance = new Map<string, number>();
  let distanceChanged = true;
  while (distanceChanged) {
    distanceChanged = false;
    for (const [containerId, children] of containerChildren) {
      const directDistance = distances.get(containerId);
      const childDistance = Math.min(
        ...[...children]
          .map(childId => distances.get(childId) ?? containerDistance.get(childId))
          .filter((value): value is number => value !== undefined)
          .map(value => value + 1),
      );
      const minDistance = Math.min(directDistance ?? Infinity, childDistance);
      if (minDistance <= distance && minDistance < (containerDistance.get(containerId) ?? Infinity)) {
        containerDistance.set(containerId, minDistance);
        distanceChanged = true;
      }
    }
  }

  const visibleIds = new Set<string>(
    [...distances].filter(([, value]) => value <= distance).map(([id]) => id),
  );
  for (const containerId of containerDistance.keys()) visibleIds.add(containerId);

  const parentByContainer = new Map<string, string>();
  for (const [parentId, children] of containerChildren) {
    for (const childId of children) {
      if (containerChildren.has(childId) && !parentByContainer.has(childId)) {
        parentByContainer.set(childId, parentId);
      }
    }
  }
  // A traced nested container is represented by its nearest parent card until
  // the nested container itself is opened.
  for (const startId of startIds) {
    if (!containerChildren.has(startId) || expanded.has(startId)) continue;
    const parentId = parentByContainer.get(startId);
    if (parentId) {
      visibleIds.delete(startId);
      visibleIds.add(parentId);
    }
  }

  // Apply the container tree from the outside in. A collapsed container is an
  // opaque boundary; an expanded one exposes only its direct members.
  const resolveContainer = (containerId: string, ancestors: Set<string>): void => {
    if (ancestors.has(containerId)) return;
    const nextAncestors = new Set(ancestors).add(containerId);
    const children = containerChildren.get(containerId) ?? new Set<string>();
    if (!expanded.has(containerId)) {
      for (const childId of children) {
        if (!containerChildren.has(childId)) visibleIds.delete(childId);
        resolveContainer(childId, nextAncestors);
      }
      return;
    }
    for (const childId of children) {
      visibleIds.add(childId);
      if (containerChildren.has(childId)) resolveContainer(childId, nextAncestors);
    }
  };

  for (const containerId of containerDistance.keys()) resolveContainer(containerId, new Set());

  // CORRECT is a version relation, not a container boundary. Keep its paired
  // message only when the visible side already belongs to this projection.
  for (const edge of edges) {
    if (edge.relationType.toLowerCase() !== 'correct') continue;
    if (!visibleIds.has(edge.from.messageId) && !visibleIds.has(edge.to.messageId)) continue;
    visibleIds.add(edge.from.messageId);
    visibleIds.add(edge.to.messageId);
    visibleIds.add(edge.relationMessageId);
  }

  const projectedMessages = messages.filter(message => visibleIds.has(message.id));
  const projectedMessageIds = new Set(projectedMessages.map(message => message.id));
  const structuralExpanded = new Set(expanded);
  for (const containerId of expanded) {
    const parentId = parentByContainer.get(containerId);
    if (parentId) structuralExpanded.add(parentId);
  }
  const projectedEdges = edges.filter(edge => {
    const owner = edge.relationMessageId;
    if (isContainerEdge(edge)) {
      // A container edge creates a frame only when that container is expanded.
      if (!structuralExpanded.has(owner) || !containerDistance.has(owner)) return false;
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