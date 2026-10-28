import {useEffect,useMemo,useRef,useState} from 'react';
import {useReadingDisplayContext} from './MessageDisplayHints';
import TraceReadingPanel from './TraceReadingPanel';
import {marksForReadingVisit,readingTasks,type ReadingTask,type ReadingOrder} from '../pages/workbench/model/readingTasks';
import {useReadingQueue} from '../hooks/useReadingQueue';
import type {TraceDirection} from '../utils/traceRange';
import {getMessageTypeLabel} from '../utils/messageDisplay';
interface Props {
  scopeKey:string;scopeIds:ReadonlySet<string>;allowedIds:ReadonlySet<string>;direction:TraceDirection;order:ReadingOrder;onOrder:(order:ReadingOrder)=>void;
  placementOrder?:string[];path:string[][];focusId:string|null;focusLocated:boolean;incoming:ReadingTask[];ready:boolean;
  onNavigate:(id:string,tasks:ReadingTask[],forceTrace?:boolean)=>Promise<void>;onBack:()=>void;
}
export default function TraceReadingController(p:Props){
  const context=useReadingDisplayContext();
  return context?<ReadingController {...p} context={context}/>:null;
}
function ReadingController(p:Props&{context:NonNullable<ReturnType<typeof useReadingDisplayContext>>}){
  const {context}=p;
  const messageTypes=useMemo(()=>new Map(context.readingInput.messages.map(message=>[message.id,getMessageTypeLabel(message)])),[context.readingInput.messages]);
  const model=useMemo(()=>readingTasks(context.readingInput,p.scopeIds,p.allowedIds,p.direction,p.order,p.placementOrder,context.data.reading),
    [context.readingInput,context.data.reading,p.scopeIds,p.allowedIds,p.direction,p.order,p.placementOrder]);
  const tasks=useMemo(()=>{
    const values=new Map(model.tasks.map(task=>[task.key,task]));
    for(const task of p.incoming){
      const pending=task.influence?(model.progress.pendingInfluences.get(task.targetId)??[]).some(item=>item.key===task.influence!.key&&item.eventId===task.influence!.eventId&&item.resultKey===task.influence!.resultKey)
        :model.progress.pendingBodies.has(task.destinationId);
      if(pending)values.set(task.key,{...task,location:'inside',outsideReason:undefined});
    }
    return [...values.values()];
  },[model,p.incoming]);
  const queue=useReadingQueue(p.scopeKey,tasks,p.ready),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const latest=useRef({scopeKey:p.scopeKey,focusId:p.focusId,queue});
  latest.current={scopeKey:p.scopeKey,focusId:p.focusId,queue};
  type Operation={kind:'save'|'visit';scopeKey:string;focusId:string|null};
  const activeOperation=useRef<Operation|null>(null);
  useEffect(()=>()=>{activeOperation.current=null;},[]);
  useEffect(()=>{
    if(p.focusId)queue.focus(p.focusId);setError(null);setNotice(null);
    const operation=activeOperation.current;
    // A save still persists after leaving, but no longer owns the new view.
    if(operation?.kind==='save'&&(operation.scopeKey!==p.scopeKey||operation.focusId!==p.focusId)){
      activeOperation.current=null;setBusy(false);
    }
  },[p.scopeKey,p.focusId]);
  const visit=async(id:string,items:ReadingTask[],force=false)=>{
    queue.start();
    // Explicitly revealing a filtered visit accepts those tasks only.
    if(!force&&p.scopeIds.has(id))queue.enroll(items);
    const operation:Operation={kind:'visit',scopeKey:p.scopeKey,focusId:id};activeOperation.current=operation;
    setBusy(true);setError(null);setNotice(null);
    try{await p.onNavigate(id,items,force);}
    catch(reason){if(activeOperation.current===operation&&!(reason instanceof Error&&reason.name==='AbortError'))setError(reason instanceof Error?reason.message:'消息定位失败，请重试');}
    finally{if(activeOperation.current===operation){activeOperation.current=null;setBusy(false);}}
  };
  const navigate=(item:{id:string;tasks:ReadingTask[]}|undefined)=>{if(item)void visit(item.id,item.tasks);};
  const confirm=async()=>{
    if(!queue.focusId||!p.focusLocated||!queue.current.length||!context.onMarkRead)return;
    const operation:Operation={kind:'save',scopeKey:p.scopeKey,focusId:p.focusId};activeOperation.current=operation;
    const isCurrent=()=>activeOperation.current===operation&&latest.current.scopeKey===operation.scopeKey&&latest.current.focusId===operation.focusId;
    setBusy(true);setError(null);setNotice(null);
    try{
      const current=queue.current;
      const displays=new Map([...context.data.hints].map(([id,hint])=>[id,hint.displayed]));
      const marks=marksForReadingVisit(context.readingInput,current,displays);
      // An original-only mark satisfies a prerequisite, not the current body.
      const bodies=new Set(marks.filter(mark=>mark.scope==='message'&&mark.state!=='UNREAD').map(mark=>mark.messageId));
      const incomplete=current.some(task=>!bodies.has(task.destinationId));
      const originalOnly=incomplete&&marks.some(mark=>mark.scope==='original'&&current.some(task=>task.destinationId===mark.messageId));
      if(!marks.length||incomplete&&!originalOnly)throw new Error('当前正文尚未准备好，请稍后重试');
      await context.onMarkRead(marks);
      if(!isCurrent())return;
      if(originalOnly){setNotice('原文已记录。请先阅读更正内容，再确认当前正文。');return;}
      const confirmed=new Set(current.map(task=>task.key));
      const activeQueue=latest.current.queue,remaining=activeQueue.pending.filter(item=>item.tasks.some(task=>!confirmed.has(task.key)));
      const forward=new Set(activeQueue.visits.slice(activeQueue.position).map(visit=>visit.id));
      const next=remaining.find(item=>forward.has(item.id))??remaining[0];
      if(next)await visit(next.id,next.tasks);
    }catch(reason){if(isCurrent())setError(reason instanceof Error?reason.message:'保存阅读状态失败，请重试');}
    finally{if(activeOperation.current===operation){activeOperation.current=null;setBusy(false);}}
  };
  return <>
    {!!p.incoming.length&&<div role="note" style={{fontSize:11,color:'#94a3b8',overflowWrap:'anywhere'}}>本次阅读来源：{[...new Set(p.incoming.map(task=>task.reason))].join('；')}。来源提示不扩展当前追溯范围。</div>}
    <TraceReadingPanel messageTypes={messageTypes} ready={p.ready} focusLocated={p.focusLocated} order={p.order} onOrder={p.onOrder} {...queue} confirmations={queue.current.map(task=>task.reason)} statistics={{bodies:tasks.filter(task=>task.kind==='body'&&task.location==='inside').length,
      influences:tasks.filter(task=>task.kind==='influence'&&task.location!=='filtered').length,outsideInfluences:tasks.filter(task=>task.kind==='influence'&&task.location==='outside').length}} busy={busy||!p.ready} canRead={!!context.onMarkRead} isWorking={busy} error={error} notice={notice}
      onNext={()=>navigate(queue.next)} onPrevious={()=>navigate(queue.previous)} onRead={()=>void confirm()} onNew={()=>{const first=queue.added[0];queue.acceptNew();if(first)void visit(first.id,first.tasks);}}
      onVisit={item=>void visit(item.id,item.tasks)} onTrace={id=>void visit(id,[],true)} onBack={p.onBack} path={p.path}/>
  </>;
}
