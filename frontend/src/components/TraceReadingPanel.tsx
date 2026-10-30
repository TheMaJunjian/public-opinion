import type {ReactNode} from 'react';
import type {ReadingOrder,ReadingTask} from '../pages/workbench/model/readingTasks';
import {readingConfirmations,type ReadingConfirmationGroup} from '../pages/workbench/model/readingConfirmations';
import MessageReferenceControl from './MessageReferenceControl';
type Visit={id:string;tasks:ReadingTask[]};
interface ReferenceActions {getMessageSummary?:(id:string)=>string;onNavigate?:(id:string)=>void;disabled?:boolean;}
function ReadingMessageId({id,type,getMessageSummary,onNavigate,disabled,navigateLabel}:{id:string;type?:string;navigateLabel?:string}&ReferenceActions){
  return <span data-reading-message-id={id}><MessageReferenceControl messageId={id} type={type??'消息'} summary={getMessageSummary?.(id)} onNavigate={onNavigate} disabled={disabled} navigateLabel={navigateLabel}/></span>;
}
export function ReadingConfirmationGroups({groups,focusId,messageTypes,...actions}:{groups:ReadingConfirmationGroup[];focusId:string|null;messageTypes:ReadonlyMap<string,string>}&ReferenceActions){
  return <>{groups.map(group=><details key={group.key} open data-reading-confirmation-group={group.key} style={{marginTop:4,paddingLeft:6,borderLeft:'2px solid #334155'}}>
    <summary style={{cursor:'pointer'}}>{group.title} · {group.kind==='body'?`${group.items.length} 条`:`${group.items.length} 条消息 / ${group.count} 项`}</summary>
    {group.items.map(item=>{
      const targets=item.targets.filter(id=>id!==focusId),showSource=item.messageId!==focusId;
      if(group.kind!=='body'&&!showSource&&!targets.length)return null;
      return <div key={item.key} data-reading-confirmation-item={item.messageId} style={{padding:'3px 0',overflowWrap:'anywhere'}}>
      {group.kind==='body'?<span>【{item.type}】当前正文</span>:<>
        {showSource&&<ReadingMessageId id={item.messageId} type={item.type} {...actions}/>}
        {!!targets.length&&<>{showSource?' · ':''}{group.kind==='selection'?'显示版本变化：':'影响：'}
          {targets.map((id,index)=><span key={id}>{index>0?'、':''}<ReadingMessageId id={id} type={messageTypes.get(id)} {...actions}/></span>)}
        </>}
      </>}
    </div>;})}
  </details>)}</>;
}
interface Props {
  order:ReadingOrder;onOrder:(order:ReadingOrder)=>void;focusId:string|null;pending:Visit[];added:Visit[];outside:Visit[];filtered:Visit[];
  busy:boolean;canRead:boolean;isWorking:boolean;error:string|null;notice?:string|null;onForward:()=>void;onBackward:()=>void;onRead:()=>void;onNew:()=>void;
  canGoBack:boolean;canGoForward:boolean;recentSelectedIds?:readonly string[];focusIds?:readonly string[];onSetReading:(ids:string[])=>void;
  confirmations:ReadingConfirmationGroup[];
  readingDetails?:ReactNode;canConfirm?:boolean;
  statistics:{bodies:number;influences:number;outsideInfluences:number};
  ready:boolean;focusLocated:boolean;
  onVisit:(visit:Visit)=>void;onBack:()=>void;path:string[][];
  messageTypes:ReadonlyMap<string,string>;
  getMessageSummary?:(id:string)=>string;
}
export default function TraceReadingPanel(p:Props){
  const focusIds=p.focusIds??(p.focusId?[p.focusId]:[]),selectedIds=p.recentSelectedIds??[];
  const onNavigate=(id:string)=>p.onVisit([...p.pending,...p.outside,...p.filtered].find(visit=>visit.id===id)??{id,tasks:[]});
  const actions:ReferenceActions={getMessageSummary:p.getMessageSummary,onNavigate,disabled:p.busy};
  const groups:Array<{type:string;location:ReadingTask['location'];visits:Visit[]}>=[];
  for(const visit of [...p.outside,...p.filtered]){
    const type=p.messageTypes.get(visit.id)??'消息',location=visit.tasks[0]?.location??'outside',previous=groups.at(-1);
    if(previous?.type===type&&previous.location===location)previous.visits.push(visit);
    else groups.push({type,location,visits:[visit]});
  }
  const reminder=(visit:Visit,type:string)=><div key={visit.id} style={{padding:'5px 0',overflowWrap:'anywhere'}}>
    <span>{visit.tasks[0]?.location==='outside'?'继续追溯并阅读':'临时显示并阅读'} <ReadingMessageId id={visit.id} type={type} {...actions} onNavigate={()=>p.onVisit(visit)} navigateLabel={`${visit.tasks[0]?.location==='outside'?'继续追溯并阅读':'临时显示并阅读'} 【${type}】 ${visit.id}`}/></span>
    <div style={{color:'#94a3b8'}}>{visit.tasks[0]?.outsideReason??'被当前筛选隐藏'} · {visit.tasks.length} 项待确认</div>
    <details><summary>确认明细</summary><ReadingConfirmationGroups groups={readingConfirmations(visit.tasks,p.messageTypes)} focusId={visit.id} messageTypes={p.messageTypes} {...actions}/></details>
  </div>;
  return <section className="trace-reading-panel" aria-label="追溯阅读" aria-busy={p.isWorking} style={{marginTop:8,padding:8,border:'1px solid #475569',borderRadius:6,fontSize:12,display:'grid',gap:7}}>
    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
      <label>阅读顺序 <select className="workbench-trace-select" aria-label="阅读顺序" value={p.order} onChange={event=>p.onOrder(event.target.value as ReadingOrder)}>
        <option value="discussion">深度优先（顺着讨论读）</option><option value="breadth">广度优先（逐层阅读）</option><option value="time">按时间浏览（从早到晚）</option>
      </select></label>
      <span>本轮待阅 {p.pending.length} 条 · 新增 {p.added.length} 条 · 范围外 {p.outside.length} 条 · 筛选隐藏 {p.filtered.length} 条</span>
    </div>
    <div style={{color:'#94a3b8'}}>{p.order==='breadth'?'以追溯消息为起点，其余消息先浏览同一层，再进入下一层。':p.order==='time'?'以追溯消息为起点，其余消息按发送时间从早到晚浏览。':'以追溯消息为起点，沿讨论分支依次浏览。'}</div>
    <div style={{color:'#94a3b8'}}>「后退 / 前进」返回实际浏览过的阅读位置，不改变已读状态；「已读并继续」确认当前内容并前往待阅消息。</div>
    <div data-reading-marker-legend style={{color:'#94a3b8',fontSize:11}}>画布边中标记：<span style={{color:'#22c55e'}}>— 当前组</span> · ‹ 后退目标 · <span style={{color:'#60a5fa'}}>› 前进目标</span> · <span style={{color:'#fbbf24'}}>» 已读并继续目标</span>。标记组内在当前画布显示的消息；目标重叠时并列显示。</div>
    <div style={{color:'#94a3b8'}}>指定阅读消息时自动以它为追溯起点，按当前距离显示前因与后续；默认向上 1 层、向下 2 层。</div>
    <div>{p.ready?<>正文未读 {p.statistics.bodies} 条 · 影响待了解 {p.statistics.influences} 项{p.statistics.outsideInfluences>0?`（其中 ${p.statistics.outsideInfluences} 项来自范围外）`:''}</>:'正在统计待阅内容…'}</div>
    <details data-reading-path style={{overflowWrap:'anywhere'}}><summary>追溯来源 · {p.path.length} 层</summary><div style={{color:'#94a3b8'}}>每层可由多条消息共同发起追溯；这里记录追溯范围的来源。</div>{p.path.map((ids,index)=><div key={index}>第 {index+1} 层：{ids.map((id,at)=><span key={id}>{at>0?'、':''}<ReadingMessageId id={id} type={p.messageTypes.get(id)} {...actions}/></span>)}</div>)}</details>
    {!!focusIds.length&&<div data-reading-current-group data-reading-trace-current style={{overflowWrap:'anywhere'}}>当前阅读与追溯消息{focusIds.length>1?`（${focusIds.length} 条）`:''}：{focusIds.map((id,index)=><span key={id} data-reading-current-id={id}>{index>0?'、':''}<ReadingMessageId id={id} type={p.messageTypes.get(id)} {...actions}/></span>)}</div>}
    <div data-reading-recent-selection={JSON.stringify(selectedIds)} style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap',overflowWrap:'anywhere'}}>
      <span>最近选中的消息{selectedIds.length>1?`（${selectedIds.length} 条）`:''}：{selectedIds.length?selectedIds.map((id,index)=><span key={id}>{index>0?'、':''}<ReadingMessageId id={id} type={p.messageTypes.get(id)} {...actions}/></span>):<span style={{color:'#94a3b8'}}>尚未选中消息</span>}</span>
      <button disabled={p.busy||!selectedIds.length} title="阅读所选消息，并自动以它们为追溯起点" onClick={()=>p.onSetReading([...selectedIds])}>设为阅读消息</button>
    </div>
    <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
      <button aria-label="阅读后退" disabled={p.busy||!p.canGoBack} onClick={p.onBackward} title="返回上一次阅读的位置及追溯范围">后退</button>
      <button aria-label="阅读前进" disabled={p.busy||!p.canGoForward} onClick={p.onForward} title="前往后退前浏览的阅读位置">前进</button>
      <button disabled={p.busy||!p.canRead||!p.focusId||!p.focusLocated||!(p.canConfirm??p.confirmations.length>0)} onClick={p.onRead} title={p.focusId&&!p.focusLocated?'请先跳转并定位当前消息':`仅确认当前阅读的 ${focusIds.length} 条消息正文及各自列出的影响`}>{focusIds.length>1?'本组已读并继续':'已读并继续'}</button>
      {p.focusId&&!p.focusLocated&&<button disabled={p.busy} onClick={()=>p.onSetReading([...focusIds])}>重新定位当前消息</button>}
      {!!p.added.length&&<button disabled={p.busy} onClick={p.onNew}>阅读新增待阅</button>}
      {p.path.length>1&&<button onClick={p.onBack}>返回上一层追溯</button>}
    </div>
    {p.readingDetails??(p.focusId&&p.confirmations.length>0&&<details open data-reading-confirmations style={{overflowWrap:'anywhere',color:'#cbd5e1'}}>
      <summary style={{cursor:'pointer'}}>本次将确认：正文 {p.confirmations.filter(group=>group.kind==='body').reduce((sum,group)=>sum+group.count,0)} 条 · 影响 {p.confirmations.filter(group=>group.kind!=='body').reduce((sum,group)=>sum+group.count,0)} 项</summary>
      <ReadingConfirmationGroups groups={p.confirmations} focusId={p.focusId} messageTypes={p.messageTypes} {...actions}/>
    </details>)}
    {p.ready&&!p.pending.length&&!p.added.length&&<div role="status">当前范围内可处理的内容已完成{p.outside.length?'，仍有范围外待阅内容':''}{p.filtered.length?'，另有筛选隐藏的待阅内容':''}。</div>}
    {p.error&&<div role="alert" style={{color:'#fca5a5'}}>{p.error}</div>}
    {p.notice&&<div role="status" style={{color:'#cbd5e1'}}>{p.notice}</div>}
    {(p.outside.length>0||p.filtered.length>0)&&<details><summary><span>范围外及筛选隐藏的待阅内容</span> · 范围外 {p.outside.length} 条 · 筛选隐藏 {p.filtered.length} 条</summary>
      <div style={{color:'#94a3b8',padding:'5px 0'}}>范围外：与当前阅读有关，但超出当前追溯距离或所在分类的待阅消息。筛选隐藏：在当前范围内，但被清爽视图或其他筛选条件隐藏的待阅消息。下列入口可继续追溯或临时显示并阅读。</div>
      {groups.map(group=>group.visits.length===1?reminder(group.visits[0],group.type):<details key={`${group.location}-${group.visits[0].id}`} data-reading-type-group={group.type}>
        <summary>{group.type} · {group.location==='outside'?'范围外':'筛选隐藏'} · {group.visits.length} 条</summary>
        {group.visits.map(visit=>reminder(visit,group.type))}
      </details>)}
    </details>}
  </section>;
}
