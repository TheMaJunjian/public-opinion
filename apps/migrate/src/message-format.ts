import {relations,replaceReference,textOf,type Message} from '@gonglun/core';
import {presentationMigration,upgradePresentationParts} from './presentation-format.js';

/** Shared, pure conversion for database records and offline archives. */
export function createMessageFormatTransform(latest:Map<string,Message>,originals:Map<string,Message>){
  const presentation= presentationMigration([...latest.values()]);
  function transform(input:any):any{
    if(Array.isArray(input))return input.map(transform);
    if(!input||typeof input!=='object')return input;
    if(typeof input.id!=='string'||!Array.isArray(input.parts))return Object.fromEntries(Object.entries(input).map(([key,value])=>[key,key==='input'||key==='sourceAudit'?value:transform(value)]));
    const message=structuredClone(input) as Message;
    message.parts=upgradePresentationParts(message,presentation);
    const meta=message.parts.find(part=>part.type==='data');
    if(meta?.type!=='data'||!meta.value||typeof meta.value!=='object'||Array.isArray(meta.value))return {...input,parts:message.parts};
    const data=meta.value,imported=typeof data.legacyTopicId==='string',relation=relations(message).find(part=>part.relation!=='member-of'||part.roles.member?.length);
    if(imported&&relation){
      if(data.legacyTopicId===message.id&&data.uiType==='CLASSIFY')data.origin={kind:'topic-classification',id:message.id};
      if(relation.relation==='legacy-join'){
        relation.relation='member-of';relation.roles={parent:relation.roles.source??[],member:relation.roles.target??[]};
      }
      if(data.uiType==='CORRECT'&&relation.relation==='amend')relation.relation='correct';
      if(data.kind==='RELATION'&&!['classify','summary','correct'].includes(relation.relation)&&!message.parts.some(part=>part.type==='display'))
        message.parts.push({id:'presentation',type:'display',relationPartId:relation.id,layout:'relation'});
      if(data.legacySupersededBy)data.supersededBy=data.legacySupersededBy;
    }
    const textCorrection=data.uiType==='CORRECT'&&(data.correctionKind==='TEXT'||typeof data.correctionContent==='string'||data.correctionValue!==undefined);
    if(relation&&(relation.relation==='correct'||relation.relation==='amend'&&(imported||textCorrection))){
      const target=relation.roles.target?.[0]?.reference;
      const original=target&&(target.revision?originals.get(`${target.messageId}:${target.revision}`):latest.get(target.messageId));
      let replacement=data.value??data.correctionValue??data.correctionAfterContent??data.correctionContent;
      if(imported&&target?.range&&original&&data.value===undefined&&typeof replacement==='string'){
        const selected=original.parts.find(part=>part.id===target.partId);
        const before=selected?.type==='text'?selected.text:selected?.type==='code'?selected.source:selected?.type==='web'?selected.excerpt:textOf(original);
        const prefix=before.slice(0,target.range.start),suffix=before.slice(target.range.end);
        if(!replacement.startsWith(prefix)||!replacement.endsWith(suffix))throw new Error(`更正 ${message.id} 的全文与原选区不一致`);
        replacement=replacement.slice(prefix.length,replacement.length-suffix.length);
      }
      if(original&&target?.partId&&typeof replacement==='string'){
        try{
          const before=textOf(original),after=textOf({...original,parts:replaceReference(original,target,replacement)});
          relation.relation='correct';data.value=replacement;data.correctionBeforeContent=before;
          if(!message.parts.some(part=>part.id==='corrected-body'))message.parts.unshift({id:'corrected-body',type:'text',text:after});
          data.correctionKind??='TEXT';
        }catch{/* Non-text proposals retain their explicit native amendment parts. */}
      }
    }
    if(relation&&['classify','summary','merge','arrange'].includes(relation.relation)&&!message.parts.some(part=>part.id==='organization-memberships'))
      message.parts.push({id:'organization-memberships',type:'data',value:{independentMemberships:true}});
    for(const key of Object.keys(data))if(key.startsWith('legacy'))delete data[key];
    return {...input,parts:message.parts};
  }
  return transform;
}
