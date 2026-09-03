import type { DemoEdge, DemoMessage } from './modelBridge';
import { isTraceTextLikeMessage } from './modelBridge';

const TRACE_CONTAINERS = new Set(['classify', 'summary']);
const INLINE_FRAMES = new Set(['arrange', 'merge']);

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
  const inlineFrameChildren = new Map<string, Set<string>>();
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

    if (INLINE_FRAMES.has(edge.relationType.toLowerCase())) {
      const children = inlineFrameChildren.get(edge.relationMessageId) ?? new Set<string>();
      for (const id of [edge.from.messageId, edge.to.messageId]) {
        if (!id.startsWith('anon:') && id !== edge.relationMessageId) children.add(id);
      }
      inlineFrameChildren.set(edge.relationMessageId, children);
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

  const childrenOf = (relationId: string): Set<string> =>
    containerChildren.get(relationId) ?? inlineFrameChildren.get(relationId) ?? new Set<string>();
  const pruneDescendants = (relationId: string, ancestors: Set<string>): void => {
    if (ancestors.has(relationId)) return;
    const nextAncestors = new Set(ancestors).add(relationId);
    for (const childId of childrenOf(relationId)) {
      visibleIds.delete(childId);
      if (containerChildren.has(childId) || inlineFrameChildren.has(childId)) {
        pruneDescendants(childId, nextAncestors);
      }
    }
  };

  const exposeInlineFrame = (relationId: string, ancestors: Set<string>): void => {
    if (ancestors.has(relationId)) return;
    const nextAncestors = new Set(ancestors).add(relationId);
    for (const childId of inlineFrameChildren.get(relationId) ?? []) {
      visibleIds.add(childId);
      if (containerChildren.has(childId)) {
        resolveContainer(childId, nextAncestors);
      } else if (inlineFrameChildren.has(childId)) {
        exposeInlineFrame(childId, nextAncestors);
      }
    }
  };

  // Apply the reachable container tree from the outside in. A collapsed
  // container owns and hides its complete subtree; an expanded one exposes
  // direct members, including complete inline MERGE/ARRANGE structures.
  const resolveContainer = (containerId: string, ancestors: Set<string>): void => {
    if (ancestors.has(containerId)) return;
    const nextAncestors = new Set(ancestors).add(containerId);
    const children = containerChildren.get(containerId) ?? new Set<string>();
    if (!expanded.has(containerId)) {
      for (const childId of children) {
        visibleIds.delete(childId);
        if (containerChildren.has(childId) || inlineFrameChildren.has(childId)) {
          pruneDescendants(childId, nextAncestors);
        }
      }
      return;
    }
    for (const childId of children) {
      visibleIds.add(childId);
      if (containerChildren.has(childId)) {
        resolveContainer(childId, nextAncestors);
      } else if (inlineFrameChildren.has(childId)) {
        exposeInlineFrame(childId, nextAncestors);
      }
    }
  };

  const reachableContainerIds = new Set(containerDistance.keys());
  for (const containerId of reachableContainerIds) {
    const parentId = parentByContainer.get(containerId);
    if (!parentId || !reachableContainerIds.has(parentId)) {
      resolveContainer(containerId, new Set());
    }
  }

  // CORRECT is a version relation, not a container boundary. Keep its paired
  // message only when the visible side already belongs to this projection.
  for (const edge of edges) {
    if (edge.relationType.toLowerCase() !== 'correct') continue;
    if (!visibleIds.has(edge.from.messageId) && !visibleIds.has(edge.to.messageId)) continue;
    visibleIds.add(edge.from.messageId);
    visibleIds.add(edge.to.messageId);
    visibleIds.add(edge.relationMessageId);
  }

  // Ordinary relations are visible objects of the projected subgraph. Their
  // labels/messages do not consume an extra hop, but survive when both real
  // endpoints are already inside the trace window.
  for (const edge of edges) {
    const relationType = edge.relationType.toLowerCase();
    if (isContainerEdge(edge) || INLINE_FRAMES.has(relationType) || relationType === 'correct') continue;
    const fromVisible = edge.from.messageId.startsWith('anon:') || visibleIds.has(edge.from.messageId);
    const toVisible = edge.to.messageId.startsWith('anon:') || visibleIds.has(edge.to.messageId);
    if (fromVisible && toVisible && messageMap.has(edge.relationMessageId)) {
      visibleIds.add(edge.relationMessageId);
    }
  }

  const projectedMessages = messages.filter(message => visibleIds.has(message.id));
  const projectedMessageIds = new Set(projectedMessages.map(message => message.id));
  const projectedEdges = edges.filter(edge => {
    const owner = edge.relationMessageId;
    if (isContainerEdge(edge)) {
      // Collapsed cards still need their edges for target counts. GraphView
      // decides card versus frame from expansion state and visible members.
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