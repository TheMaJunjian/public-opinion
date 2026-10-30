import {isCardMessage,type DemoMessage} from '../../../utils/modelBridge';
import {chronologicalOrder,discussionForest} from '../../../utils/discussionOrder';
import type {TraceDirection} from '../../../utils/traceRange';
import {deriveReadingProgress,influenceReadingMarks,readingMarksFor,type ReadingInput,type ReadingInfluence} from './readingProgress';
import type {DisplaySnapshot} from './displayHintSnapshot';
import {getPresentationSpec} from '../../../types';

export type ReadingOrder='discussion'|'breadth'|'time';
export interface ReadingTask {
  key:string; destinationId:string; targetId:string; kind:'body'|'influence'|'predecessor';
  reason:string; location:'inside'|'outside'|'filtered'; outsideReason?:string;
  influence?:ReadingInfluence; createdAt:string;
}
/** Preview and execute the same next visit after confirming the current group. */
export function nextReadingVisit(queue:{pending:readonly {id:string;tasks:ReadingTask[]}[];visits:readonly {id:string}[];position:number},currentTasks:readonly ReadingTask[]){
  const confirmed=new Set(currentTasks.map(task=>task.key));
  const remaining=queue.pending.filter(visit=>visit.tasks.some(task=>!confirmed.has(task.key)));
  const forward=new Set(queue.visits.slice(queue.position).map(visit=>visit.id));
  return remaining.find(visit=>forward.has(visit.id))??remaining[0];
}
const readable=(message:DemoMessage)=>isCardMessage(message)||['classify','summary','merge','arrange','correct'].includes(message.relationType??'');
/** These records are inspected through their affected message, unless opened explicitly. */
function statusReadingRecord(message:DemoMessage|undefined){
  if(!message)return false;
  return ['join','round','round_result'].includes(message.kind)||message.relationPayload?.operationType==='TERMINATE_SETTLEMENT'
    ||['decoration','decoration-label','inline-badge'].includes(getPresentationSpec(message.relationType??'').kind)
    ||message.kind==='relation'&&!readable(message);
}
export function readingTasks(input:ReadingInput,scope:ReadonlySet<string>,allowed:ReadonlySet<string>,direction:TraceDirection='both',order:ReadingOrder='discussion',placementOrder?:string[],providedProgress?:ReturnType<typeof deriveReadingProgress>,entryIds:ReadonlySet<string>=new Set()){
  const progress=providedProgress??deriveReadingProgress(input),map=new Map(input.messages.map(message=>[message.id,message]));
  // Rendering a record in the semantic range must not recursively enroll its
  // own body and influences in the reading queue. Keep its private marks intact.
  const readingScope=new Set([...scope].filter(id=>entryIds.has(id)||!statusReadingRecord(map.get(id))));
  const byRelation=new Map<string,string[]>();
  for(const edge of input.edges)if(!edge.from.messageId.startsWith('anon:')&&edge.from.messageId!==edge.relationMessageId){
    const values=byRelation.get(edge.relationMessageId)??[];values.push(edge.from.messageId);byRelation.set(edge.relationMessageId,values);
  }
  const destination=(id:string,affectedId:string):string=>{
    const message=map.get(id),sources=[...new Set(byRelation.get(id)??[])];
    if(statusReadingRecord(message)){
      // A reply/reference can introduce a genuinely separate source body.
      // Badges and system records are already presented in the target's status.
      const source=sources.length===1?map.get(sources[0]):undefined;
      if(message?.kind==='relation'&&!isCardMessage(message)&&getPresentationSpec(message.relationType??'').kind==='edge-label'
        &&source&&readable(source)&&!statusReadingRecord(source)&&progress.pendingBodies.has(source.id))return source.id;
      return affectedId;
    }
    return message&&!isCardMessage(message)&&sources.length===1?sources[0]:id;
  };
  const tasks:ReadingTask[]=[],keys=new Set<string>();
  const add=(task:ReadingTask)=>{if(map.has(task.destinationId)&&!keys.has(task.key)){keys.add(task.key);tasks.push(task);}};
  for(const message of input.messages){
    if(!readingScope.has(message.id))continue;
    if((readable(message)||entryIds.has(message.id))&&progress.pendingBodies.has(message.id))add({key:JSON.stringify(['body',message.id,message.revision??1]),destinationId:message.id,targetId:message.id,
      kind:'body',reason:'正文未读',location:allowed.has(message.id)?'inside':'filtered',createdAt:message.createdAt});
    for(const influence of progress.pendingInfluences.get(message.id)??[]){
      const id=destination(influence.messageId,message.id),source=map.get(influence.messageId);
      add({key:JSON.stringify(['influence',message.id,influence.key,influence.eventId,influence.resultKey]),destinationId:id,targetId:message.id,kind:'influence',influence,
        reason:influence.type==='selection'?`消息 ${message.id} 的显示版本发生变化`:`消息 ${message.id} 有未了解的${source?.relationType==='reference'?'引用':'影响'}：${influence.messageId}`,
        location:scope.has(id)?allowed.has(id)?'inside':'filtered':'outside',outsideReason:direction==='up'?'不在当前追溯方向':'超出当前追溯距离',createdAt:source?.createdAt??message.createdAt});
    }
  }
  // An effect may already be acknowledged in the target's status window while
  // its independent reply/reason body is still unread outside this range.
  const scheduledBodies=new Set(tasks.map(task=>task.destinationId));
  for(const edge of input.edges){
    const source=map.get(edge.from.messageId),target=edge.to.messageId;
    if(!readingScope.has(target)||!source||scope.has(source.id)||scheduledBodies.has(source.id)||!progress.pendingBodies.has(source.id)
      ||statusReadingRecord(source)||!readable(source)||getPresentationSpec(edge.relationType).isContainer||['read','unread'].includes(edge.relationType))continue;
    add({key:JSON.stringify(['predecessor',source.id]),destinationId:source.id,targetId:source.id,kind:'predecessor',
      reason:`消息 ${target} 关联的未读正文 ${source.id}`,location:'outside',outsideReason:direction==='up'?'不在当前追溯方向':'超出当前追溯距离',createdAt:source.createdAt});
    scheduledBodies.add(source.id);
  }
  for(const edge of input.edges){
    const from=edge.from.messageId,to=edge.to.messageId;
    if(!readingScope.has(from)||scope.has(to)||!progress.pendingBodies.has(to)||!map.has(to)||['read','unread'].includes(edge.relationType)
      ||statusReadingRecord(map.get(to))&&!entryIds.has(to))continue;
    add({key:JSON.stringify(['predecessor',to]),destinationId:to,targetId:to,kind:'predecessor',reason:`消息 ${from} 的未读前文 ${to}`,
      location:'outside',outsideReason:direction==='down'?'不在当前追溯方向':'超出当前追溯距离',createdAt:map.get(to)!.createdAt});
  }
  const traversal=order==='breadth'?discussionForest(input.messages,input.edges,map).breadthOrder
    :placementOrder??discussionForest(input.messages,input.edges,map).order;
  const ranks=new Map(traversal.map((id,index)=>[id,index]));
  tasks.sort((a,b)=>order==='time'?chronologicalOrder({id:a.key,createdAt:a.createdAt},{id:b.key,createdAt:b.createdAt})
    :(ranks.get(a.destinationId)??Infinity)-(ranks.get(b.destinationId)??Infinity)||a.key.localeCompare(b.key));
  // Browsing includes read bodies too. Keep the trace origin first; reading
  // order applies to the remaining visible, independent messages.
  const navigationIds=[...readingScope].filter(id=>{
    const message=map.get(id);return message&&allowed.has(id)&&(readable(message)||entryIds.has(id));
  }).sort((a,b)=>order==='time'?chronologicalOrder(map.get(a)!,map.get(b)!)
    :(ranks.get(a)??Infinity)-(ranks.get(b)??Infinity)||a.localeCompare(b));
  const navigable=new Set(navigationIds),origins=[...entryIds].filter(id=>navigable.has(id));
  return {tasks,progress,navigationIds:[...origins,...navigationIds.filter(id=>!entryIds.has(id))]};
}

/** The button confirms only this visit's declared bodies and affected targets. */
export function marksForReadingVisit(input:ReadingInput,tasks:ReadingTask[],displays:ReadonlyMap<string,DisplaySnapshot>){
  const marks:import('@gonglun/core').ReadingMark[]=[],bodyIds=new Set<string>(),map=new Map(input.messages.map(message=>[message.id,message]));
  const readBody=(id:string)=>{
    const display=displays.get(id);
    if(display&&!bodyIds.has(id)){
      bodyIds.add(id);marks.push(...readingMarksFor(input,id,display,'message',{automaticInfluences:false}));
    }
  };
  for(const task of tasks){
    readBody(task.destinationId);
    if(task.influence){
      // Confirming an effect at its target never reads the record's hidden body.
      // An explicit record/source visit can still read that record independently.
      if(task.destinationId!==task.targetId||!statusReadingRecord(map.get(task.influence.messageId)))readBody(task.influence.messageId);
      marks.push(...influenceReadingMarks(task.targetId,[task.influence]));
    }
  }
  const unique=new Map(marks.map(mark=>[JSON.stringify([mark.messageId,mark.scope,mark.key,mark.eventId,mark.resultKey]),mark]));
  return [...unique.values()];
}
