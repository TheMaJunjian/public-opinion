import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import PromptModal from './PromptModal';
import type { LeaderboardModalProps } from './LeaderboardModal';
import ErrorBoundary from './ErrorBoundary';
import type { CatalogClient } from '../data/catalogClient';

const LeaderboardModal = lazy(() => import('./LeaderboardModal'));
const CatalogStatus = lazy(() => import('./CatalogStatus'));

export interface LeaderboardHandle {
  open: () => void;
}

// This signal only commits when the suspended module and its window have both mounted.
function Opened({ open, onReady }: { open: boolean; onReady: () => void }) {
  useLayoutEffect(() => { if (open) onReady(); }, [open, onReady]);
  return null;
}

// Local open state prevents opening and closing the leaderboard from redrawing the workbench.
export default forwardRef<LeaderboardHandle, Omit<LeaderboardModalProps, 'open' | 'onClose'> & {
  catalog?: CatalogClient | null; globalReady?: boolean; catalogVersion?: number; useCatalogRows?: boolean;
}>(function LeaderboardController({ catalog, globalReady = true, catalogVersion = 0, useCatalogRows = true, ...props }, ref) {
  const [initialized, setInitialized] = useState(false);
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const requested = useRef(false);
  const ready = useRef(false);
  type Rows = NonNullable<LeaderboardModalProps['globalRows']>;
  const [remoteRows, setRemoteRows] = useState<{ client: CatalogClient; version: number; rows: Rows } | null>(null);
  const cachedRows = useRef(remoteRows); cachedRows.current = remoteRows;
  const needsRows = !!catalog && useCatalogRows && !props.globalRows;
  const rows = needsRows ? remoteRows?.client === catalog ? remoteRows.rows : undefined : props.globalRows;
  const close = useCallback(() => {
    requested.current = false;
    setOpen(false);
    setOpening(false);
    setFailed(false);
    // Cancel an unfinished first load; completed leaderboards retain their cached statistics.
    if (!ready.current) setInitialized(false);
  }, []);
  const onReady = useCallback(() => { ready.current = true; setOpening(false); }, []);
  const onError = useCallback(() => {
    requested.current = false;
    ready.current = false;
    setOpen(false);
    setInitialized(false);
    setOpening(false);
    setFailed(true);
  }, []);
  useImperativeHandle(ref, () => ({ open: () => {
    if (requested.current) return;
    requested.current = true;
    setFailed(false);
    setOpening(true);
  } }), []);

  useEffect(() => {
    if (!opening && !open) return;
    if (!globalReady) { catalog?.prioritize(); return; }
    const cached = cachedRows.current;
    const current = cached?.client === catalog && cached?.version === catalogVersion;
    if (!opening && (!needsRows || current)) return;
    let cancelled = false;
    const prepare = async () => {
      try {
        if (needsRows && catalog && !current) {
          const rows = await catalog.leaderboard();
          if (cancelled || !requested.current) return;
          setRemoteRows({ client: catalog, version: catalogVersion, rows });
        }
        if (cancelled || !requested.current) return;
        setInitialized(true); setOpen(true);
      } catch { if (!cancelled && requested.current) onError(); }
    };
    // Paint the lightweight feedback before importing, computing or laying out the leaderboard.
    let frame = 0;
    if (opening) {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => { if (!cancelled) void prepare(); });
      });
    } else void prepare();
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [opening, open, globalReady, catalog, catalogVersion, needsRows, onError]);

  return <>
    {initialized && globalReady && (!needsRows || rows) && <ErrorBoundary onError={onError}>
      <Suspense fallback={null}>
        <LeaderboardModal {...props} globalRows={rows} open={open} onClose={close} />
        <Opened open={open} onReady={onReady} />
      </Suspense>
    </ErrorBoundary>}
    <PromptModal open={opening || failed || (open && !globalReady)} title={failed ? '排行榜打开失败' : '正在打开排行榜'}
      confirmText={failed ? '关闭' : '取消'} onConfirm={close} zIndex={1600} lockScroll={false}
      dialogProps={{ 'aria-busy': opening }} message={<>
        <div role={failed ? 'alert' : 'status'} aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14 }}>
          {!failed && <span aria-hidden="true" style={{ display: 'inline-block', width: 22, height: 22, border: '2px solid var(--line-334155)',
            borderTopColor: 'var(--line-38bdf8)', borderRadius: '50%', animation: 'leaderboard-opening-spin 0.8s linear infinite', willChange: 'transform' }} />}
          {failed ? '排行榜暂时无法打开，请刷新页面后重试。' : globalReady ? '正在打开排行榜…' : '正在准备全局排行榜…'}
        </div>
        {!globalReady && catalog && <Suspense fallback={null}><CatalogStatus client={catalog} /></Suspense>}
      <style>{'@keyframes leaderboard-opening-spin { to { transform: rotate(360deg); } }'}</style>
      </>} />
  </>;
});
