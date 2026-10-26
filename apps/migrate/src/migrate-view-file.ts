import {bindRoles,replayArchive,relations,textOf,type Reference,type Message} from '@gonglun/core';
import {upgradeAnnotationRecords} from './annotation-format.js';
import {createMessageFormatTransform} from './message-format.js';
import {validateRetirementJournal} from './validate-retirement-journal.js';
import {createVersionContextTransform} from './version-context-format.js';
import {simplifyCorrectionMessage,synchronizeSimplifiedView,meaningCorrectionTarget,meaningReference} from './simplified-corrections-format.js';

/** Offline conversion shared by the CLI and the application's lazy file loader. */
export function migrateViewFile(input:any):any{
  if(!input||typeof input!=='object')throw new Error('缺少消息列表');
  const journalOnly=input.format==='gonglun-2'&&input.messages===undefined&&Array.isArray(input.changes);
  if(!journalOnly&&!Array.isArray(input.messages))throw new Error('缺少消息列表');
  if(input.formatVersion>5||input.format&&!['gonglun-2','gonglun-view-3'].includes(input.format))throw new Error('文件版本比当前程序更新，无法转换');
  if(input.relations!==undefined&&!Array.isArray(input.relations))throw new Error('关系列表格式无效');
  if(input.formatVersion>=4&&Array.isArray(input.messages)&&input.messages.every((message:any)=>Array.isArray(message.parts)&&Number.isSafeInteger(message.revision)))return migrateSimplifiedViewFile(structuredClone(input));
  const data=upgradeAnnotationRecords(structuredClone(input));
  data.messages??=[];
  if(data.exportKind==='economic-audit'&&Array.isArray(data.stakes)){
    data.sourceAudit=structuredClone({stakes:input.stakes,auditEvents:input.auditEvents,votes:input.votes,rounds:input.rounds,rules:input.rules});
    delete data.stakes;
  }
  data.scope??={messageId:null,title:typeof data.topic?.title==='string'?data.topic.title:'公论'};
  delete data.topic;
  function records(rows:any[],kind:string):Map<string,any>{
    const map=new Map<string,any>();
    for(const row of rows){
      if(!row||typeof row.id!=='string'||!row.id||map.has(row.id))throw new Error(`${kind}编号缺失或重复`);
      map.set(row.id,row);
    }
    return map;
  }
  const messages=records(data.messages,'消息'),relationRecords=records(data.relations??[],'关系');
  for(const message of messages.values()){
    message.authorId??=message.createdById??message.createdBy?.id;
    message.author??=message.createdBy?.username??message.authorId;
    if(message.kind==='RELATION'&&message.relationType&&!relationRecords.has(message.id))relationRecords.set(message.id,{
      ...message,sourceMessageId:message.sourceMessageId??message.relSourceId??null,payload:message.relationPayload??{},
    });
  }
  // Prisma exports stored content messages and relation messages in separate arrays.
  for(const [id,relation] of relationRecords)if(!messages.has(id))messages.set(id,{
    ...relation,kind:'RELATION',contentType:'TEXT',content:relation.payload?.content??'',relationPayload:relation.payload,
  });
  const containers=new Set(['CLASSIFY','SUMMARY','MERGE','ARRANGE']);
  const groups=data.format==='gonglun-2'?[]:[...relationRecords.values()].filter(relation=>containers.has(relation.relationType)&&!messages.get(relation.id)?.parts);
  const sets=new Map(groups.map(group=>[group.id,new Set<string>((group.targetRefs??[]).map((ref:any)=>ref.messageId??ref.relationId))]));
  for(const child of [...groups].sort((a,b)=>sets.get(a.id)!.size-sets.get(b.id)!.size)){
    if(!sets.get(child.id)!.size)continue;
    const parent=groups.filter(owner=>sets.get(owner.id)!.size>sets.get(child.id)!.size&&[...sets.get(child.id)!].every(id=>sets.get(owner.id)!.has(id)))
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
  let replay:ReturnType<typeof replayArchive>|undefined;
  if(data.format==='gonglun-2'){
    if(!Array.isArray(data.changes))throw new Error('缺少执行记录');
    let previous=0;
    for(const change of data.changes){
      if(change.previousSequence===undefined){
        if(change.sequence!==previous+1)throw new Error('旧执行记录不连续，无法确定缺失的前序游标');
        change.previousSequence=previous;
      }
      previous=change.sequence;
    }
    validateRetirementJournal(data);replay=replayArchive(data);
  }
  const native=new Map(replay?.messages.map(message=>[message.id,message]));
  if(journalOnly)for(const message of native.values()){
    const primary=relations(message).find(part=>part.relation!=='member-of'||part.roles.member?.length);
    const author=data.users?.find((user:any)=>user.id===message.authorId);
    messages.set(message.id,{...message,kind:primary?'RELATION':'TEXT',author:author?.username??author?.name??message.authorId,
      content:textOf(message),state:replay?.states.find(state=>state.messageId===message.id)});
  }
  for(const [id,message] of messages){
    const relation=relationRecords.get(id),type=relation?.relationType??message.relationType;
    const payload={...(message.payload??{}),...(message.relationPayload??{}),...(relation?.payload??{})};
    const preserved=native.get(id);
    if(preserved){message.parts=preserved.parts;message.revision=preserved.revision;}
    if(!Array.isArray(message.parts)){
      message.parts=[message.kind==='CODE'?{id:'body',type:'code',source:String(message.content??''),language:payload.language??'text'}
        :{id:'body',type:'text',text:String(message.content??'')}];
      if(type){
        const name=type==='ATTENTION'?'follow':type==='CORRECT'?'correct':type==='JOIN'?'member-of':String(type).toLowerCase();
        const roles:any={[containers.has(type)?'members':type==='JOIN'?'member':'target']:(relation?.targetRefs??message.targetRefs??[]).map(reference)};
        const source=relation?.sourceMessageId??message.sourceMessageId??message.relSourceId;
        if(source)roles[type==='JOIN'?'parent':'source']=[{messageId:source}];
        message.parts.push({id:'relation',type:'relation',relation:name,roles:bindRoles(roles)});
        message.parts.push({id:'display',type:'display',relationPartId:'relation',layout:containers.has(type)
          ?payload.targetLayout==='single-row'?'row':payload.targetLayout==='multi-column'?'columns':'flow':'relation'});
      }
      message.parts.push({id:'data',type:'data',value:{...payload,uiType:type??null,kind:message.kind,legacyTopicId:data.topicId??'offline'}});
    }
    message.revision??=1;Object.assign(message,upgradeAnnotationRecords(message));
  }
  const latest=new Map<string,Message>([...native,...messages]);
  const originals=new Map<string,Message>();
  for(const versions of replay?.revisions.values()??[])for(const message of versions)originals.set(`${message.id}:${message.revision}`,message);
  for(const message of latest.values())if(!originals.has(`${message.id}:${message.revision}`))originals.set(`${message.id}:${message.revision}`,message);
  const transform=createMessageFormatTransform(latest,originals);
  if(replay){data.changes=data.changes.map(transform);validateRetirementJournal(data);replayArchive(data);}
  for(const [id,original] of messages){
    const message=transform(original),primary=relations(message).find(part=>part.relation!=='member-of'||part.roles.member?.length);
    const metadata=Object.assign({},...message.parts.filter((part:any)=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)).map((part:any)=>part.value));
    const payload={...(message.relationPayload??message.payload??{}),...metadata};
    for(const key of Object.keys(payload))if(key.startsWith('legacy')||key==='sendCount'||key==='transformedFrom')delete payload[key];
    let relation=relationRecords.get(id);
    if(primary&&message.kind==='RELATION'&&!relation){relation={...message};relationRecords.set(id,relation);}
    if(primary){
      const type=primary.relation==='follow'?'ATTENTION':primary.relation==='member-of'?'JOIN':primary.relation.toUpperCase();
      message.relationType=metadata.uiType??type;
      if(primary.reason)payload.subType=primary.reason;
      message.relationPayload=payload;
      message.sourceMessageId=(primary.roles.source??primary.roles.parent)?.[0]?.reference.messageId??null;
      if(typeof metadata.supersededBy==='string')message.supersededBy=metadata.supersededBy;
      const refs=(primary.roles.target??primary.roles.members??primary.roles.member??[]).map(binding=>{
        const exact=binding.reference,target=latest.get(exact.messageId);
        const existing=(relation?.targetRefs??message.targetRefs??[]).find((ref:any)=>JSON.stringify(ref.reference??reference(ref))===JSON.stringify(exact));
        return {...(existing??(target&&relations(target).length?{kind:'relation',relationId:exact.messageId}:{kind:'message',messageId:exact.messageId})),reference:exact};
      });
      message.targetRefs=refs;
      if(relation)Object.assign(relation,{parts:message.parts,revision:message.revision,relationType:message.relationType,
        sourceMessageId:message.sourceMessageId,targetRefs:refs,payload,supersededBy:message.supersededBy??relation.supersededBy??null});
    }
    if(primary?.relation==='correct'){
      const corrected=message.parts.find((part:any)=>part.id==='corrected-body');
      if(corrected?.type==='text')message.content=corrected.text;
    }else if(message.content==null)message.content=textOf(message);
    messages.set(id,message);
  }
  data.messages=[...messages.values()];data.relations=[...relationRecords.values()];
  if(data.format!=='gonglun-2')data.format='gonglun-view-3';
  data.formatVersion=5;
  return migrateSimplifiedViewFile(createVersionContextTransform(latest,originals)(data));
}

