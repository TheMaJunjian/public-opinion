import type {ReadingOrder,ReadingTask} from '../pages/workbench/model/readingTasks';
type Visit={id:string;tasks:ReadingTask[]};
interface Props {
  order:ReadingOrder;onOrder:(order:ReadingOrder)=>void;focusId:string|null;pending:Visit[];added:Visit[];outside:Visit[];filtered:Visit[];
  busy:boolean;canRead:boolean;isWorking:boolean;error:string|null;notice?:string|null;onNext:()=>void;onPrevious:()=>void;onRead:()=>void;onNew:()=>void;
  previous?:Visit;next?:Visit;position:number;total:number;
  confirmations:string[];
  statistics:{bodies:number;influences:number;outsideInfluences:number};
  ready:boolean;focusLocated:boolean;
  onVisit:(visit:Visit)=>void;onTrace:(id:string)=>void;onBack:()=>void;path:string[][];
  messageTypes:ReadonlyMap<string,string>;
}
export default function TraceReadingPanel(p:Props){
  const groups:Array<{type:string;location:ReadingTask['location'];visits:Visit[]}>=[];
  for(const visit of [...p.outside,...p.filtered]){
    const type=p.messageTypes.get(visit.id)??'消息',location=visit.tasks[0]?.location??'outside',previous=groups.at(-1);
    if(previous?.type===type&&previous.location===location)previous.visits.push(visit);
    else groups.push({type,location,visits:[visit]});
  }
  const reminder=(visit:Visit,type:string)=><div key={visit.id} style={{padding:'5px 0',overflowWrap:'anywhere'}}>
    <div><span style={{color:'#a5b4fc'}}>【{type}】</span>{[...new Set(visit.tasks.map(task=>task.reason))].join('；')}</div>
    <div style={{color:'#94a3b8'}}>{visit.tasks[0]?.outsideReason??'被当前筛选隐藏'}</div>
    <button disabled={p.busy} onClick={()=>p.onVisit(visit)}>{visit.tasks[0]?.location==='outside'?'继续追溯并阅读':'临时显示并阅读'} {visit.id}</button>
  </div>;
  return <section className="trace-reading-panel" aria-label="追溯阅读" aria-busy={p.isWorking} style={{marginTop:8,padding:8,border:'1px solid #475569',borderRadius:6,fontSize:12,display:'grid',gap:7}}>
    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
      <label>阅读顺序 <select className="workbench-trace-select" aria-label="阅读顺序" value={p.order} onChange={event=>p.onOrder(event.target.value as ReadingOrder)}>
        <option value="discussion">沿讨论浏览</option><option value="time">按时间浏览（从早到晚）</option>
      </select></label>
      <span>本轮待阅 {p.pending.length} 条 · 新增 {p.added.length} 条 · 范围外 {p.outside.length} 条 · 筛选隐藏 {p.filtered.length} 条</span>
    </div>
    <div style={{color:'#94a3b8'}}>用「上一条 / 下一条」直接跳转，不改变已读状态；看完后可点「已读并继续」。</div>
    <div>{p.ready?<>正文未读 {p.statistics.bodies} 条 · 影响待了解 {p.statistics.influences} 项{p.statistics.outsideInfluences>0?`（其中 ${p.statistics.outsideInfluences} 项来自范围外）`:''}</>:'正在统计待阅内容…'}</div>
    <div title={p.path.map(ids=>ids.join('、')).join(' → ')} style={{overflowWrap:'anywhere'}}>追溯路径：{p.path.map(ids=>ids.join('、')).join(' → ')}</div>
    {p.focusId&&<div style={{overflowWrap:'anywhere'}}><span>当前阅读消息：{p.focusId}</span>{p.position>0&&<span> · 第 {p.position} / {p.total} 条</span>}</div>}
    {p.focusId&&p.confirmations.length>0&&<div style={{overflowWrap:'anywhere',color:'#cbd5e1'}}>本次将确认：{[...new Set(p.confirmations)].join('；')}</div>}
    <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
      <button disabled={p.busy||!p.previous} onClick={p.onPrevious} title="跳转到上一条，保留当前已读状态">上一条</button>
      <button disabled={p.busy||!p.next} onClick={p.onNext} title="直接跳转到下一条，无需标记已读">下一条</button>
      <button disabled={p.busy||!p.canRead||!p.focusId||!p.focusLocated||!p.confirmations.length} onClick={p.onRead} title={p.focusId&&!p.focusLocated?'请先跳转并定位当前消息':'仅确认当前阅读消息正文及本次列出的影响'}>已读并继续</button>
      {p.focusId&&!p.focusLocated&&<button disabled={p.busy} onClick={()=>p.onVisit({id:p.focusId!,tasks:[]})}>重新定位当前消息</button>}
      {!!p.added.length&&<button disabled={p.busy} onClick={p.onNew}>阅读新增待阅</button>}
      {p.focusId&&<button onClick={()=>p.onTrace(p.focusId!)}>继续追溯当前消息</button>}
      {p.path.length>1&&<button onClick={p.onBack}>返回上一层追溯</button>}
    </div>
    {p.ready&&!p.pending.length&&!p.added.length&&<div role="status">当前范围内可处理的内容已完成{p.outside.length?'，仍有范围外待阅内容':''}{p.filtered.length?'，另有筛选隐藏的待阅内容':''}。</div>}
    {p.error&&<div role="alert" style={{color:'#fca5a5'}}>{p.error}</div>}
    {p.notice&&<div role="status" style={{color:'#cbd5e1'}}>{p.notice}</div>}
    {(p.outside.length>0||p.filtered.length>0)&&<details><summary>范围外及筛选隐藏的待阅内容</summary>
      {groups.map(group=>group.visits.length===1?reminder(group.visits[0],group.type):<details key={`${group.location}-${group.visits[0].id}`} data-reading-type-group={group.type}>
        <summary>{group.type} · {group.location==='outside'?'范围外':'筛选隐藏'} · {group.visits.length} 条</summary>
        {group.visits.map(visit=>reminder(visit,group.type))}
      </details>)}
    </details>}
  </section>;
}
