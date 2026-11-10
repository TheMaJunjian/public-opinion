import { lazy, Suspense, useState } from 'react';
import { useNotifications } from '../hooks/useNotifications';
import '../theme/notifications.css';

const NotificationPanel = lazy(() => import('./NotificationPanel'));
export default function NotificationBell({userId}:{userId:string}) {
  const [open,setOpen] = useState(false);
  const {summary,error,revision} = useNotifications(userId);
  return <>
    <button type="button" className="notification-bell" aria-label={`通知，${summary.unseenCount} 条未查看${summary.pendingReviewCount?`，${summary.pendingReviewCount} 条审核未处理`:''}`}
      aria-expanded={open} aria-haspopup="dialog" title={error ? `通知暂未同步：${error}` : '消息通知'} onClick={() => setOpen(value=>!value)}>
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M6 9a6 6 0 0 1 12 0v6l2 3H4l2-3V9Zm4 12h4"/></svg>
      <span>通知</span>
      {summary.unseenCount>0&&<span className="notification-count">{summary.unseenCount>99?'99+':summary.unseenCount}</span>}
      {!!summary.pendingReviewCount&&<span className="notification-pending-count">待审 {summary.pendingReviewCount}</span>}
      {error&&<span aria-hidden="true">!</span>}
    </button>
    {open&&<Suspense fallback={<span role="status">正在打开通知…</span>}><NotificationPanel key={userId} revision={revision} onClose={()=>setOpen(false)}/></Suspense>}
  </>;
}
