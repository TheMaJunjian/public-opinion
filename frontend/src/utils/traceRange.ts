import type {DemoEdge,DemoMessage} from './modelBridge';
import {isTraceTextLikeMessage,isSettlementRecord} from './modelBridge';
import {getPresentationSpec} from '../types';

export type TraceDirection='up'|'down'|'both';
export type TraceDepths={up:number;down:number};
export const DEFAULT_TRACE_DEPTHS:Readonly<TraceDepths>={up:1,down:2};
export const traceDepths=(distance:number,direction:TraceDirection='both'):TraceDepths=>({up:direction==='down'?0:distance,down:direction==='up'?0:distance});
export const TRACE_DIRECTION_LABELS:Record<TraceDirection,string>={up:'向上：前因／依据',down:'向下：后续／影响',both:'双向：前因与后续'};

/** Content endpoints and arrangement membership cost a hop; pure relation records do not. */
export function traceRange(messages:DemoMessage[],edges:DemoEdge[],starts:string[],distance:number|TraceDepths,direction:TraceDirection='both'){
  const ids=new Set(messages.map(message=>message.id)),messageMap=new Map(messages.map(message=>[message.id,message]));
  const up=new Map<string,Set<string>>(),down=new Map<string,Set<string>>();
  const arrangementMembers=new Map<string,Set<string>>();
  const add=(map:Map<string,Set<string>>,from:string,to:string)=>{
    if(from===to||!ids.has(from)||!ids.has(to))return;
    const values=map.get(from)??new Set<string>();values.add(to);map.set(from,values);
  };
  const connect=(from:string,to:string)=>{add(up,from,to);add(down,to,from);};
  for(const edge of edges){
    if(['read','unread'].includes(edge.relationType))continue;
    const owner=edge.relationMessageId,target=edge.to.messageId,source=edge.from.messageId;
    if([owner,source,target].some(id=>isSettlementRecord(messageMap.get(id))))continue;
    // JOIN history cannot bridge former siblings. Active memberships arrive
    // as edges owned by the current container instead.
    if(String(edge.relationType)==='join'||messageMap.get(owner)?.kind==='join'
      ||String(messageMap.get(owner)?.relationType)==='join')continue;
    if(edge.relationType==='arrange'){
      const members=arrangementMembers.get(owner)??new Set<string>();
      for(const id of [owner,source,target])if(ids.has(id)&&!id.startsWith('anon:'))members.add(id);
      arrangementMembers.set(owner,members);
      continue;
    }
    // Classifications, summaries and merges retain ownership context only.
    if(getPresentationSpec(edge.relationType).isContainer)continue;
    const realSource=ids.has(source)&&!source.startsWith('anon:')?source:owner;
    connect(realSource,target);
    if(owner!==realSource){connect(owner,realSource);connect(owner,target);}
  }
  const arrangementsByMessage=new Map<string,Set<string>>();
  for(const [arrangement,members] of arrangementMembers)for(const member of members){
    const owners=arrangementsByMessage.get(member)??new Set<string>();owners.add(arrangement);arrangementsByMessage.set(member,owners);
  }
  const distances=new Map<string,number>(),queue=starts.filter(id=>ids.has(id));
  queue.forEach(id=>distances.set(id,0));
  const transparentIds=new Set(messages.filter(message=>message.kind==='relation'
    &&!isTraceTextLikeMessage(message)&&!getPresentationSpec(message.relationType??'').isContainer).map(message=>message.id));
  const walk=(maximum:number,maps:Array<Map<string,Set<string>>>)=>{
    const visited=new Map(queue.map(id=>[id,0])),pending:string[][]=[[...queue]],expandedArrangements=new Set<string>();
    const limit=Math.max(0,Math.floor(maximum));
    // A disabled direction keeps only the explicit origins.
    if(limit===0)return;
    // Process distance buckets in order so a later zero-cost route can replace
    // an earlier, longer route before an arrangement is expanded.
    for(let depth=0;depth<pending.length;depth++)for(let index=0;index<(pending[depth]?.length??0);index++){
      const id=pending[depth][index];if(visited.get(id)!==depth)continue;
      const visit=(target:string,cost:number)=>{
        const next=depth+cost;
        if(next>limit||next>=(visited.get(target)??Infinity))return;
        visited.set(target,next);(pending[next]??=[]).push(target);
        distances.set(target,Math.min(next,distances.get(target)??Infinity));
      };
      for(const map of maps)for(const target of map.get(id)??[])visit(target,transparentIds.has(target)?0:1);
      // Peers have no causal direction. Expand each arrangement once per walk
      // to avoid building a quadratic set of pairwise membership edges.
      for(const arrangement of arrangementsByMessage.get(id)??[]){
        if(expandedArrangements.has(arrangement))continue;
        expandedArrangements.add(arrangement);
        for(const member of arrangementMembers.get(arrangement)!)visit(member,1);
      }
    }
  };
  if(typeof distance==='number')walk(distance,direction==='up'?[up]:direction==='down'?[down]:[up,down]);
  else {walk(distance.up,[up]);walk(distance.down,[down]);}
  return {distances,ids:new Set(distances.keys()),up,down};
}
