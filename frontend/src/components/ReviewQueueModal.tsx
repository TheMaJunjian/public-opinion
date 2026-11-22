import {useEffect,useState} from 'react';
import {useLocation,useNavigate} from 'react-router-dom';
import {getReviewQueue,setReviewAvailability} from '../api/client';
import PromptModal from './PromptModal';
import {dialogStyles as styles} from './dialogStyles';
import {reviewStatusLabel} from './ModerationContext';

export default function ReviewQueueModal({onClose}:{onClose:()=>void}){
  const navigate=useNavigate(),location=useLocation();
  const [page,setPage]=useState<Awaited<ReturnType<typeof getReviewQueue>>|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function load(before?:string,signal?:AbortSignal){setBusy(true);setError('');try{const next=await getReviewQueue(before,signal);if(!signal?.aborted)setPage(old=>({...next,items:before?[...old?.items??[],...next.items]:next.items}));}catch(e){if(!signal?.aborted)setError(e instanceof Error?e.message:'加载失败');}finally{if(!signal?.aborted)setBusy(false);}}
  useEffect(()=>{const abort=new AbortController();void load(undefined,abort.signal);return()=>abort.abort();},[]);
  return <PromptModal open title="审核队列" hideActions onConfirm={onClose} onCancel={onClose} onClose={onClose} dialogProps={{style:{width:'min(680px, calc(100vw - 24px))'}}} message={<div style={{whiteSpace:'normal'}}>
    <p>所有登录用户都可以在这里查看公开待审核的消息。打开一个版本即可提交审核；有押注时也可发起结算。队列还会显示你自己的内容、参与过的审核和获派的复核任务。</p>
    {page&&<label><input type="checkbox" checked={page.enabled} disabled={busy} onChange={event=>{const enabled=event.target.checked;setBusy(true);void setReviewAvailability(enabled).then(()=>load()).catch(e=>{setError(e.message);setBusy(false);});}}/>参与随机审核</label>}
    <p style={{fontSize:12}}>随机任务会提醒你处理待审消息；在受限复核中，获派任务还提供临时阅读权限。关闭此选项后，仍可主动审核和结算公开内容。</p>
    {page?.eligibility&&<p>可用贡献点 {page.eligibility.available} 点；接收新审核任务至少需要 {page.eligibility.minimumRequired} 点（最低押注与协议费）。{page.eligibility.available<page.eligibility.minimumRequired?'当前点数不足，仍可阅读公开内容。':!page.eligibility.online?'等待前台在线心跳后参与随机分配。':''}</p>}
    {error&&<p role="alert">{error}</p>}
    {page?.items.map(item=><button key={item.caseId} type="button" style={{...styles.button,display:'block',width:'100%',textAlign:'left',marginTop:8,overflowWrap:'anywhere'}} onClick={()=>{if(location.pathname.startsWith('/messages'))window.dispatchEvent(new CustomEvent('gonglun:open-review',{detail:{messageId:item.messageId,revision:item.revision}}));else navigate(`/messages?review=${encodeURIComponent(item.messageId)}&reviewRevision=${item.revision}`);onClose();}}>
      {reviewStatusLabel[item.status]} · {item.author?.name??'受限内容'} · 通过 {item.pass} / 不通过 {item.reject} 点<br/><small>{item.messageId} · 版本 {item.revision}</small>
    </button>)}
    {!busy&&page&&!page.items.length&&<p>暂无待处理内容</p>}{busy&&<p role="status">正在加载…</p>}
    {page?.nextCursor&&<button type="button" disabled={busy} style={styles.button} onClick={()=>void load(page.nextCursor!)}>加载更多</button>}
    <button type="button" disabled={busy} style={{...styles.button,marginTop:12}} onClick={()=>void load()}>刷新列表</button>
  </div>}/>;
}
