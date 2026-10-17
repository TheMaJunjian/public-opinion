import { useRelationToolbar } from './workbench/useRelationToolbar';
import { useWorkbenchViewport } from './workbench/useWorkbenchViewport';
import { useWorkbenchData, VIEWER_USERNAME_KEY } from './workbench/useWorkbenchData';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import type {
  DemoEdge,
  DemoMessage,
  MessageKind,
  RelationType,
  UnitSelection,
} from '../utils/modelBridge';
import { computeEffectiveSuppressedRelIds, computeGloballySuppressedRelIds, computeTransitiveVoteStats, computeUserActiveStanceRelIds, computeUserOverriddenStanceRelIds, demoMessageToRelation, isContentKind, withCorrectionContent } from '../utils/modelBridge';
import { getLatestUserReadStatusByMessageId } from './workbench/model/filters';
import { blockCorrectionForSecondBettor as runBlockCorrectionForSecondBettor, handleAuthError as runHandleAuthError, requireAuth as runRequireAuth } from './workbench/actions/authentication';
import { clearDraftAll as runClearDraftAll, commitDraftTo as runCommitDraftTo, handleCanvasBlankClick as runHandleCanvasBlankClick, handleFragmentAnchorClick as runHandleFragmentAnchorClick, handleMessageClick as runHandleMessageClick, handleMessageDoubleClick as runHandleMessageDoubleClick, handleMessageMouseDown as runHandleMessageMouseDown, handleMessageMouseUp as runHandleMessageMouseUp, handleTextMouseUp as runHandleTextMouseUp, toggleFragmentSelection as runToggleFragmentSelection, toggleWholeUnit as runToggleWholeUnit, undoRecentClickActionsForMessage as runUndoRecentClickActionsForMessage } from './workbench/actions/cardSelection';
import { renderAlertMessage as runRenderAlertMessage, renderMessageContentWithAnchorsForList as runRenderMessageContentWithAnchorsForList, renderRelationContentWithTargets as runRenderRelationContentWithTargets } from './workbench/actions/messageRendering';
import { confirmReverseCorrection as runConfirmReverseCorrection, handleComparisonVote as runHandleComparisonVote, handleCrossRefTagClick as runHandleCrossRefTagClick, handleDecorationBodyClick as runHandleDecorationBodyClick, handleDecorationDoubleClick as runHandleDecorationDoubleClick, handleDecorationIconClick as runHandleDecorationIconClick, handleGroupFrameClick as runHandleGroupFrameClick, handleGroupFrameDoubleClick as runHandleGroupFrameDoubleClick, handleInlineBadgeClick as runHandleInlineBadgeClick, handleInlineBadgeDoubleClick as runHandleInlineBadgeDoubleClick, handleTagBodyClick as runHandleTagBodyClick, handleTagDoubleClick as runHandleTagDoubleClick } from './workbench/actions/relationActions';
import { clampAndSetScroll, findMessageElements, cancelScrollRafs as runCancelScrollRafs, scheduleViewNavigation as runScheduleViewNavigation, scrollMsgToCenter as runScrollMsgToCenter, showMessagePulse as runShowMessagePulse } from './workbench/actions/scrollNavigation';
import type { ScrollMessageOptions } from './workbench/actions/scrollNavigation';
import { handleQuickSendAndRelateFromDraftTargets as runHandleQuickSendAndRelateFromDraftTargets } from './workbench/actions/sendDraft';
import { createJoinRelationsForContainer as runCreateJoinRelationsForContainer, handleCreateRelationWithSourcesAndTargets as runHandleCreateRelationWithSourcesAndTargets, sendTagRelation as runSendTagRelation } from './workbench/actions/sendRelation';
import { attachMessageToCurrentClassify as runAttachMessageToCurrentClassify, handleSendMessageOnly as runHandleSendMessageOnly, registerCreatedRelationInCurrentClassify as runRegisterCreatedRelationInCurrentClassify } from './workbench/actions/sendText';
import { handleSendClick as runHandleSendClick } from './workbench/actions/sendTransaction';
import { collectExclusiveRelationMsgIds as runCollectExclusiveRelationMsgIds, getClassifyTargetRefs as runGetClassifyTargetRefs, getContainerCycleError as runGetContainerCycleError, getContainerMembershipTargetError as runGetContainerMembershipTargetError, getDependentDisplayTarget as runGetDependentDisplayTarget, getDependentDisplayTargets as runGetDependentDisplayTargets, getGroupedTargetTextMessageIds as runGetGroupedTargetTextMessageIds, getJoinContainerCycleError as runGetJoinContainerCycleError, getSelectedWholeMessageIds as runGetSelectedWholeMessageIds, hasCrossNonReferenceTextLinkForClassifyTargets as runHasCrossNonReferenceTextLinkForClassifyTargets, organizationTargetRef as runOrganizationTargetRef, promoteCompleteContainerSelections as runPromoteCompleteContainerSelections, resolveEffectiveTargetUnits as runResolveEffectiveTargetUnits } from './workbench/actions/targetResolution';
import { captureSnapshot as runCaptureSnapshot, confirmMessageIdNavigation as runConfirmMessageIdNavigation, enterClassification as runEnterClassification, enterTemporaryCategory as runEnterTemporaryCategory, enterTrace as runEnterTrace, enterTraceMultiple as runEnterTraceMultiple, exitAllTemporaryCategories as runExitAllTemporaryCategories, exitAllTrace as runExitAllTrace, exitClassification as runExitClassification, exitTemporaryCategory as runExitTemporaryCategory, exitTrace as runExitTrace, findContainingClassification as runFindContainingClassification, handleExitClassification as runHandleExitClassification, restoreSnapshot as runRestoreSnapshot } from './workbench/actions/viewHistory';
import { deriveComparisonGraphProjections, projectComparisonSide } from './workbench/projections/comparisonGraphProjections';
import type { DeriveComparisonGraphProjectionsInput } from './workbench/projections/comparisonGraphProjections';
import { deriveCrossClassifyRefs } from './workbench/projections/crossClassifyRefs';
import { deriveGraphMessagesToRender } from './workbench/projections/graphMessagesToRender';
import { projectGraphScene } from '../utils/graphProjection';
import { deriveHiddenInGraphView } from './workbench/projections/hiddenInGraphView';
import { deriveHomeFilterResult } from './workbench/projections/homeFilterResult';
import { deriveMessagesToShow } from './workbench/projections/messagesToShow';
import { deriveNormalGraphProjection } from './workbench/projections/normalGraphProjection';
import {deriveContainerEffect} from './workbench/model/containerEffect';
import { deriveReclassificationJoinCount } from './workbench/projections/reclassificationJoinCount';
import { deriveSendValidationLabel } from './workbench/projections/sendValidationLabel';
import { deriveSingleButtonEnabled } from './workbench/projections/singleButtonEnabled';
import { deriveSingleButtonLabel } from './workbench/projections/singleButtonLabel';
import { deriveTraceFrameIds } from './workbench/projections/traceFrameIds';
import type { ClassifyStackEntry, DraftGroup, TraceEntry, TraceSnapshot, ViewMode } from './workbench/types';
import ClassificationHeader from './workbench/ui/ClassificationHeader';
import RelationRecordPopups from './workbench/ui/RelationRecordPopups';
import RelationToolbar from './workbench/ui/RelationToolbar';
import WorkbenchMessageList from './workbench/ui/WorkbenchMessageList';
import WorkbenchViewToolbar from './workbench/ui/WorkbenchViewToolbar';

import type { Json } from '@gonglun/core';
import CorrectionComparisonPopup from '../components/CorrectionComparisonPopup';
import ErrorBoundary from '../components/ErrorBoundary';
import { Z_INDEX } from '../constants/zIndex';
import GraphView from '../components/GraphView';
import { clearBrowserSelection, relationTypeName } from '../utils/graphTextSelection';
import LeaderboardModal from '../components/LeaderboardModal';
import { MessageJumpOverlay } from '../components/PopupOverlay';
import PromptModal from '../components/PromptModal';
import WorkbenchLoadingBoundary, { useWorkbenchLoadingProgress } from '../components/WorkbenchLoadingBoundary';
import WorkbenchActivityIndicator from '../components/WorkbenchActivityIndicator';
import RegistrationGuideHint from '../components/RegistrationGuideHint';
import WorkbenchPanel from '../components/WorkbenchPanel';
import useStakeCalculation from '../hooks/useStakeCalculation';
import type { MessageStakes, Relation, TargetRef } from '../types';
import { getPresentationSpec, getRelationTitle } from '../types';
import { operationLog } from '../utils/debugLog';
import { beginWorkbenchDrawing, reportWorkbenchDrawingDuration, resetWorkbenchActivity } from '../utils/workbenchActivity';
import { PART_SELECTION_EVENT, isWholeMessageSelection, type PartSelectionDetail } from '../utils/messageElementSelection';
import { groupDraftSelections } from './workbench/actions/cardSelection';
import { referenceToUnit, targetRefToUnit, unitSelectionToReference } from '../utils/modelBridge';



import { type HomeFilterMode } from '../components/HomeFilterPanel';
import { applyMessageFilter, type MessageFilterSettings } from '../components/MessageFilterPanel';
import { useCleanView } from '../hooks/useCleanView';
import { ALL_RELATION_TYPES, MAX_TAG_LABEL_DISPLAY_LENGTH, SUB_TYPE_OPTIONS, buildRelationDemoMessage, isValidTagLabel, replyAdditionalLabel, secondaryRelationLabel, subTypeLabel } from './workbench/model/relationComposition';
import { applyTextCorrectionInheritance, expandTextIdsWithCorrections, isCorrectableCorrectionTarget } from './workbench/model/correction';
import { collectOwnedByRelation } from './workbench/model/ownership';
import { describeUnit } from '../utils/selectionLabel';
import { expandTextIdsWithSettlementResults } from './workbench/model/navigation';
import { filterContainerEdgesByEffectiveJoins, getJoinRecoveryTargetIds, getJoinRelationsForMessage,projectJoinMembershipEdges } from './workbench/model/membership';
import { nextId, selKey, unitEquals } from './workbench/model/selection';

// ========================= MessageWorkbenchPage =========================








interface MessageWorkbenchPageProps {
  topControlsFrozen?: boolean;
  topControlsOffset?: number;
}

export default function MessageWorkbenchPage({ topControlsFrozen = false, topControlsOffset = 68 }: MessageWorkbenchPageProps) {
  useEffect(() => () => resetWorkbenchActivity(), []);
  return <>
    <WorkbenchLoadingBoundary><MessageWorkbenchContent topControlsFrozen={topControlsFrozen} topControlsOffset={topControlsOffset} /></WorkbenchLoadingBoundary>
    <WorkbenchActivityIndicator />
  </>;
}

