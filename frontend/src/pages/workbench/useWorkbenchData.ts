import { useWorkbenchRecords } from './useWorkbenchRecords';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, type NavigateFunction } from 'react-router-dom';
import { flushSync } from 'react-dom';
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
import { inheritExportCacheReference, loadCachedExport, loadLastExport, loadReferencedExport, loadExportNavigation, releaseDurableExportMemory, saveLastExportPersistent, type ExportNavigation } from '../../utils/exportViewerCache';
import { isZhihuViewingData } from '../../utils/zhihuArchive';
import { prepareExportForViewing } from '../../utils/exportArchive';
import { getPreparedViewerExport, releasePreparedViewerExport, type ExportViewerRouteState } from '../../utils/exportViewerSession';
import { createZhihuStructuralViewer, shouldUseZhihuStructuralViewer, structuralScopeKey, type ZhihuStructuralViewer, type ZhihuViewerScope, type StructuralBodyPage } from '../../utils/zhihuStructuralViewer';
import { hydratePagedArchive } from '../../utils/pagedZhihuArchive';
import { useViewCacheSettings } from '../../context/ViewCacheSettingsContext';
import { createScopedProjectionCache } from '../../utils/scopedProjectionCache';
import { hydrateOnlineStructure, onlineSourceSnapshot, onlineStructuralSource } from '../../utils/onlineStructuralSource';
import { startWorkbenchTiming } from '../../utils/workbenchTiming';

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
  const { limit: scopeCacheLimit } = useViewCacheSettings();
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
  const viewerEnsure = useRef<((ids: string[]) => Promise<void>) | null>(null);
  const ensureMessages = useCallback((ids: string[]) => viewerEnsure.current?.(ids)
    ?? syncRef.current?.ensureMessages(ids) ?? Promise.reject(new Error('讨论尚未载入')), []);
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
  const viewerInstanceKey = (location.state as ExportViewerRouteState | null)?.viewerInstanceKey;
  const preparedRouteExport = useMemo(() => getPreparedViewerExport(viewerInstanceKey), [viewerInstanceKey]);
  useEffect(() => { releasePreparedViewerExport(viewerInstanceKey); }, [viewerInstanceKey]);
  const routeExport = preparedRouteExport ?? (location.state as { exportData?: ExportData })?.exportData ?? null;
  const routeCacheReference = (location.state as { viewerCacheRef?: unknown })?.viewerCacheRef;
  const preloadedLoaded = useRef<ExportData | null>(null);
  const [restoredViewer, setRestoredViewer] = useState<{ key: string; data: ExportData; navigation?: ExportNavigation | null } | null>(null);
  const needsCacheRestore = isViewerRoute && !preparedRouteExport && (!routeExport || isZhihuViewingData(routeExport) || routeCacheReference !== undefined)
    && (!routeExport || preloadedLoaded.current !== routeExport);
  const preloadedData = restoredViewer && restoredViewer.key === location.key ? restoredViewer.data : needsCacheRestore ? null : routeExport;
  const viewerNavigation = (restoredViewer && restoredViewer.key === location.key ? restoredViewer.navigation : undefined)
    ?? (location.state as ExportViewerRouteState | null)?.viewerNavigation;
  useEffect(() => {
    if (!needsCacheRestore) return;
    let cancelled = false;
    setLoading(true); setLoadError(null); setIsPreloaded(true);
    void (async () => {
      const cached = routeCacheReference !== undefined ? await loadReferencedExport(routeCacheReference, { sourceOnly: true, paged: true })
        : routeExport && isZhihuViewingData(routeExport) ? await loadCachedExport(routeExport.zhihu.archiveId, { sourceOnly: true })
        : await loadLastExport({ sourceOnly: true, paged: true });
      const source = cached ?? routeExport;
      if (!source) throw new Error('没有可恢复的阅览文件，请从“阅览”入口选择 JSON 文件');
      const prepared = await prepareExportForViewing(source);
      const data = inheritExportCacheReference(prepared.data, source);
      const navigation = await loadExportNavigation(data).catch(() => null);
      if (!cancelled) setRestoredViewer({ key: location.key, data, navigation });
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
  useEffect(() => { if (loadedExport) releaseDurableExportMemory(); }, [loadedExport]);
  const [viewingExport, setViewingExport] = useState<ExportData | null>(null);
  const [viewerStructure, setViewerStructure] = useState<ZhihuStructuralViewer | null>(null);
  const [unloadedViewerContainers, setUnloadedViewerContainers] = useState<ReadonlySet<string>>(new Set());
  const viewerIndex = useRef<ZhihuStructuralViewer | null>(null);
  const viewerScope = useRef<ZhihuViewerScope>({ classificationId: null, viewMode });
  const [viewerBodyPage, setViewerBodyPage] = useState<StructuralBodyPage>();
  const bodyPageRef = useRef<StructuralBodyPage>();
  const bodyPageLimits = useRef(new Map<string, number>());
  const appliedViewerScopeKey = useRef<string | null>(null);
  const [appliedScopeKey, setAppliedScopeKey] = useState<string | null>(null);
  const viewerUsername = useRef(viewerUser?.username ?? null); viewerUsername.current = viewerUser?.username ?? null;
  const viewerScopeGeneration = useRef(0);
  const cancelViewerScope = useRef<(() => void) | null>(null);
  type ScopedProjection = { index: ZhihuStructuralViewer | null; window: ReturnType<ZhihuStructuralViewer['window']>; snapshot: import('../../data/workbench').WorkbenchSnapshot; projected: ReturnType<typeof projectWorkbenchSnapshot> };
  const projectionCache = useRef(createScopedProjectionCache<ScopedProjection>());
  const projectViewer = async (source: ExportData, scope: ZhihuViewerScope, username: string | null, signal?: AbortSignal, bodyLimit?: number) => {
    projectionCache.current.select(source, username);
    const key = structuralScopeKey(scope), cached = projectionCache.current.get(key);
    const pageKey = structuralScopeKey({ ...scope, pinnedIds: undefined });
    const requestedLimit = bodyLimit ?? bodyPageLimits.current.get(pageKey) ?? 20;
    if (cached && (!cached.window.bodyPage?.hasMore || cached.window.bodyPage.limit >= requestedLimit)) return cached;
    const previous = viewerIndex.current;
    const online = onlineSourceSnapshot(source);
    const finishStructure = startWorkbenchTiming('structure-window');
    const index = online || shouldUseZhihuStructuralViewer(source)
      ? previous?.source === source && previous.username === username ? previous : createZhihuStructuralViewer(source, username,
        online ? selected => hydrateOnlineStructure(source, selected) : undefined)
      : null;
    const selected = index?.window(scope, online ? requestedLimit : undefined) ?? { data: source, unloadedContainers: new Set<string>() };
    finishStructure();
    const window = { ...selected, data: online ? await hydrateOnlineStructure(source, selected.data, signal) : await hydratePagedArchive(source, selected.data, signal) };
    signal?.throwIfAborted();
    const finishProjection = startWorkbenchTiming('projection');
    const snapshot = { ...archiveToWorkbenchSnapshot(window.data), ...(online ? { sequence: online.sequence, regionId: online.regionId } : {}) };
    const value = { index, window, snapshot, projected: projectWorkbenchSnapshot(snapshot, { loadedOnly: !!index && !scope.full }) };
    if (!scope.full && projectionCache.current.isCurrent(source, username)) projectionCache.current.put(key, value, snapshot.messages.reduce((bytes, row) => bytes + 1024 + row.content.length * 4, 0), scopeCacheLimit);
    finishProjection();
    return value;
  };
  const publishViewer = (value: Awaited<ReturnType<typeof projectViewer>>) => {
    viewerIndex.current = value.index;
    setViewerStructure(value.index);
    setViewingExport(value.window.data);
    setUnloadedViewerContainers(value.window.unloadedContainers);
    appliedViewerScopeKey.current = structuralScopeKey(viewerScope.current);
    setAppliedScopeKey(appliedViewerScopeKey.current);
    bodyPageRef.current = value.window.bodyPage;
    setViewerBodyPage(value.window.bodyPage);
    if (value.window.bodyPage) {
      const pageKey = structuralScopeKey({ ...viewerScope.current, pinnedIds: undefined });
      bodyPageLimits.current.delete(pageKey);
      bodyPageLimits.current.set(pageKey, value.window.bodyPage.limit);
      while (bodyPageLimits.current.size > scopeCacheLimit) bodyPageLimits.current.delete(bodyPageLimits.current.keys().next().value!);
    }
    records.replace(value.snapshot, value.projected);
    if (value.index && onlineSourceSnapshot(value.index.source)) {
      if (publishedCatalog.current) publishedCatalog.current = { ...publishedCatalog.current, projected: value.projected };
      catalogReadyRef.current = true; setCatalogReady(true); setCatalogVersion(version => version + 1);
      setOnDemand(true); setIsPreloaded(false); setLoading(false); setLoadError(null);
    }
  };
  const loadViewerScope = useCallback(async (scope: ZhihuViewerScope, bodyLimit?: number) => {
    const index = viewerIndex.current;
    if (!index) return;
    const username = onlineSourceSnapshot(index.source) ? user?.username ?? null : viewerUsername.current;
    cancelViewerScope.current?.();
    viewerScope.current = scope;
    const generation = ++viewerScopeGeneration.current;
    if (bodyLimit === undefined && structuralScopeKey(scope) === appliedViewerScopeKey.current && index.username === username) return;
    const task = startProjection();
    const controller = new AbortController();
    await new Promise<void>((resolve, reject) => {
      let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
        if (!mounted.current || generation !== viewerScopeGeneration.current) { task.cancel(); resolve(); return; }
        task.run(async () => {
          try {
            const next = await projectViewer(index.source, scope, username, controller.signal, bodyLimit);
            if (!mounted.current || generation !== viewerScopeGeneration.current) { resolve(); return; }
            if (graphViewRef.current) beginWorkbenchDrawing();
            // A parked scene suspends its old tree. Commit the bounded scope and
            // its readiness ticket together so React cannot keep replaying the
            // async update against that suspended tree during navigation.
            flushSync(() => { publishViewer(next); task.complete(); });
            resolve();
          } catch (error) {
            if (controller.signal.aborted) resolve();
            else if (onlineSourceSnapshot(index.source) && (error as {status?: number}).status === 409) {
              if ((error as { reloadCatalog?: boolean }).reloadCatalog) catalogRef.current?.reload();
              else catalogRef.current?.catchUp();
              appliedViewerScopeKey.current = null; resolve();
            }
            else reject(error);
          }
          finally { if (generation === viewerScopeGeneration.current) cancelViewerScope.current = null; task.complete(); }
        });
      }); });
      cancelViewerScope.current = () => { controller.abort(); cancelAnimationFrame(frame); task.cancel(); resolve(); };
      task.onCancel(() => { controller.abort(); cancelAnimationFrame(frame); resolve(); });
    });
  }, [viewerUser?.username, user?.username, startProjection, records.replace, scopeCacheLimit]);
  const loadMoreViewerBodies = useCallback(async () => {
    const page = bodyPageRef.current;
    if (page?.hasMore) await loadViewerScope(viewerScope.current, page.limit + 50);
  }, [loadViewerScope]);
  viewerEnsure.current = viewerStructure ? async ids => {
    if (ids.some(id => !viewerIndex.current?.has(id))) throw new Error(isViewerRoute ? '这份阅览文件中没有该消息' : '未找到该消息，消息可能已删除或不在当前可访问范围内');
    await loadViewerScope({ ...viewerScope.current, extraIds: [...new Set([...viewerScope.current.extraIds ?? [], ...ids])] });
  } : null;
  useEffect(() => () => { viewerScopeGeneration.current++; cancelViewerScope.current?.(); }, []);

  /** Publish only after the source or incremental local edit is durable. */
  const persistPreloadedExport = useCallback(async (next: ExportData, options?: { sourceUpdate?: boolean }) => {
    if (!preloadedData) throw new Error('当前未打开阅览文件');
    const origin = locationRef.current;
    let preparedScopeKey = structuralScopeKey(viewerScope.current), preparedUsername = viewerUsername.current;
    let projection = await projectViewer(next, viewerScope.current, preparedUsername);
    if (options) await saveLastExportPersistent(next, loadedExport ?? preloadedData, options);
    else await saveLastExportPersistent(next, loadedExport ?? preloadedData);
    if (!mounted.current || locationRef.current.key !== origin.key || locationRef.current.pathname !== origin.pathname
      || locationRef.current.state?.exportData !== origin.state?.exportData) {
      throw new Error('文件已保存；阅览页面已切换，请重新打开上次阅览');
    }
    // Synchronization can finish after category navigation. Publish the new
    // revision in the latest requested layer, never the layer at save start.
    while (preparedScopeKey !== structuralScopeKey(viewerScope.current) || preparedUsername !== viewerUsername.current) {
      preparedScopeKey = structuralScopeKey(viewerScope.current); preparedUsername = viewerUsername.current;
      projection = await projectViewer(next, viewerScope.current, viewerUsername.current);
      if (!mounted.current || locationRef.current.key !== origin.key || locationRef.current.pathname !== origin.pathname)
        throw new Error('文件已保存；阅览页面已切换，请重新打开上次阅览');
    }
    preloadedLoaded.current = next;
    viewerScopeGeneration.current++;
    cancelViewerScope.current?.();
    setRelatedTraceContext(null);
    setLoadError(null);
    if (graphViewRef.current) beginWorkbenchDrawing();
    publishViewer(projection);
    setIsPreloaded(true);
    setLoadedExport(next);
    setLoading(false);
    // The durable cache owns reload recovery. Replacing browser history here
    // clones the whole archive and can restart loading, unmounting the canvas.
    setRestoredViewer({ key: origin.key, data: next });
  }, [preloadedData, loadedExport, viewerUser?.username, records.replace]);

  useLayoutEffect(() => {
    if (!preloadedData || preloadedLoaded.current === preloadedData) return;
    const task = startProjection();
    const controller = new AbortController();
    setLoadError(null);
    // Let the drawing dialog paint before converting and laying out a large file.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        task.run(async () => {
          try {
            const names = [...new Set([...(preloadedData.users ?? []).map(user => user.username), ...preloadedData.messages.map(message => message.author)])]
              .filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN'));
            const savedUsername = localStorage.getItem(VIEWER_USERNAME_KEY);
            const username = preloadedData.view ? preloadedData.view.username
              : preloadedData.viewerUsername !== undefined ? preloadedData.viewerUsername
              : user?.username ?? (savedUsername && names.includes(savedUsername) ? savedUsername : names[0]);
            viewerScope.current = { classificationId: viewerNavigation ? viewerNavigation.classificationId : preloadedData.view?.classificationId ?? null,
              full: !!preloadedData.view?.homeFilter || !!preloadedData.view?.cleanFilters.length,
              includeJoinRecords: preloadedData.view?.messageFilter.hideJoin === false };
            const projection = await projectViewer(preloadedData, viewerScope.current, username ?? null, controller.signal);
            if (controller.signal.aborted || !mounted.current) return;
            preloadedLoaded.current = preloadedData;
            setViewerUser(username ? projection.snapshot.users.find(user => user.username === username) ?? { id: `viewer:${username}`, username, createdAt: '' } : null);
            setRelatedTraceContext(null);
            setLoadError(null);
            if (graphViewRef.current) beginWorkbenchDrawing();
            publishViewer(projection);
            setLoading(false);
            setIsPreloaded(true);
            setLoadedExport(preloadedData);
          } catch (error) {
            if (controller.signal.aborted) return;
            setLoadError(`阅览文件失败：${error instanceof Error ? error.message : String(error)}`);
            setLoading(false);
          } finally {
            task.complete();
          }
        });
      });
    });
    task.onCancel(() => { controller.abort(); cancelAnimationFrame(frame); });
    return () => { controller.abort(); cancelAnimationFrame(frame); task.cancel(); };
  }, [preloadedData, startProjection]);

  // A collapsed category must not hide its authors from the viewer selector.
  // This cheap source metadata is collected once per revision, not per layer.
  const sourceViewerUsernames = useMemo(() => new Set(loadedExport?.messages.map(message => message.author)), [loadedExport]);
  const viewerUsers = useMemo(() => {
    if (!isPreloaded) return [];
    const usernames = new Set<string>(registeredUsers.map(user => user.username));
    sourceViewerUsernames.forEach(username => { if (username) usernames.add(username); });
    messages.forEach(message => { if (message.author) usernames.add(message.author); });
    relations.forEach(relation => { if (relation.createdBy?.username) usernames.add(relation.createdBy.username); });
    return [...usernames].sort((a, b) => a.localeCompare(b, 'zh-CN'))
      .map(username => ({ id: `viewer:${username}`, username, createdAt: '' }));
  }, [isPreloaded, messages, relations, registeredUsers, sourceViewerUsernames]);

  useEffect(() => {
    if (!scopeMessageId || isViewerRoute || preloadedData || authLoading || !user) return;
    setLoading(true);
    setLoadError(null);
    viewerScopeGeneration.current++;
    cancelViewerScope.current?.(); cancelViewerScope.current = null;
    viewerIndex.current = null; appliedViewerScopeKey.current = null;
    bodyPageLimits.current.clear(); bodyPageRef.current = undefined; setViewerBodyPage(undefined);
    setViewerStructure(null); setAppliedScopeKey(null); setViewingExport(null);
    catalogReadyRef.current = false;
    publishedCatalog.current = null;
    windowVersion.current = { regionId: undefined, sequence: 0 };
    setCatalogReady(false); setCatalog(null); setGlobalRows(undefined);
    let cancelled = false;
    let stop: (() => void) | undefined;
    let catalogStarting = false;
    let bodySeed: import('../../data/workbench').WorkbenchSnapshot | undefined;
    const startCatalog = (regionId?: string) => {
      if (catalogStarting) return;
      catalogStarting = true;
      void import('../../data/catalogClient').then(({ createCatalogClient }) => {
        if (cancelled) return;
        const client = createCatalogClient(user.id, scopeMessageId, {
          onReady(data) {
            const { snapshot, projected, rows, index } = data;
            if (cancelled) return;
            if (snapshot.regionId === windowVersion.current.regionId && snapshot.sequence < windowVersion.current.sequence) {
              catalogRef.current?.catchUp(); return;
            }
            if (index) {
              const source = onlineStructuralSource(index, api.getWorkbenchSnapshot, bodySeed,
                { identity: user.id, previous: viewerIndex.current?.source, update: data.update });
              bodySeed = undefined;
              viewerIndex.current = createZhihuStructuralViewer(source, user.username, selected => hydrateOnlineStructure(source, selected));
              publishedCatalog.current = data;
              appliedViewerScopeKey.current = null;
              void loadViewerScope(viewerScope.current).catch(error => {
                if (!cancelled) { setLoadError(error instanceof Error ? error.message : String(error)); setLoading(false); }
              });
              return;
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
    // Fetch the worker module while the initial window request is in flight.
    void import('../../data/catalogClient').catch(() => {});
    void Promise.all([import('../../data/workbench'), import('../../data/workbenchCache')]).then(([{ syncWorkbench }, { createWorkbenchCache }]) => {
      if (cancelled) return;
      const sync = syncWorkbench({
        parent: scopeMessageId,
        cache: createWorkbenchCache(user.id, scopeMessageId),
        load: async query => {
          const snapshot = await api.getWorkbenchSnapshot(query);
          // Begin the required index as soon as a window arrives, while its
          // delta is still in flight. Full snapshots keep their existing path.
          if (!cancelled && snapshot.windowed) {
            if (query.after === undefined) bodySeed = snapshot;
            startCatalog(snapshot.regionId);
          }
          return snapshot;
        },
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
    return () => {
      cancelled = true; viewerScopeGeneration.current++; cancelViewerScope.current?.(); cancelViewerScope.current = null;
      stop?.(); catalogRef.current?.stop(); catalogRef.current = null;
    };
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
    sendPreviewPages: records.sendPreviewPages, sendPreviewMessageIds: records.sendPreviewMessageIds,
    liveSequence: records.liveSequence,
    liveMessages: records.liveMessages, liveRelations:records.liveRelations,
    captureOptimisticRollback: records.captureOptimisticRollback,
    scope, messages: viewMessages, setMessages, edges: viewEdges, setEdges,
    edgesRef, relations: viewRelations, setRelations, attentionUsersByTarget, loadError, setRelatedTraceContext,
    showUnauthenticatedNotice, setShowUnauthenticatedNotice, showRegistrationGuide, setShowRegistrationGuide, stakeCounts,
    setStakeCounts, messageBettorCounts, setMessageBettorCounts, authorStakes, setAuthorStakes,
    refreshLeaderboard, registeredUsers, isPreloaded, viewerUser, setViewerUser,
    displayUser, correctionVersions, preloadedData, loadedExport, viewerUsers, loading, persistPreloadedExport, isViewerRoute,
    viewerNavigation,
    viewingExport, viewerStructure, unloadedViewerContainers, loadViewerScope, viewerBodyPage, loadMoreViewerBodies,
    appliedScopeKey,
    tagCounts,
    onDemand, ensureMessages,
    catalog, catalogReady, catalogVersion, catalogComputationsCurrent,
    globalRows: catalogComputationsCurrent ? globalRows : undefined,
  };
}
