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
    <p>这里显示你的内容、已参与的审核和随机分配的任务。已登录且能阅读对应版本就能审核，包括作者；无需等待随机分配。随机任务仅提供提醒和受限正文的临时阅读权限。</p>
    {page&&<label><input type="checkbox" checked={page.enabled} disabled={busy} onChange={event=>{const enabled=event.target.checked;setBusy(true);void setReviewAvailability(enabled).then(()=>load()).catch(e=>{setError(e.message);setBusy(false);});}}/>参与随机审核</label>}
    <p style={{fontSize:12}}>系统从当前在线、账号正常且贡献点足够的候选用户中随机抽取，排除内容作者。页面在前台时每 30 秒更新在线状态，最近 2 分钟在线才可接收新任务。离线后已有任务仍按 30 分钟期限处理；关闭参与后不再接收新任务，已提交的审核保留。</p>
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
