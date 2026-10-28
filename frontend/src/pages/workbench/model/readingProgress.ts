import {bodyVersion,bodyVersionKey,messageReadingKey,originalReadingKey,type ReadingMark,type BodyVersion,type ReferenceContext} from '@gonglun/core';
import {displayedBodyVersion} from '../../../utils/bodyVersions';
import type {Relation} from '../../../types';
import {buildStanceTargetMap,resolveDisplayedStance,type DemoMessage,type DemoEdge,type CorrectionVersion} from '../../../utils/modelBridge';
import {displaySignature,type DisplaySnapshot} from './displayHintSnapshot';

export type ReadingInfluence={messageId:string;key:string;type:string;versionId?:string;basisIds?:string[];context?:ReferenceContext;eventId?:string;resultKey?:string;causes?:string[]};
export type ReadingInput={messages:DemoMessage[];edges:DemoEdge[];relations:Relation[];marks?:ReadingMark[];
  readStatus:ReadonlyMap<string,'READ'|'UNREAD'>;username:string|null;
  corrections?:Map<string,{current?:CorrectionVersion;versions?:CorrectionVersion[]}>;
  effectiveCorrections?:Map<string,{current?:CorrectionVersion;versions?:CorrectionVersion[]}>;
  effectiveJoinIds?:ReadonlySet<string>;
  displays?:ReadonlyMap<string,DisplaySnapshot>;
  memberships?:ReadonlyArray<{containerId:string;targetIds:readonly string[]}>};
const retired=(type:string|undefined)=>type==='read'||type==='unread';
const container=(type:string|undefined)=>['classify','summary','merge','arrange'].includes(type??'');
export function bodySignature(content:string,versionIds:string[]=[],version?:BodyVersion) {
  return version?bodyVersionKey(version):displaySignature({content,parentIds:[...new Set(versionIds)].sort(),memberIds:[],suppressed:false,correctionIds:[]});
}
export function currentBodySignature(input:ReadingInput,id:string) {
  const message=input.messages.find(item=>item.id===id);
  return message?messageReadingKey(message.id):undefined;
}

/** The author has read the submitted original body, independently of its targets. */
export function authoredReadingMark(message:Pick<DemoMessage,'id'|'revision'>,signature:string):ReadingMark {
  const key=messageReadingKey(message.id),version=bodyVersion(message.id,message.revision??1);
  return {format:3,messageId:message.id,scope:'message',key,bodySignature:key,version,state:'READ',
    signature,
    confirmation:{kind:'direct',messageId:message.id}};
}

/** Sending confirms that submission and its effects, without reading its targets. */
export function authoredReadingMarks(input:ReadingInput,id:string,signature:string):ReadingMark[] {
  const message=input.messages.find(message=>message.id===id);
  if(!message||!input.username||message.author!==input.username)return [];
  const progress=deriveReadingProgress(input);
  return [authoredReadingMark(message,signature),...[...progress.influences].flatMap(([target,items])=>{
    const own=items.filter(item=>item.messageId===id),selection=progress.selectionChanges.get(target);
    return influenceReadingMarks(target,[...own,...(own.length&&selection?[selection]:[])]);
  })];
}

