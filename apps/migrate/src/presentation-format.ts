import {relations,textOf,type Message,type Part} from '@gonglun/core';

/** Resolve old source-label conventions once, preserving source messages and addresses. */
export function presentationMigration(messages:Message[]) {
  const byId=new Map(messages.map(message=>[message.id,message]));
  const embedded=new Map<string,string>(),visible=new Set<string>(),labels=new Map<string,string>();
  for(const message of messages)for(const part of relations(message)){
    if(part.relation==='member-of')continue;
    for(const [role,bindings] of Object.entries(part.roles))for(const {reference} of bindings){
      const source=byId.get(reference.messageId);
      if(part.relation==='tag'&&role==='source'&&source&&!relations(source).some(item=>item.relation!=='member-of')){
        embedded.set(source.id,message.id);
        labels.set(message.id,textOf(source).slice(0,80));
      }else visible.add(reference.messageId);
    }
  }
  for(const id of visible)embedded.delete(id);
  return {embedded,labels};
}

export function upgradePresentationParts(message:Message,plan:ReturnType<typeof presentationMigration>):Part[]{
  const parts=structuredClone(message.parts),target=plan.embedded.get(message.id);
  if(target&&!parts.some(part=>part.type==='display'&&part.target))parts.push({id:'embedded-presentation',type:'display',layout:'relation',relationPartId:'relation',target:{messageId:target,partId:'relation'}});
  for(const part of parts)if(part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)){
    if(part.value.sendCount!==undefined){part.value.repetitionCount??=part.value.sendCount;delete part.value.sendCount;}
    delete part.value.transformedFrom;
    const label=plan.labels.get(message.id);
    if(label&&!part.value.label)part.value.label=label;
  }
  const label=plan.labels.get(message.id);
  if(label&&!parts.some(part=>part.type==='data'))parts.push({id:'data',type:'data',value:{label}});
  return parts;
}
