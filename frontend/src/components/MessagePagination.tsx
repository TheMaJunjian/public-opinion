import { useEffect, useRef, type RefObject } from 'react';

interface Props {
  parent: string;
  loadedCount: number;
  hasMore: boolean;
  loading: boolean;
  panelRef: RefObject<HTMLDivElement>;
  onMore: (parent: string) => Promise<void>;
  onError: (message: string) => void;
}

/** Follow the last mounted structure, even when the full graph reserves more canvas below it. */
export default function MessagePagination({ parent, loadedCount, hasMore, loading, panelRef, onMore, onError }: Props) {
  const footerRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const failed = useRef(false);
  useEffect(() => { failed.current = false; }, [parent]);
  useEffect(() => {
    if (!hasMore || loading || !loadedCount) return;
    const panel = panelRef.current;
    const boundary = panel?.querySelector<HTMLElement>('[data-message-window-boundary]') ?? footerRef.current;
    if (!boundary) return;
    let disposed = false;
    let frame = 0;
    const more = () => {
      if (disposed || failed.current || inFlight.current || document.hidden) return;
      const promise = onMore(parent);
      inFlight.current = promise;
      void promise.catch(error => {
        if (!disposed) { failed.current = true; onError(error instanceof Error ? error.message : '消息加载失败'); }
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
    check();
    window.addEventListener('scroll', check, { passive: true, capture: true });
    window.addEventListener('resize', check, { passive: true });
    document.addEventListener('visibilitychange', check);
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer?.disconnect();
      window.removeEventListener('scroll', check, true);
      window.removeEventListener('resize', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [parent, loadedCount, hasMore, loading, panelRef, onMore, onError]);
  return <div ref={footerRef} style={{ padding: 16, textAlign: 'center', color: 'var(--ink-94a3b8)', fontSize: 12 }}>
    当前已显示 {loadedCount} 条消息。{loading ? '正在准备消息…' : hasMore ? '向下浏览将自动显示后续结构。' : '当前范围已全部显示。'}
  </div>;
}