export function latestReadingMarks(marks:ReadingMark[]=[]){
  const result=new Map<string,ReadingMark>();
  for(const mark of marks){if(mark.format!==3||mark.unknownContext||mark.scope==='influence')continue;
    const key=JSON.stringify([mark.messageId,mark.scope]),previous=result.get(key);
    if(!previous||(mark.position??0)>(previous.position??0)||(mark.position??0)===(previous.position??0)&&(mark.updatedAt??'')>=(previous.updatedAt??''))result.set(key,mark);
  }
  return result;
}
export function readingPrerequisiteIndex(input:Pick<ReadingInput,'messages'|'edges'|'marks'>&Partial<Pick<ReadingInput,'username'>>){
  const marks=latestReadingMarks(input.marks),corrections=new Map<string,Set<string>>();
  const authored=new Set(input.messages.filter(message=>input.username&&message.author===input.username&&(message.revision??1)===1).map(message=>message.id));
  for(const edge of input.edges)if(edge.relationType==='correct'&&!edge.proposalOnly){const ids=corrections.get(edge.to.messageId)??new Set<string>();ids.add(edge.relationMessageId);corrections.set(edge.to.messageId,ids);}
  const read=(id:string)=>{const mark=marks.get(JSON.stringify([id,'message']));return mark?mark.state!=='UNREAD':authored.has(id);};
  return (id:string)=>{
    const own=marks.get(JSON.stringify([id,'message'])),completed=!!own&&(own.state!=='UNREAD'||!!own.firstConfirmedAt)||authored.has(id);
    const original=marks.get(JSON.stringify([id,'original'])),originalSeen=completed||!!own?.originalSeen||!!original&&original.state!=='UNREAD';
    const versions=[...corrections.get(id)??[]];
    return {completed,originalSeen,originalRequired:!completed&&!!versions.length&&!originalSeen,unreadCorrections:completed?[]:versions.filter(id=>!read(id)),canConfirm:completed||originalSeen&&versions.every(read)||!versions.length};
  };
}
export function readingPrerequisites(input:Pick<ReadingInput,'messages'|'edges'|'marks'>&Partial<Pick<ReadingInput,'username'>>,id:string){return readingPrerequisiteIndex(input)(id);}
export function originalReadingRequired(input:Pick<ReadingInput,'messages'|'marks'|'readStatus'>&Partial<Pick<ReadingInput,'edges'>>,id:string,_display:Pick<DisplaySnapshot,'correctionIds'|'version'>){
  void _display;
  return readingPrerequisites({...input,edges:input.edges??[]},id).originalRequired;
}

