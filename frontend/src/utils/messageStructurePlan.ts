import type { DemoMessage, DemoEdge } from './modelBridge';
import { projectGraphScene } from './graphProjection';
import { computeSceneLayout } from './frameLayout';

export interface MessageStructureInput { messages: DemoMessage[]; edges: DemoEdge[] }

/** Use the same organization/placement rules as the graph, including in the table. */
export function planMessageStructures({ messages, edges }: MessageStructureInput) {
  const ids = new Set(messages.map(message => message.id));
  const parents = new Map(messages.map(message => [message.id, message.id]));
  const find = (id: string): string => {
    let root = id;
    while (parents.get(root) !== root) root = parents.get(root)!;
    while (id !== root) { const next = parents.get(id)!; parents.set(id, root); id = next; }
    return root;
  };
  for (const edge of edges) {
    // Never pull descendants of a closed classification into this scope.
    const endpoints = [edge.from.messageId, edge.to.messageId].filter(id => ids.has(id));
    if (!ids.has(edge.relationMessageId) && !endpoints.length) continue;
    if (!parents.has(edge.relationMessageId)) parents.set(edge.relationMessageId, edge.relationMessageId);
    for (const id of endpoints) parents.set(find(id), find(edge.relationMessageId));
  }
  const byId = new Map([...parents.keys()].map(id => [id, find(id)]));
  const scene = projectGraphScene({ messages, edges, traceExpandedFrameIds: new Set(), isTraceWindow: false });
  const { placementOrder } = computeSceneLayout({ normals: scene.normals, colOf: scene.pipelineCol,
    maxCol: scene.pipelineMaxCol, measuredHeights: {}, measuredWidths: {}, correctedTargetIds: scene.hiddenTargetIds,
    frameBlocks: scene.frameBlocks, allMessages: messages, edges: scene.layoutEdges });
  // Whole connected structures are the paging unit. Within each, retain the
  // graph's frame/member preorder; relation-only records follow their members.
  const orderedIds = [...new Set([...placementOrder, ...messages.map(message => message.id)])];
  const units = [...new Set(orderedIds.map(id => byId.get(id)).filter((id): id is string => id !== undefined))];
  const members = new Map(units.map(id => [id, [] as string[]]));
  for (const id of orderedIds) if (ids.has(id)) members.get(byId.get(id)!)!.push(id);
  return { byId, units, order: units.flatMap(id => members.get(id)!) };
}
