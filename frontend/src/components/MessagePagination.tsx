import { useContext, useEffect, useRef, useState, type RefObject } from 'react';
import { WorkbenchDrawingContext } from '../context/WorkbenchDrawingContext';

interface Props {
  parent: string;
  loadedCount: number;
  hasMore: boolean;
  loading: boolean;
  showLoadingNotice?: boolean;
  pagedScope?: boolean;
  panelRef: RefObject<HTMLDivElement>;
  onMore: (parent: string) => Promise<void>;
  onError: (message: string) => void;
}

/** Follow the last mounted message, even when the graph reserves more canvas below it. */
export default function MessagePagination({ parent, loadedCount, hasMore, loading, showLoadingNotice = true, pagedScope = false, panelRef, onMore, onError }: Props) {
  const tasks = useContext(WorkbenchDrawingContext);
  const footerRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const failed = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const mounted = useRef(true);
  const scope = useRef({ parent });
  if (scope.current.parent !== parent) scope.current = { parent };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { failed.current = false; setError(null); }, [parent]);
  useEffect(() => {
    if (!hasMore || loading || !loadedCount) return;
    const panel = panelRef.current;
    const boundary = panel?.querySelector<HTMLElement>('[data-message-window-boundary]') ?? footerRef.current;
    if (!boundary) return;
    let disposed = false;
    let frame = 0;
    const more = () => {
      if (disposed || failed.current || inFlight.current || document.hidden || tasks?.blocking || tasks?.failure) return;
      const promise = onMore(parent);
      const requestedScope = scope.current;
      inFlight.current = promise;
      void promise.catch(error => {
        // Loading/row-count updates replace the observer effect while a body
        // request is pending. Its error still belongs to this mounted scope.
        if (mounted.current && scope.current === requestedScope) { failed.current = true; const message = error instanceof Error ? error.message : '消息加载失败'; setError(message); onError(message); }
      }).finally(() => { if (inFlight.current === promise) inFlight.current = null; });
    };
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = boundary.getBoundingClientRect();
        const panelRect = panel?.getBoundingClientRect();
        const top = Math.max(0, panelRect?.top ?? 0);
        const bottom = Math.min(window.innerHeight, panelRect?.bottom || window.innerHeight);
        // Zero-sized jsdom/hidden containers are not a visible loading boundary.
        if (rect.height > 0 && rect.top <= bottom + 400 && rect.bottom >= top - 400) more();
      });
    };
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) check();
    }, { root: panel, rootMargin: '400px' }) : null;
    observer?.observe(boundary);
    const unsubscribe = tasks?.subscribe(check);
    check();
    window.addEventListener('scroll', check, { passive: true, capture: true });
    window.addEventListener('resize', check, { passive: true });
    document.addEventListener('visibilitychange', check);
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer?.disconnect();
      unsubscribe?.();
      window.removeEventListener('scroll', check, true);
      window.removeEventListener('resize', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [parent, loadedCount, hasMore, loading, panelRef, onMore, onError, retry, tasks]);
  return <>
    <div ref={footerRef} style={{ padding: 16, textAlign: 'center', color: 'var(--ink-94a3b8)', fontSize: 12 }}>
      {pagedScope ? '本页已显示' : '当前已显示'} {loadedCount} 条消息。{hasMore ? '继续浏览将按时间显示后续消息。' : loading ? '' : pagedScope ? '更多关联请使用上方分页。' : '当前范围已全部显示。'}
    </div>
    {(loading && showLoadingNotice || error) && <div data-message-loading-notice style={{ position: 'sticky', bottom: 8, height: 0, zIndex: 26, pointerEvents: 'none' }}>
      <div role={error ? 'alert' : 'status'} aria-live="polite" style={{ position: 'absolute', bottom: 0, left: 12, maxWidth: 'calc(100% - 24px)', padding: '6px 10px',
        borderRadius: 4, background: 'var(--surface-141414)', color: 'var(--ink-94a3b8)', fontSize: 12, pointerEvents: error ? 'auto' : 'none' }}>
        {error ? `消息加载失败：${error}` : '正在加载消息…'}
        {error && <button type="button" onClick={() => { failed.current = false; setError(null); setRetry(value => value + 1); }} style={{ marginLeft: 8 }}>重试加载消息</button>}
      </div>
    </div>}
  </>;
}
