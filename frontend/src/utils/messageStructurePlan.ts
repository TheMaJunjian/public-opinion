import type { DemoMessage, DemoEdge } from './modelBridge';
import { projectGraphScene } from './graphProjection';
import { computeFrameSceneLayout } from './frameLayoutCore';
import {chronologicalOrder} from './discussionOrder';
import { isCardMessage } from './modelBridge';
import { edgeDisplayDependencyIds } from './displayDependency';

export interface MessageStructureInput { messages: DemoMessage[]; edges: DemoEdge[]; order?:'placement'|'time' }

function placementFor(messages: DemoMessage[], edges: DemoEdge[]) {
  const scene = projectGraphScene({ messages, edges, traceExpandedFrameIds: new Set(), isTraceWindow: false });
  const { placementOrder } = computeFrameSceneLayout({ normals: scene.normals, colOf: scene.pipelineCol,
    maxCol: scene.pipelineMaxCol, measuredHeights: {}, measuredWidths: {}, correctedTargetIds: scene.hiddenTargetIds,
    frameBlocks: scene.frameBlocks, allMessages: messages, edges: scene.layoutEdges });
  return placementOrder;
}

/** Page bodies with their attached records, keeping independent discussion bodies separate. */
function timePlan(messages: DemoMessage[], edges: DemoEdge[], placementOrder: string[]) {
  const records = new Map<string, DemoMessage>();
  for (const message of messages) if (!records.has(message.id)) records.set(message.id, message);
  const earlier = (a: string, b: string) => chronologicalOrder(records.get(a)!, records.get(b)!);
  const sources = new Map<string, string>(), edgeOnlySources = new Map<string, string>(), edgeOnlyTargets = new Map<string, string>();
  const edgesByRecord = new Map<string, DemoEdge[]>();
  const displayDependencies = new Map<string, string[]>();
  const pinSets = new Map<string, Set<string>>();
  for (const edge of edges) {
    const ownEdges = edgesByRecord.get(edge.relationMessageId) ?? [];
    ownEdges.push(edge); edgesByRecord.set(edge.relationMessageId, ownEdges);
    const record = records.get(edge.relationMessageId), source = records.get(edge.from.messageId);
    if (source && source.id !== edge.relationMessageId && (!record || record.kind === 'relation' || record.kind === 'join')) {
      const map = record ? sources : edgeOnlySources, previous = map.get(edge.relationMessageId);
      if (!previous || earlier(source.id, previous) < 0) map.set(edge.relationMessageId, source.id);
    }
    // An edge-only anonymous record has no date/body to page independently;
    // its known target provides a navigation key without merging target units.
    if (!record && !source && records.has(edge.to.messageId)) {
      const previous = edgeOnlyTargets.get(edge.relationMessageId);
      if (!previous || earlier(edge.to.messageId, previous) < 0) edgeOnlyTargets.set(edge.relationMessageId, edge.to.messageId);
    }
    if ((!record || record.kind === 'relation' || record.kind === 'join')
      && !['classify', 'summary', 'merge', 'arrange', 'join'].includes(edge.relationType)) {
      const own = pinSets.get(edge.relationMessageId) ?? new Set<string>();
      for (const id of [edge.from.messageId, edge.to.messageId]) if (records.has(id)) own.add(id);
      pinSets.set(edge.relationMessageId, own);
    }
  }
  for (const record of records.values()) {
    if (isCardMessage(record)) continue;
    const hosts = edgeDisplayDependencyIds(record, edgesByRecord.get(record.id) ?? [])
      ?.filter(id => id !== record.id && records.has(id)).sort(earlier);
    if (hosts?.length) displayDependencies.set(record.id, hosts);
    // A pure vote/tag has no independent body to load. Reveal it with its host
    // rather than spending whole pages on invisible decoration records.
    if (hosts?.length && !sources.has(record.id)) sources.set(record.id, hosts[0]);
  }
  for (const [id, target] of edgeOnlyTargets) if (!edgeOnlySources.has(id)) edgeOnlySources.set(id, target);
  // Resolve display ownership only. Cyclic malformed dependencies retain one
  // stable record as the unit; independent addressed bodies are never merged.
  const byId = new Map<string, string>();
  for (const start of records.keys()) {
    if (byId.has(start)) continue;
    const path: string[] = [], offsets = new Map<string, number>();
    let id = start;
    while (!byId.has(id) && !offsets.has(id) && sources.has(id)) {
      offsets.set(id, path.length); path.push(id); id = sources.get(id)!;
    }
    let root = byId.get(id) ?? id;
    if (offsets.has(id)) for (let index = offsets.get(id)!; index < path.length; index++) if (earlier(path[index], root) < 0) root = path[index];
    byId.set(id, root);
    for (const member of path) byId.set(member, root);
  }
  for (const [id, source] of edgeOnlySources) byId.set(id, byId.get(source) ?? source);
  const ordered = [...records.values()].sort(chronologicalOrder).map(message => message.id);
  const units = [...new Set(ordered.map(id => byId.get(id)!))].sort(earlier);
  return { byId, units, order: ordered, displayDependencies,
    placementOrder: [...new Set([...placementOrder, ...records.keys()])].filter(id => records.has(id)),
    pinDependencies: new Map([...pinSets].map(([id, dependencies]) => [id, [...dependencies]])) };
}

/** Chronological paging is independent of the optional legacy placement plan. */
export function planChronologicalMessageUnits(messages: DemoMessage[], edges: DemoEdge[]) {
  return timePlan(messages, edges, []);
}

export function planMessageStructures({ messages, edges, order='placement' }: MessageStructureInput) {
  const placementOrder = placementFor(messages, edges);
  if (order === 'time') return timePlan(messages, edges, placementOrder);
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
  // Whole connected structures are the paging unit. Within each, retain the
  // graph's frame/member preorder; relation-only records follow their members.
  const discussionOrder=[...new Set([...placementOrder,...messages.map(message=>message.id)])];
  const orderedIds=discussionOrder;
  // Paging intervals must contain all intervening discussion groups. Otherwise
  // mounting a later unit can insert an unmeasured group above an earlier one.
  const intervals=new Map<string,{first:number;last:number}>();
  placementOrder.forEach((id,index)=>{const key=byId.get(id);if(!key)return;const span=intervals.get(key);if(span)span.last=index;else intervals.set(key,{first:index,last:index});});
  const merged=new Map<string,string>();let active:{key:string;last:number}|null=null;
  for(const [key,span] of [...intervals].sort((a,b)=>a[1].first-b[1].first)){
    if(!active||span.first>active.last)active={key,last:span.last};else active.last=Math.max(active.last,span.last);
    merged.set(key,active.key);
  }
  for(const [id,key] of byId)byId.set(id,merged.get(key)??key);
  const units=[...new Set(orderedIds.map(id=>byId.get(id)).filter((id):id is string=>id!==undefined))];
  return {byId,units,order:orderedIds.filter(id=>ids.has(id)),placementOrder:discussionOrder.filter(id=>ids.has(id)),pinDependencies:new Map<string,string[]>(),displayDependencies:new Map<string,string[]>()};
}