/** All source/target directions participate; category acknowledgements are per affected message. */
export function readingInfluences(input:Pick<ReadingInput,'messages'|'edges'|'relations'|'memberships'>) {
  const map=new Map(input.messages.map(message=>[message.id,message])),stances=buildStanceTargetMap(input.edges,map);
  const joinedPlacements=new Set<string>();
  for(const relation of input.relations)if(relation.relationType==='JOIN'&&relation.sourceMessageId&&!relation.state?.membershipDisabled)
    for(const ref of relation.targetRefs)joinedPlacements.add(JSON.stringify([relation.sourceMessageId,ref.kind==='relation'?ref.relationId:ref.messageId]));
  const edgesByEvent=new Map<string,DemoEdge[]>();
  for(const edge of input.edges){const list=edgesByEvent.get(edge.relationMessageId)??[];list.push(edge);edgesByEvent.set(edge.relationMessageId,list);}
  const correctionTargets=new Map(input.edges.filter(edge=>edge.relationType==='correct'&&!edge.proposalOnly)
    .map(edge=>[edge.relationMessageId,edge.to.messageId]));
  const rootTarget=(id:string)=>{const seen=new Set<string>();while(correctionTargets.has(id)&&!seen.has(id)){seen.add(id);id=correctionTargets.get(id)!;}return id;};
  const resolvedStances=new Map(input.edges.filter(edge=>edge.relationType==='agree'||edge.relationType==='disagree').map(edge=>[edge.relationMessageId,resolveDisplayedStance(edge,map,stances)]));
  const result=new Map<string,ReadingInfluence[]>(),byEvent=new Map<string,Map<string,{type:string;versionId?:string;basisIds?:string[];context?:ReferenceContext}>>();
  const add=(target:string,event:string,type:string,key:string,versionId?:string)=>{
    if(target===event||!map.has(target)||!map.has(event)||retired(type))return;
    if(map.get(event)?.relationPayload?.operationType==='TERMINATE_SETTLEMENT'){type='terminate_settlement';key='terminate_settlement:';}
    if(type==='round'||type==='round_result')key=`${type}:`;
    if(correctionTargets.has(event)&&rootTarget(event)===target)versionId=event;
    const endpoint=(edgesByEvent.get(event)??[]).flatMap(edge=>[edge.from,edge.to]).find(endpoint=>endpoint.messageId===target);
    const context=versionId?undefined:endpoint?.reference?.context??(resolvedStances.get(event)?.targetId===target?map.get(event)?.executedStance?.target.context:undefined);
    const basisIds=undefined,scopedKey=key;
    const values=byEvent.get(event)??new Map();values.set(JSON.stringify([target,scopedKey]),{type,versionId,basisIds,context});byEvent.set(event,values);
  };
  for(const edge of input.edges){
    const type=edge.relationType;if(retired(type))continue;
    const event=edge.relationMessageId,label=map.get(event)?.relationPayload?.label??edge.relationLabel??'';
    for(const target of [edge.from.messageId,edge.to.messageId]){
      // The container is context carried by the JOIN, not another influence.
      if(container(type)&&joinedPlacements.has(JSON.stringify([event,target])))continue;
      const key=type==='reference'?(target===edge.from.messageId?`reference:${event}:${edge.to.messageId}`:'referenced')
        :type==='correct'?`correct:${event}`
        :['agree','disagree','recommend','archive','attention','block','tag'].includes(type)?`${type}:${type==='tag'?label:''}`:`${type}:${event}`;
      add(target,event,type,key);
    }
    if(type==='agree'||type==='disagree'){
      const resolved=resolveDisplayedStance(edge,map,stances);
      if(resolved){
        add(resolved.targetId,event,resolved.type,`${resolved.type}:`);
        // A stance on a correction or an annotation also affects its subject.
        if(!['classify','summary','merge','arrange'].includes(map.get(resolved.targetId)?.relationType??''))
          for(const targetEdge of edgesByEvent.get(resolved.targetId)??[]){
            add(targetEdge.to.messageId,event,resolved.type,`${resolved.type}:`,correctionTargets.has(resolved.targetId)?resolved.targetId:undefined);
          }
      }
    }
  }
  for(const relation of input.relations)if(relation.relationType==='JOIN'&&relation.sourceMessageId){
    // Membership is an influence on each member, read at that member's message.
    // The container reports member progress instead of confirming it separately.
    for(const ref of relation.targetRefs)add(ref.kind==='relation'?ref.relationId:ref.messageId,relation.id,'join',`join:${relation.sourceMessageId}:${relation.id}`);
  }
  // Trace a correction's downstream events back to its subject while retaining
  // the correction ID as provenance. All displays of the subject see them.
  const versionCache=new Map<string,Set<string>>();
  const versionsFor=(id:string)=>{
    const cached=versionCache.get(id);if(cached)return cached;
    const versions=new Set<string>(),seen=new Set<string>(),queue=[id];
    for(let index=0;index<queue.length;index++){
      const next=queue[index];if(seen.has(next))continue;seen.add(next);
      const known=next!==id&&versionCache.get(next);if(known){known.forEach(version=>versions.add(version));continue;}
      if(correctionTargets.has(next)){versions.add(next);continue;}
      const settlementTarget=map.get(next)?.settlementTargetId;if(settlementTarget)queue.push(settlementTarget);
      for(const edge of edgesByEvent.get(next)??[])for(const endpoint of [edge.from.messageId,edge.to.messageId])
        if(endpoint!==next&&(next===id||resolvedStances.has(next)||correctionTargets.has(endpoint)))queue.push(endpoint);
    }
    versionCache.set(id,versions);return versions;
  };
  for(const message of input.messages){
    if(message.kind==='round'||message.kind==='round_result'){
      const target=message.settlementTargetId;
      if(target)add(target,message.id,message.kind,`${message.kind}:`);
    }
    const existing=[...(byEvent.get(message.id)??[])];
    for(const versionId of versionsFor(message.id)){
      const root=rootTarget(versionId);if(root===versionId)continue;
      // Reuse the event's category, including resolved chained stances.
      const type=message.relationType??message.kind;
      const resolved=resolvedStances.get(message.id);
      const effectiveType=resolved?.type??type;
      const key=['agree','disagree','recommend','archive','attention','block','tag'].includes(effectiveType)
        ?`${effectiveType}:${effectiveType==='tag'?message.relationPayload?.label??'':''}`
        :existing.map(([key])=>JSON.parse(key) as [string,string]).find(([target])=>target===versionId)?.[1]??`${effectiveType}:${message.id}`;
      add(root,message.id,effectiveType,key,versionId);
    }
  }
  const structuralMembers=new Map<string,Set<string>>();
  for(const membership of input.memberships??[])for(const target of membership.targetIds){
    const members=structuralMembers.get(membership.containerId)??new Set<string>();members.add(target);structuralMembers.set(membership.containerId,members);
  }
  // A rejected latest placement can release a member into its fallback container.
  // Older placements of a member now managed elsewhere do not concern it.
  const latestJoins=new Map<string,Relation>(),relationMap=new Map(input.relations.map(relation=>[relation.id,relation]));
  for(const relation of input.relations)if(relation.relationType==='JOIN'&&!relation.state?.membershipDisabled){
    for(const ref of relation.targetRefs){
      const id=ref.kind==='relation'?ref.relationId:ref.messageId,previous=latestJoins.get(id);
      if(!previous||(relation.sequence&&previous.sequence?relation.sequence>previous.sequence:relation.createdAt>=previous.createdAt))latestJoins.set(id,relation);
    }
  }
  for(const [id,join] of latestJoins)if(join.sourceMessageId){
    const members=structuralMembers.get(join.sourceMessageId)??new Set<string>();members.add(id);structuralMembers.set(join.sourceMessageId,members);
  }
  for(const edge of input.edges)if(edge.relationType==='agree'||edge.relationType==='disagree'){
    const resolved=resolveDisplayedStance(edge,map,stances);if(!resolved)continue;
    const target=relationMap.get(resolved.targetId),changed=new Set<string>();
    if(target?.relationType==='JOIN'){
      for(const ref of target.targetRefs)changed.add(ref.kind==='relation'?ref.relationId:ref.messageId);
    }else if(target&&!target.state?.organizationRetired&&['CLASSIFY','SUMMARY','MERGE','ARRANGE'].includes(target.relationType)){
      const queue=[target.id];
      for(let index=0;index<queue.length;index++)for(const member of structuralMembers.get(queue[index])??[]){
        if(!changed.has(member)&&member!==target.id){changed.add(member);queue.push(member);}
      }
      changed.add(target.id);
    }
    // Placement changes concern the affected members. Parent containers only
    // summarize pending member progress; they do not inherit these influences.
    for(const id of changed)add(id,edge.relationMessageId,resolved.type,`${resolved.type}:`);
  }
  for(const [event,values] of byEvent)for(const [encoded,{type,versionId,basisIds,context}] of values){
    const [target,key]=JSON.parse(encoded) as [string,string],list=result.get(target)??[];
    const message=map.get(event);
    list.push({messageId:event,key,type,context,eventId:JSON.stringify([event,message?.revision??1,message?.sequence??0]),...(versionId?{versionId}:{}),...(basisIds?{basisIds}:{})});result.set(target,list);
  }
  return result;
}

