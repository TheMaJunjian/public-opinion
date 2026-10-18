import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, type NavigateFunction } from 'react-router-dom';
import { api } from '../../api';
import type { ExportData } from '../../api/client';
import { syncWorkbench } from '../../data/workbench';
import type { Relation, ScopeView, User } from '../../types';
import type { DemoEdge, DemoMessage } from '../../utils/modelBridge';
import type { ViewMode } from './types';
import { computeCorrectionVersions, computeEffectiveSuppressedRelIds } from '../../utils/modelBridge';
import { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from '../../utils/workbenchProjection';
import { beginWorkbenchDrawing, beginWorkbenchSync, finishWorkbenchSync } from '../../utils/workbenchActivity';
import type { RelatedTraceContext } from '../../utils/relatedTraceContext';
import { useWorkbenchDrawingTask } from '../../context/WorkbenchDrawingContext';

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
  const startProjection = useWorkbenchDrawingTask('projection');
  const graphViewRef = useRef(viewMode === 'graph');
  graphViewRef.current = viewMode === 'graph';
  const [loading, setLoading] = useState(true);
  const [tagCounts, setTagCounts] = useState<Record<string, Record<string, number>>>({});
  const [scope, setScope] = useState<ScopeView | null>(null);
  const [messages, setMessages] = useState<DemoMessage[]>([]);
  const [edges, setEdges] = useState<DemoEdge[]>([]);
  const edgesRef = useRef<DemoEdge[]>([]);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [relatedTraceContext, setRelatedTraceContext] = useState<RelatedTraceContext | null>(null);
  const viewMessages = useMemo(() => relatedTraceContext
    ? [...new Map([...relatedTraceContext.messages, ...messages].map(message => [message.id, message])).values()] : messages, [messages, relatedTraceContext]);
  const viewEdges = useMemo(() => relatedTraceContext
    ? [...new Map([...relatedTraceContext.edges, ...edges].map(edge => [edge.id, edge])).values()] : edges, [edges, relatedTraceContext]);
  const viewRelations = useMemo(() => relatedTraceContext
    ? [...new Map([...relatedTraceContext.relations, ...relations].map(relation => [relation.id, relation])).values()] : relations, [relations, relatedTraceContext]);
  const [attentionUsersByTarget, setAttentionUsersByTarget] = useState<Record<string, string[]>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showUnauthenticatedNotice, setShowUnauthenticatedNotice] = useState(false);
  const [showRegistrationGuide, setShowRegistrationGuide] = useState(false);
  // Per-message stake counts, split by TRUTH/VALUE settlement type
  const [stakeCounts, setStakeCounts] = useState<Record<string, { truth: { pro: number; con: number }; value: { pro: number; con: number } }>>({});
  const [messageBettorCounts, setMessageBettorCounts] = useState<Record<string, number>>({});
  const [authorStakes, setAuthorStakes] = useState<Record<string, number>>({});
  const [leaderboardRefreshVersion, setLeaderboardRefreshVersion] = useState(0);
  const [registeredUsers, setRegisteredUsers] = useState<User[]>([]);
  const [isPreloaded, setIsPreloaded] = useState(false);
  const [viewerUser, setViewerUser] = useState<User | null>(() => {
    const username = localStorage.getItem(VIEWER_USERNAME_KEY)?.trim();
    return username ? { id: `viewer:${username}`, username, createdAt: '' } : null;
  });
  const displayUser = isPreloaded ? viewerUser : user;
  const correctionVersions = useMemo(() => {
    const invalidCorrectionIds = computeEffectiveSuppressedRelIds(viewEdges, viewMessages, displayUser?.username ?? null);
    return computeCorrectionVersions(viewMessages, viewEdges, invalidCorrectionIds);
  }, [viewMessages, viewEdges, displayUser?.username]);
  useEffect(() => { setRelatedTraceContext(null); }, [scopeMessageId]);
  useEffect(() => { edgesRef.current = viewEdges; }, [viewEdges]);

  // ── Preloaded data (from export viewer) ──
  const location = useLocation();
  const preloadedData = (location.state as { exportData?: ExportData })?.exportData ?? null;
  const preloadedLoaded = useRef<ExportData | null>(null);
  const [loadedExport, setLoadedExport] = useState<ExportData | null>(null);

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
            setScope(snapshot.scope);
            setMessages(projected.messages);
            setEdges(projected.edges);
            setRelations(projected.relations);
            setRegisteredUsers(snapshot.users);
            setAttentionUsersByTarget(snapshot.attentionUsers);
            setTagCounts(snapshot.tagCounts);
            setStakeCounts(projected.counts);
            setMessageBettorCounts(projected.bettors);
            setAuthorStakes(projected.authorAmounts);
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
    if (!scopeMessageId || preloadedData || authLoading || !user) return;
    setLoading(true);
    setLoadError(null);
    const sync = syncWorkbench({
      parent: scopeMessageId,
      load: api.getWorkbenchSnapshot,
      events: api.subscribeChanges,
      onSyncState: active => { if (active) beginWorkbenchSync(); else finishWorkbenchSync(); },
      onSnapshot(snapshot) {
        if (graphViewRef.current) beginWorkbenchDrawing();
        const projected = projectWorkbenchSnapshot(snapshot);
        setScope(snapshot.scope);
        setMessages(projected.messages);
        setEdges(projected.edges);
        setRelations(projected.relations);
        setRegisteredUsers(snapshot.users);
        setAttentionUsersByTarget({ ...snapshot.attentionUsers });
        setTagCounts({ ...snapshot.tagCounts });
        setStakeCounts(projected.counts);
        setAuthorStakes(projected.authorAmounts);
        setMessageBettorCounts(projected.bettors);
        setIsPreloaded(false);
        setLoading(false);
        setLoadError(null);
      },
      onError(error) { setLoadError(error.message); setLoading(false); },
    });
    const reload = () => sync.reload();
    const catchUp = () => sync.catchUp();
    const committed = (event: Event) => {
      const pages = (event as CustomEvent<import('../../data/workbench').WorkbenchSnapshot[]>).detail;
      if (!pages.some(page => sync.applyCommitted(page))) sync.reload();
    };
    window.addEventListener('gonglun:reload', reload);
    window.addEventListener('gonglun:catch-up', catchUp);
    window.addEventListener('gonglun:committed', committed);
    const resume = () => { if (!document.hidden) sync.catchUp(); };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', resume);
    return () => {
      window.removeEventListener('gonglun:reload', reload);
      window.removeEventListener('gonglun:catch-up', catchUp);
      window.removeEventListener('gonglun:committed', committed);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('focus', resume);
      sync.stop();
    };
  }, [scopeMessageId, leaderboardRefreshVersion, authLoading, user?.id, preloadedData]);

  useEffect(() => {
    if (!authLoading && !preloadedData && !user) {
      navigate('/login', { replace: true });
    }
  }, [authLoading, navigate, preloadedData, user?.username]);

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
    scope, messages: viewMessages, setMessages, edges: viewEdges, setEdges,
    edgesRef, relations: viewRelations, setRelations, attentionUsersByTarget, loadError, setRelatedTraceContext,
    showUnauthenticatedNotice, setShowUnauthenticatedNotice, showRegistrationGuide, setShowRegistrationGuide, stakeCounts,
    setStakeCounts, messageBettorCounts, setMessageBettorCounts, authorStakes, setAuthorStakes,
    setLeaderboardRefreshVersion, registeredUsers, isPreloaded, viewerUser, setViewerUser,
    displayUser, correctionVersions, preloadedData, loadedExport, viewerUsers, loading,
    tagCounts,
  };
}
