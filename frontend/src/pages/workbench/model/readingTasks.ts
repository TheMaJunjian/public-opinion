import {isCardMessage,type DemoMessage} from '../../../utils/modelBridge';
import {chronologicalOrder,discussionForest} from '../../../utils/discussionOrder';
import type {TraceDirection} from '../../../utils/traceRange';
import {deriveReadingProgress,influenceReadingMarks,readingMarksFor,type ReadingInput,type ReadingInfluence} from './readingProgress';
import type {DisplaySnapshot} from './displayHintSnapshot';

export type ReadingOrder='discussion'|'time';
export interface ReadingTask {
  key:string; destinationId:string; targetId:string; kind:'body'|'influence'|'predecessor';
  reason:string; location:'inside'|'outside'|'filtered'; outsideReason?:string;
  influence?:ReadingInfluence; createdAt:string;
}
export function readingTasks(input:ReadingInput,scope:ReadonlySet<string>,allowed:ReadonlySet<string>,direction:TraceDirection='both',order:ReadingOrder='discussion',placementOrder?:string[],providedProgress?:ReturnType<typeof deriveReadingProgress>){
  const progress=providedProgress??deriveReadingProgress(input),map=new Map(input.messages.map(message=>[message.id,message]));
  const byRelation=new Map<string,string[]>();
  for(const edge of input.edges)if(!edge.from.messageId.startsWith('anon:')&&edge.from.messageId!==edge.relationMessageId){
    const values=byRelation.get(edge.relationMessageId)??[];values.push(edge.from.messageId);byRelation.set(edge.relationMessageId,values);
  }
  const destination=(id:string)=>{
    const message=map.get(id),sources=[...new Set(byRelation.get(id)??[])];
    return message&&!isCardMessage(message)&&sources.length===1?sources[0]:id;
  };
  const tasks:ReadingTask[]=[],keys=new Set<string>();
  const add=(task:ReadingTask)=>{if(map.has(task.destinationId)&&!keys.has(task.key)){keys.add(task.key);tasks.push(task);}};
  const readable=(message:DemoMessage)=>isCardMessage(message)||['classify','summary','merge','arrange','correct'].includes(message.relationType??'');
  for(const message of input.messages){
    if(!scope.has(message.id))continue;
    if(readable(message)&&progress.pendingBodies.has(message.id))add({key:JSON.stringify(['body',message.id,message.revision??1]),destinationId:message.id,targetId:message.id,
      kind:'body',reason:'正文未读',location:allowed.has(message.id)?'inside':'filtered',createdAt:message.createdAt});
    for(const influence of progress.pendingInfluences.get(message.id)??[]){
      const id=destination(influence.messageId),source=map.get(influence.messageId);
      add({key:JSON.stringify(['influence',message.id,influence.key,influence.eventId,influence.resultKey]),destinationId:id,targetId:message.id,kind:'influence',influence,
        reason:influence.type==='selection'?`消息 ${message.id} 的显示版本发生变化`:`消息 ${message.id} 有未了解的${source?.relationType==='reference'?'引用':'影响'}：${influence.messageId}`,
        location:scope.has(id)?allowed.has(id)?'inside':'filtered':'outside',outsideReason:direction==='up'?'不在当前追溯方向':'超出当前追溯距离',createdAt:source?.createdAt??message.createdAt});
    }
  }
  for(const edge of input.edges){
    const from=edge.from.messageId,to=edge.to.messageId;
    if(!scope.has(from)||scope.has(to)||!progress.pendingBodies.has(to)||!map.has(to)||['read','unread'].includes(edge.relationType))continue;
    add({key:JSON.stringify(['predecessor',to]),destinationId:to,targetId:to,kind:'predecessor',reason:`消息 ${from} 的未读前文 ${to}`,
      location:'outside',outsideReason:direction==='down'?'不在当前追溯方向':'超出当前追溯距离',createdAt:map.get(to)!.createdAt});
  }
  const ranks=new Map((placementOrder??discussionForest(input.messages,input.edges,map).order).map((id,index)=>[id,index]));
  tasks.sort((a,b)=>order==='time'?chronologicalOrder({id:a.key,createdAt:a.createdAt},{id:b.key,createdAt:b.createdAt})
    :(ranks.get(a.destinationId)??Infinity)-(ranks.get(b.destinationId)??Infinity)||a.key.localeCompare(b.key));
  return {tasks,progress};
}

/** The button confirms only this visit's declared bodies and affected targets. */
export function marksForReadingVisit(input:ReadingInput,tasks:ReadingTask[],displays:ReadonlyMap<string,DisplaySnapshot>){
  const marks:import('@gonglun/core').ReadingMark[]=[],bodyIds=new Set<string>();
  const readBody=(id:string)=>{
    const display=displays.get(id);
    if(display&&!bodyIds.has(id)){
      bodyIds.add(id);marks.push(...readingMarksFor(input,id,display,'message',{automaticInfluences:false}));
    }
  };
  for(const task of tasks){
    readBody(task.destinationId);
    if(task.influence){
      // A relationship displayed with its source is part of this explicit visit.
      // Read that record too, without acknowledging its other affected targets.
      readBody(task.influence.messageId);
      marks.push(...influenceReadingMarks(task.targetId,[task.influence]));
    }
  }
  const unique=new Map(marks.map(mark=>[JSON.stringify([mark.messageId,mark.scope,mark.key,mark.eventId,mark.resultKey]),mark]));
  return [...unique.values()];
}
