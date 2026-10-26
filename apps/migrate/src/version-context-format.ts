import {bodyVersion,materializeBodyVersion,relations,type Message} from '@gonglun/core';

/** Historical interpretation belongs here. Never change an executed money address. */
export function upgradeVersionContexts(message:Message,latest:Map<string,Message>,originals:Map<string,Message>):Message {
  const result=structuredClone(message),data=Object.assign({},...result.parts.flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)?[part.value]:[]));
  const resolver=(id:string,revision?:number)=>revision?originals.get(`${id}:${revision}`):latest.get(id);
  for(const part of result.parts){
    if(part.type!=='relation')continue;
    for(const [role,bindings] of Object.entries(part.roles))for(const binding of bindings){
      const ref=binding.reference;if(ref.context)continue;
      if(['member-of','classify','summary','merge','arrange','correct','amend','follow','block'].includes(part.relation)){ref.context={kind:'MESSAGE'};continue;}
      const target=resolver(ref.messageId,ref.revision),whole=!ref.partId&&!ref.range&&!ref.path?.length&&!ref.memberId;
      if(!target){ref.context={kind:'UNKNOWN'};continue;}
      const correction=relations(target).find(part=>part.relation==='correct');
      if(correction&&(whole||ref.partId===correction.id)&&!ref.range&&!ref.memberId&&!ref.path?.length){ref.context={kind:'CORRECTION'};continue;}
      if(['settlement','distribution','terminate','open-settlement','open-value-settlement'].includes(part.relation)){ref.context={kind:'UNKNOWN'};continue;}
      if(whole&&relations(target).some(part=>['agree','disagree'].includes(part.relation)&&part.roles.target?.[0]?.reference.messageId!==target.id)){ref.context={kind:'UNKNOWN'};continue;}
      // Without a saved viewing context, content after a correction is unknown.
      const saved=data.stanceCorrections&&typeof data.stanceCorrections==='object'&&!Array.isArray(data.stanceCorrections)?data.stanceCorrections[ref.messageId]:undefined;
      const edits=[...latest.values()].filter(candidate=>candidate.createdAt<=message.createdAt&&relations(candidate).some(part=>part.relation==='correct'&&part.roles.target?.some(binding=>binding.reference.messageId===ref.messageId)));
      if(saved===undefined&&edits.length||ref.revision===undefined&&target.revision!==1){ref.context={kind:'UNKNOWN'};continue;}
      try{
        if(saved!==undefined&&(!Array.isArray(saved)||saved.some(id=>typeof id!=='string')))throw new Error('未知语境');
        const version=bodyVersion(target.id,ref.revision??target.revision,(saved as string[]|undefined??[]).map(id=>{const correction=latest.get(id);if(!correction)throw new Error('更正缺失');return {messageId:id,revision:correction.revision,kind:'MEANING' as const};}));
        materializeBodyVersion(version,resolver);
        ref.revision=version.revision;ref.context={kind:role==='target'&&whole&&['agree','disagree','recommend','archive','tag'].includes(part.relation)?'MEANING':'BODY',version};
      }catch{ref.context={kind:'UNKNOWN'};}
    }
  }
  // Exported views carry the endpoints beside their native relation parts.
  const view=result as Message&{targetRefs?:Array<{reference?:unknown}>;sourceRefs?:Array<{reference?:unknown}>};
  const primary=relations(result).find(part=>part.id!=='self-stance'&&(part.relation!=='member-of'||part.roles.member?.length));
  for(const [field,bindings] of [['targetRefs',primary?.roles.target??primary?.roles.members??primary?.roles.member],['sourceRefs',primary?.roles.source??primary?.roles.parent]] as const){
    const refs=view[field];if(refs&&bindings)refs.forEach((ref,index)=>{if(bindings[index])ref.reference=structuredClone(bindings[index].reference);});
  }
  return result;
}

export function createVersionContextTransform(latest:Map<string,Message>,originals:Map<string,Message>){
  function transform(input:unknown):unknown{
    if(Array.isArray(input))return input.map(transform);
    if(!input||typeof input!=='object')return input;
    const value=input as Record<string,unknown>;
    if(typeof value.id==='string'&&Array.isArray(value.parts))return upgradeVersionContexts(value as unknown as Message,latest,originals);
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,['input','sourceAudit','signature','payload'].includes(key)?item:transform(item)]));
  }
  return transform;
}
