import {bindRoles,referenceKey,resolveReference,relations,type Message,type Reference} from '@gonglun/core';

export interface LegacySettlementSource {
  kind: 'ROUND'|'ROUND_RESULT';
  targetRefs: unknown[];
}

function referenceFromLegacy(raw: any, latest: Map<string,Message>, originals: Map<string,Message>): Reference {
  if(!raw||typeof raw!=='object')throw new Error('结算目标引用不是对象');
  const id=raw.reference?.messageId??raw.messageId??raw.relationId;
  if(typeof id!=='string'||!id)throw new Error('结算目标缺少消息 ID');
  let reference:Reference;
  if(raw.reference)reference=structuredClone(raw.reference);
  else if(raw.kind==='text-fragment'){
    const target=originals.get(`${id}:1`)??latest.get(id),body=target?.parts.find(part=>part.id==='body');
    const text=body?.type==='text'?body.text:body?.type==='code'?body.source:undefined,quote=raw.text;
    const start=typeof text==='string'&&typeof quote==='string'?text.indexOf(quote):-1;
    if(!quote||start<0||text!.indexOf(quote,start+1)>=0)throw new Error(`结算目标片段无法唯一定位：${id}`);
    reference={messageId:id,revision:target!.revision,partId:'body',range:{start,end:start+quote.length}};
  }else{
    if(raw.kind&&!['message','relation'].includes(raw.kind))throw new Error(`不支持的结算目标种类：${raw.kind}`);
    if(raw.part&&!['whole','label','decoration'].includes(raw.part))throw new Error(`不支持的结算目标部件：${raw.part}`);
    reference={messageId:id,...(raw.part&&raw.part!=='whole'?{partId:raw.part==='label'?'body':'relation'}:{})};
  }
  if(resolveReference(reference,(messageId,revision)=>revision?originals.get(`${messageId}:${revision}`):latest.get(messageId))===undefined)
    throw new Error(`结算目标消息或部件不存在：${id}`);
  return reference;
}

/** Fill missing historical addresses without changing an existing explicit target or executing a settlement. */
export function restoreSettlementTargetParts(message:Message,latest:Map<string,Message>,originals:Map<string,Message>,source?:LegacySettlementSource):boolean {
  const data=Object.assign({},...message.parts.flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)?[part.value]:[]));
  const kind=data.kind??(message as Message&{kind?:string}).kind;
  if(kind!=='ROUND'&&kind!=='ROUND_RESULT')return false;
  if(relations(message).some(part=>part.roles.target?.length))return false;
  const projected=(message as Message&{targetRefs?:unknown[]}).targetRefs;
  const raw:unknown[]=Array.isArray(data.legacyTargetRefs)&&data.legacyTargetRefs.length?data.legacyTargetRefs
    :projected?.length?projected:source&&source.kind===kind?source.targetRefs:[];
  if(!raw.length)return false;
  const refs=[...new Map<string,Reference>(raw.map(ref=>{const exact=referenceFromLegacy(ref,latest,originals);return [referenceKey(exact),exact];})).values()];
  const relation=kind==='ROUND'?'settlement':'distribution';
  const existing=relations(message).find(part=>part.relation===relation);
  if(existing)existing.roles={...existing.roles,target:bindRoles({target:refs}).target!};
  else{
    let id='settlement-target',suffix=1;
    while(message.parts.some(part=>part.id===id))id=`settlement-target-${suffix++}`;
    message.parts.push({id,type:'relation',relation,roles:bindRoles({target:refs})});
  }
  return true;
}