export function deriveReadingProgress(input:ReadingInput) {
  const marks=input.marks??[],influences=readingInfluences(input),latest=latestReadingMarks(marks),acknowledged=new Set<string>();
  for(const mark of marks)if(mark.format===3&&mark.scope==='influence'&&mark.eventId&&!mark.unknownContext&&mark.state!=='UNREAD')acknowledged.add(JSON.stringify([mark.messageId,mark.key,mark.eventId,mark.resultKey??'']));
  const pendingInfluences=new Map<string,ReadingInfluence[]>(),otherVersionInfluences=new Map<string,ReadingInfluence[]>(),otherVersionUnread=new Map<string,Set<string>>(),pendingBodies=new Set<string>(),pendingOriginals=new Set<string>(),pendingCorrections=new Map<string,string[]>(),selectionChanges=new Map<string,ReadingInfluence>();
  const messageMap=new Map(input.messages.map(message=>[message.id,message])),prerequisites=readingPrerequisiteIndex(input);
  for(const message of input.messages){
    if(retired(message.relationType)||!input.username)continue;
    const own=latest.get(JSON.stringify([message.id,'message']));
    const authored=message.author===input.username&&(message.revision??1)===1;
    if(own?own.state==='UNREAD':!authored)pendingBodies.add(message.id);
    const gate=prerequisites(message.id);
    if(gate.originalRequired)pendingOriginals.add(message.id);
    if(gate.unreadCorrections.length)pendingCorrections.set(message.id,gate.unreadCorrections);
    const pending=(influences.get(message.id)??[]).filter(item=>{
      const source=messageMap.get(item.messageId);
      return !(source?.author===input.username&&(source.revision??1)===1)
        &&!acknowledged.has(JSON.stringify([message.id,item.key,item.eventId,item.resultKey??'']));
    });
    const previous=own?.selection,selection=previous?readingSelection(input,message.id,input.displays?.get(message.id)):undefined;
    if(previous&&selection&&(previous.signature!==selection.signature||JSON.stringify(previous.outcomes)!==JSON.stringify(selection.outcomes))){
      const corrections=new Set(Object.keys(selection.outcomes)),causes=[...new Set(input.edges.filter(edge=>['agree','disagree'].includes(edge.relationType)&&corrections.has(edge.to.messageId)).map(edge=>edge.relationMessageId))];
      const fingerprint=displaySignature({content:JSON.stringify([selection,causes.map(id=>{const source=messageMap.get(id);return [id,source?.revision,source?.sequence];})]),parentIds:[],memberIds:[],suppressed:false,correctionIds:[]}),key=`selection:${fingerprint}`;
      const change:ReadingInfluence={messageId:message.id,key,type:'selection',eventId:key,resultKey:key,causes};
      if(!acknowledged.has(JSON.stringify([message.id,key,key,key]))){pending.push(change);selectionChanges.set(message.id,change);}
    }
    if(pending.length)pendingInfluences.set(message.id,pending);
  }
  // A container's members are read where they are displayed. Their current
  // progress is derived afresh, never acknowledged by a mark on the container.
  const pendingIds=new Set([...pendingBodies,...pendingOriginals,...pendingInfluences.keys()]),parents=new Map<string,Set<string>>();
  const messageIds=new Set(input.messages.filter(message=>!retired(message.relationType)).map(message=>message.id));
  for(const membership of input.memberships??[])for(const id of membership.targetIds){
    if(id===membership.containerId||!messageIds.has(id))continue;
    const values=parents.get(id)??new Set<string>();values.add(membership.containerId);parents.set(id,values);
  }
  const queue=[...pendingIds];
  for(let index=0;index<queue.length;index++)for(const parent of parents.get(queue[index])??[])
    if(!pendingIds.has(parent)){pendingIds.add(parent);queue.push(parent);}
  const pendingMembers=new Map<string,Set<string>>();
  for(const [id,containers] of parents)if(pendingIds.has(id))for(const container of containers){
    const values=pendingMembers.get(container)??new Set<string>();values.add(id);pendingMembers.set(container,values);
  }
  return {influences,pendingInfluences,otherVersionInfluences,otherVersionUnread,pendingBodies,pendingOriginals,pendingCorrections,pendingMembers,selectionChanges,confirmed:(id:string)=>!!input.username&&!pendingIds.has(id),allVersionsConfirmed:(id:string)=>!!input.username&&!pendingIds.has(id)&&!otherVersionUnread.has(id)&&!otherVersionInfluences.has(id)};
}

