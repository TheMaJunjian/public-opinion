import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, type NavigateFunction } from 'react-router-dom';
import { api } from '../../api';
import type { ExportData } from '../../api/client';
import { syncWorkbench } from '../../data/workbench';
import type { Relation, ScopeView, User } from '../../types';
import type { DemoEdge, DemoMessage } from '../../utils/modelBridge';
import { computeCorrectionVersions, computeEffectiveSuppressedRelIds, convertMessagesToDemoModel } from '../../utils/modelBridge';

export const VIEWER_USERNAME_KEY = 'export-viewer-username';

export interface WorkbenchDataInput {
  user: User | null;
  authLoading: boolean;
  scopeMessageId: string;
  navigate: NavigateFunction;
}

/** Owns snapshot loading, incremental synchronization and exported-data viewing. */
export function useWorkbenchData({ user, authLoading, scopeMessageId, navigate }: WorkbenchDataInput) {
  const [loading, setLoading] = useState(true);
  const [tagCounts, setTagCounts] = useState<Record<string, Record<string, number>>>({});
  const [scope, setScope] = useState<ScopeView | null>(null);
  const [messages, setMessages] = useState<DemoMessage[]>([]);
  const [edges, setEdges] = useState<DemoEdge[]>([]);
  const edgesRef = useRef<DemoEdge[]>([]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  const [relations, setRelations] = useState<Relation[]>([]);
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
    const invalidCorrectionIds = computeEffectiveSuppressedRelIds(edges, messages, displayUser?.username ?? null);
    return computeCorrectionVersions(messages, edges, invalidCorrectionIds);
  }, [messages, edges, displayUser?.username]);

  // ── Preloaded data (from export viewer) ──
  const location = useLocation();
  const preloadedData = (location.state as { exportData?: ExportData })?.exportData ?? null;
  const preloadedLoaded = useRef(false);

  useEffect(() => {
    if (!preloadedData || preloadedLoaded.current) return;
    preloadedLoaded.current = true;

    // Convert export data to the same shape as API returns
    const scopeData: ScopeView = { messageId: null, title: preloadedData.scope.title };
    const backendMessages: any[] = preloadedData.messages.map(m => ({
      ...m,
      createdBy: { id: '', username: m.author, createdAt: '' },
    }));
    const backendRelations: any[] = preloadedData.relations.map(r => ({
      ...r,
      id: r.id,
      relationType: r.relationType ?? 'REFERENCE',
      sourceMessageId: r.sourceMessageId,
      targetRefs: r.targetRefs ?? [],
      payload: r.payload ?? undefined,
      createdAt: r.createdAt,
      createdBy: { id: r.authorId, username: r.author, createdAt: '' },
    }));

    const { messages: demoMsgs, edges: demoEdges } = convertMessagesToDemoModel(
      backendMessages, backendRelations
    );
    setScope(scopeData);
    setRelations(backendRelations);
    const preloadedAttention: Record<string, string[]> = {};
    for (const relation of backendRelations) {
      if (relation.relationType.toUpperCase() !== 'ATTENTION') continue;
      for (const ref of relation.targetRefs) {
        if (ref.kind !== 'message' && ref.kind !== 'text-fragment') continue;
        const users = preloadedAttention[ref.messageId] ?? [];
        if (!users.includes(relation.createdBy.id)) users.push(relation.createdBy.id);
        preloadedAttention[ref.messageId] = users;
      }
    }
    setAttentionUsersByTarget(preloadedAttention);
    setMessages(demoMsgs);
    setEdges(demoEdges);
    setStakeCounts({});
    setMessageBettorCounts({});
    setAuthorStakes({});
    setLoading(false);
    setIsPreloaded(true);
  }, [preloadedData]);

  const viewerUsers = useMemo(() => {
    if (!isPreloaded) return [];
    const usernames = new Set<string>();
    messages.forEach(message => { if (message.author) usernames.add(message.author); });
    relations.forEach(relation => { if (relation.createdBy?.username) usernames.add(relation.createdBy.username); });
    return [...usernames].sort((a, b) => a.localeCompare(b, 'zh-CN'))
      .map(username => ({ id: `viewer:${username}`, username, createdAt: '' }));
  }, [isPreloaded, messages, relations]);

  useEffect(() => {
    if (!isPreloaded || viewerUsers.length === 0) return;
    setViewerUser(current => current && viewerUsers.some(candidate => candidate.username === current.username)
      ? current
      : viewerUsers[0]);
  }, [isPreloaded, viewerUsers]);

  useEffect(() => {
    if (!scopeMessageId || preloadedData || authLoading || !user) return;
    setLoading(true);
    setLoadError(null);
    const sync = syncWorkbench({
      parent: scopeMessageId,
      load: api.getWorkbenchSnapshot,
      events: api.subscribeChanges,
      onSnapshot(snapshot) {
        const active = snapshot.messages.filter(message => !message.supersededBy);
        const activeIds = new Set(active.map(message => message.id));
        const visibleRelations = snapshot.relations.filter(relation => activeIds.has(relation.id));
        const converted = convertMessagesToDemoModel(active, visibleRelations);
        setScope(snapshot.scope);
        setMessages(converted.messages);
        setEdges(converted.edges);
        setRelations(visibleRelations);
        setRegisteredUsers(snapshot.users);
        setAttentionUsersByTarget({ ...snapshot.attentionUsers });
        setTagCounts({ ...snapshot.tagCounts });
        const counts: Record<string, { truth: { pro: number; con: number }; value: { pro: number; con: number } }> = {};
        const authorAmounts: Record<string, number> = {};
        const bettors: Record<string, number> = {};
        const byId = new Map(converted.messages.map(message => [message.id, message]));
        for (const [id, stakes] of Object.entries(snapshot.stakes)) {
          counts[id] = { truth: stakes.countsByType?.TRUTH ?? stakes.counts, value: stakes.countsByType?.VALUE ?? { pro: 0, con: 0 } };
          authorAmounts[id] = stakes.stakes.filter(stake => stake.side === 'PRO' && stake.user.username === byId.get(id)?.author).reduce((sum, stake) => sum + stake.amount, 0);
          bettors[id] = new Set(stakes.stakes.map(stake => stake.user.id)).size;
        }
        setStakeCounts(counts);
        setAuthorStakes(authorAmounts);
        setMessageBettorCounts(bettors);
        setLoading(false);
        setLoadError(null);
      },
      onError(error) { setLoadError(error.message); setLoading(false); },
    });
    const reload = () => sync.reload();
    window.addEventListener('gonglun:reload', reload);
    return () => { window.removeEventListener('gonglun:reload', reload); sync.stop(); };
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
    scope, messages, setMessages, edges, setEdges,
    edgesRef, relations, setRelations, attentionUsersByTarget, loadError,
    showUnauthenticatedNotice, setShowUnauthenticatedNotice, showRegistrationGuide, setShowRegistrationGuide, stakeCounts,
    setStakeCounts, messageBettorCounts, setMessageBettorCounts, authorStakes, setAuthorStakes,
    setLeaderboardRefreshVersion, registeredUsers, isPreloaded, viewerUser, setViewerUser,
    displayUser, correctionVersions, preloadedData, viewerUsers, loading,
    tagCounts,
  };
}
