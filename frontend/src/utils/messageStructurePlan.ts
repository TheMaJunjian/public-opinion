import type { DemoMessage, DemoEdge } from './modelBridge';
import { projectGraphScene } from './graphProjection';
import { computeSceneLayout } from './frameLayout';
import {chronologicalOrder} from './discussionOrder';

export interface MessageStructureInput { messages: DemoMessage[]; edges: DemoEdge[]; order?:'placement'|'time' }

/** Page complete structures, with chronological rows for the message list. */
export function planMessageStructures({ messages, edges, order='placement' }: MessageStructureInput) {
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
  const discussionOrder=[...new Set([...placementOrder,...messages.map(message=>message.id)])];
  const orderedIds=order==='time'?[...messages].sort(chronologicalOrder).map(message=>message.id):discussionOrder;
  // Paging intervals must contain all intervening discussion groups. Otherwise
  // mounting a later unit can insert an unmeasured group above an earlier one.
  const intervals=new Map<string,{first:number;last:number}>();
  (order==='time'?orderedIds:placementOrder).forEach((id,index)=>{const key=byId.get(id);if(!key)return;const span=intervals.get(key);if(span)span.last=index;else intervals.set(key,{first:index,last:index});});
  const merged=new Map<string,string>();let active:{key:string;last:number}|null=null;
  for(const [key,span] of [...intervals].sort((a,b)=>a[1].first-b[1].first)){
    if(!active||span.first>active.last)active={key,last:span.last};else active.last=Math.max(active.last,span.last);
    merged.set(key,active.key);
  }
  for(const [id,key] of byId)byId.set(id,merged.get(key)??key);
  const units=[...new Set(orderedIds.map(id=>byId.get(id)).filter((id):id is string=>id!==undefined))];
  return {byId,units,order:orderedIds.filter(id=>ids.has(id)),placementOrder:discussionOrder.filter(id=>ids.has(id))};
}
