import type {DemoEdge,DemoMessage} from './modelBridge';
import {getPresentationSpec} from '../types';

export type TraceDirection='up'|'down'|'both';
export type TraceDepths={up:number;down:number};
export const traceDepths=(distance:number,direction:TraceDirection='both'):TraceDepths=>({up:direction==='down'?0:distance,down:direction==='up'?0:distance});
export const TRACE_DIRECTION_LABELS:Record<TraceDirection,string>={up:'向上：前因／依据',down:'向下：后续／影响',both:'双向：前因与后续'};

/** Semantic connections have unit cost, independently of their card/label rendering. */
export function traceRange(messages:DemoMessage[],edges:DemoEdge[],starts:string[],distance:number|TraceDepths,direction:TraceDirection='both'){
  const ids=new Set(messages.map(message=>message.id)),messageMap=new Map(messages.map(message=>[message.id,message]));
  const up=new Map<string,Set<string>>(),down=new Map<string,Set<string>>();
  const add=(map:Map<string,Set<string>>,from:string,to:string)=>{
    if(from===to||!ids.has(from)||!ids.has(to))return;
    const values=map.get(from)??new Set<string>();values.add(to);map.set(from,values);
  };
  const connect=(from:string,to:string)=>{add(up,from,to);add(down,to,from);};
  for(const edge of edges){
    if(['read','unread'].includes(edge.relationType))continue;
    const owner=edge.relationMessageId,target=edge.to.messageId,source=edge.from.messageId;
    // Placement records describe where a message is stored, not a discussion
    // connection. In particular, a multi-target JOIN must not bridge siblings.
    if(getPresentationSpec(edge.relationType).isContainer||String(edge.relationType)==='join'
      ||messageMap.get(owner)?.kind==='join'||String(messageMap.get(owner)?.relationType)==='join')continue;
    const realSource=ids.has(source)&&!source.startsWith('anon:')?source:owner;
    connect(realSource,target);
    if(owner!==realSource){connect(owner,realSource);connect(owner,target);}
  }
  const distances=new Map<string,number>(),queue=starts.filter(id=>ids.has(id));
  queue.forEach(id=>distances.set(id,0));
  const walk=(maximum:number,maps:Array<Map<string,Set<string>>>)=>{
    const visited=new Map(queue.map(id=>[id,0])),pending=[...queue];
    for(let index=0;index<pending.length;index++){
      const id=pending[index],depth=visited.get(id)!+1;
      if(depth>Math.max(0,Math.floor(maximum)))continue;
      for(const map of maps)for(const target of map.get(id)??[])if(!visited.has(target)){
        visited.set(target,depth);pending.push(target);
        distances.set(target,Math.min(depth,distances.get(target)??Infinity));
      }
    }
  };
  if(typeof distance==='number')walk(distance,direction==='up'?[up]:direction==='down'?[down]:[up,down]);
  else {walk(distance.up,[up]);walk(distance.down,[down]);}
  return {distances,ids:new Set(distances.keys()),up,down};
}
