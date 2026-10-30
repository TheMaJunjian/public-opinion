import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {MessageReadingDetails,useMessagesReadingConfirmation,useReadingDisplayContext} from './MessageDisplayHints';
import TraceReadingPanel,{ReadingConfirmationGroups} from './TraceReadingPanel';
import {nextReadingVisit,readingTasks,type ReadingTask,type ReadingOrder} from '../pages/workbench/model/readingTasks';
import {useReadingQueue} from '../hooks/useReadingQueue';
import type {TraceDirection} from '../utils/traceRange';
import {getMessageTypeLabel,getOrganizationTitle} from '../utils/messageDisplay';
import type {ReadingNavigationMarkers} from '../hooks/useViewedMessageHighlight';
import {readingConfirmations} from '../pages/workbench/model/readingConfirmations';
import RecentWorkbenchViews from './RecentWorkbenchViews';
interface Props {
  scopeKey:string;scopeIds:ReadonlySet<string>;allowedIds:ReadonlySet<string>;direction:TraceDirection;order:ReadingOrder;onOrder:(order:ReadingOrder)=>void;
  placementOrder?:string[];path:string[][];focusId:string|null;focusLocated:boolean;incoming:ReadingTask[];ready:boolean;
  onNavigate:(id:string,tasks:ReadingTask[],forceTrace?:boolean)=>Promise<void>;onBack:()=>void;
  onNavigationChange?:(markers:ReadingNavigationMarkers)=>void;
  recentSelectedIds?:readonly string[];focusIds?:readonly string[];
  onNavigateGroup?:(ids:string[],tasks:ReadingTask[],forceTrace?:boolean)=>Promise<void>;
  canGoBack?:boolean;canGoForward?:boolean;onBackward?:()=>void;onForward?:()=>void;
}
export default function TraceReadingController(p:Props){
  const context=useReadingDisplayContext();
  return context?<ReadingController {...p} context={context}/>:null;
}
function ReadingController(p:Props&{context:NonNullable<ReturnType<typeof useReadingDisplayContext>>}){
  const {context}=p;
  const readingIds=useMemo(()=>p.focusIds??(p.focusId?[p.focusId]:[]),[p.focusIds,p.focusId]);
  const readingKey=JSON.stringify(readingIds);
  const confirmation=useMessagesReadingConfirmation(readingIds);
  const messageTypes=useMemo(()=>new Map(context.readingInput.messages.map(message=>[message.id,getMessageTypeLabel(message)])),[context.readingInput.messages]);
  const messagesById=useMemo(()=>new Map(context.readingInput.messages.map(message=>[message.id,message])),[context.readingInput.messages]);
  const getMessageSummary=useCallback((id:string)=>{
    const message=messagesById.get(id);
    return message?getOrganizationTitle(message)||context.data.hints.get(id)?.displayed.content||message.content:'';
  },[messagesById,context.data.hints]);
  const model=useMemo(()=>readingTasks(context.readingInput,p.scopeIds,p.allowedIds,p.direction,p.order,p.placementOrder,context.data.reading,new Set(p.path.at(-1)??[])),
    [context.readingInput,context.data.reading,p.scopeIds,p.allowedIds,p.direction,p.order,p.placementOrder,p.path]);
  const tasks=useMemo(()=>{
    const values=new Map(model.tasks.map(task=>[task.key,task]));
    for(const task of p.incoming){
      const pending=task.influence?(model.progress.pendingInfluences.get(task.targetId)??[]).some(item=>item.key===task.influence!.key&&item.eventId===task.influence!.eventId&&item.resultKey===task.influence!.resultKey)
        :model.progress.pendingBodies.has(task.destinationId);
      if(pending)values.set(task.key,{...task,location:'inside',outsideReason:undefined});
    }
    return [...values.values()];
  },[model,p.incoming]);
  const queue=useReadingQueue(p.scopeKey,tasks,p.ready,model.navigationIds),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const currentTasks=tasks.filter(task=>readingIds.includes(task.destinationId));
  const visitInfluenceKey=JSON.stringify(currentTasks.filter(task=>task.influence).map(task=>[task.destinationId,task.targetId,task.influence]));
  useEffect(()=>{
    if(!p.focusId||queue.focusId!==p.focusId)return;
    const groups=new Map<string,{recordId:string;targetId:string;items:NonNullable<ReadingTask['influence']>[]}>();
    // Effects on the current message already appear in its own influence list.
    // Only other affected targets need a return link from this reading visit.
    for(const task of currentTasks)if(task.influence&&task.targetId!==task.destinationId){
      const key=JSON.stringify([task.destinationId,task.targetId]),group=groups.get(key)??{recordId:task.destinationId,targetId:task.targetId,items:[]};
      group.items.push(task.influence);groups.set(key,group);
    }
    if(!groups.size)return;
    // The status window can confirm exactly the effects declared for this
    // visit, while leaving navigation and newly arrived effects independent.
    context.setInfluenceVisits(previous=>{
      const next=[...previous.filter(visit=>!groups.has(JSON.stringify([visit.recordId,visit.targetId]))),...groups.values()];
      return JSON.stringify(previous)===JSON.stringify(next)?previous:next;
    });
  },[p.focusId,queue.focusId,visitInfluenceKey,context.setInfluenceVisits]);
  const continueId=p.ready&&p.focusLocated&&queue.focusId===p.focusId&&confirmation.ready&&confirmation.pending&&context.onMarkRead
    ?nextReadingVisit(queue,currentTasks)?.id??null:null;
  useLayoutEffect(()=>{
    p.onNavigationChange?.({current:p.focusId,previous:null,next:null,continue:continueId});
  },[p.onNavigationChange,p.focusId,continueId]);
  const [notice,setNotice]=useState<string|null>(null);
  const latest=useRef({scopeKey:p.scopeKey,focusId:p.focusId,readingKey,queue});
  latest.current={scopeKey:p.scopeKey,focusId:p.focusId,readingKey,queue};
  type Operation={kind:'save'|'visit';scopeKey:string;focusId:string|null;readingKey:string};
  const activeOperation=useRef<Operation|null>(null);
  useLayoutEffect(()=>{setBusy(false);return()=>{activeOperation.current=null;};},[]);
  useEffect(()=>{
    if(p.focusId)queue.focus(p.focusId);setError(null);setNotice(null);
    const operation=activeOperation.current;
    // A save still persists after leaving, but no longer owns the new view.
    if(operation?.kind==='save'&&(operation.scopeKey!==p.scopeKey||operation.readingKey!==readingKey)){
      activeOperation.current=null;setBusy(false);
    }
  },[p.scopeKey,p.focusId,readingKey]);
  const visit=async(id:string,items:ReadingTask[],force=false,ids=[id])=>{
    queue.start();
    // Explicitly revealing a filtered visit accepts those tasks only.
    if(!force&&ids.every(id=>p.scopeIds.has(id)))queue.enroll(items);
    const operation:Operation={kind:'visit',scopeKey:p.scopeKey,focusId:id,readingKey:JSON.stringify(ids)};activeOperation.current=operation;
    setBusy(true);setError(null);setNotice(null);
    try{
      if(ids.length>1){if(!p.onNavigateGroup)throw new Error('暂时无法打开所选消息组');await p.onNavigateGroup(ids,items,force);}
      else await p.onNavigate(id,items,force);
    }
    catch(reason){if(activeOperation.current===operation&&!(reason instanceof Error&&reason.name==='AbortError'))setError(reason instanceof Error?reason.message:'消息定位失败，请重试');}
    finally{if(activeOperation.current===operation){activeOperation.current=null;setBusy(false);}}
  };
  const confirm=async()=>{
    if(!queue.focusId||queue.focusId!==p.focusId||!p.focusLocated||!confirmation.ready||!confirmation.pending||!context.onMarkRead)return;
    const operation:Operation={kind:'save',scopeKey:p.scopeKey,focusId:p.focusId,readingKey};activeOperation.current=operation;
    const isCurrent=()=>activeOperation.current===operation&&latest.current.scopeKey===operation.scopeKey&&latest.current.readingKey===operation.readingKey;
    setBusy(true);setError(null);setNotice(null);
    try{
      const current=currentTasks;
      const marks=confirmation.marks;
      const bodies=new Set(marks.filter(mark=>mark.scope==='message'&&mark.state!=='UNREAD').map(mark=>mark.messageId));
      const incomplete=current.some(task=>!bodies.has(task.destinationId));
      if(!marks.length||incomplete)throw new Error('当前正文尚未准备好，请稍后重试');
      await context.onMarkRead(marks);
      if(!isCurrent())return;
      const next=nextReadingVisit(latest.current.queue,current);
      if(next)await visit(next.id,next.tasks);
    }catch(reason){if(isCurrent())setError(reason instanceof Error?reason.message:'保存阅读状态失败，请重试');}
    finally{if(activeOperation.current===operation){activeOperation.current=null;setBusy(false);}}
  };
  return <>
    {!!p.incoming.length&&<details role="note" style={{fontSize:11,color:'#94a3b8',overflowWrap:'anywhere'}}><summary>本次阅读来源 · {p.incoming.length} 项</summary>
      <ReadingConfirmationGroups groups={readingConfirmations(p.incoming,messageTypes)} focusId={p.focusId} messageTypes={messageTypes} getMessageSummary={getMessageSummary} disabled={busy||!p.ready} onNavigate={id=>void visit(id,tasks.filter(task=>task.destinationId===id))}/><div>来源提示不扩展当前追溯范围。</div></details>}
    <TraceReadingPanel messageTypes={messageTypes} getMessageSummary={getMessageSummary} ready={p.ready} focusLocated={p.focusLocated} order={p.order} onOrder={p.onOrder} {...queue} focusIds={readingIds} confirmations={readingConfirmations(currentTasks,messageTypes)} statistics={{bodies:tasks.filter(task=>task.kind==='body'&&task.location==='inside').length,
      influences:tasks.filter(task=>task.kind==='influence'&&task.location!=='filtered').length,outsideInfluences:tasks.filter(task=>task.kind==='influence'&&task.location==='outside').length}} busy={busy||!p.ready||queue.focusId!==p.focusId} canRead={!!context.onMarkRead} isWorking={busy} error={error} notice={notice}
      readingDetails={readingIds.length?<RecentWorkbenchViews ownerKey={context.versionHistory} viewKey={JSON.stringify([p.scopeKey,readingIds])}>{readingIds.map(id=><details key={id} open data-reading-message-section={id} style={{overflowWrap:'anywhere'}}>
        <summary style={{cursor:'pointer'}}>【{messageTypes.get(id)??'消息'}】 {id} · 消息与影响</summary>
        <MessageReadingDetails messageId={id} disabled={busy||!p.ready||!p.focusLocated}/>
      </details>)}</RecentWorkbenchViews>:undefined} canConfirm={confirmation.ready&&confirmation.pending}
      canGoBack={!!p.canGoBack} canGoForward={!!p.canGoForward} onBackward={()=>{setError(null);p.onBackward?.();}} onForward={()=>{setError(null);p.onForward?.();}} recentSelectedIds={p.recentSelectedIds}
      onSetReading={ids=>{if(ids.length)void visit(ids[0],tasks.filter(task=>ids.includes(task.destinationId)),false,ids);}}
      onRead={()=>void confirm()} onNew={()=>{const first=queue.added[0];queue.acceptNew();if(first)void visit(first.id,first.tasks);}}
      onVisit={item=>void visit(item.id,item.tasks)} onBack={p.onBack} path={p.path}/>
  </>;
}