function MessageWorkbenchContent({ topControlsFrozen = false, topControlsOffset = 68 }: MessageWorkbenchPageProps) {
  const renderStartedAt = performance.now();
  const [viewMode, setViewMode] = useState<ViewMode>("graph");
  const { messageId: routeMessageId } = useParams<{ messageId: string }>();
  const scopeMessageId = routeMessageId ?? 'root';
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, logout, loading: authLoading } = useAuth();
  const {
    scope, messages, setMessages, edges, setEdges,
    edgesRef, relations, setRelations, attentionUsersByTarget, loadError,
    showUnauthenticatedNotice, setShowUnauthenticatedNotice, showRegistrationGuide, setShowRegistrationGuide, stakeCounts,
    setStakeCounts, messageBettorCounts, setMessageBettorCounts, authorStakes, setAuthorStakes,
    setLeaderboardRefreshVersion, registeredUsers, isPreloaded, viewerUser, setViewerUser,
    displayUser, correctionVersions, preloadedData, viewerUsers, loading,
    tagCounts,
  } = useWorkbenchData({ user, authLoading, scopeMessageId, navigate, viewMode });
  useWorkbenchLoadingProgress(loading, loadError);
  const { relationBarRef, relationLeftControlsRef, relationRightControlsRef, relationBarHeight, relationBarMinWidth, relationControlsRightOffset } = useRelationToolbar(loading);

  // Messages that have no DOM element in the non-linear graph view.
  // Mirror of GraphView's hiddenTargetIds logic — used to decide whether
  // to auto-switch to linear view when navigating to such a message.
  const hiddenInGraphView = useMemo(() => deriveHiddenInGraphView({ messages, edges }), [edges, messages]);

  // Auto-enter classify scope if msg belongs to one
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
        || msgRelType === 'REPLY' || msgRelType === 'CORRECT') {
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
      if (classifyRelMsgId) exitClassification({ restoreSnapshot: false });
      enterClassification(relId);
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
    if (classifyRelMsgId) exitClassification({ restoreSnapshot: false }); else setClassifyRelMsgId(null);
    if (hiddenInGraphView.has(msgId)) setViewMode("list");
    setAutoClassifyMsgId(null);
  }, [loading, relations, autoClassifyMsgId, hiddenInGraphView, edges, messages]);

  // Phase 3: auto-open settlement from URL params (triggered by points-navigate)
  const pendingScrollMsgRef = useRef<string | null>(null);
  const pendingScrollCompletionRef = useRef<ScrollMessageOptions['onComplete']>();
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
      // Trigger scroll directly (also needed for same-scope nav where messages don't change)
      setTimeout(() => scrollMsgToCenter(msgId), 150);
    }
  }, [searchParams, setSearchParams]);

  const [relationType, setRelationType] = useState<RelationType | null>(null);
  const [secondaryRelationType, setSecondaryRelationType] = useState<string>("none");
  const [subType, setSubType] = useState<string>(""); // SPAM|OFFTOPIC|LOWVALUE|IMPORTANT|CUSTOM or empty
  const [subTypeCustomLabel, setSubTypeCustomLabel] = useState("");
  const subTypeCustomBufferRef = useRef(""); // cache textarea content when switching away from CUSTOM subType
  const savedTextOnTypeSwitchRef = useRef(""); // cache textarea content when switching to a text-less relation type
  const savedTextBeforeDelegationRef = useRef("");
  const lastTagSecondaryRef = useRef<string>("recommend"); // remember last TAG secondary selection
  const lastDelegationSecondaryRef = useRef<'create' | 'fulfill'>('create');
  const delegationContentBufferRef = useRef<Record<'create' | 'fulfill', string>>({ create: '', fulfill: '' });
  const previousComposerModeRef = useRef<string>(`${relationType ?? 'plain'}::${secondaryRelationType}`);
  const [relationLabel, setRelationLabel] = useState("");
  const [newMessageContent, setNewMessageContent] = useState("");
  const [messageIdInput, setMessageIdInput] = useState("");
  useEffect(() => {
    if (relationType !== 'proposal') return;
    if (secondaryRelationType === '终止结算' || secondaryRelationType === '分配收入') {
      setNewMessageContent('');
    } else if (secondaryRelationType === '充值分账') {
      setNewMessageContent('充值总额=1000\n收入池分成=100\n指定与会者=user-id');
    } else if (secondaryRelationType === '运营收入注入') {
      setNewMessageContent('收入金额=1000\n来源=服务收入');
    }
  }, [relationType, secondaryRelationType]);
  useEffect(() => {
    const mode = `${relationType ?? 'plain'}::${secondaryRelationType}`;
    const previousMode = previousComposerModeRef.current;
    const wasDelegation = previousMode.startsWith('delegation::');
    const isDelegation = relationType === 'delegation';
    if (isDelegation && !wasDelegation) {
      savedTextBeforeDelegationRef.current = newMessageContent;
    }
    if (previousMode.startsWith('delegation::')) {
      const previousKind = previousMode.slice('delegation::'.length);
      if (previousKind === 'create' || previousKind === 'fulfill') {
        delegationContentBufferRef.current[previousKind] = newMessageContent;
      }
    }
    if (relationType === 'delegation' && (secondaryRelationType === 'create' || secondaryRelationType === 'fulfill')) {
      const saved = delegationContentBufferRef.current[secondaryRelationType];
      setNewMessageContent(saved || (secondaryRelationType === 'create' ? '报酬数量=100\n委托内容=' : '完成说明='));
    } else if (wasDelegation && !isDelegation) {
      setNewMessageContent(savedTextBeforeDelegationRef.current);
    }
    previousComposerModeRef.current = mode;
  }, [relationType, secondaryRelationType]);
  useEffect(() => {
    if (relationType !== 'delegation') return;
    if (secondaryRelationType === 'create' || secondaryRelationType === 'fulfill') {
      lastDelegationSecondaryRef.current = secondaryRelationType;
    } else {
      setSecondaryRelationType(lastDelegationSecondaryRef.current);
    }
  }, [relationType, secondaryRelationType]);
  const [draftUnits, setDraftUnits] = useState<UnitSelection[]>([]);
  const [sourceUnits, setSourceUnits] = useState<UnitSelection[]>([]);
  const [targetUnits, setTargetUnits] = useState<UnitSelection[]>([]);
  useEffect(() => {
    const selectPart = (event: Event) => {
      const { reference, label } = (event as CustomEvent<PartSelectionDetail>).detail;
      const unit = referenceToUnit(reference, undefined, label);
      setDraftUnits(previous => {
        if (sourceUnits.some(source => source.messageId === unit.messageId)) {
          setSendError('消息已在来源集合中，不能同时加入候选暂存区');
          return previous;
        }
        return previous.some(candidate => unitEquals(candidate, unit)) ? previous.filter(candidate => !unitEquals(candidate, unit)) : [...previous, unit];
      });
    };
    window.addEventListener(PART_SELECTION_EVENT, selectPart);
    return () => window.removeEventListener(PART_SELECTION_EVENT, selectPart);
  }, [sourceUnits]);
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
  const [traceEntries, setTraceEntries] = useState<TraceEntry[]>([]);
  const [traceExpandedFrameIds, setTraceExpandedFrameIds] = useState<Set<string>>(new Set());
  // Counter incremented on every exitTrace/exitAllTrace to force GraphView
  // remount, avoiding React DOM reconciliation bugs (removeChild errors)
  // that occur when the SVG canvas structure changes drastically.
  const [classifyKey, setClassifyKey] = useState(0);
  const [traceKey, setTraceKey] = useState(0);
  const [scrollKey, setScrollKey] = useState(0);
  // Classify state — independent from the trace system.
  // When non-null, the view is scoped to the CLASSIFY/SUMMARY relation's owned messages.
  const [classifyRelMsgId, setClassifyRelMsgId] = useState<string | null>(null);
  const isInsideClassify = classifyRelMsgId !== null;
  const currentClassifyRelMsgId = classifyRelMsgId;
  // Stack-based snapshot store for nested classify enter/exit.
  // Each entry holds the classify id and the snapshot captured before entering it.
  const classifyStackRef = useRef<ClassifyStackEntry[]>([]);
  const temporaryCategoryStackRef = useRef<Array<{
    snapshot: TraceSnapshot;
    hideJoin: boolean;
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
  const [containerPreviewId,setContainerPreviewId]=useState<string|null>(null);
  const containerPreviewStack=useRef<Array<{
    id:string|null; snapshot:TraceSnapshot; filter:MessageFilterSettings;
    classifyId:string|null; classifyStack:ClassifyStackEntry[];
    traceEntries:TraceEntry[]; expandedFrames:Set<string>; previewClassifyId:string|null;
    baseMessages:DemoMessage[]|null; baseEdges:DemoEdge[]|null;
  }>>([]);
  useEffect(()=>{setContainerPreviewId(null);containerPreviewStack.current=[];},[scopeMessageId]);
  const comparisonOrigin = useRef<{
    snapshot: TraceSnapshot; filter: MessageFilterSettings;
    classifyId: string | null; classifyStack: ClassifyStackEntry[];
    traceEntries: TraceEntry[]; expandedFrames: Set<string>;
    previewId: string | null;
  } | null>(null);
  const isPreviewMode = previewClassifyId !== null||containerPreviewId!==null;
  // Fetch tag counts for clean view
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
  const [homeFilterMode, setHomeFilterMode] = useState<HomeFilterMode | null>(null);
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
  useLayoutEffect(() => {
    if (!loading && viewMode === 'graph') reportWorkbenchDrawingDuration(performance.now() - renderStartedAt);
  });
  const [guideActive, setGuideActive] = useState(false);
  const guideTargetIdRef = useRef<string | null>(null);

  useEffect(() => {
    const startGuide = () => {
      setDraftUnits([]);
      setSourceUnits([]);
      setTargetUnits([]);
      setRelationType(null);
      setSecondaryRelationType('none');
      setNewMessageContent('');
      setActiveTextSelectId(null);
      clearBrowserSelection();
      guideTargetIdRef.current = null;
      setGuideActive(true);
      setViewMode('graph');
    };
    const stopGuide = () => {
      guideTargetIdRef.current = null;
      setGuideActive(false);
      if (messagePulseTimerRef.current) clearTimeout(messagePulseTimerRef.current);
      if (messagePulseRafRef.current) cancelAnimationFrame(messagePulseRafRef.current);
      setMessagePulse(null);
    };
    const clearGuideVisuals = () => {
      if (messagePulseTimerRef.current) clearTimeout(messagePulseTimerRef.current);
      if (messagePulseRafRef.current) cancelAnimationFrame(messagePulseRafRef.current);
      setMessagePulse(null);
    };
    window.addEventListener('guide-start', startGuide);
    window.addEventListener('guide-stop', stopGuide);
    window.addEventListener('guide-clear-visuals', clearGuideVisuals);
    return () => {
      window.removeEventListener('guide-start', startGuide);
      window.removeEventListener('guide-stop', stopGuide);
      window.removeEventListener('guide-clear-visuals', clearGuideVisuals);
    };
  }, [messages]);

  useEffect(() => {
    if (!guideActive) return;
    const targetId = guideTargetIdRef.current;
    const selected = targetId ? draftUnits.some(unit => isWholeMessageSelection(unit, targetId)) : false;
    window.dispatchEvent(new CustomEvent('guide-selection-changed', { detail: { messageId: targetId, selected } }));
    if (selected) window.dispatchEvent(new Event('guide-selection-complete'));
  }, [draftUnits, guideActive]);

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

  // Scroll to message after data loads and renders (also triggers on trace changes for in-place nav).
  // View-switch decisions (graph→list for hidden messages) are made in the auto-classify
  // effect above; this effect only handles the actual scrolling.
  useEffect(() => {
    if (!loading && pendingScrollMsgRef.current && messages.some(m => m.id === pendingScrollMsgRef.current)) {
      // A pending navigation may target a JOIN record itself. Do not resolve
      // it to the joined target; the JOIN card is the requested destination.
      const dependencyIds = pendingScrollDependencyIdsRef.current;
      pendingScrollDependencyIdsRef.current = [];
      const onComplete = pendingScrollCompletionRef.current;
      pendingScrollCompletionRef.current = undefined;
      scrollMsgToCenter(pendingScrollMsgRef.current, { dependencyIds, onComplete });
      pendingScrollMsgRef.current = null;
    }
  }, [loading, messages, classifyKey, traceKey, scrollKey, viewMode]);

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
  const [traceDistance, setTraceDistance] = useState<number>(1);
  const changeTraceDistance = useCallback((update: (distance: number) => number) => {
    setTraceDistance(currentDistance => update(currentDistance));
    setTraceExpandedFrameIds(new Set());
    setLastClickedMessageId(null);
    setTraceKey(key => key + 1);
  }, []);
  // Popup state for decoration double-click (shows sender info)
  const [decorationPopup, setDecorationPopup] = useState<{
    messageId: string; kind: "agree" | "disagree";
    x: number; y: number;
  } | null>(null);
  // Popup state for tag badge double-click (shows who tagged)
  const [tagPopup, setTagPopup] = useState<{
    messageId: string; tagLabel: string; relMsgIds: string[];
    x: number; y: number;
    subDetails?: Array<{ subType: string; customLabel?: string; count: number }>;
  } | null>(null);
  const [comparisonPopup, setComparisonPopup] = useState<{
    relMsgId: string;
    x: number; y: number;
    reversePreview?: {
      before: string;
      after: string;
      target: UnitSelection;
      mode?: 'direct';
      label?: string;
      value?: Json;
    };
  } | null>(null);
  const [mergeInfoPopup, setMergeInfoPopup] = useState<{
    relMsgId: string;
    x: number; y: number;
  } | null>(null);
  // DEBUG
  const [stakeAmount, setStakeAmount] = useState<number | ''>(0);
  const [relStakeAmount, setRelStakeAmount] = useState<number | ''>(0);
  const [minSelfStake, setMinSelfStake] = useState(0);
  const [recommendationAmount, setRecommendationAmount] = useState<number | ''>(0);
  const recommendationRef = useRef(0);
  recommendationRef.current = typeof recommendationAmount === 'number' ? recommendationAmount : 0;
  const selectedRelationRef = useRef(relationType);
  selectedRelationRef.current = relationType;
  const selectedSecondaryRef = useRef(secondaryRelationType);
  selectedSecondaryRef.current = secondaryRelationType;
  const sourceUnitsRef = useRef(sourceUnits);
  sourceUnitsRef.current = sourceUnits;
  const stakeAmountRef = useRef<number>(0);
  const relStakeRef = useRef<number>(0);
  stakeAmountRef.current = typeof stakeAmount === 'number' ? stakeAmount : 0;
  relStakeRef.current = typeof relStakeAmount === 'number' ? relStakeAmount : 0;
  const [availablePoints, setAvailablePoints] = useState(100); // Phase 2: balance cap
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendInFlight, setSendInFlight] = useState(false);
  const sendInFlightRef = useRef(false);
  const sentMessageTargetsRef = useRef<string[]>([]);
  const [sentMessageTargets, setSentMessageTargets] = useState<string[]>([]);
  const [awaitingSendOverlay, setAwaitingSendOverlay] = useState(false);
  const waitingForSendOverlay = awaitingSendOverlay && sentMessageTargets.length > 0 && !loadError;
  const handleSendOverlayReady = useCallback(() => setAwaitingSendOverlay(false), []);
  const activeSentMessageRef = useRef<string | null>(null);

  useEffect(() => {
    const sentMessageTarget = sentMessageTargets[0];
    if (sendInFlight || loading || !sentMessageTarget || activeSentMessageRef.current) return;
    const target = messages.find(message => message.id === sentMessageTarget);
    if (!target) return;
    const advance = () => {
      activeSentMessageRef.current = null;
      setSentMessageTargets(queue => queue[0] === sentMessageTarget ? queue.slice(1) : queue);
    };
    // Membership records update the structure without moving the user's view.
    if (target.kind === 'join' || target.relationType?.toLowerCase() === 'join') { advance(); return; }
    activeSentMessageRef.current = sentMessageTarget;
    if (!renderedMessageIdsRef.current.has(sentMessageTarget)) setHomeFilterMode(null);
    handleNavigateToMessage(sentMessageTarget, { select: false, preserveScope: true,
      onComplete: located => {
        if (activeSentMessageRef.current !== sentMessageTarget) return;
        // Prepare the next target immediately; its overlay replaces this one
        // as soon as it is ready, without waiting for the display timer.
        if (located) advance();
        else {
          // Placement JOINs can arrive in a later snapshot. Keep this target
          // queued until that render rather than silently dropping the message.
          activeSentMessageRef.current = null;
          // A message outside a temporary or trace view may remain queued
          // until the user returns. Release the dialog so they can navigate.
          if (traceEntries.length > 0 || temporaryCategoryStackRef.current.length > 0) setAwaitingSendOverlay(false);
          if (messagesRef.current !== messages) setSentMessageTargets(queue => [...queue]);
        }
      },
    });
  }, [sendInFlight, loading, sentMessageTargets, messages, viewMode, classifyKey, traceKey]);

  useEffect(() => () => {
    activeSentMessageRef.current = null;
  }, []);

  function recordSentMessage(messageId: string): void {
    if (!sentMessageTargetsRef.current.includes(messageId)) sentMessageTargetsRef.current.push(messageId);
  }

  useEffect(() => {
    setSendError(null);
  }, [
    relationType,
    secondaryRelationType,
    subType,
    relationLabel,
    newMessageContent,
    draftUnits,
    sourceUnits,
    targetUnits,
    stakeAmount,
    relStakeAmount,
  ]);

  const [settlementOpenMsgId, setSettlementOpenMsgId] = useState<string | null>(null);
  const [settlementOpenType, setSettlementOpenType] = useState<'TRUTH' | 'VALUE' | null>(null);
  const [comparisonMode, setComparisonMode] = useState(false);
  const [comparisonReviewed, setComparisonReviewed] = useState(false);

  useEffect(() => {
    const syncGuideAvailability = () => {
      const token = localStorage.getItem('token');
      const enabled = Boolean(user && token && !isPreloaded && !isPreviewMode && !comparisonMode && !comparisonReviewed);
      window.dispatchEvent(new CustomEvent('guide-availability-changed', { detail: { enabled } }));
    };
    syncGuideAvailability();
    return () => {
      window.dispatchEvent(new CustomEvent('guide-availability-changed', { detail: { enabled: false } }));
    };
  }, [user, isPreloaded, isPreviewMode, comparisonMode, comparisonReviewed]);
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
    if (sendInFlightRef.current) api.cancelCommandBatch(new Error(message));
    setAlertMessage(message);
  }, []);

  function renderAlertMessage(message: string): React.ReactNode {
    return runRenderAlertMessage({ handleNavigateToMessage }, message);
  }

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
    return runBlockCorrectionForSecondBettor({ mergeStakeSnapshot, showAlert }, messageId);
  }

  // Phase 5: Refs to avoid stale closure in points-navigate handler
  // (initialized empty; values synced via useEffect below after all useMemos run)
  const traceEntriesRef = useRef<TraceEntry[]>([]);
  const classifyRelMsgIdRef = useRef<string | null>(null);
  const relationsRef = useRef<Relation[]>([]);
  const relationByIdRef = useRef<Map<string, Relation>>(new Map());
  const relationTypeByRelMsgIdRef = useRef<Map<string, string>>(new Map());

  // Phase 5: Listen for points-navigate custom event (in-place navigation from PointsBadge)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        messageId: string; scopeMessageId: string; roundId: string | null; txType: string;
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
          exitClassification({ restoreSnapshot: false });
        }
      }

      // Auto-enter classify if target belongs to one (and not already in one)
      if (!classifyRelMsgIdRef.current) {
        for (const rel of currentRelations) {
          const rt = rel.relationType?.toUpperCase();
          if (rt !== 'CLASSIFY' && rt !== 'SUMMARY') continue;
          const targets = (rel.targetRefs ?? []) as TargetRef[];
          if (targets.some(t => (t.kind === 'message' || t.kind === 'text-fragment') && t.messageId === messageId)) {
            enterClassification(rel.id);
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
  // Preserve the original eligibility: a relation with at least one vote.
  // Content-like cards (including JOIN and settlement records) are excluded.
  const comparisonTargets = useMemo(
    () => messages.filter(message => {
      if (isContentKind(message.kind)) return false;
      const stats = voteStats[message.id];
      return (stats?.agreeCount ?? 0) + (stats?.disagreeCount ?? 0) > 0;
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
  const containerEffect = useMemo(() => deriveContainerEffect({messages,relations,edges,username:displayUser?.username??null}),[messages,relations,edges,displayUser?.username]);
  const effectiveSuppressedRelIdsForLayout = containerEffect.suppressed;
  const rejectedContainerIds = containerEffect.rejectedContainerIds;
  const rejectedJoinRelationIds = containerEffect.rejectedJoinRelationIds;

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
  const reclassificationJoinCount = useMemo(() => deriveReclassificationJoinCount({ relationType, draftUnits, targetUnits, relations, rejectedJoinRelationIds }), [relationType, draftUnits, targetUnits, relations, rejectedJoinRelationIds]);
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
    relationType, secondaryRelationType, subType, draftUnits, targetUnits, sourceUnits, newMessageContent,
    stakeAmount, relStakeAmount, recommendationAmount, relationStakeMap, subTypeStakeMap,
    existingJoinCount,
    joinOnlyAction,
    reclassificationJoinCount,
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
        target.closest('[data-prompt-modal="true"]') ||
        target.closest('[data-guide-overlay="true"]')
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
          const defaultStake = 0;
          relationStakeMap.current = {};
          subTypeStakeMap.current = {};
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
      }).catch(() => { });
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
      }).catch(() => { });
    };
    window.addEventListener('stakes-refresh', handler);
    return () => window.removeEventListener('stakes-refresh', handler);
  }, [mergeStakeSnapshot]);

  const currentTraceEntry = traceEntries.length > 0 ? traceEntries[traceEntries.length - 1] : null;
  const currentTraceIds = currentTraceEntry?.ids ?? null;
  const standaloneMessageIds=useMemo(()=>currentTraceIds?new Set(currentTraceIds):undefined,[currentTraceIds]);
  const relationById = useMemo(() => {
    const index = new Map(relations.map(relation => [relation.id, relation]));
    for (const message of messages) {
      const relation = demoMessageToRelation(message);
      if (relation) index.set(relation.id, relation);
    }
    return index;
  }, [messages, relations]);
  const msgMap = useMemo(() => {
    const map = new Map(messages.map(m => [m.id, m]));
    for (const relation of relations) {
      if (!map.has(relation.id)) map.set(relation.id, buildRelationDemoMessage(relation));
    }
    return map;
  }, [messages, relations]);
  const sendWarning = useMemo((): string | null => {
    if (relationType?.toUpperCase() !== 'DISAGREE') return null;
    const allTargetIds = [...targetUnits, ...draftUnits].filter(u => !u.reference?.partId && !u.reference?.memberId && !u.reference?.path?.length && !u.reference?.range
      && (!u.reference?.revision || u.reference.revision === msgMap.get(u.messageId)?.revision)).map(u => u.messageId);
    const targetMsgs = allTargetIds.map(id => msgMap.get(id)).filter(Boolean) as DemoMessage[];
    const hasContainer = targetMsgs.some(m => m.kind === 'relation' && ['classify', 'summary', 'merge', 'arrange'].includes(m.relationType ?? ''));
    if (hasContainer) return targetMsgs.some(m => m.relationType === 'summary')
      ? '反对总结将取消覆盖并恢复原消息；总结及其关联记录仍可查看和投票。'
      : '反对组织将按当前规则恢复成员消息的显示；组织消息及关联记录仍可查看和投票。';
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
      for (const ref of backendRel.targetRefs) {
        const edge: DemoEdge = {
          id: nextId("edge"),
          relationMessageId: backendRel.id,
          relationType: relType.toLowerCase() as RelationType,
          from: backendRel.sourceRefs?.[0] ? referenceToUnit(backendRel.sourceRefs[0]) : { messageId: fromMsgId, selection: { kind: "whole" } },
          to: targetRefToUnit(ref),
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
      }).catch(() => { });
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
        }).catch(() => { });
      }
    }
    window.dispatchEvent(new Event('points-refresh'));
    // Notify SettlementPanel to reload stakes for target messages
    for (const mid of targetMsgIds) {
      window.dispatchEvent(new CustomEvent('stakes-refresh', { detail: { messageId: mid } }));
    }
    return Promise.resolve(null);
  }, [scopeMessageId, mergeStakeSnapshot]);

  const createRel = useCallback(async (scopeMessageId: string, data: Parameters<typeof api.createRelation>[1]) => {
    const type = data.relationType.toLowerCase();
    const selected = selectedRelationRef.current;
    const primary = type === selected || (selected === 'tag' && type === selectedSecondaryRef.current);
    const amount = sendInFlightRef.current ? (primary ? relStakeRef.current : 0) : (data.wager ?? data.stakeAmount ?? 0);
    const currentMessages = new Map(messagesRef.current.map(message => [message.id, message]));
    const selectedSources = sourceUnitsRef.current.filter(unit => unit.messageId === data.sourceMessageId);
    const sourceRefs = data.sourceRefs ?? (selectedSources.length
      ? selectedSources.map(unit => unitSelectionToReference(unit, currentMessages))
      : data.sourceMessageId ? [{ messageId: data.sourceMessageId }] : []);
    const targetRefs = data.targetRefs.map(ref => ref.reference ? ref : {
      ...ref,
      reference: ['classify', 'summary', 'merge', 'arrange', 'join'].includes(type) && ref.kind !== 'text-fragment'
        ? { messageId: ref.kind === 'relation' ? ref.relationId : ref.messageId }
        : unitSelectionToReference(targetRefToUnit(ref), currentMessages),
    });
    try {
      const relation = await api.createRelation(classifyRelMsgIdRef.current ?? scopeMessageId, {
        ...data, targetRefs, sourceRefs, stakeAmount: 0,
        wager: amount, selfAgree: type !== 'agree' && type !== 'disagree' && amount > 0,
        recommendation: data.recommendation ?? (primary ? recommendationRef.current : 0),
      });
      if (sendInFlightRef.current && type !== 'join') recordSentMessage(relation.id);
      return relation;
    } catch (e: any) {
      api.cancelCommandBatch(e);
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

  const effectiveJoinRelationIds = containerEffect.effectiveJoinIds;

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

  const traceContainerMemberships = containerEffect.memberships;

  const readStatusByMessageId = useMemo(() => {
    const currentUserId = isPreloaded ? null : user?.id;
    const currentUsername = displayUser?.username;
    if (!currentUserId && !currentUsername) return new Map<string, 'READ' | 'UNREAD'>();
    return getLatestUserReadStatusByMessageId(relations, relation => isPreloaded
      ? relation.createdBy.username === currentUsername
      : relation.createdBy.id === currentUserId);
  }, [displayUser?.username, isPreloaded, relations, user?.id]);

  const homeFilterResult = useMemo(() => deriveHomeFilterResult({ displayUser, homeFilterMode, msgMap, messages, readStatusByMessageId, edges, traceContainerMemberships }), [displayUser?.username, edges, effectiveSuppressedRelIdsForLayout, homeFilterMode, isPreloaded, messages, msgMap, readStatusByMessageId, relations, traceContainerMemberships, user?.id]);

  const homeDisplayRoleByMessageId = useMemo(() => {
    const roles = new Map<string, 'source' | 'target' | 'source-target'>();
    const matchIds = homeFilterResult?.matchIds;
    const displayIds = homeFilterResult?.displayIds;
    if (!matchIds || !displayIds) return roles;
    const addRole = (messageId: string, role: 'source' | 'target') => {
      if (matchIds.has(messageId)) return;
      const previous = roles.get(messageId);
      if (!previous || previous === role) roles.set(messageId, role);
      else roles.set(messageId, 'source-target');
    };
    for (const edge of edges) {
      if (!displayIds.has(edge.relationMessageId)) continue;
      addRole(edge.from.messageId, 'source');
      addRole(edge.to.messageId, 'target');
    }
    return roles;
  }, [edges, homeFilterResult]);
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
  traceEntriesRef.current = traceEntries;
  classifyRelMsgIdRef.current = classifyRelMsgId;
  relationsRef.current = relations;
  relationByIdRef.current = relationById;
  relationTypeByRelMsgIdRef.current = relationTypeByRelMsgId as unknown as Map<string, string>;
  const replacedRelationMsgIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of edges) {
      if (e.relationType !== "correct" || e.proposalOnly) continue;
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
      const owned = collectOwnedByRelation(relation.id, relationById, new Set(), undefined, rejectedJoinRelationIds);
      owned.textIds.forEach(id => textIds.add(id));
      owned.relationIds.forEach(id => relationIds.add(id));
    }
    return { textIds, relationIds };
  }, [relations, relationById, rejectedJoinRelationIds]);

  // Active ownership: only non-rejected CLASSIFY relations.
  // Used by visibility logic — rejected classifies don't hide their messages.
  const activeClassifyOwnership = useMemo(() => containerEffect.ownership.active('CLASSIFY'),[containerEffect]);
  const mergeOwnership = useMemo(() => {
    const textIds = new Set<string>();
    const relationIds = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType !== 'MERGE') continue;
      const owned = collectOwnedByRelation(relation.id, relationById, new Set(), undefined, rejectedJoinRelationIds);
      owned.textIds.forEach(id => textIds.add(id));
      owned.relationIds.forEach(id => relationIds.add(id));
    }
    return { textIds, relationIds };
  }, [relations, relationById, rejectedJoinRelationIds]);
  // Full ownership: all SUMMARY relations regardless of approval status.
  const summaryOwnership = useMemo(() => {
    const textIds = new Set<string>();
    const relationIds = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType !== 'SUMMARY') continue;
      const owned = collectOwnedByRelation(relation.id, relationById, new Set(), undefined, rejectedJoinRelationIds);
      owned.textIds.forEach(id => textIds.add(id));
      owned.relationIds.forEach(id => relationIds.add(id));
    }
    return { textIds, relationIds };
  }, [relations, relationById, rejectedJoinRelationIds]);

  // Active ownership: only non-rejected SUMMARY relations.
  const activeSummaryOwnership = useMemo(() => containerEffect.ownership.active('SUMMARY'),[containerEffect]);
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

  function collectExclusiveRelationMsgIds(hiddenTextIds: Set<string>, ownedRelationIds: Set<string>): Set<string> {
    return runCollectExclusiveRelationMsgIds({ edges, msgMap }, hiddenTextIds, ownedRelationIds);
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
  const { leftPanelRef, fixedHorizontalScrollRef, fixedHorizontalScroll, leftPanelMinHeight, rightPanelRef, viewModeScrollRef, TOTAL_FLEX, MIN_LEFT_PX, MIN_RIGHT_PX, MAX_RIGHT_PX, leftFlex, effectiveContainerWidth, splitterActive, panelContainerRef, handleSplitterPointerDown, handleLeftPanelTouchStart, handleLeftPanelTouchMove, handleLeftPanelTouchEnd } = useWorkbenchViewport({ comparisonReviewed, viewMode, loading });
  const [messagePulse, setMessagePulse] = useState<{ element: HTMLElement; rect: DOMRect; visualRoot: HTMLElement | null; visualRect: DOMRect } | null>(null);
  const messagePulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagePulseRafRef = useRef<number | null>(null);
  const prevTraceLenRef = useRef(0);
  const lastAddedFragmentRef = useRef<{ messageId: string; unit: UnitSelection; time: number } | null>(null);
  const mouseDownRef = useRef<{ x: number; y: number; messageId: string | null } | null>(null);
  const lastDragOrSelectTimeRef = useRef<number>(0);
  const lastClickActionsRef = useRef<{ type: "toggleWhole"; messageId: string; prevExisted: boolean; time: number }[]>([]);
  // Ref to track the ID of a newly sent message that should be scrolled into view.
  const pendingScrollMsgIdRef = useRef<string | null>(null);
  // Track pending requestAnimationFrame handles so they can be cancelled before
  // React reconciles the DOM, preventing "removeChild" errors caused by stale
  // rAF callbacks accessing nodes that React has already removed.
  const scrollRafRef = useRef<number | null>(null);
  const scrollRaf2Ref = useRef<number | null>(null);
  const scrollRequestIdRef = useRef(0);
  const viewNavigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelScrollRafs(): void {
    return runCancelScrollRafs({ scrollRafRef, scrollRaf2Ref });
  }

  function scheduleViewNavigation(targetId: string): void {
    return runScheduleViewNavigation({ viewNavigationTimerRef, scrollMsgToCenter }, targetId);
  }

  // Cleanup on unmount
  useEffect(() => () => {
    cancelScrollRafs();
    if (viewNavigationTimerRef.current !== null) clearTimeout(viewNavigationTimerRef.current);
  }, []);

  // Check auth before sending: redirect to login if not logged in
  function requireAuth(): boolean {
    return runRequireAuth({ user, logout, navigate });
  }

  // Handle auth errors: logout and redirect to login
  async function handleAuthError(err: unknown): Promise<boolean> {
    return runHandleAuthError({ logout, navigate }, err);
  }

  // Scroll the left panel canvas so the message with the given ID is centered.
  // Polls via requestAnimationFrame until the card appears in the DOM.
  // MAX_SCROLL_ATTEMPTS × ~16ms/frame ≈ 1 second maximum wait time.
  const MAX_SCROLL_ATTEMPTS = 60;

  function showMessagePulse(targetId: string, element: HTMLElement, requestId = scrollRequestIdRef.current, onShown?: (shown: boolean) => void): void {
    return runShowMessagePulse({ scrollRequestIdRef, messagePulseTimerRef, messagePulseRafRef, leftPanelRef, findMessageElements, setMessagePulse }, targetId, element, requestId, onShown);
  }



  function scrollMsgToCenter(msgId: string, options?: ScrollMessageOptions): void {
    return runScrollMsgToCenter({ scrollRequestIdRef, pendingScrollMsgIdRef, MAX_SCROLL_ATTEMPTS, pendingScrollDependencyIdsRef, leftPanelRef, scrollRafRef, findMessageElements, relationsRef, edgesRef, showMessagePulse, cancelScrollRafs }, msgId, options);
  }

  function captureSnapshot(): TraceSnapshot {
    return runCaptureSnapshot({ viewMode, leftPanelRef, rightPanelRef, draftUnits, sourceUnits, targetUnits, activeTextSelectId, lastClickedMessageId, traceDistance });
  }

  // Both presentations enter and navigate the same ordinary workbench scope.
  function prepareComparisonReview(targetId:string):void {
    const containingClassifyId=findContainingClassification(targetId);
    if(containingClassifyId && containingClassifyId!==currentClassifyRelMsgId){
      if(currentClassifyRelMsgId)exitClassification({restoreSnapshot:false});
      enterClassification(containingClassifyId);
    }
    closeSettlement();
    setComparisonReviewBaseMessages(containingClassifyId?null:(isInsideClassify?normalGraphProjection.scopedMessages:normalGraphProjection.messages));
    setComparisonReviewBaseEdges(containingClassifyId?null:normalGraphProjection.edges);
    setLastClickedMessageId(targetId);
    setViewMode('graph');
    setTimeout(()=>scrollMsgToCenter(targetId),150);
  }
  function viewRelatedContainer(id:string):void {
    if(!['classify','summary','arrange','merge'].includes(msgMap.get(id)?.relationType??''))return;
    if(id===containerPreviewId)return;
    containerPreviewStack.current.push({
      id:containerPreviewId,snapshot:captureSnapshot(),filter:{...msgFilter},
      classifyId:classifyRelMsgId,classifyStack:[...classifyStackRef.current],
      traceEntries,expandedFrames:new Set(traceExpandedFrameIds),previewClassifyId,
      baseMessages:comparisonReviewBaseMessages,baseEdges:comparisonReviewBaseEdges,
    });
    prepareComparisonReview(id);
    setContainerPreviewId(id);
  }
  function exitContainerPreview():void {
    const previous=containerPreviewStack.current.pop();
    setContainerPreviewId(previous?.id??null);
    if(previous){
      setClassifyRelMsgId(previous.classifyId);
      classifyStackRef.current=[...previous.classifyStack];
      setTraceEntries(previous.traceEntries);
      setTraceExpandedFrameIds(new Set(previous.expandedFrames));
      setPreviewClassifyId(previous.previewClassifyId);
      setClassifyKey(key=>key+1);setTraceKey(key=>key+1);
      setComparisonReviewBaseMessages(previous.baseMessages);
      setComparisonReviewBaseEdges(previous.baseEdges);
      setMsgFilter(previous.filter);restoreSnapshot(previous.snapshot);
    }
  }



  function restoreSnapshot(s: TraceSnapshot | null, opts?: { restoreSelection?: boolean }): void {
    return runRestoreSnapshot({ scrollRequestIdRef, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setLastClickedMessageId, setTraceDistance, setViewMode, cancelScrollRafs, scrollRafRef, scrollRaf2Ref, clampAndSetScroll, leftPanelRef, rightPanelRef }, s, opts);
  }

  function startComparison(): void {
    comparisonOrigin.current = {
      snapshot: captureSnapshot(), filter: {...msgFilter},
      classifyId: classifyRelMsgId, classifyStack: [...classifyStackRef.current],
      traceEntries, expandedFrames: new Set(traceExpandedFrameIds),
      previewId: containerPreviewId,
    };
    setContainerPreviewId(null);
    setComparisonMode(true);
    setComparisonReviewed(false);
    setComparisonTargetId(null);
    setComparisonReviewBaseMessages(null);
    setComparisonReviewBaseEdges(null);
    setDraftUnits([]);
    setViewMode('list');
  }
  function restoreComparisonScope(): void {
    const origin = comparisonOrigin.current;
    if (!origin) return;
    setClassifyRelMsgId(origin.classifyId);
    classifyStackRef.current = [...origin.classifyStack];
    setTraceEntries(origin.traceEntries);
    setTraceExpandedFrameIds(new Set(origin.expandedFrames));
    setClassifyKey(key => key + 1);
    setTraceKey(key => key + 1);
  }
  function exitComparison(): void {
    const origin = comparisonOrigin.current;
    restoreComparisonScope();
    comparisonOrigin.current = null;
    setComparisonMode(false);
    setComparisonReviewed(false);
    setComparisonTargetId(null);
    setComparisonReviewBaseMessages(null);
    setComparisonReviewBaseEdges(null);
    if (origin) {
      setContainerPreviewId(origin.previewId);
      setMsgFilter(origin.filter);
      restoreSnapshot(origin.snapshot);
    }
  }

  function enterTemporaryCategory(force = false): void {
    return runEnterTemporaryCategory({ joinFilterTargetId, correctionFilterTargetId, comparisonMode, comparisonReviewed, temporaryCategoryStackRef, captureSnapshot, msgFilter, joinFilterDirection, comparisonTargetId, comparisonSide, comparisonReviewBaseMessages, comparisonReviewBaseEdges }, force);
  }

  function handleJoinRecords(messageId: string, direction: 'incoming' | 'outgoing'): void {
    if (joinFilterTargetId === messageId && joinFilterDirection === direction) { exitTemporaryCategory(); return; }
    enterTemporaryCategory(joinFilterTargetId === null && (comparisonMode || comparisonReviewed || correctionFilterTargetId !== null));
    setMsgFilter(previous => ({ ...previous, hideJoin: false }));
    setComparisonMode(false); setComparisonReviewed(false); setCorrectionFilterTargetId(null);
    setJoinFilterDirection(direction); setJoinFilterTargetId(messageId);
  }

  function exitTemporaryCategory(options?: { restoreMessageFilter?: boolean }): void {
    return runExitTemporaryCategory({ temporaryCategoryStackRef, setMsgFilter, setJoinFilterTargetId, setJoinFilterDirection, setCorrectionFilterTargetId, setComparisonMode, setComparisonReviewed, setComparisonTargetId, setComparisonSide, setComparisonReviewBaseMessages, setComparisonReviewBaseEdges, restoreSnapshot }, options);
  }

  function exitAllTemporaryCategories(options?: { restoreMessageFilter?: boolean }): void {
    return runExitAllTemporaryCategories({ temporaryCategoryStackRef, restoreSnapshot, setMsgFilter, setJoinFilterTargetId, setCorrectionFilterTargetId, setComparisonMode, setComparisonReviewed, setComparisonTargetId, setComparisonReviewBaseMessages, setComparisonReviewBaseEdges }, options);
  }

  useEffect(() => {
    const prepareViewer = () => {
      exitAllTemporaryCategories();
      setTraceEntries([]);
      setTraceKey(key => key + 1);
      if (classifyStackRef.current.length > 0 || classifyRelMsgId !== null) {
        classifyStackRef.current = [];
        setClassifyRelMsgId(null);
        setClassifyKey(key => key + 1);
        setPreviewClassifyId(null);
      }
    };
    window.addEventListener('prepare-export-viewer', prepareViewer);
    return () => window.removeEventListener('prepare-export-viewer', prepareViewer);
  }, [classifyRelMsgId]);

  function enterTrace(messageId: string, options?: { replace?: boolean; mode?: "trace" | "scope"; scopeRelationMessageId?: string }): void {
    return runEnterTrace({ captureSnapshot, classifyRelMsgId, classifyStackRef, setTraceExpandedFrameIds, setTraceEntries, setClassifyRelMsgId, setClassifyKey, cancelScrollRafs, scrollRequestIdRef, leftPanelRef }, messageId, options);
  }

  function enterTraceMultiple(messageIds: string[], options?: { replace?: boolean; mode?: "trace" | "scope"; scopeRelationMessageId?: string }): void {
    return runEnterTraceMultiple({ captureSnapshot, classifyRelMsgId, classifyStackRef, setTraceExpandedFrameIds, setTraceEntries, setClassifyRelMsgId, setClassifyKey, cancelScrollRafs, scrollRequestIdRef, leftPanelRef, setTraceKey }, messageIds, options);
  }

  function exitTrace(): void {
    return runExitTrace({ traceEntries, setTraceEntries, setTraceExpandedFrameIds, setTraceKey, classifyStackRef, setClassifyRelMsgId, setClassifyKey, restoreSnapshot });
  }

  function exitAllTrace(): void {
    return runExitAllTrace({ traceEntries, setTraceEntries, setTraceExpandedFrameIds, setTraceKey, classifyStackRef, setClassifyRelMsgId, setClassifyKey, restoreSnapshot });
  }

  function clearDraftAll(): void {
    return runClearDraftAll({ setDraftUnits, setActiveTextSelectId });
  }

  const isFragmentSelected = useCallback((messageId: string, start: number, len: number, text: string) => {
    const u: UnitSelection = { messageId, selection: { kind: "text", start, len, text } };
    u.reference = unitSelectionToReference(u, msgMap);
    return draftUnits.some(x => unitEquals(x, u));
  }, [draftUnits, msgMap]);

  function toggleFragmentSelection(messageId: string, start: number, len: number, text: string): void {
    return runToggleFragmentSelection({ msgMap, setDraftUnits, sourceUnits, setSendError }, messageId, start, len, text);
  }

  /**
  * When inside a CLASSIFY / SUMMARY scope view, register a newly created
   * message or relation as a target of the parent CLASSIFY/SUMMARY so it
   * stays scoped inside the scope after exit.
   *
   * @param newTargetRef  The new target to append (message or relation).
   * @param onUpdated     Optional callback invoked after the superseding
   *                      relation replaces the old one in state. Receives
   *                      the new relation ID.
   */
  async function registerCreatedRelationInCurrentClassify(backendRel: Relation): Promise<string | null> {
    return runRegisterCreatedRelationInCurrentClassify({ appendCreatedRelation }, backendRel);
  }

  async function attachMessageToCurrentClassify(messageId: string): Promise<void> {
    return runAttachMessageToCurrentClassify({ isInsideClassify, currentClassifyRelMsgId, relationsRef, createJoinRelationsForContainer }, messageId);
  }

  async function handleSendMessageOnly(overrideContent?: string): Promise<DemoMessage | null> {
    return runHandleSendMessageOnly({ requireAuth, newMessageContent, scopeMessageId, stakeAmount, setSendError, selectedRelationRef, recommendationRef, stakeFeeAmountRef, isInsideClassify, availablePoints, currentClassifyRelMsgId, setMessages, mergeStakeSnapshot, setAuthorStakes, setStakeAmount, minSelfStake, setNewMessageContent, scrollMsgToCenter, setClassifyKey, handleAuthError,
      onCreated: messageId => { if (sendInFlightRef.current) recordSentMessage(messageId); else scrollMsgToCenter(messageId); },
    }, overrideContent);
  }

  function handleMessageMouseDown(e: React.MouseEvent, messageId: string): void {
    return runHandleMessageMouseDown({ mouseDownRef }, e, messageId);
  }

  function undoRecentClickActionsForMessage(messageId: string): void {
    return runUndoRecentClickActionsForMessage({ lastClickActionsRef, setDraftUnits }, messageId);
  }

  function handleMessageMouseUp(e: React.MouseEvent, messageId: string): void {
    return runHandleMessageMouseUp({ mouseDownRef, lastDragOrSelectTimeRef, undoRecentClickActionsForMessage }, e, messageId);
  }

  function handleMessageClick(e: React.MouseEvent, messageId: string): void {
    return runHandleMessageClick({ lastDragOrSelectTimeRef, comparisonMode, setComparisonTargetId, setComparisonReviewed, setComparisonReviewBaseMessages, setComparisonReviewBaseEdges, setComparisonSide, setLastClickedMessageId, setDraftUnits, sourceUnits, setSendError, lastClickActionsRef }, e, messageId);
  }

  function handleMessageDoubleClick(e: React.MouseEvent, messageId: string): void {
    return runHandleMessageDoubleClick({ undoRecentClickActionsForMessage, msgMap, setLastClickedMessageId, activeTextSelectId, viewMode, setComparisonPopup, edges, enterTemporaryCategory, setJoinFilterTargetId, setCorrectionFilterTargetId, setViewMode, traceFrameIds, setTraceExpandedFrameIds, setTraceKey, relationType, setActiveTextSelectId, enterClassification, rejectedContainerIds:containerPreview?.rejectedContainerIds??rejectedContainerIds, setPreviewClassifyId, setStanceHighlight, stanceHighlightTimerRef, relations, settlementOpenMsgId, closeSettlement, openSettlement, lastAddedFragmentRef, setDraftUnits }, e, messageId);
  }

  function handleTextMouseUp(e: React.MouseEvent, messageId: string): void {
    return runHandleTextMouseUp({ msgMap, activeTextSelectId, setActiveTextSelectId, setDraftUnits, sourceUnits, setSendError, lastAddedFragmentRef, lastDragOrSelectTimeRef, undoRecentClickActionsForMessage }, e, messageId);
  }

  function handleFragmentAnchorClick(messageId: string, start: number, len: number, text: string): void {
    return runHandleFragmentAnchorClick({ setActiveTextSelectId, toggleFragmentSelection, setLastClickedMessageId, undoRecentClickActionsForMessage }, messageId, start, len, text);
  }

  function commitDraftTo(role: "source" | "target"): void {
    return runCommitDraftTo({ draftUnits, targetUnits, sourceUnits, setSendError, setSourceUnits, setTargetUnits, setDraftUnits, setActiveTextSelectId }, role);
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
    return runGetGroupedTargetTextMessageIds({ msgMap, relationTypeByRelMsgId, relationById }, units);
  }

  function promoteCompleteContainerSelections(units: UnitSelection[]): UnitSelection[] {
    return runPromoteCompleteContainerSelections({ relations }, units);
  }

  function resolveEffectiveTargetUnits(draft: UnitSelection[], targets: UnitSelection[], currentRelationType: string | null): UnitSelection[] {
    return runResolveEffectiveTargetUnits({ msgMap, promoteCompleteContainerSelections }, draft, targets, currentRelationType);
  }

  function getClassifyTargetRefs(units: UnitSelection[]): TargetRef[] {
    return runGetClassifyTargetRefs({ msgMap, organizationTargetRef, relationTypeByRelMsgId }, units);
  }

  function organizationTargetRef(unit: UnitSelection): TargetRef {
    return runOrganizationTargetRef({ msgMap }, unit);
  }

  function getContainerMembershipTargetError(units: UnitSelection[]): string | null {
    return runGetContainerMembershipTargetError({ relations }, units);
  }

  function getContainerCycleError(units: UnitSelection[]): string | null {
    return runGetContainerCycleError({ currentClassifyRelMsgId, latestClassifyRelMsgIdRef, relationById, relations }, units);
  }

  function getJoinContainerCycleError(sourceContainerId: string, targetIds: string[]): string | null {
    return runGetJoinContainerCycleError({ relationById, relations }, sourceContainerId, targetIds);
  }

  function getDependentDisplayTargets(units: UnitSelection[]): { messageId: string; dependencyId: string; }[] {
    return runGetDependentDisplayTargets({ relationById }, units);
  }

  function getDependentDisplayTarget(messageId: string): { messageId: string; dependencyId: string; } | null {
    return runGetDependentDisplayTarget({ getDependentDisplayTargets }, messageId);
  }

  /**
   * Check whether any selected text messages have non-reference edges to
   * text messages that are NOT part of the current selection.
   */
  function hasCrossNonReferenceTextLinkForClassifyTargets(targetTextIds: string[], selectionUnits: UnitSelection[] = effectiveTargetUnits): string | null {
    return runHasCrossNonReferenceTextLinkForClassifyTargets({ effectiveTargetUnits, msgMap, relationTypeByRelMsgId, relationById, relations, edges }, targetTextIds, selectionUnits);
  }

  function enterClassification(relMsgId: string): void {
    if (viewMode === 'graph') beginWorkbenchDrawing();
    return runEnterClassification({ captureSnapshot, cancelScrollRafs, scrollRequestIdRef, leftPanelRef, classifyStackRef, setClassifyRelMsgId, setClassifyKey }, relMsgId);
  }
  function findContainingClassification(messageId: string): string | null {
    return runFindContainingClassification({ relationById, relations, rejectedContainerIds, rejectedJoinRelationIds }, messageId);
  }

  function exitClassification(_options?: { restoreSnapshot?: boolean; clearSelectionOnRootExit?: boolean; preserveViewMode?: ViewMode }): void {
    if (viewMode === 'graph') beginWorkbenchDrawing();
    return runExitClassification({ classifyStackRef, setClassifyRelMsgId, setClassifyKey, setPreviewClassifyId, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setLastClickedMessageId, restoreSnapshot, setViewMode }, _options);
  }

  function handleExitClassification(): void {
    return runHandleExitClassification({ draftUnits, lastClickedMessageId, exitClassification, viewMode, scrollMsgToCenter });
  }

  function handleEdgeLabelSingleClick(e: React.MouseEvent, relationMessageId: string) {
    e.stopPropagation();
    setLastClickedMessageId(relationMessageId);
    toggleWholeUnit(relationMessageId);
  }

  function handleEdgeLabelDoubleClick(e: React.MouseEvent, relationMessageId: string) {
    e.stopPropagation();
    setLastClickedMessageId(relationMessageId);
    toggleWholeUnit(relationMessageId);
  }

  /**
   * Create a single TAG relation for `targetMid` with the given label, register the
   * new relation message in state, and return a DemoEdge for the caller to append.
   * Returns null if the API call fails (error is shown via alert).
   */
  async function sendTagRelation(target: UnitSelection, tagLabel: string, subType?: string, customLabel?: string): Promise<DemoEdge | null> {
    return runSendTagRelation({ scopeMessageId, msgMap, secondaryRelationType, newMessageContent, createRel, registerCreatedRelationInCurrentClassify, showAlert }, target, tagLabel, subType, customLabel);
  }

  async function handleCreateRelationWithSourcesAndTargets(params: {
    sources: UnitSelection[]; targets: UnitSelection[]; label: string;
  }): Promise<void> {
    return runHandleCreateRelationWithSourcesAndTargets({ requireAuth, scopeMessageId, relationType, msgMap, newMessageContent, createRel, registerCreatedRelationInCurrentClassify, showAlert, secondaryRelationType, additionalAgreeTargetIds, subType, sendTagRelation, subTypeCustomLabel, setEdges }, params);
  }

  /**
   * Create "join" relations for each target of a container.
   * A join relation is: sourceMessageId=container, targetRefs=[target].
   * This enables resolveMessageCanvas / getActiveJoinRelationsForMessage
   * to find which container a message belongs to (bottom-up lookup).
   */
  async function createJoinRelationsForContainer(containerId: string, _containerType: string, targetMids: Array<string | TargetRef>): Promise<boolean> {
    return runCreateJoinRelationsForContainer({ getDependentDisplayTarget, setSendError, msgMap, containerRelationTypes, relationsRef, createRel, scopeMessageId, appendCreatedRelation }, containerId, _containerType, targetMids);
  }

  async function handleQuickSendAndRelateFromDraftTargets(): Promise<void> {
    return runHandleQuickSendAndRelateFromDraftTargets({ requireAuth, singleButtonEnabled, newMessageContent, savedTextOnTypeSwitchRef, draftUnits, targetUnits, setSendError, sourceUnits, resolveEffectiveTargetUnits, relationType, hasTextContent, stakeAmount, containerRelationTypes, appendContainerType, relStakeAmount, effectiveMinStake, subType, subTypeStakeMap, relationStakeMap, totalConsumption, availablePoints, handleSendMessageOnly, guideTargetIdRef, setNewMessageContent, getContainerMembershipTargetError, joinOnlyAction, getContainerCycleError, showAlert, relationsRef, getJoinContainerCycleError, createJoinRelationsForContainer, setEdges, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setSubType, setRelationType, setSecondaryRelationType, relationLabel, handleCreateRelationWithSourcesAndTargets, secondaryRelationType, msgMap, createRel, scopeMessageId, registerCreatedRelationInCurrentClassify, edgesRef, sendTagRelation, subTypeCustomBufferRef, setSubTypeCustomLabel, setComparisonPopup, correctionVersions, blockCorrectionForSecondBettor, edges, relationById, organizationTargetRef, getGroupedTargetTextMessageIds, relationTypeByRelMsgId, hasCrossNonReferenceTextLinkForClassifyTargets, getClassifyTargetRefs, isInsideClassify, currentClassifyRelMsgId, classifyStackRef, appendCreatedRelation, setTraceKey, isGovernanceOrOpsType, relations, setRelations, hasTargetsAvailable, user, setMessages, relStakeRef, setAuthorStakes, mergeStakeSnapshot });
  }

  async function handleSendClick(): Promise<void> {
    if (sendInFlightRef.current) return;
    sentMessageTargetsRef.current = [];
    return runHandleSendClick({ sendInFlightRef, draftUnits, sourceUnits, targetUnits, activeTextSelectId, newMessageContent, relationType, secondaryRelationType, subType, subTypeCustomLabel, relationLabel, stakeAmount, relStakeAmount, recommendationAmount, messages, edges, relations, authorStakes, stakeCounts, savedTextOnTypeSwitchRef, subTypeCustomBufferRef, savedTextBeforeDelegationRef, delegationContentBufferRef, setSendInFlight, handleQuickSendAndRelateFromDraftTargets, setRecommendationAmount, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setNewMessageContent, setRelationType, setSecondaryRelationType, setSubType, setRelationLabel, setSubTypeCustomLabel, setStakeAmount, setRelStakeAmount, setMessages, setEdges, setRelations, messagesRef, edgesRef, relationsRef, setAuthorStakes, setStakeCounts, setSendError,
      onCommitted: () => {
        const committedTargets = [...sentMessageTargetsRef.current];
        if (committedTargets.length > 0) setAwaitingSendOverlay(true);
        setSentMessageTargets(queue => [...queue, ...committedTargets.filter(id => !queue.includes(id))]);
      },
    });
  }


  const draftGroups: DraftGroup[] = useMemo(() => groupDraftSelections(draftUnits), [draftUnits]);

  const prevDraftCountRef = useRef<number>(draftUnits.length);
  useEffect(() => {
    const prev = prevDraftCountRef.current; const cur = draftUnits.length;
    if (prev > 0 && cur === 0 && activeTextSelectId !== null) setActiveTextSelectId(null);
    prevDraftCountRef.current = cur;
  }, [draftUnits, activeTextSelectId]);

  // Scroll to center the traced message when entering trace mode.
  useEffect(() => {
    const newLen = traceEntries.length;
    if (newLen <= prevTraceLenRef.current) { prevTraceLenRef.current = newLen; return; }
    prevTraceLenRef.current = newLen;
    if (viewMode !== "graph") return;
    const entry = traceEntries[newLen - 1];
    if (!entry || entry.ids.length === 0) return;
    const traceId = entry.ids[0];
    cancelScrollRafs();
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRaf2Ref.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        scrollRaf2Ref.current = null;
        const container = leftPanelRef.current;
        if (!container) return;
        const el = container.querySelector(`[data-msgid="${traceId}"]`) as HTMLElement | null;
        if (!el) return;
        const elRect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const elCenterX = elRect.left - containerRect.left + container.scrollLeft + elRect.width / 2;
        const elCenterY = elRect.top - containerRect.top + container.scrollTop + elRect.height / 2;
        container.scrollLeft = Math.max(0, Math.min(elCenterX - container.clientWidth / 2, container.scrollWidth - container.clientWidth));
        container.scrollTop = Math.max(0, Math.min(elCenterY - container.clientHeight / 2, container.scrollHeight - container.clientHeight));
      });
    });
  }, [traceEntries, viewMode]);

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
    return runGetSelectedWholeMessageIds({ draftUnits });
  }

  const recentRelations = useMemo(() => messages.filter(m => m.kind === "relation").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5), [messages]);
  const recentNormals = useMemo(() => messages.filter(m => isContentKind(m.kind)).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 8), [messages]);

  const isAgreeDisagreeType = relationType === "agree" || relationType === "disagree";
  const isArrangeType = relationType === "arrange";
  const isNotifyType = relationType === "notify";

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
  const draftHasRelationTarget = draftUnits.some(u => msgMap.get(u.messageId)?.kind === 'relation' && !msgMap.get(u.messageId)?.parts);
  const hasTargetsAvailable = draftUnits.length > 0 || targetUnits.length > 0;
  const effectiveTargetUnits = useMemo(
    () => resolveEffectiveTargetUnits(draftUnits, targetUnits, relationType),
    [draftUnits, targetUnits, relationType, relations],
  );
  const processedTargetUnits = effectiveTargetUnits;
  const hasCorrectionRelationTarget = relationType === 'correct'
    && effectiveTargetUnits.some(unit => msgMap.get(unit.messageId)?.kind === 'relation' && !msgMap.get(unit.messageId)?.parts);
  const hasInvalidCorrectTarget = relationType === 'correct' && !hasCorrectionRelationTarget && (
    sourceUnits.length > 0
    || effectiveTargetUnits.length !== 1
    || (!msgMap.get(effectiveTargetUnits[0]?.messageId)?.parts && (
      effectiveTargetUnits[0]?.selection.kind !== 'text'
      || !isCorrectableCorrectionTarget(msgMap.get(effectiveTargetUnits[0]?.messageId))
    ))
  );
  const hasInvalidContainerSource = relationType !== null
    && containerRelationTypes.has(relationType.toUpperCase())
    && sourceUnits.length > 0
    && !appendContainerType;
  const dependentDisplayTargets = (containerRelationTypes.has(relationType?.toUpperCase() ?? '') || joinOnlyAction)
    ? getDependentDisplayTargets(effectiveTargetUnits)
    : [];
  const hasInvalidJoinTarget = dependentDisplayTargets.length > 0;
  const invalidJoinTargetMessage = dependentDisplayTargets.length > 0
    ? `消息 ${dependentDisplayTargets[0].messageId} 依赖消息 ${dependentDisplayTargets[0].dependencyId} 显示，不能作为容器目标`
    : null;
  const targetTextIdsForValidation = joinOnlyAction
    ? processedTargetUnits
      .filter(unit => isContentKind(msgMap.get(unit.messageId)?.kind ?? 'normal'))
      .map(unit => unit.messageId)
    : getGroupedTargetTextMessageIds(processedTargetUnits);
  const crossLinkValidationMessage = (isClassifyType || isSummaryType || isMergeType || joinOnlyAction)
    && hasTargetsAvailable
    && hasCrossNonReferenceTextLinkForClassifyTargets(targetTextIdsForValidation, processedTargetUnits);
  const hasCrossLinkValidationError = Boolean(crossLinkValidationMessage);
  const hasOrphanContainerLabel = (isSummaryType || isMergeType)
    && effectiveTargetUnits.some(unit => {
      const targetMessage = msgMap.get(unit.messageId);
      const isContentRelation = targetMessage?.kind === 'relation'
        && ['delegation', 'proposal', 'code_change', 'operations'].includes(targetMessage.relationType ?? '');
      if (targetMessage && (isContentKind(targetMessage.kind) || isContentRelation)) return false;
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
    const amountText = readField(['报酬数量', '数量']);
    const ratioText = readField(['报酬比例', '比例']);
    const description = readField([isFulfill ? '完成说明' : '委托内容']);
    const amount = amountText ? Number(amountText) : undefined;
    const ratio = ratioText ? Number(ratioText.replace(/%$/, '')) : undefined;
    const validReward = isFulfill
      ? amount === undefined && ratio === undefined
      : amount !== undefined && Number.isInteger(amount) && amount > 0 && ratio === undefined;
    const selectedTargets = effectiveTargetUnits.filter(target => msgMap.get(target.messageId)?.kind === 'relation');
    const targetRelation = selectedTargets.length === 1
      ? relations.find(rel => rel.id === selectedTargets[0].messageId)
      : undefined;
    const isCreateDelegation = targetRelation?.payload?.delegationKind === 'CREATE';
    return !content || !description || !validReward || (isFulfill
      && (effectiveTargetUnits.length !== 1 || !targetRelation || targetRelation.relationType.toUpperCase() !== 'DELEGATION' || !isCreateDelegation));
  })();
  const hasInvalidProposalFormat = relationType === 'proposal' && (() => {
    const content = newMessageContent.trim();
    const read = (labels: string[]): string | undefined => labels
      .map(label => content.match(new RegExp(`${label}\\s*[=:：]\\s*([^\\n;；]+)`, 'i'))?.[1]?.trim())
      .find(Boolean);
    if (secondaryRelationType === '充值分账') {
      const amount = Number(read(['充值总额', '总额', 'amount']));
      const share = Number(read(['收入池分成', '分成', 'revenuePoolShare']));
      return !Number.isInteger(amount) || amount <= 0 || !Number.isInteger(share) || share < 0 || share > amount || !read(['指定与会者', 'recipientUserId']);
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
  const singleButtonEnabled = deriveSingleButtonEnabled({ relationType, newMessageContent, hasTextContent, stakeAmount, joinOnlyAction, relStakeAmount, effectiveMinStake, totalConsumption, availablePoints, draftUnits, targetUnits, hasInvalidCorrectTarget, hasInvalidContainerSource, hasInvalidJoinTarget, hasCrossLinkValidationError, hasOrphanContainerLabel, hasClassifyCycle, hasInvalidDelegationFormat, hasInvalidProposalFormat, hasCorrectionRelationTarget, isClassifyType, sourceUnits, relations, hasTargetsAvailable, isSummaryType, isMergeType, secondaryRelationType, effectiveTargetUnits, isGovernanceOrOpsType, msgMap, isTagWithInlineBadge, subType, isTagWithQuickAnnotate, isAgreeDisagreeType, isArrangeType, isNotifyType, hasAttentionNotifyTarget });

  // Dynamic label describing what the send button will do
  const singleButtonLabel = deriveSingleButtonLabel({ relationType, newMessageContent, draftUnits, isClassifyType, sourceUnits, relations, getClassifyTargetRefs, targetUnits, joinOnlyAction, hasTargetsAvailable, isSummaryType, isMergeType, hasCorrectionRelationTarget, hasInvalidCorrectTarget, hasTextContent, isNotifyType, hasAttentionNotifyTarget, isGovernanceOrOpsType, secondaryRelationType, msgMap, isAgreeDisagreeType, isArrangeType, isTagWithInlineBadge, subType, isTagWithQuickAnnotate });

  const sendValidationLabel = deriveSendValidationLabel({ singleButtonEnabled, relationType, hasTextContent, draftUnits, targetUnits, stakeAmount, joinOnlyAction, relStakeAmount, effectiveMinStake, totalConsumption, availablePoints, hasCorrectionRelationTarget, hasInvalidCorrectTarget, hasInvalidContainerSource, hasInvalidJoinTarget, invalidJoinTargetMessage, hasCrossLinkValidationError, crossLinkValidationMessage, hasOrphanContainerLabel, hasClassifyCycle, hasInvalidDelegationFormat, secondaryRelationType, hasInvalidProposalFormat, hasTargetsAvailable, isClassifyType, isGovernanceOrOpsType, isAgreeDisagreeType, isArrangeType, isMergeType, isTagWithQuickAnnotate, isTagWithInlineBadge });

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
        if (e.relationType === 'tag' && isWholeMessageSelection(e.to, mid)) {
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

  function renderMessageContentWithAnchorsForList(message: DemoMessage): React.JSX.Element {
    return runRenderMessageContentWithAnchorsForList({ edges, isFragmentSelected, handleFragmentAnchorClick }, message);
  }

  function renderRelationContentWithTargets(message: DemoMessage): React.JSX.Element {
    return runRenderRelationContentWithTargets({ handleNavigateToMessage }, message);
  }

  const { messagesToShow, edgesToShow, traceExpandableContainerIds } = useMemo(() => deriveMessagesToShow({ traceEntries, messages, edges:containerEffect.traceEdges, traceContainerMemberships, effectiveSuppressedRelIdsForLayout, traceDistance, traceExpandedFrameIds }), [containerEffect, messages, edges, traceContainerMemberships, effectiveSuppressedRelIdsForLayout, traceEntries, traceDistance, msgMap, traceExpandedFrameIds]);

  const canSetTrace = (!!lastClickedMessageId && messages.some(m => m.id === lastClickedMessageId)) || getSelectedWholeMessageIds().length > 0;
  const canExitTrace = traceEntries.length > 0;

  // Track latest classify ID across async supersede calls so sequential
  // addTargetToClassification calls always target the current classify.
  const latestClassifyRelMsgIdRef = useRef<string | null>(null);
  useEffect(() => { latestClassifyRelMsgIdRef.current = currentClassifyRelMsgId; }, [currentClassifyRelMsgId]);

  // Set of relation-message IDs directly in the current trace set.
  // Used to keep their edges visible regardless of endpoint checks.
  const traceRelationMsgIds = useMemo(() => {
    if (traceEntries.length === 0) return new Set<string>();
    const ids = new Set<string>();
    for (const id of traceEntries[traceEntries.length - 1].ids) {
      if (msgMap.get(id)?.kind === 'relation') ids.add(id);
    }
    return ids;
  }, [traceEntries, msgMap]);
  const traceFrameIds = useMemo(() => deriveTraceFrameIds({ traceRelationMsgIds, traceEntries, edges:containerEffect.traceEdges, traceContainerMemberships, traceExpandableContainerIds, msgMap }), [containerEffect, traceRelationMsgIds, traceEntries, edges, msgMap, traceExpandableContainerIds]);
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
  const classificationTitle = currentClassifyRelMsg
    ? (getRelationTitle(currentClassifyRelMsg.relationPayload) || `${classifyKindLabel}（${classifyTargetCount}）`)
    : "";
  const isTemporaryJoinCategory = joinFilterTargetId !== null;
  const temporaryJoinCount = joinFilterTargetId
    ? (joinFilterDirection === 'outgoing'
      ? (joinRelationsBySource.get(joinFilterTargetId)?.length ?? 0)
      : (joinRelationsByTarget.get(joinFilterTargetId)?.length ?? 0))
    : 0;

  const { graphMessagesToRender, graphEdgesToRender, listMessagesToRender, listEdgesToRender, hideMessageIds } = useMemo(() => deriveGraphMessagesToRender({ containerOwnership:containerEffect.ownership,traceEntries, messagesToShow, messages, edgesToShow, edges:traceEntries.length > 0 ? containerEffect.traceEdges : edges, traceContainerMemberships, effectiveSuppressedRelIdsForLayout, traceDistance, traceExpandedFrameIds, isInsideClassify, currentClassifyRelMsgId, relationById, relations, rejectedContainerIds, rejectedJoinRelationIds, msgMap, activeClassifyOwnership, classifiedTargetSummaryRelMsgIds, listExclusiveRelMsgIds, replacedRelationMsgIds, classifiedTargetTextIds, graphOwnedRelationIds, traceRelationMsgIds, classifiedTargetClassifyRelMsgIds, classifiedTargetMergeRelMsgIds, classifiedTargetARRANGERelMsgIds, activeSummaryOwnership, graphExclusiveRelMsgIds, graphHiddenTextIds }), [containerEffect,messages, edges, traceContainerMemberships, relationById, relations, messagesToShow, edgesToShow, traceEntries, isInsideClassify, currentClassifyRelMsgId, msgMap, classifiedTargetTextIds, classifiedTargetClassifyRelMsgIds, classifiedTargetMergeRelMsgIds, classifiedTargetARRANGERelMsgIds, classifiedTargetSummaryRelMsgIds, listExclusiveRelMsgIds, replacedRelationMsgIds, activeClassifyOwnership, classifyOwnership, summaryOwnership, graphExclusiveRelMsgIds, graphHiddenTextIds, traceRelationMsgIds, traceExpandedFrameIds, rejectedContainerIds, rejectedJoinRelationIds]);

  const normalGraphProjection = useMemo(() => deriveNormalGraphProjection({ graphMessagesToRender, correctionVersions, cleanVisibleIds, homeFilterResult, msgFilter, edges, messages, displayUser, graphEdgesToRender, relations, effectiveJoinRelationIds }), [messages, graphMessagesToRender, graphEdgesToRender, correctionVersions, cleanVisibleIds, homeFilterResult, msgFilter, edges, displayUser?.username, relations, effectiveJoinRelationIds]);

  // Use the rendered scope, including effective JOINs and expanded frames.
  const crossClassifyRefs = useMemo(() => {
    const scene = projectGraphScene({ ...normalGraphProjection, traceExpandedFrameIds,
      isTraceWindow: traceEntries.length > 0, rejectedContainerIds, hiddenMessageIds: hideMessageIds });
    return deriveCrossClassifyRefs({ edges: edges.filter(edge => !containerEffect.suppressed.has(edge.relationMessageId)),
      msgMap, graphVisibleTextIds: new Set(scene.normalIds) });
  }, [normalGraphProjection, traceExpandedFrameIds, traceEntries, rejectedContainerIds, hideMessageIds, edges, containerEffect.suppressed, msgMap]);

  const comparisonInput = useMemo<DeriveComparisonGraphProjectionsInput>(() => ({
    comparisonReviewed,comparisonTargetId,username:displayUser?.username??null,scopeId:currentClassifyRelMsgId,
    sourceEffect:containerEffect,messages,relations,edges,traceEntries,traceDistance,traceExpandedFrameIds,traceRelationMsgIds,traceContainerMemberships,
    collectExclusiveRelationMsgIds,replacedRelationMsgIds,comparisonReviewBaseMessages,comparisonReviewBaseEdges,isInsideClassify,normalGraphProjection,
    filterMessages:values=>applyMessageFilter(values.filter(message=>
      (!cleanVisibleIds||cleanVisibleIds.visibleTextIds.has(message.id)||cleanVisibleIds.visibleRelIds.has(message.id))
      &&(!homeFilterResult||homeFilterResult.displayIds.has(message.id))),msgFilter)
      .map(message=>{const correction=correctionVersions.get(message.id)?.current;return correction?withCorrectionContent(message,correction.content):message;}),
  }),[containerEffect,comparisonReviewed,comparisonTargetId,currentClassifyRelMsgId,displayUser?.username,messages,relations,edges,traceEntries,traceDistance,traceExpandedFrameIds,traceRelationMsgIds,traceContainerMemberships,replacedRelationMsgIds,comparisonReviewBaseMessages,comparisonReviewBaseEdges,isInsideClassify,normalGraphProjection,cleanVisibleIds,homeFilterResult,msgFilter,correctionVersions]);
  const comparisonGraphProjections=useMemo(()=>deriveComparisonGraphProjections(comparisonInput),[comparisonInput]);
  const containerPreview=useMemo(()=>{
    if(!containerPreviewId || joinFilterTargetId !== null)return null;
    const projection=projectComparisonSide({...comparisonInput,comparisonReviewed:true,comparisonTargetId:containerPreviewId},'agree')!;
    const {effect}=projection;
    return {...projection,allMessages:effect.messages,relations:effect.relations,target:effect.msgMap.get(containerPreviewId)!,
      rejectedContainerIds:effect.rejectedContainerIds,effectiveJoinIds:effect.effectiveJoinIds};
  },[containerPreviewId,comparisonInput,joinFilterTargetId]);
  const comparisonAgreeSuppressedRelIds = comparisonGraphProjections?.agree.suppressed??effectiveSuppressedRelIdsForLayout;
  const comparisonDisagreeSuppressedRelIds = comparisonGraphProjections?.disagree.suppressed??effectiveSuppressedRelIdsForLayout;

  function handleCanvasBlankClick(): void {
    return runHandleCanvasBlankClick({ setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setLastClickedMessageId });
  }

  async function confirmReverseCorrection(): Promise<void> {
    return runConfirmReverseCorrection({ sendInFlightRef, comparisonPopup, scopeMessageId, setSendInFlight, createRel, msgMap, registerCreatedRelationInCurrentClassify, setEdges, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setNewMessageContent, setRelationType, setSecondaryRelationType, setRecommendationAmount, setComparisonPopup, showAlert,
      onCreated: messageId => {
        setAwaitingSendOverlay(true);
        setSentMessageTargets(queue => [...queue, messageId]);
      },
    });
  }

  async function handleDecorationIconClick(messageId: string, kind: "agree" | "disagree"): Promise<void> {
    if(isPreviewMode)return;
    return runHandleDecorationIconClick({ comparisonReviewed, scopeMessageId, msgMap, correctionVersions, showAlert, createRel, registerCreatedRelationInCurrentClassify }, messageId, kind);
  }

  async function handleComparisonVote(side: 'agree' | 'disagree' = 'agree'): Promise<void> {
    return runHandleComparisonVote({ isPreloaded, comparisonReviewed, requireAuth, comparisonTargetId, draftUnits, scopeMessageId, relStakeAmount, effectiveMinStake, setSendError, availablePoints, createRel, msgMap, registerCreatedRelationInCurrentClassify, showAlert }, side);
  }

  function handleDecorationBodyClick(e: React.MouseEvent, messageId: string, kind: "agree" | "disagree"): void {
    return runHandleDecorationBodyClick({ edges, homeFilterResult, setLastClickedMessageId, setDraftUnits }, e, messageId, kind);
  }

  function handleDecorationDoubleClick(e: React.MouseEvent, messageId: string, kind: "agree" | "disagree"): void {
    return runHandleDecorationDoubleClick({ edges, setStanceHighlight, stanceHighlightTimerRef, setDecorationPopup }, e, messageId, kind);
  }

  function handleTagBodyClick(e: React.MouseEvent, messageId: string, _tagLabel: string, relMsgIds: string[]): void {
    return runHandleTagBodyClick({ setLastClickedMessageId, setDraftUnits }, e, messageId, _tagLabel, relMsgIds);
  }

  function handleTagDoubleClick(e: React.MouseEvent, messageId: string, tagLabel: string, relMsgIds: string[]): void {
    return runHandleTagDoubleClick({ setTagPopup }, e, messageId, tagLabel, relMsgIds);
  }

  function handleGroupFrameClick(e: React.MouseEvent, relMsgId: string): void {
    return runHandleGroupFrameClick({ setLastClickedMessageId, toggleWholeUnit }, e, relMsgId);
  }

  function handleGroupFrameDoubleClick(e: React.MouseEvent, relMsgId: string): void {
    return runHandleGroupFrameDoubleClick({ setLastClickedMessageId, edges, relationTypeByRelMsgId, traceFrameIds, setTraceExpandedFrameIds, setTraceKey, enterClassification, setMergeInfoPopup, enterTrace }, e, relMsgId);
  }

  function handleInlineBadgeClick(e: React.MouseEvent, relMsgId: string): void {
    return runHandleInlineBadgeClick({ setLastClickedMessageId, toggleWholeUnit }, e, relMsgId);
  }

  // 跨分类引用标签点击：选中关系消息
  function handleCrossRefTagClick(e: React.MouseEvent, relMsgIds: string[]): void {
    return runHandleCrossRefTagClick({ setLastClickedMessageId, setDraftUnits }, e, relMsgIds);
  }

  /** Navigate to a message: switch canvas if needed, scroll, select (clear + add to candidates) */
  const handleNavigateToMessage = useCallback((messageId: string, options?: { select?: boolean; preserveScope?: boolean; onComplete?: ScrollMessageOptions['onComplete'] }) => {
    scrollRequestIdRef.current++;
    const wasTemporaryCategoryActive = temporaryCategoryStackRef.current.length > 0
      || joinFilterTargetId !== null;
    const targetMessage = messagesRef.current.find(message => message.id === messageId);
    const navigationFilterState = navigationVisibilityRef.current;
    const targetCleanFiltered = navigationFilterState.cleanMode
      && navigationFilterState.cleanVisibleIds
      && (targetMessage?.kind === 'relation'
        ? !navigationFilterState.cleanVisibleIds.visibleRelIds.has(messageId)
        : !navigationFilterState.cleanVisibleIds.visibleTextIds.has(messageId));
    const targetTypeFiltered = (navigationFilterState.msgFilter.hideJoin && targetMessage?.kind === 'join')
      || (navigationFilterState.msgFilter.hideSettlement
        && (targetMessage?.kind === 'round' || targetMessage?.kind === 'round_result'));
    const canAutoClearTargetFilters = Boolean(targetCleanFiltered || targetTypeFiltered);
    if (canAutoClearTargetFilters) {
      if (targetCleanFiltered) {
        clearCleanView();
      }
      if (targetTypeFiltered) {
        setMsgFilter(previous => ({
          ...previous,
          hideJoin: targetMessage?.kind === 'join' ? false : previous.hideJoin,
          hideSettlement: targetMessage?.kind === 'round' || targetMessage?.kind === 'round_result'
            ? false
            : previous.hideSettlement,
        }));
      }
    }
    if (!options?.preserveScope) {
      activeSentMessageRef.current = null;
      setAwaitingSendOverlay(false);
      setSentMessageTargets([]);
      if (wasTemporaryCategoryActive) {
        exitAllTemporaryCategories({ restoreMessageFilter: false });
        if (targetMessage?.kind === 'join') {
          setClassifyRelMsgId(null);
          setClassifyKey(k => k + 1);
        }
      } else {
        setJoinFilterTargetId(null);
      }
      setTraceEntries([]);
      setTraceKey(k => k + 1);
      // Explicit navigation chooses the target's scope through the ownership effect.
      classifyStackRef.current = [];
      setClassifyRelMsgId(null);
      setClassifyKey(k => k + 1);
      setPreviewClassifyId(null);
      setAutoClassifyMsgId(messageId);
    } else if (hiddenInGraphView.has(messageId)) {
      // Sending locates the result within the current scope and keeps its history.
      setViewMode('list');
    }
    // Keep the current send overlay until the next one can replace it.
    if (!options?.preserveScope) setMessagePulse(null);
    // Clear candidates and select the target message as whole
    if (options?.select !== false) setDraftUnits([{ messageId, selection: { kind: 'whole' as const } }]);
    setSourceUnits([]);
    setTargetUnits([]);
    setLastClickedMessageId(messageId);
    // Scroll after canvas switch; bump scrollKey so the scroll effect re-triggers even
    // when the target is already on the current canvas (no classifyKey change).
    pendingScrollDependencyIdsRef.current = [];
    pendingScrollMsgRef.current = messageId;
    pendingScrollCompletionRef.current = options?.onComplete;
    setScrollKey(k => k + 1);
  }, [cleanMode, joinFilterTargetId, msgFilter, clearCleanView, showAlert, hiddenInGraphView]);

  function confirmMessageIdNavigation(): void {
    return runConfirmMessageIdNavigation({ messageIdInput, showAlert, messagesRef, handleNavigateToMessage, setAutoClassifyMsgId });
  }

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

  function handleInlineBadgeDoubleClick(e: React.MouseEvent, relMsgId: string, detail?: { relMsgIds?: string[]; subDetails?: Array<{ subType: string; customLabel?: string; count: number }> }): void {
    return runHandleInlineBadgeDoubleClick({ edges, setTagPopup, enterTemporaryCategory, setJoinFilterTargetId, setCorrectionFilterTargetId, setViewMode, setComparisonPopup }, e, relMsgId, detail);
  }

  function toggleWholeUnit(msgId: string): void {
    return runToggleWholeUnit({ setDraftUnits }, msgId);
  }

  if (!authLoading && !preloadedData && !user) return null;
  if (loading) {
    return null;
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
    return correction ? withCorrectionContent(message, correction.content) : message;
  });
  // Phase 6: Apply clean mode filter (multi-dimensional rules via useCleanView)
  const messagesToRenderClean = cleanVisibleIds
    ? messagesWithCorrections.filter(m =>
      cleanVisibleIds.visibleTextIds.has(m.id) || cleanVisibleIds.visibleRelIds.has(m.id))
    : messagesWithCorrections;
  const homeFilteredMessages = homeFilterResult
    ? messagesToRenderClean.filter(message => homeFilterResult.displayIds.has(message.id))
    : messagesToRenderClean;
  // Message type filter: hide settlement/join messages
  const typeFilteredMessages = applyMessageFilter(homeFilteredMessages, msgFilter);
  const temporaryJoinViewIds = joinFilterTargetId
    ? new Set((joinFilterDirection === 'outgoing'
      ? (joinRelationsBySource.get(joinFilterTargetId) ?? [])
      : (joinRelationsByTarget.get(joinFilterTargetId) ?? [])
    ).map(join => join.id))
    : null;
  // The chooser includes owned and suppressed relations, not just cards on
  // the current canvas. Reviewing a target opens its containing scope.
  const comparisonViewIds = comparisonMode
    ? new Set(comparisonTargets.map(message => message.id))
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

  const projectionEdgesToRender = [
    ...(viewMode === "list" ? listEdgesToRender : graphEdgesToRender),
    ...(viewMode !== "list"
      ? (traceEntries.length > 0 ? graphEdgesToRender : edges).filter(edge =>
        getPresentationSpec(edge.relationType).isContainer &&
        (traceRelationMsgIds.has(edge.relationMessageId) ||
          graphMessagesToRender.some(message => message.id === edge.relationMessageId))
      )
      : []),
  ];
  const declaredEdgesToRender = filterContainerEdgesByEffectiveJoins(
    projectionEdgesToRender,
    relations,
    effectiveJoinRelationIds,
  ).filter((edge, index, all) => all.findIndex(candidate => candidate.id === edge.id) === index);
  const visibleContainerIds=new Set(messagesToRenderFiltered.map(message=>message.id));
  const rawEdgesToRender=projectJoinMembershipEdges(declaredEdgesToRender,relations,effectiveJoinRelationIds,visibleContainerIds);
  // Phase 6: Also filter edges through clean view
  const rawEdgesToRenderClean = cleanVisibleIds
    ? rawEdgesToRender.filter(e => cleanVisibleIds.visibleRelIds.has(e.relationMessageId)||(getPresentationSpec(e.relationType).isContainer&&visibleContainerIds.has(e.relationMessageId)))
    : rawEdgesToRender;
  const homeEdgesToRender = homeFilterResult
    ? rawEdgesToRenderClean.filter(edge =>
      homeFilterResult.displayIds.has(edge.relationMessageId)
      && (edge.from.messageId.startsWith('anon:')
        || homeFilterResult.displayIds.has(edge.from.messageId)
        || homeFilterResult.matchIds.has(edge.to.messageId))
      && homeFilterResult.displayIds.has(edge.to.messageId),
    )
    : rawEdgesToRenderClean;
  // Filter edges based on current user's DISAGREE stances on relation messages.
  // When the user disagrees with a relation message, all edges produced by that
  // relation are suppressed from this user's view (per-user branch semantics).
  const temporaryEdgesToRender = comparisonViewIds
    ? homeEdgesToRender
    : correctionTemporaryViewIds
      ? homeEdgesToRender.filter(edge => correctionTemporaryViewIds.has(edge.relationMessageId))
      : temporaryJoinViewIds
        ? homeEdgesToRender.filter(edge => temporaryJoinViewIds.has(edge.relationMessageId))
        : homeEdgesToRender;
  // A user's DISAGREE relation may be outside the current classify scope.
  // Use all scope edges to determine suppression, then filter only the edges
  // currently being rendered.
  const effectiveSuppressedRelIds = computeEffectiveSuppressedRelIds(edges, messages, displayUser?.username ?? null);
  const globallySuppressedRelIds = computeGloballySuppressedRelIds(edges, messages);
  const comparisonSuppressedRelIds = comparisonReviewed && comparisonTargetId
    ? comparisonSide === 'agree' ? comparisonAgreeSuppressedRelIds : comparisonDisagreeSuppressedRelIds
    : effectiveSuppressedRelIds;
  const filteredEdgesToRender = temporaryEdgesToRender.filter(edge =>
    edge.relationType === 'correct' || !comparisonSuppressedRelIds.has(edge.relationMessageId),
  );
  // The linear list keeps the annotation and its DISAGREE relation so the
  // user's stance can be shown on the source message. The non-linear graph
  // uses the suppressed relation set as a visual projection only.
  const previewMessages=containerPreview?applyMessageFilter(containerPreview.messages,msgFilter):null;
  const edgesToRender = containerPreview?.edges??(viewMode === "list" ? temporaryEdgesToRender : filteredEdgesToRender);
  renderedRelationIdsRef.current = new Set(edgesToRender.map(edge => edge.relationMessageId));
  const suppressedRelIds = comparisonSuppressedRelIds;
  const graphMessagesFinal = (previewMessages??messagesToRenderFiltered)
    .map(message => {
      const correction = correctionVersions.get(message.id)?.current;
      return correction ? withCorrectionContent(message, correction.content) : message;
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
    const draftRelIds = new Set(draftUnits.filter(unit => isWholeMessageSelection(unit, unit.messageId)).map(u => u.messageId));
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
  // Reverse map: stance relation message ID → { target, type } for quick lookup.
  const activeStanceByRelMsgId = (() => {
    const m = new Map<string, { targetRelId: string; type: 'agree' | 'disagree' }>();
    for (const [targetId, v] of activeStanceMap) m.set(v.relMsgId, { targetRelId: targetId, type: v.type });
    return m;
  })();
  const stanceEffectByRelMsgId = (() => {
    const result = new Map<string, { local: boolean; global: boolean }>();
    for (const edge of rawEdgesToRenderClean) {
      if (edge.relationType !== 'agree' && edge.relationType !== 'disagree') continue;
      if (!msgMap.get(edge.to.messageId) || msgMap.get(edge.to.messageId)?.kind !== 'relation') continue;
      const localSuppressed = effectiveSuppressedRelIds.has(edge.to.messageId);
      const globalSuppressed = globallySuppressedRelIds.has(edge.to.messageId);
      result.set(edge.relationMessageId, {
        local: edge.relationType === 'disagree' ? localSuppressed : !localSuppressed,
        global: edge.relationType === 'disagree' ? globalSuppressed : !globalSuppressed,
      });
    }
    return result;
  })();
  // Overridden stances: the user's previous stance messages that are no longer active.
  const overriddenStanceRelIds = computeUserOverriddenStanceRelIds(rawEdgesToRender, messages, displayUser?.username ?? null);
  const relationSpringWidth = Math.max(0, effectiveContainerWidth - relationBarMinWidth);
  const classificationHeader = <ClassificationHeader isInsideClassify={isInsideClassify} isTemporaryJoinCategory={isTemporaryJoinCategory} correctionFilterTargetId={correctionFilterTargetId} comparisonMode={comparisonMode}
                comparisonTargetCount={comparisonViewIds?.size ?? 0} correctionCount={correctionTemporaryViewIds?.size ?? 0} temporaryJoinCount={temporaryJoinCount} classificationTitle={classificationTitle} classifyKindLabel={classifyKindLabel}
                comparisonTargetId={comparisonTargetId} joinFilterTargetId={joinFilterTargetId} joinFilterDirection={joinFilterDirection} currentClassifyRelMsg={currentClassifyRelMsg}
                classifyTargetCount={classifyTargetCount} classifyExitLabel={classifyExitLabel} onExitTemporary={comparisonMode?exitComparison:exitTemporaryCategory} onExitClassify={handleExitClassification} />;

  return (
    <>
      <ErrorBoundary>
        <div style={{ minHeight: "100%", width: effectiveContainerWidth, maxWidth: "100%", minWidth: MIN_LEFT_PX + MIN_RIGHT_PX + 12, margin: 0, display: "flex", flexDirection: "column", background: "#101010", color: "#eee", fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif", overflowX: "visible" }}>
          <RelationToolbar barRef={relationBarRef} leftControlsRef={relationLeftControlsRef} rightControlsRef={relationRightControlsRef}
            top={topControlsFrozen ? topControlsOffset : 0} springWidth={relationSpringWidth} rightOffset={relationControlsRightOffset} viewer={isPreloaded}
            messageIdInput={messageIdInput} onMessageIdChange={setMessageIdInput} onJump={confirmMessageIdNavigation}
            composer={{ relationType, secondaryRelationType, newMessageContent, subType, setRelationType, setSecondaryRelationType, setNewMessageContent, lastTagSecondaryRef, lastDelegationSecondaryRef, savedTextOnTypeSwitchRef, subTypeCustomBufferRef, guideTargetIdRef }} />

          <div ref={panelContainerRef} style={{ display: "flex", flex: "0 0 auto", width: "100%", minWidth: 0 }}>
            <div style={{ flex: leftFlex, display: "flex", flexDirection: "column", minWidth: MIN_LEFT_PX, overflow: "visible", paddingBottom: 8 }}>
              <WorkbenchViewToolbar top={topControlsFrozen ? topControlsOffset + relationBarHeight : relationBarHeight}
                scopeHeader={!containerPreview && !comparisonReviewed ? classificationHeader : undefined}
                scopeMessageId={scopeMessageId} exportTitle={scope?.title ?? 'export'} showAlert={showAlert}
                home={{ mode: homeFilterMode, onChange: setHomeFilterMode }}
                clean={{ active: cleanMode, filters: cleanFilters, matchCount: cleanVisibleIds?.visibleTextIds.size ?? 0, totalCount: contentMsgCount, onAdd: addCleanFilter, onRemove: removeCleanFilter, onUpdate: updateCleanFilter, onClear: clearCleanView }}
                filter={{ settings: msgFilter, onChange: setMsgFilter }}
                view={{ viewMode, setViewMode, leftPanelRef, viewModeScrollRef, draftUnits, targetUnits, traceCount: traceEntries.length, currentClassifyRelMsgId, messages, relations, findContainingClassification, exitClassification, enterClassification, scheduleViewNavigation }}
                comparison={{ singleSideReview:Boolean(containerPreview), comparisonMode, comparisonReviewed, comparisonTargetId, setComparisonTargetId, onStartComparison: startComparison }}
                correctionFilterTargetId={correctionFilterTargetId} onLeaderboard={() => setShowLeaderboard(true)} />

              <div ref={leftPanelRef}
                data-workbench-left-panel="true"
                className={`workbench-left-panel ${previewClassifyId !== null && !containerPreview ? "preview-mode" : ""}`}
                style={{ flex: "0 0 auto", minHeight: leftPanelMinHeight || undefined, boxSizing: "border-box", overflowY: "auto", overflowX: "auto", touchAction: "pan-x pan-y pinch-zoom", WebkitOverflowScrolling: "touch", padding: 8, paddingBottom: 24, position: "relative" }}
                onTouchStart={handleLeftPanelTouchStart}
                onTouchMove={handleLeftPanelTouchMove}
                onTouchEnd={handleLeftPanelTouchEnd}
                onTouchCancel={handleLeftPanelTouchEnd}
                onDoubleClick={e => {
                  const t = e.target as HTMLElement;
                  // Skip if clicked on a message card, SVG edge, or relation overlay
                  if (t.closest?.("[data-msgid]") || t.closest?.("svg") || t.closest?.('[title^="relation="]') || t.closest?.("[data-rel-overlay]")) return;
                  handleCanvasBlankClick();
                }}>
                {messagePulse && <MessageJumpOverlay targetElement={messagePulse.element} visualRoot={messagePulse.visualRoot} targetRect={messagePulse.rect} visualRect={messagePulse.visualRect} onReady={handleSendOverlayReady} />}
                {(previewMessages??messagesToRenderFiltered).length === 0 && !containerPreview && !comparisonReviewed ? (
                  <div style={{ padding: 48, textAlign: "center", color: "#666", fontSize: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                    <div style={{ fontSize: 36, opacity: 0.3 }}>📭</div>
                    <div>{comparisonMode ? "没有可对比的消息" : isInsideClassify ? `当前${classifyKindLabel}中暂无消息` : traceEntries.length > 0 ? "追溯范围内没有可见消息" : "暂无消息，请先发送一条消息或创建关系"}</div>
                    <div style={{ fontSize: 12, opacity: 0.7, maxWidth: 360, lineHeight: 1.6 }}>
                      {comparisonMode ? "仅列出已有赞同或反对记录的关系消息，不含加入、结算等消息。" : isInsideClassify ? "该分类下还没有消息。你可以退出分类视图，在完整画布中发送消息。" : traceEntries.length > 0 ? "当前追溯范围内没有匹配的消息。尝试退出追溯或调整追溯距离。" : "发言只需支付协议费，也可以额外推荐或自赞押注。选中消息或正文片段后，选择关系并发送，即可继续讨论。"}
                    </div>
                    {isInsideClassify && (
                      <button onClick={handleExitClassification} style={{ marginTop: 8, padding: "4px 16px", borderRadius: 6, border: "1px solid #555", background: "#333", color: "#ccc", cursor: "pointer", fontSize: 13 }}>
                        {classifyExitLabel}
                      </button>
                    )}
                    {!isInsideClassify && canExitTrace && (
                      <button onClick={exitTrace} style={{ marginTop: 8, padding: "4px 16px", borderRadius: 6, border: "1px solid #555", background: "#333", color: "#ccc", cursor: "pointer", fontSize: 13 }}>
                        退出追溯
                      </button>
                    )}
                  </div>
                ) : viewMode === "list" ? (
                  <WorkbenchMessageList
                    onRelatedNavigate={viewRelatedContainer} standaloneMessageIds={comparisonViewIds??standaloneMessageIds}
                    visibleMessages={previewMessages??messagesToRenderFiltered}
                    catalog={{ messages:containerPreview?.allMessages??messages, edges:containerPreview?.edges??edges, msgMap:containerPreview?new Map(containerPreview.allMessages.map(message=>[message.id,message])):msgMap, relationById:containerPreview?new Map(containerPreview.relations.map(relation=>[relation.id,relation])):relationById, relationTypeByRelMsgId, joinRelationsByTarget, joinRelationsBySource, effectiveJoinRelationIds:containerPreview?.effectiveJoinIds??effectiveJoinRelationIds, summaryCoverageByMessageId, correctionVersions }}
                    display={{ tagSourceIdsForList:comparisonMode?new Set<string>():tagSourceIdsForList, suppressedRelIds:containerPreview?.suppressed??suppressedRelIds, rejectedContainerIds:containerPreview?.rejectedContainerIds??rejectedContainerIds, overriddenStanceRelIds, readStatusByMessageId, homeMatchIds: homeFilterResult?.matchIds, homeDisplayRoleByMessageId, authorStakes, stakeCounts, correctionFilterTargetId, joinFilterTargetId }}
                    comparison={{ comparisonReviewed, comparisonTargetId, comparisonRecommendedDisplay, activeStanceByRelMsgId, activeStanceMap, stanceEffectByRelMsgId }}
                    settlement={{ settlementOpenMsgId, settlementOpenType, settlementEntryHighlight, closeSettlement, openSettlement, onMessageCreated: message => (window as Window & { __addSettlementMessage?: (value: typeof message) => void }).__addSettlementMessage?.(message) }}
                    selection={{ draftUnits, activeTextSelectId, lastClickedMessageId }}
                    cardHandlers={{ onClick: handleMessageClick, onDoubleClick: handleMessageDoubleClick, onMouseDown: handleMessageMouseDown, onMouseUp: handleMessageMouseUp, onContentMouseUp: handleTextMouseUp }}
                    scopeMessageId={scopeMessageId}
                    onJoinFilter={handleJoinRecords}
                    onRemoveMember={joinId => {
                      setDraftUnits([]); setSourceUnits([]);
                      setTargetUnits([{ messageId: joinId, selection: { kind: 'whole' } }]);
                      setRelationType('disagree'); setSecondaryRelationType('none'); setSendError(null);
                    }}
                    onNavigate={handleNavigateToMessage} onCorrectionNavigate={handleNavigateFromCorrectionTemporaryCategory}
                    renderRelation={renderRelationContentWithTargets} renderContent={renderMessageContentWithAnchorsForList}
                  />
                ) : (
                  <GraphView
                    relatedMessages={containerPreview?.allMessages??messages}
                    comparisonScopeHeader={classificationHeader}
                    comparisonSingle={Boolean(containerPreview)}
                    comparisonDisplay={containerPreview?'agree':undefined}
                    comparisonSuppressedRelIds={containerPreview?.suppressed}
                    rejectedContainerIds={containerPreview?.rejectedContainerIds??rejectedContainerIds}
                    onRelatedMessageNavigate={viewRelatedContainer}
                    standaloneMessageIds={standaloneMessageIds}
                    key={`gv-${classifyKey}-${traceKey}-${containerPreviewId??'base'}-${comparisonReviewed ? `comparison-${comparisonTargetId ?? 'none'}` : 'normal'}`}
                    messages={!containerPreview&&comparisonReviewed ? comparisonGraphMessages : graphMessagesFinal} edges={!containerPreview&&comparisonReviewed ? (comparisonAgreeGraph?.edges ?? temporaryEdgesToRender) : edgesToRender} invalidCorrectionIds={invalidCorrectionIds} draftUnits={draftUnits}
                    comparisonPair={!containerPreview&&comparisonReviewed} comparisonTargetId={containerPreview?containerPreviewId:comparisonTargetId} comparisonRecommendedDisplay={comparisonRecommendedDisplay}
                    comparisonAgreeMessages={comparisonAgreeGraph?.messages} comparisonAgreeEdges={comparisonAgreeGraph?.edges}
                    comparisonAgreeContext={comparisonAgreeGraph?.context}
                    comparisonAgreeHideMessageIds={comparisonAgreeGraph?.hideMessageIds}
                    comparisonDisagreeMessages={comparisonDisagreeGraph?.messages} comparisonDisagreeEdges={comparisonDisagreeGraph?.edges}
                    comparisonDisagreeContext={comparisonDisagreeGraph?.context}
                    comparisonDisagreeHideMessageIds={comparisonDisagreeGraph?.hideMessageIds}
                    comparisonAgreeSuppressedRelIds={comparisonAgreeSuppressedRelIds} comparisonDisagreeSuppressedRelIds={comparisonDisagreeSuppressedRelIds}
                    autoCenterMessageId={!containerPreview&&comparisonReviewed ? comparisonTargetId : null}
                    homeMatchIds={homeFilterResult?.matchIds}
                    homeContextRoleByMessageId={homeDisplayRoleByMessageId}
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
                    hideMessageIds={containerPreview?containerPreview.hideMessageIds:hideMessageIds}
                    traceExpandedFrameIds={traceExpandedFrameIds}
                    traceFrameIds={traceFrameIds}
                    stakeCounts={stakeCounts}
                    onSettlementToggleTruth={(msgId) => { if (settlementOpenMsgId === msgId && settlementOpenType === 'TRUTH') { closeSettlement(); } else { openSettlement(msgId, 'TRUTH'); } }}
                    onSettlementToggleValue={(msgId) => { if (settlementOpenMsgId === msgId && settlementOpenType === 'VALUE') { closeSettlement(); } else { openSettlement(msgId, 'VALUE'); } }}
                    scopeMessageId={scopeMessageId ?? undefined}
                    settlementOpenMsgId={settlementOpenMsgId}
                    settlementOpenType={settlementOpenType}
                    onSettlementMessageCreated={handleSettlementMessageCreated}
                    stanceHighlight={stanceHighlight}
                    settlementEntryHighlight={settlementEntryHighlight}
                    crossClassifyRefs={containerPreview?.context.crossClassifyRefs??crossClassifyRefs}
                    onCrossRefTagClick={handleCrossRefTagClick}
                    onNavigateToMessage={handleNavigateToMessage}
                    joinRelationsByTarget={joinRelationsByTarget}
                    joinRelationsBySource={joinRelationsBySource}
                    joinStatusByMessage={containerPreview?new Map([...containerPreview.effectiveJoinIds].map(id=>[id,'valid' as const])):joinStatusByMessage}
                    onJoinFilterClick={handleJoinRecords}
                  />
                )}
                <div aria-hidden="true" style={{ height: 96, flexShrink: 0 }} />
              </div>
            </div>

            {/* Draggable splitter — 12px wide with visible grip handle */}
            <div
              onPointerDown={handleSplitterPointerDown}
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


            <WorkbenchPanel
              rightPanelRef={rightPanelRef}
              leftPanelRef={leftPanelRef}
              TOTAL_FLEX={TOTAL_FLEX}
              leftFlex={leftFlex}
              minWidth={MIN_RIGHT_PX}
              maxWidth={MAX_RIGHT_PX}
              stickyTop={topControlsFrozen ? topControlsOffset + relationBarHeight : relationBarHeight}
              isPreviewMode={isPreviewMode}
              singleSideReview={containerPreview ? {
                title: getRelationTitle(containerPreview.target.relationPayload) || containerPreview.target.id,
                onExit: exitContainerPreview,
              } : undefined}
              isViewerMode={isPreloaded}
              viewerUsers={viewerUsers}
              viewerUsername={viewerUser?.username}
              onViewerUsernameChange={username => {
                const normalized = username.trim();
                if (normalized) {
                  localStorage.setItem(VIEWER_USERNAME_KEY, normalized);
                  setViewerUser({ id: `viewer:${normalized}`, username: normalized, createdAt: '' });
                } else {
                  localStorage.removeItem(VIEWER_USERNAME_KEY);
                  setViewerUser(null);
                }
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
              traceDistance={traceDistance}
              setTraceDistance={changeTraceDistance}
              canSetTrace={canSetTrace}
              canExitTrace={canExitTrace}
              getSelectedWholeMessageIds={getSelectedWholeMessageIds}
              lastClickedMessageId={lastClickedMessageId}
              enterTraceMultiple={enterTraceMultiple}
              enterTrace={enterTrace}
              exitTrace={exitTrace}
              exitAllTrace={exitAllTrace}
              onNavigateToMessage={handleNavigateToMessage}
              isInsideClassify={isInsideClassify}
              currentTraceIds={currentTraceIds}
              classifyKey={classifyKey}
              traceKey={traceKey}
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
              recommendationAmount={recommendationAmount}
              setRecommendationAmount={setRecommendationAmount}
              stakeAmount={stakeAmount}
              setStakeAmount={setStakeAmount}
              relStakeAmount={relStakeAmount}
              setRelStakeAmount={setRelStakeAmount}
              availablePoints={availablePoints}
              effectiveMinStake={effectiveMinStake}
              singleButtonEnabled={singleButtonEnabled && !sendInFlight && !waitingForSendOverlay && !comparisonReviewed && !isPreloaded}
              singleButtonLabel={singleButtonLabel}
              sendValidationLabel={sendValidationLabel}
              totalConsumption={totalConsumption}
              stakeFeeAmountRef={stakeFeeAmountRef}
              subTypeStakeMap={subTypeStakeMap}
              relationStakeMap={relationStakeMap}
              handleQuickSendAndRelateFromDraftTargets={handleSendClick}
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
              scopeMessageId={scopeMessageId!}
              comparisonMode={comparisonMode}
              comparisonReviewed={comparisonReviewed}
              comparisonTargetId={comparisonTargetId}
              comparisonSide={comparisonSide}
              onComparisonSideChange={setComparisonSide}
              onComparisonReview={() => {
                const targetId = draftUnits.length === 1 ? draftUnits[0].messageId : comparisonTargetId;
                if (!targetId) return;
                prepareComparisonReview(targetId);
                setComparisonTargetId(targetId);
                setComparisonSide('agree');
                setComparisonReviewed(true);
                setComparisonMode(false);
              }}
              onComparisonVote={handleComparisonVote}
              onReturnToComparisonCategory={() => { restoreComparisonScope(); setComparisonReviewed(false); setComparisonMode(true); setComparisonTargetId(null); setComparisonReviewBaseMessages(null); setComparisonReviewBaseEdges(null); setViewMode('list'); }}
              onExitComparison={exitComparison}
            />
          </div>
        </div>
      </ErrorBoundary>
      <PromptModal
        open={showUnauthenticatedNotice}
        title="当前未登录"
        message={'当前未登录，只能查看消息，无法发送消息。\n登录、注册按钮在右上角。\n登录后可参与讨论。'}
        confirmText="已阅"
        onConfirm={() => setShowUnauthenticatedNotice(false)}
      />
      <RegistrationGuideHint
        open={showRegistrationGuide}
        onClose={() => setShowRegistrationGuide(false)}
      />
      {fixedHorizontalScroll && createPortal(
        <div
          ref={fixedHorizontalScrollRef}
          data-fixed-left-horizontal-scroll="true"
          aria-label="左侧视图水平滚动条"
          style={{ position: "fixed", left: fixedHorizontalScroll.left, bottom: fixedHorizontalScroll.bottom, width: fixedHorizontalScroll.width, height: 14, overflowX: "scroll", overflowY: "hidden", scrollbarGutter: "stable", zIndex: Z_INDEX.header - 2, background: "#101010" }}
        >
          <div style={{ width: fixedHorizontalScroll.contentWidth, height: 1 }} />
        </div>,
        document.body,
      )}

      <PromptModal
        open={sendInFlight || waitingForSendOverlay}
        title="正在发送"
        message="正在发送消息并更新关联结构，请稍候…"
        hideActions
        onConfirm={() => undefined}
      />

      <LeaderboardModal
        open={showLeaderboard}
        onClose={() => setShowLeaderboard(false)}
        onRefresh={() => setLeaderboardRefreshVersion(version => version + 1)}
        messages={messages}
        edges={edges}
        relations={relations}
        users={registeredUsers}
        stakeCounts={stakeCounts}
        messageBettorCounts={messageBettorCounts}
      />

      <PromptModal
        open={alertMessage !== null}
        title="提示"
        message={renderAlertMessage(alertMessage ?? '')}
        confirmText="已阅"
        onConfirm={() => setAlertMessage(null)}
      />

      <RelationRecordPopups messages={messages} edges={edges} decorationPopup={decorationPopup} tagPopup={tagPopup} mergeInfoPopup={mergeInfoPopup}
        onCloseDecoration={() => setDecorationPopup(null)} onCloseTag={() => setTagPopup(null)} onCloseMerge={() => setMergeInfoPopup(null)} />
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
          isSending={sendInFlight}
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

