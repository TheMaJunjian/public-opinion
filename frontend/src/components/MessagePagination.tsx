import { useCallback, useEffect, useRef, type RefObject } from 'react';

interface Props {
  parent: string;
  loadedCount: number;
  hasMore: boolean;
  loading: boolean;
  panelRef: RefObject<HTMLDivElement>;
  onMore: (parent: string) => Promise<void>;
  onError: (message: string) => void;
  prefetch?: boolean;
}

/** Prefetch one page per visited scope; further pages follow actual downward scrolling. */
export default function MessagePagination({ parent, loadedCount, hasMore, loading, panelRef, onMore, onError, prefetch = true }: Props) {
  const prefetched = useRef(new Set<string>());
  const inFlight = useRef(false);
  const more = useCallback(async () => {
    if (!hasMore || loading || inFlight.current) return;
    inFlight.current = true;
    try { await onMore(parent); }
    catch (error) { onError(error instanceof Error ? error.message : '消息加载失败'); }
    finally { inFlight.current = false; }
  }, [hasMore, loading, onMore, onError, parent]);

  useEffect(() => {
    if (!prefetch || !hasMore || loading || prefetched.current.has(parent)) return;
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const prefetchPage = () => {
      idle = undefined; timer = undefined;
      if (document.hidden || prefetched.current.has(parent)) return;
      prefetched.current.add(parent);
      void more();
    };
    const schedule = () => {
      if (document.hidden || prefetched.current.has(parent) || idle !== undefined || timer !== undefined) return;
      if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(prefetchPage, { timeout: 1500 });
      else timer = setTimeout(prefetchPage, 600);
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [parent, hasMore, loading, more, prefetch]);

  useEffect(() => {
    if (!hasMore || loading) return;
    const panel = panelRef.current;
    const documentHost = document.scrollingElement ?? document.documentElement;
    const positions = new Map<Element, number>([[documentHost, documentHost.scrollTop], ...(panel ? [[panel, panel.scrollTop] as [Element, number]] : [])]);
    const onScroll = (event: Event) => {
      const host = event.target === panel ? panel : event.target === document || event.target === window ? documentHost : null;
      if (!host) return;
      const previous = positions.get(host) ?? 0;
      positions.set(host, host.scrollTop);
      const height = host.clientHeight || (host === documentHost ? window.innerHeight : 0);
      if (host.scrollTop > previous && height > 0 && host.scrollHeight - host.scrollTop - height < 400) void more();
    };
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [hasMore, loading, more, panelRef]);

  return <div style={{ padding: 16, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
    <div>当前已加载 {loadedCount} 条消息。</div>
    {(hasMore || loading) && <button disabled={loading} onClick={() => { void more(); }}
      style={{ marginTop: 10, padding: '6px 20px', borderRadius: 6, border: '1px solid #475569', background: '#1e293b', color: '#e2e8f0', cursor: 'pointer' }}>
      {loading ? '正在加载消息…' : '加载更多消息'}
    </button>}
  </div>;
}
