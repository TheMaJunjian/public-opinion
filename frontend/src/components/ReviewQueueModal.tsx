import {useEffect,useState} from 'react';
import {useLocation,useNavigate} from 'react-router-dom';
import {getReviewQueue} from '../api/client';
import PromptModal from './PromptModal';
import {dialogStyles as styles} from './dialogStyles';
import {reviewStatusLabel} from './ModerationContext';

export default function ReviewQueueModal({onClose}:{onClose:()=>void}){
  const navigate=useNavigate(),location=useLocation();
  const [page,setPage]=useState<Awaited<ReturnType<typeof getReviewQueue>>|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function load(before?:string,signal?:AbortSignal){setBusy(true);setError('');try{const next=await getReviewQueue(before,signal);if(!signal?.aborted)setPage(old=>({...next,items:before?[...old?.items??[],...next.items]:next.items}));}catch(e){if(!signal?.aborted)setError(e instanceof Error?e.message:'加载失败');}finally{if(!signal?.aborted)setBusy(false);}}
  useEffect(()=>{const abort=new AbortController();void load(undefined,abort.signal);return()=>abort.abort();},[]);
  return <PromptModal open title="审核队列" hideActions onConfirm={onClose} onCancel={onClose} onClose={onClose} dialogProps={{style:{width:'min(680px, calc(100vw - 24px))'}}} message={<div style={{whiteSpace:'normal'}}>
    <p>打开待审版本即可提交审核，已有押注的版本也可以发起结算。</p>
    {error&&<p role="alert">{error}</p>}
    {page?.items.map(item=><button key={item.caseId} type="button" style={{...styles.button,display:'block',width:'100%',textAlign:'left',marginTop:8,overflowWrap:'anywhere'}} onClick={()=>{if(location.pathname.startsWith('/messages'))window.dispatchEvent(new CustomEvent('gonglun:open-review',{detail:{messageId:item.messageId,revision:item.revision}}));else navigate(`/messages?review=${encodeURIComponent(item.messageId)}&reviewRevision=${item.revision}`);onClose();}}>
      {reviewStatusLabel[item.status]} · {item.author?.name??'受限内容'} · 通过 {item.pass} / 不通过 {item.reject} 点<br/><small>{item.messageId} · 版本 {item.revision}</small>
    </button>)}
    {!busy&&page&&!page.items.length&&<p>暂无待处理内容</p>}{busy&&<p role="status">正在加载…</p>}
    {page?.nextCursor&&<button type="button" disabled={busy} style={styles.button} onClick={()=>void load(page.nextCursor!)}>加载更多</button>}
    <button type="button" disabled={busy} style={{...styles.button,marginTop:12}} onClick={()=>void load()}>刷新列表</button>
  </div>}/>;
}
