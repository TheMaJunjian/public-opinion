import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import {notificationSection,type NotificationFilter,type NotificationItem,type NotificationPage} from '@gonglun/core';
import { getNotifications, markNotificationsSeen, muteNotifications, deleteNotifications } from '../api/client';
import { groupNotifications, notificationPath, notificationTypeLabel, refreshNotifications } from '../data/notifications';
import { Z_INDEX } from '../constants/zIndex';
import MessageReferenceControl from './MessageReferenceControl';

type MainCategory=Exclude<NotificationFilter,'review-revoked'>;
type ReviewSection='review'|'review-revoked';
const categories: Array<[MainCategory,string]> = [['all','全部'],['direct','与我相关'],['following','关注动态'],['review','审核'],['financial','资金与委托']];
const reviewSections: Array<[ReviewSection,string]> = [['review','审核通知'],['review-revoked','任务撤回']];
const taskLabels={pending:'未处理',submitted:'已处理',revoked:'已撤回',expired:'已过期',closed:'已结束'};
const timestamp = (value:string) => new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const delta = (value:number) => `${value>0?'+':''}${value}`;

export default function NotificationPanel({revision,onClose}:{revision:number;onClose:()=>void}) {
  const navigate = useNavigate(), location = useLocation();
  const [category,setCategory] = useState<MainCategory>('all');
  const [reviewSection,setReviewSection] = useState<ReviewSection>('review');
  const filter:NotificationFilter=category==='review'?reviewSection:category;
  const [unread,setUnread] = useState(false);
  const [pending,setPending] = useState(false);
  const queryKey=JSON.stringify([filter,unread,pending]);
  const requestedKey=useRef(queryKey);requestedKey.current=queryKey;
  const [loaded,setLoaded] = useState<{key:string;page:NotificationPage}|null>(null);
  const page=loaded?.page??null,currentPage=loaded?.key===queryKey;
  const [loading,setLoading] = useState(true), [busy,setBusy] = useState(false), [error,setError] = useState<string|null>(null);
  const [showLoading,setShowLoading]=useState(false);
  const [refresh,setRefresh] = useState(0);
  const [expandedTypes,setExpandedTypes] = useState<Record<string,boolean>>({});
  const groupId = useId();
  const panel = useRef<HTMLElement>(null);
  const generation = useRef(0), alive = useRef(true);
  const closeRef = useRef(onClose); closeRef.current=onClose;
  useEffect(() => {
    alive.current=true;
    const previous = document.activeElement as HTMLElement|null;
    panel.current?.querySelector<HTMLButtonElement>('[data-notification-close]')?.focus({preventScroll:true});
    const keydown = (event:KeyboardEvent) => {
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeRef.current();}
      if(event.key==='Tab'){
        const elements = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary,[tabindex="0"]')];
        const first=elements[0],last=elements.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',keydown,true);
    return () => { alive.current=false;generation.current++;document.removeEventListener('keydown',keydown,true);previous?.focus({preventScroll:true}); };
  },[]);
  useEffect(() => {
    const abort = new AbortController(), current=++generation.current;
    setLoading(true); setError(null);
    getNotifications({category:filter,unread,...(pending?{pending:true}:{})},abort.signal).then(result=>{
      if(!abort.signal.aborted&&current===generation.current&&requestedKey.current===queryKey)setLoaded({key:queryKey,page:result});
    })
      .catch(cause=>{if(!abort.signal.aborted&&current===generation.current&&requestedKey.current===queryKey)setError(cause instanceof Error?cause.message:'通知加载失败');})
      .finally(()=>{if(!abort.signal.aborted&&current===generation.current&&requestedKey.current===queryKey)setLoading(false);});
    return () => abort.abort();
  },[filter,unread,pending,queryKey,revision,refresh]);
  useEffect(()=>{
    setShowLoading(false);
    if(!loading)return;
    const timer=setTimeout(()=>setShowLoading(true),180);
    return()=>clearTimeout(timer);
  },[loading,queryKey]);
  const more = async () => {
    if(!currentPage||!page?.nextCursor||loading)return;
    const current=generation.current;
    setLoading(true);setError(null);
    try {
      const next=await getNotifications({category:filter,unread,...(pending?{pending:true}:{}),through:page.through,cursor:page.nextCursor});
      if(current===generation.current&&requestedKey.current===queryKey)setLoaded(previous=>previous?.key===queryKey
        ?{key:queryKey,page:{...next,items:[...previous.page.items,...next.items]}}:previous);
    } catch(cause){if(current===generation.current&&requestedKey.current===queryKey)setError(cause instanceof Error?cause.message:'加载失败');}
    finally{if(current===generation.current&&requestedKey.current===queryKey)setLoading(false);}
  };
  const mutate = useCallback(async (operation:()=>Promise<unknown>)=>{
    setBusy(true);setError(null);
    try{await operation();refreshNotifications();if(alive.current)setRefresh(value=>value+1);}
    catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:'保存失败，请重试');}
    finally{if(alive.current)setBusy(false);}
  },[]);
  const open = (item:NotificationItem) => { if(!currentPage)return;navigate(notificationPath(item,location.pathname,location.search));onClose(); };
  const renderCategory=(key:MainCategory,label:string)=>{
    const unseen=key==='review'?(page?.unseenByCategory?.review??0)+(page?.unseenByCategory?.['review-revoked']??0)
      :key==='all'?0:page?.unseenByCategory?.[key]??0;
    return <button key={key} type="button" aria-label={label} aria-pressed={category===key} onClick={()=>{
      if(key===category)return;
      setCategory(key);
      if(key!=='all'&&(key!=='review'||reviewSection!=='review'))setPending(false);
    }}>{label}
      {!!unseen&&<span> · {unseen} 未查看</span>}
      {key==='review'&&!!page?.pendingReviewCount&&<span> · {page.pendingReviewCount} 未处理</span>}
    </button>;
  };
  const renderItem = (item:NotificationItem) => <article key={item.id} className={`notification-item${item.seenAt?'':' is-unseen'}`} data-notification-id={item.id}>
    <button type="button" className="notification-open" disabled={!currentPage} onClick={()=>open(item)}>
      <span className="notification-item-title">{!item.seenAt&&<span className="notification-dot" aria-label="未查看"/>}{item.actorName} · {item.action}</span>
      {(item.category!=='review'||item.excerpt)&&<span className="notification-excerpt" title={item.excerpt}>{item.excerpt||'查看消息详情'}</span>}
      {item.category!=='review'&&item.targetExcerpt&&item.targetExcerpt!==item.excerpt&&<span className="notification-target" title={item.targetExcerpt}>关联：{item.targetExcerpt}</span>}
      {item.availableDelta!==undefined&&<span className="notification-money">可用 {delta(item.availableDelta)} 点{item.lockedDelta?` · 锁定 ${delta(item.lockedDelta)} 点`:''}</span>}
    </button>
    {item.category==='review'&&<div className="notification-reference">
      <MessageReferenceControl messageId={item.reviewTarget?.messageId??item.targetId} type={item.targetMessageType??'消息'}
        summary={item.targetExcerpt} initialView="summary" wholeMessage={false} disabled={!currentPage} onNavigate={()=>open(item)}/>
    </div>}
    {item.reviewTaskStatus&&<div className="notification-task-state" data-task-status={item.reviewTaskStatus}>
      <span>{item.seenAt?'已查看':'未查看'}</span><span className={item.reviewTaskStatus==='pending'?'notification-task-pending':undefined}>{taskLabels[item.reviewTaskStatus]}</span>
      {item.reviewTaskStatus==='pending'&&item.reviewTaskExpiresAt&&<small>截止 {timestamp(item.reviewTaskExpiresAt)}</small>}
    </div>}
    <div className="notification-item-footer">
    <span className="notification-meta" title={item.reasons.join('；')}>{timestamp(item.createdAt)} · {item.reasons.join('；')}</span>
    <div className="notification-actions">
      {item.reviewTaskStatus==='pending'&&<button disabled={!currentPage} onClick={()=>open(item)}>去审核</button>}
      {!item.seenAt&&<button disabled={busy||!currentPage} onClick={()=>void mutate(()=>markNotificationsSeen({through:page!.through,ids:[item.id]}))}>标为已查看</button>}
      {item.category!=='financial'&&item.kind!=='review-financial'&&<button disabled={busy||!currentPage} onClick={()=>void mutate(()=>muteNotifications(item.targetId,!item.muted))}>{item.muted?'恢复此讨论通知':'静音此讨论'}</button>}
      <button disabled={busy||!currentPage} title="只删除这条通知，保留原消息" onClick={()=>void mutate(()=>deleteNotifications({through:page!.through,ids:[item.id]}))}>删除通知</button>
    </div>
    </div>
  </article>;
  return createPortal(<div className="notification-backdrop" style={{zIndex:Z_INDEX.modal}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section ref={panel} className="notification-panel" role="dialog" aria-modal="true" aria-labelledby="notification-title">
      <header><div><h2 id="notification-title">消息通知</h2><p>{page?`${page.unseenCount} 条未查看 · ${page.pendingReviewCount??0} 条审核未处理`:'正在同步通知'}</p></div>
        <button type="button" data-notification-close data-shortcut-cancel="true" aria-label="关闭通知" onClick={onClose}>✕</button></header>
      <nav aria-label="通知分类">{categories.map(([key,label])=>renderCategory(key,label))}</nav>
      {category==='review'&&<nav className="notification-review-sections" aria-label="审核子分区">{reviewSections.map(([key,label])=><button key={key} type="button" aria-label={label}
        aria-pressed={reviewSection===key} onClick={()=>{if(key!==reviewSection){setReviewSection(key);if(key!=='review')setPending(false);}}}>{label}
        {!!page?.unseenByCategory?.[key]&&<span> · {page.unseenByCategory[key]} 未查看</span>}
        {key==='review'&&!!page?.pendingReviewCount&&<span> · {page.pendingReviewCount} 未处理</span>}
      </button>)}</nav>}
      <div className="notification-toolbar"><label><input type="checkbox" checked={unread} onChange={event=>setUnread(event.target.checked)}/> 仅未查看</label>
        {(filter==='all'||filter==='review')&&<label><input type="checkbox" checked={pending} onChange={event=>setPending(event.target.checked)}/> 仅未处理</label>}
        <button disabled={busy||loading||!currentPage||!page?.items.length} onClick={()=>void mutate(()=>markNotificationsSeen({through:page!.through,category:filter,...(pending?{pending:true}:{})}))}>全部标为已查看</button>
        <button disabled={busy||loading||!currentPage||!page?.items.length||unread||pending} title="保留尚未处理的审核任务" onClick={()=>void mutate(()=>deleteNotifications({through:page!.through,category:filter,seenOnly:true}))}>清除已查看</button></div>
      <div className="notification-loading" role="status">{loading&&showLoading?'正在加载通知…':''}</div>
      {error&&<div className="notification-error" role="alert">{error} <button onClick={()=>setRefresh(value=>value+1)}>重试</button></div>}
      <div className="notification-list" aria-busy={loading||!currentPage&&!error} data-switching={!currentPage&&!error?'true':undefined}>
        {page&&(!error||currentPage)&&groupNotifications(page.items).map(group=>{
          const kind=group[0].kind,withdrawn=notificationSection(group[0])==='review-revoked',key=`${withdrawn?'withdrawn:':''}${kind}`;
          const label=withdrawn&&kind==='review-assigned'?'已结束审核任务':notificationTypeLabel(kind),expanded=expandedTypes[key]??group.length===1;
          const unseen=group.filter(item=>!item.seenAt).length;
          const unhandled=group.filter(item=>item.reviewTaskStatus==='pending').length;
          return <section className="notification-group" key={`${loaded!.key}:${key}`} data-notification-kind={kind} data-notification-section={notificationSection(group[0])} aria-label={`${label}通知`}>
            <button type="button" className="notification-group-toggle" disabled={!currentPage} aria-expanded={expanded} aria-controls={`${groupId}-${key}`}
              onClick={()=>setExpandedTypes(previous=>({...previous,[key]:!expanded}))}>
              <span><span aria-hidden="true">{expanded?'▾':'▸'}</span> {label} · {group.length} 条</span>
              <small>{unseen?`${unseen} 条未查看`:'全部已查看'}{unhandled>0?` · ${unhandled} 条未处理`:''}</small>
            </button>
            {expanded&&<div id={`${groupId}-${key}`} className="notification-group-items">{group.map(renderItem)}</div>}
          </section>;
        })}
        {!loading&&!error&&currentPage&&!page?.items.length&&<div className="notification-empty">{pending?(unread?'暂无未查看且未处理的审核任务':'暂无未处理的审核任务'):unread?'暂时没有未查看的通知':'暂时没有通知'}<p>相关讨论有新进展时，会显示在这里。</p></div>}
        {page?.nextCursor&&<button className="notification-more" disabled={loading||!currentPage} onClick={()=>void more()}>加载更多</button>}
      </div>
      <footer>查看通知不代表处理审核。清除已查看会保留未处理审核；单独删除通知不会结束任务。正文已阅与影响确认分别保存。</footer>
    </section>
  </div>,document.body);
}
