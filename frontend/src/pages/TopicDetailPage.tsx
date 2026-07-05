import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { convertMessagesToDemoModel, unitSelectionToTargetRef, computeCorrectedEdgeMap, computeUserFilteredEdges, computeUserSuppressedRelIds, computeUserActiveStanceRelIds, computeUserOverriddenStanceRelIds, computeTransitiveVoteStats, isContentKind, kindLabel } from '../utils/modelBridge';
import type {
  DemoMessage, DemoEdge, UnitSelection, Selection,
  RelationType, MessageKind,
} from '../utils/modelBridge';
import type { Topic, TargetRef, Relation } from '../types';
import { getPresentationSpec, getRelationTitle } from '../types';
import GraphView, { clearBrowserSelection, extractTextTargetsForMessage, relationTypeName, getSelectionFragment, buildAnnoTree, renderAnnoNodes } from '../components/GraphView';
import ErrorBoundary from '../components/ErrorBoundary';
import SettlementPanel from '../components/SettlementPanel';
import RoundHistory from '../components/RoundHistory';
import StanceHistoryPanel from '../components/StanceHistoryPanel';
import AuditLogView from '../components/AuditLogView';
import RevenuePanel from '../components/RevenuePanel';
import TopicStructureView from '../components/TopicStructureView';
import CorrectionComparisonPopup from '../components/CorrectionComparisonPopup';
import { applyContainerExpansion } from '../utils/focusContainer';
import { useCleanView } from '../hooks/useCleanView';
import CleanFilterPanel from '../components/CleanFilterPanel';
import {
  ALL_RELATION_TYPES,
  CLASSIFY_TARGET_HINT,
  MAX_TAG_LABEL_DISPLAY_LENGTH,
  SUB_TYPE_OPTIONS,
  applyTextCorrectionInheritance,
  buildRelationDemoMessage,
  buildRelationPayload,
  collectOwnedByRelation,
  describeUnit,
  expandTextIdsWithCorrections,
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

type FocusSnapshot = {
  leftScroll: { top: number; left: number } | null;
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
  const { user } = useAuth();

  const [topic, setTopic] = useState<Topic | null>(null);
  const [messages, setMessages] = useState<DemoMessage[]>([]);
  const [edges, setEdges] = useState<DemoEdge[]>([]);
  const edgesRef = useRef<DemoEdge[]>([]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stakeCounts, setStakeCounts] = useState<Record<string, { pro: number; con: number }>>({});
  const [authorStakes, setAuthorStakes] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!topicId) return;
    let cancelled = false;
    async function load() {
      try {
        setLoading(true); setLoadError(null);
        const [topicData, messagesData, relationsData] = await Promise.all([
          api.getTopic(topicId!),
          api.getMessages(topicId!, { limit: 200 }),
          api.getRelations(topicId!, { limit: 200 }),
        ]);
        if (cancelled) return;
        setTopic(topicData);
        const { messages: demoMsgs, edges: demoEdges } = convertMessagesToDemoModel(
          messagesData.data, relationsData.data
        );
        setRelations(relationsData.data);
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
                  return { id, pro: r.counts.pro, con: r.counts.con, authorStake };
                })
              )
            );
            const map: Record<string, { pro: number; con: number }> = {};
            const aMap: Record<string, number> = {};
            for (const s of stakes) { map[s.id] = { pro: s.pro, con: s.con }; aMap[s.id] = s.authorStake; }
            // For RECOMMEND/ARCHIVE relations: mirror text target stake counts onto
            // the annotation relation message so badges show correct stats.
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
            if (!cancelled) { setStakeCounts(map); setAuthorStakes(aMap); }
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
      if (hiddenInGraphView.has(msgId)) setViewMode("list");
      setAutoClassifyMsgId(null);
    };

    // ── Find the classify that owns the anchor ──
    // First pass: direct targetRefs match.
    for (const rel of relations) {
      const rt = rel.relationType?.toUpperCase();
      if (rt !== 'CLASSIFY' && rt !== 'SUMMARY') continue;
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
      const owned = collectOwnedByRelation(rel.id, relById);
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
      let msgId = targetMsgId || settlementMsgId!;
      // Resolve through supersede chain (same as points-navigate handler).
      // Classify relations get new IDs when modified; URL params from stance
      // records may carry the old ID.  Resolve to the current canvas ID.
      const chain = supersedeMapRef.current;
      if (chain.has(msgId)) {
        let cur = msgId;
        const visited = new Set<string>();
        while (cur && chain.has(cur) && !visited.has(cur)) {
          visited.add(cur);
          cur = chain.get(cur)!;
        }
        if (cur !== msgId) msgId = cur;
      }
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
  const [subType, setSubType] = useState<string>(""); // SPAM|OFFTOPIC|LOWVALUE|IMPORTANT|CUSTOM or empty
  const [subTypeCustomLabel, setSubTypeCustomLabel] = useState("");
  const [relationLabel, setRelationLabel] = useState("");
  const [newMessageContent, setNewMessageContent] = useState("");
  const [draftUnits, setDraftUnits] = useState<UnitSelection[]>([]);
  const [sourceUnits, setSourceUnits] = useState<UnitSelection[]>([]);
  const [targetUnits, setTargetUnits] = useState<UnitSelection[]>([]);
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
  // Stack-based snapshot store for nested classify enter/exit.
  // Each entry holds the classify id and the snapshot captured before entering it.
  const classifyStackRef = useRef<Array<{ relMsgId: string; snapshot: FocusSnapshot | null }>>([]);
  // Phase 6: Clean view — multi-dimensional filter rules (replaces simple boolean)
  const {
    cleanMode, cleanFilters, cleanVisibleIds,
    addFilter: addCleanFilter, removeFilter: removeCleanFilter,
    updateFilter: updateCleanFilter, clearFilters: clearCleanFilters,
  } = useCleanView({ messages, edges, stakeCounts });
  // Count content messages for the filter panel stats
  const contentMsgCount = useMemo(() => messages.filter(m => isContentKind(m.kind)).length, [messages]);
  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;
  const messagesRef = useRef<DemoMessage[]>([]);
  messagesRef.current = messages;
  // Phase 6: expose for SettlementPanel direct access
  useEffect(() => { (window as any).__addSettlementMessage = (m: any) => { setMessagesRef.current((prev: any) => [...prev, {...m, author: m.author || user?.username || ''}]); setTimeout(() => scrollMsgToCenter(m.id), 50); }; return () => { delete (window as any).__addSettlementMessage; }; }, [user]);

  const [lastClickedMessageId, setLastClickedMessageId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("graph");

  // Scroll to message after data loads and renders (also triggers on focus changes for in-place nav).
  // View-switch decisions (graph→list for hidden messages) are made in the auto-classify
  // effect above; this effect only handles the actual scrolling.
  useEffect(() => {
    if (!loading && pendingScrollMsgRef.current && messages.some(m => m.id === pendingScrollMsgRef.current)) {
      scrollMsgToCenter(pendingScrollMsgRef.current);
      pendingScrollMsgRef.current = null;
    }
  }, [loading, messages, classifyKey, focusKey, scrollKey, viewMode]);
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
  } | null>(null);
  const [mergeInfoPopup, setMergeInfoPopup] = useState<{
    relMsgId: string;
    x: number; y: number;
  } | null>(null);
  // DEBUG
  const [debugRects, setDebugRects] = useState("");
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

  // Helper: open settlement with explicit type (defaults to TRUTH for old code paths)
  const openSettlement = useCallback((msgId: string, type: 'TRUTH' | 'VALUE' = 'TRUTH') => {
    setSettlementOpenMsgId(msgId);
    setSettlementOpenType(type);
  }, []);
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

  // Phase 5: Refs to avoid stale closure in points-navigate handler
  // (initialized empty; values synced via useEffect below after all useMemos run)
  const focusEntriesRef = useRef<FocusEntry[]>([]);
  const classifyRelMsgIdRef = useRef<string | null>(null);
  const relationsRef = useRef<Relation[]>([]);
  const relationByIdRef = useRef<Map<string, Relation>>(new Map());
  const relationTypeByRelMsgIdRef = useRef<Map<string, string>>(new Map());
  // Phase 5: Track supersede chain (oldId → newId) for point-record message ID resolution
  const supersedeMapRef = useRef<Map<string, string>>(new Map());

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

      // Phase 5: Resolve message ID through supersede chain
      // When a classify is updated (e.g. via agree inside it), the old relation
      // is superseded. Point records still reference the old ID — resolve to current.
      let resolvedMessageId = messageId;
      const chain = supersedeMapRef.current;
      if (chain.has(messageId)) {
        let cur = messageId;
        const visited = new Set<string>();
        while (cur && chain.has(cur) && !visited.has(cur)) {
          visited.add(cur);
          cur = chain.get(cur)!;
        }
        if (cur !== messageId) resolvedMessageId = cur;
      }

      // ── Smart classify enter/exit ──
      const currentClassifyId = classifyRelMsgIdRef.current;
      if (currentClassifyId) {
        const owned = collectOwnedByRelation(currentClassifyId, currentRelationById);
        const allOwnedIds = new Set([...owned.textIds, ...owned.relationIds]);
        if (!allOwnedIds.has(resolvedMessageId)) {
          exitClassifyTopic({ restoreSnapshot: false });
        }
      }

      // Auto-enter classify if target belongs to one (and not already in one)
      if (!classifyRelMsgIdRef.current) {
        for (const rel of currentRelations) {
          const rt = rel.relationType?.toUpperCase();
          if (rt !== 'CLASSIFY' && rt !== 'SUMMARY') continue;
          const targets = (rel.targetRefs ?? []) as TargetRef[];
          if (targets.some(t => (t.kind === 'message' || t.kind === 'text-fragment') && t.messageId === resolvedMessageId)) {
            enterClassifyTopic(rel.id);
            break;
          }
        }
      }

      // Clear existing draft and select target message
      setDraftUnits([{ messageId: resolvedMessageId, selection: { kind: "whole" } }]);
      setActiveTextSelectId(null);
      pendingScrollMsgRef.current = resolvedMessageId;

      // Phase 5: Open settlement panel for all stake/vote/settlement transactions
      const settlementTypes = ['STAKE_LOCK', 'VOTE_LOCK', 'SETTLEMENT_GAIN', 'SETTLEMENT_LOSS', 'CLAWBACK'];
      const highlightMessageTypes = ['MINT', 'STAKE_LOCK', 'VOTE_LOCK'];

      if (settlementTypes.includes(txType)) {
        openSettlement(resolvedMessageId);
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
        setStanceHighlight({ stanceMsgId: resolvedMessageId, evidenceMsgIds: [] });
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

  const stakeDefaultLoaded = useRef(false);
  const relationStakeMap = useRef<Record<string, number>>({});
  const subTypeStakeMap = useRef<Record<string, number>>({});

  // Compute the effective minimum stake considering both relationType and subType
  const SUB_TYPE_MIN_STAKE_FALLBACK: Record<string, number> = { SPAM: 5, OFFTOPIC: 5, LOWVALUE: 5, IMPORTANT: 10, CUSTOM: 5 };
  const effectiveMinStake = (() => {
    const typeMinBase = relationType
      ? (relationStakeMap.current[relationType.toUpperCase()] ?? 10)
      : 10;
    let min = typeMinBase;
    // When subType is set, apply subType minimum (whichever is higher)
    if (subType) {
      const subMin = subTypeStakeMap.current[subType] ?? SUB_TYPE_MIN_STAKE_FALLBACK[subType];
      if (subMin) min = Math.max(min, subMin);
    }
    // Governance/ops: add reference costs
    const isGovOps = relationType === "proposal" || relationType === "code_change" || relationType === "operations";
    const govTargetCount = isGovOps ? (draftUnits.length > 0 ? draftUnits.length : targetUnits.length) : 0;
    const refMin = relationStakeMap.current['REFERENCE'] ?? 10;
    if (isGovOps && govTargetCount > 0) min += govTargetCount * refMin;
    return min;
  })();

  // Effective target count for multi-target relation types
  const multiTargetCount = (() => {
    const multiTargetTypes = new Set(['annotation', 'reference', 'reply', 'agree', 'disagree', 'tag']);
    if (!relationType || !multiTargetTypes.has(relationType.toLowerCase())) return 0;
    return draftUnits.length > 0 ? draftUnits.length : targetUnits.length;
  })();

  // Total consumption: text stake + relation stakes × count + all burn fees
  const stakeFeeAmountRef = useRef(1); // default burn fee per stake (from rule parameters)
  // Types where the text input is part of the relation payload (title/label/content),
  // not a separate text message — no separate text stake should be counted.
  const isTextInPayload = relationType === 'classify' || relationType === 'summary' || relationType === 'merge'
    || relationType === 'tag' || relationType === 'proposal' || relationType === 'code_change' || relationType === 'operations';
  const hasTextContentForTotal = !isTextInPayload && newMessageContent.trim().length > 0;
  const totalConsumption = (() => {
    const burnPerOp = stakeFeeAmountRef.current;
    // Text message: stake + burn (if text is present)
    const textStake = hasTextContentForTotal && typeof stakeAmount === 'number' ? stakeAmount : 0;
    const textBurn = textStake > 0 ? burnPerOp : 0;
    // Relation messages
    if (!relationType) {
      if (textStake > 0) return { stakeTotal: textStake, burnTotal: textBurn, total: textStake + textBurn, perStake: textStake, textStake, relCount: 0, hasText: true, hasRel: false };
      return null;
    }
    if (typeof relStakeAmount !== 'number') {
      if (textStake > 0) return { stakeTotal: textStake, burnTotal: textBurn, total: textStake + textBurn, perStake: 0, textStake, relCount: 0, hasText: true, hasRel: false };
      return null;
    }
    const relCount = multiTargetCount > 0 ? multiTargetCount : 1;
    const relStakeTotal = relStakeAmount * relCount;
    const relBurnTotal = burnPerOp * relCount;
    // Governance/ops: add reference stake costs for each target
    const isGovOps2 = relationType === 'proposal' || relationType === 'code_change' || relationType === 'operations';
    const govRefCount = isGovOps2 ? (draftUnits.length > 0 ? draftUnits.length : targetUnits.length) : 0;
    const refMin = relationStakeMap.current['REFERENCE'] ?? 10;
    const refStakeTotal = govRefCount > 0 ? govRefCount * refMin : 0;
    const refBurnTotal = govRefCount > 0 ? govRefCount * burnPerOp : 0;
    const totalStake = textStake + relStakeTotal + refStakeTotal;
    const totalBurn = textBurn + relBurnTotal + refBurnTotal;
    return {
      stakeTotal: totalStake,
      burnTotal: totalBurn,
      total: totalStake + totalBurn,
      perStake: relStakeAmount,
      textStake,
      refStakeTotal,
      refCount: govRefCount,
      relCount,
      hasText: textStake > 0,
      hasRel: true,
    };
  })();

  // Update relStakeAmount when relation type, subType, or target count changes
  useEffect(() => {
    if (!stakeDefaultLoaded.current) return;
    setMinSelfStake(effectiveMinStake);
    setRelStakeAmount(effectiveMinStake);
  }, [relationType, subType, draftUnits.length, targetUnits.length]);
  useEffect(() => {
    if (!settlementOpenMsgId) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Keep panel open if clicking inside it or on the settlement toggle buttons
      if (target.closest('[data-settlement-panel]') || target.closest('[data-settlement-toggle-truth]') || target.closest('[data-settlement-toggle-value]')) return;
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
        setStakeCounts(prev => ({ ...prev, [messageId]: { pro: s.counts.pro, con: s.counts.con } }));
      }).catch(() => {});
    };
    window.addEventListener('stakes-refresh', handler);
    return () => window.removeEventListener('stakes-refresh', handler);
  }, []);

  const currentFocusEntry = focusEntries.length > 0 ? focusEntries[focusEntries.length - 1] : null;
  const currentFocusIds = currentFocusEntry?.ids ?? null;
  const relationById = useMemo(() => new Map(relations.map(relation => [relation.id, relation])), [relations]);
  const msgMap = useMemo(() => new Map(messages.map(m => [m.id, m])), [messages]);
  const appendCreatedRelation = useCallback((backendRel: Relation) => {
    // Skip adding duplicate relations (deduplicated on backend)
    // When deduplicated, update the existing relation/message in state instead
    const isDedup = !!(backendRel as unknown as Record<string, unknown>).deduplicated;
    if (isDedup) {
      // Update existing relation and message with fresh data (e.g. incremented sendCount)
      setRelations(prev => prev.map(r => r.id === backendRel.id ? backendRel : r));
      setMessages(prev => prev.map(m => m.id === backendRel.id ? buildRelationDemoMessage(backendRel) : m));
    } else {
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
        setStakeCounts(prev => ({ ...prev, [mid]: { pro: s.counts.pro, con: s.counts.con } }));
      }).catch(() => {});
    }
    // For RECOMMEND/ARCHIVE: the stake is on the text target, so also mirror its
    // stake counts onto the annotation relation message for badge display.
    if (relType === 'RECOMMEND' || relType === 'ARCHIVE') {
      const textTarget = targetMsgIds[0];
      if (textTarget) {
        api.getMessageStakes(textTarget).then(s => {
          setStakeCounts(prev => ({
            ...prev,
            [backendRel.id]: { pro: s.counts.pro, con: s.counts.con },
          }));
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
            scrollMsgToCenter(roundMsg.id);
            resolve(roundMsg.id);
          }).catch(() => resolve(null));
        });
        return roundPromise;
      }
    }
    return Promise.resolve(null);
  }, [topicId]);

  const createRel = useCallback((topicId: string, data: Parameters<typeof api.createRelation>[1]) => {
    const amount = Math.max(relStakeRef.current, 1);
    return api.createRelation(topicId, { ...data, stakeAmount: amount });
  }, []);

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

  // Transitive vote stats: agree/disagree counts projected through stance chains
  // to the ultimate target, so "agree on disagree on rel-arr" counts as disagree on rel-arr.
  const voteStats = useMemo(
    () => computeTransitiveVoteStats(edges, messages),
    [edges, messages]
  );
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
  const classifyOwnership = useMemo(() => {
    const textIds = new Set<string>();
    const relationIds = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType !== 'CLASSIFY') continue;
      const owned = collectOwnedByRelation(relation.id, relationById);
      owned.textIds.forEach(id => textIds.add(id));
      owned.relationIds.forEach(id => relationIds.add(id));
    }
    return { textIds, relationIds };
  }, [relations, relationById]);
  const mergeOwnership = useMemo(() => {
    const textIds = new Set<string>();
    const relationIds = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType !== 'MERGE') continue;
      const owned = collectOwnedByRelation(relation.id, relationById);
      owned.textIds.forEach(id => textIds.add(id));
      owned.relationIds.forEach(id => relationIds.add(id));
    }
    return { textIds, relationIds };
  }, [relations, relationById]);
  const summaryOwnership = useMemo(() => {
    const textIds = new Set<string>();
    const relationIds = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType !== 'SUMMARY') continue;
      const owned = collectOwnedByRelation(relation.id, relationById);
      owned.textIds.forEach(id => textIds.add(id));
      owned.relationIds.forEach(id => relationIds.add(id));
    }
    return { textIds, relationIds };
  }, [relations, relationById]);
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
  const classifyOwnershipTextIdsExpanded = useMemo(
    () => expandTextIdsWithCorrections(classifyOwnership.textIds, edges, msgMap),
    [classifyOwnership, edges, msgMap]
  );
  const summaryOwnershipTextIdsExpanded = useMemo(
    () => expandTextIdsWithCorrections(summaryOwnership.textIds, edges, msgMap),
    [summaryOwnership, edges, msgMap]
  );

  const classifiedTargetTextIds = classifyOwnershipTextIdsExpanded;
  const classifiedTargetClassifyRelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    classifyOwnership.relationIds.forEach(id => {
      if (relationById.get(id)?.relationType.toUpperCase() === 'CLASSIFY') ids.add(id);
    });
    return ids;
  }, [classifyOwnership, relationById]);
  const classifiedTargetMergeRelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    classifyOwnership.relationIds.forEach(id => {
      if (relationById.get(id)?.relationType.toUpperCase() === 'MERGE') ids.add(id);
    });
    return ids;
  }, [classifyOwnership, relationById]);
  const classifiedTargetARRANGERelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    classifyOwnership.relationIds.forEach(id => {
      if (relationById.get(id)?.relationType.toUpperCase() === 'ARRANGE') ids.add(id);
    });
    return ids;
  }, [classifyOwnership, relationById]);
  const classifiedTargetSummaryRelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    classifyOwnership.relationIds.forEach(id => {
      if (relationById.get(id)?.relationType.toUpperCase() === 'SUMMARY') ids.add(id);
    });
    return ids;
  }, [classifyOwnership, relationById]);

  function collectExclusiveRelationMsgIds(hiddenTextIds: Set<string>, ownedRelationIds: Set<string>) {
    const ids = new Set<string>();
    const edgesByRel = new Map<string, DemoEdge[]>();
    for (const e of edges) {
      const arr = edgesByRel.get(e.relationMessageId) ?? [];
      arr.push(e);
      edgesByRel.set(e.relationMessageId, arr);
    }
    for (const [relMsgId, relEdges] of edgesByRel) {
      const relType = relEdges[0]?.relationType;
      if (relType === 'classify' || relType === 'summary' || relType === 'merge') continue;
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
    () => collectExclusiveRelationMsgIds(classifyOwnershipTextIdsExpanded, classifyOwnership.relationIds),
    [edges, msgMap, classifyOwnershipTextIdsExpanded, classifyOwnership.relationIds]
  );
  const graphHiddenTextIds = useMemo(() => {
    const ids = new Set<string>(classifyOwnershipTextIdsExpanded);
    summaryOwnershipTextIdsExpanded.forEach(id => ids.add(id));
    // MERGE displays as a group frame whose targets remain visible as cards on the canvas,
    // so mergeOwnership.textIds is intentionally excluded here.
    return ids;
  }, [classifyOwnershipTextIdsExpanded, summaryOwnershipTextIdsExpanded]);

  const graphOwnedRelationIds = useMemo(() => {
    const ids = new Set<string>(classifyOwnership.relationIds);
    mergeOwnership.relationIds.forEach(id => ids.add(id));
    summaryOwnership.relationIds.forEach(id => ids.add(id));
    return ids;
  }, [classifyOwnership, mergeOwnership, summaryOwnership]);
  const graphExclusiveRelMsgIds = useMemo(
    () => collectExclusiveRelationMsgIds(graphHiddenTextIds, graphOwnedRelationIds),
    [edges, msgMap, graphHiddenTextIds, graphOwnedRelationIds]
  );

  const leftPanelRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
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
  useEffect(() => () => cancelScrollRafs(), []);

  // Scroll the left panel canvas so the message with the given ID is centered.
  // Polls via requestAnimationFrame until the card appears in the DOM.
  // MAX_SCROLL_ATTEMPTS × ~16ms/frame ≈ 1 second maximum wait time.
  const MAX_SCROLL_ATTEMPTS = 60;
  function scrollMsgToCenter(msgId: string) {
    pendingScrollMsgIdRef.current = msgId;
    let attempts = 0;
    const tryScroll = () => {
      attempts++;
      if (attempts > MAX_SCROLL_ATTEMPTS) { pendingScrollMsgIdRef.current = null; return; }
      if (pendingScrollMsgIdRef.current !== msgId) return; // superseded by newer message
      const container = leftPanelRef.current;
      if (!container) { scrollRafRef.current = requestAnimationFrame(tryScroll); return; }
      const el = container.querySelector(`[data-msgid="${msgId}"]`) as HTMLElement | null;
      if (!el) { scrollRafRef.current = requestAnimationFrame(tryScroll); return; }
      pendingScrollMsgIdRef.current = null;
      const elRect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const elCenterX = elRect.left - containerRect.left + container.scrollLeft + elRect.width / 2;
      const elCenterY = elRect.top - containerRect.top + container.scrollTop + elRect.height / 2;
      container.scrollLeft = Math.max(0, Math.min(elCenterX - container.clientWidth / 2, container.scrollWidth - container.clientWidth));
      container.scrollTop = Math.max(0, Math.min(elCenterY - container.clientHeight / 2, container.scrollHeight - container.clientHeight));
    };
    cancelScrollRafs();
    scrollRafRef.current = requestAnimationFrame(tryScroll);
  }

  function captureSnapshot(): FocusSnapshot {
    return {
      leftScroll: leftPanelRef.current ? { top: leftPanelRef.current.scrollTop, left: leftPanelRef.current.scrollLeft } : null,
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
    // Cancel any in-flight scroll rAF before scheduling new ones so that stale
    // callbacks never touch DOM nodes after React has reconciled them away.
    cancelScrollRafs();
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRaf2Ref.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        scrollRaf2Ref.current = null;
        clampAndSetScroll(leftPanelRef.current, s.leftScroll?.top ?? null, s.leftScroll?.left ?? null);
        clampAndSetScroll(rightPanelRef.current, s.rightScroll?.top ?? null, s.rightScroll?.left ?? null);
      });
    });
  }

  function enterFocus(messageId: string, options?: { replace?: boolean; mode?: "focus" | "topic"; topicRelMsgId?: string }) {
    if (!messageId) return;
    const snapshot = captureSnapshot();
    const entry: FocusEntry = { ids: [messageId], snapshot, mode: options?.mode ?? "focus", topicRelMsgId: options?.topicRelMsgId };
    setFocusEntries(prev => options?.replace ? [entry] : [...prev, entry]);
  }

  function enterFocusMultiple(messageIds: string[], options?: { replace?: boolean; mode?: "focus" | "topic"; topicRelMsgId?: string }) {
    if (!messageIds || messageIds.length === 0) return;
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
    setFocusEntries(prev => {
      if (prev.length === 0) return prev;
      return prev.slice(0, -1);
    });
    setFocusKey(k => k + 1);
    if (snapshot) restoreSnapshot(snapshot, { restoreSelection: true });
  }

  function exitAllFocus() {
    const snapshot = focusEntries.length > 0 ? focusEntries[0].snapshot : null;
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
      await addTargetToClassifyTopic({ kind: 'relation', relationId: backendRel.id });
    }
    if (roundId) {
      await addTargetToClassifyTopic({ kind: 'message', messageId: roundId });
    }
    return roundId;
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
    scrollMsgToCenter(roundMsg.id);
    return roundMsg.id;
  }

  async function handleSendMessageOnly(overrideContent?: string): Promise<DemoMessage | null> {
    const text = overrideContent ?? newMessageContent;
    if (text.trim().length === 0) return null;
    if (!topicId) return null;
    const pts = typeof stakeAmount === 'number' ? stakeAmount : 0;
    if (pts < 10) {
      setSendError('文本消息最低押注为 10 点');
      return null;
    }
    if (pts > availablePoints) {
      setSendError(`贡献点余额不足（可用 ${availablePoints}，需要 ${pts + 1} 含燃烧）`);
      return null;
    }
    setSendError(null);
    try {
      const backendMsg = await api.createMessage(topicId, { content: text, contentType: 'TEXT', stakeAmount: pts });
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
        setStakeCounts(prev => ({ ...prev, [msg.id]: { pro: s.counts.pro, con: s.counts.con } }));
        setAuthorStakes(prev => ({ ...prev, [msg.id]: s.stakes.find(st => st.side === 'PRO' && st.user.username === msg.author)?.amount ?? 0 }));
      }).catch(() => {});
      // Reset to rule default
      setStakeAmount(minSelfStake);
      if (isInsideClassify) {
        if (currentClassifyRelMsgId) {
          // Persist the new message as a target of the classify/summary topic
          // so the message remains scoped inside the topic after exit / reload.
          await addTargetToClassifyTopic(
            { kind: 'message', messageId: msg.id },
            (newRelId) => {
              // Add a classify/summary edge for the new message so the topic
              // card reflects the updated target count in GraphView.
              const relType = (currentClassifyRelType === "summary" ? "summary" : "classify") as RelationType;
              const alreadyLinked = false; // fresh target, no existing edge
              if (!alreadyLinked) {
                setEdges(prev => [...prev, {
                  id: nextId("edge"),
                  relationMessageId: newRelId,
                  relationType: relType,
                  from: { messageId: `anon:${newRelId}`, selection: { kind: "whole" } },
                  to: { messageId: msg.id, selection: { kind: "whole" } },
                  relationLabel: relationTypeName(relType),
                }]);
              }
            },
          );
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
          await addTargetToClassifyTopic({ kind: 'message', messageId: roundMsg.id });
          scrollMsgToCenter(roundMsg.id);
        } catch { /* round creation optional */ }
      }
      return msg;
    } catch (e: any) {
      setSendError(e?.message ?? '发送失败');
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
    setLastClickedMessageId(messageId);
    const wholeUnit: UnitSelection = { messageId, selection: { kind: "whole" } };
    setDraftUnits(prev => {
      const exists = prev.some(u => unitEquals(u, wholeUnit));
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
      if (relType === "classify" || relType === "summary") {
        // Always clear any text selection before entering classification to prevent
        // the browser's native double-click text selection from persisting into the new view.
        setActiveTextSelectId(null);
        clearBrowserSelection();
        enterClassifyTopic(messageId);
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
    if (!m || m.kind !== "normal") return;
    const container = e.currentTarget as HTMLElement;
    const frag = getSelectionFragment(container);
    clearBrowserSelection();
    if (!frag || frag.len <= 0) return;
    const fragmentUnit: UnitSelection = { messageId, selection: { kind: "text", start: frag.start, len: frag.len, text: frag.text } };
    setDraftUnits(prev => {
      const exists = prev.some(u => unitEquals(u, fragmentUnit));
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
      // ARRANGE / MERGE: expand to their contained text messages (layout containers),
      // AND also keep the container itself as a relation-kind target so it gets
      // hidden from the parent view (list + graph) when classified.
      if (relType === "arrange" || relType === "merge") {
        const relKey = `relation:${mid}`;
        if (!seen.has(relKey)) {
          seen.add(relKey);
          res.push({ kind: "relation", relationId: mid });
        }
        const owned = collectOwnedByRelation(mid, relationById);
        for (const textId of owned.textIds) {
          const key = `message:${textId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          res.push({ kind: "message", messageId: textId });
        }
      } else {
        const key = `relation:${mid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        res.push({ kind: "relation", relationId: mid });
      }
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

  function exitClassifyTopic(options?: { restoreSnapshot?: boolean }) {
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
    if (options?.restoreSnapshot !== false && entry?.snapshot) {
      restoreSnapshot(entry.snapshot);
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
      const payload: Record<string, unknown> = { relationType: 'TAG', label: tagLabel };
      if (subType) { payload.subType = subType; if (subType === 'CUSTOM') { const ct = (customLabel || newMessageContent).trim(); if (ct) payload.customLabel = ct.slice(0, 20); } }
      const backendRel = await createRel(topicId, {
        relationType: 'TAG',
        sourceMessageId: null,
        targetRefs: [backendTargetRef],
        payload: buildRelationPayload(payload as unknown as Parameters<typeof buildRelationPayload>[0]),
      });
      const relId = backendRel.id;
      await registerCreatedRelationInCurrentClassify(backendRel);
      const anonSrcId = `anon:${relId}`;
      return { id: nextId("edge"), relationMessageId: relId, relationType: "tag", from: { messageId: anonSrcId, selection: { kind: "whole" } }, to: { messageId: targetMid, selection: { kind: "whole" } }, relationLabel: tagLabel } as DemoEdge;
    } catch (e: any) {
      alert(`建立标注关系失败: ${e?.message ?? e}`);
      return null;
    }
  }

  async function handleCreateRelationWithSourcesAndTargets(params: {
    sources: UnitSelection[]; targets: UnitSelection[]; label: string;
  }) {
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

    if (relationType === "reply") {
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
            } catch (e: any) { alert(`建立回复关系失败: ${e?.message ?? e}`); }
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
            } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
          }
        }
      } else {
        // Pure-stance: no source — persist to backend (relation messages are first-class messages)
        for (const targetMid of uniqueTargetMids) {
          try {
            const backendRel = await createRel(topicId, { relationType: relationType.toUpperCase(), sourceMessageId: null, targetRefs: [unitSelectionToTargetRef({ messageId: targetMid, selection: { kind: "whole" } }, msgMap)] });
            await registerCreatedRelationInCurrentClassify(backendRel);
          } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
        }
      }
    } else if (relationType === "recommend" || relationType === "archive") {
      // RECOMMEND/ARCHIVE: user-to-message relations with no source message, one per target.
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
        } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
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
            label: secondaryRelationType === "custom" ? (label || "自定义") : secondaryRelationType,
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
            } catch (e: any) { alert(`建立引用关系失败: ${e?.message ?? e}`); }
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
            } catch (e: any) { alert(`建立注释关系失败: ${e?.message ?? e}`); }
          }
        }
      }
    } else {
      // Generic types (ARRANGE/CLASSIFY/MERGE/SUMMARY/PROPOSAL/CODE_CHANGE/OPERATIONS etc.) with source message.
      // CORRECT: single target only.
      if (relationType === "correct" && targets.length > 1) {
        alert("更正关系只能有一个目标");
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
          } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
        }
      }
    }
    setEdges(prev => [...prev, ...newEdgesList]);
  }

  async function handleQuickSendAndRelateFromDraftTargets() {
    const text = newMessageContent.trim();

    // Effective targets: candidates (draftUnits) if non-empty, else explicit target collection.
    const effectiveTargets = draftUnits.length > 0 ? draftUnits : targetUnits;
    // Validate both stakes — collect all errors
    const errors: string[] = [];
    if (hasTextContent && typeof stakeAmount === 'number' && stakeAmount < 10) {
      errors.push(`文本消息最低押注 10 点（当前 ${stakeAmount}）`);
    }
    if (relationType) {
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
        if (totalConsumption.burnTotal > 0) parts.push(`燃烧 ${totalConsumption.burnTotal}`);
        errors.push(`贡献点余额不足（可用 ${availablePoints}，总计需要 ${totalConsumption.total} 点 = ${parts.join(' + ')}）`);
      }
    }
    if (errors.length > 0) {
      setSendError(errors.join('；'));
      return;
    }
    setSendError(null);

    // No relation type selected: just send a plain message
    if (relationType === null) {
      if (text.length === 0) return;
      await handleSendMessageOnly(text);
      setNewMessageContent("");
      return;
    }

    // Scenario: source collection + target collection explicitly committed (no draft candidates).
    // Build the relation directly without creating a new text message.
    if (relationType !== "classify" && relationType !== "merge" && draftUnits.length === 0 && sourceUnits.length > 0 && targetUnits.length > 0) {
      const labelDefault = relationTypeName(relationType);
      const label = relationLabel.trim() || labelDefault;
      await handleCreateRelationWithSourcesAndTargets({ sources: sourceUnits, targets: targetUnits, label });
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent(""); setSubType("");
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    if (effectiveTargets.length === 0 && relationType !== "classify" && relationType !== "proposal" && relationType !== "code_change" && relationType !== "operations") return;
    const isAgreeDisagree = relationType === "agree" || relationType === "disagree";
    const isArrange = relationType === "arrange";
    // isInlineBadge kept for backwards-compat but recommend/archive are no longer top-level types
    const isInlineBadge = false;

    // TAG + secondary relation: create RECOMMEND/ARCHIVE or quick-annotate TAG with label from secondary
    if (relationType === "tag" && secondaryRelationType !== "none") {
      const secType = secondaryRelationType;
      const uniqueTargetMids = Array.from(new Set(effectiveTargets.map(u => u.messageId)));
      const newEdgesList: DemoEdge[] = [];
      if (secType === "recommend" || secType === "archive") {
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
          } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
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
      return;
    }

    // Relation target with CORRECT: no text, no source — create null-source relation
    const hasDraftRelTarget = draftUnits.some(u => msgMap.get(u.messageId)?.kind === 'relation');
    const hasSecSelector = relationType === "correct" && hasDraftRelTarget;
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
        const oldRelEdges = edges.filter(e => e.relationMessageId === targetRelMsgId);
        if (oldRelEdges.length === 0) {
          alert(`无法找到目标关系消息的边（ID：${targetRelMsgId}），无法创建更正关系`);
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
          alert(`没有选中的片段，无法创建更正关系`);
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
        } catch (e: any) { alert(`建立更正关系失败: ${e?.message ?? e}`); }
        setEdges(prev => [...prev, ...newEdgesList]);
        setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
        setRelationType(null); setSecondaryRelationType("none");
        return;
      }

      // CORRECT (no secondary) targeting a relation message: create null-source relation, single target only.
      // Generic path also covers REFERENCE/ANNOTATION with secondary labels
      if (relationType === "correct" && draftUnits.length > 1) {
        alert("更正关系只能有一个目标");
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
      } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
      setEdges(prev => [...prev, ...newEdgesList]);
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent(""); setSubType(""); setRelationType(null); setSecondaryRelationType("none");
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
        } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
      }
      if (newEdgesList2.length > 0) setEdges(prev => [...prev, ...newEdgesList2]);
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setRelationType(null); setSecondaryRelationType("none");
      return;
    }

    // ARRANGE relation: user-to-message relation (like CLASSIFY/MERGE/SUMMARY), no source message.
    // If text is present, create a text message first and include it as a target of the frame.
    // This avoids creating normal→normal edges that could falsely trigger cross-link checks.
    // Targets are collected as-is; the layout engine handles nested ARRANGE frames via
    // buildFrameBlocks subset detection (treating arrange messages as whole units).
    if (isArrange) {
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
      } catch (e: any) { alert(`建立排列关系失败: ${e?.message ?? e}`); }
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
        alert(`选中的${orphanLabels.join('、')}标签对应的消息不在分类目标中，请先选择目标消息再选择其标签，或取消选择无关标签`);
        return;
      }
      if (hasCrossNonReferenceTextLinkForClassifyTargets(targetTextIds)) {
        alert("分类目标与其他文本消息存在非引用关联，无法建立分类关系");
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
          alert(`同一条排列关系关联了 ${uniqueMids.length} 条文本消息，分类前需全部选中`);
          return;
        }
      }
      const classifyTitle = newMessageContent.trim();
      if (!classifyTitle) {
        alert("分类名称不能为空");
        return;
      }
      const targetRefs = getClassifyTargetRefs(effectiveTargets);
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
      } catch (e: any) {
        alert(`建立关系失败: ${e?.message ?? e}`);
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
        alert("总结内容不能为空");
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
        alert(`选中的${orphanSummaryLabels.join('、')}标签对应的消息不在总结目标中，请先选择目标消息再选择其标签，或取消选择无关标签`);
        return;
      }
      if (hasCrossNonReferenceTextLinkForClassifyTargets(targetTextIds)) {
        alert("总结目标与其他文本消息存在非引用关联，无法建立总结关系");
        return;
      }
      const summaryTargetRefs = getClassifyTargetRefs(effectiveTargets);
      if (summaryTargetRefs.length === 0) {
        alert("总结关系至少需要一个目标消息");
        return;
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
      } catch (e: any) {
        alert(`建立总结关系失败: ${e?.message ?? e}`);
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
        alert(`选中的${orphanMergeLabels.join('、')}标签对应的消息不在归并目标中，请先选择目标消息再选择其标签，或取消选择无关标签`);
        return;
      }
      if (hasCrossNonReferenceTextLinkForClassifyTargets(mergeTargetTextIds)) {
        alert("归并目标与其他文本消息存在非引用关联，无法建立归并关系");
        return;
      }
      const mergeTargetRefs = Array.from(new Map(
        foldUpToWhole(effectiveTargets).map(u => {
          const ref = unitSelectionToTargetRef(u, msgMap);
          return [targetRefDisplayId(ref), ref] as const;
        })
      ).values());
      if (mergeTargetRefs.length === 0) {
        alert("归并关系至少需要一个文本消息或关系消息作为目标");
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
        // Only add merge edges on the main canvas, not inside another classify
        if (!isInsideClassify) {
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
        }
      } catch (e: any) {
        alert(`建立归并关系失败: ${e?.message ?? e}`);
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
        alert("更正关系目前仅支持单个目标消息");
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

      const generated = generateCorrectionContent(resolvedTargets, text, msgMap);
      if (generated === null) {
        alert("更正关系目标必须是普通文本消息");
        return;
      }
      const msg = await handleSendMessageOnly(generated);
      if (!msg) return;
      const sources: UnitSelection[] = [{ messageId: msg.id, selection: { kind: "whole" } }];
      await handleCreateRelationWithSourcesAndTargets({ sources, targets: resolvedTargets, label });
      setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
      setNewMessageContent("");
      setRelationType(null); setSecondaryRelationType("none");
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

    // PROPOSAL / CODE_CHANGE / OPERATIONS: governance & operational messages.
    // Source forbidden, targetRefs always empty — targets expressed via REFERENCE relations.
    // Text is optional when targets are selected (auto-fills from targets if empty).
    if (relationType === "proposal" || relationType === "code_change" || relationType === "operations") {
      let proposalContent = newMessageContent.trim();
      if (!proposalContent && !hasTargetsAvailable) {
        alert("请输入内容或选择目标消息");
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
        const backendRel = await createRel(topicId!, {
          relationType: relationType.toUpperCase(),
          sourceMessageId: null,
          targetRefs: [],
          payload: buildRelationPayload({
            relationType: relationType.toUpperCase(),
            content: proposalContent || '',
            title: (proposalContent || '').slice(0, 200) || undefined,
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
        await addTargetToClassifyTopic({ kind: 'relation', relationId: backendRel.id });
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
          setStakeCounts(prev => ({ ...prev, [backendRel.id]: { pro: s.counts.pro, con: s.counts.con } }));
        }).catch(() => {});
        window.dispatchEvent(new Event('points-refresh'));
      } catch (e: any) {
        alert(`建立${relationTypeName(relationType)}关系失败: ${e?.message ?? e}`);
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
  const isClassifyType = relationType === "classify";
  const isMergeType = relationType === "merge";
  const isSummaryType = relationType === "summary";
  const isGovernanceOrOpsType = relationType === "proposal" || relationType === "code_change" || relationType === "operations";
  // TAG + secondary = recommend/archive acts as an inline badge (no text needed)
  const isTagWithQuickAnnotate = relationType === "tag" && secondaryRelationType !== "none";
  const isTagWithInlineBadge = relationType === "tag" && (secondaryRelationType === "recommend" || secondaryRelationType === "archive");

  // Whether any draft unit points to a relation message (vs. text message or fragment)
  const draftHasRelationTarget = draftUnits.some(u => msgMap.get(u.messageId)?.kind === 'relation');
  const hasTargetsAvailable = draftUnits.length > 0 || targetUnits.length > 0;
  const composerRefreshKey = `${relationType ?? "plain"}::${secondaryRelationType}::${draftUnits.length === 0 ? "draft-empty" : "draft-has"}::${targetUnits.length === 0 ? "target-empty" : "target-has"}::${sourceUnits.length === 0 ? "source-empty" : "source-has"}::${draftHasRelationTarget ? "draft-rel" : "draft-text"}`;

  // Additional relation selector:
  // - REPLY: always available (none/question/answer)
  // - CORRECT: only when targeting relation messages
  // - TAG: always available (none/recommend/archive/existing-tag shortcuts)
  // - ARRANGE: always available (vertical/horizontal)
  const hasSecondaryRelationSelector =
    relationType === "reply"
    || (relationType === "correct" && draftHasRelationTarget)
    || relationType === "tag"
    || relationType === "arrange"
    || relationType === "reference";

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
    if (relationType && typeof relStakeAmount === 'number' && relStakeAmount < effectiveMinStake) return false;
    if (totalConsumption && totalConsumption.total > availablePoints) return false;
    // CORRECT targeting a relation message: special mode (no text, no source, use secondary selector)
    if (draftHasRelationTarget && relationType === "correct") {
      return draftUnits.length > 0 && newMessageContent.trim().length === 0 && sourceUnits.length === 0;
    }
    if (isClassifyType) return newMessageContent.trim().length > 0;
    if (isSummaryType) return hasTargetsAvailable && newMessageContent.trim().length > 0;
    if (isMergeType) return hasTargetsAvailable && sourceUnits.length === 0 && newMessageContent.trim().length === 0;
    if (isGovernanceOrOpsType) {
      // 来源禁止；目标可选；有目标时文本可不填
      if (sourceUnits.length > 0) return false;
      return newMessageContent.trim().length > 0 || hasTargetsAvailable;
    }
    // TAG with any non-none secondary (recommend/archive/existing-tag) needs only targets, no text
    if (isAgreeDisagreeType || isArrangeType || isTagWithQuickAnnotate) return hasTargetsAvailable;
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
    // Check for subType minimum stake requirement
    if (typeof relStakeAmount === 'number' && relStakeAmount < effectiveMinStake) {
      const st = subType ? subTypeLabel(subType) : null;
      const note = st ? `（「${st}」理由要求最低 ${effectiveMinStake} 点）` : `（最低 ${effectiveMinStake} 点）`;
      return `贡献点不足${note}，当前 ${relStakeAmount} 点`;
    }
    if (totalConsumption && totalConsumption.total > availablePoints) {
      const parts: string[] = [];
      if (totalConsumption.hasText) parts.push(`文本 ${totalConsumption.textStake}`);
      if (totalConsumption.hasRel) parts.push(`关系 ${totalConsumption.perStake}×${totalConsumption.relCount}`);
      if ((totalConsumption as any).refCount > 0) parts.push(`引用 ${(totalConsumption as any).refStakeTotal}`);
      if (totalConsumption.burnTotal > 0) parts.push(`燃烧 ${totalConsumption.burnTotal}`);
      return `贡献点余额不足（可用 ${availablePoints}，总计需要 ${totalConsumption.total} 点 = ${parts.join(' + ')}）`;
    }
    if (draftHasRelationTarget && relationType === "correct") {
      if (newMessageContent.trim().length > 0) return `请清空文本输入框（更正关系目标为关系消息时不应有文本）`;
      if (sourceUnits.length > 0) return `请清空来源集合（更正关系目标为关系消息时来源必须为空）`;
      const secLabel = secondaryRelationType === "none" ? "无" : relationTypeName(secondaryRelationType as RelationType);
      return `建立「${typeName}」关系（目标为关系消息，附加：${secLabel}）`;
    }
    const usingDraft = draftUnits.length > 0;
    if (isClassifyType) {
      const targetCount = getClassifyTargetRefs(usingDraft ? draftUnits : targetUnits).length;
      if (targetCount === 0) return "建立分类（无目标）";
      return `建立分类（${targetCount} 个${CLASSIFY_TARGET_HINT}目标）`;
    }
    if (isSummaryType) {
      const targetCount = getClassifyTargetRefs(usingDraft ? draftUnits : targetUnits).length;
      if (!hasTargetsAvailable) return "请在画布中选择要总结的目标消息";
      if (newMessageContent.trim().length === 0) return "请输入总结内容（不能为空）";
      return `建立总结关系（${targetCount} 个目标）`;
    }
    if (isMergeType) {
      if (sourceUnits.length > 0) return "归并关系不需要来源消息，请清空来源集合";
      if (!hasTargetsAvailable) return "请在画布中选择要归并的目标消息";
      if (newMessageContent.trim().length > 0) return "归并关系不需要输入文本消息";
      return `建立归并关系（用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
    }
    if (isGovernanceOrOpsType) {
      const govTypeLabel = relationType === "proposal" ? "提案" : relationType === "code_change" ? "代码" : "运营";
      if (sourceUnits.length > 0)
        return `请清空来源集合（${govTypeLabel}消息不需要来源）`;
      const usingDraft2 = draftUnits.length > 0;
      const targetCount = (usingDraft2 ? draftUnits : targetUnits).length;
      if (!hasTargetsAvailable && newMessageContent.trim().length === 0)
        return `请输入${govTypeLabel}内容或选择目标消息`;
      if (targetCount > 0 && newMessageContent.trim().length > 0)
        return `发送${govTypeLabel}消息（引用 ${targetCount} 个目标）`;
      if (targetCount > 0)
        return `发送${govTypeLabel}消息（引用 ${targetCount} 个目标，无正文）`;
      return `发送${govTypeLabel}消息`;
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
      return `建立「${secName}」关系（用${usingDraft ? "候选" : "目标集合"}作目标，无需文本）`;
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

  // Secondary relation options for TAG type: none, recommend, archive, plus existing tags on target messages.
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
    return ['recommend', 'archive', ...Array.from(existingTagLabels)];
  }, [relationType, draftUnits, targetUnits, edges]);

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
  const isInsideClassify = classifyRelMsgId !== null;
  const currentClassifyRelMsgId = classifyRelMsgId;

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
      const topicTextIds = new Set<string>();
      const topicRelationIds = new Set<string>();
      if (topicRelation) {
        getTextTargetIds(topicRelation.targetRefs).forEach(id => topicTextIds.add(id));
        getRelationTargetIds(topicRelation.targetRefs).forEach(id => topicRelationIds.add(id));
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
            // (SUMMARY targets are hidden by GraphView's hiddenTargetIds in non-linear
            // view; in linear view, double-click the summary card to see its targets.)
          }
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
      ...classifyOwnership.relationIds,
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
      ...summaryOwnership.relationIds,
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
  }, [messages, edges, relationById, messagesToShow, edgesToShow, focusEntries, isInsideClassify, currentClassifyRelMsgId, msgMap, classifiedTargetTextIds, classifiedTargetClassifyRelMsgIds, classifiedTargetMergeRelMsgIds, classifiedTargetARRANGERelMsgIds, classifiedTargetSummaryRelMsgIds, listExclusiveRelMsgIds, replacedRelationMsgIds, classifyOwnership, summaryOwnership, graphExclusiveRelMsgIds, graphHiddenTextIds, focusRelationMsgIds]);

  function handleCanvasBlankClick() {
    setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection(); setLastClickedMessageId(null);
    setRelationType(null); setSecondaryRelationType("none");
  }

  async function handleDecorationIconClick(messageId: string, kind: "agree" | "disagree") {
    // Quick send: pure-stance agree/disagree — relation messages are first-class, persist to backend
    if (!topicId) return;
    try {
      const backendRel = await createRel(topicId, {
        relationType: kind.toUpperCase(),
        sourceMessageId: null,
        targetRefs: [{ kind: 'message', messageId }],
      });
      await registerCreatedRelationInCurrentClassify(backendRel);
    } catch (e: any) { alert(`建立关系失败: ${e?.message ?? e}`); }
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
    setLastClickedMessageId(messageId);
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
    } catch (e: any) { alert(`操作失败: ${e?.message ?? e}`); }
  }

  function handleSplitterMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    splitterDragRef.current = { startX: e.clientX, startFlex: leftFlex };
    function onMouseMove(ev: MouseEvent) {
      if (!splitterDragRef.current || !panelContainerRef.current) return;
      const dx = ev.clientX - splitterDragRef.current.startX;
      const containerW = panelContainerRef.current.clientWidth;
      const flexChange = containerW > 0 ? (dx / containerW) * TOTAL_FLEX : 0;
      const newLeft = Math.max(MIN_LEFT_FLEX, Math.min(MAX_LEFT_FLEX, splitterDragRef.current.startFlex + flexChange));
      setLeftFlex(newLeft);
    }
    function onMouseUp() {
      splitterDragRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Phase 6: Clean mode — computed by useCleanView hook (multi-dimensional filters)

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
  // Phase 6: Apply clean mode filter (multi-dimensional rules via useCleanView)
  const messagesToRenderClean = cleanVisibleIds
    ? messagesToRender.filter(m =>
        cleanVisibleIds.visibleTextIds.has(m.id) || cleanVisibleIds.visibleRelIds.has(m.id))
    : messagesToRender;
  const rawEdgesToRender = viewMode === "list" ? listEdgesToRender : graphEdgesToRender;
  // Phase 6: Also filter edges through clean view
  const rawEdgesToRenderClean = cleanVisibleIds
    ? rawEdgesToRender.filter(e => cleanVisibleIds.visibleRelIds.has(e.relationMessageId))
    : rawEdgesToRender;
  // Filter edges based on current user's DISAGREE stances on relation messages.
  // When the user disagrees with a relation message, all edges produced by that
  // relation are suppressed from this user's view (per-user branch semantics).
  const edgesToRender = computeUserFilteredEdges(rawEdgesToRenderClean, messages, user?.username ?? null);
  // Also compute which relation messages are suppressed, for visual indicators in the list view.
  const suppressedRelIds = computeUserSuppressedRelIds(rawEdgesToRenderClean, messages, user?.username ?? null);
  // In graph view, hide suppressed relation messages (classify/merge cards/frames).
  // List view keeps them visible with "你已反对" label so the user can undo.
  const graphMessagesFiltered = viewMode === "graph"
    ? messagesToRenderClean.filter(m => m.kind !== "relation" || !suppressedRelIds.has(m.id))
    : messagesToRenderClean;
  // When a classify is suppressed, release its owned text messages back to the canvas.
  const suppressedClassifyTextIds = (() => {
    if (suppressedRelIds.size === 0) return new Set<string>();
    const ids = new Set<string>();
    for (const relId of suppressedRelIds) {
      const rel = relationById.get(relId);
      if (rel?.relationType !== 'CLASSIFY') continue;
      const owned = collectOwnedByRelation(relId, relationById);
      owned.textIds.forEach(id => ids.add(id));
    }
    return ids;
  })();
  // Final graph messages: include released text messages from suppressed classifies
  const graphMessagesFinal = viewMode === "graph"
    ? [...graphMessagesFiltered, ...messagesToRenderClean.filter(m => 
        isContentKind(m.kind) && suppressedClassifyTextIds.has(m.id) && !graphMessagesFiltered.some(gm => gm.id === m.id)
      )]
    : graphMessagesFiltered;
  // And the active stance messages: which of the user's own agree/disagree messages
  // are the "current" stance on each target, for bidirectional visual linking.
  const activeStanceMap = computeUserActiveStanceRelIds(rawEdgesToRenderClean, messages, user?.username ?? null);
  // Precomputed set of relation message IDs that are active stances.
  const activeStanceRelIds = new Set([...activeStanceMap.values()].map(v => v.relMsgId));
  // Reverse map: stance relation message ID → { target, type } for quick lookup.
  const activeStanceByRelMsgId = (() => {
    const m = new Map<string, { targetRelId: string; type: 'agree' | 'disagree' }>();
    for (const [targetId, v] of activeStanceMap) m.set(v.relMsgId, { targetRelId: targetId, type: v.type });
    return m;
  })();
  // Overridden stances: the user's previous stance messages that are no longer active.
  const overriddenStanceRelIds = computeUserOverriddenStanceRelIds(rawEdgesToRender, messages, user?.username ?? null);
  const isOwner = user && topic && (topic as any).author?.id === user.id;

  return (
    <>
    <ErrorBoundary>
    <div style={{ height: "100%", overflow: "hidden", margin: 0, display: "flex", flexDirection: "column", background: "#101010", color: "#eee", fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif" }}>
      <div style={{ padding: "8px 16px", borderBottom: "1px solid #333", background: "#181818", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {isOwner && <>
            <button onClick={handleArchiveTopic} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#fff", fontSize: 11, cursor: "pointer" }}>
              {topic?.status === 'ARCHIVED' ? '重新开放' : '归档'}
            </button>
          </>}
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: 12 }}>
          <span>关系类型：</span>
          {ALL_RELATION_TYPES.map(rt => (
            <button key={rt} onClick={() => { setRelationType(prev => prev === rt ? null : rt); setSecondaryRelationType(rt === "arrange" ? "vertical" : "none"); }}
              style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: relationType === rt ? "#0b84ff" : "#222", color: relationType === rt ? "#fff" : "rgba(255,255,255,0.7)", cursor: "pointer" }}>
              {relationTypeName(rt)}
            </button>
          ))}
        </div>
      </div>

      <div ref={panelContainerRef} style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
        <div style={{ flex: leftFlex, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden", paddingBottom: 8 }}>
          <div style={{ flex: "0 0 auto", padding: 8, borderBottom: "1px solid #333", background: "#141414" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontWeight: 600 }}>{viewMode === "list" ? "消息列表（线性）" : "结构图（非线性）"}</div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <CleanFilterPanel
                  active={cleanMode}
                  filters={cleanFilters}
                  matchCount={cleanVisibleIds?.visibleTextIds.size ?? 0}
                  totalCount={contentMsgCount}
                  onAdd={addCleanFilter}
                  onRemove={removeCleanFilter}
                  onUpdate={updateCleanFilter}
                  onClear={clearCleanFilters}
                />
                <button onClick={() => {
                if (leftPanelRef.current) {
                  viewModeScrollRef.current[viewMode] = { top: leftPanelRef.current.scrollTop, left: leftPanelRef.current.scrollLeft };
                }
                setViewMode(prev => prev === "list" ? "graph" : "list");
                if (lastClickedMessageId) {
                  setTimeout(() => scrollMsgToCenter(lastClickedMessageId), 100);
                }
              }} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#fff", fontSize: 12, cursor: "pointer" }}>
                {viewMode === "list" ? "切换为结构图" : "切换为列表"}
              </button>
              </div>
            </div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {viewMode === "list" ? "线性视图：支持自由换行内容；双击 normal 进入文本选择模式；可点击高亮片段切换选中。" : "结构图：注释/引用 source 自动推到 target 右侧列（规则1）；label避让文字；高亮片段可点击。"}
            </div>
          </div>
          {isInsideClassify && (
            <div style={{ flex: "0 0 auto", padding: "8px 8px 12px 8px", background: "#101010" }}>
              <div style={{ border: "1px solid #334155", borderRadius: 10, padding: "8px 10px", background: "linear-gradient(180deg, #162036 0%, #0f172a 100%)", color: "#e2e8f0", boxShadow: "0 6px 16px rgba(0,0,0,0.25)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <div style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {topicFocusTitle || classifyKindLabel}
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 999, background: "rgba(34,197,94,0.18)", color: "#86efac", border: "1px solid rgba(34,197,94,0.35)", flexShrink: 0 }}>
                      进行中
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "#94a3b8", display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <span>由 <span style={{ fontWeight: 600, color: "#cbd5e1" }}>{currentClassifyRelMsg?.author ?? "系统"}</span> 发起</span>
                    <span>💬 {classifyTargetCount} 条观点</span>
                    <span>{currentClassifyRelMsg ? new Date(currentClassifyRelMsg.createdAt).toLocaleDateString('zh-CN') : ""}</span>
                  </div>
                </div>
                <button onClick={() => exitClassifyTopic()} style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid #475569", background: "#1e293b", color: "#e2e8f0", cursor: "pointer", flexShrink: 0 }}>
                  {classifyExitLabel}
                </button>
              </div>
            </div>
          )}

          <div ref={leftPanelRef} style={{ flex: "1 1 auto", overflow: "auto", padding: 8, minHeight: 0 }}
            onDoubleClick={e => {
              const t = e.target as HTMLElement;
              // Skip if clicked on a message card, SVG edge, or relation overlay
              if (t.closest?.("[data-msgid]") || t.closest?.("svg") || t.closest?.('[title^="relation="]') || t.closest?.("[data-rel-overlay]")) return;
              handleCanvasBlankClick();
            }}>
            {messagesToRenderClean.length === 0 ? (
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
                {messagesToRenderClean
                  .filter(msg => !tagSourceIdsForList.has(msg.id))
                  .map(msg => {
                  const isWholeSelected = draftUnits.some(u => u.messageId === msg.id && u.selection.kind === "whole");
                  const isActiveText = activeTextSelectId === msg.id;
                  const relType = msg.kind === "relation" ? relationTypeByRelMsgId.get(msg.id) : null;
                  const isClassifyTopicMsg = relType === "classify";
                  const isSummaryTopicMsg = relType === "summary";
                  const isMergeTopicMsg = relType === "merge";
                  const isTopicMsg = isClassifyTopicMsg || isSummaryTopicMsg || isMergeTopicMsg;
                  const topicMsgTargetCount = isTopicMsg
                    ? collectOwnedByRelation(msg.id, relationById).textIds.size
                    : 0;
                  const topicMsgTitle = isTopicMsg ? (getRelationTitle(msg.relationPayload) || (isClassifyTopicMsg ? `分类（${topicMsgTargetCount}）` : isMergeTopicMsg ? `归并（${topicMsgTargetCount}）` : `总结（${topicMsgTargetCount}）`)) : "";
                  const summaryCoverages = summaryCoverageByMessageId.get(msg.id) ?? [];
                  return (
                    <div key={msg.id} data-msgid={msg.id} onClick={e => handleMessageClick(e, msg.id)} onDoubleClick={e => handleMessageDoubleClick(e, msg.id)} onMouseDown={e => handleMessageMouseDown(e, msg.id)} onMouseUp={e => handleMessageMouseUp(e, msg.id)}
                      style={{
                        position: "relative",
                        borderRadius: isTopicMsg ? 8 : 6,
                        border: isWholeSelected
                          ? "2px solid #0b84ff"
                          : isTopicMsg
                            ? "1px solid #334155"
                            : isActiveText ? "2px dashed #0b84ff" : "1px solid #444",
                        borderLeft: isWholeSelected
                          ? "3px solid #0b84ff"
                          : isTopicMsg ? "3px solid #6366f1" : undefined,
                        background: isWholeSelected
                          ? "#1e3a5f"
                          : isTopicMsg ? "#1e293b" : "#1f1f1f",
                        color: undefined,
                        padding: isTopicMsg ? "10px 12px" : "10px 14px",
                        cursor: "pointer",
                        fontSize: 13,
                        boxShadow: isWholeSelected
                          ? "0 2px 12px rgba(11,132,255,0.2)"
                          : isTopicMsg ? "0 2px 8px rgba(0,0,0,0.15)" : undefined,
                        outline: lastClickedMessageId === msg.id ? "1px dashed #0b84ff" : "none",
                        userSelect: isActiveText ? "text" : "auto"
                      }}>
                      <div style={{ fontSize: 11, opacity: isTopicMsg ? 0.65 : 0.8, marginBottom: 4, display: "flex", justifyContent: "space-between", color: isTopicMsg ? "#94a3b8" : undefined }}>
                        <span>{isClassifyTopicMsg ? `分类 ${msg.id}` : isSummaryTopicMsg ? `总结 ${msg.id}` : isMergeTopicMsg ? `归并 ${msg.id}` : msg.kind === "relation" ? `关系消息 ${msg.id}` : (msg as any).backendKind === "ROUND" ? ((msg as any).roundPayload?.settlementType === 'VALUE' ? `💎 发起价值仲裁` : `⚖️ 发起真假仲裁`) : (msg as any).backendKind === "ROUND_RESULT" ? `🏁 结算完成` : (msg as any).backendKind === "GOVERNANCE" ? `🏛️ 治理提案` : (msg as any).backendKind === "CODE" ? `💻 代码` : (msg as any).backendKind === "OPERATIONS" ? `📊 运营` : `消息 ${msg.id}`}</span>
                        <span style={{textAlign:"right"}}>
                          <div>{isClassifyTopicMsg ? "双击进入分类" : isTopicMsg ? "双击进入分类" : `作者：${msg.author}`}</div>
                          <div style={{ fontSize: 10, color: "#6b7280" }}>自押 PRO {authorStakes[msg.id] ?? 0} 点</div>
                          {(() => {
                            const sc = stakeCounts[msg.id];
                            const showProCon = sc && (sc.pro > 0 || sc.con > 0);
                            const isTruthOpen = settlementOpenMsgId === msg.id && settlementOpenType === 'TRUTH';
                            const isValueOpen = settlementOpenMsgId === msg.id && settlementOpenType === 'VALUE';
                            return (
                              <div style={{ display: "flex", gap: 4, fontSize: 11, justifyContent: "flex-end", marginTop: 1 }}>
                                {showProCon && sc!.pro > 0 && (
                                  <span style={{ color: "#4ade80" }}>👍{sc!.pro}</span>
                                )}
                                {showProCon && sc!.con > 0 && (
                                  <span style={{ color: "#f87171" }}>👎{sc!.con}</span>
                                )}
                                <button
                                  data-settlement-toggle-truth
                                  onClick={(e) => { e.stopPropagation(); if (isTruthOpen) { closeSettlement(); } else { openSettlement(msg.id, 'TRUTH'); } }}
                                  style={{ fontSize: 13, cursor: "pointer", background: isTruthOpen ? "rgba(99,102,241,0.2)" : "none", border: isTruthOpen ? "1px solid #6366f1" : "1px solid transparent", borderRadius: 4, padding: "0 3px", color: isTruthOpen ? "#a5b4fc" : "#6b7280" }}
                                  title="真假仲裁"
                                >⚖️</button>
                                <button
                                  data-settlement-toggle-value
                                  onClick={(e) => { e.stopPropagation(); if (isValueOpen) { closeSettlement(); } else { openSettlement(msg.id, 'VALUE'); } }}
                                  style={{ fontSize: 13, cursor: "pointer", background: isValueOpen ? "rgba(245,158,11,0.2)" : "none", border: isValueOpen ? "1px solid #f59e0b" : "1px solid transparent", borderRadius: 4, padding: "0 3px", color: isValueOpen ? "#fcd34d" : "#6b7280" }}
                                  title="价值仲裁"
                                >💎</button>
                              </div>
                            );
                          })()}
                        </span>
                      </div>
                      {isTopicMsg && (
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                          <div style={{ fontWeight: 600, color: "#f1f5f9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {topicMsgTitle}
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 999, background: isMergeTopicMsg ? "rgba(148,163,184,0.18)" : "rgba(34,197,94,0.15)", color: isMergeTopicMsg ? "#94a3b8" : "#4ade80" }}>
                            {isMergeTopicMsg ? "归并" : "进行中"}
                          </span>
                        </div>
                      )}
                      {!isTopicMsg && msg.kind === "relation" && (
                        <div style={{ marginBottom: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                          <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(255,255,255,0.08)", color: "#9ca3af" }}>
                            {relType ? String(relType) : "关系"}
                          </span>
                          {suppressedRelIds.has(msg.id) && (
                            <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(239,68,68,0.2)", color: "#fca5a5", border: "1px solid rgba(239,68,68,0.35)" }}>
                              你已反对 · 点赞同恢复
                            </span>
                          )}
                          {activeStanceRelIds.has(msg.id) && (() => {
                            const info = activeStanceByRelMsgId.get(msg.id);
                            if (!info) return null;
                            return info.type === 'disagree' ? (
                              <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(239,68,68,0.15)", color: "#fca5a5", border: "1px solid rgba(239,68,68,0.3)" }}>
                                你的反对生效中
                              </span>
                            ) : (
                              <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(34,197,94,0.15)", color: "#86efac", border: "1px solid rgba(34,197,94,0.3)" }}>
                                你的赞同生效中
                              </span>
                            );
                          })()}
                          {overriddenStanceRelIds.has(msg.id) && (
                            <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(255,255,255,0.04)", color: "#6b7280", border: "1px solid rgba(255,255,255,0.1)" }}>
                              已失效
                            </span>
                          )}
                        </div>
                      )}
                      {isActiveText && isContentKind(msg.kind) && <div style={{ fontSize: 11, color: "#0b84ff", marginBottom: 4 }}>文本选择模式：拖选记录 start+len；或点击高亮片段</div>}
                      {summaryCoverages.length > 0 && (
                        <div style={{ marginBottom: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {summaryCoverages.map(item => (
                            <span key={item.summaryId} style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "rgba(245,158,11,0.14)", color: "#fcd34d", border: "1px solid rgba(245,158,11,0.28)" }}>
                              非线性视图由总结「{item.title}」覆盖
                            </span>
                          ))}
                        </div>
                      )}
                      <div style={{ fontSize: 13, color: "#f5f5f5" }} onMouseUp={e => isContentKind(msg.kind) && handleTextMouseUp(e, msg.id)}>
                        {isContentKind(msg.kind)
                          ? renderMessageContentWithAnchorsForList(msg)
                          : isTopicMsg
                            ? (
                              <div style={{ fontSize: 12, color: "#94a3b8", display: "flex", gap: 12, flexWrap: "wrap" }}>
                                <span>由 <span style={{ fontWeight: 600, color: "#cbd5e1" }}>{msg.author}</span> 发起</span>
                                <span>💬 {topicMsgTargetCount} 条观点</span>
                                <span>{new Date(msg.createdAt).toLocaleDateString('zh-CN')}</span>
                              </div>
                            )
                            : <div style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#d1d5db" }}>{msg.content}</div>}
                      </div>
                      {/* Phase 3: Settlement Panel as floating overlay */}
                      {settlementOpenMsgId === msg.id && (
                        <div data-settlement-panel style={{ position: "absolute", right: 0, top: "100%", zIndex: 100, width: 360, marginTop: 4 }}>
                          <SettlementPanel messageId={msg.id} topicId={topicId!} highlightRoundId={sessionStorage.getItem('settlementHighlightRound')} entryHighlight={settlementEntryHighlight} onMessageCreated={(nm:any) => (window as any).__addSettlementMessage?.({...nm, kind: nm.kind})} filterSettlementType={settlementOpenType ?? undefined} />
                          <div style={{ marginTop: 4 }}>
                            <RoundHistory messageId={msg.id} compact />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <GraphView
                  key={`gv-${classifyKey}-${focusKey}`}
                  messages={graphMessagesFinal} edges={edgesToRender} draftUnits={draftUnits}
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
                  settlementOpenMsgId={settlementOpenMsgId}
                  settlementOpenType={settlementOpenType}
                  onSettlementMessageCreated={(m: any) => {
                    setMessages(prev => [...prev, { ...m, author: m.author || user?.username || '', kind: m.kind || 'round' }]);
                    setTimeout(() => scrollMsgToCenter(m.id), 50);
                  }}
                  stanceHighlight={stanceHighlight}
                  settlementEntryHighlight={settlementEntryHighlight}
                  crossClassifyRefs={crossClassifyRefs}
                  onCrossRefTagClick={handleCrossRefTagClick}
                  onDebugRects={setDebugRects}
                />
            )}
          </div>
        </div>

        {/* Draggable splitter */}
        <div
          onMouseDown={handleSplitterMouseDown}
          style={{ width: 6, flexShrink: 0, background: "#2a2a2a", cursor: "col-resize", borderLeft: "1px solid #383838", borderRight: "1px solid #383838", transition: "background 0.15s" }}
          onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "#3a3a3a"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = "#2a2a2a"; }}
        />

        <div ref={rightPanelRef} style={{ flex: TOTAL_FLEX - leftFlex, padding: 8, display: "flex", flexDirection: "column", gap: 8, overflow: "auto", minWidth: 0 }}>
          <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>候选区（Draft）</div>
              <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
                <button onClick={clearDraftAll} disabled={draftUnits.length === 0 && !activeTextSelectId}
                  style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: draftUnits.length === 0 && !activeTextSelectId ? "#333" : "#444", color: draftUnits.length === 0 && !activeTextSelectId ? "#777" : "#fff", cursor: draftUnits.length === 0 && !activeTextSelectId ? "default" : "pointer" }}>
                  清空
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button onClick={() => { const selWhole = getSelectedWholeMessageIds(); if (selWhole.length > 0) enterFocusMultiple(selWhole, { replace: false }); else if (lastClickedMessageId) enterFocus(lastClickedMessageId, { replace: false }); }} disabled={!canSetFocus}
                    style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: canSetFocus ? "#444" : "#333", color: canSetFocus ? "#fff" : "#777", cursor: canSetFocus ? "pointer" : "default" }}>
                    设为焦点消息
                  </button>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={exitFocus} disabled={!canExitFocus} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: canExitFocus ? "#444" : "#333", color: canExitFocus ? "#fff" : "#777", cursor: canExitFocus ? "pointer" : "default" }} title="退出最近一次进入的焦点并恢复进入该焦点前的现场">退出焦点</button>
                    <button onClick={exitAllFocus} disabled={!canExitFocus} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: canExitFocus ? "#333" : "#222", color: canExitFocus ? "#fff" : "#777", cursor: canExitFocus ? "pointer" : "default" }} title="退出所有焦点并恢复进入第一个焦点前的现场">退出全部</button>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>焦点距离（hop）：{focusHop}</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => setFocusHop(h => Math.max(0, h - 1))} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#222", color: "#fff", cursor: "pointer" }}>-</button>
                <button onClick={() => setFocusHop(h => Math.min(8, h + 1))} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: "#222", color: "#fff", cursor: "pointer" }}>+</button>
                <div style={{ fontSize: 12, opacity: 0.7 }}>（可设置 hop，默认 1，最大 8）</div>
              </div>
            </div>

            {draftGroups.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>当前未选择任何候选。</div>
            ) : (
              <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, maxHeight: 220, overflow: "auto", fontSize: 12, marginTop: 8 }}>
                {draftGroups.map(g => (
                  <li key={`DG-${g.messageId}`} style={{ borderBottom: "1px solid #333", paddingBottom: 6, marginBottom: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span>{g.messageId} · 整条：{g.wholeSelected ? "是" : "否"} · 片段数：{g.fragments.length}</span>
                      {g.wholeSelected && <button onClick={() => removeUnitFromDraft({ messageId: g.messageId, selection: { kind: "whole" } })} style={{ fontSize: 10, padding: "0 6px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer" }}>删除整条</button>}
                    </div>
                    {g.fragments.length > 0 && (
                      <ul style={{ listStyle: "disc", marginLeft: 18, marginTop: 2, marginBottom: 0 }}>
                        {g.fragments.map(u => {
                          const s = u.selection;
                          const label = s.kind === "edge" ? `@edge:${s.edgeId}` : s.kind === "text" ? `start=${s.start} len=${s.len} "${s.text}"` : "(whole)";
                          return (
                            <li key={selKey(u)} style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
                              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
                              <button onClick={() => removeUnitFromDraft(u)} style={{ fontSize: 10, padding: "0 6px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer", flex: "0 0 auto" }}>删除片段</button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div style={{ marginTop: 6, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => commitDraftTo("source")} disabled={draftUnits.length === 0} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: draftUnits.length === 0 ? "#333" : "#444", color: draftUnits.length === 0 ? "#777" : "#fff", cursor: draftUnits.length === 0 ? "default" : "pointer", fontSize: 12 }}>加入来源集合</button>
              <button onClick={() => commitDraftTo("target")} disabled={draftUnits.length === 0} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: draftUnits.length === 0 ? "#333" : "#444", color: draftUnits.length === 0 ? "#777" : "#fff", cursor: draftUnits.length === 0 ? "default" : "pointer", fontSize: 12 }}>加入目标集合</button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Sources</div>
              {sourceUnits.length === 0 ? <div style={{ fontSize: 12, opacity: 0.6 }}>暂无。</div> : (
                <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, maxHeight: 120, overflow: "auto", fontSize: 12 }}>
                  {sourceUnits.map(u => (
                    <li key={selKey(u)} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                      <span>{describeUnit(u)}</span>
                      <button onClick={() => removeUnitFrom("source", u)} style={{ fontSize: 10, padding: "0 6px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer" }}>删除</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Targets</div>
              {targetUnits.length === 0 ? <div style={{ fontSize: 12, opacity: 0.6 }}>暂无。</div> : (
                <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, maxHeight: 120, overflow: "auto", fontSize: 12 }}>
                  {targetUnits.map(u => (
                    <li key={selKey(u)} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                      <span>{describeUnit(u)}</span>
                      <button onClick={() => removeUnitFrom("target", u)} style={{ fontSize: 10, padding: "0 6px", borderRadius: 4, border: "1px solid #666", background: "#333", color: "#eee", cursor: "pointer" }}>删除</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {user && (
            <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontWeight: 600 }}>关系标签与消息文本</div>
              {hasSecondaryRelationSelector && (() => {
                const opts = relationType === "reply"
                  ? ["none", "question", "answer"]
                  : relationType === "tag"
                    ? tagSecondaryOptions
                    : relationType === "arrange"
                      ? ["vertical", "horizontal"]
                      : relationType === "reference"
                        ? ["none", "evidence", "custom"]
                        : correctSecondaryOptions;
                return (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, flexWrap: "wrap" }}>
                    <span style={{ opacity: 0.85 }}>附加关系：</span>
                    {opts.map(t => (
                      <button key={t} onClick={() => setSecondaryRelationType(prev => (prev === t && t !== "none") ? "none" : t)}
                        style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: secondaryRelationType === t ? "#0b84ff" : "#222", color: secondaryRelationType === t ? "#fff" : "rgba(255,255,255,0.7)", cursor: "pointer" }}>
                        {secondaryRelationLabel(t)}
                      </button>
                    ))}
                  </div>
                );
              })()}
              {/* SubType selector: shown when TAG + recommend/archive is selected */}
              {((relationType === "tag" && (secondaryRelationType === "recommend" || secondaryRelationType === "archive")) || relationType === "recommend" || relationType === "archive") && (
                <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, flexWrap: "wrap" }}>
                  <span style={{ opacity: 0.85 }}>标注理由：</span>
                  {SUB_TYPE_OPTIONS.map(st => (
                    <button key={st || 'none'} onClick={() => { setSubType(st); if (st !== 'CUSTOM') { setSubTypeCustomLabel(''); setNewMessageContent(''); } }}
                      style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: subType === st ? (secondaryRelationType === "recommend" ? "#f59e0b" : "#64748b") : "#222", color: subType === st ? "#fff" : "rgba(255,255,255,0.7)", cursor: "pointer" }}>
                      {st ? subTypeLabel(st) : '无'}
                    </button>
                  ))}
                </div>
              )}
              {/* Label input: REPLY (auto-filled, read-only) or REFERENCE+custom (editable) */}
              {relationType === "reply" && (
              <input
                style={{ width: "100%", padding: 4, borderRadius: 4, border: "1px solid #555", background: relationType === "reply" ? "#1a1a1a" : "#222", color: relationType === "reply" ? "#999" : "#eee", fontSize: 12 }}
                placeholder="回复标签由附加关系决定"
                value={relationType === "reply" ? replyAdditionalLabel(secondaryRelationType) : relationLabel}
                readOnly={relationType === "reply"}
                onChange={e => relationType !== "reply" && setRelationLabel(e.target.value)}
              />
              )}
              {/* REFERENCE(自定义): show label input for custom text */}
              {relationType === "reference" && secondaryRelationType === "custom" && (
              <input
                style={{ width: "100%", padding: 4, borderRadius: 4, border: "1px solid #555", background: "#222", color: "#eee", fontSize: 12 }}
                placeholder="输入自定义引用标签"
                value={relationLabel}
                onChange={e => setRelationLabel(e.target.value)}
              />
              )}
              <div key={composerRefreshKey}>
              {(() => {
                const isCustomSubType = subType === 'CUSTOM' && ((relationType === "tag" && (secondaryRelationType === "recommend" || secondaryRelationType === "archive")) || relationType === "recommend" || relationType === "archive");
                const textAreaDisabled =
                  (isCustomSubType ? false : (
                    (draftHasRelationTarget && relationType === "correct")
                    || (isTagWithQuickAnnotate && hasTargetsAvailable)
                    || (isMergeType && hasTargetsAvailable)
                  ));
                const placeholderText = isCustomSubType ? "输入自定义理由（最长20字）"
                  : textAreaDisabled
                  ? (isTagWithQuickAnnotate ? "已选择附加关系，此处不可输入" : isMergeType ? "归并关系为用户-消息关系，此处不应输入内容" : "更正关系目标为关系消息时，此处不应有内容")
                  : isClassifyType ? "输入分类名称（不能为空）"
                  : isSummaryType ? "输入总结内容（不能为空）"
                  : isGovernanceOrOpsType ? (relationType === "proposal" ? "输入提案内容（不能为空，支持 Markdown）" : relationType === "code_change" ? "输入代码内容（不能为空，支持 Markdown）" : "输入运营公告内容（不能为空，支持 Markdown）")
                  : "输入一条新普通消息（支持自由换行）";
                return (
                  <textarea
                    style={{ width: "100%", minHeight: 80, maxHeight: 220, padding: 4, borderRadius: 4, border: "1px solid #555", background: textAreaDisabled ? "#1a1a1a" : "#222", color: textAreaDisabled ? "#666" : "#eee", fontSize: 13, resize: "vertical" }}
                    placeholder={placeholderText}
                    value={newMessageContent}
                    readOnly={textAreaDisabled}
                    onChange={e => !textAreaDisabled && setNewMessageContent(e.target.value)}
                  />
                );
              })()}
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {/* Text stake: only when text creates a separate message */}
                {hasTextContent && !isClassifyType && !isSummaryType && !isMergeType && !isGovernanceOrOpsType && !(draftHasRelationTarget && relationType === "correct") && !(isTagWithQuickAnnotate && hasTargetsAvailable) && (
                  <>
                    <span style={{ fontSize: 11, color: "#888" }}>文本:</span>
                    <input
                      type="number"
                      min={10}
                      max={availablePoints}
                      value={stakeAmount}
                      onChange={e => {
                        const raw = e.target.value;
                        if (raw === '') { setStakeAmount(''); return; }
                        const v = parseInt(raw);
                        if (isNaN(v)) return;
                        setStakeAmount(Math.min(v, availablePoints));
                      }}
                      style={{ width: 48, padding: "2px 4px", borderRadius: 4, border: "1px solid #555", background: "#1a1a1a", color: "#eee", fontSize: 12, textAlign: "center" }}
                    />
                  </>
                )}
                {/* Relation stake */}
                {relationType && (
                  <>
                    <span style={{ fontSize: 11, color: "#888" }}>{hasTextContent && !isClassifyType && !isSummaryType && !isMergeType && !isGovernanceOrOpsType && !(draftHasRelationTarget && relationType === "correct") && !(isTagWithQuickAnnotate && hasTargetsAvailable) ? '+关系:' : '押注:'}</span>
                    <input
                      type="number"
                      min={effectiveMinStake}
                      max={availablePoints}
                      value={relStakeAmount}
                      onChange={e => {
                        const raw = e.target.value;
                        if (raw === '') { setRelStakeAmount(''); return; }
                        const v = parseInt(raw);
                        if (isNaN(v)) return;
                        setRelStakeAmount(Math.min(v, availablePoints));
                      }}
                      style={{ width: 48, padding: "2px 4px", borderRadius: 4, border: typeof relStakeAmount === 'number' && relStakeAmount < effectiveMinStake ? "1px solid #f87171" : "1px solid #666", background: "#1a1a1a", color: "#eee", fontSize: 12, textAlign: "center" }}
                    />
                    {subType && subTypeStakeMap.current[subType] && subTypeStakeMap.current[subType] > (relationStakeMap.current[relationType.toUpperCase()] ?? 0) && (
                      <span style={{ fontSize: 10, color: "#f59e0b" }}>（「{subTypeLabel(subType)}」最低 {subTypeStakeMap.current[subType]} 点）</span>
                    )}
                  </>
                )}
                {/* Default: plain text message */}
                {!hasTextContent && !relationType && (
                  <>
                    <span style={{ fontSize: 11, color: "#888" }}>押注:</span>
                    <input
                      type="number"
                      min={10}
                      max={availablePoints}
                      value={stakeAmount}
                      onChange={e => {
                        const raw = e.target.value;
                        if (raw === '') { setStakeAmount(''); return; }
                        const v = parseInt(raw);
                        if (isNaN(v)) return;
                        setStakeAmount(Math.min(v, availablePoints));
                      }}
                      style={{ width: 48, padding: "2px 4px", borderRadius: 4, border: "1px solid #555", background: "#1a1a1a", color: "#eee", fontSize: 12, textAlign: "center" }}
                    />
                  </>
                )}
                <span style={{ fontSize: 11, color: "#666" }}>点 / {availablePoints}</span>
                {/* Total consumption breakdown */}
                {totalConsumption && (
                  <span style={{ fontSize: 11, color: totalConsumption.total > availablePoints ? "#f87171" : "#f59e0b" }}>
                    总计 {totalConsumption.total} 点
                    <span style={{ color: "#888" }}>
                      （{[
                        totalConsumption.hasText ? `文本 ${totalConsumption.textStake}` : null,
                        totalConsumption.hasRel ? `关系 ${totalConsumption.perStake}×${totalConsumption.relCount}` : null,
                        (totalConsumption as any).refCount > 0 ? `引用 ${(totalConsumption as any).refStakeTotal}` : null,
                        totalConsumption.burnTotal > 0 ? `燃烧 ${totalConsumption.burnTotal}` : null,
                      ].filter(Boolean).join(' + ')}）
                    </span>
                  </span>
                )}
                <button
                  onClick={handleQuickSendAndRelateFromDraftTargets}
                  disabled={!singleButtonEnabled}
                  style={{ padding: "4px 14px", borderRadius: 4, border: "1px solid #666", background: singleButtonEnabled ? "#0b84ff" : "#333", color: singleButtonEnabled ? "#fff" : "#777", cursor: singleButtonEnabled ? "pointer" : "default", fontSize: 13, fontWeight: 600, flexShrink: 0 }}
                >
                  发送
                </button>
                <span style={{ fontSize: 11, opacity: singleButtonEnabled ? 0.9 : 0.5, color: singleButtonEnabled ? "#cce4ff" : "#999" }}>
                  {singleButtonLabel}
                </span>
              </div>
              {sendError && (
                <div style={{ color: "#f87171", fontSize: 11, marginTop: 4 }}>{sendError}</div>
              )}
              </div>
            </div>
          )}

          <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}>
            <div style={{ fontWeight: 600 }}>焦点</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{isInsideClassify ? "当前模式：分类" : "当前模式：焦点"}</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>当前焦点：{currentFocusIds ? currentFocusIds.join(", ") : "（无）"}</div>
          </div>

          <TopicStructureView key={`sv-${classifyKey}-${focusKey}`} focusIds={currentFocusIds ?? []} messages={messages} edges={edges} />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>最近普通消息</div>
              <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, fontSize: 12, maxHeight: 100, overflow: "auto" }}>
                {recentNormals.map(m => <li key={m.id}>{m.id}：{m.content.slice(0, 40)}{m.content.length > 40 ? "…" : ""}</li>)}
              </ul>
            </div>
            <div style={{ flex: 1, border: "1px solid #444", borderRadius: 6, padding: 8, minWidth: 0 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>最近关系消息</div>
              <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, fontSize: 12, maxHeight: 100, overflow: "auto" }}>
                {recentRelations.map(m => <li key={m.id}>{m.id}：{m.content.slice(0, 60)}{m.content.length > 60 ? "…" : ""}</li>)}
              </ul>
            </div>
          </div>
          {/* Phase 5: Stance History Panel */}
          <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8, marginTop: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>📋 站队 · 立场 · 表态</div>
              <button
                onClick={() => setShowStanceHistory(!showStanceHistory)}
                style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: showStanceHistory ? "#0b84ff" : "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}
              >
                {showStanceHistory ? '收起' : '展开'}
              </button>
            </div>
            {showStanceHistory && user && (
              <div style={{ marginTop: 8 }}>
                <StanceHistoryPanel userId={user.id} topicId={topicId} />
              </div>
            )}
          </div>
          {/* Audit Log Panel */}
          <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8, marginTop: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>📋 审计日志</div>
              <button
                onClick={() => setShowAuditLog(!showAuditLog)}
                style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: showAuditLog ? "#0b84ff" : "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}
              >
                {showAuditLog ? '收起' : '展开'}
              </button>
            </div>
            {showAuditLog && (
              <div style={{ marginTop: 8 }}>
                <AuditLogView topicId={topicId} />
              </div>
            )}
          </div>
          {/* Revenue Panel */}
          <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8, marginTop: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>💰 收入</div>
              <button
                onClick={() => setShowRevenue(!showRevenue)}
                style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid #666", background: showRevenue ? "#0b84ff" : "#333", color: "#fff", cursor: "pointer", fontSize: 12 }}
              >
                {showRevenue ? '收起' : '展开'}
              </button>
            </div>
            {showRevenue && (
              <div style={{ marginTop: 8 }}>
                <RevenuePanel />
              </div>
            )}
          </div>
          {/* DEBUG: rectangle info */}
          <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8, marginTop: 8 }}>
            <div style={{ fontWeight: 600, marginBottom: 4, color: "#0f0" }}>Debug Rects</div>
            <pre style={{ fontSize: 10, fontFamily: "monospace", color: "#0f0", margin: 0, maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap" }}>{debugRects || "等待数据..."}</pre>
          </div>
        </div>
      </div>
    </div>
    </ErrorBoundary>

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
        onClose={() => setComparisonPopup(null)}
      />
    )}
    </>
  );
}
