import { buildStanceTargetMap, resolveDisplayedStance } from '../../../utils/modelBridge';
import { indexRelatedMessages } from '../../../utils/relatedMessages';
import type { Relation } from '../../../types';
import { type CorrectionVersion, type DemoEdge, type DemoMessage } from '../../../utils/modelBridge';
import { isContainerType, type ContainerEffect } from './containerEffect';

export type DisplaySnapshot = {
  content: string;
  arrangement?: { layout: string; order: string[] };
  parentIds: string[];
  memberIds: string[];
  suppressed: boolean;
  correctionIds: string[];
  recommendationTied?: boolean;
};
export type DisplayHint = {
  unread: boolean;
  explicitlyUnread: boolean;
  relatedUnreadIds: string[];
  source?: 'personal' | 'recommended';
  different: boolean;
  matchesPersonal: boolean;
  matchesRecommended: boolean;
  readChanged?: boolean;
  personal: DisplaySnapshot;
  recommended: DisplaySnapshot;
};
export type DisplayHintsInput = {
  messages: DemoMessage[];
  relations: Relation[];
  edges: DemoEdge[];
  username: string | null;
  readStatus: ReadonlyMap<string, 'READ' | 'UNREAD'>;
  personalEffect: ContainerEffect;
  displayEffect?: ContainerEffect;
  corrections: Map<string, { current?: CorrectionVersion; versions: CorrectionVersion[] }>;
  displayCorrections?: Map<string, { current?: CorrectionVersion; versions: CorrectionVersion[] }>;
};
const same = (a: string[],b: string[]) => a.length === b.length && a.every((id,index) => id === b[index]);
export function sameDisplay(a: DisplaySnapshot,b: DisplaySnapshot) {
  return a.content === b.content && a.suppressed === b.suppressed && same(a.parentIds,b.parentIds) && same(a.memberIds,b.memberIds)
    && JSON.stringify(a.arrangement)===JSON.stringify(b.arrangement);
}
export function parentsFor(effect: ContainerEffect) {
  const parents = new Map<string,Set<string>>();
  for (const membership of effect.memberships) for (const id of membership.targetIds) {
    const list = parents.get(id) ?? new Set<string>(); list.add(membership.containerId); parents.set(id,list);
  }
  return parents;
}
export function snapshot(message: DemoMessage, effect: ContainerEffect, parents: Map<string,Set<string>>, correction?: CorrectionVersion): DisplaySnapshot {
  const membership = isContainerType(message.relationType) ? effect.ownership.direct(message.id) : undefined;
  return { content: correction?.content ?? message.content, parentIds: [...(parents.get(message.id) ?? [])].sort(),
    ...(message.relationType==='arrange'?{arrangement:{layout:message.relationPayload?.targetLayout??'',
      order:[...new Set(effect.edges.filter(edge=>edge.relationMessageId===message.id&&edge.relationType==='arrange').map(edge=>edge.to.messageId))]}}:{}),
    memberIds: membership ? [...membership.textIds,...membership.relationIds].sort() : [], suppressed: effect.suppressed.has(message.id),
    correctionIds: correction?.appliedCorrectionIds ?? (correction ? [correction.correctionId] : []), recommendationTied: correction?.recommendationTied };
}

/** A compact display fingerprint stored only when the user sends a READ message. */
export function displaySignature(value: DisplaySnapshot): string {
  const text=JSON.stringify([value.content,value.parentIds,value.memberIds,value.suppressed,value.arrangement]);
  let first=2166136261,second=5381;
  for(let index=0;index<text.length;index++){first=Math.imul(first^text.charCodeAt(index),16777619);second=Math.imul(second,33)^text.charCodeAt(index);}
  return `display:1:${text.length}:${(first>>>0).toString(36)}:${(second>>>0).toString(36)}`;
}

export function getMessageDisplaySignature(input:DisplayHintsInput,id:string):string|undefined {
  const message=input.messages.find(item=>item.id===id);
  const effect=input.displayEffect??input.personalEffect;
  return message?displaySignature(snapshot(message,effect,parentsFor(effect),(input.displayCorrections??input.corrections).get(id)?.current)):undefined;
}

export function messageDisplay(value: DisplaySnapshot, original: DemoMessage, hasCorrections: boolean): DisplaySnapshot {
  return hasCorrections ? {...value,content:original.content,correctionIds:[]} : value;
}
export function correctionDisplay(value: DisplaySnapshot): DisplaySnapshot {
  return {content:value.content,parentIds:[],memberIds:[],suppressed:false,correctionIds:[]};
}
export function getMessageDisplayParts(input:DisplayHintsInput,id:string) {
  const message=input.messages.find(item=>item.id===id);
  if(!message)return;
  const hasCorrections=!!input.corrections.get(id)?.versions.length;
  const effect=input.displayEffect??input.personalEffect;
  const displayed=snapshot(message,effect,parentsFor(effect),(input.displayCorrections??input.corrections).get(id)?.current);
  return {message:displaySignature(messageDisplay(displayed,message,hasCorrections)),corrections:displaySignature(correctionDisplay(displayed))};
}

/** Resolve a hint to the workbench's existing correction records, container preview or trace. */
export function displayHintDestination(input:DisplayHintsInput,id:string,record=false):{kind:'correction'|'corrections'|'container'|'related';id:string} {
  const map=new Map(input.messages.map(message=>[message.id,message])),message=map.get(id);
  if(message?.relationType==='correct')return {kind:record?'correction':'corrections',id};
  if(isContainerType(message?.relationType))return {kind:'container',id};
  if(message?.kind==='join'&&message.joinInfo?.containerId)return {kind:'container',id:message.joinInfo.containerId};
  const edge=input.edges.find(item=>item.relationMessageId===id&&['agree','disagree'].includes(item.relationType));
  const target=edge?resolveDisplayedStance(edge,map,buildStanceTargetMap(input.edges,map))?.targetId:undefined;
  if(target&&isContainerType(map.get(target)?.relationType))return {kind:'container',id:target};
  if(target&&map.get(target)?.relationType==='correct')return {kind:'corrections',id:target};
  const rejected=indexRelatedMessages(input.messages,input.personalEffect.rejectedContainerIds).get(id)?.[0];
  if(rejected)return {kind:'container',id:rejected.message.id};
  const correction=input.edges.find(item=>item.relationType==='correct'&&item.to.messageId===id);
  return correction?{kind:'corrections',id:correction.relationMessageId}:{kind:'related',id};
}
