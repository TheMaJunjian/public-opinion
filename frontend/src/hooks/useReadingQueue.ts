import {useRef,useState} from 'react';
import type {ReadingTask} from '../pages/workbench/model/readingTasks';

interface Session {baseline:string[];snapshots:Map<string,ReadingTask>;navigationIds:string[];started:boolean;initialized:boolean;focusId:string|null;}
/** View sessions restore independently; completion is always derived from live marks. */
export function useReadingQueue(key:string,tasks:ReadingTask[],ready:boolean,orderedIds?:readonly string[]){
  const sessions=useRef(new Map<string,Session>()),[,redraw]=useState(0);
  let session=sessions.current.get(key);
  const inside=tasks.filter(task=>task.location==='inside');
  if(!session){session={baseline:[],snapshots:new Map(),navigationIds:[],started:false,initialized:false,focusId:null};sessions.current.set(key,session);}
  if(ready&&(!session.initialized||!session.started)){session.baseline=inside.map(task=>task.key);session.snapshots=new Map(inside.map(task=>[task.key,task]));session.navigationIds=[...new Set([...(session.started?session.navigationIds:[]),...(orderedIds??[]),...inside.map(task=>task.destinationId)])];session.initialized=true;}
  const baseline=new Set(session.baseline),byKey=new Map(inside.map(task=>[task.key,task]));
  const pending=session.baseline.flatMap(key=>byKey.has(key)?[byKey.get(key)!]:[]);
  const added=inside.filter(task=>!baseline.has(task.key));
  const focus=(id:string)=>{
    // An already-read origin still belongs to navigation, without becoming a
    // pending task or changing any reading marks.
    if(!session!.navigationIds.includes(id))session!.navigationIds.splice(session!.navigationIds.indexOf(session!.focusId??'')+1,0,id);
    session!.started=true;session!.focusId=id;redraw(value=>value+1);
  };
  const start=()=>{session!.started=true;};
  const enroll=(items:ReadingTask[])=>{
    const keys=new Set(session!.baseline);
    for(const item of items){keys.add(item.key);session!.snapshots.set(item.key,item);}
    session!.baseline=[...keys];session!.started=true;redraw(value=>value+1);
  };
  const acceptNew=()=>enroll(added);
  const groups=(items:ReadingTask[])=>{
    const grouped=new Map<string,ReadingTask[]>();
    for(const item of items){const values=grouped.get(item.destinationId)??[];values.push(item);grouped.set(item.destinationId,values);}
    return [...grouped].map(([id,tasks])=>({id,tasks}));
  };
  // Retain completed visits so confirming a body never removes the way back.
  const groupedVisits=groups(session.baseline.flatMap(key=>{const item=byKey.get(key)??session!.snapshots.get(key);return item?[item]:[];}));
  const byDestination=new Map(groupedVisits.map(visit=>[visit.id,visit])),navigationIds=new Set(session.navigationIds);
  for(const visit of groupedVisits)if(!navigationIds.has(visit.id)){session.navigationIds.push(visit.id);navigationIds.add(visit.id);}
  const visits=session.navigationIds.map(id=>byDestination.get(id)??{id,tasks:[]});
  const index=visits.findIndex(visit=>visit.id===session!.focusId);
  return {focusId:session.focusId,focus,start,enroll,acceptNew,pending:groups(pending),added:groups(added),
    visits,previous:index>0?visits[index-1]:undefined,next:visits[index+1],position:index+1,total:visits.length,
    outside:groups(tasks.filter(task=>task.location==='outside')),filtered:groups(tasks.filter(task=>task.location==='filtered')),
    current:pending.filter(task=>task.destinationId===session!.focusId)};
}