function migrateSimplifiedViewFile(result:any){
  result.formatVersion=5;
  result.relations??=[];
  if(result.view?.homeFilter?.status==='pending-versions')result.view.homeFilter.status='pending';
  if(result.format==='gonglun-2'){validateRetirementJournal(result);replayArchive(result);}
  const changed:Message[]=[],created:Message[]=[],used=new Set<string>(result.messages.map((message:Message)=>message.id));
  result.messages=result.messages.map((view:any)=>{
    if(!meaningCorrectionTarget(view))return view;
    const next=simplifyCorrectionMessage(view);
    created.push(meaningReference(view,used));
    const converted=synchronizeSimplifiedView(view,next);changed.push(converted);return converted;
  });
  result.relations=result.relations.filter((relation:any)=>!changed.some(message=>message.id===relation.id));
  for(const message of created){
    const view={...synchronizeSimplifiedView({},message),authorId:message.authorId,content:'',sourceMessageId:relations(message)[0]!.roles.source![0]!.reference.messageId,targetRefs:[{kind:'message',messageId:relations(message)[0]!.roles.target![0]!.reference.messageId,reference:relations(message)[0]!.roles.target![0]!.reference}]};
    result.messages.push(view);result.relations.push(view);
  }
  changed.push(...created);
  if(result.format==='gonglun-2'&&changed.length){
    const previous=replayArchive(result),previousSequence=previous.sequence,sequence=previousSequence+1;
    changed.forEach(message=>message.sequence=sequence);
    for(const view of [...result.messages,...result.relations])if(changed.some(message=>message.id===view.id))view.sequence=sequence;
    const change={sequence,previousSequence,messages:changed,memberships:[],removedMemberships:[],states:[],ledger:[],treasury:{operating:previous.operating,issued:previous.issued}};
    result.changes.push(change);
    if(result.journal)Object.assign(result.journal,{lastSequence:sequence,entryCount:result.changes.length});
    replayArchive(result);
  }
  return result;
}
