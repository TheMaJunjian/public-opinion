import {normalizeHomeFilter,type HomeFilterMode} from '../model/homeFilter';
import type {ReadingMark} from '@gonglun/core';
import type {User,Relation} from '../../../types';
import {isCardMessage,type DemoEdge,type DemoMessage,type CorrectionVersion} from '../../../utils/modelBridge';
import type {TraceContainerMembership} from '../../../utils/traceProjection';
import {buildHomeFilterDisplayIds} from '../model/filters';
import {deriveReadingProgress} from '../model/readingProgress';

interface DeriveHomeFilterResultInput {
  displayUser:User|null;homeFilterMode:HomeFilterMode|null;msgMap:Map<string,DemoMessage>;messages:DemoMessage[];
  readStatusByMessageId:Map<string,'READ'|'UNREAD'>;edges:DemoEdge[];traceContainerMemberships:TraceContainerMembership[];
  relations?:Relation[];readingMarks?:ReadingMark[];corrections?:Map<string,{current?:CorrectionVersion;versions?:CorrectionVersion[]}>;
}
export function deriveHomeFilterResult(input:DeriveHomeFilterResultInput):{matchIds:Set<string>;displayIds:Set<string>}|null {
  if(input.homeFilterMode===null)return null;
  const selected=normalizeHomeFilter(input.homeFilterMode),username=input.displayUser?.username;
  const own=new Set(input.messages.filter(message=>message.author===username).map(message=>message.id));
  const related=new Set(own),following=new Set<string>();
  for(const edge of input.edges){
    if(['read','unread'].includes(edge.relationType))continue;
    const ids=[edge.relationMessageId,edge.from.messageId,edge.to.messageId];
    if(ids.some(id=>own.has(id)))ids.forEach(id=>related.add(id));
  }
  const latest=new Map<string,Relation>();
  for(const relation of input.relations??[]){
    if(relation.relationType!=='ATTENTION'||relation.createdBy.username!==username)continue;
    for(const ref of relation.targetRefs){
      const id=ref.kind==='relation'?ref.relationId:ref.messageId,previous=latest.get(id);
      if(!previous||(relation.sequence&&previous.sequence?relation.sequence>previous.sequence:relation.createdAt>=previous.createdAt))latest.set(id,relation);
    }
  }
  for(const [id,relation] of latest)if(relation.payload?.subType!=='NO')following.add(id);
  let expanded=true;
  while(expanded){
    expanded=false;
    for(const membership of input.traceContainerMemberships)if(following.has(membership.containerId))for(const id of membership.targetIds){
      if(!following.has(id)){following.add(id);expanded=true;}
    }
  }
  const reading=deriveReadingProgress({messages:input.messages,edges:input.edges,relations:input.relations??[],username:username??null,
    readStatus:input.readStatusByMessageId,marks:input.readingMarks,corrections:input.corrections,memberships:input.traceContainerMemberships});
  const matchIds=new Set(input.messages.filter(message=>isCardMessage(message)||message.relationType==='correct').filter(message=>{
    const id=message.id;
    if(selected.scope==='self'&&!own.has(id)||selected.scope==='related'&&!related.has(id)||selected.scope==='following'&&!following.has(id))return false;
    return selected.status==='all'||(selected.status==='confirmed'?reading.confirmed(id):!reading.confirmed(id));
  }).map(message=>message.id));
  return {matchIds,displayIds:buildHomeFilterDisplayIds(matchIds,input.edges,{includeRelationContext:true,containerMemberships:input.traceContainerMemberships})};
}
