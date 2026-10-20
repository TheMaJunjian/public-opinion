import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function LeaderboardRefreshButton({ onRefresh }: { onRefresh: () => void | Promise<boolean> }) {
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; clearTimeout(timer.current); };
  }, []);

  const refresh = async () => {
    if (pending.current) return;
    pending.current = true;
    clearTimeout(timer.current);
    setNotice('');
    setRefreshing(true);
    try {
      const changed = await onRefresh();
      if (active.current) setNotice(changed === false ? '刷新完成，暂无新变化' : '刷新完成，已更新最新数据');
    } catch {
      if (active.current) setNotice('刷新失败，请稍后重试');
    } finally {
      pending.current = false;
      if (active.current) {
        setRefreshing(false);
        timer.current = setTimeout(() => setNotice(''), 1500);
      }
    }
  };

  return <>
    <button onClick={refresh} disabled={refreshing}
      style={{ border: '1px solid #475569', background: '#1e293b', color: '#cbd5e1', borderRadius: 6, padding: '2px 8px', cursor: refreshing ? 'default' : 'pointer', fontSize: 12 }}
      title="检查并同步最新变化">
      {refreshing ? '刷新中…' : '刷新'}
    </button>
    {notice && createPortal(<div role="status" aria-label="排行榜刷新提示" style={{
      position: 'fixed', top: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 1600,
      background: '#1e293b', color: '#e2e8f0', border: '1px solid #475569', borderRadius: 8,
      padding: '10px 18px', boxShadow: '0 4px 18px #0006', pointerEvents: 'none', fontSize: 13,
    }}>{notice}</div>, document.body)}
  </>;
}
