import {bindRoles,replayArchive,type Reference} from '@gonglun/core';
import {upgradeAnnotationRecords} from './annotation-format.js';
import {presentationMigration,upgradePresentationParts} from './presentation-format.js';
import {validateRetirementJournal} from './validate-retirement-journal.js';

/** Offline conversion; never sends the file to a server or re-executes its actions. */
export function migrateViewFile(input:any):any{
  if(!input||typeof input!=='object'||!Array.isArray(input.messages))throw new Error('缺少消息列表');
  const data=upgradeAnnotationRecords(structuredClone(input));
  data.scope??={messageId:null,title:typeof data.topic?.title==='string'?data.topic.title:'公论'};
  delete data.topic;
  const messages=new Map<string,any>(data.messages.map((message:any)=>[message.id,message]));
  const relations=new Map<string,any>((data.relations??[]).map((relation:any)=>[relation.id,relation]));
  const containers=new Set(['CLASSIFY','SUMMARY','MERGE','ARRANGE']);
  // Previous view-only files encoded nesting through strict subsets. Convert that once into explicit members.
  const groups=data.format==='gonglun-2'?[]:[...relations.values()].filter(relation=>containers.has(relation.relationType)&&!messages.get(relation.id)?.parts);
  const sets=new Map(groups.map(group=>[group.id,new Set<string>((group.targetRefs??[]).map((ref:any)=>ref.messageId??ref.relationId))]));
  for(const child of [...groups].sort((a,b)=>sets.get(a.id)!.size-sets.get(b.id)!.size)){
    if(!sets.get(child.id)!.size)continue;
    const parent=[...groups].filter(owner=>sets.get(owner.id)!.size>sets.get(child.id)!.size&&[...sets.get(child.id)!].every(id=>sets.get(owner.id)!.has(id)))
      .sort((a,b)=>sets.get(a.id)!.size-sets.get(b.id)!.size)[0];
    if(parent)parent.targetRefs=[...(parent.targetRefs??[]).filter((ref:any)=>!sets.get(child.id)!.has(ref.messageId??ref.relationId)),{kind:'relation',relationId:child.id}];
  }
  function reference(ref:any):Reference{
    if(ref.reference)return ref.reference;
    const id=ref.messageId??ref.relationId,target=messages.get(id);
    if(typeof id!=='string')throw new Error('目标引用缺少消息编号');
    if(ref.kind==='text-fragment'){
      const text=String(target?.content??''),quote=String(ref.text??''),start=text.indexOf(quote);
      if(!quote||start<0||text.indexOf(quote,start+1)>=0)throw new Error(`消息 ${id} 的片段位置不唯一，原文件未修改`);
      return {messageId:id,revision:target?.revision??1,partId:'body',range:{start,end:start+quote.length}};
    }
    return {messageId:id,...(ref.part&&ref.part!=='whole'?{partId:ref.part==='label'?'body':'relation'}:{})};
  }
  const native=new Map<string,any>();
  if(data.format==='gonglun-2'&&Array.isArray(data.changes)){
    let previous=0;
    for(const change of data.changes){if(change.previousSequence===undefined)change.previousSequence=previous;previous=change.sequence;}
    validateRetirementJournal(data);
    for(const message of replayArchive(data).messages)native.set(message.id,message);
  }
  for(const [id,message] of messages){
    const relation=relations.get(id),type=relation?.relationType??message.relationType,payload={...(message.payload??{}),...(message.relationPayload??{}),...(relation?.payload??{})};
    const preserved=native.get(id);
    if(preserved)message.parts=preserved.parts;
    if(!Array.isArray(message.parts)){
      message.parts=[{id:'body',type:'text',text:String(message.content??'')}];
      if(type){
        const name=type==='ATTENTION'?'follow':type==='CORRECT'?'correct':String(type).toLowerCase();
        const roles:any={[containers.has(type)?'members':'target']:(relation?.targetRefs??message.targetRefs??[]).map(reference)};
        const source=relation?.sourceMessageId??message.sourceMessageId;if(source)roles.source=[{messageId:source}];
        message.parts.push({id:'relation',type:'relation',relation:name,roles:bindRoles(roles)});
        if(containers.has(type))message.parts.push({id:'display',type:'display',relationPartId:'relation',layout:payload.targetLayout==='single-row'?'row':payload.targetLayout==='multi-column'?'columns':'flow'});
        else message.parts.push({id:'display',type:'display',relationPartId:'relation',layout:'relation'});
      }
        message.parts.push({id:'data',type:'data',value:{...payload,uiType:type??null}});
        if(type==='ATTENTION'||type==='BLOCK')message.parts.find((part:any)=>part.type==='relation').reason=payload.subType;
    }
    message.revision??=preserved?.revision??1;
    const upgraded=upgradeAnnotationRecords(message);Object.assign(message,upgraded);
    if(relation){
      relation.parts=message.parts;relation.revision=message.revision;
      const part=message.parts.find((part:any)=>part.type==='relation'&&part.id==='relation');
      if(part?.reason){relation.payload={...payload,subType:part.reason};relation.relationType=part.relation==='follow'?'ATTENTION':'BLOCK';}
      relation.targetRefs=(relation.targetRefs??message.targetRefs??[]).map((ref:any)=>({...ref,reference:reference(ref)}));
    }
  }
  const plan=presentationMigration([...messages.values()]);
  for(const message of messages.values()){
    message.parts=upgradePresentationParts(message,plan);
    const relation=relations.get(message.id);
    if(relation){
      relation.parts=message.parts;
      const label=plan.labels.get(message.id);
      if(label&&!relation.payload?.label)relation.payload={...relation.payload,label};
      if(relation.payload?.sendCount!==undefined){relation.payload.repetitionCount??=relation.payload.sendCount;delete relation.payload.sendCount;}
      if(relation.payload)delete relation.payload.transformedFrom;
    }
  }
  data.messages=[...messages.values()];data.relations=[...relations.values()];
  if(data.format!=='gonglun-2')data.format='gonglun-view-3';
  data.formatVersion=3;
  return data;
}
