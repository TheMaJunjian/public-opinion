import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import type { NotificationFilter, NotificationItem, NotificationPage } from '@gonglun/core';
import { getNotifications, markNotificationsSeen, muteNotifications, deleteNotifications } from '../api/client';
import { groupNotifications, notificationPath, notificationTypeLabel, refreshNotifications } from '../data/notifications';
import { Z_INDEX } from '../constants/zIndex';

const categories: Array<[NotificationFilter,string]> = [['all','全部'],['direct','与我相关'],['following','关注动态'],['financial','资金与委托']];
const timestamp = (value:string) => new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const delta = (value:number) => `${value>0?'+':''}${value}`;

export default function NotificationPanel({revision,onClose}:{revision:number;onClose:()=>void}) {
  const navigate = useNavigate(), location = useLocation();
  const [category,setCategory] = useState<NotificationFilter>('all');
  const [unread,setUnread] = useState(false);
  const [page,setPage] = useState<NotificationPage|null>(null);
  const [loading,setLoading] = useState(true), [busy,setBusy] = useState(false), [error,setError] = useState<string|null>(null);
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
    getNotifications({category,unread},abort.signal).then(result=>{if(current===generation.current)setPage(result);})
      .catch(cause=>{if(!abort.signal.aborted&&current===generation.current)setError(cause instanceof Error?cause.message:'通知加载失败');})
      .finally(()=>{if(current===generation.current)setLoading(false);});
    return () => abort.abort();
  },[category,unread,revision,refresh]);
  const more = async () => {
    if(!page?.nextCursor||loading)return;
    const current=generation.current;
    setLoading(true);setError(null);
    try {
      const next=await getNotifications({category,unread,through:page.through,cursor:page.nextCursor});
      if(current===generation.current)setPage(previous=>previous?{...next,items:[...previous.items,...next.items]}:next);
    } catch(cause){if(current===generation.current)setError(cause instanceof Error?cause.message:'加载失败');}
    finally{if(current===generation.current)setLoading(false);}
  };
  const mutate = useCallback(async (operation:()=>Promise<unknown>)=>{
    setBusy(true);setError(null);
    try{await operation();refreshNotifications();if(alive.current)setRefresh(value=>value+1);}
    catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:'保存失败，请重试');}
    finally{if(alive.current)setBusy(false);}
  },[]);
  const open = (item:NotificationItem) => { navigate(notificationPath(item,location.pathname,location.search));onClose(); };
  const renderItem = (item:NotificationItem) => <article key={item.id} className={`notification-item${item.seenAt?'':' is-unseen'}`} data-notification-id={item.id}>
    <button type="button" className="notification-open" onClick={()=>open(item)}>
      <span className="notification-item-title">{!item.seenAt&&<span className="notification-dot" aria-label="未查看"/>}{item.actorName} · {item.action}</span>
      <span className="notification-excerpt" title={item.excerpt}>{item.excerpt||'查看消息详情'}</span>
      {item.targetExcerpt&&item.targetExcerpt!==item.excerpt&&<span className="notification-target" title={item.targetExcerpt}>关联：{item.targetExcerpt}</span>}
      {item.availableDelta!==undefined&&<span className="notification-money">可用 {delta(item.availableDelta)} 点{item.lockedDelta?` · 锁定 ${delta(item.lockedDelta)} 点`:''}</span>}
    </button>
    <div className="notification-item-footer">
    <span className="notification-meta" title={item.reasons.join('；')}>{timestamp(item.createdAt)} · {item.reasons.join('；')}</span>
    <div className="notification-actions">
      {!item.seenAt&&<button disabled={busy} onClick={()=>void mutate(()=>markNotificationsSeen({through:page!.through,ids:[item.id]}))}>标为已查看</button>}
      {item.category!=='financial'&&<button disabled={busy} onClick={()=>void mutate(()=>muteNotifications(item.targetId,!item.muted))}>{item.muted?'恢复此讨论通知':'静音此讨论'}</button>}
      <button disabled={busy} title="只删除这条通知，保留原消息" onClick={()=>void mutate(()=>deleteNotifications({through:page!.through,ids:[item.id]}))}>删除通知</button>
    </div>
    </div>
  </article>;
  return createPortal(<div className="notification-backdrop" style={{zIndex:Z_INDEX.modal}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section ref={panel} className="notification-panel" role="dialog" aria-modal="true" aria-labelledby="notification-title">
      <header><div><h2 id="notification-title">消息通知</h2><p>{page?`${page.unseenCount} 条未查看`:'正在同步通知'}</p></div>
        <button type="button" data-notification-close data-shortcut-cancel="true" aria-label="关闭通知" onClick={onClose}>✕</button></header>
      <nav aria-label="通知分类">{categories.map(([key,label])=><button key={key} type="button" aria-pressed={category===key} onClick={()=>{if(key!==category){setPage(null);setCategory(key);}}}>{label}</button>)}</nav>
      <div className="notification-toolbar"><label><input type="checkbox" checked={unread} onChange={event=>{setPage(null);setUnread(event.target.checked);}}/> 仅未查看</label>
        <button disabled={busy||loading||!page?.items.length} onClick={()=>void mutate(()=>markNotificationsSeen({through:page!.through,category}))}>全部标为已查看</button>
        <button disabled={busy||loading||!page?.items.length||unread} onClick={()=>void mutate(()=>deleteNotifications({through:page!.through,category,seenOnly:true}))}>清除已查看</button></div>
      {error&&<div className="notification-error" role="alert">{error} <button onClick={()=>setRefresh(value=>value+1)}>重试</button></div>}
      <div className="notification-list" aria-busy={loading}>
        {page&&groupNotifications(page.items).map(group=>{
          const kind=group[0].kind,label=notificationTypeLabel(kind),expanded=expandedTypes[kind]??group.length===1;
          const unseen=group.filter(item=>!item.seenAt).length;
          return <section className="notification-group" key={kind} data-notification-kind={kind} aria-label={`${label}通知`}>
            <button type="button" className="notification-group-toggle" aria-expanded={expanded} aria-controls={`${groupId}-${kind}`}
              onClick={()=>setExpandedTypes(previous=>({...previous,[kind]:!expanded}))}>
              <span><span aria-hidden="true">{expanded?'▾':'▸'}</span> {label} · {group.length} 条</span>
              <small>{unseen?`${unseen} 条未查看`:'全部已查看'}</small>
            </button>
            {expanded&&<div id={`${groupId}-${kind}`} className="notification-group-items">{group.map(renderItem)}</div>}
          </section>;
        })}
        {!loading&&!error&&!page?.items.length&&<div className="notification-empty">{unread?'暂时没有未查看的通知':'暂时没有通知'}<p>相关讨论有新进展时，会显示在这里。</p></div>}
        {loading&&<p className="notification-status" role="status">正在加载通知…</p>}
        {page?.nextCursor&&!loading&&<button className="notification-more" onClick={()=>void more()}>加载更多</button>}
      </div>
      <footer>删除通知不会删除原消息。通知查看、正文已阅与影响确认分别保存。</footer>
    </section>
  </div>,document.body);
}
