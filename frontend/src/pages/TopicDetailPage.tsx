import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ApiError, type ExportData } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { convertMessagesToDemoModel, unitSelectionToTargetRef, computeCorrectedEdgeMap, computeCorrectionVersions, correctionSelectionIsStale, hasActiveCorrectionForSelection, computeEffectiveSuppressedRelIds, computeUserActiveStanceRelIds, computeUserOverriddenStanceRelIds, computeTransitiveVoteStats, isContentKind, kindLabel } from '../utils/modelBridge';
import type {
  DemoMessage, DemoEdge, UnitSelection, Selection,
  RelationType, MessageKind,
} from '../utils/modelBridge';
import type { Topic, TargetRef, Relation, MessageStakes, User } from '../types';
import { getPresentationSpec, getRelationTitle } from '../types';
import GraphView, { clearBrowserSelection, extractTextTargetsForMessage, relationTypeName, getSelectionFragment, buildAnnoTree, renderAnnoNodes } from '../components/GraphView';
import ErrorBoundary from '../components/ErrorBoundary';
import MessageCard, { type MessageCardContext } from '../components/MessageCard';
import SettlementPanel from '../components/SettlementPanel';
import RoundHistory from '../components/RoundHistory';
import TopicRightPanel from '../components/TopicRightPanel';
import LeaderboardModal from '../components/LeaderboardModal';
import PromptModal from '../components/PromptModal';
import { MessageJumpOverlay } from '../components/PopupOverlay';
import useStakeCalculation from '../hooks/useStakeCalculation';
import CorrectionComparisonPopup from '../components/CorrectionComparisonPopup';
import { applyContainerExpansion } from '../utils/focusContainer';
import { operationLog } from '../utils/debugLog';
import { useCleanView } from '../hooks/useCleanView';
import CleanFilterPanel from '../components/CleanFilterPanel';
import MessageFilterPanel, { type MessageFilterSettings, applyMessageFilter } from '../components/MessageFilterPanel';
import {
  ALL_RELATION_TYPES,
  CLASSIFY_TARGET_HINT,
  MAX_TAG_LABEL_DISPLAY_LENGTH,
  SUB_TYPE_OPTIONS,
  applyTextCorrectionInheritance,
  buildRelationDemoMessage,
  buildRelationPayload,
  collectContainerVisibleIds,
  collectOwnedByRelation,
  describeUnit,
  expandTextIdsWithCorrections,
  getRejectedJoinRelationIds,
  getJoinRelationsForMessage,
  getJoinRecoveryTargetIds,
  getEffectiveJoinRelationIds,
  filterContainerEdgesByEffectiveJoins,
  formatCorrectionRange,
  resolveNavigationTargetId,
  getUserPreferredJoinByTarget,
  expandTextIdsWithSettlementResults,
  foldUpToWhole,
  generateCorrectionContent,
  getRelationTargetIds,
  getTextTargetIds,
  isValidTagLabel,
  mergeUnits,
  nextId,
  replyAdditionalLabel,
  secondaryRelationLabel,
  selKey,
  subTypeLabel,
  targetRefDisplayId,
  uniqueTargetRefsFromEdges,
  unitEquals,
} from './topicDetailHelpers';

// ========================= TopicDetailPage =========================

type ViewMode = "list" | "graph";

function collectNavigationDisplayDependencies(
  messageId: string,
  messages: DemoMessage[],
  relations: Relation[],
  edges: DemoEdge[],
  includeAuxiliaryRecords = true,
): Set<string> {
  const relationById = new Map(relations.map(relation => [relation.id, relation]));
  const dependencyIds = new Set<string>();
  const pendingIds = [messageId];

  while (pendingIds.length > 0) {
    const currentId = pendingIds.pop()!;
    if (dependencyIds.has(currentId)) continue;
    dependencyIds.add(currentId);

    for (const edge of edges) {
      if (edge.relationMessageId === currentId) {
        if (!edge.from.messageId.startsWith('anon:')) pendingIds.push(edge.from.messageId);
        if (!edge.to.messageId.startsWith('anon:')) pendingIds.push(edge.to.messageId);
      }
    }

    const relation = relationById.get(currentId);
    if (relation) {
      if (relation.sourceMessageId) pendingIds.push(relation.sourceMessageId);
      for (const ref of relation.targetRefs ?? []) {
        pendingIds.push(ref.kind === 'relation' ? ref.relationId : ref.messageId);
      }
    }

    if (includeAuxiliaryRecords) {
      // JOIN and settlement records can affect whether the current message is
      // included in its owning presentation, even though they do not always
      // produce a visible edge of their own.
      for (const candidate of relations) {
        if (candidate.relationType?.toUpperCase() === 'JOIN' && candidate.targetRefs.some(ref =>
          (ref.kind === 'relation' ? ref.relationId : ref.messageId) === currentId,
        )) {
          pendingIds.push(candidate.id);
        }
      }
      for (const candidate of messages) {
        if ((candidate.kind === 'round' || candidate.kind === 'round_result')
          && candidate.settlementTargetId === currentId) {
          pendingIds.push(candidate.id);
        }
      }
    }
  }

  return dependencyIds;
}

type FocusSnapshot = {
  viewMode: ViewMode;
  leftScroll: { top: number; left: number } | null;
  leftHorizontalScroll: number | null;
  rightScroll: { top: number; left: number } | null;
  draftUnits: UnitSelection[];
  sourceUnits: UnitSelection[];
  targetUnits: UnitSelection[];
  activeTextSelectId: string | null;
  lastClickedMessageId: string | null;
  focusHop: number;
};

type FocusEntry = {
  ids: string[];
  snapshot: FocusSnapshot | null;
  mode: "focus" | "topic";
  topicRelMsgId?: string;
};

export default function TopicDetailPage() {
  const { topicId } = useParams<{ topicId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [topic, setTopic] = useState<Topic | null>(null);
  const [messages, setMessages] = useState<DemoMessage[]>([]);
  const [edges, setEdges] = useState<DemoEdge[]>([]);
  const edgesRef = useRef<DemoEdge[]>([]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [attentionUsersByTarget, setAttentionUsersByTarget] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Per-message stake counts, split by TRUTH/VALUE settlement type
  const [stakeCounts, setStakeCounts] = useState<Record<string, { truth: { pro: number; con: number }; value: { pro: number; con: number } }>>({});
  const [messageBettorCounts, setMessageBettorCounts] = useState<Record<string, number>>({});
  const [authorStakes, setAuthorStakes] = useState<Record<string, number>>({});
  const [isPreloaded, setIsPreloaded] = useState(false);
  const [viewerUser, setViewerUser] = useState<User | null>(null);
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
    const topicData: Topic = {
      id: '__preloaded__',
      title: preloadedData.topic.title,
      body: preloadedData.topic.body ?? undefined,
      status: preloadedData.topic.status as 'OPEN' | 'ARCHIVED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: { id: '__system__', username: '导出数据', createdAt: '' },
    };
    const backendMessages: any[] = preloadedData.messages.map(m => ({
      ...m,
      topicId: '__preloaded__',
      createdBy: { id: '', username: m.author, createdAt: '' },
    }));
    const backendRelations: any[] = preloadedData.relations.map(r => ({
      id: r.id, topicId: '__preloaded__',
      relationType: r.relationType ?? 'REFERENCE',
      sourceMessageId: r.sourceMessageId,
      targetRefs: r.targetRefs ?? [],
      payload: r.payload ?? undefined,
      createdAt: r.createdAt,
      createdBy: { id: '', username: r.author, createdAt: '' },
    }));

    const { messages: demoMsgs, edges: demoEdges } = convertMessagesToDemoModel(
      backendMessages, backendRelations
    );
    setTopic(topicData);
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
    if (!topicId || preloadedData) return;
    let cancelled = false;
    async function load() {
      try {
        setLoading(true); setLoadError(null);
        const [topicData, messagesData, relationsData, attentionData] = await Promise.all([
          api.getTopic(topicId!),
          api.getMessages(topicId!, { limit: 200 }),
          api.getRelations(topicId!, { limit: 200 }),
          api.getAttentionUsers(topicId!),
        ]);
        if (cancelled) return;
        setTopic(topicData);
        const { messages: demoMsgs, edges: demoEdges } = convertMessagesToDemoModel(
          messagesData.data, relationsData.data
        );
        setRelations(relationsData.data);
        setAttentionUsersByTarget(attentionData.data);
        operationLog('加载主题关系', `count=${relationsData.data.length}`);
        setMessages(demoMsgs);
        setEdges(demoEdges);

        // Phase 2: batch-load stake counts for ALL messages (text + relation)
        const allMsgIds = demoMsgs.map((m: { id: string }) => m.id);
        if (allMsgIds.length > 0) {
          try {
            const stakes = await Promise.all(
              allMsgIds.map((id: string) =>
                api.getMessageStakes(id).then(r => {
                  const msg = demoMsgs.find((m: { id: string; author: string }) => m.id === id);
                  const authorStake = msg
                    ? r.stakes
                        .filter(s => s.user.username === msg.author && s.side === 'PRO')
                        .reduce((sum, s) => sum + s.amount, 0)
                    : 0;
                  const byType = r.countsByType ?? {};
                  return {
                    id,
                    truth: byType.TRUTH ?? { pro: 0, con: 0 },
                    value: byType.VALUE ?? { pro: 0, con: 0 },
                    authorStake,
                    bettors: new Set(r.stakes.map(s => s.user.id || s.user.username)).size,
                  };
                })
              )
            );
            const map: Record<string, { truth: { pro: number; con: number }; value: { pro: number; con: number } }> = {};
            const aMap: Record<string, number> = {};
            const bettorsMap: Record<string, number> = {};
            for (const s of stakes) {
              map[s.id] = { truth: s.truth, value: s.value };
              aMap[s.id] = s.authorStake;
              bettorsMap[s.id] = s.bettors;
            }
            // For RECOMMEND/ARCHIVE relations: mirror text target's VALUE stake counts onto
            // the annotation relation message so badges show correct VALUE stats.
            for (const rel of relationsData.data) {
              const rt = rel.relationType?.toUpperCase();
              if (rt === 'RECOMMEND' || rt === 'ARCHIVE') {
                const trefs = rel.targetRefs as Array<{ messageId?: string }> | undefined;
                const textTargetId = trefs?.[0]?.messageId;
                if (textTargetId && map[textTargetId]) {
                  map[rel.id] = map[textTargetId];
                }
              }
            }
            if (!cancelled) {
              setStakeCounts(map);
              setAuthorStakes(aMap);
              setMessageBettorCounts(bettorsMap);
            }
          } catch {
            // stake fetch is best-effort; don't block the page
          }
        }
      } catch (e: any) {
        if (cancelled) return;
        setLoadError(String(e?.message ?? e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [topicId]);

  // Messages that have no DOM element in the non-linear graph view.
  // Mirror of GraphView's hiddenTargetIds logic — used to decide whether
  // to auto-switch to linear view when navigating to such a message.
  const hiddenInGraphView = useMemo(() => {
    const ids = new Set<string>();
    // 1) CORRECT relation messages are not rendered as independent cards
    for (const m of messages) {
      if (m.kind === 'relation' && m.relationType === 'correct') ids.add(m.id);
    }
    // 2) Corrected text targets that are not themselves correction sources
    //    (GraphView.hiddenCorrectedTargetIds)
    const correctedTargets = new Set<string>();
    const correctionSources = new Set<string>();
    for (const e of edges) {
      if (e.relationType === 'correct' && !e.from.messageId.startsWith('anon:')) {
        correctedTargets.add(e.to.messageId);
        correctionSources.add(e.from.messageId);
      }
    }
    for (const id of correctedTargets) {
      if (!correctionSources.has(id)) ids.add(id);
    }
    // 3) Summary text targets that are not themselves summary sources
    //    (GraphView.hiddenSummaryTargetIds)
    const summaryRelMsgIds = new Set<string>();
    for (const e of edges) {
      if (e.relationType === 'summary') summaryRelMsgIds.add(e.relationMessageId);
    }
    for (const e of edges) {
      if (e.relationType === 'summary' && !summaryRelMsgIds.has(e.to.messageId)) {
        ids.add(e.to.messageId);
      }
    }
    return ids;
  }, [edges, messages]);

  // Auto-enter classify topic if msg belongs to one
  const [autoClassifyMsgId, setAutoClassifyMsgId] = useState<string | null>(null);
  useEffect(() => {
    if (loading || relations.length === 0) return;
    const msgId = autoClassifyMsgId;
    if (!msgId) return;

    const msgRel = relations.find(r => r.id === msgId);
    const msgRelType = msgRel?.relationType?.toUpperCase();
    // Determine the "anchor" — the message whose classify determines where
    // this message is displayed on the canvas.
    // - ANNOTATION / REFERENCE / REPLY / CORRECT → displayed alongside source
    // - AGREE / DISAGREE / TAG → displayed alongside target (as decorations)
    // - Other types / text messages → the message itself is the anchor
    let anchorId = msgId;
    if (msgRel) {
      const srcId = msgRel.sourceMessageId ?? null;
      const firstTextTarget = ((msgRel.targetRefs ?? []) as TargetRef[])
        .find(t => t.kind === 'message' || t.kind === 'text-fragment');
      const tgtId = firstTextTarget ? firstTextTarget.messageId : null;
      if (msgRelType === 'ANNOTATION' || msgRelType === 'REFERENCE'
       || msgRelType === 'REPLY'   || msgRelType === 'CORRECT') {
        anchorId = srcId || msgId;
      } else if (msgRelType === 'AGREE' || msgRelType === 'DISAGREE'
              || msgRelType === 'TAG') {
        anchorId = tgtId || msgId;
      }
    }
    // Build lookup for ownership expansion
    const relById = new Map(relations.map(r => [r.id, r]));
    const msgMapLocal = new Map(messages.map(m => [m.id, m]));

    const tryEnter = (relId: string) => {
      if (classifyRelMsgId === relId) {
        // Already in this classify — just ensure correct view mode
        if (hiddenInGraphView.has(msgId)) setViewMode("list");
        setAutoClassifyMsgId(null);
        return;
      }
      if (classifyRelMsgId) exitClassifyTopic({ restoreSnapshot: false });
      enterClassifyTopic(relId);
      // If the classify is rejected, enter preview (read-only) mode
      if (rejectedContainerIds.has(relId)) {
        setPreviewClassifyId(relId);
      }
      if (hiddenInGraphView.has(msgId)) setViewMode("list");
      setAutoClassifyMsgId(null);
    };

    // ── Find the classify that owns the anchor ──
    // First pass: direct targetRefs match.
    for (const rel of relations) {
      const rt = rel.relationType?.toUpperCase();
      if (rt !== 'CLASSIFY' && rt !== 'SUMMARY') continue;
      // Don't auto-enter rejected classifies from navigation jumps —
      // their messages are back on the main canvas.  User can still
      // enter preview mode by double-clicking the card directly.
      if (rejectedContainerIds.has(rel.id)) continue;
      const targets = (rel.targetRefs ?? []) as TargetRef[];
      if (targets.some(t =>
        (t.kind === 'relation' && t.relationId === anchorId) ||
        (t.kind !== 'relation' && t.messageId === anchorId)
      )) { tryEnter(rel.id); return; }
    }
    // Second pass: transitive ownership + CORRECT expansion.
    for (const rel of relations) {
      const rt = rel.relationType?.toUpperCase();
      if (rt !== 'CLASSIFY' && rt !== 'SUMMARY') continue;
      if (rejectedContainerIds.has(rel.id)) continue;
      const owned = collectOwnedByRelation(rel.id, relById, new Set(), undefined, rejectedJoinRelationIds);
      const expanded = expandTextIdsWithCorrections(owned.textIds, edges, msgMapLocal);
      if (expanded.has(anchorId) || owned.relationIds.has(anchorId)) {
        tryEnter(rel.id); return;
      }
    }
    // Anchor not in any classify → main view.
    if (classifyRelMsgId) exitClassifyTopic({ restoreSnapshot: false }); else setClassifyRelMsgId(null);
    if (hiddenInGraphView.has(msgId)) setViewMode("list");
    setAutoClassifyMsgId(null);
  }, [loading, relations, autoClassifyMsgId, hiddenInGraphView, edges, messages]);

  // Phase 3: auto-open settlement from URL params (triggered by points-navigate)
  const pendingScrollMsgRef = useRef<string | null>(null);
  useEffect(() => {
    const targetMsgId = searchParams.get('msg');
    const settlementMsgId = searchParams.get('settlement');
    if (targetMsgId || settlementMsgId) {
      const msgId = targetMsgId || settlementMsgId!;
      pendingScrollMsgRef.current = msgId;
      setAutoClassifyMsgId(msgId); // try auto-enter classify
      // Clear all selections and select the target message
      setDraftUnits([{ messageId: msgId, selection: { kind: "whole" } }]);
      setActiveTextSelectId(null);
      if (settlementMsgId) {
        const settlementTypeParam = searchParams.get('settlementType');
        const settlementType = settlementTypeParam === 'VALUE' ? 'VALUE' : 'TRUTH';
        openSettlement(settlementMsgId, settlementType);
        const highlightRoundId = searchParams.get('highlightRound');
        if (highlightRoundId) sessionStorage.setItem('settlementHighlightRound', highlightRoundId);
        const highlight: { side?: 'PRO' | 'CON'; vote?: 'TRUE' | 'FALSE'; username?: string; stakeId?: string; voteId?: string } = {};
        const stakeId = searchParams.get('stakeId');
        const voteId = searchParams.get('voteId');
        const side = searchParams.get('side');
        const vote = searchParams.get('vote');
        const username = searchParams.get('username');
        if (stakeId) highlight.stakeId = stakeId;
        if (voteId) highlight.voteId = voteId;
        if (side === 'PRO' || side === 'CON') highlight.side = side;
        if (vote === 'TRUE' || vote === 'FALSE') highlight.vote = vote;
        if (username) highlight.username = username;
        setSettlementEntryHighlight(Object.keys(highlight).length > 0 ? highlight : null);
        if (Object.keys(highlight).length > 0) setTimeout(() => setSettlementEntryHighlight(null), 1500);
        searchParams.delete('settlement');
        searchParams.delete('settlementType');
        searchParams.delete('highlightRound');
        searchParams.delete('stakeId');
        searchParams.delete('voteId');
        searchParams.delete('side');
        searchParams.delete('vote');
        searchParams.delete('username');
      }
      searchParams.delete('msg');
      setSearchParams(searchParams, { replace: true });
      setScrollKey(k => k + 1);
      // Trigger scroll directly (also needed for same-topic nav where messages don't change)
      setTimeout(() => scrollMsgToCenter(msgId), 150);
    }
  }, [searchParams, setSearchParams]);

  const [relationType, setRelationType] = useState<RelationType | null>(null);
  const [secondaryRelationType, setSecondaryRelationType] = useState<string>("none");
  const [isArrangeLayoutLocked, setIsArrangeLayoutLocked] = useState(false);
  const [subType, setSubType] = useState<string>(""); // SPAM|OFFTOPIC|LOWVALUE|IMPORTANT|CUSTOM or empty
  const [subTypeCustomLabel, setSubTypeCustomLabel] = useState("");
  const subTypeCustomBufferRef = useRef(""); // cache textarea content when switching away from CUSTOM subType
  const savedTextOnTypeSwitchRef = useRef(""); // cache textarea content when switching to a text-less relation type
  const lastTagSecondaryRef = useRef<string>("recommend"); // remember last TAG secondary selection
  const [relationLabel, setRelationLabel] = useState("");
  const [newMessageContent, setNewMessageContent] = useState("");
  useEffect(() => {
    if (relationType !== 'proposal') return;
    if (secondaryRelationType === '终止结算' || secondaryRelationType === '分配收入') {
      setNewMessageContent('');
    } else if (secondaryRelationType === '充值分账') {
      setNewMessageContent('充值总额=1000\n收入池分成=100\n指定用户=user-id');
    } else if (secondaryRelationType === '运营收入注入') {
      setNewMessageContent('收入金额=1000\n来源=服务收入');
    }
  }, [relationType, secondaryRelationType]);
  useEffect(() => {
    if (relationType !== 'delegation') return;
    if (secondaryRelationType === 'create') {
      setNewMessageContent('报酬数量=100\n委托内容=');
    } else if (secondaryRelationType === 'fulfill') {
      setNewMessageContent('分配数量=100\n完成说明=');
    }
  }, [relationType, secondaryRelationType]);
  const [draftUnits, setDraftUnits] = useState<UnitSelection[]>([]);
  const [sourceUnits, setSourceUnits] = useState<UnitSelection[]>([]);
  const [targetUnits, setTargetUnits] = useState<UnitSelection[]>([]);
  const selectionLogInitializedRef = useRef(false);

  useEffect(() => {
    if (!selectionLogInitializedRef.current) {
      selectionLogInitializedRef.current = true;
      return;
    }
    const describe = (units: UnitSelection[]) => units.map(unit => {
      const selection = unit.selection;
      const detail = selection.kind === 'whole'
        ? '整条'
        : selection.kind === 'text'
          ? `字符${selection.start}-${selection.start + selection.len}`
          : `边${selection.edgeId}`;
      return `${unit.messageId}[${detail}]`;
    }).join(',') || '空';
    operationLog('选择变化', `暂存区=${describe(draftUnits)} 来源集合=${describe(sourceUnits)} 目标集合=${describe(targetUnits)}`);
  }, [draftUnits, sourceUnits, targetUnits]);
  const [activeTextSelectId, setActiveTextSelectId] = useState<string | null>(null);
  const [focusEntries, setFocusEntries] = useState<FocusEntry[]>([]);
  // Counter incremented on every exitFocus/exitAllFocus to force GraphView
  // remount, avoiding React DOM reconciliation bugs (removeChild errors)
  // that occur when the SVG canvas structure changes drastically.
  const [classifyKey, setClassifyKey] = useState(0);
  const [focusKey, setFocusKey] = useState(0);
  const [scrollKey, setScrollKey] = useState(0);
  // Classify state — independent from the focus system.
  // When non-null, the view is scoped to the CLASSIFY/SUMMARY relation's owned messages.
  const [classifyRelMsgId, setClassifyRelMsgId] = useState<string | null>(null);
  const isInsideClassify = classifyRelMsgId !== null;
  const currentClassifyRelMsgId = classifyRelMsgId;
  // Stack-based snapshot store for nested classify enter/exit.
  // Each entry holds the classify id and the snapshot captured before entering it.
  const classifyStackRef = useRef<Array<{ relMsgId: string; snapshot: FocusSnapshot | null }>>([]);
  const temporaryCategoryStackRef = useRef<Array<{
    snapshot: FocusSnapshot;
    joinFilterTargetId: string | null;
    joinFilterDirection: 'incoming' | 'outgoing';
    correctionFilterTargetId: string | null;
    comparisonMode: boolean;
    comparisonReviewed: boolean;
    comparisonTargetId: string | null;
    comparisonSide: 'agree' | 'disagree';
    comparisonReviewBaseMessages: DemoMessage[] | null;
    comparisonReviewBaseEdges: DemoEdge[] | null;
  }>>([]);
  // Preview mode: when entering a rejected classify, the view is read-only
  // with a grey filter.  null = normal mode, string = classify ID being previewed.
  const [previewClassifyId, setPreviewClassifyId] = useState<string | null>(null);
  const isPreviewMode = previewClassifyId !== null;
  // Fetch tag counts for clean view
  const [tagCounts, setTagCounts] = useState<Record<string, Record<string, number>>>({});
  useEffect(() => {
    if (!topicId) return;
    api.getTopicTagCounts(topicId).then(res => setTagCounts(res.counts)).catch(() => {});
  }, [topicId, messages.length]);
  // Phase 6: Clean view — multi-dimensional filter rules
  const {
    cleanMode, cleanFilters, cleanVisibleIds,
    addFilter: addCleanFilter, removeFilter: removeCleanFilter,
    updateFilter: updateCleanFilter, clearFilters: clearCleanFilters,
  } = useCleanView({ messages, edges, stakeCounts, tagCounts });
  const cleanSender = searchParams.get('sender');
  const skipCleanSenderInitRef = useRef(false);
  useEffect(() => {
    if (!cleanSender) {
      skipCleanSenderInitRef.current = false;
      return;
    }
    if (skipCleanSenderInitRef.current) return;
    if (messages.length === 0) return;
    if (cleanFilters.some(rule => rule.kind === 'sender' && rule.username === cleanSender)) return;
    clearCleanFilters();
    addCleanFilter({ id: `url-sender-${cleanSender}`, kind: 'sender', username: cleanSender });
  }, [cleanSender, messages.length, cleanFilters, addCleanFilter, clearCleanFilters]);
  const clearCleanView = useCallback(() => {
    skipCleanSenderInitRef.current = true;
    clearCleanFilters();
    if (searchParams.has('sender')) {
      const nextSearchParams = new URLSearchParams(searchParams);
      nextSearchParams.delete('sender');
      setSearchParams(nextSearchParams, { replace: true });
    }
  }, [clearCleanFilters, searchParams, setSearchParams]);
  const contentMsgCount = useMemo(() => messages.filter(m => isContentKind(m.kind)).length, [messages]);
  // Message type filter: hide settlement / join messages
  const [msgFilter, setMsgFilter] = useState<MessageFilterSettings>({ hideSettlement: true, hideJoin: true });
  const [joinFilterTargetId, setJoinFilterTargetId] = useState<string | null>(null);
  const [joinFilterDirection, setJoinFilterDirection] = useState<'incoming' | 'outgoing'>('incoming');
  const [correctionFilterTargetId, setCorrectionFilterTargetId] = useState<string | null>(null);
  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;
  const messagesRef = useRef<DemoMessage[]>([]);
  messagesRef.current = messages;
  const renderedMessageIdsRef = useRef<Set<string>>(new Set());
  const renderedRelationIdsRef = useRef<Set<string>>(new Set());
  const pendingCorrectionNavigationRef = useRef<{ messageId: string } | null>(null);
  const navigationVisibilityRef = useRef<{
    cleanMode: boolean;
    cleanVisibleIds: { visibleTextIds: Set<string>; visibleRelIds: Set<string> } | null;
    msgFilter: MessageFilterSettings;
  }>({ cleanMode: false, cleanVisibleIds: null, msgFilter });
  navigationVisibilityRef.current = { cleanMode, cleanVisibleIds, msgFilter };
  const pendingScrollDependencyIdsRef = useRef<string[]>([]);

  const [lastClickedMessageId, setLastClickedMessageId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("graph");

  const handleSettlementMessageCreated = useCallback((m: any) => {
    const normalized = { ...m, author: m.author || user?.username || '', kind: m.kind || 'round' };
    setMessagesRef.current((prev: any) => {
      const exists = prev.some((item: DemoMessage) => item.id === normalized.id);
      return exists ? prev : [...prev, normalized];
    });
    if (isInsideClassify && currentClassifyRelMsgId) {
      void attachMessageToCurrentClassify(normalized.id).catch((error) => {
        console.warn('结算结果加入当前分类失败', { messageId: normalized.id, error });
      });
      setClassifyKey(k => k + 1);
    }
    setTimeout(() => scrollMsgToCenter(normalized.settlementTargetId ?? normalized.id), 50);
  }, [user, isInsideClassify, currentClassifyRelMsgId]);

  // Phase 6: expose for SettlementPanel direct access
  useEffect(() => { (window as any).__addSettlementMessage = handleSettlementMessageCreated; return () => { delete (window as any).__addSettlementMessage; }; }, [handleSettlementMessageCreated]);

  // Scroll to message after data loads and renders (also triggers on focus changes for in-place nav).
  // View-switch decisions (graph→list for hidden messages) are made in the auto-classify
  // effect above; this effect only handles the actual scrolling.
  useEffect(() => {
    if (!loading && pendingScrollMsgRef.current && messages.some(m => m.id === pendingScrollMsgRef.current)) {
      // A pending navigation may target a JOIN record itself. Do not resolve
      // it to the joined target; the JOIN card is the requested destination.
      const dependencyIds = pendingScrollDependencyIdsRef.current;
      pendingScrollDependencyIdsRef.current = [];
      scrollMsgToCenter(pendingScrollMsgRef.current, { resolveTarget: false, dependencyIds });
      pendingScrollMsgRef.current = null;
    }
  }, [loading, messages, classifyKey, focusKey, scrollKey, viewMode]);

  useEffect(() => {
    const pendingNavigation = pendingCorrectionNavigationRef.current;
    if (!pendingNavigation || correctionFilterTargetId !== null) return;
    const targetExists = messagesRef.current.some(message => message.id === pendingNavigation.messageId)
      || relationsRef.current.some(relation => relation.id === pendingNavigation.messageId);
    if (!targetExists) return;
    pendingCorrectionNavigationRef.current = null;
    handleNavigateToMessage(pendingNavigation.messageId);
  }, [correctionFilterTargetId, viewMode, loading, messages, edges, relations, scrollKey]);

  useEffect(() => () => {
    if (messagePulseTimerRef.current) clearTimeout(messagePulseTimerRef.current);
    if (messagePulseRafRef.current) cancelAnimationFrame(messagePulseRafRef.current);
  }, []);
  const [focusHop, setFocusHop] = useState<number>(1);
  // Popup state for decoration double-click (shows sender info)
  const [decorationPopup, setDecorationPopup] = useState<{
    messageId: string; kind: "agree" | "disagree";
    x: number; y: number;
  } | null>(null);
  // Popup state for tag badge double-click (shows who tagged)
  const [tagPopup, setTagPopup] = useState<{
    messageId: string; tagLabel: string; relMsgIds: string[];
    x: number; y: number;
    subDetails?: Array<{subType:string;customLabel?:string;count:number}>;
  } | null>(null);
  const [comparisonPopup, setComparisonPopup] = useState<{
    relMsgId: string;
    x: number; y: number;
    reversePreview?: {
      before: string;
      after: string;
      target: UnitSelection;
      mode?: 'direct' | 'source';
      label?: string;
    };
  } | null>(null);
  const [mergeInfoPopup, setMergeInfoPopup] = useState<{
    relMsgId: string;
    x: number; y: number;
  } | null>(null);
  // DEBUG
  const [stakeAmount, setStakeAmount] = useState<number | ''>(10);
  const [relStakeAmount, setRelStakeAmount] = useState<number | ''>(10);
  const [minSelfStake, setMinSelfStake] = useState(10);
  const stakeAmountRef = useRef<number>(10);
  const relStakeRef = useRef<number>(10);
  stakeAmountRef.current = typeof stakeAmount === 'number' ? stakeAmount : 0;
  relStakeRef.current = typeof relStakeAmount === 'number' ? relStakeAmount : 0;
  const [availablePoints, setAvailablePoints] = useState(100); // Phase 2: balance cap
  const [sendError, setSendError] = useState<string | null>(null);
  const [settlementOpenMsgId, setSettlementOpenMsgId] = useState<string | null>(null);
  const [settlementOpenType, setSettlementOpenType] = useState<'TRUTH' | 'VALUE' | null>(null);
  const [comparisonMode, setComparisonMode] = useState(false);
  const [comparisonReviewed, setComparisonReviewed] = useState(false);
  const [comparisonTargetId, setComparisonTargetId] = useState<string | null>(null);
  const [comparisonSide, setComparisonSide] = useState<'agree' | 'disagree'>('agree');
  const [comparisonReviewBaseMessages, setComparisonReviewBaseMessages] = useState<DemoMessage[] | null>(null);
  const [comparisonReviewBaseEdges, setComparisonReviewBaseEdges] = useState<DemoEdge[] | null>(null);

  // Helper: open settlement with explicit type (defaults to TRUTH for old code paths)
  const openSettlement = useCallback((msgId: string, type: 'TRUTH' | 'VALUE' = 'TRUTH') => {
    if (comparisonReviewed) return;
    setSettlementOpenMsgId(msgId);
    setSettlementOpenType(type);
  }, [comparisonReviewed]);
  const closeSettlement = useCallback(() => {
    setSettlementOpenMsgId(null);
    setSettlementOpenType(null);
  }, []);
  // Phase 6: auto-scroll settlement panel into view
  useEffect(() => {
    if (!settlementOpenMsgId) return;
    setTimeout(() => {
      document.querySelector('[data-settlement-panel]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
  }, [settlementOpenMsgId]);
  const [settlementEntryHighlight, setSettlementEntryHighlight] = useState<{
    side?: 'PRO' | 'CON'; vote?: 'TRUE' | 'FALSE'; username?: string;
    stakeId?: string; voteId?: string;
  } | null>(null);
  const [stanceHighlight, setStanceHighlight] = useState<{ stanceMsgId: string; evidenceMsgIds: string[] } | null>(null);
  const stanceHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showStanceHistory, setShowStanceHistory] = useState(false);
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [showRevenue, setShowRevenue] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);

  const showAlert = useCallback((message: string) => {
    setAlertMessage(message);
  }, []);

  const mergeStakeSnapshot = useCallback((messageId: string, stakes: MessageStakes) => {
    const byType = stakes.countsByType ?? {};
    setStakeCounts(prev => ({
      ...prev,
      [messageId]: {
        truth: byType.TRUTH ?? { pro: 0, con: 0 },
        value: byType.VALUE ?? { pro: 0, con: 0 },
      },
    }));
    const bettors = new Set(stakes.stakes.map(s => s.user.id || s.user.username)).size;
    setMessageBettorCounts(prev => ({ ...prev, [messageId]: bettors }));
  }, []);

  async function blockCorrectionForSecondBettor(messageId: string): Promise<boolean> {
    try {
      const stakes = await api.getMessageStakes(messageId);
      mergeStakeSnapshot(messageId, stakes);
      const bettors = new Set(stakes.stakes.map(stake => stake.user.id || stake.user.username)).size;
      if (bettors >= 2) {
        showAlert('目标消息已有第二位用户押注，不能再发送更正消息');
        return true;
      }
    } catch {
      // The backend remains authoritative when the best-effort refresh fails.
    }
    return false;
  }

  // Phase 5: Refs to avoid stale closure in points-navigate handler
  // (initialized empty; values synced via useEffect below after all useMemos run)
  const focusEntriesRef = useRef<FocusEntry[]>([]);
  const classifyRelMsgIdRef = useRef<string | null>(null);
  const relationsRef = useRef<Relation[]>([]);
  const relationByIdRef = useRef<Map<string, Relation>>(new Map());
  const relationTypeByRelMsgIdRef = useRef<Map<string, string>>(new Map());

  // Phase 5: Listen for points-navigate custom event (in-place navigation from PointsBadge)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        messageId: string; topicId: string; roundId: string | null; txType: string;
        txData?: Record<string, unknown> | null; username?: string;
      };
      const { messageId, roundId, txType, txData, username } = detail;

      // Read latest state from refs (avoids stale closure)
      const currentRelations = relationsRef.current;
      const currentRelationById = relationByIdRef.current;

      // ── Smart classify enter/exit ──
      const currentClassifyId = classifyRelMsgIdRef.current;
      if (currentClassifyId) {
        const owned = collectOwnedByRelation(currentClassifyId, currentRelationById);
        const allOwnedIds = new Set([...owned.textIds, ...owned.relationIds]);
        if (!allOwnedIds.has(messageId)) {
          exitClassifyTopic({ restoreSnapshot: false });
        }
      }

      // Auto-enter classify if target belongs to one (and not already in one)
      if (!classifyRelMsgIdRef.current) {
        for (const rel of currentRelations) {
          const rt = rel.relationType?.toUpperCase();
          if (rt !== 'CLASSIFY' && rt !== 'SUMMARY') continue;
          const targets = (rel.targetRefs ?? []) as TargetRef[];
          if (targets.some(t => (t.kind === 'message' || t.kind === 'text-fragment') && t.messageId === messageId)) {
            enterClassifyTopic(rel.id);
            break;
          }
        }
      }

      // Clear existing draft and select target message
      setDraftUnits([{ messageId: messageId, selection: { kind: "whole" } }]);
      setActiveTextSelectId(null);
      pendingScrollMsgRef.current = messageId;

      // Phase 5: Open settlement panel for all stake/vote/settlement transactions
      const settlementTypes = ['STAKE_LOCK', 'VOTE_LOCK', 'SETTLEMENT_GAIN', 'SETTLEMENT_LOSS', 'CLAWBACK'];
      const highlightMessageTypes = ['MINT', 'STAKE_LOCK', 'VOTE_LOCK'];

      if (settlementTypes.includes(txType)) {
        openSettlement(messageId);
        if (roundId) sessionStorage.setItem('settlementHighlightRound', roundId);

        // Extract settlement entry highlight from txData
        const highlight: { side?: 'PRO' | 'CON'; vote?: 'TRUE' | 'FALSE'; username?: string; stakeId?: string; voteId?: string } = {};
        if (txData?.side) highlight.side = txData.side as 'PRO' | 'CON';
        if (txData?.vote) highlight.vote = txData.vote as 'TRUE' | 'FALSE';
        if (txData?.stakeId) highlight.stakeId = txData.stakeId as string;
        if (txData?.voteId) highlight.voteId = txData.voteId as string;

        // For SETTLEMENT_GAIN/LOSS: derive highlight from settlementResult
        if (!highlight.side && !highlight.vote && txData?.settlementResult) {
          const result = txData.settlementResult as string;
          if (txType === 'SETTLEMENT_GAIN') {
            if (result === 'TRUE') { highlight.side = 'PRO'; highlight.vote = 'TRUE'; }
            else if (result === 'FALSE') { highlight.side = 'CON'; highlight.vote = 'FALSE'; }
          } else if (txType === 'SETTLEMENT_LOSS' || txType === 'CLAWBACK') {
            if (result === 'TRUE') { highlight.side = 'CON'; highlight.vote = 'FALSE'; }
            else if (result === 'FALSE') { highlight.side = 'PRO'; highlight.vote = 'TRUE'; }
          }
        }

        if (username) highlight.username = username;
        setSettlementEntryHighlight(Object.keys(highlight).length > 0 ? highlight : null);
        setTimeout(() => setSettlementEntryHighlight(null), 1000);
      } else {
        closeSettlement();
        setSettlementEntryHighlight(null);
      }

      // Phase 5: Message card highlight — any tx linked to a message gets a golden flash
      if (highlightMessageTypes.includes(txType) && txData?.messageId) {
        setStanceHighlight({ stanceMsgId: messageId, evidenceMsgIds: [] });
        if (stanceHighlightTimerRef.current) clearTimeout(stanceHighlightTimerRef.current);
        stanceHighlightTimerRef.current = setTimeout(() => {
          setStanceHighlight(null);
        }, 1000);
      } else if (!settlementTypes.includes(txType)) {
        setStanceHighlight(null);
      }
    };

    window.addEventListener('points-navigate', handler);
    return () => window.removeEventListener('points-navigate', handler);
  }, []);

  // Transitive vote stats drive both canvas visibility and JOIN recovery cost.
  const voteStats = useMemo(
    () => computeTransitiveVoteStats(edges, messages),
    [edges, messages]
  );
  const comparisonTargets = useMemo(
    () => Object.entries(voteStats)
      .filter(([, stats]) => stats.agreeCount + stats.disagreeCount > 0)
      .map(([id, stats]) => ({ message: messages.find(message => message.id === id), ...stats }))
      .filter((item): item is { message: DemoMessage; agreeCount: number; disagreeCount: number; agreeKey: string; disagreeKey: string } => {
        const message = item.message;
        if (!message) return false;
        return !isContentKind(message.kind);
      }),
    [messages, voteStats],
  );
  const comparisonStakeTotals = useMemo(() => {
    const totals = new Map<string, { agree: number; disagree: number }>();
    for (const edge of edges) {
      if (edge.relationType !== 'agree' && edge.relationType !== 'disagree') continue;
      const current = totals.get(edge.to.messageId) ?? { agree: 0, disagree: 0 };
      current[edge.relationType] += authorStakes[edge.relationMessageId] ?? 0;
      totals.set(edge.to.messageId, current);
    }
    return totals;
  }, [edges, authorStakes]);
  const comparisonRecommendedDisplay = useMemo(() => {
    if (!comparisonTargetId) return 'agree' as const;
    const totals = comparisonStakeTotals.get(comparisonTargetId);
    return totals && totals.disagree > totals.agree ? 'disagree' as const : 'agree' as const;
  }, [comparisonStakeTotals, comparisonTargetId]);
  const effectiveSuppressedRelIdsForLayout = useMemo(
    () => computeEffectiveSuppressedRelIds(edges, messages, displayUser?.username ?? null),
    [edges, messages, displayUser?.username],
  );
  const rejectedContainerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType !== 'CLASSIFY' && relation.relationType !== 'SUMMARY' && relation.relationType !== 'ARRANGE' && relation.relationType !== 'MERGE') continue;
      if (effectiveSuppressedRelIdsForLayout.has(relation.id)) ids.add(relation.id);
    }
    return ids;
  }, [relations, effectiveSuppressedRelIdsForLayout]);
  const rejectedJoinRelationIds = useMemo(
    () => new Set(getRejectedJoinRelationIds(relations, voteStats)),
    [relations, voteStats]
  );

  const stakeDefaultLoaded = useRef(false);
  const relationStakeMap = useRef<Record<string, number>>({});
  const subTypeStakeMap = useRef<Record<string, number>>({});
  const existingJoinCount = useMemo(() => {
    const containerTypes = new Set(['classify', 'summary', 'arrange', 'merge']);
    if (!relationType || !containerTypes.has(relationType)) return 0;
    const sourceContainer = sourceUnits
      .map(unit => relations.find(relation => relation.id === unit.messageId))
      .find(relation => relation?.relationType?.toUpperCase() === relationType.toUpperCase());
    if (!sourceContainer) return 0;
    const targets = draftUnits.length > 0 ? draftUnits : targetUnits;
    const targetIds = new Set(targets.map(target => target.messageId));
    return relations.filter(relation =>
      relation.relationType?.toUpperCase() === 'JOIN' &&
      relation.sourceMessageId === sourceContainer.id &&
      (relation.targetRefs as Array<{ kind?: string; messageId?: string }>).some(ref =>
        (ref.kind === 'message' || ref.kind === 'text-fragment') && ref.messageId && targetIds.has(ref.messageId)
      )
    ).length;
  }, [relationType, sourceUnits, targetUnits, draftUnits, relations]);
  const containerRelationTypes = new Set(['CLASSIFY', 'ARRANGE', 'MERGE', 'SUMMARY']);
  const appendContainerType = (() => {
    if (!relationType || !containerRelationTypes.has(relationType.toUpperCase())) return null;
    if (newMessageContent.trim().length > 0 || (draftUnits.length === 0 && targetUnits.length === 0)) return null;
    if (sourceUnits.length !== 1) return null;
    const source = relations.find(relation => relation.id === sourceUnits[0].messageId);
    return source?.relationType?.toUpperCase() === relationType.toUpperCase() ? relationType.toUpperCase() : null;
  })();
  const joinOnlyAction = appendContainerType !== null;
  const additionalAgreeTargetIds = useMemo(() => {
    if (relationType !== 'agree' || sourceUnits.length > 0) return [];
    const targets = draftUnits.length > 0 ? draftUnits : targetUnits;
    return getJoinRecoveryTargetIds(
      Array.from(new Set(targets.map(target => target.messageId))),
      relations,
      rejectedContainerIds,
    );
  }, [relationType, sourceUnits.length, draftUnits, targetUnits, relations, rejectedContainerIds]);

  const { effectiveMinStake, totalConsumption, stakeFeeAmountRef } = useStakeCalculation({
    relationType, secondaryRelationType, subType, draftUnits, targetUnits, newMessageContent,
    stakeAmount, relStakeAmount, relationStakeMap, subTypeStakeMap,
    existingJoinCount,
    joinOnlyAction,
    additionalAgreeTargetCount: additionalAgreeTargetIds.length,
    onRelStakeChange: (min) => { setMinSelfStake(min); setRelStakeAmount(min); },
    stakeDefaultLoaded,
  });

  useEffect(() => {
    if (!settlementOpenMsgId) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Keep panel open if clicking inside it or on the settlement toggle buttons
      if (
        target.closest('[data-settlement-panel]') ||
        target.closest('[data-settlement-toggle-truth]') ||
        target.closest('[data-settlement-toggle-value]') ||
        target.closest('[data-prompt-modal="true"]')
      ) return;
      closeSettlement();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [settlementOpenMsgId]);

  // Keep available points in sync + load rule default stake
  useEffect(() => {
    const update = () => {
      Promise.all([
        api.getPointsBalance(),
        api.getCurrentRules().catch(() => null),
      ]).then(([b, rule]) => {
        setAvailablePoints(b.points.available);
        // Set initial default from rule on first load only
        if (!stakeDefaultLoaded.current) {
          const defaultStake = (rule?.parameters as Record<string, unknown> | null)?.selfStakeOnCreate as number ?? 10;
          const map = (rule?.parameters as Record<string, unknown> | null)?.relationTypeMinStake as Record<string, number> | null;
          if (map) relationStakeMap.current = map;
          const subMap = (rule?.parameters as Record<string, unknown> | null)?.subTypeMinStake as Record<string, number> | null;
          if (subMap) subTypeStakeMap.current = subMap;
          const feeAmount = (rule?.parameters as Record<string, unknown> | null)?.stakeFeeAmount as number;
          if (typeof feeAmount === 'number') stakeFeeAmountRef.current = feeAmount;
          setMinSelfStake(defaultStake);
          setStakeAmount(Math.min(defaultStake, b.points.available));
          stakeDefaultLoaded.current = true;
        } else {
          // Clamp to available on refresh
          setStakeAmount(prev => {
            if (typeof prev !== 'number') return prev;
            return Math.max(minSelfStake, Math.min(prev, b.points.available));
          });
        }
      }).catch(() => {});
    };
    update();
    window.addEventListener('points-refresh', update);
    return () => window.removeEventListener('points-refresh', update);
  }, []);

  // Listen for stake count refreshes (triggered after vote/settle)
  useEffect(() => {
    const handler = (e: Event) => {
      const { messageId } = (e as CustomEvent<{ messageId: string }>).detail;
      api.getMessageStakes(messageId).then(s => {
        mergeStakeSnapshot(messageId, s);
      }).catch(() => {});
    };
    window.addEventListener('stakes-refresh', handler);
    return () => window.removeEventListener('stakes-refresh', handler);
  }, [mergeStakeSnapshot]);

  const currentFocusEntry = focusEntries.length > 0 ? focusEntries[focusEntries.length - 1] : null;
  const currentFocusIds = currentFocusEntry?.ids ?? null;
  const relationById = useMemo(() => new Map(relations.map(relation => [relation.id, relation])), [relations]);
  const msgMap = useMemo(() => {
    const map = new Map(messages.map(m => [m.id, m]));
    for (const relation of relations) {
      if (!map.has(relation.id)) map.set(relation.id, buildRelationDemoMessage(relation));
    }
    return map;
  }, [messages, relations]);

  const sendWarning = useMemo((): string | null => {
    if (relationType?.toUpperCase() !== 'DISAGREE') return null;
    const allTargetIds = [...targetUnits, ...draftUnits].map(u => u.messageId);
    const targetMsgs = allTargetIds.map(id => msgMap.get(id)).filter(Boolean) as DemoMessage[];
    const hasContainer = targetMsgs.some(m => m.kind === 'relation' && ['classify','summary','merge','arrange'].includes(m.relationType ?? ''));
    const hasRecommend = targetMsgs.some(m => m.kind === 'relation' && m.relationType === 'recommend');
    if (hasContainer) return '反对此容器：若反对超过赞同，容器将被驳回（隐藏内部消息）';
    if (hasRecommend) return '反对推荐标注：将转为冷藏标注（ARCHIVE）';
    return null;
  }, [relationType, targetUnits, draftUnits, msgMap]);
  const appendCreatedRelation = useCallback((backendRel: Relation) => {
    // Skip adding duplicate relations (deduplicated on backend)
    // When deduplicated, update the existing relation/message in state instead
    const isDedup = !!(backendRel as unknown as Record<string, unknown>).deduplicated;
    if (isDedup) {
      // Update existing relation and message with fresh data (e.g. incremented sendCount)
      relationsRef.current = relationsRef.current.map(r => r.id === backendRel.id ? backendRel : r);
      setRelations(prev => prev.map(r => r.id === backendRel.id ? backendRel : r));
      setMessages(prev => prev.map(m => m.id === backendRel.id ? buildRelationDemoMessage(backendRel) : m));
    } else {
      relationsRef.current = relationsRef.current.some(r => r.id === backendRel.id)
        ? relationsRef.current
        : [...relationsRef.current, backendRel];
      setRelations(prev => prev.some(r => r.id === backendRel.id) ? prev : [...prev, backendRel]);
      setMessages(prev => prev.some(m => m.id === backendRel.id) ? prev : [...prev, buildRelationDemoMessage(backendRel)]);
    }
    const relType = backendRel.relationType?.toUpperCase();
    const targetMsgIds: string[] = [];
    if (relType === 'AGREE' || relType === 'DISAGREE') {
      targetMsgIds.push(...backendRel.targetRefs
        .filter((ref) => 
          (ref.kind === 'message' || ref.kind === 'text-fragment') && 'messageId' in ref)
        .map(ref => (ref as { messageId: string }).messageId));
      targetMsgIds.push(...backendRel.targetRefs
        .filter((ref): ref is { kind: 'relation'; relationId: string } =>
          ref.kind === 'relation' && 'relationId' in ref)
        .map(ref => ref.relationId));
      // Add edge for AGREE/DISAGREE relation
      const srcMsgId = backendRel.sourceMessageId ?? null;
      const fromMsgId = srcMsgId || `anon:${backendRel.id}`;
      for (const mid of targetMsgIds) {
        const edge: DemoEdge = {
          id: nextId("edge"),
          relationMessageId: backendRel.id,
          relationType: relType.toLowerCase() as RelationType,
          from: { messageId: fromMsgId, selection: { kind: "whole" } },
          to: { messageId: mid, selection: { kind: "whole" } },
          relationLabel: relationTypeName(relType.toLowerCase()),
        };
        setEdges(prev => [...prev, edge]);
      }
    }
    // For RECOMMEND/ARCHIVE: populate targetMsgIds from text targets
    if (relType === 'RECOMMEND' || relType === 'ARCHIVE') {
      targetMsgIds.push(...backendRel.targetRefs
        .filter((ref) => 
          (ref.kind === 'message' || ref.kind === 'text-fragment') && 'messageId' in ref)
        .map(ref => (ref as { messageId: string }).messageId));
    }
    // Self-stake amount for the relation message itself
    const rawPayload2 = (backendRel as unknown as Record<string, unknown>).relationPayload
      ?? backendRel.payload;
    const relPayload2 = rawPayload2 as Record<string, unknown> | null;
    const selfStake = (relPayload2?.amount as number) ?? relStakeRef.current;
    setAuthorStakes(prev => ({ ...prev, [backendRel.id]: selfStake }));
    // Re-fetch stakeCounts from backend (authoritative, avoids client-side sync issues)
    const allIds = [backendRel.id, ...targetMsgIds];
    for (const mid of allIds) {
      api.getMessageStakes(mid).then(s => {
        mergeStakeSnapshot(mid, s);
      }).catch(() => {});
    }
    // For RECOMMEND/ARCHIVE: the stake is on the text target, so also mirror its
    // stake counts onto the annotation relation message for badge display.
    if (relType === 'RECOMMEND' || relType === 'ARCHIVE') {
      const textTarget = targetMsgIds[0];
      if (textTarget) {
        api.getMessageStakes(textTarget).then(s => {
          mergeStakeSnapshot(textTarget, s);
          const byType = s.countsByType ?? {};
          setStakeCounts(prev => ({
            ...prev,
            [backendRel.id]: {
              truth: byType.TRUTH ?? { pro: 0, con: 0 },
              value: byType.VALUE ?? { pro: 0, con: 0 },
            },
          }));
          const bettors = new Set(s.stakes.map(st => st.user.id || st.user.username)).size;
          setMessageBettorCounts(prev => ({ ...prev, [backendRel.id]: bettors }));
        }).catch(() => {});
      }
    }
    window.dispatchEvent(new Event('points-refresh'));
    // Notify SettlementPanel to reload stakes for target messages
    for (const mid of targetMsgIds) {
      window.dispatchEvent(new CustomEvent('stakes-refresh', { detail: { messageId: mid } }));
    }
    // Phase 6: auto-create settlement ROUND message card.
    // Skip if an un-settled ROUND card already exists for this target.
    // (Backend ensures SettlementRound via ensureVotingRound; frontend just creates the card.)
    if (topicId) {
      // For annotations (RECOMMEND/ARCHIVE), the settlement is on the text target, not the relation
      const isAnnotation = relType === 'RECOMMEND' || relType === 'ARCHIVE';
      const settleTargetId = (relType === 'AGREE' || relType === 'DISAGREE' || isAnnotation) && targetMsgIds.length > 0
        ? targetMsgIds[0]
        : backendRel.id;
      // Only count ROUND cards of the SAME settlement type (TRUTH vs VALUE)
      const roundSt = isAnnotation ? 'VALUE' : 'TRUTH';
      const rounds = messagesRef.current.filter(m =>
        m.kind === 'round' && m.settlementTargetId === settleTargetId
          && (m as any).roundPayload?.settlementType === roundSt
      );
      const results = messagesRef.current.filter(m =>
        m.kind === 'round_result' && m.settlementTargetId === settleTargetId
      );
      if (rounds.length <= results.length) {
        const relAuthor = backendRel.createdBy?.username ?? '?';
        const roundPromise = new Promise<string | null>((resolve) => {
          api.createMessage(topicId!, { kind: 'ROUND', content: undefined, targetMessageId: settleTargetId, settlementType: roundSt }).then(roundMsg => {
            setMessages((prev: any) => [...prev, {
              id: roundMsg.id,
              author: roundMsg.createdBy?.username || relAuthor,
              createdAt: roundMsg.createdAt,
              content: kindLabel('ROUND', undefined, roundSt),
              kind: 'round',
              backendKind: 'ROUND',
              settlementTargetId: settleTargetId,
              roundPayload: { settlementType: roundSt, roundId: (roundMsg as any).relationPayload?.roundId },
            }]);
            scrollMsgToCenter(settleTargetId);
            resolve(roundMsg.id);
          }).catch(() => resolve(null));
        });
        return roundPromise;
      }
    }
    return Promise.resolve(null);
  }, [topicId, mergeStakeSnapshot]);

  const createRel = useCallback(async (topicId: string, data: Parameters<typeof api.createRelation>[1]) => {
    const amount = relStakeRef.current;
    try {
      return await api.createRelation(topicId, { ...data, stakeAmount: amount });
    } catch (e: any) {
      const isTokenFailure = e instanceof ApiError && e.status === 401 && (
        e.code === 'AUTH_TOKEN_MISSING'
        || e.code === 'AUTH_TOKEN_INVALID'
        || e.code === 'AUTH_TOKEN_EXPIRED'
      );
      if (isTokenFailure) {
        logout();
        navigate('/login', { state: { reason: e.message } });
      }
      throw e;
    }
  }, [logout, navigate]);

  // Listen for relation-created events (triggered after vote creates AGREE/DISAGREE relation)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Relation>).detail;
      if (detail && detail.id && detail.relationType) {
        appendCreatedRelation(detail);
        // For RECOMMEND/ARCHIVE from voting: create edge for badge display
        const rt = detail.relationType?.toUpperCase();
        if (rt === 'RECOMMEND' || rt === 'ARCHIVE') {
          const isDup = !!(detail as unknown as Record<string, unknown>).deduplicated;
          if (!isDup) {
            const targetIds = detail.targetRefs
              .filter(ref => (ref.kind === 'message' || ref.kind === 'text-fragment') && 'messageId' in ref)
              .map(ref => (ref as { messageId: string }).messageId);
            const anonSrcId = `anon:${detail.id}`;
            setEdges(prev => {
              const newEdges = targetIds.filter(mid =>
                !prev.some(e => e.relationMessageId === detail.id && e.to.messageId === mid)
              ).map(mid => ({
                id: nextId("edge"),
                relationMessageId: detail.id,
                relationType: rt.toLowerCase() as RelationType,
                from: { messageId: anonSrcId, selection: { kind: "whole" as const } },
                to: { messageId: mid, selection: { kind: "whole" as const } },
                relationLabel: relationTypeName(rt.toLowerCase()),
              }));
              return [...prev, ...newEdges];
            });
          }
        }
      }
    };
    window.addEventListener('relation-created', handler);
    return () => window.removeEventListener('relation-created', handler);
  }, [appendCreatedRelation]);

  // Per-edge corrected index: old relation-message ID → set of corrected edge IDs.
  // Used to skip corrected fragments when double-clicking to select all fragments.
  const correctedEdgeMap = useMemo(() => computeCorrectedEdgeMap(edges), [edges]);
  const lastInheritedEdgeSignatureRef = useRef<string>('');

  useEffect(() => {
    if (edges.length === 0) return;
    const inherited = applyTextCorrectionInheritance(edges, msgMap);
    const signature = inherited.map(e =>
      `${e.id}::${e.relationMessageId}::${e.relationType}::${selKey(e.from)}::${selKey(e.to)}::${e.relationLabel}`
    ).join('|');
    if (inherited !== edges && signature !== lastInheritedEdgeSignatureRef.current) {
      lastInheritedEdgeSignatureRef.current = signature;
      setEdges(inherited);
      return;
    }
    if (inherited === edges) {
      lastInheritedEdgeSignatureRef.current = signature;
    }
  }, [edges, msgMap, setEdges]);

  /** Returns edge IDs for a relation message, excluding any that have been individually corrected. */
  function getUncorrectedEdgeIds(relationMessageId: string): string[] {
    const correctedIds = correctedEdgeMap.get(relationMessageId);
    return getEdgeIdsForRelation(relationMessageId).filter(id => !correctedIds?.has(id));
  }

  // TAG-only source messages in the linear list view: messages used exclusively as old-style
  // TAG relation sources should not appear as list items (their label is shown on the tag badge).
  const tagSourceIdsForList = useMemo(() => {
    const hiddenTagSourceIds = new Set<string>();
    const shouldKeepVisible = new Set<string>();
    for (const e of edges) {
      const fromKind = msgMap.get(e.from.messageId)?.kind;
      const toKind = msgMap.get(e.to.messageId)?.kind;
      if (e.relationType === "tag" && fromKind && isContentKind(fromKind as MessageKind)) {
        hiddenTagSourceIds.add(e.from.messageId);
      }
      if (toKind && isContentKind(toKind as MessageKind)) shouldKeepVisible.add(e.to.messageId);
      if (e.relationType !== "tag" && fromKind && isContentKind(fromKind as MessageKind)) {
        shouldKeepVisible.add(e.from.messageId);
      }
    }
    for (const id of shouldKeepVisible) hiddenTagSourceIds.delete(id);
    return hiddenTagSourceIds;
  }, [edges, msgMap]);

  const userPreferredJoinByTarget = useMemo(
    () => getUserPreferredJoinByTarget(relations, computeUserActiveStanceRelIds(edges, messages, displayUser?.username ?? null), displayUser?.username ?? null),
    [edges, messages, relations, displayUser?.username]
  );
  const effectiveJoinRelationIds = useMemo(
    () => getEffectiveJoinRelationIds(relations, rejectedContainerIds, rejectedJoinRelationIds, userPreferredJoinByTarget),
    [relations, rejectedContainerIds, rejectedJoinRelationIds, userPreferredJoinByTarget]
  );

  const joinRelationsByTarget = useMemo(() => {
    const map = new Map<string, Relation[]>();
    for (const message of messages) {
      const joins = getJoinRelationsForMessage(message.id, relations);
      if (joins.length > 0) map.set(message.id, joins);
    }
    return map;
  }, [messages, relations]);
  const joinRelationsBySource = useMemo(() => {
    const map = new Map<string, Relation[]>();
    for (const relation of relations) {
      if (relation.relationType?.toUpperCase() !== 'JOIN' || !relation.sourceMessageId) continue;
      const existing = map.get(relation.sourceMessageId) ?? [];
      existing.push(relation);
      map.set(relation.sourceMessageId, existing);
    }
    return map;
  }, [relations]);

  const readStatusByMessageId = useMemo(() => {
    const latest = new Map<string, { type: 'READ' | 'UNREAD'; createdAt: string }>();
    if (!user?.id) return new Map<string, 'READ' | 'UNREAD'>();
    for (const relation of relations) {
      const type = relation.relationType?.toUpperCase();
      if ((type !== 'READ' && type !== 'UNREAD') || relation.createdBy.id !== user.id) continue;
      for (const target of relation.targetRefs) {
        if (target.kind !== 'message' && target.kind !== 'text-fragment') continue;
        const previous = latest.get(target.messageId);
        if (!previous || new Date(relation.createdAt).getTime() >= new Date(previous.createdAt).getTime()) {
          latest.set(target.messageId, { type, createdAt: relation.createdAt });
        }
      }
    }
    return new Map([...latest].map(([id, value]) => [id, value.type]));
  }, [relations, user?.id]);

  const joinStatusByMessage = useMemo(() => {
    const map = new Map<string, 'valid'>();
    for (const relation of relations) {
      if (relation.relationType?.toUpperCase() !== 'JOIN') continue;
      if (effectiveJoinRelationIds.has(relation.id)) map.set(relation.id, 'valid');
    }
    return map;
  }, [relations, effectiveJoinRelationIds]);

  // Real-time: if the previewed classify becomes active (no longer rejected),
  // exit preview mode so the user gets full interaction capabilities.
  useEffect(() => {
    if (previewClassifyId && !rejectedContainerIds.has(previewClassifyId)) {
      setPreviewClassifyId(null);
    }
  }, [rejectedContainerIds, previewClassifyId]);

  const relationTypeByRelMsgId = useMemo(() => {
    const map = new Map<string, RelationType>();
    for (const relation of relations) {
      map.set(relation.id, relation.relationType.toLowerCase() as RelationType);
    }
    return map;
  }, [relations]);

  // Phase 5: Keep refs in sync with derived state for points-navigate handler
  focusEntriesRef.current = focusEntries;
  classifyRelMsgIdRef.current = classifyRelMsgId;
  relationsRef.current = relations;
  relationByIdRef.current = relationById;
  relationTypeByRelMsgIdRef.current = relationTypeByRelMsgId as unknown as Map<string, string>;
  const replacedRelationMsgIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of edges) {
      if (e.relationType !== "correct") continue;
      if (e.from.messageId.startsWith("anon:")) continue;
      const fromKind = msgMap.get(e.from.messageId)?.kind;
      const toKind = msgMap.get(e.to.messageId)?.kind;
      if (fromKind === "relation" && toKind === "relation") ids.add(e.to.messageId);
    }
    return ids;
  }, [edges, msgMap]);
  // Full ownership: all CLASSIFY relations regardless of approval status.
  // Used by preview mode and auto-classify to find targets even in rejected classifies.
  const classifyOwnership = useMemo(() => {
    const textIds = new Set<string>();
    const relationIds = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType !== 'CLASSIFY') continue;
      const owned = collectOwnedByRelation(relation.id, relationById, new Set(), undefined, rejectedJoinRelationIds, userPreferredJoinByTarget);
      owned.textIds.forEach(id => textIds.add(id));
      owned.relationIds.forEach(id => relationIds.add(id));
    }
    return { textIds, relationIds };
  }, [relations, relationById, userPreferredJoinByTarget]);

  // Active ownership: only non-rejected CLASSIFY relations.
  // Used by visibility logic — rejected classifies don't hide their messages.
  const activeClassifyOwnership = useMemo(() => {
    const textIds = new Set<string>();
    const relationIds = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType !== 'CLASSIFY') continue;
      if (rejectedContainerIds.has(relation.id)) continue;
      const owned = collectOwnedByRelation(relation.id, relationById, new Set(), rejectedContainerIds, rejectedJoinRelationIds, userPreferredJoinByTarget);
      owned.textIds.forEach(id => textIds.add(id));
      owned.relationIds.forEach(id => relationIds.add(id));
    }
    return { textIds, relationIds };
  }, [relations, relationById, rejectedContainerIds, rejectedJoinRelationIds, userPreferredJoinByTarget]);
  const mergeOwnership = useMemo(() => {
    const textIds = new Set<string>();
    const relationIds = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType !== 'MERGE') continue;
      const owned = collectOwnedByRelation(relation.id, relationById, new Set(), undefined, rejectedJoinRelationIds, userPreferredJoinByTarget);
      owned.textIds.forEach(id => textIds.add(id));
      owned.relationIds.forEach(id => relationIds.add(id));
    }
    return { textIds, relationIds };
  }, [relations, relationById, userPreferredJoinByTarget]);
  // Full ownership: all SUMMARY relations regardless of approval status.
  const summaryOwnership = useMemo(() => {
    const textIds = new Set<string>();
    const relationIds = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType !== 'SUMMARY') continue;
      const owned = collectOwnedByRelation(relation.id, relationById, new Set(), undefined, rejectedJoinRelationIds, userPreferredJoinByTarget);
      owned.textIds.forEach(id => textIds.add(id));
      owned.relationIds.forEach(id => relationIds.add(id));
    }
    return { textIds, relationIds };
  }, [relations, relationById, userPreferredJoinByTarget]);

  // Active ownership: only non-rejected SUMMARY relations.
  const activeSummaryOwnership = useMemo(() => {
    const textIds = new Set<string>();
    const relationIds = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType !== 'SUMMARY') continue;
      if (rejectedContainerIds.has(relation.id)) continue;
      const owned = collectOwnedByRelation(relation.id, relationById, new Set(), rejectedContainerIds, rejectedJoinRelationIds, userPreferredJoinByTarget);
      owned.textIds.forEach(id => textIds.add(id));
      owned.relationIds.forEach(id => relationIds.add(id));
    }
    return { textIds, relationIds };
  }, [relations, relationById, rejectedContainerIds, rejectedJoinRelationIds, userPreferredJoinByTarget]);
  const summaryCoverageByMessageId = useMemo(() => {
    const map = new Map<string, Array<{ summaryId: string; title: string }>>();
    for (const relation of relations) {
      if (relation.relationType !== 'SUMMARY') continue;
      const targetIds = new Set<string>();
      for (const ref of relation.targetRefs as TargetRef[]) {
        if (ref.kind === 'relation') targetIds.add(ref.relationId);
        else targetIds.add(ref.messageId);
      }
      const title = getRelationTitle(relation.payload) || `总结（${targetIds.size}）`;
      for (const targetId of targetIds) {
        const existing = map.get(targetId) ?? [];
        existing.push({ summaryId: relation.id, title });
        map.set(targetId, existing);
      }
    }
    return map;
  }, [relations]);

  // Expand classify/summary ownership text IDs to include text messages that have
  // CORRECT (更正) relations with any already-owned message. This ensures that when
  // T1 is classified/summarized, the correcting message T2 (and the CORRECT relation
  // message) are automatically treated as part of the same group.
  const activeClassifyOwnershipTextIdsExpanded = useMemo(
    () => {
      const base = expandTextIdsWithCorrections(activeClassifyOwnership.textIds, edges, msgMap);
      return expandTextIdsWithSettlementResults(base, messages);
    },
    [activeClassifyOwnership, edges, msgMap, messages]
  );
  const activeSummaryOwnershipTextIdsExpanded = useMemo(
    () => expandTextIdsWithCorrections(activeSummaryOwnership.textIds, edges, msgMap),
    [activeSummaryOwnership, edges, msgMap]
  );

  const classifiedTargetTextIds = activeClassifyOwnershipTextIdsExpanded;
  const classifiedTargetClassifyRelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    activeClassifyOwnership.relationIds.forEach(id => {
      if (relationById.get(id)?.relationType.toUpperCase() === 'CLASSIFY') ids.add(id);
    });
    return ids;
  }, [activeClassifyOwnership, relationById]);
  const classifiedTargetMergeRelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    activeClassifyOwnership.relationIds.forEach(id => {
      if (relationById.get(id)?.relationType.toUpperCase() === 'MERGE') ids.add(id);
    });
    return ids;
  }, [activeClassifyOwnership, relationById]);
  const classifiedTargetARRANGERelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    activeClassifyOwnership.relationIds.forEach(id => {
      if (relationById.get(id)?.relationType.toUpperCase() === 'ARRANGE') ids.add(id);
    });
    return ids;
  }, [activeClassifyOwnership, relationById]);
  const classifiedTargetSummaryRelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    activeClassifyOwnership.relationIds.forEach(id => {
      if (relationById.get(id)?.relationType.toUpperCase() === 'SUMMARY') ids.add(id);
    });
    return ids;
  }, [activeClassifyOwnership, relationById]);

  function collectExclusiveRelationMsgIds(hiddenTextIds: Set<string>, ownedRelationIds: Set<string>) {
    const ids = new Set<string>();
    const edgesByRel = new Map<string, DemoEdge[]>();
    for (const e of edges) {
      const arr = edgesByRel.get(e.relationMessageId) ?? [];
      arr.push(e);
      edgesByRel.set(e.relationMessageId, arr);
    }
    for (const [relMsgId, relEdges] of edgesByRel) {
      const relType = String(relEdges[0]?.relationType ?? '').toLowerCase();
      if (relType === 'classify' || relType === 'summary' || relType === 'merge' || relType === 'join') continue;
      if (ownedRelationIds.has(relMsgId)) continue;
      const textEndpoints = relEdges
        .flatMap(e => [e.from.messageId, e.to.messageId])
        .filter(mid => { const m = msgMap.get(mid); return m && isContentKind(m.kind); });
      if (textEndpoints.length > 0) {
        if (relType === 'reference') {
          // Cross-topic REFERENCE: only hide the relation message when its source
          // (from) message is classified/hidden.  If the source is visible but the
          // target is in another classify topic, the reference should still appear
          // alongside the source in the linear and graph views.
          const sourceHidden = relEdges.some(e => {
            const fromM = msgMap.get(e.from.messageId);
            return fromM && isContentKind(fromM.kind) && (hiddenTextIds.has(e.from.messageId) || ownedRelationIds.has(e.from.messageId));
          });
          if (sourceHidden) {
            ids.add(relMsgId);
          }
        } else if (textEndpoints.some(mid => hiddenTextIds.has(mid))) {
          ids.add(relMsgId);
        }
        continue;
      }
      // No text endpoints — all targets are relation messages.
      // Hide if any target relation is owned by a CLASSIFY/SUMMARY.
      const relEndpoints = relEdges
        .flatMap(e => [e.from.messageId, e.to.messageId])
        .filter(mid => msgMap.get(mid)?.kind === 'relation');
      if (relEndpoints.some(mid => ownedRelationIds.has(mid))) {
        ids.add(relMsgId);
      }
    }
    return ids;
  }

  const listExclusiveRelMsgIds = useMemo(
    () => collectExclusiveRelationMsgIds(activeClassifyOwnershipTextIdsExpanded, activeClassifyOwnership.relationIds),
    [edges, msgMap, activeClassifyOwnershipTextIdsExpanded, activeClassifyOwnership.relationIds]
  );
  const graphHiddenTextIds = useMemo(() => {
    const ids = new Set<string>(activeClassifyOwnershipTextIdsExpanded);
    activeSummaryOwnershipTextIdsExpanded.forEach(id => ids.add(id));
    // MERGE displays as a group frame whose targets remain visible as cards on the canvas,
    // so mergeOwnership.textIds is intentionally excluded here.
    return ids;
  }, [activeClassifyOwnershipTextIdsExpanded, activeSummaryOwnershipTextIdsExpanded]);

  const graphOwnedRelationIds = useMemo(() => {
    const ids = new Set<string>(activeClassifyOwnership.relationIds);
    mergeOwnership.relationIds.forEach(id => ids.add(id));
    activeSummaryOwnership.relationIds.forEach(id => ids.add(id));
    return ids;
  }, [activeClassifyOwnership, mergeOwnership, activeSummaryOwnership]);
  const graphExclusiveRelMsgIds = useMemo(
    () => collectExclusiveRelationMsgIds(graphHiddenTextIds, graphOwnedRelationIds),
    [edges, msgMap, graphHiddenTextIds, graphOwnedRelationIds]
  );

  const leftPanelRef = useRef<HTMLDivElement | null>(null);
  const leftPanelTouchRef = useRef<{ x: number; y: number } | null>(null);
  const [documentHorizontalScrollVisible, setDocumentHorizontalScrollVisible] = useState(false);
  const leftHorizontalScrollRef = useRef<HTMLDivElement | null>(null);
  const leftHorizontalScrollSourceRef = useRef<HTMLElement | null>(null);
  const leftHorizontalScrollScaleRef = useRef(1);
  const [leftHorizontalScrollMetrics, setLeftHorizontalScrollMetrics] = useState({ visible: false, left: 0, width: 0, scrollWidth: 1 });
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
  const [messagePulse, setMessagePulse] = useState<{ element: HTMLElement; rect: DOMRect; visualRoot: HTMLElement | null; visualRect: DOMRect } | null>(null);
  const messagePulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagePulseRafRef = useRef<number | null>(null);
  // Saved scroll positions for each view mode, so switching modes does not reset to top.
  const viewModeScrollRef = useRef<{ graph: { top: number; left: number } | null; list: { top: number; left: number } | null }>({ graph: null, list: null });
  const prevFocusLenRef = useRef(0);
  const lastAddedFragmentRef = useRef<{ messageId: string; unit: UnitSelection; time: number } | null>(null);
  const mouseDownRef = useRef<{ x: number; y: number; messageId: string | null } | null>(null);
  const lastDragOrSelectTimeRef = useRef<number>(0);
  const lastClickActionsRef = useRef<{ type: "toggleWhole"; messageId: string; prevExisted: boolean; time: number }[]>([]);
  const TOTAL_FLEX = 4;
  const MIN_LEFT_FLEX = 0.6;
  const MAX_LEFT_FLEX = TOTAL_FLEX - MIN_LEFT_FLEX;
  const [leftFlex, setLeftFlex] = useState(TOTAL_FLEX / 2);
  const MIN_RIGHT_PX = 280;
  const MAX_RIGHT_PX = 500;
  const BASE_WIDTH = 1024;
  const [containerWidth, setContainerWidth] = useState(() => {
    const saved = localStorage.getItem('topicWidth');
    return saved ? Number(saved) : BASE_WIDTH;
  });
  const [splitterActive, setSplitterActive] = useState(false);
  const panelContainerRef = useRef<HTMLDivElement | null>(null);
  const splitterDragRef = useRef<{ startX: number; startFlex: number } | null>(null);
  // Ref to track the ID of a newly sent message that should be scrolled into view.
  const pendingScrollMsgIdRef = useRef<string | null>(null);
  // Track pending requestAnimationFrame handles so they can be cancelled before
  // React reconciles the DOM, preventing "removeChild" errors caused by stale
  // rAF callbacks accessing nodes that React has already removed.
  const scrollRafRef = useRef<number | null>(null);
  const scrollRaf2Ref = useRef<number | null>(null);

  function cancelScrollRafs() {
    if (scrollRafRef.current !== null) { cancelAnimationFrame(scrollRafRef.current); scrollRafRef.current = null; }
    if (scrollRaf2Ref.current !== null) { cancelAnimationFrame(scrollRaf2Ref.current); scrollRaf2Ref.current = null; }
  }

  // Cleanup on unmount
  useEffect(() => () => { cancelScrollRafs(); }, []);
  // Persist containerWidth to localStorage
  useEffect(() => { localStorage.setItem('topicWidth', String(containerWidth)); }, [containerWidth]);

  // Check auth before sending: redirect to login if not logged in
  function requireAuth(): boolean {
    const token = localStorage.getItem('token');
    if (!user || !token) {
      logout();
      navigate('/login', { state: { reason: '发送消息需要登录' } });
      return false;
    }
    return true;
  }

  // Handle auth errors: logout and redirect to login
  async function handleAuthError(err: unknown) {
    const apiError = err as { status?: number; code?: string; message?: string };
    const authFailureCodes = new Set([
      'AUTH_TOKEN_MISSING',
      'AUTH_TOKEN_INVALID',
      'AUTH_TOKEN_EXPIRED',
    ]);
    if (apiError.status === 401 && authFailureCodes.has(apiError.code ?? '')) {
      await logout();
      navigate('/login', {
        state: {
          reason: `认证失败：${apiError.message ?? '登录令牌无效或已过期'}。请求接口：${(err as any)?.path ?? '未知'}`,
        },
      });
      return true;
    }
    return false;
  }

  // Scroll the left panel canvas so the message with the given ID is centered.
  // Polls via requestAnimationFrame until the card appears in the DOM.
  // MAX_SCROLL_ATTEMPTS × ~16ms/frame ≈ 1 second maximum wait time.
  const MAX_SCROLL_ATTEMPTS = 60;

  function showMessagePulse(targetId: string, element: HTMLElement) {
    if (messagePulseTimerRef.current) clearTimeout(messagePulseTimerRef.current);
    if (messagePulseRafRef.current) cancelAnimationFrame(messagePulseRafRef.current);
    messagePulseRafRef.current = requestAnimationFrame(() => {
      messagePulseRafRef.current = null;
      let pulseElement = element;
      if (!pulseElement.isConnected) {
        const currentCandidates = Array.from(leftPanelRef.current?.querySelectorAll(
          `[data-msgid="${targetId}"], [data-jump-msgids~="${targetId}"]`
        ) ?? []) as HTMLElement[];
        pulseElement = currentCandidates.find(candidate =>
          candidate.hasAttribute('data-rel-overlay') && candidate.getAttribute('data-msgid') === targetId,
        ) ?? currentCandidates.find(candidate => candidate.hasAttribute('data-rel-overlay'))
          ?? currentCandidates[0];
      }
      if (!pulseElement?.isConnected) return;
      const targetElements = Array.from(leftPanelRef.current?.querySelectorAll(
        pulseElement.hasAttribute('data-rel-overlay')
          ? `[data-msgid="${targetId}"][data-rel-overlay]`
          : `[data-msgid="${targetId}"], [data-jump-msgids~="${targetId}"]`
      ) ?? []);
      const targetRects = targetElements
        .map(candidate => (candidate as HTMLElement).getBoundingClientRect())
        .filter(candidateRect => candidateRect.width > 0 && candidateRect.height > 0);
      const rect = targetRects.reduce((bounds, candidateRect) => {
        const left = Math.min(bounds.left, candidateRect.left);
        const top = Math.min(bounds.top, candidateRect.top);
        const right = Math.max(bounds.right, candidateRect.right);
        const bottom = Math.max(bounds.bottom, candidateRect.bottom);
        return new DOMRect(left, top, right - left, bottom - top);
      }, pulseElement.getBoundingClientRect());
      const visualRoot = pulseElement.hasAttribute('data-rel-overlay')
        ? pulseElement.closest('[data-jump-canvas]') as HTMLElement | null
        : null;
      const visualRect = rect;
      setMessagePulse({ element: pulseElement, rect, visualRoot, visualRect });
      messagePulseTimerRef.current = setTimeout(() => {
        setMessagePulse(null);
        messagePulseTimerRef.current = null;
      }, 500);
    });
  }

  function resolveScrollTargetMessageId(msgId: string): string {
    return resolveNavigationTargetId(msgId, messagesRef.current, relationsRef.current);
  }

  function findMessageElements(container: HTMLElement, messageId: string): HTMLElement[] {
    return Array.from(container.querySelectorAll('[data-msgid], [data-jump-msgids]'))
      .filter(node => {
        const element = node as HTMLElement;
        const directId = element.getAttribute('data-msgid');
        const jumpIds = element.getAttribute('data-jump-msgids')?.split(/\s+/) ?? [];
        return directId === messageId || jumpIds.includes(messageId);
      }) as HTMLElement[];
  }

  function scrollMsgToCenter(msgId: string, options?: { resolveTarget?: boolean; dependencyIds?: string[] }) {
    const targetId = options?.resolveTarget === false ? msgId : resolveScrollTargetMessageId(msgId);
    const dependencyIds = options?.dependencyIds ?? [];
    pendingScrollMsgIdRef.current = targetId;
    let attempts = 0;
    const tryScroll = () => {
      attempts++;
      if (attempts > MAX_SCROLL_ATTEMPTS) {
        pendingScrollMsgIdRef.current = null;
        pendingScrollDependencyIdsRef.current = [];
        return;
      }
      if (pendingScrollMsgIdRef.current !== targetId) return; // superseded by newer message
      const container = leftPanelRef.current;
      if (!container) { scrollRafRef.current = requestAnimationFrame(tryScroll); return; }
      const containerRect = container.getBoundingClientRect();
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const containerOutsideViewport = containerRect.bottom <= 0
        || containerRect.top >= viewportHeight
        || containerRect.right <= 0
        || containerRect.left >= viewportWidth;
      if (containerOutsideViewport) {
        container.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        scrollRafRef.current = requestAnimationFrame(tryScroll);
        return;
      }
      const dependencyReady = dependencyIds.every(dependencyId =>
        findMessageElements(container, dependencyId).some(element => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }),
      );
      if (!dependencyReady) { scrollRafRef.current = requestAnimationFrame(tryScroll); return; }
      const candidates = findMessageElements(container, targetId);
      const targetRelation = relationsRef.current.find(relation => relation.id === targetId);
      const targetEdge = edgesRef.current.find(edge => edge.relationMessageId === targetId);
      const isDecorationTarget = targetRelation
        ? ['AGREE', 'DISAGREE', 'CORRECT'].includes(targetRelation.relationType.toUpperCase())
          || getPresentationSpec(targetRelation.relationType).kind === 'inline-badge'
        : ['AGREE', 'DISAGREE', 'CORRECT'].includes(targetEdge?.relationType?.toUpperCase() ?? '');
      const comparisonPair = container.querySelector('[data-comparison-pair]');
      const comparisonCandidates = candidates.filter(candidate => candidate.closest('[data-comparison-view="agree"]'));
      const overlayCandidates = candidates.filter(candidate => candidate.hasAttribute('data-rel-overlay'));
      const directOverlayCandidates = overlayCandidates.filter(candidate => candidate.getAttribute('data-msgid') === targetId);
      const overlayComparisonCandidates = comparisonCandidates.filter(candidate => candidate.hasAttribute('data-rel-overlay'));
      const preferredCandidates = isDecorationTarget
        ? (directOverlayCandidates.length > 0 ? directOverlayCandidates : overlayCandidates.length > 0 ? overlayCandidates : candidates)
        : candidates;
      const preferredComparisonCandidates = isDecorationTarget && overlayComparisonCandidates.length > 0
        ? overlayComparisonCandidates
        : comparisonCandidates;
      const el = comparisonPair
        ? preferredComparisonCandidates[0] ?? null
        : isDecorationTarget
          ? preferredCandidates[0] ?? null
          : preferredCandidates.find(candidate => !candidate.hasAttribute('data-rel-overlay')) ?? preferredCandidates[0] ?? null;
      if (!el) { scrollRafRef.current = requestAnimationFrame(tryScroll); return; }
      const elRect = el.getBoundingClientRect();
      if (elRect.width === 0 || elRect.height === 0) {
        scrollRafRef.current = requestAnimationFrame(tryScroll);
        return;
      }
      pendingScrollMsgIdRef.current = null;
      const comparisonView = el.closest('[data-comparison-view="agree"]');
      const comparisonViewport = comparisonView?.querySelector('[data-comparison-viewport="agree"]') as HTMLDivElement | null;
        const comparisonPairElement = comparisonView?.closest('[data-comparison-pair]');
        if (comparisonViewport && comparisonPairElement) {
        const comparisonViewportRect = comparisonViewport.getBoundingClientRect();
        const comparisonTargetTop = comparisonViewport.scrollTop + elRect.top - comparisonViewportRect.top + elRect.height / 2 - comparisonViewport.clientHeight / 2;
        const comparisonTargetLeft = comparisonViewport.scrollLeft + elRect.left - comparisonViewportRect.left + elRect.width / 2 - comparisonViewport.clientWidth / 2;
        const comparisonTop = Math.max(0, comparisonTargetTop);
        const comparisonLeft = Math.max(0, comparisonTargetLeft);
          const comparisonScrollTargets = comparisonPairElement.querySelectorAll('[data-comparison-viewport], [data-comparison-scroll-vertical]');
        comparisonScrollTargets.forEach(node => { (node as HTMLElement).scrollTop = comparisonTop; });
          const horizontalScroll = comparisonPairElement.querySelector('[data-comparison-scroll-horizontal]') as HTMLElement | null;
          const horizontalTargets = comparisonPairElement.querySelectorAll('[data-comparison-viewport], [data-comparison-scroll-horizontal]');
        horizontalTargets.forEach(node => { (node as HTMLElement).scrollLeft = comparisonLeft; });
        if (horizontalScroll) horizontalScroll.scrollLeft = comparisonLeft;
      } else {
        const elCenterX = elRect.left - containerRect.left + container.scrollLeft + elRect.width / 2;
        const elCenterY = elRect.top - containerRect.top + container.scrollTop + elRect.height / 2;
        container.scrollLeft = Math.max(0, Math.min(elCenterX - container.clientWidth / 2, container.scrollWidth - container.clientWidth));
        container.scrollTop = Math.max(0, Math.min(elCenterY - container.clientHeight / 2, container.scrollHeight - container.clientHeight));
      }
      // The left panel may itself be only partly visible in the browser viewport.
      // Re-read after the inner scroll, then move the outer page if the target is
      // still outside the actual viewport before creating the jump overlay.
      requestAnimationFrame(() => {
        let currentElement = el;
        if (!currentElement.isConnected) {
          const currentCandidates = findMessageElements(container, targetId);
          currentElement = currentCandidates.find(candidate =>
            isDecorationTarget && candidate.hasAttribute('data-rel-overlay')
              && candidate.getAttribute('data-msgid') === targetId,
          ) ?? currentCandidates.find(candidate => isDecorationTarget && candidate.hasAttribute('data-rel-overlay'))
            ?? currentCandidates[0];
        }
        if (!currentElement?.isConnected) return;
        const currentRect = currentElement.getBoundingClientRect();
        const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const targetOutsideViewport = currentRect.bottom <= 0
          || currentRect.top >= viewportHeight
          || currentRect.right <= 0
          || currentRect.left >= viewportWidth;
        if (targetOutsideViewport) {
          currentElement.scrollIntoView({ block: 'center', inline: 'nearest' });
          requestAnimationFrame(() => {
            showMessagePulse(targetId, currentElement);
          });
          return;
        }
        showMessagePulse(targetId, currentElement);
      });
      // The left panel handles the inner scroll; the target scrollIntoView above
      // handles the outer page when the panel itself is outside the viewport.
    };
    cancelScrollRafs();
    scrollRafRef.current = requestAnimationFrame(tryScroll);
  }

  function captureSnapshot(): FocusSnapshot {
    return {
      viewMode,
      leftScroll: leftPanelRef.current ? { top: leftPanelRef.current.scrollTop, left: leftPanelRef.current.scrollLeft } : null,
      leftHorizontalScroll: leftHorizontalScrollSourceRef.current?.scrollLeft
        ?? leftHorizontalScrollRef.current?.scrollLeft
        ?? null,
      rightScroll: rightPanelRef.current ? { top: rightPanelRef.current.scrollTop, left: rightPanelRef.current.scrollLeft } : null,
      draftUnits: draftUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })),
      sourceUnits: sourceUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })),
      targetUnits: targetUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })),
      activeTextSelectId,
      lastClickedMessageId,
      focusHop,
    };
  }

  function clampAndSetScroll(container: HTMLDivElement | null, top: number | null, left: number | null) {
    if (!container) return;
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    if (top !== null) container.scrollTop = Math.min(Math.max(0, top), maxTop);
    if (left !== null) container.scrollLeft = Math.min(Math.max(0, left), maxLeft);
  }

  function clampAndSetHorizontalScroll(container: HTMLElement | null, left: number | null) {
    if (!container || left === null) return;
    const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    container.scrollLeft = Math.min(Math.max(0, left), maxLeft);
  }

  function restoreSnapshot(s: FocusSnapshot | null, opts?: { restoreSelection?: boolean }) {
    if (!s) return;
    const restoreSel = opts?.restoreSelection !== false; // 默认 true，焦点模式恢复候选区
    if (restoreSel) {
      setDraftUnits(s.draftUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })));
      setSourceUnits(s.sourceUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })));
      setTargetUnits(s.targetUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })));
    }
    setActiveTextSelectId(s.activeTextSelectId);
    setLastClickedMessageId(s.lastClickedMessageId);
    setFocusHop(s.focusHop);
    setViewMode(s.viewMode);
    // Cancel any in-flight scroll rAF before scheduling new ones so that stale
    // callbacks never touch DOM nodes after React has reconciled them away.
    cancelScrollRafs();
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRaf2Ref.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        scrollRaf2Ref.current = null;
        clampAndSetScroll(leftPanelRef.current, s.leftScroll?.top ?? null, s.leftScroll?.left ?? null);
        clampAndSetHorizontalScroll(leftHorizontalScrollSourceRef.current, s.leftHorizontalScroll);
        clampAndSetHorizontalScroll(
          leftHorizontalScrollRef.current,
          s.leftHorizontalScroll === null
            ? null
            : s.leftHorizontalScroll * leftHorizontalScrollScaleRef.current,
        );
        clampAndSetScroll(rightPanelRef.current, s.rightScroll?.top ?? null, s.rightScroll?.left ?? null);
      });
    });
  }

  function enterTemporaryCategory(force = false) {
    const isTemporaryCategoryActive = joinFilterTargetId !== null
      || correctionFilterTargetId !== null
      || comparisonMode
      || comparisonReviewed;
    if (isTemporaryCategoryActive && !force) return;
    temporaryCategoryStackRef.current.push({
      snapshot: captureSnapshot(),
      joinFilterTargetId,
      joinFilterDirection,
      correctionFilterTargetId,
      comparisonMode,
      comparisonReviewed,
      comparisonTargetId,
      comparisonSide,
      comparisonReviewBaseMessages,
      comparisonReviewBaseEdges,
    });
  }

  function exitTemporaryCategory() {
    const entry = temporaryCategoryStackRef.current.pop();
    if (!entry) return;
    setJoinFilterTargetId(entry.joinFilterTargetId);
    setJoinFilterDirection(entry.joinFilterDirection);
    setCorrectionFilterTargetId(entry.correctionFilterTargetId);
    setComparisonMode(entry.comparisonMode);
    setComparisonReviewed(entry.comparisonReviewed);
    setComparisonTargetId(entry.comparisonTargetId);
    setComparisonSide(entry.comparisonSide);
    setComparisonReviewBaseMessages(entry.comparisonReviewBaseMessages);
    setComparisonReviewBaseEdges(entry.comparisonReviewBaseEdges);
    restoreSnapshot(entry.snapshot);
  }

  function enterFocus(messageId: string, options?: { replace?: boolean; mode?: "focus" | "topic"; topicRelMsgId?: string }) {
    if (!messageId) return;
    operationLog(`进入${options?.mode === 'topic' ? '分类' : '焦点'}`, `message=${messageId}`);
    const snapshot = captureSnapshot();
    const entry: FocusEntry = { ids: [messageId], snapshot, mode: options?.mode ?? "focus", topicRelMsgId: options?.topicRelMsgId };
    setFocusEntries(prev => options?.replace ? [entry] : [...prev, entry]);
  }

  function enterFocusMultiple(messageIds: string[], options?: { replace?: boolean; mode?: "focus" | "topic"; topicRelMsgId?: string }) {
    if (!messageIds || messageIds.length === 0) return;
    operationLog(`进入${options?.mode === 'topic' ? '分类' : '焦点'}`, `messages=${messageIds.join(',')}`);
    const snapshot = captureSnapshot();
    const entry: FocusEntry = { ids: messageIds, snapshot, mode: options?.mode ?? "focus", topicRelMsgId: options?.topicRelMsgId };
    setFocusEntries(prev => options?.replace ? [entry] : [...prev, entry]);
    // Bump exit key to force GraphView clean remount when entering focus,
    // avoiding React 18 concurrent reconciliation removeChild errors.
    setFocusKey(k => k + 1);
  }

  function exitFocus() {
    // Pop the focus stack and bump the exit key to force GraphView remount,
    // avoiding React 18 concurrent reconciliation bugs (removeChild errors).
    const entry = focusEntries.length > 0 ? focusEntries[focusEntries.length - 1] : null;
    const snapshot = entry?.snapshot ?? null;
    operationLog('退出焦点', `depth=${focusEntries.length}`);
    setFocusEntries(prev => {
      if (prev.length === 0) return prev;
      return prev.slice(0, -1);
    });
    setFocusKey(k => k + 1);
    if (snapshot) restoreSnapshot(snapshot, { restoreSelection: true });
  }

  function exitAllFocus() {
    const snapshot = focusEntries.length > 0 ? focusEntries[0].snapshot : null;
    operationLog('退出全部焦点', `depth=${focusEntries.length}`);
    setFocusEntries(prev => {
      if (prev.length === 0) return prev;
      return [];
    });
    setFocusKey(k => k + 1);
    if (snapshot) restoreSnapshot(snapshot);
  }

  function clearDraftAll() {
    setDraftUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  }

  const isFragmentSelected = useCallback((messageId: string, start: number, len: number, text: string) => {
    const u: UnitSelection = { messageId, selection: { kind: "text", start, len, text } };
    return draftUnits.some(x => unitEquals(x, u));
  }, [draftUnits]);

  function toggleFragmentSelection(messageId: string, start: number, len: number, text: string) {
    const u: UnitSelection = { messageId, selection: { kind: "text", start, len, text } };
    setDraftUnits(prev => {
      const exists = prev.some(x => unitEquals(x, u));
      if (!exists && sourceUnits.some(unit => unit.messageId === messageId)) {
        setSendError('消息已在来源集合中，不能同时加入候选暂存区');
        return prev;
      }
      return exists ? prev.filter(x => !unitEquals(x, u)) : [...prev, u];
    });
  }

  /**
   * When inside a CLASSIFY / SUMMARY topic focus, register a newly created
   * message or relation as a target of the parent CLASSIFY/SUMMARY so it
   * stays scoped inside the topic after exit.
   *
   * @param newTargetRef  The new target to append (message or relation).
   * @param onUpdated     Optional callback invoked after the superseding
   *                      relation replaces the old one in state. Receives
   *                      the new relation ID.
   */
  function addTargetToClassifyTopic(
    newTargetRef: TargetRef,
    onUpdated?: (newRelId: string) => void,
  ): Promise<void> | void {
    const currentClassifyId = latestClassifyRelMsgIdRef.current;
    if (!currentClassifyId || !topicId) return;
    const topicRelation = relationsRef.current.find(r => r.id === currentClassifyId);
    if (!topicRelation) return;
    const existingRefs = (topicRelation.targetRefs ?? []) as TargetRef[];
    const exists = existingRefs.some(ref => {
      if (newTargetRef.kind === 'relation') {
        return ref.kind === 'relation' && ref.relationId === newTargetRef.relationId;
      }
      return (ref.kind === 'message' || ref.kind === 'text-fragment') && ref.messageId === newTargetRef.messageId;
    });
    if (exists) {
      onUpdated?.(currentClassifyId);
      return;
    }
    const updatedRefs = [...existingRefs, newTargetRef];

    // Update targetRefs in-place via PATCH — preserves the relation's ID
    // so stance records, classify stack, and other references stay valid.
    return api.patchRelationTargets(topicId, currentClassifyId, updatedRefs)
      .then(updatedRel => {
        // Update relations in local state (ID unchanged)
        const updated = { ...topicRelation, targetRefs: updatedRefs };
        relationsRef.current = relationsRef.current.map(r =>
          r.id === currentClassifyId ? updated : r
        );
        setRelations(prev => prev.map(r =>
          r.id === currentClassifyId ? updated : r
        ));
        // Update the DemoMessage display content
        setMessages(prev => prev.map(m =>
          m.id === currentClassifyId ? buildRelationDemoMessage(updatedRel) : m
        ));
        // Add CLASSIFY edge from the classify to the new target, but only
        // on the main canvas (not inside another classify sub-canvas).
        if (!isInsideClassify) {
          const edgeTargetId = newTargetRef.kind === 'relation'
            ? newTargetRef.relationId
            : newTargetRef.messageId;
          const anonSrcId = `anon:${currentClassifyId}`;
          const newEdge: DemoEdge = {
            id: nextId("edge"),
            relationMessageId: currentClassifyId,
            relationType: "classify" as RelationType,
            from: { messageId: anonSrcId, selection: { kind: "whole" as const } },
            to: { messageId: edgeTargetId, selection: { kind: "whole" as const } },
            relationLabel: relationTypeName("classify"),
          };
          setEdges(prev => {
            // Avoid duplicate
            const key = `${newEdge.relationMessageId}::${newEdge.to.messageId}`;
            if (prev.some(e => `${e.relationMessageId}::${e.to.messageId}` === key)) return prev;
            return [...prev, newEdge];
          });
        }
        onUpdated?.(currentClassifyId);
      })
      .catch(e => console.warn('更新分类目标失败:', e));
  }

  async function registerCreatedRelationInCurrentClassify(backendRel: Relation): Promise<string | null> {
    const roundId = await appendCreatedRelation(backendRel);
    const isDedup = !!(backendRel as unknown as Record<string, unknown>).deduplicated;
    if (!isDedup) {
      const rt = backendRel.relationType?.toUpperCase();
      const isGovOps = rt === 'PROPOSAL' || rt === 'CODE_CHANGE' || rt === 'OPERATIONS';
      const isDecoration = new Set([
        'AGREE', 'DISAGREE', 'TAG', 'READ', 'UNREAD', 'ANNOTATION', 'REFERENCE',
        'REPLY', 'NOTIFY', 'CORRECT', 'RECOMMEND', 'ARCHIVE', 'ATTENTION', 'BLOCK',
      ]).has(rt ?? '');
      if (isInsideClassify && currentClassifyRelMsgId && !isDecoration) {
        await attachMessageToCurrentClassify(isGovOps ? backendRel.id : backendRel.id);
      }
    }
    if (roundId) {
      await attachMessageToCurrentClassify(roundId);
    }
    return roundId;
  }

  async function attachMessageToCurrentClassify(messageId: string) {
    if (!isInsideClassify || !currentClassifyRelMsgId || !messageId) return;
    const currentClassifyRel = relationsRef.current.find(r => r.id === currentClassifyRelMsgId);
    if (!currentClassifyRel) return;
    const joinType = currentClassifyRel.relationType?.toUpperCase() === 'SUMMARY' ? 'SUMMARY' : 'CLASSIFY';

    // A message sent inside a container is completed by one JOIN request:
    // source=container, target=message. The backend records the container
    // target in the same transaction as the JOIN message.
    await createJoinRelationsForContainer(currentClassifyRelMsgId, joinType, [messageId]);
  }

  async function createSettlementRoundForMessage(
    settleTargetId: string,
    fallbackAuthor: string,
    settlementType: 'TRUTH' | 'VALUE' = 'TRUTH',
  ): Promise<string | null> {
    if (!topicId) return null;
    const rounds = messagesRef.current.filter(m =>
      m.kind === 'round' && m.settlementTargetId === settleTargetId
        && ((m as any).roundPayload?.settlementType ?? 'TRUTH') === settlementType
    );
    const results = messagesRef.current.filter(m =>
      m.kind === 'round_result' && m.settlementTargetId === settleTargetId
    );
    if (rounds.length > results.length) return null;
    const roundMsg = await api.createMessage(topicId, {
      kind: 'ROUND',
      content: undefined,
      targetMessageId: settleTargetId,
      settlementType,
    });
    setMessages((prev: any) => [...prev, {
      id: roundMsg.id,
      author: roundMsg.createdBy?.username || fallbackAuthor,
      createdAt: roundMsg.createdAt,
      content: kindLabel('ROUND', undefined, settlementType),
      kind: 'round',
      backendKind: 'ROUND',
      settlementTargetId: settleTargetId,
      roundPayload: { settlementType, roundId: (roundMsg as any).relationPayload?.roundId },
    }]);
    if (isInsideClassify && currentClassifyRelMsgId) {
      await attachMessageToCurrentClassify(roundMsg.id);
      setClassifyKey(k => k + 1);
    }
    scrollMsgToCenter(settleTargetId);
    return roundMsg.id;
  }

  async function handleSendMessageOnly(overrideContent?: string): Promise<DemoMessage | null> {
    if (!requireAuth()) return null;
    const text = overrideContent ?? newMessageContent;
    if (text.trim().length === 0) return null;
    if (!topicId) return null;
    const pts = typeof stakeAmount === 'number' ? stakeAmount : 0;
    if (pts < 10) {
      setSendError('文本消息最低押注为 10 点');
      return null;
    }
    const totalNeeded = pts + stakeFeeAmountRef.current + (isInsideClassify ? 1 + stakeFeeAmountRef.current : 0);
    if (totalNeeded > availablePoints) {
      const parts = [`文本 ${pts}`, `协议费 ${stakeFeeAmountRef.current}`];
      if (isInsideClassify) parts.push(`加入容器 ${1 + stakeFeeAmountRef.current}`);
      setSendError(`贡献点余额不足（可用 ${availablePoints}，需要 ${totalNeeded} 点 = ${parts.join(' + ')}）`);
      return null;
    }
    setSendError(null);
    try {
      const backendMsg = await api.createMessage(topicId, { content: text, contentType: 'TEXT', stakeAmount: pts });
      operationLog('发送消息', `message=${backendMsg.id} length=${text.length} stake=${pts}`);
      const msg: DemoMessage = {
        id: backendMsg.id,
        author: backendMsg.createdBy.username,
        createdAt: backendMsg.createdAt,
        content: backendMsg.content,
        kind: "normal",
      };
      setMessages(prev => [...prev, msg]);
      // Fetch real stake counts from backend (not optimistic)
      api.getMessageStakes(msg.id).then(s => {
        mergeStakeSnapshot(msg.id, s);
        setAuthorStakes(prev => ({ ...prev, [msg.id]: s.stakes.find(st => st.side === 'PRO' && st.user.username === msg.author)?.amount ?? 0 }));
      }).catch(() => {});
      // Reset to rule default
      setStakeAmount(minSelfStake);
      if (isInsideClassify) {
        if (currentClassifyRelMsgId) {
          try {
            // Create a join message on the main canvas that adds the new message
            // to the current classify. This is the primary ownership action.
            await attachMessageToCurrentClassify(msg.id);
          } catch (e: any) {
            setSendError(`加入容器记录创建失败: ${e?.message ?? e}`);
            setTimeout(() => setSendError(null), 4000);
          }
        }
        setClassifyKey(k => k + 1); // force StructureView remount AFTER classify updated
      }
      if (!overrideContent) setNewMessageContent("");
      scrollMsgToCenter(msg.id);
      window.dispatchEvent(new Event('points-refresh'));
      // Phase 6: auto-create settlement ROUND message card (skip if already exists)
      const rounds = messagesRef.current.filter(m =>
        m.kind === 'round' && m.settlementTargetId === msg.id
      );
      const results = messagesRef.current.filter(m =>
        m.kind === 'round_result' && m.settlementTargetId === msg.id
      );
      if (rounds.length <= results.length) {
        try {
          const roundMsg = await api.createMessage(topicId, { kind: 'ROUND', content: undefined, targetMessageId: msg.id, settlementType: 'TRUTH' });
          setMessages((prev: any) => [...prev, {
            id: roundMsg.id,
            author: roundMsg.createdBy?.username || msg.author,
            createdAt: roundMsg.createdAt,
            content: kindLabel('ROUND', undefined, 'TRUTH'),
            kind: 'round',
            backendKind: 'ROUND',
            settlementTargetId: msg.id,
            roundPayload: { settlementType: 'TRUTH', roundId: (roundMsg as any).relationPayload?.roundId },
          }]);
          await attachMessageToCurrentClassify(roundMsg.id);
          scrollMsgToCenter(msg.id);
        } catch { /* round creation optional */ }
      }
      return msg;
    } catch (e: any) {
      if (await handleAuthError(e)) return null;
      const detail = e instanceof ApiError
        ? `${e.message}（HTTP ${e.status}，接口 ${e.path}${e.code ? `，错误码 ${e.code}` : ''}）`
        : (e?.message ?? '发送失败');
      setSendError(detail);
      setTimeout(() => setSendError(null), 4000);
      return null;
    }
  }

  function handleMessageMouseDown(e: React.MouseEvent, messageId: string) {
    if (e.button !== 0) return;
    mouseDownRef.current = { x: e.clientX, y: e.clientY, messageId };
  }

  function undoRecentClickActionsForMessage(messageId: string) {
    const now = Date.now(); const windowMs = 600;
    const arr = lastClickActionsRef.current;
    if (!arr || arr.length === 0) return;
    const indices: number[] = [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const a = arr[i];
      if (now - a.time > windowMs) continue;
      if (a.messageId === messageId) indices.push(i);
    }
    if (indices.length === 0) return;
    setDraftUnits(prev => {
      let cur = [...prev];
      for (const idx of indices) {
        const a = arr[idx];
        if (a.type === "toggleWhole") {
          const wholeUnit: UnitSelection = { messageId: a.messageId, selection: { kind: "whole" } };
          if (a.prevExisted) { if (!cur.some(u => unitEquals(u, wholeUnit))) cur.push(wholeUnit); }
          else { cur = cur.filter(u => !unitEquals(u, wholeUnit)); }
        }
      }
      return cur;
    });
    lastClickActionsRef.current = arr.filter((_v, idx) => !indices.includes(idx));
  }

  function handleMessageMouseUp(e: React.MouseEvent, messageId: string) {
    if (!mouseDownRef.current) return;
    const md = mouseDownRef.current; mouseDownRef.current = null;
    if (md.messageId !== messageId) return;
    const dx = Math.abs(md.x - e.clientX), dy = Math.abs(md.y - e.clientY);
    const moved = dx > 6 || dy > 6;
    if (moved) { lastDragOrSelectTimeRef.current = Date.now(); undoRecentClickActionsForMessage(messageId); }
  }

  function handleMessageClick(e: React.MouseEvent, messageId: string) {
    if (e.button !== 0) return;
    if (Date.now() - lastDragOrSelectTimeRef.current < 350) return;
    e.stopPropagation();
    if (comparisonMode) {
      setComparisonTargetId(messageId);
      setComparisonReviewed(false);
      setComparisonReviewBaseMessages(null);
      setComparisonReviewBaseEdges(null);
      setComparisonSide('agree');
      setLastClickedMessageId(messageId);
      setDraftUnits([{ messageId, selection: { kind: 'whole' } }]);
      return;
    }
    setLastClickedMessageId(messageId);
    const wholeUnit: UnitSelection = { messageId, selection: { kind: "whole" } };
    setDraftUnits(prev => {
      const exists = prev.some(u => unitEquals(u, wholeUnit));
      if (!exists && sourceUnits.some(unit => unit.messageId === messageId)) {
        setSendError('消息已在来源集合中，不能同时加入候选暂存区');
        return prev;
      }
      const next = exists ? prev.filter(u => !unitEquals(u, wholeUnit)) : [...prev, wholeUnit];
      lastClickActionsRef.current.push({ type: "toggleWhole", messageId, prevExisted: exists, time: Date.now() });
      const now = Date.now();
      lastClickActionsRef.current = lastClickActionsRef.current.filter(a => now - a.time < 2000);
      return next;
    });
  }

  function handleMessageDoubleClick(e: React.MouseEvent, messageId: string) {
    e.stopPropagation();
    undoRecentClickActionsForMessage(messageId);
    const m = msgMap.get(messageId);
    setLastClickedMessageId(messageId);
    const currentlyActive = activeTextSelectId === messageId;
    if (m?.kind === "relation") {
      // Use msg.relationType directly — more reliable than relationTypeByRelMsgId
      // which depends on edges and can be stale after ErrorBoundary recovery.
      const relType = m.relationType;
      if (relType === "correct") {
        if (viewMode === "list") {
          setComparisonPopup({ relMsgId: messageId, x: e.clientX, y: e.clientY });
          return;
        }
        const targetId = edges.find(edge => edge.relationMessageId === messageId)?.to.messageId;
        if (targetId) {
          enterTemporaryCategory(true);
          setJoinFilterTargetId(null);
          setCorrectionFilterTargetId(targetId);
          setViewMode("list");
        }
        return;
      }
      if (relType === "classify" || relType === "summary") {
        if (relationType === "correct") {
          // In correction mode, the container card is the selectable text target;
          // do not navigate away from the current canvas.
          if (currentlyActive) { setActiveTextSelectId(null); clearBrowserSelection(); }
          else setActiveTextSelectId(messageId);
          return;
        }
        // Always clear any text selection before entering classification to prevent
        // the browser's native double-click text selection from persisting into the new view.
        setActiveTextSelectId(null);
        clearBrowserSelection();
        enterClassifyTopic(messageId);
        // If entering a rejected classify, enter preview mode
        if (rejectedContainerIds.has(messageId)) {
          setPreviewClassifyId(messageId);
        }
        return;
      }
      if (relType === "merge") {
        // Rejected MERGE: just toggle active state, no special action needed
        if (currentlyActive) { setActiveTextSelectId(null); clearBrowserSelection(); }
        return;
      }
      if (currentlyActive) { setActiveTextSelectId(null); clearBrowserSelection(); }
      return;
    }
    // Phase 6: settlement → switch to list view + gold highlight + open panel
    if (m?.kind === "round" || m?.kind === "round_result") {
      if (currentlyActive) { setActiveTextSelectId(null); clearBrowserSelection(); }
      const targetId = (m as any).settlementTargetId || messageId;
      setLastClickedMessageId(targetId);
      setStanceHighlight({ stanceMsgId: targetId, evidenceMsgIds: [] });
      if (stanceHighlightTimerRef.current) clearTimeout(stanceHighlightTimerRef.current);
      stanceHighlightTimerRef.current = setTimeout(() => setStanceHighlight(null), 1000);
      // Switch to linear view so settlement panel has room to expand
      setViewMode("list");
      // Highlight specific round in settlement panel
      const rp = (m as any).roundPayload;
      const roundIdToHighlight = rp?.roundId ?? (m.kind === 'round_result' ? messageId : null);
      if (roundIdToHighlight) sessionStorage.setItem('settlementHighlightRound', roundIdToHighlight as string);
      const classifyRel = relations.find(r =>
        r.relationType === 'CLASSIFY' &&
        (r.targetRefs as Array<{ messageId?: string }>).some(t => t.messageId === targetId)
      );
      if (classifyRel) enterClassifyTopic(classifyRel.id);
      // Use round's own settlementType to open the correct panel (TRUTH or VALUE)
      const stype = (rp?.settlementType as 'TRUTH' | 'VALUE') ?? 'TRUTH';
      if (settlementOpenMsgId === targetId) { closeSettlement(); } else { openSettlement(targetId, stype); }
      return;
    }
    if (currentlyActive) {
      const laf = lastAddedFragmentRef.current;
      if (laf && laf.messageId === messageId && Date.now() - laf.time < 450) {
        setDraftUnits(prev => prev.filter(u => !unitEquals(u, laf.unit)));
        lastAddedFragmentRef.current = null;
      }
      setActiveTextSelectId(null); clearBrowserSelection(); return;
    }
    setActiveTextSelectId(messageId); clearBrowserSelection();
  }

  function handleTextMouseUp(e: React.MouseEvent, messageId: string) {
    if (!activeTextSelectId || activeTextSelectId !== messageId) return;
    const m = msgMap.get(messageId);
    const correctableRelationTypes = new Set(['classify', 'summary', 'proposal', 'delegation', 'code_change', 'operations']);
    const canSelectCorrectionText = m?.kind === 'normal'
      || (m?.kind === 'relation' && correctableRelationTypes.has(m.relationType ?? ''));
    if (!m || !canSelectCorrectionText) return;
    const container = e.currentTarget as HTMLElement;
    const frag = getSelectionFragment(container);
    clearBrowserSelection();
    if (!frag || frag.len <= 0) return;
    const fragmentUnit: UnitSelection = { messageId, selection: { kind: "text", start: frag.start, len: frag.len, text: frag.text } };
    setDraftUnits(prev => {
      const exists = prev.some(u => unitEquals(u, fragmentUnit));
      if (!exists && sourceUnits.some(unit => unit.messageId === messageId)) {
        setSendError('消息已在来源集合中，不能同时加入候选暂存区');
        return prev;
      }
      return exists ? prev.filter(u => !unitEquals(u, fragmentUnit)) : [...prev, fragmentUnit];
    });
    lastAddedFragmentRef.current = { messageId, unit: fragmentUnit, time: Date.now() };
    lastDragOrSelectTimeRef.current = Date.now();
    undoRecentClickActionsForMessage(messageId);
  }

  function handleFragmentAnchorClick(messageId: string, start: number, len: number, text: string) {
    setActiveTextSelectId(messageId); clearBrowserSelection();
    toggleFragmentSelection(messageId, start, len, text);
    setLastClickedMessageId(messageId);
    undoRecentClickActionsForMessage(messageId);
  }

  function commitDraftTo(role: "source" | "target") {
    if (draftUnits.length === 0) return;
    const oppositeUnits = role === "source" ? targetUnits : sourceUnits;
    const oppositeMessageIds = new Set(oppositeUnits.map(unit => unit.messageId));
    if (draftUnits.some(unit => oppositeMessageIds.has(unit.messageId))) {
      setSendError(`消息已在${role === "source" ? "目标" : "来源"}集合中，不能同时加入${role === "source" ? "来源" : "目标"}集合`);
      return;
    }
    if (role === "source") setSourceUnits(prev => mergeUnits(prev, draftUnits));
    else setTargetUnits(prev => mergeUnits(prev, draftUnits));
    setDraftUnits([]); setActiveTextSelectId(null);
  }

  function removeUnitFrom(role: "source" | "target", unit: UnitSelection) {
    const update = (list: UnitSelection[]) => list.filter(u => !unitEquals(u, unit));
    if (role === "source") setSourceUnits(prev => update(prev));
    else setTargetUnits(prev => update(prev));
  }

  function removeUnitFromDraft(unit: UnitSelection) {
    setDraftUnits(prev => prev.filter(u => !unitEquals(u, unit)));
  }

  function getGroupedTargetTextMessageIds(units: UnitSelection[]): string[] {
    const ids = new Set<string>();
    for (const unit of foldUpToWhole(units)) {
      if (msgMap.get(unit.messageId)?.kind && isContentKind(msgMap.get(unit.messageId)!.kind)) {
        ids.add(unit.messageId);
        continue;
      }
      const relType = relationTypeByRelMsgId.get(unit.messageId);
      if (relType !== "classify" && relType !== "merge" && relType !== "arrange" && relType !== "summary") continue;
      const owned = collectOwnedByRelation(unit.messageId, relationById);
      owned.textIds.forEach(id => ids.add(id));
    }
    return [...ids];
  }

  function getClassifyTargetRefs(units: UnitSelection[]): TargetRef[] {
    const res: TargetRef[] = [];
    const seen = new Set<string>();
    for (const u of foldUpToWhole(units)) {
      const mid = u.messageId;
      const m = msgMap.get(mid);
      if (!m) continue;
      if (m.kind && isContentKind(m.kind)) {
        const key = `message:${mid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        res.push({ kind: "message", messageId: mid });
        continue;
      }
      const relType = relationTypeByRelMsgId.get(mid);
      if (relType !== "classify" && relType !== "merge" && relType !== "arrange" && relType !== "summary") {
        // Non-container relation types (proposal, code_change, operations etc.)
        // are treated as relation-kind targets — they become opaque cards when classified.
        if (relType !== undefined) {
          const key = "relation:" + mid;
          if (!seen.has(key)) {
            seen.add(key);
            res.push({ kind: "relation", relationId: mid });
          }
        }
        continue;
      }
      // All container types (classify/summary/arrange/merge): add as a single
      // relation-kind target.  The container itself joins the parent — its
      // children do NOT get individual join relations to the parent.
      const key = `relation:${mid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      res.push({ kind: "relation", relationId: mid });
    }
    return res;
  }

  /**
   * Check whether any selected text messages have non-reference edges to
   * already-classified text messages that are NOT part of the current selection.
   *
   * Defensive expansion: when a selected text message is connected via an edge
   * to a classify/merge/arrange/summary relation message, the relation's
   * owned text messages are also treated as "selected".  This prevents false
   * positives when getGroupedTargetTextMessageIds has already expanded the
   * selection but an edge exists between a selected text and a classified text
   * that belongs to the same relation group.
   */
  function hasCrossNonReferenceTextLinkForClassifyTargets(targetTextIds: string[]): boolean {
    if (targetTextIds.length === 0) return false;
    const selected = new Set(targetTextIds);

    // Defensive expansion: when a selected normal message has an edge to an
    // expandable relation message (classify/merge/arrange/summary), treat
    // that relation's owned text messages as also selected.
    const expandableTypes = new Set(['classify', 'merge', 'arrange', 'summary']);
    for (const e of edges) {
      const fromMsg = msgMap.get(e.from.messageId);
      const toMsg = msgMap.get(e.to.messageId);
      const fromIsSelectedNormal = fromMsg && isContentKind(fromMsg.kind) && selected.has(e.from.messageId);
      const toIsSelectedNormal = toMsg && isContentKind(toMsg.kind) && selected.has(e.to.messageId);
      const relationEndpoint = fromIsSelectedNormal
        ? (toMsg?.kind === 'relation' && expandableTypes.has(toMsg.relationType ?? '') ? e.to.messageId : null)
        : toIsSelectedNormal
          ? (fromMsg?.kind === 'relation' && expandableTypes.has(fromMsg.relationType ?? '') ? e.from.messageId : null)
          : null;
      if (!relationEndpoint) continue;
      const owned = collectOwnedByRelation(relationEndpoint, relationById);
      for (const ownedTextId of owned.textIds) {
        if (!selected.has(ownedTextId)) selected.add(ownedTextId);
      }
    }

    for (const e of edges) {
      // Skip reference and correct edges: reference is a citation that does
      // not imply semantic grouping; correct edges are already handled by
      // expandTextIdsWithCorrections and should not trigger cross-link blocks.
      if (e.relationType === "reference" || e.relationType === "correct") continue;
      const fromKind = msgMap.get(e.from.messageId)?.kind;
      const toKind = msgMap.get(e.to.messageId)?.kind;
      if (fromKind !== "normal" || toKind !== "normal") continue;
      const fromSelected = selected.has(e.from.messageId);
      const toSelected = selected.has(e.to.messageId);
      if (fromSelected !== toSelected) {
        const nonTargetMessageId = fromSelected ? e.to.messageId : e.from.messageId;
        if (classifiedTargetTextIds.has(nonTargetMessageId)) return true;
      }
    }
    return false;
  }

  function enterClassifyTopic(relMsgId: string) {
    // Save snapshot so we can restore on exit
    classifyStackRef.current.push({ relMsgId, snapshot: captureSnapshot() });
    setClassifyRelMsgId(relMsgId);
    setClassifyKey(k => k + 1);
  }
  function findContainingClassifyTopic(messageId: string): string | null {
    const targetRelation = relationById.get(messageId);
    let anchorId = messageId;
    if (targetRelation) {
      const relationType = targetRelation.relationType.toUpperCase();
      const sourceId = targetRelation.sourceMessageId ?? null;
      const firstTarget = (targetRelation.targetRefs ?? []).find(ref =>
        ref.kind === 'message' || ref.kind === 'text-fragment' || ref.kind === 'relation',
      );
      const targetId = firstTarget?.kind === 'relation'
        ? firstTarget.relationId
        : firstTarget?.messageId;
      if (['ANNOTATION', 'REFERENCE', 'REPLY', 'CORRECT'].includes(relationType)) {
        anchorId = sourceId || messageId;
      } else if (['AGREE', 'DISAGREE', 'TAG'].includes(relationType)) {
        anchorId = targetId || messageId;
      }
    }
    let match: { id: string; size: number } | null = null;
    for (const relation of relations) {
      if (relation.relationType !== 'CLASSIFY' || rejectedContainerIds.has(relation.id)) continue;
      const owned = collectOwnedByRelation(
        relation.id,
        relationById,
        new Set(),
        rejectedContainerIds,
        rejectedJoinRelationIds,
        userPreferredJoinByTarget,
      );
      if (!owned.textIds.has(anchorId) && !owned.relationIds.has(anchorId)) continue;
      const size = owned.textIds.size + owned.relationIds.size;
      if (!match || size < match.size) match = { id: relation.id, size };
    }
    return match?.id ?? null;
  }

  function exitClassifyTopic(_options?: { restoreSnapshot?: boolean }) {
    const entry = classifyStackRef.current.pop();
    const prev = classifyStackRef.current.length > 0
      ? classifyStackRef.current[classifyStackRef.current.length - 1]
      : null;
    if (prev) {
      // Return to parent classify
      setClassifyRelMsgId(prev.relMsgId);
    } else {
      // Exit to main view
      setClassifyRelMsgId(null);
    }
    setClassifyKey(k => k + 1);
    setPreviewClassifyId(null); // exit preview mode when leaving classify
    if (_options?.restoreSnapshot !== false && entry?.snapshot) {
      restoreSnapshot(entry.snapshot, { restoreSelection: false });
    }
  }

  function getEdgeIdsForRelation(relationMessageId: string) {
    return edges.filter(e => e.relationMessageId === relationMessageId).map(e => e.id);
  }

  function relationAllFragmentsSelected(relationMessageId: string, units: UnitSelection[]) {
    const edgeIds = getUncorrectedEdgeIds(relationMessageId);
    if (edgeIds.length === 0) return units.some(u => u.messageId === relationMessageId && u.selection.kind === "whole");
    const have = new Set(units.filter(u => u.messageId === relationMessageId && u.selection.kind === "edge").map(u => (u.selection as any).edgeId));
    return edgeIds.every(id => have.has(id));
  }

  function ensureRelationWholeSynced(relationMessageId: string) {
    setDraftUnits(prev => {
      const shouldHaveWhole = relationAllFragmentsSelected(relationMessageId, prev);
      const wholeUnit: UnitSelection = { messageId: relationMessageId, selection: { kind: "whole" } };
      const hasWhole = prev.some(u => unitEquals(u, wholeUnit));
      let next = [...prev];
      if (shouldHaveWhole && !hasWhole) next.push(wholeUnit);
      else if (!shouldHaveWhole && hasWhole) next = next.filter(u => !unitEquals(u, wholeUnit));
      return next;
    });
  }

  function handleEdgeLabelSingleClick(e: React.MouseEvent, relationMessageId: string, edgeId: string) {
    e.stopPropagation();
    setLastClickedMessageId(relationMessageId);
    const unit: UnitSelection = { messageId: relationMessageId, selection: { kind: "edge", edgeId } };
    setDraftUnits(prev => {
      const exists = prev.some(u => unitEquals(u, unit));
      const next = exists ? prev.filter(u => !unitEquals(u, unit)) : [...prev, unit];
      setTimeout(() => ensureRelationWholeSynced(relationMessageId), 0);
      return next;
    });
  }

  function handleEdgeLabelDoubleClick(e: React.MouseEvent, relationMessageId: string) {
    e.stopPropagation();
    setLastClickedMessageId(relationMessageId);
    const wholeUnit: UnitSelection = { messageId: relationMessageId, selection: { kind: "whole" } };
    const edgeIds = getUncorrectedEdgeIds(relationMessageId);
    const edgeUnits = edgeIds.map(id => ({ messageId: relationMessageId, selection: { kind: "edge", edgeId: id } as Selection }));
    setDraftUnits(prev => {
      const hasWhole = prev.some(u => unitEquals(u, wholeUnit));
      if (hasWhole) return prev.filter(u => !(u.messageId === relationMessageId && (u.selection.kind === "whole" || u.selection.kind === "edge")));
      const merged = mergeUnits(prev, edgeUnits as UnitSelection[]);
      if (!merged.some(u => unitEquals(u, wholeUnit))) merged.push(wholeUnit);
      return merged;
    });
  }

  /**
   * Create a single TAG relation for `targetMid` with the given label, register the
   * new relation message in state, and return a DemoEdge for the caller to append.
   * Returns null if the API call fails (error is shown via alert).
   */
  async function sendTagRelation(targetMid: string, tagLabel: string, subType?: string, customLabel?: string): Promise<DemoEdge | null> {
    if (!topicId) return null;
    const backendTargetRef = unitSelectionToTargetRef({ messageId: targetMid, selection: { kind: "whole" } }, msgMap);
    try {
      const isReadStatus = secondaryRelationType === 'read' || secondaryRelationType === 'unread';
      const statusType = secondaryRelationType.toUpperCase();
      const payload: Record<string, unknown> = { relationType: isReadStatus ? statusType : 'TAG', label: tagLabel };
      if (subType) { payload.subType = subType; if (subType === 'CUSTOM') { const ct = (customLabel || newMessageContent).trim(); if (ct) payload.customLabel = ct.slice(0, 20); } }
      const backendRel = await createRel(topicId, {
        relationType: isReadStatus ? statusType : 'TAG',
        sourceMessageId: null,
        targetRefs: [backendTargetRef],
        payload: buildRelationPayload(payload as unknown as Parameters<typeof buildRelationPayload>[0]),
      });
      const relId = backendRel.id;
      await registerCreatedRelationInCurrentClassify(backendRel);
      const anonSrcId = `anon:${relId}`;
      return { id: nextId("edge"), relationMessageId: relId, relationType: isReadStatus ? secondaryRelationType : "tag", from: { messageId: anonSrcId, selection: { kind: "whole" } }, to: { messageId: targetMid, selection: { kind: "whole" } }, relationLabel: isReadStatus ? secondaryRelationType : tagLabel } as DemoEdge;
    } catch (e: any) {
      showAlert(`建立标注关系失败: ${e?.message ?? e}`);
      return null;
    }
  }

  async function handleCreateRelationWithSourcesAndTargets(params: {
    sources: UnitSelection[]; targets: UnitSelection[]; label: string;
  }) {
    if (!requireAuth()) return;
    if (!topicId) return;
    if (!relationType) return;
    const { sources, label } = params;
    // Deduplicate relation-message targets: when both a whole and edge selection exist for the same
    // relation message, keep only the whole (it covers all edges, preventing duplicate
    // targetRefs that the backend would reject and that GraphView would render as extra arrows).
    const wholeRelIds = new Set(
      params.targets
        .filter(t => msgMap.get(t.messageId)?.kind === "relation" && t.selection.kind === 'whole')
        .map(t => t.messageId)
    );
    const targets = params.targets.filter(t =>
      !(msgMap.get(t.messageId)?.kind === "relation" && t.selection.kind === 'edge' && wholeRelIds.has(t.messageId))
    );
    const newEdgesList: DemoEdge[] = [];

    const buildEdges = (src: UnitSelection, tgt: UnitSelection, type: RelationType, lbl: string, relId: string) => {
      return {
        id: nextId("edge"),
        relationMessageId: relId,
        relationType: type,
        from: src,
        to: tgt,
        relationLabel: lbl,
      } as DemoEdge;
    };

    if (relationType === "notify") {
      const notifyPayload = buildRelationPayload({
        relationType: "NOTIFY",
        content: newMessageContent.trim() || "回复通知",
      });
      for (const src of sources) {
        for (const t of targets) {
          try {
            const backendRel = await createRel(topicId, {
              relationType: "NOTIFY",
              sourceMessageId: src.messageId,
              targetRefs: [unitSelectionToTargetRef(t, msgMap)],
              payload: notifyPayload,
            });
            await registerCreatedRelationInCurrentClassify(backendRel);
            newEdgesList.push(buildEdges({ ...src }, { ...t }, "notify", "notify", backendRel.id));
          } catch (e: any) { showAlert(`建立通知关系失败: ${e?.message ?? e}`); }
        }
      }
    } else if (relationType === "reply") {
      // REPLY: 每条边一个关系消息（source→target 一一对应）
      const replyAdditional = secondaryRelationType === "question" || secondaryRelationType === "answer"
        ? secondaryRelationType
        : "none";
      const replyEdgeLabel = replyAdditional === "none" ? "reply" : replyAdditional;
      const replyPayload = buildRelationPayload({
        relationType: "REPLY",
        label: replyAdditional === "none" ? undefined : replyAdditional,
      });
      const uniqueSources = Array.from(new Set(sources.map(s => s.messageId)));
      for (const srcId of uniqueSources) {
        const srcs = sources.filter(s => s.messageId === srcId);
        for (const srcUnit of srcs) {
          for (const t of targets) {
            try {
              const backendRel = await createRel(topicId, {
                relationType: "REPLY",
                sourceMessageId: srcId,
                targetRefs: [unitSelectionToTargetRef(t, msgMap)],
                payload: replyPayload,
              });
              const relId = backendRel.id;
              await registerCreatedRelationInCurrentClassify(backendRel);
              newEdgesList.push(buildEdges({ ...srcUnit }, { ...t }, "reply", replyEdgeLabel, relId));
            } catch (e: any) { showAlert(`建立回复关系失败: ${e?.message ?? e}`); }
          }
        }
      }
    } else if (relationType === "agree" || relationType === "disagree") {
      // Relation messages are also messages — include relation-message sources
      const uniqueSources = Array.from(new Set(sources.map(s => s.messageId)));
      const uniqueTargetMids = Array.from(new Set(targets.map(t => t.messageId)));
      if (uniqueSources.length > 0) {
        for (const srcId of uniqueSources) {
          for (const t of targets) {
            try {
              const backendRel = await createRel(topicId, { relationType: relationType.toUpperCase(), sourceMessageId: srcId, targetRefs: [unitSelectionToTargetRef(t, msgMap)] });
              await registerCreatedRelationInCurrentClassify(backendRel);
            } catch (e: any) { showAlert(`建立关系失败: ${e?.message ?? e}`); }
          }
        }
      } else {
        // Pure-stance: no source — persist to backend (relation messages are first-class messages)
        const recoveryTargetIds = new Set([...uniqueTargetMids, ...additionalAgreeTargetIds]);
        for (const targetMid of recoveryTargetIds) {
          try {
            const backendRel = await createRel(topicId, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs: [unitSelectionToTargetRef({ messageId: targetMid, selection: { kind: "whole" } }, msgMap)] });
            await registerCreatedRelationInCurrentClassify(backendRel);
          } catch (e: any) { showAlert(`建立关系失败: ${e?.message ?? e}`); }
        }
      }
    } else if (relationType === "recommend" || relationType === "archive" || relationType === "attention" || relationType === "block") {
      // Annotation relations: user-to-message relations with no source message, one per target.
      // Source units are intentionally ignored — these relations never carry a source message.
      const uniqueTargetMids = Array.from(new Set(targets.map(t => t.messageId)));
      for (const targetMid of uniqueTargetMids) {
        try {
          const payload: Record<string, unknown> = {};
          if (subType) { payload.subType = subType; if (subType === 'CUSTOM') { const ct = newMessageContent.trim(); if (ct) payload.customLabel = ct.slice(0, 20); } }
          const backendRel = await createRel(topicId, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs: [unitSelectionToTargetRef({ messageId: targetMid, selection: { kind: "whole" } }, msgMap)], payload: Object.keys(payload).length > 0 ? payload : undefined });
          const relId = backendRel.id;
          await registerCreatedRelationInCurrentClassify(backendRel);
          const anonSrcId = `anon:${backendRel.id}`;
          newEdgesList.push(buildEdges({ messageId: anonSrcId, selection: { kind: "whole" } }, { messageId: targetMid, selection: { kind: "whole" } }, relationType, label, relId));
        } catch (e: any) { showAlert(`建立关系失败: ${e?.message ?? e}`); }
      }
    } else if (relationType === "tag") {
      // TAG: user-to-message relation with no source message; label stored as tagLabel.
      // Source units are intentionally ignored — TAG never uses a source text message.
      const uniqueTargetMids = Array.from(new Set(targets.map(t => t.messageId)));
      const tagLabel = label;
      for (const targetMid of uniqueTargetMids) {
        const edge = await sendTagRelation(targetMid, tagLabel, subType, subTypeCustomLabel);
        if (edge) newEdgesList.push(edge);
      }
    } else if (relationType === "reference") {
      // REFERENCE: 每条边一个关系消息（source→target 一一对应）
      const uniqueSources = Array.from(new Set(sources.map(s => s.messageId)));
      const uniqueTargets = targets; // 不去重——每条边独立
      const refPayload = secondaryRelationType !== "none"
        ? buildRelationPayload({
            relationType: "reference",
            label: secondaryRelationType === "custom"
              ? (label || "自定义")
              : secondaryRelationType === "delegation" ? "完成委托" : secondaryRelationType,
          })
        : undefined;
      const refEdgeLabel = secondaryRelationType !== "none"
        ? (secondaryRelationType === "custom" ? (label || "自定义") : secondaryRelationLabel(secondaryRelationType))
        : "ref"; // none → default type label
      for (const srcId of uniqueSources) {
        const srcs = sources.filter(s => s.messageId === srcId);
        for (const srcUnit of srcs) {
          for (const t of uniqueTargets) {
            try {
              const backendRel = await createRel(topicId, {
                relationType: "REFERENCE",
                sourceMessageId: srcId,
                targetRefs: [unitSelectionToTargetRef(t, msgMap)],
                payload: refPayload,
              });
              const relId = backendRel.id;
              await registerCreatedRelationInCurrentClassify(backendRel);
              newEdgesList.push(buildEdges({ ...srcUnit }, { ...t }, "reference", refEdgeLabel, relId));
            } catch (e: any) { showAlert(`建立引用关系失败: ${e?.message ?? e}`); }
          }
        }
      }
    } else if (relationType === "annotation") {
      // ANNOTATION: 每条边一个关系消息（source→target 一一对应）
      const uniqueSources = Array.from(new Set(sources.map(s => s.messageId)));
      for (const srcId of uniqueSources) {
        const srcs = sources.filter(s => s.messageId === srcId);
        for (const srcUnit of srcs) {
          for (const t of targets) {
            try {
              const backendRel = await createRel(topicId, {
                relationType: "ANNOTATION",
                sourceMessageId: srcId,
                targetRefs: [unitSelectionToTargetRef(t, msgMap)],
              });
              const relId = backendRel.id;
              await registerCreatedRelationInCurrentClassify(backendRel);
              newEdgesList.push(buildEdges({ ...srcUnit }, { ...t }, "annotation", label, relId));
            } catch (e: any) { showAlert(`建立注释关系失败: ${e?.message ?? e}`); }
          }
        }
      }
    } else {
      // Generic types (ARRANGE/CLASSIFY/MERGE/SUMMARY/PROPOSAL/CODE_CHANGE/OPERATIONS etc.) with source message.
      // CORRECT: single target only.
      if (relationType === "correct" && targets.length > 1) {
        showAlert("更正关系只能有一个目标");
        return;
      }
      const uniqueSources = Array.from(new Set(sources.map(s => s.messageId)));
      for (const srcId of uniqueSources) {
        const srcs = sources.filter(s => s.messageId === srcId);
        for (const srcUnit of srcs) {
          const targetRefs = targets.map(t => unitSelectionToTargetRef(t, msgMap));
          try {
            const backendRel = await createRel(topicId, { relationType: relationType.toUpperCase(), sourceMessageId: srcId, targetRefs, payload: undefined });
            const relId = backendRel.id;
            await registerCreatedRelationInCurrentClassify(backendRel);
            for (const t of targets) {
              newEdgesList.push(buildEdges({ ...srcUnit }, { ...t }, relationType, label, relId));
            }
            if (secondaryRelationType !== "none" && relationType === "correct") {
              const secType = secondaryRelationType as RelationType;
              for (const t of targets) {
                newEdgesList.push(buildEdges({ ...srcUnit }, { ...t }, secType, label, relId));
              }
            }
          } catch (e: any) { showAlert(`建立关系失败: ${e?.message ?? e}`); }
        }
      }
    }
    operationLog('创建关系', `type=${relationType} sources=${sources.length} targets=${targets.length} created=${newEdgesList.length} label=${label.slice(0, 80)}`);
    setEdges(prev => [...prev, ...newEdgesList]);
  }

  /**
   * Create "join" relations for each target of a container.
   * A join relation is: sourceMessageId=container, targetRefs=[target].
   * This enables resolveMessageCanvas / getActiveJoinRelationsForMessage
   * to find which container a message belongs to (bottom-up lookup).
   */
  async function createJoinRelationsForContainer(
    containerId: string,
    _containerType: string,
    targetMids: string[],
  ) {
    const decorationTypes = new Set(['AGREE', 'DISAGREE', 'TAG', 'READ', 'UNREAD', 'ANNOTATION', 'REFERENCE', 'REPLY', 'NOTIFY', 'CORRECT', 'RECOMMEND', 'ARCHIVE', 'ATTENTION', 'BLOCK']);
    const invalidTarget = targetMids
      .map(id => msgMap.get(id))
      .find(message => message?.kind === 'relation' && decorationTypes.has(message.relationType?.toUpperCase() ?? ''));
    if (invalidTarget) {
      setSendError('加入消息的目标不能是绑定在其他消息上的装饰关系消息');
      return false;
    }
    const joinStake = Math.max(relationStakeMap.current.JOIN ?? 1, 1);
    for (const tgtMid of targetMids) {
      try {
        const existingJoin = relationsRef.current.find(relation =>
          relation.relationType?.toUpperCase() === 'JOIN' &&
          relation.sourceMessageId === containerId &&
          relation.targetRefs.some(ref =>
            (ref.kind === 'message' || ref.kind === 'text-fragment') && ref.messageId === tgtMid
          )
        );
        const relation = existingJoin
          ? await api.createRelation(topicId!, {
              relationType: 'AGREE',
              targetRefs: [{ kind: 'relation', relationId: existingJoin.id }],
              payload: {},
              stakeAmount: joinStake,
            })
          : await api.createRelation(topicId!, {
              relationType: 'JOIN',
              sourceMessageId: containerId,
              targetRefs: [{ kind: 'message', messageId: tgtMid }],
              payload: {},
              stakeAmount: joinStake,
            });
        await appendCreatedRelation(relation);
        if (relation.relationType?.toUpperCase() === 'JOIN') {
          const source = relationsRef.current.find(item => item.id === containerId);
          if (source) {
            const targetRef: TargetRef = { kind: 'message', messageId: tgtMid };
            const hasTarget = source.targetRefs.some(ref =>
              ref.kind !== 'relation' && ref.messageId === tgtMid
            );
            if (!hasTarget) {
              const updatedSource = { ...source, targetRefs: [...source.targetRefs, targetRef] };
              relationsRef.current = relationsRef.current.map(item =>
                item.id === containerId ? updatedSource : item
              );
              setRelations(prev => prev.map(item =>
                item.id === containerId ? updatedSource : item
              ));
              setMessages(prev => prev.map(message =>
                message.id === containerId ? buildRelationDemoMessage(updatedSource) : message
              ));
            }
          }
        }
      } catch (e) {
        operationLog('加入分类失败', `containerId=${containerId.slice(-6)} target=${tgtMid.slice(-6)} error=${String(e)}`);
        throw e;
      }
    }
    return true;
  }

  async function handleQuickSendAndRelateFromDraftTargets() {
    if (!requireAuth()) return;
    if (!singleButtonEnabled) return;
    const text = newMessageContent.trim();
    // Clear saved text on type switch since user is sending/committing
    savedTextOnTypeSwitchRef.current = "";

    if (draftUnits.length > 0 && targetUnits.length > 0) {
      setSendError('候选区和目标集合不能同时有内容，请先将候选区移入目标集合或清空其中一方');
      return;
    }
    const sourceMessageIds = new Set(sourceUnits.map(unit => unit.messageId));
    if (draftUnits.some(unit => sourceMessageIds.has(unit.messageId)) || targetUnits.some(unit => sourceMessageIds.has(unit.messageId))) {
      setSendError('同一消息不能同时出现在来源集合和候选暂存区或目标集合中');
      return;
    }

    // Effective targets: candidates (draftUnits) if non-empty, else explicit target collection.
    const effectiveTargets = draftUnits.length > 0 ? draftUnits : targetUnits;
    // Validate both stakes — collect all errors
    const errors: string[] = [];
    if (hasTextContent) {
      if (typeof stakeAmount !== 'number') {
        errors.push('请输入文本消息贡献点');
      } else if (stakeAmount < 10) {
        errors.push(`文本消息最低押注 10 点（当前 ${stakeAmount}）`);
      }
    }
    if (relationType) {
      const isContainerRelation = containerRelationTypes.has(relationType.toUpperCase());
      const hasSelectedSource = sourceUnits.length > 0;
      if (isContainerRelation && hasSelectedSource && !appendContainerType) {
        setSendError('加入消息的来源必须是当前关系类型对应的容器消息，目标消息来自当前选择');
        return;
      }
      if (typeof relStakeAmount !== 'number') {
        errors.push('请输入关系消息贡献点');
      }
      if (typeof relStakeAmount === 'number' && relStakeAmount < effectiveMinStake) {
        const subTypeNote = (subType && subTypeStakeMap.current[subType] && subTypeStakeMap.current[subType] > (relationStakeMap.current[relationType.toUpperCase()] ?? 0))
          ? `（「${subTypeLabel(subType)}」理由要求最低 ${effectiveMinStake} 点）` : '';
        errors.push(`关系消息最低押注 ${effectiveMinStake} 点（当前 ${relStakeAmount}）${subTypeNote}`);
      }
      // Check total consumption (text stake + relation stakes × count + all burn fees) against available balance
      if (totalConsumption && totalConsumption.total > availablePoints) {
        const parts: string[] = [];
        if (totalConsumption.hasText) parts.push(`文本 ${totalConsumption.textStake}`);
        if (totalConsumption.hasRel) parts.push(`关系 ${totalConsumption.perStake}×${totalConsumption.relCount}`);
        if ((totalConsumption as any).refCount > 0) parts.push(`引用 ${(totalConsumption as any).refStakeTotal}`);
        if ((totalConsumption as any).joinCount > 0) {
          const newCount = (totalConsumption as any).newJoinCount ?? (totalConsumption as any).joinCount;
          const agreeCount = (totalConsumption as any).existingJoinAgreeCount ?? 0;
          parts.push(`加入 ${((totalConsumption as any).joinStakeTotal ?? 0) + ((totalConsumption as any).joinFeeTotal ?? 0)}（新建 ${newCount}，赞同已有 ${agreeCount}）`);
        }
        if (totalConsumption.protocolFeeTotal > 0) parts.push(`协议费 ${totalConsumption.protocolFeeTotal}`);
        errors.push(`贡献点余额不足（可用 ${availablePoints}，总计需要 ${totalConsumption.total} 点 = ${parts.join(' + ')}）`);
      }
    }
    if (errors.length > 0) {
      setSendError(errors.join('；'));
      return;
    }
    setSendError(null);

    // With no relation selected, the composer sends a standalone text message.
    // CORRECT uses its own branch below and never creates a replacement text message.
    if (relationType === null) {
      if (text.length === 0) return;
      await handleSendMessageOnly(text);
      setNewMessageContent("");
      return;
    }

    // Adding targets to an existing container uses one JOIN per target.
    if (joinOnlyAction) {
      const containerSource = sourceUnits
        .map(unit => relationsRef.current.find(relation => relation.id === unit.messageId))
        .find((relation): relation is Relation => relation?.relationType?.toUpperCase() === appendContainerType);
      if (!containerSource) {
        setSendError('追加容器内容时只能选择一个同类型容器作为来源');
        return;
      }
      const targetIds = Array.from(new Set(effectiveTargets.map(unit => unit.messageId)));
      const joinCreated = await createJoinRelationsForContainer(containerSource.id, appendContainerType!, targetIds);
      if (!joinCreated) return;
      if (appendContainerType === 'ARRANGE' || appendContainerType === 'MERGE' || appendContainerType === 'SUMMARY') {
        const isArrangeAppend = appendContainerType === 'ARRANGE';
        const isMergeAppend = appendContainerType === 'MERGE';
        const layout = (containerSource.payload as any)?.targetLayout;
        const edgeLabel = isArrangeAppend
          ? layout === 'single-row' ? 'arrange-h' : 'arrange-v'
          : relationTypeName(isMergeAppend ? 'merge' : 'summary');
        const newEdges = targetIds.map(targetId => ({
          id: nextId('edge'),
          relationMessageId: containerSource.id,
          relationType: (isArrangeAppend ? 'arrange' : isMergeAppend ? 'merge' : 'summary') as RelationType,
          from: { messageId: `anon:${containerSource.id}`, selection: { kind: 'whole' as const } },
          to: { messageId: targetId, selection: { kind: 'whole' as const } },
          relationLabel: edgeLabel,
        }));
        setEdges(prev => {
          const existingKeys = new Set(prev.map(edge => `${edge.relationMessageId}::${edge.to.messageId}`));
          return [...prev, ...newEdges.filter(edge => !existingKeys.has(`${edge.relationMessageId}::${edge.to.messageId}`))];
        });
      }
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent(""); setSubType("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    // Scenario: source collection + target collection explicitly committed (no draft candidates).
    // Build the relation directly without creating a new text message.
    if (relationType !== "merge" && relationType !== "arrange" && draftUnits.length === 0 && sourceUnits.length > 0 && targetUnits.length > 0 && (relationType !== 'classify' || joinOnlyAction)) {
      const labelDefault = relationTypeName(relationType);
      const label = relationLabel.trim() || labelDefault;
      await handleCreateRelationWithSourcesAndTargets({ sources: sourceUnits, targets: targetUnits, label });
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent(""); setSubType("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    if (effectiveTargets.length === 0 && relationType !== "classify" && relationType !== "proposal" && relationType !== "code_change" && relationType !== "operations" && !(relationType === 'delegation' && secondaryRelationType === 'create')) return;
    const isAgreeDisagree = relationType === "agree" || relationType === "disagree";
    const isArrange = relationType === "arrange";
    // isInlineBadge kept for backwards-compat but recommend/archive are no longer top-level types
    const isInlineBadge = false;

    if (relationType === "notify") {
      let notifySources = sourceUnits;
      if (notifySources.length === 0 && text.length > 0) {
        const sourceMessage = await handleSendMessageOnly(text);
        if (!sourceMessage) return;
        notifySources = [{ messageId: sourceMessage.id, selection: { kind: "whole" } }];
      }
      if (notifySources.length === 0) {
        setSendError('通知需要来源消息，请输入通知内容或选择来源消息');
        return;
      }
      await handleCreateRelationWithSourcesAndTargets({
        sources: notifySources,
        targets: effectiveTargets,
        label: '通知',
      });
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent(''); setSubType(''); setRelationType(null); setSecondaryRelationType('none');
      return;
    }

    // TAG + secondary relation: create RECOMMEND/ARCHIVE or quick-annotate TAG with label from secondary
    if (relationType === "tag" && secondaryRelationType !== "none") {
      const secType = secondaryRelationType;
      const uniqueTargetMids = Array.from(new Set(effectiveTargets.map(u => u.messageId)));
      const newEdgesList: DemoEdge[] = [];
      if (secType === "recommend" || secType === "archive" || secType === "attention" || secType === "block") {
        // Create inline badge relation (no source message), one per target
        for (const tgtMid of uniqueTargetMids) {
          const backendTargetRef = unitSelectionToTargetRef({ messageId: tgtMid, selection: { kind: "whole" } }, msgMap);
          try {
            const relPayload: any = {};
            if (subType) {
              relPayload.subType = subType;
              if (subType === 'CUSTOM') {
                const customText = newMessageContent.trim();
                if (customText) relPayload.customLabel = customText.slice(0, 20);
              }
            }
            const backendRel = await createRel(topicId!, { relationType: secType.toUpperCase(), sourceMessageId: null, targetRefs: [backendTargetRef], payload: relPayload });
            const relId = backendRel.id;
            await registerCreatedRelationInCurrentClassify(backendRel);
            // Only add edge if not already present for this relation-target pair
            const alreadyHasEdge = edgesRef.current.some(e =>
              e.relationMessageId === relId && e.to.messageId === tgtMid);
            if (!alreadyHasEdge) {
              const anonSrcId = `anon:${backendRel.id}`;
              newEdgesList.push({ id: nextId("edge"), relationMessageId: relId, relationType: secType as RelationType, from: { messageId: anonSrcId, selection: { kind: "whole" } }, to: { messageId: tgtMid, selection: { kind: "whole" } }, relationLabel: relationTypeName(secType) } as DemoEdge);
            }
          } catch (e: any) { showAlert(`建立关系失败: ${e?.message ?? e}`); }
        }
        setEdges(prev => [...prev, ...newEdgesList]);
      } else {
        // Existing tag label selected: create TAG relation directly without a source message.
        // The label text is stored in tagLabel on the relation itself.
        const tagLabel = secType;
        const newTagEdges: DemoEdge[] = [];
        for (const tgtMid of uniqueTargetMids) {
          const edge = await sendTagRelation(tgtMid, tagLabel);
          if (edge) newTagEdges.push(edge);
        }
        setEdges(prev => [...prev, ...newTagEdges]);
      }
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent(""); setSubType(""); setRelationType(null); setSecondaryRelationType("none");
      subTypeCustomBufferRef.current = ""; setSubTypeCustomLabel("");
      return;
    }

    // Relation target with CORRECT: no text, no source — create null-source relation
    const hasDraftRelTarget = draftUnits.some(u => msgMap.get(u.messageId)?.kind === 'relation');
    const hasSecSelector = relationType === "correct" && hasDraftRelTarget;
    if (relationType === 'correct' && !hasDraftRelTarget && effectiveTargets.length === 1 && text.length > 0) {
      const correctionTarget = effectiveTargets[0];
      if (correctionTarget.selection.kind !== 'text') {
        setSendError('更正只能选择原始内容中的一个文本字段');
        return;
      }
      const originalContent = msgMap.get(correctionTarget.messageId)?.content ?? '';
      if (hasActiveCorrectionForSelection(correctionTarget.messageId, correctionTarget.selection, correctionVersions)) {
        setSendError('该字段已有未被反对的更正，不能重复发送');
        return;
      }
      const correctedContent = generateCorrectionContent(
        effectiveTargets,
        text,
        msgMap,
        originalContent,
      );
      if (correctedContent == null) {
        setSendError('更正只能针对一条文本消息或其片段');
        return;
      }
      if (correctionSelectionIsStale(
        originalContent,
        correctionTarget.selection,
      )) {
        setSendError('当前选择已不再匹配原始内容');
        return;
      }
      if (await blockCorrectionForSecondBettor(correctionTarget.messageId)) return;
      const beforeContent = originalContent;
      setComparisonPopup({
        relMsgId: '__new-correction__', x: window.innerWidth / 2, y: window.innerHeight / 2,
        reversePreview: { before: beforeContent, after: correctedContent, target: effectiveTargets[0], mode: 'direct' },
      });
      return;
    }
    if (hasSecSelector) {
      if (text.length > 0 || sourceUnits.length > 0) return; // validation: state must be clean

      // CORRECT targeting a relation message with a secondary relation type:
      // Create a new relation of the secondary type (with the same endpoints as the old relation),
      // then create a CORRECT relation pointing from the new relation to the old relation.
      // A double-click on an edge label adds both a "whole" unit and one or more "edge" units for
      // the same relation message, so we count unique relation-message IDs rather than raw units.
      const relDraftMsgIds = Array.from(new Set(
        draftUnits.filter(u => msgMap.get(u.messageId)?.kind === 'relation').map(u => u.messageId)
      ));
      if (relationType === "correct" && secondaryRelationType !== "none" && relDraftMsgIds.length === 1) {
        const targetRelMsgId = relDraftMsgIds[0];
        if (await blockCorrectionForSecondBettor(targetRelMsgId)) return;
        const oldRelEdges = edges.filter(e => e.relationMessageId === targetRelMsgId);
        if (oldRelEdges.length === 0) {
          showAlert(`无法找到目标关系消息的边（ID：${targetRelMsgId}），无法创建更正关系`);
          return;
        }
        const secType = secondaryRelationType as RelationType;
        const secTypeName = relationTypeName(secType);
        const oldSourceId = oldRelEdges[0].from.messageId;
        const newSourceId = oldSourceId.startsWith('anon:') ? null : oldSourceId;
        const corrTypeName = relationTypeName("correct");

        // Determine which edges the user selected:
        // "whole" means the user selected the entire relation (all edges) → one combined correction.
        // Specific "edge" selections (no "whole") → one separate correction per selected fragment.
        const wholeSelected = draftUnits.some(u => u.messageId === targetRelMsgId && u.selection.kind === "whole");
        const selectedEdgeIds = new Set(
          draftUnits
            .filter(u => u.messageId === targetRelMsgId && u.selection.kind === "edge")
            .map(u => (u.selection as { kind: "edge"; edgeId: string }).edgeId)
        );
        const edgesToCorrect = wholeSelected
          ? oldRelEdges
          : oldRelEdges.filter(e => selectedEdgeIds.has(e.id));
        if (edgesToCorrect.length === 0) {
          showAlert(`没有选中的片段，无法创建更正关系`);
          return;
        }

        const newEdgesList: DemoEdge[] = [];
        try {
          if (wholeSelected) {
            // Whole selected: one combined correction covering all edges (original behavior)
            const newTargetRefs = uniqueTargetRefsFromEdges(edgesToCorrect, msgMap);
            // Step 1: Create the new relation of secondary type with the same endpoints
            const newRelBackend = await createRel(topicId!, { relationType: secType.toUpperCase(), sourceMessageId: newSourceId, targetRefs: newTargetRefs });
            const newRelId = newRelBackend.id;
            await registerCreatedRelationInCurrentClassify(newRelBackend);
            const newFromId = newSourceId ?? `anon:${newRelId}`;
            for (const e of edgesToCorrect) {
              newEdgesList.push({ id: nextId("edge"), relationMessageId: newRelId, relationType: secType, from: { messageId: newFromId, selection: { kind: "whole" } }, to: { ...e.to }, relationLabel: secTypeName } as DemoEdge);
            }
            // Step 2: Create the CORRECT relation with the new relation as source, old relation as target
            const corrBackendRel = await createRel(topicId!, { relationType: 'CORRECT', sourceMessageId: newRelId, targetRefs: [{ kind: 'relation', relationId: targetRelMsgId }] });
            const corrRelId = corrBackendRel.id;
            await registerCreatedRelationInCurrentClassify(corrBackendRel);
            newEdgesList.push({ id: nextId("edge"), relationMessageId: corrRelId, relationType: "correct", from: { messageId: newRelId, selection: { kind: "whole" } }, to: { messageId: targetRelMsgId, selection: { kind: "whole" } }, relationLabel: corrTypeName } as DemoEdge);
          } else {
            // Specific fragments selected: one separate correction per selected edge fragment
            for (const edge of edgesToCorrect) {
              const newTargetRefs = uniqueTargetRefsFromEdges([edge], msgMap);
              // Step 1: Create a new relation of secondary type for this fragment only
              const newRelBackend = await createRel(topicId!, { relationType: secType.toUpperCase(), sourceMessageId: newSourceId, targetRefs: newTargetRefs });
              const newRelId = newRelBackend.id;
              await registerCreatedRelationInCurrentClassify(newRelBackend);
              const newFromId = newSourceId ?? `anon:${newRelId}`;
              newEdgesList.push({ id: nextId("edge"), relationMessageId: newRelId, relationType: secType, from: { messageId: newFromId, selection: { kind: "whole" } }, to: { ...edge.to }, relationLabel: secTypeName } as DemoEdge);
              // Step 2: Create the CORRECT relation for this fragment
              const corrBackendRel = await createRel(topicId!, { relationType: 'CORRECT', sourceMessageId: newRelId, targetRefs: [{ kind: 'relation', relationId: targetRelMsgId }] });
              const corrRelId = corrBackendRel.id;
              await registerCreatedRelationInCurrentClassify(corrBackendRel);
              newEdgesList.push({ id: nextId("edge"), relationMessageId: corrRelId, relationType: "correct", from: { messageId: newRelId, selection: { kind: "whole" } }, to: { messageId: targetRelMsgId, selection: { kind: "whole" } }, relationLabel: corrTypeName } as DemoEdge);
            }
          }
        } catch (e: any) { showAlert(`建立更正关系失败: ${e?.message ?? e}`); }
        setEdges(prev => [...prev, ...newEdgesList]);
        setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
        setRelationType(null); setSecondaryRelationType("none");
        return;
      }

      // CORRECT (no secondary) targeting a relation message: create null-source relation, single target only.
      // Generic path also covers REFERENCE/ANNOTATION with secondary labels
      if (relationType === "correct" && draftUnits.length > 1) {
        showAlert("更正关系只能有一个目标");
        return;
      }
      const targetRefs = draftUnits.map(u => unitSelectionToTargetRef(u, msgMap));
      const typeName = relationTypeName(relationType);
      const newEdgesList: DemoEdge[] = [];
      try {
        const refPayload = undefined;
        const backendRel = await createRel(topicId!, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs, payload: refPayload });
        const relId = backendRel.id;
        await registerCreatedRelationInCurrentClassify(backendRel);
        const anonSrcId = `anon:${backendRel.id}`;
        const edgeLabel = typeName;
        for (const t of draftUnits) {
          newEdgesList.push({ id: nextId("edge"), relationMessageId: relId, relationType: relationType, from: { messageId: anonSrcId, selection: { kind: "whole" } }, to: { ...t }, relationLabel: edgeLabel } as DemoEdge);
        }
        if (secondaryRelationType !== "none") {
          const secType = secondaryRelationType as RelationType;
          for (const t of draftUnits) {
            newEdgesList.push({ id: nextId("edge"), relationMessageId: relId, relationType: secType, from: { messageId: anonSrcId, selection: { kind: "whole" } }, to: { ...t }, relationLabel: relationTypeName(secType) } as DemoEdge);
          }
        }
      } catch (e: any) { showAlert(`建立关系失败: ${e?.message ?? e}`); }
      setEdges(prev => [...prev, ...newEdgesList]);
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent(""); setSubType(""); setRelationType(null); setSecondaryRelationType("none");
      subTypeCustomBufferRef.current = ""; setSubTypeCustomLabel("");
      return;
    }

    if ((isAgreeDisagree || isInlineBadge) && text.length === 0) {
      // Agree/disagree: one relation per target. Edge created inside appendCreatedRelation
      // for AGREE/DISAGREE; for transformed RECOMMEND/ARCHIVE, create edge here.
      const uniqueTargetMids = Array.from(new Set(effectiveTargets.map(u => u.messageId)));
      const newEdgesList2: DemoEdge[] = [];
      for (const tgtMid of uniqueTargetMids) {
        const backendTargetRef = unitSelectionToTargetRef({ messageId: tgtMid, selection: { kind: "whole" } }, msgMap);
        try {
          const backendRel = await createRel(topicId!, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs: [backendTargetRef] });
          await registerCreatedRelationInCurrentClassify(backendRel);
          // If backend transformed to RECOMMEND/ARCHIVE, create inline-badge edge
          const effectiveRelType = backendRel.relationType?.toUpperCase();
          if (effectiveRelType === 'RECOMMEND' || effectiveRelType === 'ARCHIVE') {
            const textTargets = (backendRel.targetRefs as Array<{ messageId?: string }>)
              .filter(ref => ref.messageId).map(ref => ref.messageId!);
            for (const textMid of textTargets) {
              const already = edgesRef.current.some(ee => ee.relationMessageId === backendRel.id && ee.to.messageId === textMid)
                || newEdgesList2.some(ee => ee.relationMessageId === backendRel.id && ee.to.messageId === textMid);
              if (!already) {
                newEdgesList2.push({
                  id: nextId("edge"),
                  relationMessageId: backendRel.id,
                  relationType: effectiveRelType.toLowerCase() as RelationType,
                  from: { messageId: `anon:${backendRel.id}`, selection: { kind: "whole" } },
                  to: { messageId: textMid, selection: { kind: "whole" } },
                  relationLabel: relationTypeName(effectiveRelType.toLowerCase()),
                } as DemoEdge);
              }
            }
          }
        } catch (e: any) { showAlert(`建立关系失败: ${e?.message ?? e}`); }
      }
      if (newEdgesList2.length > 0) setEdges(prev => [...prev, ...newEdgesList2]);
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    // ARRANGE relation: create new, or append targets to an existing ARRANGE.
    // When sourceUnits contains an existing ARRANGE relation, append targets
    // to its frame instead of creating a new ARRANGE.
    if (isArrange) {
      // Check if sourceUnits has an existing ARRANGE relation (append mode)
      const existingArrangeSource = sourceUnits.find(u => {
        const rel = relationById.get(u.messageId);
        return rel && rel.relationType === 'ARRANGE';
      });
      if (existingArrangeSource && targetUnits.length > 0) {
        // Append targets to existing ARRANGE
        const existingRel = relationById.get(existingArrangeSource.messageId)!;
        const existingTargetRefs = (existingRel.targetRefs ?? []) as TargetRef[];
        const existingTargetKeys = new Set(existingTargetRefs.map(r => `${r.kind}:${r.kind === 'relation' ? r.relationId : r.messageId}`));
        const newTargetRefs: TargetRef[] = [];
        const newTargetMids: string[] = [];
        for (const u of targetUnits) {
          const tr = unitSelectionToTargetRef(u, msgMap);
          const key = `${tr.kind}:${tr.kind === 'relation' ? tr.relationId : tr.messageId}`;
          if (!existingTargetKeys.has(key)) {
            newTargetRefs.push(tr);
            // For edges: use the message/relation ID for the to endpoint
            const mid = tr.kind === 'relation' ? tr.relationId : tr.messageId;
            newTargetMids.push(mid);
            existingTargetKeys.add(key);
          }
        }
        if (newTargetRefs.length > 0) {
          try {
            const updatedRefs = [...existingTargetRefs, ...newTargetRefs];
            const updatedRel = await api.patchRelationTargets(topicId!, existingRel.id, updatedRefs);
            // Update local state
            const updated = { ...existingRel, targetRefs: updatedRefs };
            relationsRef.current = relationsRef.current.map(r => r.id === existingRel.id ? updated : r);
            setRelations(prev => prev.map(r => r.id === existingRel.id ? updated : r));
            setMessages(prev => prev.map(m => m.id === existingRel.id ? buildRelationDemoMessage(updatedRel) : m));
            // Add edges from the existing ARRANGE to new targets
            const layout = (existingRel.payload as any)?.targetLayout;
            const edgeLabel = layout === 'single-row' ? 'arrange-h' : 'arrange-v';
            const anonSrcId = `anon:${existingRel.id}`;
            const newEdges: DemoEdge[] = newTargetMids.map(tgtMid => ({
              id: nextId("edge"),
              relationMessageId: existingRel.id,
              relationType: "arrange" as RelationType,
              from: { messageId: anonSrcId, selection: { kind: "whole" as const } },
              to: { messageId: tgtMid, selection: { kind: "whole" as const } },
              relationLabel: edgeLabel,
            }));
            setEdges(prev => {
              const existingKeys = new Set(prev.map(e => `${e.relationMessageId}::${e.to.messageId}`));
              const filtered = newEdges.filter(e => !existingKeys.has(`${e.relationMessageId}::${e.to.messageId}`));
              return [...prev, ...filtered];
            });
            // Create join relations for each new target
            await createJoinRelationsForContainer(existingRel.id, 'ARRANGE', newTargetMids);
          } catch (e: any) {
            showAlert(`追加到排列框架失败: ${e?.message ?? e}`);
          }
        }
        setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
        setNewMessageContent("");
        setRelationType(null); setSecondaryRelationType("none");
        return;
      }

      // Create new ARRANGE (no existing arrange source)
      const newEdgesList: DemoEdge[] = [];
      const uniqueTargetMids = Array.from(new Set(effectiveTargets.map(u => u.messageId)));
      let extraTargetMid: string | null = null;
      if (text.length > 0) {
        const msg = await handleSendMessageOnly(text);
        if (!msg) return;
        extraTargetMid = msg.id;
      }
      const allTargetMids = extraTargetMid ? [...uniqueTargetMids, extraTargetMid] : uniqueTargetMids;
      const targetRefs = allTargetMids.map(mid => unitSelectionToTargetRef({ messageId: mid, selection: { kind: "whole" } }, msgMap));
      // Determine targetLayout from secondaryRelationType: 'single-column' (纵) or 'single-row' (横)
      const targetLayout = secondaryRelationType === 'horizontal' ? 'single-row' as const : 'single-column' as const;
      try {
        const backendRel = await createRel(topicId!, {
          relationType: 'ARRANGE',
          sourceMessageId: null,
          targetRefs,
          payload: buildRelationPayload({ relationType: 'ARRANGE', targetLayout }),
        });
        const relId = backendRel.id;
        // Encode layout direction in relationLabel so layout engine can read it directly
        const edgeLabel = secondaryRelationType === 'horizontal' ? 'arrange-h' : 'arrange-v';
        await registerCreatedRelationInCurrentClassify(backendRel);
        const anonSrcId = `anon:${backendRel.id}`;
        for (const tgtMid of allTargetMids) {
          newEdgesList.push({
            id: nextId("edge"), relationMessageId: relId, relationType: "arrange",
            from: { messageId: anonSrcId, selection: { kind: "whole" } },
            to: { messageId: tgtMid, selection: { kind: "whole" } },
            relationLabel: edgeLabel,
          } as DemoEdge);
        }
        // Create join relations for each target
        await createJoinRelationsForContainer(backendRel.id, 'ARRANGE', allTargetMids);
      } catch (e: any) { showAlert(`建立排列关系失败: ${e?.message ?? e}`); }
      setEdges(prev => [...prev, ...newEdgesList]);
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    // CLASSIFY relation: user-to-message relation with no source message.
    // Targets can be text messages and/or classify relation messages, and can be empty.
    if (relationType === "classify") {
      const targetTextIds = getGroupedTargetTextMessageIds(effectiveTargets);
      // Warn if non-grouping relation labels (TAG/RECOMMEND/ARCHIVE etc.) are selected
      // but their target text message is not among the messages being classified.
      const orphanLabels: string[] = [];
      for (const u of effectiveTargets) {
        const targetMsg = msgMap.get(u.messageId);
        if (targetMsg && isContentKind(targetMsg.kind)) continue;
        const rt = relationTypeByRelMsgId.get(u.messageId);
        if (!rt || rt === 'classify' || rt === 'merge' || rt === 'arrange' || rt === 'summary') continue;
        const rel = relationById.get(u.messageId);
        if (!rel) continue;
        const relTargets = (rel.targetRefs ?? []) as TargetRef[];
        const hasTargetInSelection = relTargets.some(t =>
          (t.kind === 'message' || t.kind === 'text-fragment') && t.messageId && targetTextIds.includes(t.messageId)
        );
        if (!hasTargetInSelection) {
          const spec = getPresentationSpec(rt);
          orphanLabels.push(`「${spec.label}」`);
        }
      }
      if (orphanLabels.length > 0) {
        showAlert(`选中的${orphanLabels.join('、')}标签对应的消息不在分类目标中，请先选择目标消息再选择其标签，或取消选择无关标签`);
        return;
      }
      if (hasCrossNonReferenceTextLinkForClassifyTargets(targetTextIds)) {
        showAlert("分类目标与其他文本消息存在非引用关联，无法建立分类关系");
        return;
      }
      const selectedSet = new Set(targetTextIds);
      const arrangeTargetsByRelMsg = new Map<string, string[]>();
      for (const e of edges) {
        if (e.relationType !== "arrange") continue;
        if (msgMap.get(e.to.messageId)?.kind !== "normal") continue;
        const arr = arrangeTargetsByRelMsg.get(e.relationMessageId) ?? [];
        arr.push(e.to.messageId);
        arrangeTargetsByRelMsg.set(e.relationMessageId, arr);
      }
      for (const [, mids] of arrangeTargetsByRelMsg) {
        const uniqueMids = Array.from(new Set(mids));
        if (uniqueMids.length <= 1) continue;
        const selectedCount = uniqueMids.filter(mid => selectedSet.has(mid)).length;
        if (selectedCount > 0 && selectedCount < uniqueMids.length) {
          showAlert(`同一条排列关系关联了 ${uniqueMids.length} 条文本消息，分类前需全部选中`);
          return;
        }
      }
      const classifyTitle = newMessageContent.trim();
      if (!classifyTitle) {
        showAlert("分类名称不能为空");
        return;
      }
      const targetRefs = getClassifyTargetRefs(effectiveTargets);

      // Prevent circular nesting: a classify created from within the
      // classify hierarchy must not target any ancestor (including the
      // current classify and all its parents).
      if (isInsideClassify) {
        const ancestorIds = new Set<string>();
        if (currentClassifyRelMsgId) ancestorIds.add(currentClassifyRelMsgId);
        for (const entry of classifyStackRef.current) {
          ancestorIds.add(entry.relMsgId);
        }
        const targetsAncestor = targetRefs.some(ref =>
          ancestorIds.has(ref.kind === 'relation' ? ref.relationId : ref.messageId)
        );
        if (targetsAncestor) {
          showAlert('不能将当前分类或其上级分类作为新分类的目标');
          return;
        }
      }

      try {
        const backendRel = await createRel(topicId!, {
          relationType: 'CLASSIFY',
          sourceMessageId: null,
          targetRefs,
          payload: buildRelationPayload({ relationType: 'CLASSIFY', title: classifyTitle }),
        });
        const relId = backendRel.id;
        const classifyRoundId = await appendCreatedRelation(backendRel);

        // Remove reclassified targets from parent classifies.
        // Handle current classify first (awaited), then others (fire-and-forget).
        const reclassifiedTargetKeys = new Set(targetRefs.map(ref =>
          ref.kind === 'relation' ? `relation:${ref.relationId}` : `message:${ref.messageId}`
        ));
        const reclassifiedTextIds = new Set(targetTextIds);
        const isReclassified = (ref: TargetRef) => {
          if (ref.kind === 'relation') {
            return reclassifiedTargetKeys.has(`relation:${ref.relationId}`)
              || reclassifiedTextIds.has(ref.relationId);
          }
          return reclassifiedTargetKeys.has(`message:${ref.messageId}`)
            || reclassifiedTextIds.has(ref.messageId)
            || reclassifiedTargetKeys.has(`relation:${ref.messageId}`);
        };
        if (isInsideClassify && currentClassifyRelMsgId) {
          const curRel = relationsRef.current.find(r => r.id === currentClassifyRelMsgId);
          if (curRel) {
            const remainingRefs = (curRel.targetRefs as TargetRef[]).filter(ref => !isReclassified(ref));
            if (remainingRefs.length !== (curRel.targetRefs as TargetRef[]).length) {
              try {
                // Update targetRefs in-place — preserves the classify ID
                const updatedRel = await api.patchRelationTargets(topicId!, currentClassifyRelMsgId, remainingRefs);
                // Update relations in local state (ID unchanged)
                const updated = { ...curRel, targetRefs: remainingRefs };
                relationsRef.current = relationsRef.current.map(r =>
                  r.id === currentClassifyRelMsgId ? updated : r
                );
                setRelations(prev => prev.map(r =>
                  r.id === currentClassifyRelMsgId ? updated : r
                ));
                setMessages(prev => prev.map(m =>
                  m.id === currentClassifyRelMsgId ? buildRelationDemoMessage(updatedRel) : m
                ));
              } catch { /* text removal optional */ }
            }
          }
        }
        for (const rel of relations) {
          if (rel.relationType !== 'CLASSIFY' && rel.relationType !== 'SUMMARY') continue;
          if (isInsideClassify && rel.id === currentClassifyRelMsgId) continue; // handled above
          const remainingRefs = (rel.targetRefs as TargetRef[]).filter(ref => !isReclassified(ref));
          if (remainingRefs.length === (rel.targetRefs as TargetRef[]).length) continue;
          api.patchRelationTargets(topicId!, rel.id, remainingRefs)
            .then(updatedRel => {
              const updated = { ...rel, targetRefs: remainingRefs };
              setRelations(prev => prev.map(r =>
                r.id === rel.id ? updated : r
              ));
              setMessages(prev => prev.map(m =>
                m.id === rel.id ? buildRelationDemoMessage(updatedRel) : m
              ));
            }).catch(() => {});
        }

        // Now add CLASSIFY and its ROUND to the current classify.
        await addTargetToClassifyTopic({ kind: 'relation', relationId: backendRel.id });
        if (classifyRoundId) await addTargetToClassifyTopic({ kind: 'message', messageId: classifyRoundId });

        const anonSrcId = `anon:${backendRel.id}`;
        const edgeTargetIds = Array.from(new Set(
          targetRefs.map(ref => ref.kind === "relation" ? ref.relationId : ref.messageId)
        ));
        // Only add classify edges on the main canvas, not inside another classify
        if (!isInsideClassify) {
          const newEdges = edgeTargetIds.map(targetMid => ({
            id: nextId("edge"),
            relationMessageId: relId,
            relationType: "classify" as RelationType,
            from: { messageId: anonSrcId, selection: { kind: "whole" as const } },
            to: { messageId: targetMid, selection: { kind: "whole" as const } },
            relationLabel: relationTypeName("classify"),
          }));
          setEdges(prev => [...prev, ...newEdges]);
        }
        // Create join relations for each target
        await createJoinRelationsForContainer(backendRel.id, 'CLASSIFY', edgeTargetIds);
      } catch (e: any) {
        showAlert(`建立关系失败: ${e?.message ?? e}`);
        return;
      }
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
      // Bump key to force GraphView clean remount after adding classify edges,
      // avoiding React 18 concurrent reconciliation removeChild errors.
      setFocusKey(k => k + 1);
      return;
    }

    // SUMMARY relation: user-to-message relation, like CLASSIFY but with multi-column layout.
    // Requires both non-empty targets and non-empty title text.
    if (relationType === "summary") {
      const summaryTitle = newMessageContent.trim();
      if (!summaryTitle) {
        showAlert("总结内容不能为空");
        return;
      }
      const targetTextIds = getGroupedTargetTextMessageIds(effectiveTargets);
      // Warn if unrelated relation labels are selected
      const orphanSummaryLabels: string[] = [];
      for (const u of effectiveTargets) {
        const targetMsg = msgMap.get(u.messageId);
        if (targetMsg && isContentKind(targetMsg.kind)) continue;
        const rt = relationTypeByRelMsgId.get(u.messageId);
        if (!rt || rt === 'classify' || rt === 'merge' || rt === 'arrange' || rt === 'summary') continue;
        const rel = relationById.get(u.messageId);
        if (!rel) continue;
        const relTargets = (rel.targetRefs ?? []) as TargetRef[];
        if (!relTargets.some(t => (t.kind === 'message' || t.kind === 'text-fragment') && t.messageId && targetTextIds.includes(t.messageId))) {
          orphanSummaryLabels.push(`「${getPresentationSpec(rt).label}」`);
        }
      }
      if (orphanSummaryLabels.length > 0) {
        showAlert(`选中的${orphanSummaryLabels.join('、')}标签对应的消息不在总结目标中，请先选择目标消息再选择其标签，或取消选择无关标签`);
        return;
      }
      if (hasCrossNonReferenceTextLinkForClassifyTargets(targetTextIds)) {
        showAlert("总结目标与其他文本消息存在非引用关联，无法建立总结关系");
        return;
      }
      const summaryTargetRefs = getClassifyTargetRefs(effectiveTargets);
      if (summaryTargetRefs.length === 0) {
        showAlert("总结关系至少需要一个目标消息");
        return;
      }
      // Prevent circular nesting (same as CLASSIFY above)
      if (isInsideClassify) {
        const ancestorIds = new Set<string>();
        if (currentClassifyRelMsgId) ancestorIds.add(currentClassifyRelMsgId);
        for (const entry of classifyStackRef.current) {
          ancestorIds.add(entry.relMsgId);
        }
        if (summaryTargetRefs.some(ref =>
          ancestorIds.has(ref.kind === 'relation' ? ref.relationId : ref.messageId)
        )) {
          showAlert('不能将当前分类或其上级分类作为新总结的目标');
          return;
        }
      }
      try {
        const backendRel = await createRel(topicId!, {
          relationType: 'SUMMARY',
          sourceMessageId: null,
          targetRefs: summaryTargetRefs,
          payload: buildRelationPayload({ relationType: 'SUMMARY', title: summaryTitle, targetLayout: 'multi-column' }),
        });
        const relId = backendRel.id;
        const roundId = await appendCreatedRelation(backendRel);
        await addTargetToClassifyTopic({ kind: 'relation', relationId: backendRel.id });
        if (roundId) await addTargetToClassifyTopic({ kind: 'message', messageId: roundId });
        const anonSrcId = `anon:${backendRel.id}`;
        const edgeTargetIds = Array.from(new Set(
          summaryTargetRefs.map(ref => ref.kind === "relation" ? ref.relationId : ref.messageId)
        ));
        // Only add summary edges on the main canvas, not inside another classify
        if (!isInsideClassify) {
          const newEdges = edgeTargetIds.map(targetMid => ({
            id: nextId("edge"),
            relationMessageId: relId,
            relationType: "summary" as RelationType,
            from: { messageId: anonSrcId, selection: { kind: "whole" as const } },
            to: { messageId: targetMid, selection: { kind: "whole" as const } },
            relationLabel: relationTypeName("summary"),
          }));
          setEdges(prev => [...prev, ...newEdges]);
        }
        // Create join relations for each target
        await createJoinRelationsForContainer(backendRel.id, 'SUMMARY', edgeTargetIds);
      } catch (e: any) {
        showAlert(`建立总结关系失败: ${e?.message ?? e}`);
        return;
      }
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    // MERGE relation: user-to-message relation with no source message.
    // Targets may be text messages or relation messages; fragments are folded up to whole targets.
    // If text is present, create a standalone text message first — it appears outside the merge frame.
    if (relationType === "merge") {
      // Create a standalone text message if text is present (outside the merge frame).
      if (text.length > 0) {
        const msg = await handleSendMessageOnly(text);
        if (!msg) return; // message creation failed, keep UI state for retry
        // The new message is NOT added to merge targets — it stays outside the frame.
      }

      const mergeTargetTextIds = getGroupedTargetTextMessageIds(effectiveTargets);
      // Warn if unrelated relation labels are selected
      const orphanMergeLabels: string[] = [];
      for (const u of effectiveTargets) {
        const targetMsg = msgMap.get(u.messageId);
        if (targetMsg && isContentKind(targetMsg.kind)) continue;
        const rt = relationTypeByRelMsgId.get(u.messageId);
        if (!rt || rt === 'classify' || rt === 'merge' || rt === 'arrange' || rt === 'summary') continue;
        const rel = relationById.get(u.messageId);
        if (!rel) continue;
        const relTargets = (rel.targetRefs ?? []) as TargetRef[];
        if (!relTargets.some(t => (t.kind === 'message' || t.kind === 'text-fragment') && t.messageId && mergeTargetTextIds.includes(t.messageId))) {
          orphanMergeLabels.push(`「${getPresentationSpec(rt).label}」`);
        }
      }
      if (orphanMergeLabels.length > 0) {
        showAlert(`选中的${orphanMergeLabels.join('、')}标签对应的消息不在归并目标中，请先选择目标消息再选择其标签，或取消选择无关标签`);
        return;
      }
      if (hasCrossNonReferenceTextLinkForClassifyTargets(mergeTargetTextIds)) {
        showAlert("归并目标与其他文本消息存在非引用关联，无法建立归并关系");
        return;
      }
      const mergeTargetRefs = Array.from(new Map(
        foldUpToWhole(effectiveTargets).map(u => {
          const ref = unitSelectionToTargetRef(u, msgMap);
          return [targetRefDisplayId(ref), ref] as const;
        })
      ).values());
      if (mergeTargetRefs.length === 0) {
        showAlert("归并关系至少需要一个文本消息或关系消息作为目标");
        return;
      }
      try {
        const backendRel = await createRel(topicId!, {
          relationType: 'MERGE',
          sourceMessageId: null,
          targetRefs: mergeTargetRefs,
          payload: buildRelationPayload({ relationType: 'MERGE', targetLayout: 'multi-column' }),
        });
        const relId = backendRel.id;
        const roundId = await appendCreatedRelation(backendRel);
        await addTargetToClassifyTopic({ kind: 'relation', relationId: backendRel.id });
        if (roundId) await addTargetToClassifyTopic({ kind: 'message', messageId: roundId });
        const virtualFrameNodeId = `anon:${backendRel.id}`;
        const newEdges = mergeTargetRefs.map(targetRef => ({
          id: nextId("edge"),
          relationMessageId: relId,
          relationType: "merge" as RelationType,
          from: { messageId: virtualFrameNodeId, selection: { kind: "whole" as const } },
          to: targetRef.kind === "relation"
            ? { messageId: targetRef.relationId, selection: { kind: "whole" as const } }
            : { messageId: targetRef.messageId, selection: { kind: "whole" as const } },
          relationLabel: relationTypeName("merge"),
        }));
        setEdges(prev => [...prev, ...newEdges]);
        // Create join relations for each target
        const mergeTargetMids = mergeTargetRefs.map(ref => ref.kind === 'relation' ? ref.relationId : ref.messageId);
        await createJoinRelationsForContainer(backendRel.id, 'MERGE', mergeTargetMids);
      } catch (e: any) {
        showAlert(`建立归并关系失败: ${e?.message ?? e}`);
        return;
      }
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    // For most types below, text is required. Governance/ops types allow empty text when targets exist.
    if (text.length === 0 && !isGovernanceOrOpsType) return;
    const labelDefault = relationTypeName(relationType);
    const label = relationLabel.trim() || labelDefault;

    // CORRECT relation: auto-generate the new message content by applying the replacement
    // (text box content) to the selected fragment(s) or whole of the target message.
    if (relationType === "correct") {
      const uniqueTargetMids = Array.from(new Set(effectiveTargets.map(u => u.messageId)));
      if (uniqueTargetMids.length !== 1) {
        showAlert("更正关系目前仅支持单个目标消息");
        return;
      }
      const rawTargetMid = uniqueTargetMids[0];

      // Resolve correction chain: if the target is itself a correction source
      // (i.e., it corrects another message), find the ultimate ancestor so the
      // new CORRECT points directly to the origin, avoiding orphaned intermediate
      // correction messages (Bug 4 fix: chain corrections).
      let ancestorTargetMid = rawTargetMid;
      const visited = new Set<string>();
      while (true) {
        if (visited.has(ancestorTargetMid)) break; // cycle guard
        visited.add(ancestorTargetMid);
        const parentEdge = edges.find(e =>
          e.relationType === 'correct' &&
          e.from.messageId === ancestorTargetMid &&
          !e.from.messageId.startsWith('anon:') &&
          (() => { const m = msgMap.get(e.to.messageId); return m && isContentKind(m.kind); })()
        );
        if (!parentEdge) break;
        ancestorTargetMid = parentEdge.to.messageId;
      }

      // Build effective targets pointing to the ancestor
      const resolvedTargets: UnitSelection[] = ancestorTargetMid === rawTargetMid
        ? effectiveTargets
        : effectiveTargets.map(u => ({ ...u, messageId: ancestorTargetMid }));

      const generated = generateCorrectionContent(
        resolvedTargets,
        text,
        msgMap,
        correctionVersions.get(ancestorTargetMid)?.current?.content,
      );
      if (generated === null) {
        showAlert("更正关系目标必须是普通文本消息");
        return;
      }
      if (correctionSelectionIsStale(
        correctionVersions.get(ancestorTargetMid)?.current?.content
          ?? msgMap.get(ancestorTargetMid)?.content
          ?? '',
        resolvedTargets[0].selection,
      )) {
        setSendError('当前片段已被其他更正修改，请基于最新内容新建更正');
        return;
      }
      const beforeContent = msgMap.get(ancestorTargetMid)?.content ?? generated;
      setComparisonPopup({
        relMsgId: '__new-correction__', x: window.innerWidth / 2, y: window.innerHeight / 2,
        reversePreview: { before: beforeContent, after: generated, target: resolvedTargets[0], mode: 'source', label },
      });
      return;
    }

    // TAG relation: do NOT create a text message. Store the label as tagLabel on the relation,
    // making it a pure user-to-message relation without a source text message.
    if (relationType === "tag") {
      const uniqueTargetMids = Array.from(new Set(effectiveTargets.map(u => u.messageId)));
      const tagLabel = text;
      const newTagEdges: DemoEdge[] = [];
      for (const tgtMid of uniqueTargetMids) {
        const edge = await sendTagRelation(tgtMid, tagLabel);
        if (edge) newTagEdges.push(edge);
      }
      setEdges(prev => [...prev, ...newTagEdges]);
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    // DELEGATION: create a commission or claim completion of one.
    if (relationType === 'delegation') {
      const content = newMessageContent.trim();
      const readField = (labels: string[]): string | null => {
        for (const field of labels) {
          const match = content.match(new RegExp(`${field}\\s*[=:：]\\s*([^\\n;；]+)`, 'i'));
          if (match?.[1]?.trim()) return match[1].trim();
        }
        return null;
      };
      const isFulfill = secondaryRelationType === 'fulfill';
      const selectedTargets = effectiveTargets.filter(target => msgMap.get(target.messageId)?.kind === 'relation');
      const targetRelation = selectedTargets.length === 1
        ? relations.find(rel => rel.id === selectedTargets[0].messageId)
        : undefined;
      const amountText = readField([isFulfill ? '分配数量' : '报酬数量', '数量']);
      const ratioText = readField([isFulfill ? '分配比例' : '报酬比例', '比例']);
      const amount = amountText ? Number(amountText) : undefined;
      const ratio = ratioText ? Number(ratioText.replace(/%$/, '')) : undefined;
      const validReward = isFulfill
        ? (amount === undefined) !== (ratio === undefined)
          && (amount === undefined || (Number.isInteger(amount) && amount > 0))
          && (ratio === undefined || (Number.isInteger(ratio) && ratio > 0 && ratio <= 100))
        : amount !== undefined && Number.isInteger(amount) && amount > 0 && ratio === undefined;
      if (!content || !validReward || (isFulfill && effectiveTargets.length > 0 && (effectiveTargets.length !== 1 || !targetRelation || targetRelation.relationType.toUpperCase() !== 'DELEGATION'))) {
        setSendError(isFulfill
          ? '完成委托格式：分配数量=100 或 分配比例=30%（二选一）；完成说明=...（分配字段必须放在第一行）'
          : '创建委托格式：报酬数量=100；委托内容=...（报酬数量必须放在第一行）');
        return;
      }
      try {
        const backendRel = await createRel(topicId!, {
          relationType: 'DELEGATION',
          sourceMessageId: null,
          targetRefs: isFulfill && targetRelation
            ? [unitSelectionToTargetRef({ messageId: targetRelation!.id, selection: { kind: 'whole' } }, msgMap)]
            : [],
          payload: buildRelationPayload({
            relationType: 'DELEGATION', content,
            delegationKind: isFulfill ? 'FULFILL' : 'CREATE',
            rewardAmount: amount, rewardRatio: ratio,
          }),
        });
        await registerCreatedRelationInCurrentClassify(backendRel);
        setRelations(prev => [...prev, backendRel]);
        if (isFulfill && targetRelation) {
          const refStake = Math.max(relationStakeMap.current['REFERENCE'] ?? 10, 1);
          const refRel = await api.createRelation(topicId!, {
            relationType: 'REFERENCE',
            sourceMessageId: backendRel.id,
            targetRefs: [{ kind: 'relation', relationId: targetRelation.id, part: 'whole' }],
            payload: { label: '完成委托' },
            stakeAmount: refStake,
          });
          await registerCreatedRelationInCurrentClassify(refRel);
          setRelations(prev => [...prev, refRel]);
          setEdges(prev => [...prev, {
            id: nextId('edge'),
            relationMessageId: refRel.id,
            relationType: 'reference',
            from: { messageId: backendRel.id, selection: { kind: 'whole' } },
            to: { messageId: targetRelation.id, selection: { kind: 'whole' } },
            relationLabel: '完成委托',
          } as DemoEdge]);
        }
        setNewMessageContent(''); setRelationType(null); setSecondaryRelationType('none');
      } catch (e: any) { setSendError(`${isFulfill ? '建立完成委托' : '建立委托'}失败：${e?.message ?? e}`); }
      return;
    }

    // PROPOSAL / CODE_CHANGE / OPERATIONS: governance & operational messages.
    if (relationType === "proposal" || relationType === "code_change" || relationType === "operations") {
      let proposalContent = newMessageContent.trim();
      let payloadExtraForOperation: Record<string, unknown> = {};

      // 分配收入：内置文案
      if (relationType === 'proposal' && secondaryRelationType === '分配收入') {
        proposalContent = '提案：将当前收入池余额按规则分配给社区成员';
      }
      const readProposalField = (labels: string[]): string | null => {
        for (const label of labels) {
          const match = proposalContent.match(new RegExp(`${label}\\s*[=:：]\\s*([^\\n;；]+)`, 'i'));
          if (match?.[1]?.trim()) return match[1].trim();
        }
        return null;
      };
      if (relationType === 'proposal' && secondaryRelationType === '充值分账') {
        const amount = Number(readProposalField(['充值总额', '总额', 'amount']));
        const revenuePoolShare = Number(readProposalField(['收入池分成', '分成', 'revenuePoolShare']));
        const recipientUserId = readProposalField(['指定用户', 'recipientUserId']);
        if (!Number.isInteger(amount) || amount <= 0 || !Number.isInteger(revenuePoolShare) || revenuePoolShare < 0 || revenuePoolShare > amount || !recipientUserId) {
          setSendError('充值分账提案格式：充值总额=1000；收入池分成=100；指定用户=user-id');
          return;
        }
        proposalContent = `充值分账提案\n充值总额：${amount}\n收入池分成：${revenuePoolShare}\n指定用户：${recipientUserId}`;
        payloadExtraForOperation = { operationType: 'RECHARGE', amount, revenuePoolShare, recipientUserId };
      }
      if (relationType === 'proposal' && secondaryRelationType === '运营收入注入') {
        const amount = Number(readProposalField(['收入金额', '金额', 'amount']));
        const source = readProposalField(['来源', 'source']);
        if (!Number.isInteger(amount) || amount <= 0 || !source) {
          setSendError('运营收入提案格式：收入金额=1000；来源=服务收入');
          return;
        }
        proposalContent = `运营收入注入提案\n收入金额：${amount}\n来源：${source}`;
        payloadExtraForOperation = { operationType: 'REVENUE_INJECTION', amount, source };
      }
      // 终止结算：内置文案带目标信息
      else if (relationType === 'proposal' && secondaryRelationType === '终止结算') {
        const targetInfos: string[] = [];
        for (const t of effectiveTargets) {
          const m = msgMap.get(t.messageId);
          if (m?.kind === 'governance') {
            const preview = m.content ? m.content.slice(0, 80) : '(无内容)';
            targetInfos.push(`「${preview}」— ${m.author}`);
          }
        }
        proposalContent = `终止结算提案\n目标提案：${targetInfos.join('; ')}`;
      }
      else if (!proposalContent && !hasTargetsAvailable) {
        showAlert("请输入内容或选择目标消息");
        return;
      }
      // Auto-fill content from target text messages when input is empty
      if (!proposalContent && hasTargetsAvailable) {
        const targetContents: string[] = [];
        for (const t of effectiveTargets) {
          const m = msgMap.get(t.messageId);
          if (m && isContentKind(m.kind) && m.content) {
            targetContents.push(m.content);
          }
        }
        proposalContent = targetContents.join('\n\n---\n\n');
      }
      try {
        const payloadExtra: Record<string, unknown> = {};
        if (relationType === 'proposal' && secondaryRelationType !== 'none') {
          const opMap: Record<string, string> = { '分配收入': 'DISTRIBUTE_REVENUE', '充值分账': 'RECHARGE', '运营收入注入': 'REVENUE_INJECTION', '终止结算': 'TERMINATE_SETTLEMENT' };
          payloadExtra.operationType = opMap[secondaryRelationType] ?? secondaryRelationType.toUpperCase();
        }
        Object.assign(payloadExtra, payloadExtraForOperation);
        // 终止结算：传递目标消息 ID 给后端
        if (secondaryRelationType === '终止结算') {
          const targetMsgIds: string[] = [];
          for (const t of effectiveTargets) {
            const m = msgMap.get(t.messageId);
            if (m?.kind === 'governance') targetMsgIds.push(t.messageId);
          }
          if (targetMsgIds.length > 0) payloadExtra.targetMessageIds = targetMsgIds;
        }
        const backendRel = await createRel(topicId!, {
          relationType: relationType.toUpperCase(),
          sourceMessageId: null,
          targetRefs: [],
          payload: buildRelationPayload({
            relationType: relationType.toUpperCase(),
            content: proposalContent || '',
            title: (proposalContent || '').slice(0, 200) || undefined,
            ...payloadExtra,
          }),
        });
        // Add as governance/code/operations content message (not relation), so it renders as a card
        const govKind: MessageKind = relationType === "proposal" ? "governance" : relationType === "code_change" ? "code" : "operations";
        const govMsg: DemoMessage = {
          id: backendRel.id,
          author: backendRel.createdBy?.username ?? user?.username ?? '?',
          createdAt: backendRel.createdAt,
          content: proposalContent,
          kind: govKind,
          backendKind: relationType === "proposal" ? "GOVERNANCE" : relationType === "code_change" ? "CODE" : "OPERATIONS",
        };
        setMessages(prev => [...prev, govMsg]);
        setRelations(prev => [...prev, backendRel]);
        // Governance/ops messages are content-kind — add as message target
        await addTargetToClassifyTopic({ kind: 'message', messageId: backendRel.id });
        const govRoundId = await createSettlementRoundForMessage(
          backendRel.id,
          backendRel.createdBy?.username ?? user?.username ?? '?',
          'TRUTH',
        );
        if (govRoundId) await addTargetToClassifyTopic({ kind: 'message', messageId: govRoundId });
        // Create REFERENCE relations from governance message to each target.
        if (hasTargetsAvailable) {
          const refMinStake = relationStakeMap.current['REFERENCE'] ?? 10;
          const refStake = Math.max(refMinStake, 1);
          for (const t of effectiveTargets) {
            try {
              const targetRef = unitSelectionToTargetRef(t, msgMap);
              const refRel = await createRel(topicId!, {
                relationType: 'REFERENCE',
                sourceMessageId: backendRel.id,
                targetRefs: [targetRef],
                stakeAmount: refStake,
              });
              await registerCreatedRelationInCurrentClassify(refRel);
              setEdges(prev => [...prev, {
                id: nextId("edge"),
                relationMessageId: refRel.id,
                relationType: "reference",
                from: { messageId: backendRel.id, selection: { kind: "whole" } },
                to: { ...t },
                relationLabel: "reference",
              } as DemoEdge]);
            } catch (e: any) {
              console.error(`创建引用关系失败: ${e?.message ?? e}`);
            }
          }
        }
        // Auto-self-stake
        const selfStake = relStakeRef.current;
        setAuthorStakes(prev => ({ ...prev, [backendRel.id]: selfStake }));
        api.getMessageStakes(backendRel.id).then(s => {
          mergeStakeSnapshot(backendRel.id, s);
        }).catch(() => {});
        window.dispatchEvent(new Event('points-refresh'));
      } catch (e: any) {
        showAlert(`建立${relationTypeName(relationType)}关系失败: ${e?.message ?? e}`);
        return;
      }
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    const msg = await handleSendMessageOnly(text);
    if (!msg) return;
    const sources: UnitSelection[] = [{ messageId: msg.id, selection: { kind: "whole" } }];
    const targets: UnitSelection[] = [...effectiveTargets];
    await handleCreateRelationWithSourcesAndTargets({ sources, targets, label });
    setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
    setNewMessageContent("");
    setRelationType(null); setSecondaryRelationType("none");
  }

  type DraftGroup = { messageId: string; wholeSelected: boolean; fragments: UnitSelection[] };
  const draftGroups: DraftGroup[] = useMemo(() => {
    const map = new Map<string, DraftGroup>();
    for (const u of draftUnits) {
      const g = map.get(u.messageId) || ({ messageId: u.messageId, wholeSelected: false, fragments: [] } as DraftGroup);
      if (u.selection.kind === "whole") g.wholeSelected = true; else g.fragments.push(u);
      map.set(u.messageId, g);
    }
    return Array.from(map.values());
  }, [draftUnits]);

  const prevDraftCountRef = useRef<number>(draftUnits.length);
  useEffect(() => {
    const prev = prevDraftCountRef.current; const cur = draftUnits.length;
    if (prev > 0 && cur === 0 && activeTextSelectId !== null) setActiveTextSelectId(null);
    prevDraftCountRef.current = cur;
  }, [draftUnits, activeTextSelectId]);

  // Bug 3: scroll to center focused message when entering focus mode
  useEffect(() => {
    const newLen = focusEntries.length;
    if (newLen <= prevFocusLenRef.current) { prevFocusLenRef.current = newLen; return; }
    prevFocusLenRef.current = newLen;
    if (viewMode !== "graph") return;
    const entry = focusEntries[newLen - 1];
    if (!entry || entry.ids.length === 0) return;
    const focusId = entry.ids[0];
    cancelScrollRafs();
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRaf2Ref.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        scrollRaf2Ref.current = null;
        const container = leftPanelRef.current;
        if (!container) return;
        const el = container.querySelector(`[data-msgid="${focusId}"]`) as HTMLElement | null;
        if (!el) return;
        const elRect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const elCenterX = elRect.left - containerRect.left + container.scrollLeft + elRect.width / 2;
        const elCenterY = elRect.top - containerRect.top + container.scrollTop + elRect.height / 2;
        container.scrollLeft = Math.max(0, Math.min(elCenterX - container.clientWidth / 2, container.scrollWidth - container.clientWidth));
        container.scrollTop = Math.max(0, Math.min(elCenterY - container.clientHeight / 2, container.scrollHeight - container.clientHeight));
      });
    });
  }, [focusEntries, viewMode]);

  // Restore saved scroll position after view mode switch so switching does not auto-scroll to top.
  useEffect(() => {
    const saved = viewModeScrollRef.current[viewMode];
    if (saved !== null) {
      viewModeScrollRef.current[viewMode] = null;
      cancelScrollRafs();
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRaf2Ref.current = requestAnimationFrame(() => {
          scrollRafRef.current = null;
          scrollRaf2Ref.current = null;
          clampAndSetScroll(leftPanelRef.current, saved.top, saved.left);
        });
      });
    }
  }, [viewMode]);

  function getSelectedWholeMessageIds(): string[] {
    const ids = draftUnits.filter(u => u.selection.kind === "whole").map(u => u.messageId);
    return Array.from(new Set(ids));
  }

  const recentRelations = useMemo(() => messages.filter(m => m.kind === "relation").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5), [messages]);
  const recentNormals = useMemo(() => messages.filter(m => isContentKind(m.kind)).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 8), [messages]);

  const isAgreeDisagreeType = relationType === "agree" || relationType === "disagree";
  const isArrangeType = relationType === "arrange";
  const isNotifyType = relationType === "notify";

  // Lock arrange layout when appending to an existing ARRANGE frame.
  // When the user selects an existing arrange relation as a source or target,
  // lock secondaryRelationType to match the parent frame's layout.
  useEffect(() => {
    if (!isArrangeType) {
      setIsArrangeLayoutLocked(false);
      return;
    }
    // Check sourceUnits first (append to existing arrange), then draft/target
    const unitsToCheck = sourceUnits.length > 0 ? sourceUnits
      : draftUnits.length > 0 ? draftUnits : targetUnits;
    for (const u of unitsToCheck) {
      const msg = msgMap.get(u.messageId);
      if (msg?.kind === 'relation') {
        const rel = relationById.get(u.messageId);
        if (rel && rel.relationType === 'ARRANGE') {
          const layout = (rel.payload as any)?.targetLayout;
          const lockedDir = layout === 'single-row' ? 'horizontal' : 'vertical';
          setSecondaryRelationType(lockedDir);
          setIsArrangeLayoutLocked(true);
          return;
        }
      }
    }
    setIsArrangeLayoutLocked(false);
  }, [isArrangeType, draftUnits, targetUnits, msgMap, relationById]);
  const isClassifyType = relationType === "classify";
  const isMergeType = relationType === "merge";
  const isSummaryType = relationType === "summary";
  const isGovernanceOrOpsType = relationType === "proposal" || relationType === "code_change" || relationType === "operations";
  // TAG + secondary = recommend/archive acts as an inline badge (no text needed)
  const isTagWithQuickAnnotate = relationType === "tag" && secondaryRelationType !== "none";
  const isTagWithInlineBadge = relationType === "tag" && (secondaryRelationType === "recommend" || secondaryRelationType === "archive" || secondaryRelationType === "attention" || secondaryRelationType === "block");
  const notifyTargets = draftUnits.length > 0 ? draftUnits : targetUnits;
  const attentionTargetMessageIds = useMemo(() => {
    const targetIds = new Set(Object.keys(attentionUsersByTarget).filter(id => attentionUsersByTarget[id].length > 0));
    for (const relation of relations) {
      if (relation.relationType.toUpperCase() !== 'ATTENTION') continue;
      for (const targetRef of relation.targetRefs) {
        if (targetRef.kind === 'message' || targetRef.kind === 'text-fragment') {
          targetIds.add(targetRef.messageId);
        }
      }
    }
    return targetIds;
  }, [attentionUsersByTarget, relations]);
  const hasAttentionNotifyTarget = notifyTargets.length > 0 && notifyTargets.every(target =>
    attentionTargetMessageIds.has(target.messageId)
  );

  // Whether any draft unit points to a relation message (vs. text message or fragment)
  const draftHasRelationTarget = draftUnits.some(u => msgMap.get(u.messageId)?.kind === 'relation');
  const hasTargetsAvailable = draftUnits.length > 0 || targetUnits.length > 0;
  const effectiveTargetUnits = draftUnits.length > 0 ? draftUnits : targetUnits;
  const hasInvalidCorrectTarget = relationType === 'correct' && (
    sourceUnits.length > 0
    || effectiveTargetUnits.length !== 1
    || effectiveTargetUnits[0].selection.kind !== 'text'
    || !isContentKind(msgMap.get(effectiveTargetUnits[0].messageId)?.kind ?? 'normal')
  );
  const hasInvalidContainerSource = relationType !== null
    && containerRelationTypes.has(relationType.toUpperCase())
    && sourceUnits.length > 0
    && !appendContainerType;
  const hasInvalidJoinTarget = joinOnlyAction && effectiveTargetUnits.some(unit => {
    const message = msgMap.get(unit.messageId);
    const decorationTypes = new Set(['AGREE', 'DISAGREE', 'TAG', 'READ', 'UNREAD', 'ANNOTATION', 'REFERENCE', 'REPLY', 'NOTIFY', 'CORRECT', 'RECOMMEND', 'ARCHIVE', 'ATTENTION', 'BLOCK']);
    return message?.kind === 'relation' && decorationTypes.has(message.relationType?.toUpperCase() ?? '');
  });
  const targetTextIdsForValidation = getGroupedTargetTextMessageIds(effectiveTargetUnits);
  const hasCrossLinkValidationError = (isClassifyType || isSummaryType || isMergeType)
    && hasTargetsAvailable
    && hasCrossNonReferenceTextLinkForClassifyTargets(targetTextIdsForValidation);
  const hasOrphanContainerLabel = (isClassifyType || isSummaryType || isMergeType)
    && effectiveTargetUnits.some(unit => {
      const targetMessage = msgMap.get(unit.messageId);
      if (targetMessage && isContentKind(targetMessage.kind)) return false;
      const targetType = relationTypeByRelMsgId.get(unit.messageId);
      if (!targetType || ['classify', 'merge', 'arrange', 'summary'].includes(targetType)) return false;
      const targetRelation = relationById.get(unit.messageId);
      const targetRefs = (targetRelation?.targetRefs ?? []) as TargetRef[];
      return !targetRefs.some(ref =>
        (ref.kind === 'message' || ref.kind === 'text-fragment')
        && ref.messageId
        && targetTextIdsForValidation.includes(ref.messageId)
      );
    });
  const hasClassifyCycle = relationType === 'classify' && isInsideClassify && (() => {
    const ancestorIds = new Set<string>();
    if (currentClassifyRelMsgId) ancestorIds.add(currentClassifyRelMsgId);
    for (const entry of classifyStackRef.current) ancestorIds.add(entry.relMsgId);
    return getClassifyTargetRefs(effectiveTargetUnits).some(ref =>
      ancestorIds.has(ref.kind === 'relation' ? ref.relationId : ref.messageId)
    );
  })();
  const hasInvalidDelegationFormat = relationType === 'delegation' && (() => {
    const content = newMessageContent.trim();
    const isFulfill = secondaryRelationType === 'fulfill';
    const readField = (labels: string[]): string | null => {
      for (const field of labels) {
        const match = content.match(new RegExp(`${field}\\s*[=:：]\\s*([^\\n;；]+)`, 'i'));
        if (match?.[1]?.trim()) return match[1].trim();
      }
      return null;
    };
    const amountText = readField([isFulfill ? '分配数量' : '报酬数量', '数量']);
    const ratioText = readField([isFulfill ? '分配比例' : '报酬比例', '比例']);
    const amount = amountText ? Number(amountText) : undefined;
    const ratio = ratioText ? Number(ratioText.replace(/%$/, '')) : undefined;
    const validReward = isFulfill
      ? (amount === undefined) !== (ratio === undefined)
        && (amount === undefined || (Number.isInteger(amount) && amount > 0))
        && (ratio === undefined || (Number.isInteger(ratio) && ratio > 0 && ratio <= 100))
      : amount !== undefined && Number.isInteger(amount) && amount > 0 && ratio === undefined;
    const selectedTargets = effectiveTargetUnits.filter(target => msgMap.get(target.messageId)?.kind === 'relation');
    const targetRelation = selectedTargets.length === 1
      ? relations.find(rel => rel.id === selectedTargets[0].messageId)
      : undefined;
    return !content || !validReward || (isFulfill && effectiveTargetUnits.length > 0
      && (effectiveTargetUnits.length !== 1 || !targetRelation || targetRelation.relationType.toUpperCase() !== 'DELEGATION'));
  })();
  const hasInvalidProposalFormat = relationType === 'proposal' && (() => {
    const content = newMessageContent.trim();
    const read = (labels: string[]): string | undefined => labels
      .map(label => content.match(new RegExp(`${label}\\s*[=:：]\\s*([^\\n;；]+)`, 'i'))?.[1]?.trim())
      .find(Boolean);
    if (secondaryRelationType === '充值分账') {
      const amount = Number(read(['充值总额', '总额', 'amount']));
      const share = Number(read(['收入池分成', '分成', 'revenuePoolShare']));
      return !Number.isInteger(amount) || amount <= 0 || !Number.isInteger(share) || share < 0 || share > amount || !read(['指定用户', 'recipientUserId']);
    }
    if (secondaryRelationType === '运营收入注入') {
      const amount = Number(read(['收入金额', '金额', 'amount']));
      return !Number.isInteger(amount) || amount <= 0 || !read(['来源', 'source']);
    }
    return false;
  })();
  const composerRefreshKey = `${relationType ?? "plain"}::${secondaryRelationType}::${draftUnits.length === 0 ? "draft-empty" : "draft-has"}::${targetUnits.length === 0 ? "target-empty" : "target-has"}::${sourceUnits.length === 0 ? "source-empty" : "source-has"}::${draftHasRelationTarget ? "draft-rel" : "draft-text"}`;

  // Additional relation selector:
  // - REPLY: always available (none/question/answer)
  // - TAG: always available (none/recommend/archive/existing-tag shortcuts)
  // - ARRANGE: always available (vertical/horizontal)
  const hasSecondaryRelationSelector =
    relationType === "reply"
    || relationType === "tag"
    || relationType === "arrange"
    || relationType === "reference"
    || relationType === "proposal"
    || relationType === "delegation";

  // Send button enabled logic (single button):
  //   - No relation type: just send message → need text
  //   - Relation target + reply/correct with secondary selector: text must be empty, source must be empty
  //   - agree/disagree/arrange (pure-stance): draft or target collection not empty
  //   - sourceUnits + targetUnits explicitly set (draft empty): can build relation without new text
  //   - Other types: (draft or target collection) not empty AND text not empty
  // Note: draftUnits (候选区) is a quick substitute for targetUnits (目标集合).
  // If draftUnits is non-empty it takes precedence; otherwise targetUnits is used.
  const hasTextContent = newMessageContent.trim().length > 0;
  const singleButtonEnabled = (() => {
    if (relationType === null) return newMessageContent.trim().length > 0;
    // Check that relation stake meets the effective minimum (type + subType combined)
    if (hasTextContent && typeof stakeAmount !== 'number') return false;
    if (hasTextContent && typeof stakeAmount === 'number' && stakeAmount < 10) return false;
    if (!joinOnlyAction && relationType && typeof relStakeAmount !== 'number') return false;
    if (!joinOnlyAction && relationType && typeof relStakeAmount === 'number' && relStakeAmount < effectiveMinStake) return false;
    if (totalConsumption && totalConsumption.total > availablePoints) return false;
    // Ambiguous: both draft and target non-empty — force user to clear one
    if (draftUnits.length > 0 && targetUnits.length > 0) return false;
    if (hasInvalidCorrectTarget || hasInvalidContainerSource || hasInvalidJoinTarget || hasCrossLinkValidationError || hasOrphanContainerLabel || hasClassifyCycle || hasInvalidDelegationFormat || hasInvalidProposalFormat) return false;
    if (isClassifyType) {
      const hasExistingClassifySource = sourceUnits.some(unit =>
        relations.find(relation => relation.id === unit.messageId)?.relationType?.toUpperCase() === 'CLASSIFY'
      );
      return hasExistingClassifySource && joinOnlyAction
        ? hasTargetsAvailable
        : newMessageContent.trim().length > 0;
    }
    if (isSummaryType) {
      return joinOnlyAction
        ? hasTargetsAvailable
        : hasTargetsAvailable && newMessageContent.trim().length > 0;
    }
    if (isMergeType) {
      return joinOnlyAction
        ? hasTargetsAvailable
        : hasTargetsAvailable && sourceUnits.length === 0 && newMessageContent.trim().length === 0;
    }
    if (relationType === 'delegation') {
      if (secondaryRelationType === 'fulfill') {
        return newMessageContent.trim().length > 0 && sourceUnits.length === 0;
      }
      return sourceUnits.length === 0 && newMessageContent.trim().length > 0;
    }
    if (isGovernanceOrOpsType) {
      if (sourceUnits.length > 0) return false;
      // 分配收入：必须完全清空
      if (relationType === 'proposal' && secondaryRelationType === '分配收入') {
        return !hasTargetsAvailable && newMessageContent.trim().length === 0;
      }
      if (relationType === 'proposal' && secondaryRelationType === '充值分账') {
        return newMessageContent.trim().length > 0;
      }
      // 终止结算：目标必须是 governance 消息
      if (relationType === 'proposal' && secondaryRelationType === '终止结算') {
        return targetUnits.some(t => msgMap.get(t.messageId)?.kind === 'governance');
      }
      return newMessageContent.trim().length > 0 || hasTargetsAvailable;
    }
    // TAG with recommend/archive (inline badge): needs targets; if CUSTOM subType, also needs text
    if (isTagWithInlineBadge) {
      if (!hasTargetsAvailable) return false;
      if (subType === 'CUSTOM') return newMessageContent.trim().length > 0;
      return true;
    }
    // TAG with existing tag label (non-recommend/archive): needs only targets, no text
    if (isTagWithQuickAnnotate) return hasTargetsAvailable;
    // TAG with secondary=none: invalid state, cannot send
    if (relationType === "tag") return false;
    if (isAgreeDisagreeType || isArrangeType) return hasTargetsAvailable;
    if (isNotifyType) return (sourceUnits.length > 0 || newMessageContent.trim().length > 0) && hasAttentionNotifyTarget;
    // sourceUnits + targetUnits explicitly committed (no draft): relation can be built without new text
    if (draftUnits.length === 0 && sourceUnits.length > 0 && targetUnits.length > 0) return true;
    return hasTargetsAvailable && newMessageContent.trim().length > 0;
  })();

  // Dynamic label describing what the send button will do
  const singleButtonLabel = (() => {
    if (relationType === null) {
      if (newMessageContent.trim().length === 0) return "请输入消息内容后发送";
      return "仅发送这条消息（未选择关系类型）";
    }
    const typeName = relationTypeName(relationType);
    const usingDraft = draftUnits.length > 0;
    if (isClassifyType) {
      const existingClassifySource = sourceUnits.some(unit =>
        relations.find(relation => relation.id === unit.messageId)?.relationType?.toUpperCase() === 'CLASSIFY'
      );
      const targetCount = getClassifyTargetRefs(usingDraft ? draftUnits : targetUnits).length;
      if (existingClassifySource && joinOnlyAction) {
        if (!hasTargetsAvailable) return "请选择要加入已有分类的目标消息";
        return `将${usingDraft ? "候选区" : "目标集合"}中的 ${targetCount} 个消息加入已有分类`;
      }
      if (targetCount === 0) return "文本将作为分类名称，建立分类（无目标）";
      return `文本将作为分类名称，建立分类（${targetCount} 个${CLASSIFY_TARGET_HINT}目标）`;
    }
    if (isSummaryType) {
      const targetCount = getClassifyTargetRefs(usingDraft ? draftUnits : targetUnits).length;
      if (!hasTargetsAvailable) return "请在画布中选择要总结的目标消息";
      if (newMessageContent.trim().length === 0) return "请输入总结内容（不能为空）";
      return `文本将作为总结内容，建立总结关系（${targetCount} 个目标）`;
    }
    if (isMergeType) {
      if (sourceUnits.length > 0) return "归并关系不需要来源消息，请清空来源集合";
      if (!hasTargetsAvailable) return "请在画布中选择要归并的目标消息";
      if (newMessageContent.trim().length > 0) return "归并关系不需要输入文本消息";
      return `建立归并关系（用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
    }
    if (isNotifyType) {
      if (!hasAttentionNotifyTarget) return '请选择已有关注用户的目标消息';
      if (sourceUnits.length === 0 && newMessageContent.trim().length === 0) return '请输入通知内容或选择来源消息';
      return `发送通知（通知目标消息的关注用户）`;
    }
    if (isGovernanceOrOpsType) {
      const govTypeLabel = relationType === "proposal" ? "提案" : relationType === "code_change" ? "代码" : "运营";
      if (sourceUnits.length > 0)
        return `请清空来源集合（${govTypeLabel}消息不需要来源）`;
      // 分配收入
      if (relationType === 'proposal' && secondaryRelationType === '分配收入') {
        if (hasTargetsAvailable) return '分配收入提案不能选择目标，请清空目标集合';
        if (newMessageContent.trim().length > 0) return '分配收入提案不需要输入文本，请清空文本框';
        return '发送分配收入提案（将当前收入池余额按规则分配给社区成员）';
      }
      if (relationType === 'proposal' && secondaryRelationType === '充值分账') {
        return '发送充值分账提案（提交后验证指定用户）';
      }
      // 终止结算
      if (relationType === 'proposal' && secondaryRelationType === '终止结算') {
        if (!hasTargetsAvailable) return '请选择目标提案消息';
        if (!targetUnits.some(t => msgMap.get(t.messageId)?.kind === 'governance'))
          return '终止结算的目标必须是提案消息';
        return '发送终止结算提案';
      }
      const usingDraft2 = draftUnits.length > 0;
      const targetCount = (usingDraft2 ? draftUnits : targetUnits).length;
      if (!hasTargetsAvailable && newMessageContent.trim().length === 0)
        return `请输入${govTypeLabel}内容或选择目标消息`;
      if (targetCount > 0 && newMessageContent.trim().length > 0)
        return `文本将作为${govTypeLabel}正文，发送${govTypeLabel}消息（引用 ${targetCount} 个目标）`;
      if (targetCount > 0)
        return `发送${govTypeLabel}消息（引用 ${targetCount} 个目标，无正文）`;
      return `文本将作为${govTypeLabel}正文，发送${govTypeLabel}消息`;
    }
    if (isAgreeDisagreeType) {
      if (!hasTargetsAvailable) return "请在画布中选择目标消息";
      return newMessageContent.trim().length > 0
        ? `发送消息并建立「${typeName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标）`
        : `建立纯立场「${typeName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
    }
    if (isArrangeType) {
      if (!hasTargetsAvailable) return "请在画布中选择目标消息";
      const layoutLabel = secondaryRelationType === 'horizontal' ? '横排' : '纵排';
      return newMessageContent.trim().length > 0
        ? `发送消息并建立「${typeName}」关系（${layoutLabel}，文本消息加入排列框架）`
        : `建立「${typeName}」关系（${layoutLabel}，用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
    }
    // TAG + secondary = recommend/archive: quick inline-badge shortcut
    if (isTagWithInlineBadge) {
      if (!hasTargetsAvailable) return "请在画布中选择目标消息";
      const secName = relationTypeName(secondaryRelationType as RelationType);
      if (subType === 'CUSTOM') {
        if (newMessageContent.trim().length === 0) return "请输入自定义理由";
        return `建立「${secName}」关系（自定义理由，用${usingDraft ? "候选" : "目标集合"}作目标）`;
      }
      return `建立「${secName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
    }
    // TAG + secondary = none: invalid state prompt
    if (relationType === "tag" && secondaryRelationType === "none") {
      return "请先选择推荐或冷藏";
    }
    // TAG + secondary = existing tag label: quick re-annotation shortcut
    if (isTagWithQuickAnnotate) {
      if (!hasTargetsAvailable) return "请在画布中选择目标消息";
      return `快速标注「${secondaryRelationType}」（用${usingDraft ? "候选" : "目标集合"}作目标）`;
    }
    if (draftUnits.length === 0 && sourceUnits.length > 0 && targetUnits.length > 0) {
      return `建立「${typeName}」关系（来源集合 → 目标集合）`;
    }
    if (!hasTargetsAvailable) return "请在画布中选择目标消息";
    if (newMessageContent.trim().length === 0) return "请输入消息内容（将作为来源）";
    return `发送消息并建立「${typeName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标）`;
  })();

  const sendValidationLabel = (() => {
    if (singleButtonEnabled) return null;
    if (relationType === null && !hasTextContent) return "请输入消息内容后发送";
    if (draftUnits.length > 0 && targetUnits.length > 0) return "候选区和目标集合不能同时有内容，请清空其中一方";
    if (hasTextContent && typeof stakeAmount !== 'number') return "请输入文本消息贡献点";
    if (hasTextContent && typeof stakeAmount === 'number' && stakeAmount < 10) return `文本消息最低押注 10 点`;
    if (!joinOnlyAction && relationType && typeof relStakeAmount !== 'number') return "请输入关系消息贡献点";
    if (!joinOnlyAction && relationType && typeof relStakeAmount === 'number' && relStakeAmount < effectiveMinStake) return `关系消息最低押注 ${effectiveMinStake} 点`;
    if (totalConsumption && totalConsumption.total > availablePoints) return `贡献点余额不足：需要 ${totalConsumption.total} 点，可用 ${availablePoints} 点`;
    if (hasInvalidCorrectTarget) return "更正关系只能选择一条普通消息片段";
    if (hasInvalidContainerSource) return "来源集合必须是当前关系类型对应的容器消息";
    if (hasInvalidJoinTarget) return "加入容器的目标不能是装饰关系消息";
    if (hasCrossLinkValidationError) return "目标与已分类消息存在非引用关联，无法建立关系";
    if (hasOrphanContainerLabel) return "选中的关系标签不属于当前目标集合";
    if (hasClassifyCycle) return "不能将当前分类或其上级分类作为新分类的目标";
    if (hasInvalidDelegationFormat) return secondaryRelationType === 'fulfill'
      ? "完成委托格式无效，请填写分配数量或分配比例，并选择一条委托关系"
      : "创建委托格式无效，请填写报酬数量和委托内容";
    if (hasInvalidProposalFormat) return secondaryRelationType === '充值分账'
      ? "充值分账格式无效，请填写充值总额、收入池分成和指定用户"
      : "运营收入提案格式无效，请填写收入金额和来源";
    if (relationType === 'tag' && secondaryRelationType === 'none') return "请先选择推荐、冷藏、已读、未读或已有标签";
    if (!hasTargetsAvailable && relationType !== null && !isClassifyType && !isGovernanceOrOpsType) return "请先选择目标消息";
    if (relationType !== null && !hasTextContent && !isAgreeDisagreeType && !isArrangeType && !isMergeType && !isTagWithQuickAnnotate && !isTagWithInlineBadge) return "请输入消息内容";
    return null;
  })();

  // Secondary relation options for CORRECT type: relations of the same PresentationKind as the targeted relation message, plus "none".
  const correctSecondaryOptions = useMemo((): string[] => {
    if (relationType !== 'correct') return ['none'];
    const allUnits = [...draftUnits, ...targetUnits];
    const targetRelMsgId = allUnits.find(u => msgMap.get(u.messageId)?.kind === 'relation')?.messageId;
    if (!targetRelMsgId) return ['none'];
    const relEdgesForTarget = edges.filter(e => e.relationMessageId === targetRelMsgId);
    if (relEdgesForTarget.length === 0) return ['none'];
    // All edges sharing the same relationMessageId are created from the same Relation record
    // and therefore have identical relationType. Using the first edge is sufficient.
    const targetRelType = relEdgesForTarget[0].relationType;
    const targetSpec = getPresentationSpec(targetRelType);
    const sameKindTypes = ALL_RELATION_TYPES.filter(rt => getPresentationSpec(rt).kind === targetSpec.kind && rt !== targetRelType);
    return ['none', ...sameKindTypes];
  }, [relationType, draftUnits, targetUnits, edges, msgMap]);

  // Secondary relation options for TAG type: recommend, archive, attention, block, plus existing tags.
  const tagSecondaryOptions = useMemo((): string[] => {
    if (relationType !== 'tag') return ['none'];
    const allUnits = [...draftUnits, ...targetUnits];
    const targetMids = Array.from(new Set(allUnits.map(u => u.messageId)));
    const existingTagLabels = new Set<string>();
    for (const mid of targetMids) {
      for (const e of edges) {
        if (e.relationType === 'tag' && e.to.messageId === mid && e.to.selection.kind === 'whole') {
          const label = isValidTagLabel(e.relationLabel) ? e.relationLabel : null;
          if (label) existingTagLabels.add(label.slice(0, MAX_TAG_LABEL_DISPLAY_LENGTH));
        }
      }
    }
    return ['read', 'unread', 'recommend', 'archive', 'attention', 'block', ...Array.from(existingTagLabels)];
  }, [relationType, draftUnits, targetUnits, edges]);

  const proposalSecondaryOptions = useMemo((): string[] => {
    if (relationType !== 'proposal') return ['none'];
    return ['none', '分配收入', '充值分账', '运营收入注入', '终止结算'];
  }, [relationType]);

  function renderMessageContentWithAnchorsForList(message: DemoMessage) {
    const targets = extractTextTargetsForMessage(message.id, edges);
    if (targets.length === 0) return <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 13 }}>{message.content}</pre>;
    const text = message.content;
    const validItems = targets
      .filter(t => t.start >= 0 && t.start + t.len <= text.length && t.len > 0)
      .map(t => ({ start: t.start, end: t.start + t.len, relationType: t.relationType, edgeId: t.edgeId }));
    const tree = buildAnnoTree(validItems);
    const nodes = renderAnnoNodes(text, tree, 0, text.length, 0, message.id, isFragmentSelected, handleFragmentAnchorClick);
    return <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 13 }}>{nodes}</pre>;
  }

  const { messagesToShow, edgesToShow } = useMemo(() => {
    if (focusEntries.length === 0) return { messagesToShow: messages, edgesToShow: edges };
    const startIds = focusEntries[focusEntries.length - 1].ids.filter(Boolean);
    if (startIds.length === 0) return { messagesToShow: messages, edgesToShow: edges };
    const adj = new Map<string, Set<string>>();
    function addEdgeAdj(a: string, b: string) {
      if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a)!.add(b); adj.get(b)!.add(a);
    }
    for (const e of edges) {
      // Container-type relations (CLASSIFY, MERGE, SUMMARY) do NOT count as
      // focus-distance hops.  They use a two-level visibility model:
      //   - Container card is shown when its nearest connected message is within range.
      //   - Container children are expanded when range has 1+ hop of budget remaining.
      // This prevents the entire cluster from appearing at distance 1.
      if (getPresentationSpec(e.relationType).isContainer) continue;
      // Only add a direct from↔to hop if at least one endpoint is a normal text message.
      // Relation-to-relation connections (e.g. a CORRECT relation linking two relation messages)
      // should not count as focus-distance hops.
      const fromIsNormal = isContentKind(msgMap.get(e.from.messageId)?.kind ?? "normal");
      const toIsNormal = isContentKind(msgMap.get(e.to.messageId)?.kind ?? "normal");
      if (fromIsNormal || toIsNormal) addEdgeAdj(e.from.messageId, e.to.messageId);
      // Connect the relation message to both endpoints so BFS can traverse through
      // relation messages (including those with anon: sources).  Skip anon: IDs
      // since they are not real messages and should not appear as BFS nodes.
      const fromId = e.from.messageId;
      const toId = e.to.messageId;
      if (!fromId.startsWith('anon:')) addEdgeAdj(e.relationMessageId, fromId);
      if (!toId.startsWith('anon:')) addEdgeAdj(e.relationMessageId, toId);
    }
    // When a relation message is the focus, resolve it to its connected normal (text)
    // messages and use those as BFS roots.  This preserves the original hop semantics:
    //   1 hop = one relation message connecting two text messages.
    // Distance is measured TEXT-MESSAGE to TEXT-MESSAGE through relation messages.
    // The relation message itself does NOT act as a BFS node — it is the connector.
    //
    // The relation edges are always shown when their text-message endpoints are visible
    // (ensured by the edge filter below with relationFocusIds / focusRelationMsgIds guards).
    //
    // This way:
    //   hop=0 → text messages directly connected to the focused relation
    //   hop=1 → those text messages + their 1-hop neighbours through other relations
    const effectiveStartIds = new Set<string>();
    const relationFocusIds = new Set<string>();
    function collectNormalMessagesForRelation(relId: string, seen: Set<string>): void {
      if (seen.has(relId)) return;
      seen.add(relId);
      for (const e of edges) {
        if (e.relationMessageId !== relId) continue;
        const mf = msgMap.get(e.from.messageId);
        if (mf && isContentKind(mf.kind)) effectiveStartIds.add(e.from.messageId);
        else if (mf?.kind === "relation") collectNormalMessagesForRelation(e.from.messageId, seen);
        const mt = msgMap.get(e.to.messageId);
        if (mt && isContentKind(mt.kind)) effectiveStartIds.add(e.to.messageId);
        else if (mt?.kind === "relation") collectNormalMessagesForRelation(e.to.messageId, seen);
      }
    }
    for (const id of startIds) {
      const m = msgMap.get(id);
      if (m && m.kind === "relation") {
        relationFocusIds.add(id);
        // When a container-type relation is the focus at hop=0, don't resolve
        // its children — only the container card itself should be shown.
        // At hop >= 1, resolve normally so children appear as the container expands.
        const isContainer = m.relationType ? getPresentationSpec(m.relationType).isContainer : false;
        if (!(focusHop === 0 && isContainer)) {
          const sizeBefore = effectiveStartIds.size;
          collectNormalMessagesForRelation(id, new Set<string>());
          // Fallback: relation has no connected normal messages (e.g. pure-stance
          // with anon source).  Keep the relation message itself as BFS root so
          // focus mode still shows something.
          if (effectiveStartIds.size === sizeBefore) effectiveStartIds.add(id);
        }
        // Also include the relation message itself as a BFS root so that
        // external messages connected directly to the relation (not via its
        // resolved normal messages) are reachable at hop=1.
        effectiveStartIds.add(id);
      } else {
        effectiveStartIds.add(id);
      }
    }
    const dist = new Map<string, number>(); const q: string[] = [];
    for (const id of Array.from(effectiveStartIds)) { if (!dist.has(id)) { dist.set(id, 0); q.push(id); } }
    // Pre-compute frame membership: for each frame-type relation message, the set of
    // normal message IDs that belong to that frame (endpoints of edges whose
    // relationMessageId is the frame itself).  Used during BFS boundary expansion
    // to avoid pulling in external messages that merely reference the frame.
    const frameMembers = new Map<string, Set<string>>();
    for (const e of edges) {
      const relMsg = msgMap.get(e.relationMessageId);
      if (!relMsg || relMsg.kind !== 'relation' || !relMsg.relationType) continue;
      const spec = getPresentationSpec(relMsg.relationType);
      if (!spec.groupsTargets) continue;
      let members = frameMembers.get(e.relationMessageId);
      if (!members) { members = new Set<string>(); frameMembers.set(e.relationMessageId, members); }
      const fromKind = msgMap.get(e.from.messageId)?.kind ?? "normal";
      const toKind = msgMap.get(e.to.messageId)?.kind ?? "normal";
      if (isContentKind(fromKind as MessageKind)) members.add(e.from.messageId);
      if (isContentKind(toKind as MessageKind)) members.add(e.to.messageId);
    }
    // Reverse index: for each normal message, which frame IDs contain it.
    const msgFrameMap = new Map<string, Set<string>>();
    for (const [frameId, members] of frameMembers) {
      for (const m of members) {
        let frames = msgFrameMap.get(m);
        if (!frames) { frames = new Set<string>(); msgFrameMap.set(m, frames); }
        frames.add(frameId);
      }
    }
    while (q.length > 0) {
      const cur = q.shift()!; const d = dist.get(cur)!;
      if (d >= focusHop) {
        // Frame-type relations (ARRANGE, MERGE, etc.) at the boundary: expand to
        // contained normal messages at the same distance so the entire frame group
        // appears at hop=1 when a contained message or an external reference is
        // the focus.  Only include messages that are actual members of this frame
        // (endpoints of edges with relationMessageId === cur), not external messages
        // that merely reference the frame via other relations.
        const curMsg = msgMap.get(cur);
        if (d === focusHop && curMsg?.kind === 'relation' && curMsg.relationType) {
          const spec = getPresentationSpec(curMsg.relationType);
          if (spec.groupsTargets) {
            const members = frameMembers.get(cur);
            if (members) {
              for (const m of members) {
                if (!dist.has(m)) dist.set(m, d);
              }
            }
          }
        }
        continue;
      }
      const neighbors = adj.get(cur); if (!neighbors) continue;
      const curMsg = msgMap.get(cur);
      // When the frame itself is the focus (relationFocusIds contains a frame that
      // contains cur), external connections should NOT be deferred — hop=1 should
      // expand one hop beyond the frame group.
      const frameIsFocus = curMsg && isContentKind(curMsg.kind) &&
        (msgFrameMap.get(cur) ? Array.from(msgFrameMap.get(cur)!).some(f => relationFocusIds.has(f)) : false);
      for (const nb of neighbors) {
        if (dist.has(nb)) continue;
        // When the current node is a normal message inside a frame at d=0,
        // defer direct edges to external normal messages to d+2 so they
        // only appear at hop=2.  The frame relation and same-frame messages
        // get d+1 normally (they appear at hop=1 as part of the frame group).
        // Exception: when the containing frame itself is the focus, external
        // messages should appear at hop=1 (no deferral).
        let hopDelta = 1;
        if (d === 0 && curMsg && isContentKind(curMsg.kind) && !frameIsFocus) {
          const curFrames = msgFrameMap.get(cur);
          if (curFrames && curFrames.size > 0) {
            const nbMsg = msgMap.get(nb);
            if (nbMsg && isContentKind(nbMsg.kind)) {
              const nbFrames = msgFrameMap.get(nb);
              if (!nbFrames || !Array.from(curFrames).some(f => nbFrames.has(f))) {
                hopDelta = 2;
              }
            }
          }
        }
        dist.set(nb, d + hopDelta);
        q.push(nb);
      }
    }
    // ── Container expansion (two-level visibility model) ──
    // Delegated to applyContainerExpansion (focusContainer.ts) which is
    // independently unit-tested.  See that module for the full expansion rules.
    applyContainerExpansion(dist, edges, focusHop);

    const messagesToShowArr = messages.filter(m => dist.has(m.id));
    const shownIds = new Set(messagesToShowArr.map(m => m.id));
    const relationMessagesToAdd = new Set<string>();
    for (const e of edges) {
      // Auto-add a relation message when:
      //   - At least one endpoint is strictly within the hop window (dist < focusHop), OR
      //   - Both endpoints are "visible" (in dist or an anon: placeholder).  This
      //     ensures relations whose text-message endpoints are all shown (e.g. a
      //     pure-stance MERGE/ARRANGE frame or AGREE badge whose targets are visible)
      //     appear even when every endpoint is at the hop boundary.
      const fromDist = dist.get(e.from.messageId);
      const toDist = dist.get(e.to.messageId);
      const fromTriggers = fromDist !== undefined && fromDist < focusHop;
      const toTriggers = toDist !== undefined && toDist < focusHop;
      // bothVisible only applies when focusHop > 0 (normal expansion) OR when a
      // relation message is the focus (relationFocusIds > 0) — in that case all
      // resolved text messages are intentionally shown, so nested frames whose
      // endpoints are all visible should also appear at hop=0.
      const fromOk = fromDist !== undefined || e.from.messageId.startsWith('anon:');
      const toOk = toDist !== undefined || e.to.messageId.startsWith('anon:');
      const bothVisible = (focusHop > 0 || relationFocusIds.size > 0) && fromOk && toOk;
      if (fromTriggers || toTriggers || bothVisible) relationMessagesToAdd.add(e.relationMessageId);
    }
    const relationMsgsAdded = new Set<string>();
    for (const rmId of relationMessagesToAdd) {
      if (shownIds.has(rmId)) continue;
      const m = messages.find(x => x.id === rmId);
      if (m) { messagesToShowArr.push(m); relationMsgsAdded.add(rmId); }
    }
    // Always ensure the original focus-entry IDs are in messagesToShow.
    // When a startId is a classify relation message, collectNormalMessagesForRelation resolves
    // through it to normal message targets; the classify message itself may not appear via
    // BFS dist or the relation-adjacency step above (if its edges point to other relations,
    // not directly to text messages).
    for (const id of startIds) {
      if (!shownIds.has(id) && !relationMsgsAdded.has(id)) {
        const m = msgMap.get(id);
        if (m) messagesToShowArr.push(m);
      }
    }
    const shownSet = new Set(messagesToShowArr.map(m => m.id));
    // An edge is visible when its relationMessageId is in shownSet AND at least one
    // of its endpoints is either in shownSet or is an anon: placeholder.
    // Additionally, edges belonging to a directly-focused relation message are always
    // shown so that the relation structure is fully visible even at hop=0
    // (Bug fix: focus mode relation message visibility).
    //
    // Container-type edges (CLASSIFY, MERGE, SUMMARY): always show when the
    // container is in shownSet.  The frame rendering in GraphView will only
    // display children that are actually in messagesToShow (with layout boxes).
    // Children not independently reachable are hidden inside the frame.
    const edgesToShowArr = edges.filter(e => {
      if (!shownSet.has(e.relationMessageId)) return false;
      // Always show all edges of a directly-focused relation message
      if (relationFocusIds.has(e.relationMessageId)) return true;
      // Container edges: always visible when container is in shownSet.
      // GraphView renders the frame border + header; only children with
      // layout boxes (in messagesToShow) appear inside the frame.
      if (getPresentationSpec(e.relationType).isContainer) return true;
      const fromOk = shownSet.has(e.from.messageId) || e.from.messageId.startsWith('anon:');
      const toOk = shownSet.has(e.to.messageId);
      return fromOk || toOk;
    });
    return { messagesToShow: messagesToShowArr, edgesToShow: edgesToShowArr };
  }, [messages, edges, focusEntries, focusHop, msgMap]);

  const canSetFocus = (!!lastClickedMessageId && messages.some(m => m.id === lastClickedMessageId)) || getSelectedWholeMessageIds().length > 0;
  const canExitFocus = focusEntries.length > 0;

  // Track latest classify ID across async supersede calls so sequential
  // addTargetToClassifyTopic calls always target the current classify.
  const latestClassifyRelMsgIdRef = useRef<string | null>(null);
  useEffect(() => { latestClassifyRelMsgIdRef.current = currentClassifyRelMsgId; }, [currentClassifyRelMsgId]);

  // Set of relation-message IDs that are directly in the current focus set.
  // Used to ensure that edges of focused relations are always visible regardless
  // of endpoint checks (fix: REFERENCE edge not showing when relation is focused).
  const focusRelationMsgIds = useMemo(() => {
    if (focusEntries.length === 0) return new Set<string>();
    const ids = new Set<string>();
    for (const id of focusEntries[focusEntries.length - 1].ids) {
      if (msgMap.get(id)?.kind === 'relation') ids.add(id);
    }
    return ids;
  }, [focusEntries, msgMap]);
  const classifyTargetCount = useMemo(
    () => currentClassifyRelMsgId ? collectOwnedByRelation(currentClassifyRelMsgId, relationById).textIds.size : 0,
    [currentClassifyRelMsgId, relationById]
  );
  const currentClassifyRelMsg = useMemo(
    () => currentClassifyRelMsgId ? msgMap.get(currentClassifyRelMsgId) : null,
    [currentClassifyRelMsgId, msgMap]
  );
  const currentClassifyRelType = useMemo(
    () => {
      if (currentClassifyRelMsg?.relationType === "summary") return "summary";
      if (currentClassifyRelMsg?.relationType === "classify") return "classify";
      return null;
    },
    [currentClassifyRelMsg]
  );
  const classifyKindLabel = currentClassifyRelType === "summary" ? "总结" : currentClassifyRelType === "classify" ? "分类" : "分类";
  const classifyExitLabel = currentClassifyRelType === "summary" ? "退出总结" : currentClassifyRelType === "classify" ? "退出分类" : "退出分类";
  const topicFocusTitle = currentClassifyRelMsg
    ? (getRelationTitle(currentClassifyRelMsg.relationPayload) || `${classifyKindLabel}（${classifyTargetCount}）`)
    : "";
  const isTemporaryJoinCategory = joinFilterTargetId !== null;
  const temporaryJoinCount = joinFilterTargetId
    ? (joinFilterDirection === 'outgoing'
      ? (joinRelationsBySource.get(joinFilterTargetId)?.length ?? 0)
      : (joinRelationsByTarget.get(joinFilterTargetId)?.length ?? 0))
    : 0;

  // 当前视图实际可见的内容消息ID集（考虑焦点/分类上下文）
  const graphVisibleTextIds = useMemo(() => {
    if (isInsideClassify && currentClassifyRelMsgId) {
      const topicRelation = relationById.get(currentClassifyRelMsgId);
      if (!topicRelation) return new Set<string>();
      const ids = new Set<string>(getTextTargetIds(topicRelation.targetRefs));
      // Also include content-kind relation targets (governance/code/ops)
      // so REFERENCE edges from them are not treated as cross-classify.
      for (const relId of getRelationTargetIds(topicRelation.targetRefs)) {
        const m = msgMap.get(relId);
        if (m && isContentKind(m.kind)) ids.add(relId);
      }
      return ids;
    }
    // 主画布：visible = NOT in hiddenTextIds
    const visible = new Set<string>();
    for (const m of messages) {
      if (isContentKind(m.kind) && !graphHiddenTextIds.has(m.id) && !graphOwnedRelationIds.has(m.id)) visible.add(m.id);
    }
    return visible;
  }, [isInsideClassify, currentClassifyRelMsgId, relationById, messages, graphHiddenTextIds, graphOwnedRelationIds]);

  // 跨分类引用标签：按二级标签分组（"证据" / "引用" / 自定义）
  // 消息 A（可见）引用 B（不可见）→ A 上显示 outgoing 标签
  // B（不可见）被 A 引用 → 若 B 在某视图中可见，显示 incoming 标签
  const crossClassifyRefs = useMemo(() => {
    const raw = new Map<string, { outgoing: Record<string, Set<string>>; incoming: Record<string, Set<string>> }>();
    const labelOf = (raw: string): string => {
      const n = raw.trim().toLowerCase();
      if (n === "evidence" || n === "证据") return "证据";
      if (n === "ref" || n === "reference" || !n) return "引用";
      return raw; // custom label
    };
    for (const e of edges) {
      if (e.relationType !== 'reference') continue;
      const fromKind = msgMap.get(e.from.messageId)?.kind;
      const toKind = msgMap.get(e.to.messageId)?.kind;
      if (!isContentKind(fromKind as MessageKind) || !isContentKind(toKind as MessageKind)) continue;
      const fromVisible = graphVisibleTextIds.has(e.from.messageId);
      const toVisible = graphVisibleTextIds.has(e.to.messageId);
      if (fromVisible === toVisible) continue;
      const lbl = labelOf(e.relationLabel);
      if (fromVisible && !toVisible) {
        let entry = raw.get(e.from.messageId);
        if (!entry) { entry = { outgoing: {}, incoming: {} }; raw.set(e.from.messageId, entry); }
        (entry.outgoing[lbl] ??= new Set()).add(e.relationMessageId);
      } else if (!fromVisible && toVisible) {
        let entry = raw.get(e.to.messageId);
        if (!entry) { entry = { outgoing: {}, incoming: {} }; raw.set(e.to.messageId, entry); }
        (entry.incoming[lbl] ??= new Set()).add(e.relationMessageId);
      }
    }
    // 转换 Set → array 用于 props 传递
    const result = new Map<string, { outgoing: Record<string, string[]>; incoming: Record<string, string[]> }>();
    for (const [msgId, entry] of raw) {
      const out: Record<string, string[]> = {};
      for (const [lbl, ids] of Object.entries(entry.outgoing)) out[lbl] = Array.from(ids);
      const inc: Record<string, string[]> = {};
      for (const [lbl, ids] of Object.entries(entry.incoming)) inc[lbl] = Array.from(ids);
      result.set(msgId, { outgoing: out, incoming: inc });
    }
    return result;
  }, [edges, msgMap, graphVisibleTextIds]);

  const { graphMessagesToRender, graphEdgesToRender, listMessagesToRender, listEdgesToRender, hideMessageIds } = useMemo(() => {
    const useFocusWindow = focusEntries.length > 0 && !isInsideClassify;
    const baseMessages = useFocusWindow ? messagesToShow : messages;
    const baseEdges = useFocusWindow ? edgesToShow : edges;
    if (isInsideClassify && currentClassifyRelMsgId) {
      const topicRelation = relationById.get(currentClassifyRelMsgId);
      const containerVisible = collectContainerVisibleIds(currentClassifyRelMsgId, relations, rejectedContainerIds, rejectedJoinRelationIds, userPreferredJoinByTarget);
      const topicTextIds = new Set<string>(containerVisible.textIds);
      const topicRelationIds = new Set<string>(containerVisible.relationIds);
      if (topicRelation) {
        const queue = Array.from(topicRelationIds);
        const visited = new Set<string>();
        while (queue.length > 0) {
          const relId = queue.shift();
          if (!relId || visited.has(relId)) continue;
          visited.add(relId);
          const rel = relationById.get(relId);
          if (!rel) continue;
          const relType = rel.relationType.toUpperCase();
          if (relType !== 'CLASSIFY' && relType !== 'MERGE' && relType !== 'ARRANGE' && relType !== 'SUMMARY') continue;
          // Include the source message of nested relations (not applicable to ARRANGE/CLASSIFY/MERGE/SUMMARY
          // which are user-to-message relations with no sourceMessageId, but may apply to other relation
          // types that appear as nested targets via future extensions).
          if (rel.sourceMessageId) {
            const srcId = rel.sourceMessageId;
            if (!topicTextIds.has(srcId) && !topicRelationIds.has(srcId)) {
              const srcMsg = msgMap.get(srcId);
              if (srcMsg && isContentKind(srcMsg.kind)) {
                topicTextIds.add(srcId);
              } else if (srcMsg?.kind === 'relation') {
                topicRelationIds.add(srcId);
                queue.push(srcId);
              }
            }
          }
          if (relType === 'ARRANGE' || relType === 'MERGE') {
            // ARRANGE and MERGE are framing relations: all content (text targets and
            // nested framing relations) is expanded inline.
            // CLASSIFY and SUMMARY targets are shown as topic cards but not expanded
            // (user must double-click to enter them).
            getTextTargetIds(rel.targetRefs).forEach(id => topicTextIds.add(id));
            getRelationTargetIds(rel.targetRefs).forEach(id => {
              topicRelationIds.add(id);
              const childRelType = relationById.get(id)?.relationType?.toUpperCase();
              if ((childRelType === 'ARRANGE' || childRelType === 'MERGE') && !visited.has(id)) {
                queue.push(id);
              }
              // CLASSIFY and SUMMARY remain as opaque topic cards.
            });
          } else {
            // CLASSIFY and SUMMARY: these are opaque topic cards — they are already in
            // topicRelationIds (added when first encountered as targets), and GraphView
            // will render them as cards.  Their internal targets are NOT expanded into
            // the current view; the user must double-click to enter them.
            // Exception: rejected classifies release their messages into the parent view.
            if (rejectedContainerIds.has(relId)) {
              getTextTargetIds(rel.targetRefs).forEach(id => topicTextIds.add(id));
              getRelationTargetIds(rel.targetRefs).forEach(id => {
                topicRelationIds.add(id);
                const childRelType = relationById.get(id)?.relationType?.toUpperCase();
                if ((childRelType === 'ARRANGE' || childRelType === 'MERGE') && !visited.has(id)) {
                  queue.push(id);
                }
              });
            }
          }
        }
      }
      for (const e of baseEdges) {
        if (!topicRelationIds.has(e.relationMessageId)) continue;
        const relation = relationById.get(e.relationMessageId);
        if (relation?.relationType.toUpperCase() !== 'ANNOTATION') continue;
        for (const endpointId of [e.from.messageId, e.to.messageId]) {
          const endpoint = msgMap.get(endpointId);
          if (endpoint && isContentKind(endpoint.kind)) topicTextIds.add(endpointId);
        }
      }
      // Expand topicTextIds with text messages that have CORRECT (更正) relations
      // with any text message already in the topic, and add the CORRECT relation
      // messages between such pairs to topicRelationIds.
      // This implements: when T1 is in the topic, CORRECT-related T2 and the
      // CORRECT relation message are automatically included in the topic view.
      {
        const correctQ = Array.from(topicTextIds);
        const correctVisited = new Set<string>();
        while (correctQ.length > 0) {
          const tid = correctQ.shift()!;
          if (correctVisited.has(tid)) continue;
          correctVisited.add(tid);
          for (const e of baseEdges) {
            if (e.relationType !== 'correct') continue;
            if (msgMap.get(e.from.messageId)?.kind !== 'normal' || msgMap.get(e.to.messageId)?.kind !== 'normal') continue;
            if (e.from.messageId !== tid && e.to.messageId !== tid) continue;
            topicRelationIds.add(e.relationMessageId);
            const other = e.from.messageId === tid ? e.to.messageId : e.from.messageId;
            if (!topicTextIds.has(other)) {
              topicTextIds.add(other);
              correctQ.push(other);
            }
          }
        }
      }
      const edgesByRel = new Map<string, DemoEdge[]>();
      for (const e of baseEdges) {
        const arr = edgesByRel.get(e.relationMessageId) ?? [];
        arr.push(e);
        edgesByRel.set(e.relationMessageId, arr);
      }
      for (const [relMsgId, relEdges] of edgesByRel) {
        if (relMsgId === currentClassifyRelMsgId || topicRelationIds.has(relMsgId)) continue;
        const textEndpoints = relEdges
          .flatMap(e => [e.from.messageId, e.to.messageId])
          .filter(mid => { const m = msgMap.get(mid); return m && isContentKind(m.kind); });
        if (textEndpoints.length > 0) {
          // A content-kind endpoint is "in topic" if it's in topicTextIds
          // OR in topicRelationIds (governance/code/ops are relation targets).
          const endpointInTopic = (mid: string) =>
            topicTextIds.has(mid) || topicRelationIds.has(mid);
          if (textEndpoints.every(mid => endpointInTopic(mid))) {
            topicRelationIds.add(relMsgId);
          } else if (relEdges[0]?.relationType === 'reference') {
            // Cross-topic REFERENCE: include the relation message when its source
            // message (from) is in the current topic, even if the target is in
            // a different classify topic.
            const sourceInTopic = relEdges.some(e => {
              const fromM = msgMap.get(e.from.messageId);
              return fromM && isContentKind(fromM.kind) && endpointInTopic(e.from.messageId);
            });
            if (sourceInTopic) {
              topicRelationIds.add(relMsgId);
            }
          }
          continue;
        }
        // All endpoints are relation messages — include if any target is in the topic
        const relEndpoints = relEdges
          .flatMap(e => [e.from.messageId, e.to.messageId])
          .filter(mid => msgMap.get(mid)?.kind === 'relation');
        if (relEndpoints.some(mid => topicRelationIds.has(mid))) {
          topicRelationIds.add(relMsgId);
        }
      }
      const visibleIds = new Set<string>([...topicTextIds, ...topicRelationIds]);
      const topicMessages = baseMessages.filter(m => visibleIds.has(m.id));
      // Include edges whose relation message is visible.  For CLASSIFY and SUMMARY
      // edges, keep them even when the target text messages are not in visibleIds —
      // this lets topic cards display correct target counts and lets SUMMARY compute
      // its hiddenTargetIds for covered messages.
      const topicEdges = baseEdges.filter(e => {
        if (!visibleIds.has(e.relationMessageId)) return false;
        // Inside a classify sub-canvas, exclude nested CLASSIFY/SUMMARY edges
        // to prevent duplicate group frames.  The sub-canvas already renders
        // nested classify relations as topic cards via topicRelationIds.
        if (isInsideClassify && (e.relationType === 'classify' || e.relationType === 'summary')) return false;
        if (e.relationType === 'classify' || e.relationType === 'summary') return true;
        // Cross-topic REFERENCE: include the edge when the source endpoint is
        // visible, even if the target is in a different classify topic.
        if (e.relationType === 'reference') {
          return e.from.messageId.startsWith("anon:") || visibleIds.has(e.from.messageId);
        }
        return (e.from.messageId.startsWith("anon:") || visibleIds.has(e.from.messageId)) &&
               visibleIds.has(e.to.messageId);
      });
      return {
        graphMessagesToRender: topicMessages,
        graphEdgesToRender: topicEdges,
        listMessagesToRender: topicMessages,
        listEdgesToRender: topicEdges,
      };
    }

    // listHiddenRelationIds: relation messages to hide in the linear list view.
    // All CLASSIFY-owned relations are hidden — they belong to the CLASSIFY scope
    // and should not appear in the parent topic's flat list.
    // CLASSIFY and SUMMARY relation messages that are owned by CLASSIFY are hidden (they are
    // the classification containers and are shown in the graph view as topic cards).
    // MERGE owned by CLASSIFY is also hidden (intermediate grouping structure).
    // arrange owned by CLASSIFY is unconditionally hidden — its text messages are already
    // classified, and the arrange container itself should not appear in the main view.
    // arrange NOT owned by CLASSIFY is only hidden when ALL its text endpoints
    // are classified (via listExclusiveRelMsgIds).
    //
    // In focus mode (useFocusWindow), baseMessages is already correctly filtered by
    // the BFS + container expansion logic.  The classified-message hiding below is
    // only for the main (non-focus) view.
    const skipClassifyHiding = useFocusWindow || isInsideClassify;
    const listHiddenRelationIds = new Set<string>([
      ...activeClassifyOwnership.relationIds,
      ...classifiedTargetSummaryRelMsgIds,
      ...listExclusiveRelMsgIds,
      ...replacedRelationMsgIds,
    ]);
    const listMessages = skipClassifyHiding
      ? baseMessages
      : baseMessages.filter(m => {
          if (isContentKind(m.kind) && classifiedTargetTextIds.has(m.id)) return false;
          if (m.kind === "relation" && listHiddenRelationIds.has(m.id)) return false;
          // Hide content-kind messages owned by a classify (e.g. governance/ops cards)
          if (isContentKind(m.kind) && graphOwnedRelationIds.has(m.id)) return false;
          return true;
        });
    const listVisibleIds = new Set(listMessages.map(m => m.id));
    // Edge is visible in list view when the relation message is visible AND
    // the edge does not connect to a classified (hidden) text endpoint.
    // Edges of directly-focused relation messages are always included
    // so the relation structure is fully visible (fix: REFERENCE edge focus).
    const listEdges = baseEdges.filter(e => {
      if (!listVisibleIds.has(e.relationMessageId) && !focusRelationMsgIds.has(e.relationMessageId)) return false;
      // Edges of focused relations: always visible
      if (focusRelationMsgIds.has(e.relationMessageId)) return true;
      const fromOk = e.from.messageId.startsWith('anon:') || listVisibleIds.has(e.from.messageId);
      const toOk = listVisibleIds.has(e.to.messageId);
      return fromOk && toOk;
    });

    // graphHiddenRelationIds: relation messages to hide in the non-linear graph view.
    // Unconditionally hide CLASSIFY-owned CLASSIFY/SUMMARY/MERGE/arrange containers and replaced relations.
    // arrange owned by CLASSIFY is unconditionally hidden — its text messages are already
    // classified via collectOwnedByRelation, and the arrange container should not appear.
    // arrange NOT owned by CLASSIFY is only hidden when ALL its text endpoints
    // are in the hidden set (via graphExclusiveRelMsgIds).
    //
    // In focus mode (useFocusWindow), baseMessages is already correctly filtered by
    // the BFS + container expansion logic — skip the classified-message hiding.
    const graphHiddenRelationIds = new Set<string>([
      ...classifiedTargetClassifyRelMsgIds,
      ...classifiedTargetMergeRelMsgIds,
      ...classifiedTargetSummaryRelMsgIds,
      ...classifiedTargetARRANGERelMsgIds,
      ...activeSummaryOwnership.relationIds,
      ...graphExclusiveRelMsgIds,
      ...replacedRelationMsgIds,
    ]);
    const graphMessages = skipClassifyHiding
      ? baseMessages
      : baseMessages.filter(m => {
          if (isContentKind(m.kind) && graphHiddenTextIds.has(m.id)) return false;
          if (m.kind === "relation" && graphHiddenRelationIds.has(m.id)) return false;
          // Hide content-kind messages owned by a classify (e.g. governance/ops cards)
          if (isContentKind(m.kind) && graphOwnedRelationIds.has(m.id)) return false;
          return true;
        });
    const graphVisibleIds = new Set(graphMessages.map(m => m.id));

    // In focus mode, container-type relation messages (CLASSIFY, MERGE, SUMMARY)
    // are rendered as frames (via their edges in GraphView), not as message cards.
    // We keep them in graphMessagesToRender so that GraphView's msgMap can look up
    // their author/title for frame headers.  GraphView skips card rendering for
    // frame-type messages (isAnyFrameRel check).
    const graphMessagesToRender = graphMessages;
    // Edge is visible in graph view when the relation message is visible AND
    // the edge does not connect to a classified (hidden) text endpoint.
    // Edges of directly-focused relation messages are always included
    // so the relation structure is fully visible (fix: REFERENCE edge focus).
    // CLASSIFY / SUMMARY edges are always included so their topic cards can
    // display the correct target count, even when targets are hidden.
    const graphEdges = baseEdges.filter(e => {
      // CORRECT relations are rendered as decorations on their target cards.
      // Keep them when the target is visible even if the relation message is hidden.
      if (e.relationType === 'correct' && graphVisibleIds.has(e.to.messageId)) return true;
      if (!graphVisibleIds.has(e.relationMessageId) && !focusRelationMsgIds.has(e.relationMessageId)) return false;
      // Edges of focused relations: always visible
      if (focusRelationMsgIds.has(e.relationMessageId)) return true;
      // CLASSIFY / SUMMARY: keep edges so topic card target count is correct
      if (e.relationType === 'classify' || e.relationType === 'summary') return true;
      const fromOk = e.from.messageId.startsWith('anon:') || graphVisibleIds.has(e.from.messageId);
      const toOk = graphVisibleIds.has(e.to.messageId);
      return fromOk && toOk;
    });
    // In focus mode, container-type relation messages (CLASSIFY, MERGE, SUMMARY)
    // are rendered as group frames — skip their individual message cards.
    // In non-focus mode, they show as topic cards (e.g. "双击进入分类").
    const hideMessageIds = useFocusWindow
      ? new Set(
          graphMessages
            .filter(m => m.kind === 'relation' && m.relationType && getPresentationSpec(m.relationType).isContainer)
            .map(m => m.id)
        )
      : undefined;

    return {
      graphMessagesToRender: graphMessagesToRender,
      graphEdgesToRender: graphEdges,
      listMessagesToRender: listMessages,
      listEdgesToRender: listEdges,
      hideMessageIds,
    };
  }, [messages, edges, relationById, messagesToShow, edgesToShow, focusEntries, isInsideClassify, currentClassifyRelMsgId, msgMap, classifiedTargetTextIds, classifiedTargetClassifyRelMsgIds, classifiedTargetMergeRelMsgIds, classifiedTargetARRANGERelMsgIds, classifiedTargetSummaryRelMsgIds, listExclusiveRelMsgIds, replacedRelationMsgIds, classifyOwnership, summaryOwnership, graphExclusiveRelMsgIds, graphHiddenTextIds, focusRelationMsgIds, userPreferredJoinByTarget]);

  const normalGraphProjection = useMemo(() => {
    const scopedCorrectedMessages = graphMessagesToRender.map(message => {
      const correction = correctionVersions.get(message.id)?.current;
      return correction ? { ...message, content: correction.content } : message;
    });
    const scopedCleanMessages = cleanVisibleIds
      ? scopedCorrectedMessages.filter(message =>
          cleanVisibleIds.visibleTextIds.has(message.id) || cleanVisibleIds.visibleRelIds.has(message.id))
      : scopedCorrectedMessages;
    const scopedMessages = applyMessageFilter(scopedCleanMessages, msgFilter);
    const correctedMessages = messages.map(message => {
      const correction = correctionVersions.get(message.id)?.current;
      return correction ? { ...message, content: correction.content } : message;
    });
    const cleanMessages = cleanVisibleIds
      ? correctedMessages.filter(message =>
          cleanVisibleIds.visibleTextIds.has(message.id) || cleanVisibleIds.visibleRelIds.has(message.id))
      : correctedMessages;
    const filteredMessages = applyMessageFilter(cleanMessages, msgFilter);
    const suppressedRelIds = computeEffectiveSuppressedRelIds(edges, messages, displayUser?.username ?? null);
    const rawEdges = filterContainerEdgesByEffectiveJoins(
      graphEdgesToRender,
      relations,
      effectiveJoinRelationIds,
    );
    const cleanEdges = cleanVisibleIds
      ? rawEdges.filter(edge => cleanVisibleIds.visibleRelIds.has(edge.relationMessageId))
      : rawEdges;

    return {
      messages: filteredMessages,
      scopedMessages,
      edges: cleanEdges.filter(edge => !suppressedRelIds.has(edge.relationMessageId)),
    };
  }, [messages, graphMessagesToRender, graphEdgesToRender, correctionVersions, cleanVisibleIds, msgFilter, edges, displayUser?.username, relations, effectiveJoinRelationIds]);

  const comparisonAgreeSuppressedRelIds = useMemo(() => {
    const ids = computeEffectiveSuppressedRelIds(edges, messages, displayUser?.username ?? null);
    if (comparisonTargetId) ids.delete(comparisonTargetId);
    if (comparisonReviewed) {
      for (const edge of edges) {
        if (edge.relationType !== 'annotation') continue;
        if (ids.has(edge.from.messageId) || ids.has(edge.to.messageId)) ids.add(edge.relationMessageId);
      }
    }
    return ids;
  }, [comparisonReviewed, comparisonTargetId, edges, messages, displayUser?.username]);

  const comparisonDisagreeSuppressedRelIds = useMemo(() => {
    const ids = computeEffectiveSuppressedRelIds(edges, messages, displayUser?.username ?? null);
    if (comparisonTargetId) ids.add(comparisonTargetId);
    if (comparisonReviewed) {
      for (const edge of edges) {
        if (edge.relationType !== 'annotation') continue;
        if (ids.has(edge.from.messageId) || ids.has(edge.to.messageId)) ids.add(edge.relationMessageId);
      }
    }
    return ids;
  }, [comparisonReviewed, comparisonTargetId, edges, messages, displayUser?.username]);

  const comparisonGraphProjections = useMemo(() => {
    if (!comparisonReviewed || !comparisonTargetId) return null;

    const buildProjection = (side: 'agree' | 'disagree') => {
      const sideRejectedContainerIds = new Set(rejectedContainerIds);
      if (side === 'agree') sideRejectedContainerIds.delete(comparisonTargetId);
      else sideRejectedContainerIds.add(comparisonTargetId);

      const sideClassifyOwnership = { textIds: new Set<string>(), relationIds: new Set<string>() };
      for (const relation of relations) {
        if (relation.relationType !== 'CLASSIFY' || sideRejectedContainerIds.has(relation.id)) continue;
        const owned = collectOwnedByRelation(relation.id, relationById, new Set(), sideRejectedContainerIds, rejectedJoinRelationIds, userPreferredJoinByTarget);
        owned.textIds.forEach(id => sideClassifyOwnership.textIds.add(id));
        owned.relationIds.forEach(id => sideClassifyOwnership.relationIds.add(id));
      }
      const sideSummaryOwnership = { textIds: new Set<string>(), relationIds: new Set<string>() };
      for (const relation of relations) {
        if (relation.relationType !== 'SUMMARY' || sideRejectedContainerIds.has(relation.id)) continue;
        const owned = collectOwnedByRelation(relation.id, relationById, new Set(), sideRejectedContainerIds, rejectedJoinRelationIds, userPreferredJoinByTarget);
        owned.textIds.forEach(id => sideSummaryOwnership.textIds.add(id));
        owned.relationIds.forEach(id => sideSummaryOwnership.relationIds.add(id));
      }
      const sideClassifyTextIds = expandTextIdsWithSettlementResults(
        expandTextIdsWithCorrections(sideClassifyOwnership.textIds, edges, msgMap),
        messages,
      );
      const sideSummaryTextIds = expandTextIdsWithCorrections(sideSummaryOwnership.textIds, edges, msgMap);
      const sideHiddenTextIds = new Set(sideClassifyTextIds);
      sideSummaryTextIds.forEach(id => sideHiddenTextIds.add(id));
      const sideOwnedRelationIds = new Set(sideClassifyOwnership.relationIds);
      mergeOwnership.relationIds.forEach(id => sideOwnedRelationIds.add(id));
      sideSummaryOwnership.relationIds.forEach(id => sideOwnedRelationIds.add(id));
      const sideExclusiveRelMsgIds = collectExclusiveRelationMsgIds(sideHiddenTextIds, sideOwnedRelationIds);
      const sideClassifyRelationIdsByType = (type: string) => new Set(
        [...sideClassifyOwnership.relationIds].filter(id => relationById.get(id)?.relationType.toUpperCase() === type),
      );
      const sideHiddenRelationIds = new Set<string>([
        ...sideClassifyRelationIdsByType('CLASSIFY'),
        ...sideClassifyRelationIdsByType('MERGE'),
        ...sideClassifyRelationIdsByType('ARRANGE'),
        ...sideClassifyRelationIdsByType('SUMMARY'),
        ...sideSummaryOwnership.relationIds,
        ...sideExclusiveRelMsgIds,
        ...replacedRelationMsgIds,
      ]);
      const projectionBaseMessages = comparisonReviewBaseMessages
        ?? (isInsideClassify ? normalGraphProjection.scopedMessages : normalGraphProjection.messages);
      const projectionBaseEdges = comparisonReviewBaseEdges ?? normalGraphProjection.edges;
      const targetMessageIds = new Set([comparisonTargetId]);
      const comparisonTargetEdges = edges.filter(edge => edge.relationMessageId === comparisonTargetId);
      const targetRelationType = relationById.get(comparisonTargetId)?.relationType.toUpperCase();
      const targetIsContainer = targetRelationType && ['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'].includes(targetRelationType);
      if (!targetIsContainer) {
        for (const edge of comparisonTargetEdges) {
          if (!edge.from.messageId.startsWith('anon:')) targetMessageIds.add(edge.from.messageId);
          if (!edge.to.messageId.startsWith('anon:')) targetMessageIds.add(edge.to.messageId);
        }
      }
      const baseMessagesWithTarget = [...projectionBaseMessages];
      const baseMessageIds = new Set(baseMessagesWithTarget.map(message => message.id));
      for (const targetId of targetMessageIds) {
        if (baseMessageIds.has(targetId)) continue;
        const targetMessage = msgMap.get(targetId);
        if (targetMessage) {
          baseMessagesWithTarget.push(targetMessage);
          baseMessageIds.add(targetId);
        }
      }
      const baseEdgesWithTarget = [
        ...projectionBaseEdges,
        ...(side === 'agree'
          ? comparisonTargetEdges.filter(edge => !projectionBaseEdges.some(existing => existing.id === edge.id))
          : []),
      ];
      const sideSuppressedRelIds = side === 'agree'
        ? comparisonAgreeSuppressedRelIds
        : comparisonDisagreeSuppressedRelIds;
      const forcedVisibleIds = side === 'agree' ? targetMessageIds : new Set<string>();
      const scopedBaseMessageIds = new Set(projectionBaseMessages.map(message => message.id));
      const graphMessages = (side === 'agree' ? baseMessagesWithTarget : projectionBaseMessages).filter(message => {
        if (forcedVisibleIds.has(message.id)) return true;
        if (sideSuppressedRelIds.has(message.id)) return false;
        if (isInsideClassify && scopedBaseMessageIds.has(message.id)) return true;
        if (isContentKind(message.kind) && sideHiddenTextIds.has(message.id)) return false;
        if (message.kind === 'relation' && sideHiddenRelationIds.has(message.id)) return false;
        if (isContentKind(message.kind) && sideOwnedRelationIds.has(message.id)) return false;
        return true;
      });
      const graphVisibleIds = new Set(graphMessages.map(message => message.id));
      const graphEdges = baseEdgesWithTarget.filter(edge => {
        if (sideSuppressedRelIds.has(edge.relationMessageId)) return false;
        if (!graphVisibleIds.has(edge.relationMessageId) && !focusRelationMsgIds.has(edge.relationMessageId)) return false;
        if (focusRelationMsgIds.has(edge.relationMessageId)) return true;
        if (edge.relationType === 'classify' || edge.relationType === 'summary') return true;
        const fromOk = edge.from.messageId.startsWith('anon:') || graphVisibleIds.has(edge.from.messageId);
        const toOk = graphVisibleIds.has(edge.to.messageId);
        return fromOk && toOk;
      });
      return { messages: graphMessages, edges: graphEdges, hideMessageIds: undefined };
    };

    return { agree: buildProjection('agree'), disagree: buildProjection('disagree') };
  }, [comparisonReviewed, comparisonTargetId, relations, relationById, rejectedContainerIds, rejectedJoinRelationIds, userPreferredJoinByTarget, edges, msgMap, messages, mergeOwnership, replacedRelationMsgIds, focusRelationMsgIds, comparisonReviewBaseMessages, comparisonReviewBaseEdges, normalGraphProjection, isInsideClassify, comparisonAgreeSuppressedRelIds, comparisonDisagreeSuppressedRelIds]);

  function handleCanvasBlankClick() {
    setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection(); setLastClickedMessageId(null);
    setRelationType(null); setSecondaryRelationType("none");
  }

  async function confirmReverseCorrection() {
    const preview = comparisonPopup?.reversePreview;
    if (!preview || !topicId) return;
    try {
      if (preview.mode === 'source') {
        const sourceMessage = await handleSendMessageOnly(preview.after);
        if (!sourceMessage) return;
        await handleCreateRelationWithSourcesAndTargets({
          sources: [{ messageId: sourceMessage.id, selection: { kind: 'whole' } }],
          targets: [preview.target],
          label: preview.label ?? relationTypeName('correct'),
        });
      } else {
        const backendRel = await createRel(topicId, {
          relationType: 'CORRECT',
          sourceMessageId: null,
          targetRefs: [unitSelectionToTargetRef(preview.target, msgMap)],
          payload: { correctionContent: preview.after },
        });
        await registerCreatedRelationInCurrentClassify(backendRel);
        setEdges(prev => [...prev, {
          id: nextId('edge'),
          relationMessageId: backendRel.id,
          relationType: 'correct',
          from: { messageId: `anon:${backendRel.id}`, selection: { kind: 'whole' } },
          to: preview.target,
          relationLabel: relationTypeName('correct'),
        }]);
      }
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent(''); setRelationType(null); setSecondaryRelationType('none');
      setComparisonPopup(null);
    } catch (e: any) {
      showAlert(`建立反向更正失败: ${e?.message ?? e}`);
    }
  }

  async function handleDecorationIconClick(messageId: string, kind: "agree" | "disagree") {
    // Quick send: pure-stance agree/disagree — relation messages are first-class, persist to backend
    if (comparisonReviewed) return;
    if (!topicId) return;
    if (kind === 'agree' && msgMap.get(messageId)?.relationType === 'correct') {
      const correctionVersion = Array.from(correctionVersions.values())
        .flatMap(entry => entry.versions)
        .find(version => version.correctionId === messageId);
      if (correctionVersion && hasActiveCorrectionForSelection(
        correctionVersion.targetId,
        correctionVersion.selection,
        correctionVersions,
        correctionVersion.correctionId,
      )) {
        showAlert('该字段已有其他有效更正，不能赞同这条更正');
        return;
      }
    }
    try {
      const backendRel = await createRel(topicId, {
        relationType: kind.toUpperCase(),
        sourceMessageId: null,
        targetRefs: [unitSelectionToTargetRef({ messageId, selection: { kind: "whole" } }, msgMap)],
      });
      await registerCreatedRelationInCurrentClassify(backendRel);
    } catch (e: any) { showAlert(`建立关系失败: ${e?.message ?? e}`); }
  }

  async function handleComparisonVote(side: 'agree' | 'disagree' = 'agree') {
    if (isPreloaded || !comparisonReviewed) return;
    if (!requireAuth()) return;
    const targetId = comparisonTargetId ?? (draftUnits.length === 1 ? draftUnits[0].messageId : null);
    if (!topicId || !targetId) return;
    const amount = typeof relStakeAmount === 'number' ? relStakeAmount : 0;
    const minimum = effectiveMinStake;
    if (amount < minimum) {
      setSendError(`关系消息最低押注 ${minimum} 点（当前 ${amount}）`);
      return;
    }
    if (amount > availablePoints) {
      setSendError(`贡献点余额不足：需要 ${amount} 点，可用 ${availablePoints} 点`);
      return;
    }
    setSendError(null);
    try {
      const relation = await createRel(topicId, {
        relationType: side.toUpperCase(),
        sourceMessageId: null,
        targetRefs: [unitSelectionToTargetRef({ messageId: targetId, selection: { kind: 'whole' } }, msgMap)],
        stakeAmount: amount,
      });
      await registerCreatedRelationInCurrentClassify(relation);
    } catch (e: any) {
      showAlert(`建立对比表态失败: ${e?.message ?? e}`);
    }
  }

  function handleDecorationBodyClick(e: React.MouseEvent, messageId: string, kind: "agree" | "disagree") {
    e.stopPropagation();
    // Toggle selection of all agree/disagree relation messages targeting this message
    const matchingRelMsgs = edges.filter(edge =>
      edge.relationType === kind &&
      edge.to.messageId === messageId &&
      edge.to.selection.kind === "whole"
    ).map(edge => edge.relationMessageId);
    const uniqueRelMsgIds = Array.from(new Set(matchingRelMsgs));
    setLastClickedMessageId(uniqueRelMsgIds[0] ?? messageId);
    for (const relMsgId of uniqueRelMsgIds) {
      const wholeUnit: UnitSelection = { messageId: relMsgId, selection: { kind: "whole" } };
      setDraftUnits(prev => {
        const exists = prev.some(u => unitEquals(u, wholeUnit));
        return exists ? prev.filter(u => !unitEquals(u, wholeUnit)) : [...prev, wholeUnit];
      });
    }
  }

  function handleDecorationDoubleClick(e: React.MouseEvent, messageId: string, kind: "agree" | "disagree") {
    e.stopPropagation();

    // Phase 5: Stance path highlight — trace the argumentation chain
    // 1. Find all AGREE/DISAGREE edges pointing to this message
    const stanceEdges = edges.filter(
      edge => edge.relationType === kind &&
        edge.to.messageId === messageId &&
        edge.to.selection.kind === 'whole'
    );

    // 2. Collect source TEXT messages (non-anonymous origins) from those edges
    const sourceMsgIds = new Set<string>();
    for (const edge of stanceEdges) {
      if (!edge.from.messageId.startsWith('anon:')) {
        sourceMsgIds.add(edge.from.messageId);
      }
    }

    // 3. For each source TEXT message, find outgoing REFERENCE(证据) edges
    const evidenceMsgIds: string[] = [];
    const seenEvidence = new Set<string>();
    for (const srcId of sourceMsgIds) {
      const evidenceEdges = edges.filter(
        edge => edge.relationType === 'reference' &&
          edge.from.messageId === srcId &&
          (edge.relationLabel === '证据' || edge.relationLabel === 'evidence')
      );
      for (const evEdge of evidenceEdges) {
        if (!seenEvidence.has(evEdge.to.messageId)) {
          seenEvidence.add(evEdge.to.messageId);
          evidenceMsgIds.push(evEdge.to.messageId);
        }
      }
    }

    // 4. Highlight: stance target (this message) + all source text messages + evidence targets
    const allHighlightIds = [messageId, ...sourceMsgIds, ...evidenceMsgIds];
    setStanceHighlight({ stanceMsgId: messageId, evidenceMsgIds: allHighlightIds });
    if (stanceHighlightTimerRef.current) clearTimeout(stanceHighlightTimerRef.current);
    stanceHighlightTimerRef.current = setTimeout(() => {
      setStanceHighlight(null);
    }, 3000);

    // Also show the popup for reference
    setDecorationPopup({ messageId, kind, x: e.clientX, y: e.clientY });
  }

  function handleTagBodyClick(e: React.MouseEvent, messageId: string, _tagLabel: string, relMsgIds: string[]) {
    e.stopPropagation();
    setLastClickedMessageId(messageId);
    setDraftUnits(prev => {
      const anySelected = relMsgIds.some(id => prev.some(u => u.messageId === id && u.selection.kind === "whole"));
      if (anySelected) {
        return prev.filter(u => !(relMsgIds.includes(u.messageId) && u.selection.kind === "whole"));
      } else {
        const toAdd = relMsgIds.filter(id => !prev.some(u => u.messageId === id && u.selection.kind === "whole"));
        return [...prev, ...toAdd.map(id => ({ messageId: id, selection: { kind: "whole" as const } }))];
      }
    });
  }

  function handleTagDoubleClick(e: React.MouseEvent, messageId: string, tagLabel: string, relMsgIds: string[]) {
    e.stopPropagation();
    setTagPopup({ messageId, tagLabel, relMsgIds, x: e.clientX, y: e.clientY });
  }

  function handleGroupFrameClick(e: React.MouseEvent, relMsgId: string) {
    e.stopPropagation();
    setLastClickedMessageId(relMsgId);
    toggleWholeUnit(relMsgId);
  }

  function handleGroupFrameDoubleClick(e: React.MouseEvent, relMsgId: string) {
    e.stopPropagation();
    setLastClickedMessageId(relMsgId);
    const relEdges = edges.filter(ed => ed.relationMessageId === relMsgId);
    const relType = relEdges[0]?.relationType ?? relationTypeByRelMsgId.get(relMsgId) ?? "";
    if (relType === "classify" || relType === "summary") {
      enterClassifyTopic(relMsgId);
      return;
    }
    if (relType === "merge") {
      setMergeInfoPopup({ relMsgId, x: e.clientX, y: e.clientY });
      return;
    }
    enterFocus(relMsgId);
  }

  function handleInlineBadgeClick(e: React.MouseEvent, relMsgId: string) {
    e.stopPropagation();
    setLastClickedMessageId(relMsgId);
    toggleWholeUnit(relMsgId);
  }

  // 跨分类引用标签点击：选中关系消息
  function handleCrossRefTagClick(e: React.MouseEvent, relMsgIds: string[]) {
    e.stopPropagation();
    if (relMsgIds.length === 0) return;
    setLastClickedMessageId(relMsgIds[0]);
    setDraftUnits(prev => {
      const anySelected = relMsgIds.some(id => prev.some(u => u.messageId === id && u.selection.kind === "whole"));
      if (anySelected) {
        return prev.filter(u => !(relMsgIds.includes(u.messageId) && u.selection.kind === "whole"));
      } else {
        const toAdd = relMsgIds.filter(id => !prev.some(u => u.messageId === id && u.selection.kind === "whole"));
        return [...prev, ...toAdd.map(id => ({ messageId: id, selection: { kind: "whole" as const } }))];
      }
    });
  }

  /** Navigate to a message: switch canvas if needed, scroll, select (clear + add to candidates) */
  const handleNavigateToMessage = useCallback((messageId: string) => {
    const targetMessage = messagesRef.current.find(message => message.id === messageId);
    const isSpecialTarget = targetMessage?.kind === 'join'
      || targetMessage?.kind === 'round'
      || targetMessage?.kind === 'round_result';
    const isCorrectionTarget = targetMessage?.relationType?.toUpperCase() === 'CORRECT'
      || relationsRef.current.some(relation => relation.id === messageId && relation.relationType?.toUpperCase() === 'CORRECT')
      || edgesRef.current.some(edge => edge.relationType?.toUpperCase() === 'CORRECT' && edge.to.messageId === messageId);
    const allDependencyIds = collectNavigationDisplayDependencies(
      messageId,
      messagesRef.current,
      relationsRef.current,
      edgesRef.current,
      !isCorrectionTarget,
    );
    const dependencyIds = isSpecialTarget || isCorrectionTarget
      ? new Set([messageId])
      : allDependencyIds;
    const navigationFilterState = navigationVisibilityRef.current;
    const targetEndpointIds = new Set(Array.from(dependencyIds).filter(id => id !== messageId));
    const isRenderedDependency = (dependencyId: string) =>
      renderedMessageIdsRef.current.has(dependencyId)
      || renderedRelationIdsRef.current.has(dependencyId);
    let cleanFilteredDependencyIds = navigationFilterState.cleanMode && navigationFilterState.cleanVisibleIds
      ? Array.from(dependencyIds).filter(dependencyId => {
          const dependency = messagesRef.current.find(message => message.id === dependencyId);
          if (!dependency) return false;
          return dependency.kind === 'relation'
            ? !navigationFilterState.cleanVisibleIds!.visibleRelIds.has(dependencyId)
            : !navigationFilterState.cleanVisibleIds!.visibleTextIds.has(dependencyId);
        })
      : [];
    let typeFilteredDependencyIds = Array.from(dependencyIds).filter(dependencyId => {
      const dependency = messagesRef.current.find(message => message.id === dependencyId);
      if (!dependency) return false;
      return (navigationFilterState.msgFilter.hideJoin && dependency.kind === 'join')
        || (navigationFilterState.msgFilter.hideSettlement
          && (dependency.kind === 'round' || dependency.kind === 'round_result'));
    });
    const targetCleanFiltered = cleanFilteredDependencyIds.includes(messageId);
    const targetTypeFiltered = typeFilteredDependencyIds.includes(messageId);
    const canAutoClearTargetFilters = isSpecialTarget && (targetCleanFiltered || targetTypeFiltered);
    if (canAutoClearTargetFilters) {
      if (targetCleanFiltered) {
        clearCleanView();
        cleanFilteredDependencyIds = cleanFilteredDependencyIds.filter(id => id !== messageId);
      }
      if (targetTypeFiltered) {
        setMsgFilter(previous => ({
          ...previous,
          hideJoin: targetMessage?.kind === 'join' ? false : previous.hideJoin,
          hideSettlement: targetMessage?.kind === 'round' || targetMessage?.kind === 'round_result'
            ? false
            : previous.hideSettlement,
        }));
        typeFilteredDependencyIds = typeFilteredDependencyIds.filter(id => id !== messageId);
      }
    }
    const missingDataDependencyIds = Array.from(dependencyIds).filter(dependencyId =>
      !messagesRef.current.some(message => message.id === dependencyId)
      && !relationsRef.current.some(relation => relation.id === dependencyId));
    const notRenderedDependencyIds = Array.from(dependencyIds).filter(dependencyId =>
      dependencyId !== messageId
      && !missingDataDependencyIds.includes(dependencyId)
      && !isRenderedDependency(dependencyId));
    const unavailableReasons: string[] = [];
    if (cleanFilteredDependencyIds.length > 0) {
      unavailableReasons.push(`清爽视图过滤了 ${cleanFilteredDependencyIds.length} 个依赖消息`);
    }
    if (typeFilteredDependencyIds.length > 0) {
      unavailableReasons.push(`消息类型过滤了 ${typeFilteredDependencyIds.length} 个依赖消息`);
    }
    if (missingDataDependencyIds.length > 0) {
      unavailableReasons.push(`缺少 ${missingDataDependencyIds.length} 个消息或关系数据`);
    }
    if (notRenderedDependencyIds.length > 0) {
      unavailableReasons.push(`当前画布未显示 ${notRenderedDependencyIds.length} 个目标或依赖消息`);
    }
    if (unavailableReasons.length > 0) {
      operationLog('消息跳转受阻', `target=${messageId}`);
      showAlert(`无法跳转：${unavailableReasons.join('；')}。请先调整过滤条件或切换到能显示目标消息的画布。`);
      pendingScrollDependencyIdsRef.current = [];
      pendingScrollMsgRef.current = null;
      return;
    }
    setJoinFilterTargetId(null);
    setFocusEntries([]);
    setFocusKey(k => k + 1);
    // Clear candidates and select the target message as whole
    setDraftUnits([{ messageId, selection: { kind: 'whole' as const } }]);
    setSourceUnits([]);
    setTargetUnits([]);
    setLastClickedMessageId(messageId);
    // Scroll after canvas switch; bump scrollKey so the scroll effect re-triggers even
    // when the target is already on the current canvas (no classifyKey change).
    pendingScrollDependencyIdsRef.current = Array.from(new Set([messageId, ...targetEndpointIds]));
    pendingScrollMsgRef.current = messageId;
    setScrollKey(k => k + 1);
  }, [classifyRelMsgId, cleanMode, msgFilter, isTemporaryJoinCategory, clearCleanView, showAlert]);

  const handleNavigateFromCorrectionTemporaryCategory = useCallback((messageId: string, switchToList: boolean) => {
    if (correctionFilterTargetId === null) {
      handleNavigateToMessage(messageId);
      return;
    }
    pendingCorrectionNavigationRef.current = { messageId };
    exitTemporaryCategory();
    setCorrectionFilterTargetId(null);
    if (switchToList) setViewMode('list');
  }, [correctionFilterTargetId, handleNavigateToMessage, viewMode]);

  function handleInlineBadgeDoubleClick(e: React.MouseEvent, relMsgId: string, detail?: { relMsgIds?: string[]; subDetails?: Array<{subType:string;customLabel?:string;count:number}> }) {
    e.stopPropagation();
    // Recommend/archive: show aggregated badge detail with subType breakdown
    const relEdges = edges.filter(ed => ed.relationMessageId === relMsgId);
    const relType = relEdges[0]?.relationType;
    if (relType === 'recommend' || relType === 'archive') {
      const targetMid = relEdges[0]?.to.messageId;
      if (!targetMid) return;
      const typeName = relationTypeName(relType);
      const allRelMsgIds = detail?.relMsgIds ?? Array.from(new Set(
        edges.filter(ed => ed.relationType === relType && ed.to.messageId === targetMid && ed.to.selection.kind === 'whole')
          .map(ed => ed.relationMessageId)
      ));
      setTagPopup({ messageId: targetMid, tagLabel: typeName, relMsgIds: allRelMsgIds, x: e.clientX, y: e.clientY, subDetails: detail?.subDetails });
    } else if (relType === 'correct') {
      const targetId = relEdges[0]?.to.messageId;
      if (!targetId) return;
      enterTemporaryCategory(true);
      setJoinFilterTargetId(null);
      setCorrectionFilterTargetId(targetId);
      setViewMode("list");
    } else {
      // Correction badge and other inline badges: show comparison popup
      setComparisonPopup({ relMsgId, x: e.clientX, y: e.clientY });
    }
  }

  function toggleWholeUnit(msgId: string) {
    const wholeUnit: UnitSelection = { messageId: msgId, selection: { kind: "whole" } };
    setDraftUnits(prev => {
      const exists = prev.some(u => unitEquals(u, wholeUnit));
      return exists ? prev.filter(u => !unitEquals(u, wholeUnit)) : [...prev, wholeUnit];
    });
  }

  async function handleArchiveTopic() {
    if (!topicId || !topic) return;
    try {
      const updated = await api.updateTopic(topicId, { status: topic.status === 'ARCHIVED' ? 'OPEN' : 'ARCHIVED' });
      setTopic(updated);
    } catch (e: any) { showAlert(`操作失败: ${e?.message ?? e}`); }
  }

  function handleSplitterMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    setSplitterActive(true);
    splitterDragRef.current = { startX: e.clientX, startFlex: leftFlex };
    function onMouseMove(ev: MouseEvent) {
      if (!splitterDragRef.current || !panelContainerRef.current) return;
      const dx = ev.clientX - splitterDragRef.current.startX;
      const containerW = panelContainerRef.current.clientWidth;
      const flexChange = containerW > 0 ? (dx / containerW) * TOTAL_FLEX : 0;
      const newLeft = Math.max(MIN_LEFT_FLEX, Math.min(MAX_LEFT_FLEX, splitterDragRef.current.startFlex + flexChange));
      // Adjust containerWidth to keep right panel between MIN_RIGHT_PX and MAX_RIGHT_PX
      const rightFlex = TOTAL_FLEX - newLeft;
      if (rightFlex > 0) {
        const rightPx = (containerW - 12) * rightFlex / TOTAL_FLEX;
        if (rightPx < MIN_RIGHT_PX) {
          setContainerWidth(prev => Math.max(prev, Math.ceil(MIN_RIGHT_PX * TOTAL_FLEX / rightFlex + 12)));
        } else if (rightPx > MAX_RIGHT_PX) {
          setContainerWidth(prev => Math.max(BASE_WIDTH, Math.min(prev, Math.ceil(MAX_RIGHT_PX * TOTAL_FLEX / rightFlex + 12))));
        }
      }
      setLeftFlex(newLeft);
    }
    function onMouseUp() {
      setSplitterActive(false);
      splitterDragRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function handleSplitterTouchStart(e: React.TouchEvent) {
    e.preventDefault();
    setSplitterActive(true);
    const touch = e.touches[0];
    if (!touch) return;
    splitterDragRef.current = { startX: touch.clientX, startFlex: leftFlex };
    function onTouchMove(ev: TouchEvent) {
      if (!splitterDragRef.current || !panelContainerRef.current) return;
      const t = ev.touches[0];
      if (!t) return;
      const dx = t.clientX - splitterDragRef.current.startX;
      const containerW = panelContainerRef.current.clientWidth;
      const flexChange = containerW > 0 ? (dx / containerW) * TOTAL_FLEX : 0;
      const newLeft = Math.max(MIN_LEFT_FLEX, Math.min(MAX_LEFT_FLEX, splitterDragRef.current.startFlex + flexChange));
      // Adjust containerWidth to keep right panel between MIN_RIGHT_PX and MAX_RIGHT_PX
      const rightFlex = TOTAL_FLEX - newLeft;
      if (rightFlex > 0) {
        const rightPx = (containerW - 12) * rightFlex / TOTAL_FLEX;
        if (rightPx < MIN_RIGHT_PX) {
          setContainerWidth(prev => Math.max(prev, Math.ceil(MIN_RIGHT_PX * TOTAL_FLEX / rightFlex + 12)));
        } else if (rightPx > MAX_RIGHT_PX) {
          setContainerWidth(prev => Math.max(BASE_WIDTH, Math.min(prev, Math.ceil(MAX_RIGHT_PX * TOTAL_FLEX / rightFlex + 12))));
        }
      }
      setLeftFlex(newLeft);
    }
    function onTouchEnd() {
      setSplitterActive(false);
      splitterDragRef.current = null;
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    }
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
  }

  useEffect(() => {
    const panel = leftPanelRef.current;
    if (!panel) return;
    const handleTouchStart = (event: TouchEvent) => {
      leftPanelTouchRef.current = event.touches.length === 1
        ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
        : null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1 || !leftPanelTouchRef.current) {
        leftPanelTouchRef.current = null;
        return;
      }
      const touch = event.touches[0];
      const deltaX = touch.clientX - leftPanelTouchRef.current.x;
      const maxPanelScrollLeft = Math.max(0, panel.scrollWidth - panel.clientWidth);
      const atLeftEdge = panel.scrollLeft <= 0 && deltaX > 0;
      const atRightEdge = panel.scrollLeft >= maxPanelScrollLeft - 1 && deltaX < 0;
      const documentScroller = document.scrollingElement;
      if ((atLeftEdge || atRightEdge) && documentScroller && deltaX !== 0) {
        const maxDocumentScrollLeft = Math.max(0, documentScroller.scrollWidth - documentScroller.clientWidth);
        const nextScrollLeft = Math.max(0, Math.min(
          maxDocumentScrollLeft,
          documentScroller.scrollLeft - deltaX,
        ));
        if (nextScrollLeft !== documentScroller.scrollLeft) {
          event.preventDefault();
          documentScroller.scrollLeft = nextScrollLeft;
        }
      }
      leftPanelTouchRef.current = { x: touch.clientX, y: touch.clientY };
    };
    const handleTouchEnd = () => { leftPanelTouchRef.current = null; };
    panel.addEventListener('touchstart', handleTouchStart, { passive: true });
    panel.addEventListener('touchmove', handleTouchMove, { passive: false });
    panel.addEventListener('touchend', handleTouchEnd, { passive: true });
    panel.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    return () => {
      panel.removeEventListener('touchstart', handleTouchStart);
      panel.removeEventListener('touchmove', handleTouchMove);
      panel.removeEventListener('touchend', handleTouchEnd);
      panel.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [loading, viewMode, comparisonReviewed, messages.length, edges.length, comparisonMode]);

  // Phase 6: Clean mode — computed by useCleanView hook (multi-dimensional filters)

  useEffect(() => {
    const panel = leftPanelRef.current;
    if (!panel) return;
    const comparisonSource = panel.querySelector('[data-comparison-scroll-horizontal]') as HTMLElement | null;
    const measure = () => {
      const documentScrollSource = document.scrollingElement;
      setDocumentHorizontalScrollVisible(Boolean(documentScrollSource && documentScrollSource.scrollWidth > documentScrollSource.clientWidth + 1));
      const comparisonViewports = Array.from(panel.querySelectorAll<HTMLElement>('[data-comparison-viewport]'));
      const comparisonViewport = comparisonViewports.reduce<HTMLElement | null>((widest, viewport) => {
        if (!widest) return viewport;
        return viewport.scrollWidth - viewport.clientWidth > widest.scrollWidth - widest.clientWidth
          ? viewport
          : widest;
      }, null);
      const comparisonPair = panel.querySelector('[data-comparison-pair]') as HTMLElement | null;
      const candidate = comparisonViewport ?? panel;
      leftHorizontalScrollSourceRef.current = candidate;
      const sourceRect = candidate.getBoundingClientRect();
      const rect = comparisonPair?.getBoundingClientRect() ?? sourceRect;
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const visibleLeft = Math.max(0, Math.min(rect.left, viewportWidth));
      const visibleWidth = Math.max(0, Math.min(rect.width, viewportWidth - visibleLeft));
      leftHorizontalScrollScaleRef.current = sourceRect.width / Math.max(candidate.offsetWidth, 1);
      const scale = leftHorizontalScrollScaleRef.current;
      const visible = candidate.scrollWidth > candidate.clientWidth + 1;
      setLeftHorizontalScrollMetrics(previous => {
        const sourceOverflow = Math.max(candidate.scrollWidth - candidate.clientWidth, 0) * scale;
        const next = { visible, left: visibleLeft, width: visibleWidth, scrollWidth: Math.max(visibleWidth + sourceOverflow, 1) };
        return previous.visible === next.visible
          && previous.left === next.left
          && previous.width === next.width
          && previous.scrollWidth === next.scrollWidth
          ? previous
          : next;
      });
      const scrollbar = leftHorizontalScrollRef.current;
      const nextScrollLeft = candidate.scrollLeft * scale;
      if (scrollbar && scrollbar.scrollLeft !== nextScrollLeft) scrollbar.scrollLeft = nextScrollLeft;
    };
    const syncScrollbar = () => {
      const candidate = leftHorizontalScrollSourceRef.current ?? panel;
      const scrollbar = leftHorizontalScrollRef.current;
      const scale = leftHorizontalScrollScaleRef.current;
      const nextScrollLeft = candidate.scrollLeft * scale;
      if (scrollbar && scrollbar.scrollLeft !== nextScrollLeft) scrollbar.scrollLeft = nextScrollLeft;
    };
    const syncSource = () => {
      const candidate = leftHorizontalScrollSourceRef.current ?? panel;
      const scrollbar = leftHorizontalScrollRef.current;
      const scale = leftHorizontalScrollScaleRef.current;
      if (scrollbar && candidate.scrollLeft !== scrollbar.scrollLeft / scale) candidate.scrollLeft = scrollbar.scrollLeft / scale;
      measure();
    };
    panel.addEventListener('scroll', syncScrollbar, { passive: true });
    comparisonSource?.addEventListener('scroll', syncScrollbar, { passive: true });
    panel.querySelectorAll<HTMLElement>('[data-comparison-viewport]').forEach(viewport => {
      viewport.addEventListener('scroll', syncScrollbar, { passive: true });
    });
    const scrollbar = leftHorizontalScrollRef.current;
    scrollbar?.addEventListener('scroll', syncSource, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resizeObserver?.observe(panel);
    for (const element of panel.querySelectorAll<HTMLElement>('[data-jump-canvas], [data-comparison-pair], [data-comparison-scroll-horizontal], [data-comparison-scroll-horizontal] > div')) {
      resizeObserver?.observe(element);
    }
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    measure();
    return () => {
      panel.removeEventListener('scroll', syncScrollbar);
      comparisonSource?.removeEventListener('scroll', syncScrollbar);
      panel.querySelectorAll<HTMLElement>('[data-comparison-viewport]').forEach(viewport => {
        viewport.removeEventListener('scroll', syncScrollbar);
      });
      scrollbar?.removeEventListener('scroll', syncSource);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
    };
  }, [loading, viewMode, comparisonReviewed, messages.length, edges.length, comparisonMode]);

  if (loading) {
    return <div style={{ padding: 16, background: "#101010", color: "#eee", height: "100%" }}>加载中…</div>;
  }
  if (loadError) {
    return (
      <div style={{ padding: 16, background: "#101010", color: "#eee", height: "100%" }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>加载失败</div>
        <pre style={{ whiteSpace: "pre-wrap", color: "#ff8080" }}>{loadError}</pre>
      </div>
    );
  }

  const messagesToRender = viewMode === "list" ? listMessagesToRender : graphMessagesToRender;
  const messagesWithCorrections = messagesToRender.map(message => {
    const correction = correctionVersions.get(message.id)?.current;
    return correction ? { ...message, content: correction.content } : message;
  });
  // Phase 6: Apply clean mode filter (multi-dimensional rules via useCleanView)
  const messagesToRenderClean = cleanVisibleIds
    ? messagesWithCorrections.filter(m =>
        cleanVisibleIds.visibleTextIds.has(m.id) || cleanVisibleIds.visibleRelIds.has(m.id))
    : messagesWithCorrections;
  // Message type filter: hide settlement/join messages
  const typeFilteredMessages = applyMessageFilter(messagesToRenderClean, msgFilter);
  const temporaryJoinViewIds = joinFilterTargetId
    ? new Set((joinFilterDirection === 'outgoing'
      ? (joinRelationsBySource.get(joinFilterTargetId) ?? [])
      : (joinRelationsByTarget.get(joinFilterTargetId) ?? [])
    ).map(join => join.id))
    : null;
  const comparisonViewIds = comparisonMode
    ? new Set(comparisonTargets.map(item => item.message.id))
    : null;
  const correctionTemporaryViewIds = correctionFilterTargetId
    ? new Set(
        edges
          .filter(edge => edge.relationType === 'correct' && edge.to.messageId === correctionFilterTargetId)
          .map(edge => edge.relationMessageId),
      )
    : null;
  // JOIN records can belong to different containers and therefore be absent
  // from the current canvas. Build this temporary category from the full
  // message map and show JOIN records only, not the target message itself.
  const messagesToRenderFiltered = comparisonViewIds
    ? Array.from(comparisonViewIds)
        .map(id => msgMap.get(id))
        .filter((message): message is DemoMessage => Boolean(message))
    : correctionTemporaryViewIds
    ? Array.from(correctionTemporaryViewIds)
        .map(id => msgMap.get(id))
        .filter((message): message is DemoMessage => Boolean(message))
    : temporaryJoinViewIds
    ? Array.from(temporaryJoinViewIds)
        .map(id => msgMap.get(id))
        .filter((message): message is DemoMessage => Boolean(message))
        .filter(message => !msgFilter.hideJoin || message.kind !== 'join')
    : typeFilteredMessages;
  renderedMessageIdsRef.current = new Set(messagesToRenderFiltered.map(message => message.id));

  const rawEdgesToRender = filterContainerEdgesByEffectiveJoins(
    viewMode === "list" ? listEdgesToRender : graphEdgesToRender,
    relations,
    effectiveJoinRelationIds,
  );
  // Phase 6: Also filter edges through clean view
  const rawEdgesToRenderClean = cleanVisibleIds
    ? rawEdgesToRender.filter(e => cleanVisibleIds.visibleRelIds.has(e.relationMessageId))
    : rawEdgesToRender;
  // Filter edges based on current user's DISAGREE stances on relation messages.
  // When the user disagrees with a relation message, all edges produced by that
  // relation are suppressed from this user's view (per-user branch semantics).
  const temporaryEdgesToRender = comparisonViewIds
    ? rawEdgesToRender
    : correctionTemporaryViewIds
    ? rawEdgesToRender.filter(edge => correctionTemporaryViewIds.has(edge.relationMessageId))
    : temporaryJoinViewIds
    ? rawEdgesToRender.filter(edge => temporaryJoinViewIds.has(edge.relationMessageId))
    : rawEdgesToRender;
  // A user's DISAGREE relation may be outside the current classify scope.
  // Use all topic edges to determine suppression, then filter only the edges
  // currently being rendered.
  const effectiveSuppressedRelIds = computeEffectiveSuppressedRelIds(edges, messages, displayUser?.username ?? null);
  const comparisonSuppressedRelIds = comparisonReviewed && comparisonTargetId
    ? comparisonSide === 'agree' ? comparisonAgreeSuppressedRelIds : comparisonDisagreeSuppressedRelIds
    : effectiveSuppressedRelIds;
  const filteredEdgesToRender = temporaryEdgesToRender.filter(edge =>
    edge.relationType === 'correct' || !comparisonSuppressedRelIds.has(edge.relationMessageId),
  );
  // The linear list keeps the annotation and its DISAGREE relation so the
  // user's stance can be shown on the source message. The non-linear graph
  // uses the suppressed relation set as a visual projection only.
  const edgesToRender = viewMode === "list" ? temporaryEdgesToRender : filteredEdgesToRender;
  renderedRelationIdsRef.current = new Set(edgesToRender.map(edge => edge.relationMessageId));
  const suppressedRelIds = comparisonSuppressedRelIds;
  const graphMessagesFinal = messagesToRenderFiltered
    .filter(message => correctionTemporaryViewIds?.has(message.id) || !suppressedRelIds.has(message.id))
    .map(message => {
    const correction = correctionVersions.get(message.id)?.current;
    return correction ? { ...message, content: correction.content } : message;
    });
  const comparisonAgreeGraph = comparisonGraphProjections?.agree;
  const comparisonDisagreeGraph = comparisonGraphProjections?.disagree;
  const comparisonGraphMessages = comparisonAgreeGraph?.messages ?? messagesToRenderFiltered;
  const invalidCorrectionIds = (() => {
    const ids = new Set<string>();
    for (const entry of correctionVersions.values()) {
      for (const version of entry.versions) if (!version.valid || version.conflicted) ids.add(version.correctionId);
    }
    return ids;
  })();

  // Which agree/disagree decoration badges are currently selected (via draftUnits)
  const selectedDecorations = (() => {
    const sel = new Set<string>();
    const draftRelIds = new Set(draftUnits.map(u => u.messageId));
    for (const e of edgesToRender) {
      if (e.relationType !== 'agree' && e.relationType !== 'disagree') continue;
      if (draftRelIds.has(e.relationMessageId)) {
        sel.add(`${e.to.messageId}::${e.relationType}`);
      }
    }
    return sel;
  })();

  // And the active stance messages: which of the user's own agree/disagree messages
  // are the "current" stance on each target, for bidirectional visual linking.
  const activeStanceMap = computeUserActiveStanceRelIds(rawEdgesToRenderClean, messages, displayUser?.username ?? null);
  // Precomputed set of relation message IDs that are active stances.
  const activeStanceRelIds = new Set([...activeStanceMap.values()].map(v => v.relMsgId));
  // Set of target message IDs that have an active stance against them.
  const activeStanceTargetIds = new Set(activeStanceMap.keys());
  // Reverse map: stance relation message ID → { target, type } for quick lookup.
  const activeStanceByRelMsgId = (() => {
    const m = new Map<string, { targetRelId: string; type: 'agree' | 'disagree' }>();
    for (const [targetId, v] of activeStanceMap) m.set(v.relMsgId, { targetRelId: targetId, type: v.type });
    return m;
  })();
  // Overridden stances: the user's previous stance messages that are no longer active.
  const overriddenStanceRelIds = computeUserOverriddenStanceRelIds(rawEdgesToRender, messages, displayUser?.username ?? null);
  const isOwner = user && topic && (topic as any).author?.id === user.id;

  return (
    <>
    <ErrorBoundary>
    <div style={{ minHeight: "100%", minWidth: containerWidth, margin: 0, display: "flex", flexDirection: "column", background: "#101010", color: "#eee", fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif" }}>
      <div style={{ padding: "8px 16px", borderBottom: "1px solid #333", background: "#181818", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 14, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isOwner && <>
            <button onClick={handleArchiveTopic} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#fff", fontSize: 11, cursor: "pointer" }}>
              {topic?.status === 'ARCHIVED' ? '重新开放' : '归档'}
            </button>
          </>}
        </div>
        {!isPreloaded && (
        <div style={{ display: "flex", gap: 12, fontSize: 12 }}>
          <span>关系类型：</span>
          {ALL_RELATION_TYPES.map(rt => (
            <button key={rt} onClick={() => {
              if (relationType === "tag") { lastTagSecondaryRef.current = secondaryRelationType !== "none" ? secondaryRelationType : "recommend"; }
              const isDeselecting = relationType === rt;
              const newType = isDeselecting ? null : rt;
              // Types that generally don't use the text input (user-to-message relations)
              const isTextLessType = (t: string | null) => t === "tag" || t === "merge";
              const wasTextLess = isTextLessType(relationType);
              const willBeTextLess = isTextLessType(newType);
              // Save and clear when switching TO a text-less type
              if (!wasTextLess && willBeTextLess && newMessageContent.trim()) {
                savedTextOnTypeSwitchRef.current = newMessageContent;
                // Also seed the subType buffer so that selecting CUSTOM
                // after entering TAG will restore this text.
                if (!subTypeCustomBufferRef.current) {
                  subTypeCustomBufferRef.current = newMessageContent;
                }
                setNewMessageContent("");
              }
              // When switching FROM a text-less type (e.g. TAG), save CUSTOM
              // reason text to subType buffer so it can be restored when the
              // user switches back to TAG and selects CUSTOM again.
              if (wasTextLess && !willBeTextLess && subType === 'CUSTOM' && newMessageContent.trim()) {
                subTypeCustomBufferRef.current = newMessageContent;
              }
              // Restore when switching FROM a text-less type
              if (wasTextLess && !willBeTextLess && savedTextOnTypeSwitchRef.current) {
                setNewMessageContent(savedTextOnTypeSwitchRef.current);
              }
              setRelationType(prev => prev === rt ? null : rt);
              if (rt === "tag") { setSecondaryRelationType(lastTagSecondaryRef.current || "recommend"); }
              else { setSecondaryRelationType(rt === "arrange" ? "vertical" : "none"); }
            }}
              style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: relationType === rt ? "#0b84ff" : "#222", color: relationType === rt ? "#fff" : "rgba(255,255,255,0.7)", cursor: "pointer" }}>
              {relationTypeName(rt)}
            </button>
          ))}
        </div>
        )}
      </div>

      <div ref={panelContainerRef} style={{ display: "flex", flex: "0 0 auto", minWidth: containerWidth }}>
        <div style={{ flex: leftFlex, display: "flex", flexDirection: "column", minWidth: 0, overflow: "visible", paddingBottom: 8 }}>
          <div style={{ flex: "0 0 auto", padding: 8, borderBottom: "1px solid #333", background: "#141414" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontWeight: 600 }}>{viewMode === "list" ? "消息列表（线性）" : "结构图（非线性）"}</div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button onClick={async () => {
                try {
                  const data = await api.exportTopic(topicId!);
                  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${topic?.title ?? 'export'}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                } catch (e: any) {
                  showAlert(`导出失败: ${e?.message ?? e}`);
                }
              }} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #4a9eff", background: "#1a3a5c", color: "#4a9eff", fontSize: 12, cursor: "pointer" }}>
                导出
              </button>
                <button onClick={() => navigate(`/topics/${topicId}?sender=${encodeURIComponent(user?.username ?? '')}`)} disabled={!user?.username} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#fff", fontSize: 12, cursor: user?.username ? "pointer" : "not-allowed", opacity: user?.username ? 1 : 0.5 }} title="在当前主题中查看我的消息">
                  主页
                </button>
                <CleanFilterPanel
                  active={cleanMode}
                  filters={cleanFilters}
                  matchCount={cleanVisibleIds?.visibleTextIds.size ?? 0}
                  totalCount={contentMsgCount}
                  onAdd={addCleanFilter}
                  onRemove={removeCleanFilter}
                  onUpdate={updateCleanFilter}
                  onClear={clearCleanView}
                />
                <MessageFilterPanel
                  settings={msgFilter}
                  onChange={setMsgFilter}
                />
                {!comparisonMode && !comparisonReviewed && <button
                  onClick={() => {
                    setComparisonMode(current => {
                      const next = !current;
                      if (next) enterTemporaryCategory(true);
                      setComparisonTargetId(null);
                      setComparisonReviewed(false);
                      setComparisonReviewBaseMessages(null);
                      setComparisonReviewBaseEdges(null);
                      if (next) setDraftUnits([]);
                      return next;
                    });
                    setViewMode('list');
                  }}
                  style={{ padding: "2px 8px", borderRadius: 4, border: comparisonMode ? "1px solid #22c55e" : "1px solid #666", background: comparisonMode ? "#12351f" : "#333", color: comparisonMode ? "#86efac" : "#fff", fontSize: 12, cursor: "pointer" }}
                  title="查看赞同/反对生效后的不同显示效果"
                >
                  {comparisonMode ? '退出对比' : '对比'}
                </button>}
                <button
                  onClick={() => setShowLeaderboard(true)}
                  style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #d97706", background: "#3f2a06", color: "#fbbf24", fontSize: 12, cursor: "pointer" }}
                  title="查看用户榜与消息榜"
                >
                  排行榜
                </button>
                {!comparisonMode && !comparisonReviewed && correctionFilterTargetId === null && <button onClick={() => {
                if (leftPanelRef.current) {
                  viewModeScrollRef.current[viewMode] = { top: leftPanelRef.current.scrollTop, left: leftPanelRef.current.scrollLeft };
                }
                const nextViewMode = viewMode === "list" ? "graph" : "list";
                const comparisonId = draftUnits.length === 1 ? draftUnits[0].messageId : comparisonTargetId;
                if (comparisonMode && nextViewMode === 'list') {
                  setComparisonTargetId(null);
                }
                setViewMode(nextViewMode);
                const scrollTargetId = comparisonMode ? comparisonId : lastClickedMessageId;
                if (scrollTargetId) {
                  const scrollTargetMessage = messages.find(message => message.id === scrollTargetId);
                  const scrollTargetRelation = relations.find(relation => relation.id === scrollTargetId);
                  const isCorrectionTarget = scrollTargetMessage?.relationType?.toUpperCase() === 'CORRECT'
                    || scrollTargetRelation?.relationType?.toUpperCase() === 'CORRECT';
                  setTimeout(() => scrollMsgToCenter(scrollTargetId, { resolveTarget: !isCorrectionTarget }), 100);
                }
              }} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#fff", fontSize: 12, cursor: "pointer" }}>
                {viewMode === "list" ? "切换为结构图" : "切换为列表"}
              </button>}
              </div>
            </div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {viewMode === "list" ? "线性视图：按线性结构查看消息。" : "结构图：按非线性结构查看消息。"}
            </div>
          </div>
          {(isInsideClassify || isTemporaryJoinCategory || correctionFilterTargetId !== null || comparisonMode) && (
            <div style={{ flex: "0 0 auto", padding: "8px 8px 12px 8px", background: "#101010" }}>
              <div style={{ border: "1px solid #334155", borderRadius: 10, padding: "8px 10px", background: "linear-gradient(180deg, #162036 0%, #0f172a 100%)", color: "#e2e8f0", boxShadow: "0 6px 16px rgba(0,0,0,0.25)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <div style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {comparisonMode
                        ? `对比临时分类（${comparisonTargets.length}）`
                        : correctionFilterTargetId !== null
                        ? `更正记录临时分类（${correctionTemporaryViewIds?.size ?? 0}）`
                        : isTemporaryJoinCategory ? `加入记录临时分类（${temporaryJoinCount}）` : (topicFocusTitle || classifyKindLabel)}
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 999, background: "rgba(34,197,94,0.18)", color: "#86efac", border: "1px solid rgba(34,197,94,0.35)", flexShrink: 0 }}>
                      {comparisonMode || correctionFilterTargetId !== null || isTemporaryJoinCategory ? "临时" : "进行中"}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "#94a3b8", display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {comparisonMode ? (
                      <span>{comparisonTargetId ? `正在审阅目标消息 ${comparisonTargetId}` : '显示所有影响显示效果的赞同/反对目标消息'}</span>
                    ) : correctionFilterTargetId !== null ? (
                      <span>目标消息 {correctionFilterTargetId} 的全部更正消息</span>
                    ) : isTemporaryJoinCategory ? (
                      <span>目标消息 {joinFilterTargetId} 的全部加入记录</span>
                    ) : (
                      <>
                        <span>由 <span style={{ fontWeight: 600, color: "#cbd5e1" }}>{currentClassifyRelMsg?.author ?? "系统"}</span> 发起</span>
                        <span>💬 {classifyTargetCount} 条观点</span>
                        <span>{currentClassifyRelMsg ? new Date(currentClassifyRelMsg.createdAt).toLocaleDateString('zh-CN') : ""}</span>
                      </>
                    )}
                  </div>
                </div>
                <button onClick={() => {
                  if (comparisonMode) {
                    exitTemporaryCategory();
                    return;
                  }
                  if (correctionFilterTargetId !== null || isTemporaryJoinCategory) {
                    exitTemporaryCategory();
                    return;
                  }
                  exitClassifyTopic();
                }} style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid #475569", background: "#1e293b", color: "#e2e8f0", cursor: "pointer", flexShrink: 0 }}>
                  {comparisonMode || correctionFilterTargetId !== null || isTemporaryJoinCategory ? "退出临时分类" : classifyExitLabel}
                </button>
              </div>
            </div>
          )}

          <div ref={leftPanelRef}
            data-topic-left-panel="true"
            className={`topic-left-panel ${isPreviewMode ? "preview-mode " : ""}${comparisonReviewed ? "comparison-scroll-host" : ""}`}
            style={{ flex: "0 0 auto", overflowY: "visible", overflowX: "auto", overscrollBehaviorX: "auto", touchAction: "pan-x pan-y pinch-zoom", scrollbarWidth: comparisonReviewed ? "none" : undefined, msOverflowStyle: comparisonReviewed ? "none" : undefined, WebkitOverflowScrolling: "touch", padding: 8, paddingBottom: 24, position: "relative" }}
            onDoubleClick={e => {
              const t = e.target as HTMLElement;
              // Skip if clicked on a message card, SVG edge, or relation overlay
              if (t.closest?.("[data-msgid]") || t.closest?.("svg") || t.closest?.('[title^="relation="]') || t.closest?.("[data-rel-overlay]")) return;
              handleCanvasBlankClick();
            }}>
            {messagePulse && <MessageJumpOverlay targetElement={messagePulse.element} visualRoot={messagePulse.visualRoot} targetRect={messagePulse.rect} visualRect={messagePulse.visualRect} />}
            {messagesToRenderFiltered.length === 0 ? (
              <div style={{ padding: 48, textAlign: "center", color: "#666", fontSize: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 36, opacity: 0.3 }}>📭</div>
                <div>{isInsideClassify ? `当前${classifyKindLabel}中暂无消息` : focusEntries.length > 0 ? "焦点范围内没有可见消息" : "暂无消息，请先发送一条消息或创建关系"}</div>
                <div style={{ fontSize: 12, opacity: 0.7, maxWidth: 360, lineHeight: 1.6 }}>
                  {isInsideClassify ? "该分类下还没有消息。你可以退出分类视图，在完整画布中发送消息。" : focusEntries.length > 0 ? "当前焦点范围内没有匹配的消息。尝试退出焦点或调整过滤规则。" : "发送消息会按规则自动自押一定贡献点（赞同自己），其他用户可通过赞同/反对表态并押注。押注会自动创建结算轮次，任何人都可以关闭结算来判定胜负并分配押注池，也可以重新发起结算推翻之前的结果。"}
                </div>
                {isInsideClassify && (
                  <button onClick={() => exitClassifyTopic()} style={{ marginTop: 8, padding: "4px 16px", borderRadius: 6, border: "1px solid #555", background: "#333", color: "#ccc", cursor: "pointer", fontSize: 13 }}>
                    {classifyExitLabel}
                  </button>
                )}
                {!isInsideClassify && canExitFocus && (
                  <button onClick={exitFocus} style={{ marginTop: 8, padding: "4px 16px", borderRadius: 6, border: "1px solid #555", background: "#333", color: "#ccc", cursor: "pointer", fontSize: 13 }}>
                    退出焦点
                  </button>
                )}
              </div>
            ) : viewMode === "list" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {messagesToRenderFiltered
                  .filter(msg => !tagSourceIdsForList.has(msg.id))
                  .map(msg => {
                  const isWholeSelected = draftUnits.some(u => u.messageId === msg.id && u.selection.kind === "whole");
                  const isActiveText = activeTextSelectId === msg.id;
                  const relType = msg.kind === "relation" ? relationTypeByRelMsgId.get(msg.id) : null;
                  const isClassifyTopicMsg = relType === "classify";
                  const isSummaryTopicMsg = relType === "summary";
                  const isMergeTopicMsg = relType === "merge";
                  const isTopicMsg = isClassifyTopicMsg || isSummaryTopicMsg || isMergeTopicMsg;
                  const govKind = (msg as any).backendKind as string | undefined;
                  const isGovernanceMsg = !isTopicMsg && msg.kind !== "relation" && (govKind === "GOVERNANCE" || govKind === "CODE" || govKind === "OPERATIONS");
                  const governanceColor = govKind === "GOVERNANCE" ? "#f59e0b" : govKind === "CODE" ? "#3b82f6" : "#10b981";
                  const topicMsgTargetCount = isTopicMsg
                    ? collectOwnedByRelation(msg.id, relationById).textIds.size
                    : 0;
                  const topicMsgTitle = isTopicMsg ? (getRelationTitle(msg.relationPayload) || (isClassifyTopicMsg ? `分类（${topicMsgTargetCount}）` : isMergeTopicMsg ? `归并（${topicMsgTargetCount}）` : `总结（${topicMsgTargetCount}）`)) : "";
                  const summaryCoverages = summaryCoverageByMessageId.get(msg.id) ?? [];
                  const settleTargetId = (msg as any).settlementTargetId as string | undefined;
                  const targetMsg = settleTargetId ? msgMap.get(settleTargetId) : undefined;
                  const relatedJoinRelations = joinRelationsByTarget.get(msg.id) ?? [];
                  const outgoingJoinRelations = joinRelationsBySource.get(msg.id) ?? [];
                  const joinRelation = msg.kind === 'join' ? relationById.get(msg.id) : undefined;
                  const joinIsEffective = !!joinRelation && effectiveJoinRelationIds.has(joinRelation.id);
                  const effectiveJoinCount = relatedJoinRelations.filter(join => effectiveJoinRelationIds.has(join.id)).length;
                  const ctx: MessageCardContext = {
                    isWholeSelected, isActiveText, isTopicMsg,
                    isClassifyTopic: isClassifyTopicMsg,
                    isSummaryTopic: isSummaryTopicMsg,
                    isMergeTopic: isMergeTopicMsg,
                    isGovernanceMsg,
                    governanceColor,
                    topicMsgTitle,
                    topicMsgTargetCount,
                    relType,
                    settlementTargetId: settleTargetId,
                    settlementTargetContent: targetMsg?.content ?? '',
                    isValueSettlement: (msg as any).roundPayload?.settlementType === 'VALUE',
                    lastClickedMsgId: lastClickedMessageId,
                    readStatus: readStatusByMessageId.get(msg.id),
                  };
                  const sc = stakeCounts[msg.id];
                  const truthPro = sc?.truth.pro ?? 0;
                  const truthCon = sc?.truth.con ?? 0;
                  const valuePro = sc?.value.pro ?? 0;
                  const valueCon = sc?.value.con ?? 0;
                  const showTruthProCon = truthPro > 0 || truthCon > 0;
                  const showValueProCon = valuePro > 0 || valueCon > 0;
                  const isTruthOpen = settlementOpenMsgId === msg.id && settlementOpenType === 'TRUTH';
                  const isValueOpen = settlementOpenMsgId === msg.id && settlementOpenType === 'VALUE';
                  const hasCustomContent = isContentKind(msg.kind) && msg.kind !== 'round' && msg.kind !== 'round_result';
                  const correctionTargetEdge = msg.relationType === 'correct'
                    ? edges.find(edge => edge.relationMessageId === msg.id)
                    : undefined;
                  const correctionTarget = correctionTargetEdge ? msgMap.get(correctionTargetEdge.to.messageId) : undefined;
                  const correctionTargetOriginal = correctionTarget
                    ? messages.find(message => message.id === correctionTarget.id) ?? correctionTarget
                    : undefined;
                  const correctionSourceEdge = correctionTargetEdge && !correctionTargetEdge.from.messageId.startsWith('anon:')
                    ? correctionTargetEdge
                    : undefined;
                  const correctionSource = correctionSourceEdge ? msgMap.get(correctionSourceEdge.from.messageId) : undefined;
                  const correctionContent = msg.relationPayload?.correctionContent ?? correctionSource?.content ?? msg.content;
                  const correctionTargetText = correctionTargetEdge?.to.selection.kind === 'text'
                    ? correctionTargetEdge.to.selection.text
                    : correctionTargetOriginal?.content ?? '';
                  const correctionTargetLabel = correctionTargetEdge?.to.selection.kind === 'text'
                    ? formatCorrectionRange(correctionTargetEdge.to.selection.start, correctionTargetEdge.to.selection.len, correctionTargetText)
                    : formatCorrectionRange(0, correctionTargetText.length, correctionTargetText);
                  const correctionReplacement = correctionTargetEdge?.to.selection.kind === 'text' && correctionTargetOriginal
                    ? (() => {
                      const selection = correctionTargetEdge.to.selection;
                      const suffixLength = correctionTargetOriginal.content.length - selection.start - selection.len;
                      const replacementEnd = correctionContent.length - suffixLength;
                      return selection.start >= 0 && selection.len >= 0 && suffixLength >= 0 &&
                        replacementEnd >= selection.start && replacementEnd <= correctionContent.length
                        ? correctionContent.slice(selection.start, replacementEnd)
                        : correctionContent;
                    })()
                    : correctionContent;

                  const correctionRecords = msg.relationType !== 'correct'
                    ? edges.filter(edge => edge.relationType === 'correct' && edge.to.messageId === msg.id)
                    : [];
                  const correctionVersion = msg.relationType === 'correct'
                    ? Array.from(correctionVersions.values())
                      .flatMap(entry => entry.versions)
                      .find(version => version.correctionId === msg.id)
                    : undefined;

                  return (
                    <MessageCard
                      key={msg.id} msg={msg} ctx={ctx}
                      onClick={handleMessageClick}
                      onDoubleClick={handleMessageDoubleClick}
                      onMouseDown={handleMessageMouseDown}
                      onMouseUp={handleMessageMouseUp}
                      onContentMouseUp={handleTextMouseUp}
                      headerLabel={correctionFilterTargetId !== null && msg.relationType === 'correct' ? (
                        <span style={{ color: '#fbbf24', fontWeight: 600 }}>
                          <span
                            role="link"
                            tabIndex={0}
                            onClick={event => { event.stopPropagation(); handleNavigateFromCorrectionTemporaryCategory(msg.id, true); }}
                            onKeyDown={event => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                event.stopPropagation();
                                handleNavigateFromCorrectionTemporaryCategory(msg.id, true);
                              }
                            }}
                            style={{ cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
                            title={`跳转到更正消息 ${msg.id}`}
                          >
                            {msg.id}
                          </span>
                          <span style={{
                            marginLeft: 5,
                            color: correctionVersion?.valid && !correctionVersion.conflicted ? '#4ade80' : '#f87171',
                            textDecoration: 'none',
                          }}>
                            {correctionVersion?.valid && !correctionVersion.conflicted ? '（生效）' : '（未生效）'}
                          </span>
                        </span>
                      ) : undefined}
                      headerAfterAuthor={viewMode === 'list' && correctionRecords.length > 0 && correctionVersions.get(msg.id)?.current ? (
                        <span style={{ color: '#fbbf24', fontWeight: 600 }} title="此消息已被更正">已被更正</span>
                      ) : undefined}
                      onSettlementTargetClick={(e, id) => { e.stopPropagation(); handleNavigateToMessage(id); }}
                      headerExtra={
                        <>
                          <div style={{ fontSize: 10, color: "#6b7280" }}>自押 PRO {authorStakes[msg.id] ?? 0} 点</div>
                          <div style={{ display: "flex", gap: 4, fontSize: 11, justifyContent: "flex-end", marginTop: 1 }}>
                            {showTruthProCon && (
                              <span style={{ color: "#a5b4fc" }} title="真假仲裁">
                                ⚖️{truthPro > 0 && <span style={{ color: "#4ade80" }}>👍{truthPro}</span>}
                                {truthPro > 0 && truthCon > 0 && ' '}
                                {truthCon > 0 && <span style={{ color: "#f87171" }}>👎{truthCon}</span>}
                              </span>
                            )}
                            {showValueProCon && (
                              <span style={{ color: "#fcd34d" }} title="价值仲裁">
                                💎{valuePro > 0 && <span style={{ color: "#4ade80" }}>👍{valuePro}</span>}
                                {valuePro > 0 && valueCon > 0 && ' '}
                                {valueCon > 0 && <span style={{ color: "#f87171" }}>👎{valueCon}</span>}
                              </span>
                            )}
                            <button data-settlement-toggle-truth onClick={(e) => { e.stopPropagation(); if (isTruthOpen) { closeSettlement(); } else { openSettlement(msg.id, 'TRUTH'); } }} style={{ fontSize: 13, cursor: "pointer", background: isTruthOpen ? "rgba(99,102,241,0.2)" : "none", border: isTruthOpen ? "1px solid #6366f1" : "1px solid transparent", borderRadius: 4, padding: "0 3px", color: isTruthOpen ? "#a5b4fc" : "#6b7280" }} title="真假仲裁">⚖️</button>
                            <button data-settlement-toggle-value onClick={(e) => { e.stopPropagation(); if (isValueOpen) { closeSettlement(); } else { openSettlement(msg.id, 'VALUE'); } }} style={{ fontSize: 13, cursor: "pointer", background: isValueOpen ? "rgba(245,158,11,0.2)" : "none", border: isValueOpen ? "1px solid #f59e0b" : "1px solid transparent", borderRadius: 4, padding: "0 3px", color: isValueOpen ? "#fcd34d" : "#6b7280" }} title="价值仲裁">💎</button>
                          </div>
                        </>
                      }
                      badges={
                        <>
                          {msg.kind === "join" && joinRelation && joinIsEffective && (
                            <div style={{ marginBottom: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                              <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(34,197,94,0.15)", color: "#86efac", border: "1px solid rgba(34,197,94,0.3)" }}>
                                生效
                              </span>
                            </div>
                          )}
                          {!isTopicMsg && msg.kind === "relation" && (
                            <div style={{ marginBottom: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                              <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(255,255,255,0.08)", color: "#9ca3af" }}>{relType ? String(relType) : "关系"}</span>
                              {relType === 'notify' && (() => {
                                const payload = msg.relationPayload;
                                const notifyUsers = Array.isArray(payload?.notifyUsers) && payload.notifyUsers.length > 0
                                  ? payload.notifyUsers
                                  : (payload?.notifyUserIds ?? []).map(id => ({ id, username: id }));
                                return notifyUsers.length > 0 ? (
                                  <span
                                    title="通知关系标签"
                                    style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(59,130,246,0.18)", color: "#93c5fd", border: "1px solid rgba(59,130,246,0.45)", display: "inline-flex", alignItems: "center", gap: 3 }}
                                  >
                                    {notifyUsers.map((notifyUser, index) => (
                                      <React.Fragment key={notifyUser.id}>
                                        {index > 0 && '、'}
                                        <span
                                          role="link"
                                          tabIndex={0}
                                          onClick={(event) => { event.stopPropagation(); navigate(`/topics/${topicId}?sender=${encodeURIComponent(notifyUser.username)}`); }}
                                          onKeyDown={(event) => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                              event.preventDefault();
                                              event.stopPropagation();
                                              navigate(`/topics/${topicId}?sender=${encodeURIComponent(notifyUser.username)}`);
                                            }
                                          }}
                                          style={{ color: "#bfdbfe", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2, fontFamily: "monospace" }}
                                          title={`在清爽视图中查看 ${notifyUser.username} 的消息`}
                                        >
                                          {notifyUser.id}
                                        </span>
                                      </React.Fragment>
                                    ))}
                                    <span>：通知</span>
                                  </span>
                                ) : null;
                              })()}
                              {suppressedRelIds.has(msg.id) && <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(239,68,68,0.2)", color: "#fca5a5", border: "1px solid rgba(239,68,68,0.35)" }}>你已反对 · 点赞同恢复</span>}
                              {rejectedContainerIds.has(msg.id) && <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(251,191,36,0.15)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)" }} title="社区反对多于赞同，该分类已暂时解散">社区已反对 · 双击预览</span>}
                              {activeStanceRelIds.has(msg.id) && (() => { const info = activeStanceByRelMsgId.get(msg.id); if (!info) return null; return info.type === 'disagree' ? <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(239,68,68,0.15)", color: "#fca5a5", border: "1px solid rgba(239,68,68,0.3)" }}>你的反对生效中</span> : <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(34,197,94,0.15)", color: "#86efac", border: "1px solid rgba(34,197,94,0.3)" }}>你的赞同生效中</span>; })()}
                              {overriddenStanceRelIds.has(msg.id) && <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(255,255,255,0.04)", color: "#6b7280", border: "1px solid rgba(255,255,255,0.1)" }}>已失效</span>}
                            </div>
                          )}
                          {outgoingJoinRelations.length > 0 && (
                            <div style={{ marginBottom: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                              <button
                                onClick={(event) => { event.stopPropagation(); const isExiting = joinFilterTargetId === msg.id && joinFilterDirection === 'outgoing'; if (isExiting) { exitTemporaryCategory(); return; } enterTemporaryCategory(); setMsgFilter(prev => ({ ...prev, hideJoin: false })); setJoinFilterDirection('outgoing'); setJoinFilterTargetId(msg.id); }}
                                title="筛选显示该容器发出的全部加入消息"
                                style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(16,185,129,0.14)", color: "#a7f3d0", border: "1px solid rgba(16,185,129,0.4)", cursor: "pointer" }}
                              >加入消息：{outgoingJoinRelations.length} 条</button>
                            </div>
                          )}
                          {relatedJoinRelations.length > 0 && (
                            <div style={{ marginBottom: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                              <button
                                onClick={(event) => { event.stopPropagation(); const isExiting = joinFilterTargetId === msg.id && joinFilterDirection === 'incoming'; if (isExiting) { exitTemporaryCategory(); return; } enterTemporaryCategory(); setMsgFilter(prev => ({ ...prev, hideJoin: false })); setJoinFilterDirection('incoming'); setJoinFilterTargetId(msg.id); }}
                                title="筛选显示把此消息加入容器的全部加入消息"
                                style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: joinFilterTargetId === msg.id ? "rgba(59,130,246,0.28)" : "rgba(59,130,246,0.14)", color: "#bfdbfe", border: "1px solid rgba(59,130,246,0.4)", cursor: "pointer" }}
                              >被加入消息：{effectiveJoinCount} 条生效</button>
                            </div>
                          )}
                          {activeStanceTargetIds.has(msg.id) && (() => { const info = activeStanceMap.get(msg.id); if (!info) return null; return <div style={{ marginBottom: 4, display: "flex", gap: 6 }}><span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: info.type === 'disagree' ? "rgba(239,68,68,0.15)" : "rgba(34,197,94,0.15)", color: info.type === 'disagree' ? "#fca5a5" : "#86efac", border: info.type === 'disagree' ? "1px solid rgba(239,68,68,0.3)" : "1px solid rgba(34,197,94,0.3)" }}>{info.type === 'disagree' ? '被反对 · 你的反对生效中' : '被赞同 · 你的赞同生效中'}</span></div>; })()}
                          {summaryCoverages.length > 0 && (
                            <div style={{ marginBottom: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                              {summaryCoverages.map(item => <span key={item.summaryId} style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(245,158,11,0.14)", color: "#fcd34d", border: "1px solid rgba(245,158,11,0.28)" }}>非线性视图由总结「{item.title}」覆盖</span>)}
                            </div>
                          )}
                        </>
                      }
                      overlays={settlementOpenMsgId === msg.id ? (
                        <div data-settlement-panel style={{ position: "absolute", right: 0, top: "100%", zIndex: 100, width: 360, marginTop: 4 }}>
                          <SettlementPanel messageId={msg.id} topicId={topicId!} highlightRoundId={sessionStorage.getItem('settlementHighlightRound')} entryHighlight={settlementEntryHighlight} onMessageCreated={(nm:any) => (window as any).__addSettlementMessage?.({...nm, kind: nm.kind})} filterSettlementType={settlementOpenType ?? undefined} />
                          <div style={{ marginTop: 4 }}><RoundHistory messageId={msg.id} compact /></div>
                        </div>
                      ) : undefined}
                    >
                      {msg.relationType === 'correct' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ fontSize: 12, color: '#fbbf24' }}>
                            ✏ {msg.author} 更正了消息
                            {correctionTarget && (
                              <button
                                type="button"
                                onClick={event => { event.stopPropagation(); handleNavigateFromCorrectionTemporaryCategory(correctionTarget.id, false); }}
                                style={{ marginLeft: 6, padding: '2px 7px', borderRadius: 999, border: '1px solid rgba(96,165,250,0.5)', background: 'rgba(59,130,246,0.16)', color: '#93c5fd', cursor: 'pointer', fontSize: 11 }}
                                title={`跳转到目标消息 ${correctionTarget.id}`}
                              >
                                目标消息 · {correctionTarget.id}
                              </button>
                            )}
                          </div>
                          <div style={{ borderLeft: '3px solid #0d9488', background: 'rgba(13,148,136,0.12)', padding: '6px 8px' }}>
                            <div style={{ fontSize: 11, color: '#5eead4', marginBottom: 3 }}>具体更改</div>
                            <div style={{ whiteSpace: 'pre-wrap', color: '#fca5a5' }}>
                              {correctionContent.length === 0
                                ? `删除${correctionTargetLabel}`
                                : `将${correctionTargetLabel}修改为「${correctionReplacement}」`}
                            </div>
                          </div>
                        </div>
                      ) : hasCustomContent ? renderMessageContentWithAnchorsForList(msg) : undefined}
                    </MessageCard>
                  );
                })}
              </div>
            ) : (
              <GraphView
                  key={`gv-${classifyKey}-${focusKey}-${comparisonReviewed ? `comparison-${comparisonTargetId ?? 'none'}` : 'normal'}`}
                  messages={comparisonReviewed ? comparisonGraphMessages : graphMessagesFinal} edges={comparisonReviewed ? (comparisonAgreeGraph?.edges ?? temporaryEdgesToRender) : edgesToRender} invalidCorrectionIds={invalidCorrectionIds} draftUnits={draftUnits}
                  comparisonPair={comparisonReviewed} comparisonTargetId={comparisonTargetId} comparisonRecommendedDisplay={comparisonRecommendedDisplay}
                  comparisonAgreeMessages={comparisonAgreeGraph?.messages} comparisonAgreeEdges={comparisonAgreeGraph?.edges}
                  comparisonAgreeHideMessageIds={comparisonAgreeGraph?.hideMessageIds}
                  comparisonDisagreeMessages={comparisonDisagreeGraph?.messages} comparisonDisagreeEdges={comparisonDisagreeGraph?.edges}
                  comparisonDisagreeHideMessageIds={comparisonDisagreeGraph?.hideMessageIds}
                  comparisonAgreeSuppressedRelIds={comparisonAgreeSuppressedRelIds} comparisonDisagreeSuppressedRelIds={comparisonDisagreeSuppressedRelIds}
                  autoCenterMessageId={comparisonReviewed ? comparisonTargetId : null}
                  activeTextSelectId={activeTextSelectId} lastClickedMessageId={lastClickedMessageId}
                  onMessageClick={handleMessageClick} onMessageDoubleClick={handleMessageDoubleClick}
                  onTextMouseUp={handleTextMouseUp} onEdgeLabelSingleClick={handleEdgeLabelSingleClick}
                  onEdgeLabelDoubleClick={handleEdgeLabelDoubleClick} onFragmentAnchorClick={handleFragmentAnchorClick}
                  isFragmentSelected={isFragmentSelected} onCanvasBlankClick={handleCanvasBlankClick}
                  onMessageMouseDown={handleMessageMouseDown} onMessageMouseUp={handleMessageMouseUp}
                  voteStats={voteStats}
                  onDecorationIconClick={handleDecorationIconClick}
                  onDecorationBodyClick={handleDecorationBodyClick}
                  onDecorationDoubleClick={handleDecorationDoubleClick}
                  selectedDecorations={selectedDecorations}
                  onTagBodyClick={handleTagBodyClick}
                  onTagDoubleClick={handleTagDoubleClick}
                  onGroupFrameClick={handleGroupFrameClick}
                  onGroupFrameDoubleClick={handleGroupFrameDoubleClick}
                  onInlineBadgeClick={handleInlineBadgeClick}
                  onInlineBadgeDoubleClick={handleInlineBadgeDoubleClick}
                  hideMessageIds={hideMessageIds}
                  stakeCounts={stakeCounts}
                  onSettlementToggleTruth={(msgId) => { if (settlementOpenMsgId === msgId && settlementOpenType === 'TRUTH') { closeSettlement(); } else { openSettlement(msgId, 'TRUTH'); } }}
                  onSettlementToggleValue={(msgId) => { if (settlementOpenMsgId === msgId && settlementOpenType === 'VALUE') { closeSettlement(); } else { openSettlement(msgId, 'VALUE'); } }}
                  topicId={topicId ?? undefined}
                  settlementOpenMsgId={settlementOpenMsgId}
                  settlementOpenType={settlementOpenType}
                  onSettlementMessageCreated={handleSettlementMessageCreated}
                  stanceHighlight={stanceHighlight}
                  settlementEntryHighlight={settlementEntryHighlight}
                  crossClassifyRefs={crossClassifyRefs}
                  onCrossRefTagClick={handleCrossRefTagClick}
                  onNavigateToMessage={handleNavigateToMessage}
                  joinRelationsByTarget={joinRelationsByTarget}
                  joinRelationsBySource={joinRelationsBySource}
                  joinStatusByMessage={joinStatusByMessage}
                  onJoinFilterClick={(messageId, direction) => {
                    setMsgFilter(prev => ({ ...prev, hideJoin: false }));
                    setJoinFilterDirection(direction);
                    const isExiting = joinFilterTargetId === messageId && joinFilterDirection === direction;
                    if (isExiting) { exitTemporaryCategory(); return; }
                    enterTemporaryCategory();
                    setJoinFilterTargetId(messageId);
                  }}
                />
            )}
          </div>
        </div>

        {typeof document !== "undefined" && createPortal(
          <div
            ref={leftHorizontalScrollRef}
            data-main-horizontal-scroll="true"
            aria-label="主界面水平滚动条"
            style={{
              display: leftHorizontalScrollMetrics.visible ? "block" : "none",
              position: "fixed",
              left: leftHorizontalScrollMetrics.left,
              bottom: documentHorizontalScrollVisible ? 14 : 0,
              width: leftHorizontalScrollMetrics.width,
              height: 14,
              zIndex: 60,
              overflowX: "scroll",
              overflowY: "hidden",
              scrollbarGutter: "stable",
              scrollbarWidth: "auto",
              background: "#181818",
              border: "1px solid #333",
              boxSizing: "border-box",
            }}
          >
            <div
              style={{ width: leftHorizontalScrollMetrics.scrollWidth, height: 1 }}
            />
          </div>,
          document.body,
        )}

        {/* Draggable splitter — 12px wide with visible grip handle */}
        <div
          onMouseDown={handleSplitterMouseDown}
          onTouchStart={handleSplitterTouchStart}
          style={{
            width: 12, flexShrink: 0,
            background: splitterActive ? "#0b84ff" : "#2a2a2a",
            cursor: "col-resize",
            transition: "background 0.15s",
            touchAction: "none",
            alignItems: "center", justifyContent: "center",
            userSelect: "none",
          }}
          onMouseEnter={e => { if (!splitterActive) (e.currentTarget as HTMLDivElement).style.background = "#4a4a4a"; }}
          onMouseLeave={e => { if (!splitterActive) (e.currentTarget as HTMLDivElement).style.background = "#2a2a2a"; }}
        >
          {/* Grip dots indicator */}
          <div style={{
            display: "flex", flexDirection: "column", gap: 3, alignItems: "center",
            opacity: splitterActive ? 1 : 0.5, transition: "opacity 0.15s",
          }}>
            <div style={{ width: 3, height: 3, borderRadius: "50%", background: splitterActive ? "#fff" : "#888" }} />
            <div style={{ width: 3, height: 3, borderRadius: "50%", background: splitterActive ? "#fff" : "#888" }} />
            <div style={{ width: 3, height: 3, borderRadius: "50%", background: splitterActive ? "#fff" : "#888" }} />
          </div>
        </div>


        <TopicRightPanel
          rightPanelRef={rightPanelRef}
          TOTAL_FLEX={TOTAL_FLEX}
          leftFlex={leftFlex}
          isPreviewMode={isPreviewMode}
          isViewerMode={isPreloaded}
          viewerUsers={viewerUsers}
          viewerUsername={viewerUser?.username}
          onViewerUsernameChange={username => {
            const normalized = username.trim();
            setViewerUser(normalized ? { id: `viewer:${normalized}`, username: normalized, createdAt: '' } : null);
          }}
          onExitViewer={() => navigate('/')}
          draftUnits={draftUnits}
          draftGroups={draftGroups}
          activeTextSelectId={activeTextSelectId}
          clearDraftAll={clearDraftAll}
          removeUnitFromDraft={removeUnitFromDraft}
          commitDraftTo={commitDraftTo}
          selKey={selKey}
          sourceUnits={sourceUnits}
          targetUnits={targetUnits}
          removeUnitFrom={removeUnitFrom}
          describeUnit={describeUnit}
          focusHop={focusHop}
          setFocusHop={setFocusHop}
          canSetFocus={canSetFocus}
          canExitFocus={canExitFocus}
          getSelectedWholeMessageIds={getSelectedWholeMessageIds}
          lastClickedMessageId={lastClickedMessageId}
          enterFocusMultiple={enterFocusMultiple}
          enterFocus={enterFocus}
          exitFocus={exitFocus}
          exitAllFocus={exitAllFocus}
          isInsideClassify={isInsideClassify}
          currentFocusIds={currentFocusIds}
          classifyKey={classifyKey}
          focusKey={focusKey}
          messages={messages}
          edges={edges}
          user={user}
          relationType={relationType}
          secondaryRelationType={secondaryRelationType}
          setSecondaryRelationType={setSecondaryRelationType}
          hasSecondaryRelationSelector={hasSecondaryRelationSelector}
          tagSecondaryOptions={tagSecondaryOptions}
          correctSecondaryOptions={correctSecondaryOptions}
          proposalSecondaryOptions={proposalSecondaryOptions}
          isArrangeType={isArrangeType}
          isArrangeLayoutLocked={isArrangeLayoutLocked}
          isClassifyType={isClassifyType}
          isSummaryType={isSummaryType}
          isMergeType={isMergeType}
          isGovernanceOrOpsType={isGovernanceOrOpsType}
          isTagWithQuickAnnotate={isTagWithQuickAnnotate}
          hasTargetsAvailable={hasTargetsAvailable}
          draftHasRelationTarget={draftHasRelationTarget}
          hasTextContent={hasTextContent}
          secondaryRelationLabel={secondaryRelationLabel}
          replyAdditionalLabel={replyAdditionalLabel}
          subType={subType}
          setSubType={setSubType}
          subTypeCustomLabel={subTypeCustomLabel}
          setSubTypeCustomLabel={setSubTypeCustomLabel}
          subTypeCustomBufferRef={subTypeCustomBufferRef}
          SUB_TYPE_OPTIONS={SUB_TYPE_OPTIONS}
          subTypeLabel={subTypeLabel}
          relationLabel={relationLabel}
          setRelationLabel={setRelationLabel}
          newMessageContent={newMessageContent}
          setNewMessageContent={setNewMessageContent}
          composerRefreshKey={composerRefreshKey}
          stakeAmount={stakeAmount}
          setStakeAmount={setStakeAmount}
          relStakeAmount={relStakeAmount}
          setRelStakeAmount={setRelStakeAmount}
          availablePoints={availablePoints}
          effectiveMinStake={effectiveMinStake}
          singleButtonEnabled={singleButtonEnabled}
          singleButtonLabel={singleButtonLabel}
          sendValidationLabel={sendValidationLabel}
          totalConsumption={totalConsumption}
          stakeFeeAmountRef={stakeFeeAmountRef}
          subTypeStakeMap={subTypeStakeMap}
          relationStakeMap={relationStakeMap}
          handleQuickSendAndRelateFromDraftTargets={handleQuickSendAndRelateFromDraftTargets}
          sendError={sendError}
          sendWarning={sendWarning}
          recentNormals={recentNormals}
          recentRelations={recentRelations}
          showStanceHistory={showStanceHistory}
          setShowStanceHistory={setShowStanceHistory}
          showAuditLog={showAuditLog}
          setShowAuditLog={setShowAuditLog}
          showRevenue={showRevenue}
          setShowRevenue={setShowRevenue}
          topicId={topicId!}
          comparisonMode={comparisonMode}
          comparisonReviewed={comparisonReviewed}
          comparisonTargetId={comparisonTargetId}
          comparisonSide={comparisonSide}
          onComparisonSideChange={setComparisonSide}
          onComparisonReview={() => {
            const targetId = draftUnits.length === 1 ? draftUnits[0].messageId : comparisonTargetId;
            if (!targetId) return;
            const containingClassifyId = findContainingClassifyTopic(targetId);
            if (containingClassifyId && containingClassifyId !== currentClassifyRelMsgId) {
              if (currentClassifyRelMsgId) exitClassifyTopic({ restoreSnapshot: false });
              enterClassifyTopic(containingClassifyId);
            }
            closeSettlement();
            setComparisonTargetId(targetId);
            setComparisonSide('agree');
            setComparisonReviewBaseMessages(containingClassifyId
              ? null
              : (isInsideClassify ? normalGraphProjection.scopedMessages : normalGraphProjection.messages));
            setComparisonReviewBaseEdges(containingClassifyId ? null : normalGraphProjection.edges);
            setComparisonReviewed(true);
            setComparisonMode(false);
            setLastClickedMessageId(targetId);
            setViewMode('graph');
            setTimeout(() => scrollMsgToCenter(targetId), 150);
          }}
          onComparisonVote={handleComparisonVote}
          onReturnToComparisonCategory={() => { setComparisonReviewed(false); setComparisonMode(true); setComparisonTargetId(null); setComparisonReviewBaseMessages(null); setComparisonReviewBaseEdges(null); setViewMode('list'); }}
          onExitComparison={() => { exitTemporaryCategory(); }}
        />
      </div>
    </div>
    </ErrorBoundary>

    <LeaderboardModal
      open={showLeaderboard}
      onClose={() => setShowLeaderboard(false)}
      messages={messages}
      edges={edges}
      relations={relations}
      stakeCounts={stakeCounts}
      messageBettorCounts={messageBettorCounts}
    />

    <PromptModal
      open={alertMessage !== null}
      title="提示"
      message={alertMessage ?? ''}
      confirmText="我知道了"
      onConfirm={() => setAlertMessage(null)}
    />

    {/* Decoration double-click popup: shows sender info for agree/disagree relations */}
    {decorationPopup && (() => {
      const { messageId, kind, x, y } = decorationPopup;
      const matchingRelations = edges.filter(e =>
        e.relationType === kind && e.to.messageId === messageId && e.to.selection.kind === "whole"
      ).map(e => {
        const relMsg = messages.find(m => m.id === e.relationMessageId);
        return relMsg ? { id: relMsg.id, author: relMsg.author, createdAt: relMsg.createdAt } : null;
      }).filter(Boolean) as { id: string; author: string; createdAt: string }[];
      return (
        <div key="dec-popup" onClick={() => setDecorationPopup(null)}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ position: "fixed", left: Math.min(x, window.innerWidth - 280), top: Math.min(y, window.innerHeight - 200), width: 260, background: "#1e1e1e", border: "1px solid #555", borderRadius: 8, padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.6)", zIndex: 1001 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
              {kind === "agree" ? "👍 赞同" : "👎 反对"} 记录（共 {matchingRelations.length} 条）
            </div>
            {matchingRelations.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.6 }}>暂无记录</div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 160, overflow: "auto", fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                {matchingRelations.map(r => (
                  <li key={r.id} style={{ padding: "4px 6px", borderRadius: 4, background: "#2a2a2a", display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600 }}>{r.author}</span>
                    <span style={{ opacity: 0.6 }}>{new Date(r.createdAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
            <button onClick={() => setDecorationPopup(null)}
              style={{ marginTop: 10, width: "100%", padding: "4px 0", borderRadius: 4, border: "1px solid #555", background: "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}>
              关闭
            </button>
          </div>
        </div>
      );
    })()}

    {/* Tag double-click popup: shows who tagged with the given label */}
    {tagPopup && (() => {
      const { messageId, tagLabel, relMsgIds, x, y, subDetails } = tagPopup;
      const taggers = relMsgIds.map(id => {
        const relMsg = messages.find(m => m.id === id);
        return relMsg ? { id: relMsg.id, author: relMsg.author, createdAt: relMsg.createdAt } : null;
      }).filter(Boolean) as { id: string; author: string; createdAt: string }[];
      return (
        <div key="tag-popup" onClick={() => setTagPopup(null)}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ position: "fixed", left: Math.min(x, window.innerWidth - 280), top: Math.min(y, window.innerHeight - 300), width: 260, background: "#1e1e1e", border: "1px solid #555", borderRadius: 8, padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.6)", zIndex: 1001 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
              🏷 「{tagLabel}」（共 {taggers.length} 人）<br />
              <span style={{ fontSize: 11, opacity: 0.7 }}>消息：{messageId}</span>
            </div>
            {/* SubType breakdown */}
            {subDetails && subDetails.length > 0 && (
              <div style={{ marginBottom: 8, padding: "6px 8px", borderRadius: 4, background: "#2a2a2a", fontSize: 11 }}>
                <div style={{ fontWeight: 600, marginBottom: 4, opacity: 0.8 }}>理由明细：</div>
                {subDetails.map(d => {
                  const stLabels: Record<string,string> = { SPAM:'垃圾', OFFTOPIC:'跑题', LOWVALUE:'低质', IMPORTANT:'重要', CUSTOM:'自定义' };
                  return (
                    <div key={d.subType} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                      <span>{d.customLabel || stLabels[d.subType] || d.subType}</span>
                      <span style={{ fontWeight: 600 }}>{d.count}人</span>
                    </div>
                  );
                })}
              </div>
            )}
            {taggers.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.6 }}>暂无记录</div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 160, overflow: "auto", fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                {taggers.map(r => (
                  <li key={r.id} style={{ padding: "4px 6px", borderRadius: 4, background: "#2a2a2a", display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600 }}>{r.author}</span>
                    <span style={{ opacity: 0.6 }}>{new Date(r.createdAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
            <button onClick={() => setTagPopup(null)}
              style={{ marginTop: 10, width: "100%", padding: "4px 0", borderRadius: 4, border: "1px solid #555", background: "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}>
              关闭
            </button>
          </div>
        </div>
      );
    })()}
    {mergeInfoPopup && (() => {
      const relMsg = messages.find(m => m.id === mergeInfoPopup.relMsgId);
      const left = Math.min(mergeInfoPopup.x, window.innerWidth - 320);
      const top = Math.min(mergeInfoPopup.y, window.innerHeight - 180);
      return (
        <div key="merge-info-popup" onClick={() => setMergeInfoPopup(null)}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ position: "fixed", left, top, width: 300, background: "#1e1e1e", border: "1px solid #555", borderRadius: 8, padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.6)", zIndex: 1001 }}>
            <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13 }}>
              归并关系信息
            </div>
            <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              <div>创建者：<span style={{ fontWeight: 600 }}>{relMsg?.author ?? "未知"}</span></div>
              <div>发送时间：<span style={{ opacity: 0.8 }}>{relMsg ? new Date(relMsg.createdAt).toLocaleString() : "未知"}</span></div>
            </div>
            <button onClick={() => setMergeInfoPopup(null)}
              style={{ marginTop: 12, width: "100%", padding: "4px 0", borderRadius: 4, border: "1px solid #555", background: "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}>
              关闭
            </button>
          </div>
        </div>
      );
    })()}
    {comparisonPopup && (
      <CorrectionComparisonPopup
        popup={comparisonPopup}
        messages={messages}
        edges={edges}
        invalidCorrectionIds={new Set(
          Array.from(correctionVersions.values()).flatMap(entry =>
            entry.versions.filter(version => !version.valid).map(version => version.correctionId),
          ),
        )}
        onClose={() => setComparisonPopup(null)}
        reversePreview={comparisonPopup.reversePreview ? {
          before: comparisonPopup.reversePreview.before,
          after: comparisonPopup.reversePreview.after,
          onConfirm: confirmReverseCorrection,
        } : undefined}
      />
    )}
    </>
  );
}

