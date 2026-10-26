import {bindRoles,relations,type Message,type Reference} from '@gonglun/core';

export function meaningCorrectionTarget(message:Message):Reference|undefined{
  const data=Object.assign({},...message.parts.flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)?[part.value]:[]));
  return data.correctionKind==='MEANING'?relations(message).find(part=>['correct','amend'].includes(part.relation))?.roles.target?.[0]?.reference:undefined;
}

export function meaningReference(source:Message,used:Set<string>):Message {
  let suffix=0,id:string;do{id=`reference:${source.id}`.slice(0,94)+(suffix?`:${suffix}`:'');suffix++;}while(used.has(id));used.add(id);
  const target=meaningCorrectionTarget(source)!;
  return {id,revision:1,sequence:0,authorId:source.authorId,createdAt:source.createdAt,updatedAt:source.updatedAt,regionId:source.regionId,ledgerId:source.ledgerId,programVersion:source.programVersion,ruleVersion:source.ruleVersion,spending:{protocol:0,recommendation:0,wager:0},parts:[
    {id:'relation',type:'relation',relation:'reference',roles:bindRoles({source:[{messageId:source.id,revision:source.revision,context:{kind:'MESSAGE'}}],target:[{messageId:target.messageId,...(target.revision?{revision:target.revision}:{}),context:{kind:'MESSAGE'}}]})},
    {id:'data',type:'data',value:{kind:'RELATION',uiType:'REFERENCE',label:'修正原意'}},
    {id:'display',type:'display',relationPartId:'relation',layout:'relation'},
  ]};
}

/** Keep the independent message ID; do not create a correction revision. */
export function simplifyCorrectionMessage(source:Message):Message {
  const message=structuredClone(source),target=meaningCorrectionTarget(message);
  const correction=target?relations(message).find(part=>['correct','amend'].includes(part.relation)):undefined;
  if(correction){
    const data=Object.assign({},...message.parts.flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)?[part.value]:[]));
    const content=data.correctionAfterContent??data.correctionContent??data.value;
    message.parts=message.parts.filter(part=>part!==correction&&!(part.type==='display'&&part.relationPartId===correction.id));
    if(typeof content==='string'&&!message.parts.some(part=>part.id==='corrected-body'))message.parts.push({id:'corrected-body',type:'text',text:content});
    for(const part of message.parts){
      if(part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)){
        const value={...part.value,kind:'TEXT'};
        for(const key of Object.keys(value))if(key.startsWith('correction')||['uiType','stanceCorrections','expectedRevision','value','parts'].includes(key))delete (value as Record<string,unknown>)[key];
        part.value=value;
      }
    }
  }
  // Historical reference contexts are evidence, including the basis of old bets.
  // New commands use MESSAGE; old public records keep their original addresses.
  return message;
}

export function synchronizeSimplifiedView(view:any,message:Message){
  const relation=relations(message).find(part=>part.id!=='self-stance'&&(part.relation!=='member-of'||part.roles.member?.length));
  const result={...view,...message};
  if(!relation){result.kind='TEXT';result.content=message.parts.flatMap(part=>part.type==='text'?[part.text]:part.type==='code'?[part.source]:part.type==='web'?[part.excerpt||part.url]:[]).join('\n');for(const key of ['relationType','relationPayload','payload','targetRefs','sourceMessageId','relSourceId'])delete result[key];return result;}
  if(relation){
    const data=Object.assign({},...message.parts.flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)?[part.value]:[]));
    result.kind='RELATION';result.relationType=relation.relation.toUpperCase();result.relationPayload=data;result.payload=data;
    const refs=(relation.roles.target??relation.roles.members??relation.roles.member??[]).map((binding,index)=>({...view.targetRefs?.[index],kind:view.targetRefs?.[index]?.kind??'message',messageId:binding.reference.messageId,reference:binding.reference}));
    if(view.targetRefs)result.targetRefs=refs;
  }
  return result;
}
