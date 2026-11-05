import { useWorkbenchRecords } from './useWorkbenchRecords';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, type NavigateFunction } from 'react-router-dom';
import { api } from '../../api';
import type { ExportData } from '../../api/client';
import type { syncWorkbench } from '../../data/workbench';
import type { CatalogClient } from '../../data/catalogClient';
import type { CatalogData } from '../../data/catalogEngine';
import type { User } from '../../types';
import type { DemoEdge } from '../../utils/modelBridge';
import type { ViewMode } from './types';
import { computeCorrectionVersions, computeEffectiveSuppressedRelIds } from '../../utils/modelBridge';
import { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from '../../utils/workbenchProjection';
import { beginWorkbenchDrawing, beginWorkbenchSync, finishWorkbenchSync } from '../../utils/workbenchActivity';
import type { RelatedTraceContext } from '../../utils/relatedTraceContext';
import { useWorkbenchDrawingTask } from '../../context/WorkbenchDrawingContext';
import { inheritExportCacheReference, loadCachedExport, loadLastExport, loadReferencedExport, saveLastExportPersistent } from '../../utils/exportViewerCache';
import { isZhihuViewingData } from '../../utils/zhihuArchive';
import { prepareExportForViewing } from '../../utils/exportArchive';

export const VIEWER_USERNAME_KEY = 'export-viewer-username';

export interface WorkbenchDataInput {
  user: User | null;
  authLoading: boolean;
  scopeMessageId: string;
  navigate: NavigateFunction;
  viewMode: ViewMode;
}

/** Owns snapshot loading, incremental synchronization and exported-data viewing. */
export function useWorkbenchData({ user, authLoading, scopeMessageId, navigate, viewMode }: WorkbenchDataInput) {
  const records = useWorkbenchRecords();
  const { tagCounts, scope, messages, edges, relations, attentionUsersByTarget, stakeCounts, messageBettorCounts, authorStakes, registeredUsers, setMessages, setEdges, setRelations, setStakeCounts, setMessageBettorCounts, setAuthorStakes } = records;
  const startProjection = useWorkbenchDrawingTask('projection');
  const graphViewRef = useRef(viewMode === 'graph');
  graphViewRef.current = viewMode === 'graph';
  const [loading, setLoading] = useState(true);
  const edgesRef = useRef<DemoEdge[]>([]);
  const [relatedTraceContext, setRelatedTraceContext] = useState<RelatedTraceContext | null>(null);
  const viewMessages = useMemo(() => relatedTraceContext
    ? [...new Map([...relatedTraceContext.messages, ...messages].map(message => [message.id, message])).values()] : messages, [messages, relatedTraceContext]);
  const viewEdges = useMemo(() => relatedTraceContext
    ? [...new Map([...relatedTraceContext.edges, ...edges].map(edge => [edge.id, edge])).values()] : edges, [edges, relatedTraceContext]);
  const viewRelations = useMemo(() => relatedTraceContext
    ? [...new Map([...relatedTraceContext.relations, ...relations].map(relation => [relation.id, relation])).values()] : relations, [relations, relatedTraceContext]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showUnauthenticatedNotice, setShowUnauthenticatedNotice] = useState(false);
  const [showRegistrationGuide, setShowRegistrationGuide] = useState(false);
  const syncRef = useRef<ReturnType<typeof syncWorkbench> | null>(null);
  const [onDemand, setOnDemand] = useState(false);
  const [catalog, setCatalog] = useState<CatalogClient | null>(null);
  const catalogRef = useRef<CatalogClient | null>(null);
  const catalogReadyRef = useRef(false);
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [globalRows, setGlobalRows] = useState<CatalogData['rows']>();
  const publishedCatalog = useRef<CatalogData | null>(null);
  const windowVersion = useRef({ regionId: undefined as string | undefined, sequence: 0 });
  // Optimistic edits and explicitly loaded external context retain their original local semantics.
  const catalogComputationsCurrent = !relatedTraceContext && !!publishedCatalog.current
    && messages === publishedCatalog.current.projected.messages && edges === publishedCatalog.current.projected.edges
    && relations === publishedCatalog.current.projected.relations && stakeCounts === publishedCatalog.current.projected.counts
    && messageBettorCounts === publishedCatalog.current.projected.bettors;
  const ensureMessages = useCallback((ids: string[]) => syncRef.current?.ensureMessages(ids) ?? Promise.reject(new Error('讨论尚未载入')), []);
  const [isPreloaded, setIsPreloaded] = useState(false);
  const [viewerUser, setViewerUser] = useState<User | null>(() => {
    const username = localStorage.getItem(VIEWER_USERNAME_KEY)?.trim();
    return username ? { id: `viewer:${username}`, username, createdAt: '' } : null;
  });
  const displayUser = isPreloaded ? viewerUser : user;
  const correctionVersions = useMemo(() => {
    const invalidCorrectionIds = computeEffectiveSuppressedRelIds(viewEdges, viewMessages, displayUser?.username ?? null);
    return computeCorrectionVersions(viewMessages, viewEdges, invalidCorrectionIds, displayUser?.username ?? null);
  }, [viewMessages, viewEdges, displayUser?.username]);
  useEffect(() => { setRelatedTraceContext(null); }, [scopeMessageId]);
  useEffect(() => { edgesRef.current = viewEdges; }, [viewEdges]);

  // ── Preloaded data (from export viewer) ──
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isViewerRoute = location.pathname === '/viewer';
  const routeExport = (location.state as { exportData?: ExportData })?.exportData ?? null;
  const routeCacheReference = (location.state as { viewerCacheRef?: unknown })?.viewerCacheRef;
  const preloadedLoaded = useRef<ExportData | null>(null);
  const [restoredViewer, setRestoredViewer] = useState<{ key: string; data: ExportData } | null>(null);
  const needsCacheRestore = isViewerRoute && (!routeExport || isZhihuViewingData(routeExport) || routeCacheReference !== undefined)
    && (!routeExport || preloadedLoaded.current !== routeExport);
  const preloadedData = restoredViewer && restoredViewer.key === location.key ? restoredViewer.data : needsCacheRestore ? null : routeExport;
  useEffect(() => {
    if (!needsCacheRestore) return;
    let cancelled = false;
    setLoading(true); setLoadError(null); setIsPreloaded(true);
    void (async () => {
      const cached = routeCacheReference !== undefined ? await loadReferencedExport(routeCacheReference, { sourceOnly: true })
        : routeExport && isZhihuViewingData(routeExport) ? await loadCachedExport(routeExport.zhihu.archiveId, { sourceOnly: true })
        : await loadLastExport({ sourceOnly: true });
      const source = cached ?? routeExport;
      if (!source) throw new Error('没有可恢复的阅览文件，请从“阅览”入口选择 JSON 文件');
      const prepared = await prepareExportForViewing(source);
      if (!cancelled) setRestoredViewer({ key: location.key, data: inheritExportCacheReference(prepared.data, source) });
    })().catch(error => {
      if (!cancelled) { setLoadError(`恢复阅览失败：${error instanceof Error ? error.message : String(error)}`); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [needsCacheRestore, location.key, routeExport, routeCacheReference]);
  const refreshLeaderboard = useCallback(() => {
    if (preloadedData) return Promise.resolve(false);
    return catalogRef.current?.refresh() ?? syncRef.current?.refresh() ?? Promise.reject(new Error('讨论尚未载入'));
  }, [preloadedData]);
  const [loadedExport, setLoadedExport] = useState<ExportData | null>(null);

  /** Publish only after the source or incremental local edit is durable. */
  const persistPreloadedExport = useCallback(async (next: ExportData, options?: { sourceUpdate?: boolean }) => {
    if (!preloadedData) throw new Error('当前未打开阅览文件');
    const origin = locationRef.current;
    const snapshot = archiveToWorkbenchSnapshot(next);
    const projected = projectWorkbenchSnapshot(snapshot);
    if (options) await saveLastExportPersistent(next, loadedExport ?? preloadedData, options);
    else await saveLastExportPersistent(next, loadedExport ?? preloadedData);
    if (!mounted.current || locationRef.current.key !== origin.key || locationRef.current.pathname !== origin.pathname
      || locationRef.current.state?.exportData !== origin.state?.exportData) {
      throw new Error('文件已保存；阅览页面已切换，请重新打开上次阅览');
    }
    preloadedLoaded.current = next;
    setRelatedTraceContext(null);
    setLoadError(null);
    if (graphViewRef.current) beginWorkbenchDrawing();
    records.replace(snapshot, projected);
    setIsPreloaded(true);
    setLoadedExport(next);
    setLoading(false);
    // The durable cache owns reload recovery. Replacing browser history here
    // clones the whole archive and can restart loading, unmounting the canvas.
    setRestoredViewer({ key: origin.key, data: next });
  }, [preloadedData, loadedExport, records.replace]);

  useLayoutEffect(() => {
    if (!preloadedData || preloadedLoaded.current === preloadedData) return;
    const task = startProjection();
    setLoadError(null);
    // Let the drawing dialog paint before converting and laying out a large file.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        task.run(() => {
          try {
            preloadedLoaded.current = preloadedData;
            const snapshot = archiveToWorkbenchSnapshot(preloadedData);
            const projected = projectWorkbenchSnapshot(snapshot);
            const names = [...new Set([...snapshot.users.map(user => user.username), ...projected.messages.map(message => message.author)])]
              .filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN'));
            const savedUsername = localStorage.getItem(VIEWER_USERNAME_KEY);
            const username = preloadedData.view ? preloadedData.view.username
              : preloadedData.viewerUsername !== undefined ? preloadedData.viewerUsername
              : user?.username ?? (savedUsername && names.includes(savedUsername) ? savedUsername : names[0]);
            setViewerUser(username ? snapshot.users.find(user => user.username === username) ?? { id: `viewer:${username}`, username, createdAt: '' } : null);
            setRelatedTraceContext(null);
            setLoadError(null);
            if (graphViewRef.current) beginWorkbenchDrawing();
            records.replace(snapshot, projected);
            setLoading(false);
            setIsPreloaded(true);
            setLoadedExport(preloadedData);
          } catch (error) {
            setLoadError(`阅览文件失败：${error instanceof Error ? error.message : String(error)}`);
            setLoading(false);
          } finally {
            task.complete();
          }
        });
      });
    });
    task.onCancel(() => cancelAnimationFrame(frame));
    return () => { cancelAnimationFrame(frame); task.cancel(); };
  }, [preloadedData, startProjection]);

  const viewerUsers = useMemo(() => {
    if (!isPreloaded) return [];
    const usernames = new Set<string>(registeredUsers.map(user => user.username));
    messages.forEach(message => { if (message.author) usernames.add(message.author); });
    relations.forEach(relation => { if (relation.createdBy?.username) usernames.add(relation.createdBy.username); });
    return [...usernames].sort((a, b) => a.localeCompare(b, 'zh-CN'))
      .map(username => ({ id: `viewer:${username}`, username, createdAt: '' }));
  }, [isPreloaded, messages, relations, registeredUsers]);

  useEffect(() => {
    if (!scopeMessageId || isViewerRoute || preloadedData || authLoading || !user) return;
    setLoading(true);
    setLoadError(null);
    catalogReadyRef.current = false;
    publishedCatalog.current = null;
    windowVersion.current = { regionId: undefined, sequence: 0 };
    setCatalogReady(false); setCatalog(null); setGlobalRows(undefined);
    let cancelled = false;
    let stop: (() => void) | undefined;
    let catalogStarting = false;
    const startCatalog = (regionId?: string) => {
      if (catalogStarting) return;
      catalogStarting = true;
      void import('../../data/catalogClient').then(({ createCatalogClient }) => {
        if (cancelled) return;
        const client = createCatalogClient(user.id, scopeMessageId, {
          onReady({ snapshot, projected, rows }) {
            if (cancelled) return;
            if (snapshot.regionId === windowVersion.current.regionId && snapshot.sequence < windowVersion.current.sequence) {
              catalogRef.current?.catchUp(); return;
            }
            catalogReadyRef.current = true; setCatalogReady(true);
            publishedCatalog.current = { snapshot, projected, rows };
            records.replace(snapshot, projected); setGlobalRows(rows);
            setCatalogVersion(version => version + 1);
            setIsPreloaded(false); setLoading(false); setLoadError(null);
          },
          onProgress(progress) {
            if (cancelled || progress.ready) return;
            catalogReadyRef.current = false; setCatalogReady(false);
            if (progress.error) { setLoadError(progress.error); setLoading(false); }
          },
        }, regionId);
        catalogRef.current = client; setCatalog(client);
        // The first visible model needs all organization and stance records.
        // Do not wait for idle budgets while the workbench is still loading.
        client.prioritize();
      }).catch(error => {
        if (cancelled) return;
        catalogStarting = false;
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoading(false);
      });
    };
    void Promise.all([import('../../data/workbench'), import('../../data/workbenchCache')]).then(([{ syncWorkbench }, { createWorkbenchCache }]) => {
      if (cancelled) return;
      const sync = syncWorkbench({
        parent: scopeMessageId,
        cache: createWorkbenchCache(user.id, scopeMessageId),
        load: api.getWorkbenchSnapshot,
        events: api.subscribeChanges,
        onSyncState: active => { if (active) beginWorkbenchSync(); else finishWorkbenchSync(); },
        onSnapshot(snapshot) {
          windowVersion.current = { regionId: snapshot.regionId, sequence: snapshot.sequence };
          setOnDemand(!!snapshot.windowed);
          if (snapshot.windowed) {
            startCatalog(snapshot.regionId);
            catalogRef.current?.catchUp();
            // A raw record window cannot establish membership, suppression or
            // correction chains. Publish only the complete catalog projection.
            return;
          }
          catalogRef.current?.catchUp();
          if (!catalogReadyRef.current) {
            if (graphViewRef.current) beginWorkbenchDrawing();
            const projected = projectWorkbenchSnapshot(snapshot);
            records.replace(snapshot, projected);
          }
          setIsPreloaded(false);
          setLoading(false);
          setLoadError(null);
        },
        onError(error) { setLoadError(error.message); setLoading(false); },
      });
      syncRef.current = sync;
      const reload = () => { sync.reload(); catalogRef.current?.catchUp(); };
      const invalidateCache = () => {
        setLoading(true); setLoadError(null);
        catalogReadyRef.current = false; setCatalogReady(false);
        sync.reload(); catalogRef.current?.reload();
      };
      const catchUp = () => { sync.catchUp(); catalogRef.current?.catchUp(); };
      const committed = (event: Event) => {
        const pages = (event as CustomEvent<import('../../data/workbench').WorkbenchSnapshot[]>).detail;
        catalogRef.current?.applyCommitted(pages);
        if (!pages.some(page => sync.applyCommitted(page))) sync.reload();
      };
      window.addEventListener('gonglun:reload', reload);
      window.addEventListener('gonglun:invalidate-cache', invalidateCache);
      window.addEventListener('gonglun:catch-up', catchUp);
      window.addEventListener('gonglun:committed', committed);
      const resume = () => { if (!document.hidden) catchUp(); };
      document.addEventListener('visibilitychange', resume);
      window.addEventListener('pageshow', resume);
      window.addEventListener('focus', resume);
      window.addEventListener('online', resume);
      stop = () => {
        window.removeEventListener('gonglun:reload', reload);
        window.removeEventListener('gonglun:invalidate-cache', invalidateCache);
        window.removeEventListener('gonglun:catch-up', catchUp);
        window.removeEventListener('gonglun:committed', committed);
        document.removeEventListener('visibilitychange', resume);
        window.removeEventListener('pageshow', resume);
        window.removeEventListener('focus', resume);
        window.removeEventListener('online', resume);
        if (syncRef.current === sync) syncRef.current = null;
        sync.stop();
      };
    }).catch(error => {
      if (cancelled) return;
      setLoadError(error instanceof Error ? error.message : String(error));
      setLoading(false);
    });
    return () => { cancelled = true; stop?.(); catalogRef.current?.stop(); catalogRef.current = null; };
  }, [scopeMessageId, authLoading, user?.id, preloadedData, isViewerRoute]);

  useEffect(() => {
    if (!isViewerRoute && !authLoading && !preloadedData && !user) {
      navigate('/login', { replace: true });
    }
  }, [authLoading, navigate, preloadedData, user?.username, isViewerRoute]);

  useEffect(() => {
    if (loading || authLoading || loadError || isPreloaded) return;
    if (!user) {
      setShowUnauthenticatedNotice(true);
      return;
    }
    if (localStorage.getItem('registration-guide-pending') === 'true') {
      localStorage.removeItem('registration-guide-pending');
      setShowRegistrationGuide(true);
    }
  }, [authLoading, isPreloaded, loadError, loading, user]);


  return {
    captureTransient: records.captureTransient,
    showSendPreview: records.showSendPreview,
    clearSendPreview: records.clearSendPreview,
    confirmSendPreview: records.confirmSendPreview,
    liveSequence: records.liveSequence,
    liveMessages: records.liveMessages, liveRelations:records.liveRelations,
    captureOptimisticRollback: records.captureOptimisticRollback,
    scope, messages: viewMessages, setMessages, edges: viewEdges, setEdges,
    edgesRef, relations: viewRelations, setRelations, attentionUsersByTarget, loadError, setRelatedTraceContext,
    showUnauthenticatedNotice, setShowUnauthenticatedNotice, showRegistrationGuide, setShowRegistrationGuide, stakeCounts,
    setStakeCounts, messageBettorCounts, setMessageBettorCounts, authorStakes, setAuthorStakes,
    refreshLeaderboard, registeredUsers, isPreloaded, viewerUser, setViewerUser,
    displayUser, correctionVersions, preloadedData, loadedExport, viewerUsers, loading, persistPreloadedExport, isViewerRoute,
    tagCounts,
    onDemand, ensureMessages,
    catalog, catalogReady, catalogVersion, catalogComputationsCurrent,
    globalRows: catalogComputationsCurrent ? globalRows : undefined,
  };
}
