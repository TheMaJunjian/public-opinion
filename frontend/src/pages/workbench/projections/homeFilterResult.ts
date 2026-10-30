import {normalizeHomeFilter,type HomeFilterMode} from '../model/homeFilter';
import type {ReadingMark} from '@gonglun/core';
import type {User,Relation} from '../../../types';
import {getPresentationSpec} from '../../../types';
import {isCardMessage,type DemoEdge,type DemoMessage,type CorrectionVersion} from '../../../utils/modelBridge';
import type {TraceContainerMembership} from '../../../utils/traceProjection';
import {buildHomeFilterDisplayIds} from '../model/filters';
import {deriveReadingProgress} from '../model/readingProgress';

interface DeriveHomeFilterResultInput {
  displayUser:User|null;homeFilterMode:HomeFilterMode|null;msgMap:Map<string,DemoMessage>;messages:DemoMessage[];
  readStatusByMessageId:Map<string,'READ'|'UNREAD'>;edges:DemoEdge[];traceContainerMemberships:TraceContainerMembership[];
  relations?:Relation[];readingMarks?:ReadingMark[];corrections?:Map<string,{current?:CorrectionVersion;versions?:CorrectionVersion[]}>;
}
export function deriveHomeFilterResult(input:DeriveHomeFilterResultInput):{matchIds:Set<string>;displayIds:Set<string>;reasonByMessageId:Map<string,string>}|null {
  if(input.homeFilterMode===null)return null;
  const selected=normalizeHomeFilter(input.homeFilterMode),username=input.displayUser?.username;
  const own=new Set(input.messages.filter(message=>!!username&&(message.authorId&&input.displayUser?.id
    ? message.authorId===input.displayUser.id : message.author===username)).map(message=>message.id));
  const related=new Set(own),following=new Set<string>();
  const relationLabel=(edge:DemoEdge)=>getPresentationSpec(edge.relationType).label||edge.relationLabel||edge.relationType;
  const scopeReasons=new Map<string,string>();
  own.forEach(id=>scopeReasons.set(id,'由本人发送'));
  for(const edge of input.edges){
    if(['read','unread'].includes(edge.relationType))continue;
    const ids=[edge.relationMessageId,edge.from.messageId,edge.to.messageId];
    const ownId=ids.find(id=>own.has(id));
    if(ownId)ids.forEach(id=>{
      related.add(id);
      if(!scopeReasons.has(id))scopeReasons.set(id,`通过${relationLabel(edge)}消息 ${edge.relationMessageId} 与本人消息 ${ownId} 关联`);
    });
  }
  const latest=new Map<string,Relation>();
  for(const relation of input.relations??[]){
    if(relation.relationType!=='ATTENTION'||!username||(relation.createdBy.id&&input.displayUser?.id
      ? relation.createdBy.id!==input.displayUser.id : relation.createdBy.username!==username))continue;
    for(const ref of relation.targetRefs){
      const id=ref.kind==='relation'?ref.relationId:ref.messageId,previous=latest.get(id);
      if(!previous||(relation.sequence&&previous.sequence?relation.sequence>previous.sequence:relation.createdAt>=previous.createdAt))latest.set(id,relation);
    }
  }
  const followingReasons=new Map<string,string>();
  const followingRoots=new Map<string,string>();
  for(const [id,relation] of latest)if(relation.payload?.subType!=='NO'){
    following.add(id);followingReasons.set(id,`本人已关注此消息（关注记录 ${relation.id}）`);followingRoots.set(id,id);
  }
  let expanded=true;
  while(expanded){
    expanded=false;
    for(const membership of input.traceContainerMemberships)if(following.has(membership.containerId))for(const id of membership.targetIds){
      if(!following.has(id)){
        const root=followingRoots.get(membership.containerId)!;
        following.add(id);followingRoots.set(id,root);followingReasons.set(id,`属于已关注的容器 ${root}（关注记录 ${latest.get(root)!.id}）`);expanded=true;
      }
    }
  }
  const reading=deriveReadingProgress({messages:input.messages,edges:input.edges,relations:input.relations??[],username:username??null,userId:input.displayUser?.id,
    readStatus:input.readStatusByMessageId,marks:input.readingMarks,corrections:input.corrections,memberships:input.traceContainerMemberships});
  const matchIds=new Set(input.messages.filter(message=>isCardMessage(message)||message.relationType==='correct').filter(message=>{
    const id=message.id;
    if(selected.scope==='self'&&!own.has(id)||selected.scope==='related'&&!related.has(id)||selected.scope==='following'&&!following.has(id))return false;
    return selected.status==='all'||(selected.status==='confirmed'?reading.confirmed(id):!reading.confirmed(id));
  }).map(message=>message.id));
  const displayIds=buildHomeFilterDisplayIds(matchIds,input.edges,{includeRelationContext:true,containerMemberships:input.traceContainerMemberships});
  const reasonByMessageId=new Map<string,string>();
  const idsLabel=(ids:Iterable<string>)=>{const values=[...new Set(ids)];return values.slice(0,6).join('、')+(values.length>6?` 等 ${values.length} 条消息`:'');};
  for(const id of matchIds){
    const reasons=[selected.scope==='all'?'消息范围：全部消息':selected.scope==='following'?followingReasons.get(id)!:scopeReasons.get(id)!];
    if(selected.status==='confirmed')reasons.push('已确认：正文和当前需确认的影响均已处理');
    if(selected.status==='pending'){
      if(reading.pendingBodies.has(id))reasons.push('待确认：正文未阅或已标为未阅');
      if(reading.pendingOriginals.has(id))reasons.push('待确认：需先阅读原文');
      const corrections=reading.pendingCorrections.get(id);
      if(corrections?.length)reasons.push(`待确认的修正消息：${idsLabel(corrections)}`);
      const change=reading.selectionChanges.get(id);
      if(change)reasons.push(`待确认：当前显示版本发生变化${change.causes?.length?`（影响消息 ${idsLabel(change.causes)}）`:''}`);
      const influences=reading.pendingInfluences.get(id)?.filter(item=>item.type!=='selection');
      if(influences?.length)reasons.push(`待确认的影响消息：${idsLabel(influences.map(item=>item.messageId))}`);
      const members=reading.pendingMembers.get(id);
      if(members?.size)reasons.push(`容器内仍有待确认的消息：${idsLabel(members)}`);
    }
    reasonByMessageId.set(id,reasons.join('\n'));
  }
  // Explain context separately: being retained beside a match is not a match.
  const explainContext=(id:string,reason:string)=>{
    if(displayIds.has(id)&&!reasonByMessageId.has(id))reasonByMessageId.set(id,`未直接命中筛选条件；${reason}`);
  };
  for(const edge of input.edges){
    if(['read','unread'].includes(edge.relationType))continue;
    const ids=[edge.relationMessageId,edge.from.messageId,edge.to.messageId],match=ids.find(id=>matchIds.has(id));
    if(match)ids.forEach(id=>explainContext(id,`作为命中消息 ${match} 的关系上下文保留（${relationLabel(edge)} ${edge.relationMessageId}）`));
  }
  const parents=new Map<string,Set<string>>();
  const addParent=(child:string,parent:string)=>{const values=parents.get(child)??new Set<string>();values.add(parent);parents.set(child,values);};
  for(const membership of input.traceContainerMemberships)for(const id of membership.targetIds)addParent(id,membership.containerId);
  for(const edge of input.edges)if(['classify','summary','merge','arrange'].includes(edge.relationType))addParent(edge.to.messageId,edge.relationMessageId);
  const queue=[...reasonByMessageId.keys()];
  for(let index=0;index<queue.length;index++)for(const parent of parents.get(queue[index])??[]){
    if(displayIds.has(parent)&&!reasonByMessageId.has(parent)){
      explainContext(parent,`作为消息 ${queue[index]} 的外层容器保留`);queue.push(parent);
    }
  }
  return {matchIds,displayIds,reasonByMessageId};
}