export function readingSelection(input:ReadingInput,id:string,_display?:DisplaySnapshot):NonNullable<ReadingMark['selection']>{
  void _display;
  const message=input.messages.find(item=>item.id===id)!,entry=(input.effectiveCorrections??input.corrections)?.get(id),version=displayedBodyVersion(message,entry?.current);
  const outcomes=Object.fromEntries((input.effectiveCorrections??input.corrections)?.get(id)?.versions?.map(item=>[item.correctionId,item.exclusionReason??(item.adopted?'adopted':item.valid?'eligible':'excluded')])??[]);
  const signature=displaySignature({content:entry?.current?.content??message.content,parentIds:[],memberIds:[],suppressed:false,correctionIds:[]});
  return {versionKey:messageReadingKey(version.messageId),outcomes,signature};
}

export const groupedReadingInfluence=(item:ReadingInfluence)=>['selection','agree','disagree','recommend','archive','attention','block','tag','correct','round','round_result','terminate_settlement'].includes(item.type)
  ||item.type==='reference'&&(item.key==='referenced'||item.key.endsWith(':referenced'));

export const automaticReadingInfluence=(item:ReadingInfluence)=>['agree','disagree','recommend','archive','attention','block','tag','round','round_result','terminate_settlement'].includes(item.type);
type ReadingConfirmationOptions={automaticInfluences?:boolean};

