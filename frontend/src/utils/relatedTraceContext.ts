import type { Message, Relation } from '../types';
import { convertMessagesToDemoModel, isCardMessage, type DemoMessage, type DemoEdge } from './modelBridge';

export type RelatedTraceContext = { messages: DemoMessage[]; edges: DemoEdge[]; relations: Relation[] };

/** Fetch only missing endpoints; transparent relation targets may need their own endpoints. */
export async function loadRelatedTraceContext(messageId: string, messages: DemoMessage[], edges: DemoEdge[],
  load: (ids: string[]) => Promise<{ messages: Message[]; relations: Relation[] }>,
): Promise<RelatedTraceContext> {
  const catalog = new Map(messages.map(message => [message.id, message]));
  const links = new Map<string, DemoEdge[]>();
  const addEdges = (edges: DemoEdge[]) => {
    for (const edge of edges) {
      const own = links.get(edge.relationMessageId) ?? [];
      own.push(edge); links.set(edge.relationMessageId, own);
    }
  };
  addEdges(edges);
  const result: RelatedTraceContext = { messages: [], edges: [], relations: [] };
  const visited = new Set<string>();
  let queue = [messageId];
  while (queue.length) {
    const next = new Set<string>();
    for (const id of queue) {
      if (visited.has(id)) continue;
      visited.add(id);
      if (id !== messageId && isCardMessage(catalog.get(id))) continue;
      for (const edge of links.get(id) ?? []) for (const endpoint of [edge.from.messageId, edge.to.messageId]) {
        if (!endpoint.startsWith('anon:') && !visited.has(endpoint)) next.add(endpoint);
      }
    }
    const missing = [...next].filter(id => !catalog.has(id));
    for (let offset = 0; offset < missing.length; offset += 50) {
      const ids = missing.slice(offset, offset + 50);
      const page = await load(ids);
      const converted = convertMessagesToDemoModel(page.messages, page.relations);
      for (const message of converted.messages) catalog.set(message.id, message);
      if (ids.some(id => !catalog.has(id))) throw new Error('关联消息未能完整加载，请重试');
      result.messages.push(...converted.messages); result.edges.push(...converted.edges); result.relations.push(...page.relations);
      addEdges(converted.edges);
    }
    queue = [...next];
  }
  return result;
}
