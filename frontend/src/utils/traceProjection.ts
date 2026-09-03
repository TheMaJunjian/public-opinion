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

/** Build the ordinary GraphView input for a distance-limited trace. */
export function buildTraceProjection(input: TraceProjectionInput): TraceProjection {
  const { messages, edges, startIds, distance } = input;
  const messageMap = new Map(messages.map(message => [message.id, message]));
  const adjacency = new Map<string, Set<string>>();

  for (const edge of edges) {
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
  const queue: string[] = [];
  for (const id of startIds) {
    if (!messageMap.has(id) || distances.has(id)) continue;
    distances.set(id, 0);
    queue.push(id);
  }
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

  const visibleIds = new Set(
    [...distances].filter(([, value]) => value <= distance).map(([id]) => id),
  );
  const projectedMessages = messages.filter(message => visibleIds.has(message.id));
  const projectedMessageIds = new Set(projectedMessages.map(message => message.id));
  const projectedEdges = edges.filter(edge => {
    if (!projectedMessageIds.has(edge.relationMessageId)) return false;
    const fromVisible = edge.from.messageId.startsWith('anon:') || projectedMessageIds.has(edge.from.messageId);
    const toVisible = edge.to.messageId.startsWith('anon:') || projectedMessageIds.has(edge.to.messageId);
    return fromVisible && toVisible;
  });

  return { messages: projectedMessages, edges: projectedEdges };
}