export function influenceReadingMarks(id:string,items:ReadingInfluence[]):ReadingMark[]{
  return [...new Map(items.map(item=>[JSON.stringify([item.key,item.eventId,item.resultKey]),{format:3 as const,messageId:id,scope:'influence' as const,key:item.key,eventId:item.eventId??item.messageId,...(item.resultKey?{resultKey:item.resultKey}:{})}])).values()];
}

/** Record shared progress with evidence of the visible body; never read hidden bodies. */
export function readingMarksFor(input:ReadingInput,id:string,display:DisplaySnapshot,scope:'message'|'corrections'='message',options:ReadingConfirmationOptions={}):ReadingMark[] {
  const gate=readingPrerequisites(input,id);
  if(display.correctionIds.length&&!gate.canConfirm)throw new Error(gate.originalRequired?'请先切回原文并确认已阅':'请先阅读全部更正消息');
  return planReadingMarks(input,id,display,scope,options);
}

/** Preview and saving share one plan, so the UI describes exactly what is confirmed. */
export function planReadingMarks(input:ReadingInput,id:string,display:DisplaySnapshot,_scope:'message'|'corrections'='message',options:ReadingConfirmationOptions={}):ReadingMark[] {
  void _scope;
  const message=input.messages.find(item=>item.id===id)!,version=bodyVersion(message.id,display.version?.revision??message.revision??1,display.correctionIds.map(correctionId=>{
    const correction=input.messages.find(item=>item.id===correctionId);return {messageId:correctionId,revision:correction?.revision??1,kind:correction?.relationPayload?.correctionKind==='MEANING'?'MEANING':'TEXT'};
  }));
  const gate=readingPrerequisites(input,id),onlyOriginal=!display.correctionIds.length&&!gate.canConfirm;
  const signature=onlyOriginal?originalReadingKey(id):messageReadingKey(id),marks:ReadingMark[]=[{format:3,version,messageId:id,scope:onlyOriginal?'original':'message',key:signature,signature:displaySignature(display),bodySignature:signature,state:'READ',selection:readingSelection(input,id,{...display,version})}];
  // The status window confirms the current message's displayed votes,
  // annotations and settlement outcomes together, without reading other bodies.
  // Reading visits can keep their explicitly declared set of influences frozen.
  if(options.automaticInfluences!==false)marks.push(...influenceReadingMarks(id,(readingInfluences(input).get(id)??[]).filter(automaticReadingInfluence)));
  return marks.map(mark=>mark.scope==='influence'?mark:{...mark,confirmation:{kind:'direct' as const,messageId:id}});
}
