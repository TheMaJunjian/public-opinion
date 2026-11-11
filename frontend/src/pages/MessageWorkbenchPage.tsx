import {useReadingViewportAnchor} from '../hooks/useReadingViewportAnchor';
import type {ReadingTask,ReadingOrder} from './workbench/model/readingTasks';
import {exitTrace as runExitTrace} from './workbench/actions/viewHistory';
import {DEFAULT_TRACE_DEPTHS,traceDepths as legacyTraceDepths,type TraceDirection,type TraceDepths} from '../utils/traceRange';
import { useWorkbenchComposer } from './workbench/useWorkbenchComposer';
import { useSendPreview } from './workbench/useSendPreview';
import { CardWidthContext } from '../components/graph/CardWidthContext';
import {ModerationContext} from '../components/ModerationContext';
import {projectReviewDiscussionEdges,reviewRecordTarget,reviewTargetMessage} from '../utils/reviewRecords';
import {ReviewDetailContext,useReviewDetail} from '../hooks/useReviewDetail';
import {isRelationView,isReviewProcessRecord,reviewContextOf,sameReviewContext,selectReviewDiscussion} from '@gonglun/core';
import {convertMessagesToDemoModel,isReviewDiscussion} from '../utils/modelBridge';
import { ReadingTextLinksContext } from '../components/ReadingTextLinksContext';
import { createZhihuReadingLinks } from '../utils/zhihuReadingLinks';
import { effectiveCardWidths } from '../utils/cardWidth';
import {contributionFor,contributionTypeForTarget,primaryContributionType,type ContributionDraft} from './workbench/model/contributions';
import {targetInvestmentDimension} from '@gonglun/core';
import {contributionContext} from './workbench/model/contributionContext';
import { annotationStanceError } from '@gonglun/core';
import { useRelationToolbar } from './workbench/useRelationToolbar';
import { useWorkbenchViewport } from './workbench/useWorkbenchViewport';
import { useBrowsingHistory } from './workbench/useBrowsingHistory';
import { useWorkbenchData, VIEWER_USERNAME_KEY } from './workbench/useWorkbenchData';
import { useDiscussionView } from './workbench/useDiscussionView';
import { copyDiscussionView } from '../utils/discussionView';
import { zhihuStanceReference, zhihuWholeMessageUnit } from '../utils/zhihuSelection';
import { getZhihuDisplayFields, getZhihuInactiveRelationIds, isZhihuViewingData } from '../utils/zhihuArchive';
import ZhihuDirectorySync from '../components/ZhihuDirectorySync';
import { isNativeZhihuView } from '../utils/nativeZhihuView';
import { nativeZhihuDocument, nativeZhihuEditingView } from '../utils/nativeZhihuEditor';
import { LocalDiscussion } from '../utils/localDiscussion';
import { sendPagedZhihuRelation } from '../utils/pagedZhihuEditor';
import { getExportCacheReference, saveExportNavigation } from '../utils/exportViewerCache';
import { structuralScopeKey } from '../utils/zhihuStructuralViewer';
import { serializeGonglunZhihuViewingData } from '../utils/zhihuGonglunExport';
import type { LocalRelationType } from './workbench/ui/RelationToolbar';
import { downloadExport } from '../utils/saveExport';
import React, { lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import DeferredWorkbench from '../components/DeferredWorkbench';
import RecentWorkbenchViews from '../components/RecentWorkbenchViews';
import {ViewCacheSettingsProvider} from '../context/ViewCacheSettingsContext';
import WorkbenchSplitter from '../components/WorkbenchSplitter';
import WorkbenchScrollViewport from '../components/WorkbenchScrollViewport';
import { isCapturingPreview } from '../api/commandBatch';
import { MessageDisplayHintsProvider } from '../components/LazyMessageDisplayHints';
import { displayHintDestination } from './workbench/model/displayHintSnapshot';
import {applyReadingVersions,createReadingVersionHistory,selectedReadingVersion} from './workbench/model/readingVersions';
import { deriveCorrectionStanceDisplay } from '../utils/correctionStanceDisplay';
import {messageAuthorInvestment} from '../utils/messageAuthorship';
import LeaderboardController, { type LeaderboardHandle } from '../components/LeaderboardController';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ApiError, type ExportData } from '../api/client';
import { useAuth } from '../context/AuthContext';
import type {
  DemoEdge,
  DemoMessage,
  RelationType,
  UnitSelection,
} from '../utils/modelBridge';
import { computeCorrectionVersions, computeGloballySuppressedRelIds, computeTransitiveVoteStats, computeUserActiveStanceRelIds, computeUserOverriddenStanceRelIds, demoMessageToRelation, isCardMessage, isContentKind, isReviewRecord, isSettlementRecord, presentationTarget, withCorrectionContent } from '../utils/modelBridge';
import { blockCorrectionForSecondBettor as runBlockCorrectionForSecondBettor, handleAuthError as runHandleAuthError, requireAuth as runRequireAuth } from './workbench/actions/authentication';
import { clearDraftAll as runClearDraftAll, commitDraftTo as runCommitDraftTo, handleCanvasBlankClick as runHandleCanvasBlankClick, handleFragmentAnchorClick as runHandleFragmentAnchorClick, handleMessageClick as runHandleMessageClick, handleMessageDoubleClick as runHandleMessageDoubleClick, handleMessageMouseDown as runHandleMessageMouseDown, handleMessageMouseUp as runHandleMessageMouseUp, handleTextMouseUp as runHandleTextMouseUp, toggleFragmentSelection as runToggleFragmentSelection, toggleWholeUnit as runToggleWholeUnit, undoRecentClickActionsForMessage as runUndoRecentClickActionsForMessage } from './workbench/actions/cardSelection';
import { renderAlertMessage as runRenderAlertMessage, renderMessageContentWithAnchorsForList as runRenderMessageContentWithAnchorsForList, renderRelationContentWithTargets as runRenderRelationContentWithTargets } from './workbench/actions/messageRendering';
import { confirmReverseCorrection as runConfirmReverseCorrection, handleComparisonVote as runHandleComparisonVote, handleDecorationBodyClick as runHandleDecorationBodyClick, handleDecorationIconClick as runHandleDecorationIconClick, handleGroupFrameClick as runHandleGroupFrameClick, handleGroupFrameDoubleClick as runHandleGroupFrameDoubleClick, handleInlineBadgeClick as runHandleInlineBadgeClick, handleInlineBadgeDoubleClick as runHandleInlineBadgeDoubleClick, handleTagBodyClick as runHandleTagBodyClick } from './workbench/actions/relationActions';
import { clampAndSetScroll, findMessageElements, findVisibleMessageElement, cancelScrollRafs as runCancelScrollRafs, scheduleViewNavigation as runScheduleViewNavigation, scrollMsgToCenter as runScrollMsgToCenter, showMessagePulse as runShowMessagePulse } from './workbench/actions/scrollNavigation';
import type { ScrollMessageOptions } from './workbench/actions/scrollNavigation';
import { REVEAL_VIRTUAL_MESSAGE } from '../hooks/useVirtualMessageMounts';
import { handleQuickSendAndRelateFromDraftTargets as runHandleQuickSendAndRelateFromDraftTargets } from './workbench/actions/sendDraft';
import { createJoinRelationsForContainer as runCreateJoinRelationsForContainer, handleCreateRelationWithSourcesAndTargets as runHandleCreateRelationWithSourcesAndTargets, sendTagRelation as runSendTagRelation } from './workbench/actions/sendRelation';
import { handleSendMessageOnly as runHandleSendMessageOnly, registerCreatedRelationInCurrentClassify as runRegisterCreatedRelationInCurrentClassify } from './workbench/actions/sendText';
import { handleSendClick as runHandleSendClick } from './workbench/actions/sendTransaction';
import { collectExclusiveRelationMsgIds as runCollectExclusiveRelationMsgIds, getClassifyTargetRefs as runGetClassifyTargetRefs, getContainerCycleError as runGetContainerCycleError, getContainerMembershipTargetError as runGetContainerMembershipTargetError, getDependentDisplayTarget as runGetDependentDisplayTarget, getDependentDisplayTargets as runGetDependentDisplayTargets, getGroupedTargetTextMessageIds as runGetGroupedTargetTextMessageIds, getJoinContainerCycleError as runGetJoinContainerCycleError, getSelectedWholeMessageIds as runGetSelectedWholeMessageIds, hasCrossNonReferenceTextLinkForClassifyTargets as runHasCrossNonReferenceTextLinkForClassifyTargets, organizationTargetRef as runOrganizationTargetRef, promoteCompleteContainerSelections as runPromoteCompleteContainerSelections, resolveEffectiveTargetUnits as runResolveEffectiveTargetUnits } from './workbench/actions/targetResolution';
import { captureSnapshot as runCaptureSnapshot, confirmMessageIdNavigation as runConfirmMessageIdNavigation, enterClassification as runEnterClassification, enterTemporaryCategory as runEnterTemporaryCategory, enterTrace as runEnterTrace, enterTraceMultiple as runEnterTraceMultiple, exitAllTemporaryCategories as runExitAllTemporaryCategories, exitAllTrace as runExitAllTrace, exitClassification as runExitClassification, exitTemporaryCategory as runExitTemporaryCategory, findContainingClassification as runFindContainingClassification, handleExitClassification as runHandleExitClassification, restoreSnapshot as runRestoreSnapshot } from './workbench/actions/viewHistory';
import type { RestoreSnapshotOptions } from './workbench/actions/viewHistory';
import { deriveComparisonGraphProjections, projectComparisonSide } from './workbench/projections/comparisonGraphProjections';
import type { DeriveComparisonGraphProjectionsInput } from './workbench/projections/comparisonGraphProjections';
import { deriveCrossCanvasRelations } from '../utils/crossCanvasRelations';
import { loadRelatedTraceContext } from '../utils/relatedTraceContext';
import { deriveGraphMessagesToRender } from './workbench/projections/graphMessagesToRender';
import { comparisonViewMessageIds, hasComparisonDisplayEffect } from './workbench/projections/comparisonViewScope';
import { projectGraphScene } from '../utils/graphProjection';
import { deriveHiddenInGraphView } from './workbench/projections/hiddenInGraphView';
import { deriveHomeFilterResult } from './workbench/projections/homeFilterResult';
import { normalizeHomeFilter } from './workbench/model/homeFilter';
import { useHomeFilterReadingMarks } from '../hooks/useHomeFilterReadingMarks';
import { deriveMessagesToShow } from './workbench/projections/messagesToShow';
import { deriveNormalGraphProjection } from './workbench/projections/normalGraphProjection';
import {deriveContainerEffect,isContainerType} from './workbench/model/containerEffect';
import { deriveReclassificationJoinCount } from './workbench/projections/reclassificationJoinCount';
import { deriveSendValidationLabel } from './workbench/projections/sendValidationLabel';
import { deriveSingleButtonEnabled } from './workbench/projections/singleButtonEnabled';
import { deriveSingleButtonLabel } from './workbench/projections/singleButtonLabel';
import { deriveTraceFrameIds } from './workbench/projections/traceFrameIds';
import type { ClassifyStackEntry, DraftGroup, TraceEntry, TraceSnapshot, ViewMode } from './workbench/types';

import type { Json } from '@gonglun/core';
import ErrorBoundary from '../components/ErrorBoundary';
import { clearBrowserSelection, relationTypeName } from '../utils/graphTextSelection';
import { MessageJumpOverlay } from '../components/PopupOverlay';
import PromptModal from '../components/PromptModal';
import WorkbenchLoadingBoundary, { useWorkbenchLoadingProgress, useWorkbenchSendingProgress, useWorkbenchDrawingPreparation } from '../components/WorkbenchLoadingBoundary';
import { flushSync } from 'react-dom';
import WorkbenchActivityIndicator from '../components/WorkbenchActivityIndicator';
import { useWorkbenchDrawingCommit, useWorkbenchDrawingFailure, useWorkbenchDrawingTask } from '../context/WorkbenchDrawingContext';
const WorkbenchPanel = lazy(() => import('../components/WorkbenchPanel'));
const ZhihuReplyEditor = lazy(() => import('../components/ZhihuReplyEditor'));
import useStakeCalculation from '../hooks/useStakeCalculation';
import type { MessageStakes, Relation, TargetRef } from '../types';
import { getPresentationSpec, getRelationTitle } from '../types';
import {isRejectedRelation} from '../utils/relatedMessages';
import { operationLog } from '../utils/debugLog';
import { beginWorkbenchDrawing, reportWorkbenchDrawingDuration, resetWorkbenchActivity } from '../utils/workbenchActivity';
import { PART_SELECTION_EVENT, isWholeMessageSelection, type PartSelectionDetail } from '../utils/messageElementSelection';
import { groupDraftSelections } from './workbench/actions/cardSelection';
import { referenceToUnit, targetRefToUnit, unitSelectionToReference } from '../utils/modelBridge';



import { type HomeFilterMode } from '../components/HomeFilterPanel';
import { applyMessageFilter, type MessageFilterSettings } from '../components/MessageFilterPanel';
import { useCleanView } from '../hooks/useCleanView';
import { useViewedMessageHighlight,type ReadingNavigationMarkers } from '../hooks/useViewedMessageHighlight';
import { useNotificationNavigation } from '../hooks/useNotificationNavigation';
import { useMessageLinkNavigation } from '../hooks/useMessageLinkNavigation';
import { messageNavigationUrl } from '../utils/messageLink';
import { useNotificationRecipients } from '../hooks/useNotificationRecipients';
import { useCatalogFilters } from '../hooks/useCatalogFilters';
import {useReadingState} from '../hooks/useReadingState';
import {messageReadingKey} from '@gonglun/core';
import {expandedFrameScope} from './workbench/model/expandedFrameCategory';
import {createDisplayHintWindow} from './workbench/model/displayHintWindow';
import {createCurrentContainerLookup} from './workbench/model/displayHintContainers';
import { useMessageWindow } from '../hooks/useMessageWindow';
import { MAX_TAG_LABEL_DISPLAY_LENGTH, SUB_TYPE_OPTIONS, buildRelationDemoMessage, isValidTagLabel, replyAdditionalLabel, secondaryRelationLabel, subTypeLabel } from './workbench/model/relationComposition';
import { expandTextIdsWithCorrections, isCorrectableCorrectionTarget } from './workbench/model/correction';
import { collectAllContainerOwnership, collectOwnedByRelation } from './workbench/model/ownership';
import { describeUnit } from '../utils/selectionLabel';
import { expandTextIdsWithSettlementResults } from './workbench/model/navigation';
import { filterContainerEdgesByEffectiveJoins, indexJoinRelationsByTarget,projectJoinMembershipEdges } from './workbench/model/membership';
import { nextId, selKey, unitEquals } from './workbench/model/selection';

// ========================= MessageWorkbenchPage =========================
const GraphView = lazy(() => import('../components/GraphView'));
const RelationToolbar = lazy(() => import('./workbench/ui/RelationToolbar'));
const RelationChoices = lazy(() => import('./workbench/ui/RelationToolbar').then(module => ({ default: module.RelationChoices })));
const WorkbenchViewToolbar = lazy(() => import('./workbench/ui/WorkbenchViewToolbar'));
const ClassificationHeader = lazy(() => import('./workbench/ui/ClassificationHeader'));
const TraceReadingController = lazy(() => import('../components/TraceReadingController'));
const ReadingCanvasPresentation = lazy(() => import('../components/ReadingCanvasPresentation'));
const AuthoredReadingBackfill = lazy(() => import('../components/AuthoredReadingBackfill'));
const WorkbenchMessageList = lazy(() => import('./workbench/ui/WorkbenchMessageList'));
const CorrectionComparisonPopup = lazy(() => import('../components/CorrectionComparisonPopup'));
const RelationRecordPopups = lazy(() => import('./workbench/ui/RelationRecordPopups'));
const MessagePagination = lazy(() => import('../components/MessagePagination'));
const CatalogStatus = lazy(() => import('../components/CatalogStatus'));
const RegistrationGuideHint = lazy(() => import('../components/RegistrationGuideHint'));








export default function MessageWorkbenchPage() {
  const location = useLocation();
  useEffect(() => () => resetWorkbenchActivity(), []);
  return <ViewCacheSettingsProvider>
    <WorkbenchLoadingBoundary key={location.pathname === '/viewer' ? location.state?.viewerInstanceKey ?? location.key : 'online'}><MessageWorkbenchContent routeState={location.state} /></WorkbenchLoadingBoundary>
    <WorkbenchActivityIndicator />
  </ViewCacheSettingsProvider>;
}

function MessageWorkbenchContent({ routeState }: { routeState: unknown }) {
  const composer = useWorkbenchComposer();
  const {
    draftUnits, setDraftUnits, sourceUnits, setSourceUnits, targetUnits, setTargetUnits, activeTextSelectId,
    setActiveTextSelectId, relationType, setRelationType, secondaryRelationType, setSecondaryRelationType,
    subType, setSubType, subTypeCustomLabel, setSubTypeCustomLabel, relationLabel, setRelationLabel,
    newMessageContent, setNewMessageContent, stakeAmount, setStakeAmount, relStakeAmount, setRelStakeAmount,
    recommendationAmount, setRecommendationAmount, subTypeCustomBufferRef, savedTextOnTypeSwitchRef,
    lastTagSecondaryRef, lastDelegationSecondaryRef,
  } = composer;
  const reportDrawingFailure = useWorkbenchDrawingFailure();
  useWorkbenchDrawingCommit();
  const beginPositioning = useWorkbenchDrawingTask('positioning', true);
  const beginLoading = useWorkbenchDrawingTask('loading', true);
  const beginProjection = useWorkbenchDrawingTask('projection', true);
  const prepareCategoryDrawing = useWorkbenchDrawingPreparation();
  const renderStartedAt = performance.now();
  const [viewMode, setViewMode] = useState<ViewMode>("graph");
  const { messageId: routeMessageId } = useParams<{ messageId: string }>();
  const scopeMessageId = routeMessageId ?? 'root';
  const [searchParams, setSearchParams] = useSearchParams();
  const [notificationFocusIds,setNotificationFocusIds] = useState<string[]>([]);
  const navigate = useNavigate();
  const { user, logout, loading: authLoading } = useAuth();
  const {
    scope, messages:loadedMessages, setMessages, edges:loadedEdges, setEdges,
    edgesRef, relations:loadedRelations, setRelations, attentionUsersByTarget, loadError,
    showUnauthenticatedNotice, setShowUnauthenticatedNotice, showRegistrationGuide, setShowRegistrationGuide, stakeCounts,
    setStakeCounts, messageBettorCounts, setMessageBettorCounts, authorStakes, setAuthorStakes,
    refreshLeaderboard, registeredUsers, isPreloaded, viewerUser, setViewerUser,
    displayUser, correctionVersions:personalCorrectionVersions, preloadedData, loadedExport, viewerUsers, loading, persistPreloadedExport, isViewerRoute, viewerNavigation,
    tagCounts, setRelatedTraceContext, captureOptimisticRollback,
    onDemand, ensureMessages,
    catalog, catalogReady, catalogVersion, catalogComputationsCurrent, globalRows,
    viewingExport, viewerStructure, unloadedViewerContainers, loadViewerScope, appliedScopeKey, viewerBodyPage, loadMoreViewerBodies,
    captureTransient, showSendPreview, clearSendPreview, confirmSendPreview, liveSequence, sendPreviewPages, sendPreviewMessageIds,
  } = useWorkbenchData({ user, authLoading, scopeMessageId, navigate, viewMode });
  const [currentRecordCategory,setRecordCategory]=useState<{targetId:string;label:string;recordIds:string[];revision?:number}|null>(null);
  // Preview the destination without changing the draft's sending scope or the
  // browsing state that must return when the rehearsal is cancelled.
  const previewReviewContext=useMemo(()=>{
    const ids=new Set(sendPreviewMessageIds);
    const record=sendPreviewPages?.flatMap(page=>page.messages).find(message=>ids.has(message.id)&&isReviewRecord(message));
    return reviewContextOf(record);
  },[sendPreviewPages,sendPreviewMessageIds]);
  const recordCategory=useMemo(()=>!previewReviewContext||currentRecordCategory?.label==='审核'
    &&currentRecordCategory.targetId===previewReviewContext.messageId&&(!currentRecordCategory.revision||currentRecordCategory.revision===previewReviewContext.revision)
    ?currentRecordCategory:{targetId:previewReviewContext.messageId,label:'审核',revision:previewReviewContext.revision,recordIds:sendPreviewMessageIds??[]},
    [currentRecordCategory,previewReviewContext,sendPreviewMessageIds]);
  // The active review owns its data outside retained canvases. Its complete API
  // records also survive bounded catalog projections without refetching bodies.
  const review=useReviewDetail(!isPreloaded&&recordCategory?.label==='审核'?recordCategory.targetId:undefined,recordCategory?.revision,sendPreviewPages);
  const activeReviewContext=useMemo(()=>recordCategory?.label==='审核'&& (recordCategory.revision??review.detail?.summary.revision)
    ?{messageId:recordCategory.targetId,revision:(recordCategory.revision??review.detail!.summary.revision)}:undefined,
    [recordCategory?.label,recordCategory?.targetId,recordCategory?.revision,review.detail?.summary.revision]);
  const compositionReviewContext=currentRecordCategory?.label==='审核'&&currentRecordCategory.targetId===activeReviewContext?.messageId?activeReviewContext:undefined;
  const reviewRecordsModel=useMemo(()=>convertMessagesToDemoModel(review.records,review.records.filter(isRelationView)),[review.records]);
  const messages=useMemo(()=>review.records.length?[...new Map([...loadedMessages,...reviewRecordsModel.messages].map(message=>[message.id,message])).values()]:loadedMessages,[loadedMessages,reviewRecordsModel]);
  const relations=useMemo(()=>review.records.length?[...new Map([...loadedRelations,...review.records.filter(isRelationView)].map(relation=>[relation.id,relation])).values()]:loadedRelations,[loadedRelations,review.records]);
  const edges=useMemo(()=>review.records.length?[...new Map([...loadedEdges,...reviewRecordsModel.edges].map(edge=>[edge.id,edge])).values()]:loadedEdges,[loadedEdges,reviewRecordsModel]);
  const nativeZhihuData = isNativeZhihuView(loadedExport) ? loadedExport : null;
  const localMessageData = isViewerRoute && loadedExport && !nativeZhihuData && !isZhihuViewingData(loadedExport) ? loadedExport : null;
  const zhihuData = useMemo(() => nativeZhihuData ? nativeZhihuEditingView(isNativeZhihuView(viewingExport) ? viewingExport : nativeZhihuData)
    : isZhihuViewingData(loadedExport) ? loadedExport : null, [loadedExport, nativeZhihuData, viewingExport]);
  const discussion = useDiscussionView(loadedExport);
  const readingTextLinks = useMemo(() => isViewerRoute && zhihuData ? { linksForMessage: createZhihuReadingLinks(zhihuData) } : false, [isViewerRoute, zhihuData]);
  const [localRelationType, setLocalRelationType] = useState<LocalRelationType | null>('reply');
  const localDraftRef = useRef<LocalDiscussion | null>(null);
  const [localSending, setLocalSending] = useState(false);
  const localRelationMode = zhihuData ? { relationType: localRelationType, onChange: (type: LocalRelationType | null) => {
    if (type === 'correct' && localRelationType !== 'correct') setSecondaryRelationType('text-correction');
    setLocalRelationType(type);
  }, disabled: localSending } : undefined;
  const localInactiveRelationIds = useMemo(() => zhihuData ? getZhihuInactiveRelationIds(zhihuData) : new Set<string>(), [zhihuData]);
  const localPanelData = useMemo(() => localInactiveRelationIds.size ? {
    messages: messages.filter(message => !localInactiveRelationIds.has(message.id)),
    edges: edges.filter(edge => !localInactiveRelationIds.has(edge.relationMessageId)
      && !localInactiveRelationIds.has(edge.from.messageId) && !localInactiveRelationIds.has(edge.to.messageId)),
  } : { messages, edges }, [messages, edges, localInactiveRelationIds]);
  const knownMessageIds = useMemo(() => viewerStructure?.knownIds ?? new Set(messages.map(message => message.id)), [messages, viewerStructure]);
  useWorkbenchLoadingProgress(loading && !preloadedData, loadError, preloadedData);
  const { relationBarRef, relationLeftControlsRef, relationRightControlsRef, relationBarHeight, relationBarMinWidth, relationControlsRightOffset } = useRelationToolbar(loading);

  // Messages that have no DOM element in the non-linear graph view.
  // Mirror of GraphView's hiddenTargetIds logic — used to decide whether
  // to auto-switch to linear view when navigating to such a message.
  const hiddenInGraphView = useMemo(() => deriveHiddenInGraphView({ messages, edges }), [edges, messages]);

  // Auto-enter classify scope if msg belongs to one
  const [autoClassifyMsgId, setAutoClassifyMsgId] = useState<string | null>(null);

  // Phase 3: auto-open settlement from URL params (triggered by points-navigate)
  const pendingScrollMsgRef = useRef<string | null>(null);
  const pendingScrollCompletionRef = useRef<ScrollMessageOptions['onComplete']>();
  const pendingReadingLoadRef=useRef<{id:string;ids:string[];tasks:ReadingTask[];force:boolean;loaded:boolean;resolve:()=>void;reject:(error:Error)=>void}|null>(null);
  useEffect(() => {
    const targetMsgId = searchParams.get('msg');
    const settlementMsgId = searchParams.get('settlement');
    if (!loading && !loadError && settlementMsgId) {
      const msgId = targetMsgId || settlementMsgId!;
      navigateToMessageRef.current?.(msgId);
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
    }
  }, [searchParams, setSearchParams, loading, loadError]);
  useEffect(() => {
    const selectPart = (event: Event) => {
      const { reference, label } = (event as CustomEvent<PartSelectionDetail>).detail;
      const unit = referenceToUnit(reference, undefined, label);
      setLastClickedMessageId(unit.messageId);
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
  const compositionParentId=compositionReviewContext
    ?currentClassifyRelMsgId&&sameReviewContext(compositionReviewContext,reviewContextOf(messages.find(message=>message.id===currentClassifyRelMsgId)))?currentClassifyRelMsgId:'root'
    :currentClassifyRelMsgId??scopeMessageId;
  // Stack-based snapshot store for nested classify enter/exit.
  // Each entry holds the classify id and the snapshot captured before entering it.
  const classifyStackRef = useRef<ClassifyStackEntry[]>([]);
  const isTemporaryFrameCategory=!!classifyStackRef.current.at(-1)?.frameScopeIds;
  const graphFrameViewStateRef=useRef<import('../utils/frameViewports').GraphFrameViewState>({});
  const [frameViewRestoreKey,setFrameViewRestoreKey]=useState(0);
  function resetFrameExpansion():void {
    graphFrameViewStateRef.current=Object.fromEntries(Object.entries(graphFrameViewStateRef.current)
      .map(([key,state])=>[key,{...state,full:{},collapsed:[]}]));
    setFrameViewRestoreKey(key=>key+1);
  }
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
  const correctionPreviewId=messages.find(message=>message.id===containerPreviewId)?.relationType==='correct'?containerPreviewId:null;
  const availableCorrectionVersions=useMemo(()=>{
    if(!correctionPreviewId)return personalCorrectionVersions;
    const invalid=new Set([...personalCorrectionVersions.values()].flatMap(entry=>entry.versions.filter(version=>!version.valid).map(version=>version.correctionId)));
    return computeCorrectionVersions(messages,edges,invalid,displayUser?.username??null,{previewCorrectionId:correctionPreviewId});
  },[personalCorrectionVersions,correctionPreviewId,messages,edges,displayUser?.username]);
  const readingVersionHistory=useMemo(createReadingVersionHistory,[scopeMessageId,loadedExport,displayUser?.username]);
  const readingVersions=useSyncExternalStore(readingVersionHistory.subscribe,readingVersionHistory.getSnapshot);
  const recommendedCorrectionVersions=useMemo(()=>computeCorrectionVersions(messages,edges,computeGloballySuppressedRelIds(edges,messages)),[messages,edges]);
  const correctionVersions=useMemo(()=>applyReadingVersions(availableCorrectionVersions,readingVersions,messages,recommendedCorrectionVersions,personalCorrectionVersions),[availableCorrectionVersions,readingVersions,messages,recommendedCorrectionVersions,personalCorrectionVersions]);
  const correctionStances=useMemo(()=>deriveCorrectionStanceDisplay(messages,edges,correctionVersions,stakeCounts,authorStakes),[messages,edges,correctionVersions,stakeCounts,authorStakes]);
  const displayStanceEdges=useMemo(()=>edges.filter(edge=>!correctionStances.excludedEdges.has(edge.id)),[edges,correctionStances.excludedEdges]);
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
    messages: DemoMessage[]; edges: DemoEdge[]; messageIds: Set<string>;
  } | null>(null);
  const comparisonChooser = useRef<{ snapshot: TraceSnapshot; targetId: string; selection: UnitSelection[] } | null>(null);
  const isPreviewMode = previewClassifyId !== null && containerPreviewId === null;
  // Fetch tag counts for clean view
  // Phase 6: Clean view — multi-dimensional filter rules
  const {
    cleanMode, cleanFilters, cleanVisibleIds: localCleanVisibleIds,
    addFilter: addCleanFilter, removeFilter: removeCleanFilter,
    updateFilter: updateCleanFilter, clearFilters: clearCleanFilters,
  } = useCleanView({ messages, edges, stakeCounts, tagCounts, defer: onDemand && !isPreloaded && !viewerStructure && (!catalogReady || catalogComputationsCurrent) });
  const [homeFilterMode, setHomeFilterMode] = useState<HomeFilterMode | null>(null);
  const readingState=useReadingState(user?.id,!isPreloaded && !isViewerRoute);
  const homeReadingStatus = normalizeHomeFilter(homeFilterMode).status;
  const homeFilterReadingMarks = useHomeFilterReadingMarks(homeFilterMode, JSON.stringify([user?.id, scopeMessageId, isPreloaded, viewMode, cleanFilters]), readingState.marks, readingState.ready);
  const displayHintWindow=useMemo(()=>createDisplayHintWindow(),[scopeMessageId,loadedExport,displayUser?.username]);
  const workerFilters = onDemand && !isPreloaded && !viewerStructure && (!catalogReady || catalogComputationsCurrent);
  const globalFilters = useCatalogFilters(workerFilters ? catalog : null, catalogVersion, catalogReady, { rules: cleanFilters, home: homeFilterMode, user: displayUser, readingMarks: homeReadingStatus === 'all' ? undefined : homeFilterReadingMarks });
  const globalFilterPending = workerFilters && globalFilters.pending;
  useLayoutEffect(() => {
    if (!globalFilterPending || globalFilters.error) return;
    const task = beginProjection();
    // History restores its viewport after the filtered canvas has mounted.
    return () => task.complete();
  }, [globalFilterPending, globalFilters.error, beginProjection]);
  const cleanVisibleIds = workerFilters ? globalFilters.result?.clean ?? null : localCleanVisibleIds;
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
  const filteringMessageTypes = cleanFilters.some(rule => rule.kind === 'messageType'||rule.kind==='time');
  const filterableMessages = useMemo(() => filteringMessageTypes ? messages
    : messages.filter(message => isCardMessage(message) || getPresentationSpec(message.relationType ?? '').isContainer), [messages, filteringMessageTypes]);
  const contentMsgCount = filterableMessages.length;
  const cleanMatchCount = useMemo(() => cleanVisibleIds?filterableMessages.filter(message=>cleanVisibleIds.visibleTextIds.has(message.id)||cleanVisibleIds.visibleRelIds.has(message.id)).length:0,[filterableMessages,cleanVisibleIds]);
  // Message type filter: hide settlement / join messages
  const [msgFilter, setMsgFilter] = useState<MessageFilterSettings>({ hideSettlement: true, hideJoin: true });
  const restoredExportView = useRef<typeof loadedExport>(null);
  useLayoutEffect(() => {
    if (!loadedExport) return;
    const previous = restoredExportView.current;
    restoredExportView.current = loadedExport;
    if (isNativeZhihuView(previous) && isNativeZhihuView(loadedExport)) {
      const previousCache = getExportCacheReference(previous), currentCache = getExportCacheReference(loadedExport);
      if (previousCache && currentCache && previousCache.viewCacheId === currentCache.viewCacheId) return;
    }
    // A local save keeps the current navigation and canvas; its saved view is
    // a copy of that state, not a request to enter the same document again.
    if (isZhihuViewingData(previous) && isZhihuViewingData(loadedExport)
      && previous.zhihu.archiveId === loadedExport.zhihu.archiveId) return;
    const task = beginProjection();
    task.run(() => {
      const view = loadedExport.view;
      setViewMode(view?.mode ?? 'graph');
      setMsgFilter(view?.messageFilter ?? { hideSettlement: true, hideJoin: true });
      setHomeFilterMode(view?.homeFilter ?? null);
      clearCleanFilters();
      view?.cleanFilters.forEach(addCleanFilter);
      const navigation = viewerNavigation;
      const requestedId = navigation ? navigation.classificationId : view?.classificationId ?? null;
      const classificationId = requestedId && loadedExport.messages.some(message => message.id === requestedId) ? requestedId : null;
      // An archive can open inside a container without an enter action. Keep
      // that starting layer in history so leaving a child returns to it, and
      // replace history from any previously opened archive at the same time.
      const path = classificationId && navigation?.classificationPath?.at(-1) === classificationId
        ? navigation.classificationPath : classificationId ? [classificationId] : [];
      const knownIds = new Set(loadedExport.messages.map(message => message.id));
      classifyStackRef.current = path.filter(id => knownIds.has(id)).map(relMsgId => ({ relMsgId, snapshot: null }));
      setClassifyRelMsgId(classificationId);
      task.complete();
    });
  }, [loadedExport, clearCleanFilters, addCleanFilter, beginProjection]);
  const previousViewerPosition = useRef({ data: loadedExport, classificationId: classifyRelMsgId });
  const saveViewerPosition = () => {
    if (loadedExport) void saveExportNavigation(loadedExport, { classificationId: classifyRelMsgId,
      classificationPath: classifyStackRef.current.map(entry => entry.relMsgId) }).catch(() => undefined);
  };
  useEffect(() => {
    const previous = previousViewerPosition.current;
    previousViewerPosition.current = { data: loadedExport, classificationId: classifyRelMsgId };
    // Skip the intermediate render before a newly loaded file restores its view.
    if (previous.data === loadedExport && previous.classificationId !== classifyRelMsgId) saveViewerPosition();
  }, [loadedExport, classifyRelMsgId]);
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
  const [recentSelectedMessageIds,setRecentSelectedMessageIds]=useState<string[]>([]);
  const previousSelectedUnits=useRef<UnitSelection[]>([]);
  useEffect(()=>{
    const added=draftUnits.some(unit=>!previousSelectedUnits.current.some(previous=>unitEquals(unit,previous)));
    previousSelectedUnits.current=draftUnits;
    // Remember the most recently selected group, even after some or all of
    // that group is deselected. Moving the reading cursor does not select it.
    if(added)setRecentSelectedMessageIds([...new Set(draftUnits.map(unit=>unit.messageId))]);
  },[draftUnits]);
  useEffect(()=>setRecentSelectedMessageIds([]),[scopeMessageId,loadedExport]);
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

  // Scroll to message after data loads and renders (also triggers on trace changes for in-place nav).
  // View-switch decisions (graph→list for hidden messages) are made in the auto-classify
  // effect above; this effect only handles the actual scrolling.
  useEffect(() => {
    if (!loading && !autoClassifyMsgId && pendingScrollMsgRef.current && messages.some(m => m.id === pendingScrollMsgRef.current)) {
      // A pending navigation may target a JOIN record itself. Do not resolve
      // it to the joined target; the JOIN card is the requested destination.
      const dependencyIds = pendingScrollDependencyIdsRef.current;
      pendingScrollDependencyIdsRef.current = [];
      const onComplete = pendingScrollCompletionRef.current;
      pendingScrollCompletionRef.current = undefined;
      scrollMsgToCenter(pendingScrollMsgRef.current, { dependencyIds, onComplete });
      pendingScrollMsgRef.current = null;
    }
  }, [loading, autoClassifyMsgId, messages, classifyKey, traceKey, scrollKey, viewMode]);

  useEffect(() => {
    const pendingNavigation = pendingCorrectionNavigationRef.current;
    if (!pendingNavigation || correctionFilterTargetId !== null) return;
    const targetExists = messagesRef.current.some(message => message.id === pendingNavigation.messageId)
      || relationsRef.current.some(relation => relation.id === pendingNavigation.messageId);
    if (!targetExists) return;
    pendingCorrectionNavigationRef.current = null;
    handleNavigateToMessage(pendingNavigation.messageId, { recordHistory: false });
  }, [correctionFilterTargetId, viewMode, loading, messages, edges, relations, scrollKey]);

  useEffect(() => () => {
    pendingScrollCompletionRef.current?.(false,true);
    pendingReadingLoadRef.current?.reject(new DOMException('消息页面已关闭','AbortError'));
    if (messagePulseTimerRef.current) clearTimeout(messagePulseTimerRef.current);
    if (messagePulseRafRef.current) cancelAnimationFrame(messagePulseRafRef.current);
  }, []);
  const [traceDepths,setTraceDepths]=useState<TraceDepths>(()=>({...DEFAULT_TRACE_DEPTHS}));
  const traceDistance=Math.max(traceDepths.up,traceDepths.down);
  const traceDirection:TraceDirection=traceDepths.up===0?'down':traceDepths.down===0?'up':'both';
  const setTraceDistance=useCallback((update:React.SetStateAction<number>)=>setTraceDepths(previous=>{
    const distance=typeof update==='function'?update(Math.max(previous.up,previous.down)):update;
    return {up:distance,down:distance};
  }),[]);
  const [readingOrder,setReadingOrder]=useState<ReadingOrder>('discussion');
  const [readingFocusId,setReadingFocusAnchorId]=useState<string|null>(null);
  const [readingMessageIds,setReadingMessageIds]=useState<string[]>([]);
  function setReadingFocusId(id:string|null){setReadingFocusAnchorId(id);setReadingMessageIds(id?[id]:[]);}
  const [readingDecorationExpansion,setReadingDecorationExpansion]=useState({requestId:0,messageIds:[] as string[]});
  const [readingNavigation,setReadingNavigation]=useState<ReadingNavigationMarkers>({current:null,previous:null,next:null});
  const changeReadingNavigation=useCallback((next:ReadingNavigationMarkers)=>setReadingNavigation(previous=>
    JSON.stringify(previous)===JSON.stringify(next)?previous:next),[]);
  const [readingAnchorId,setReadingAnchorId]=useState<string|null>(null);
  const [temporaryReadingIds,setTemporaryReadingIds]=useState<Set<string>>(()=>new Set());
  const changeTraceDepth = useCallback((side:keyof TraceDepths,value:number) => {
    setTraceDepths(current=>({...current,[side]:Math.max(0,Math.min(8,Math.floor(value)||0))}));
    const starts=traceEntries.at(-1)?.ids??[];
    const category=starts.length===1&&messagesRef.current.find(message=>message.id===starts[0])?.relationType==='classify'?starts[0]:null;
    // Preserve the selected classification as the message-range seed, while
    // discarding expansions introduced only by the previous distance.
    setTraceExpandedFrameIds(new Set(category?[category]:[]));
    setLastClickedMessageId(null);
    setTraceKey(key => key + 1);
  }, [traceEntries]);
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
    compareCurrent?:boolean;
    reversePreview?: {
      before: string;
      after: string;
      target: UnitSelection;
      mode?: 'direct';
      label?: string;
      value?: Json; correctionKind?: 'TEXT' | 'MEANING';
    };
  } | null>(null);
  const reviewedMessage=useMemo(()=>{
    if(recordCategory?.label!=='审核')return;
    if(review.target)return reviewTargetMessage({...review.target,moderation:review.detail?.summary??review.target.moderation});
    if(review.detail||review.error)return;
    const current=messages.find(message=>message.id===recordCategory.targetId);
    if(current&&(!recordCategory.revision||current.revision===recordCategory.revision)
      &&(current.restricted||!current.moderation||['pending','approved'].includes(current.moderation.status)))return current;
  },[review.target,review.detail,review.error,messages,recordCategory?.label,recordCategory?.targetId,recordCategory?.revision]);
  useEffect(()=>{
    if(!review.detail||sendPreviewPages)return;
    const ids=review.records.map(record=>record.id);
    setRecordCategory(current=>current?.label==='审核'&&current.targetId===review.messageId&&current.revision===review.revision
      &&(current.recordIds.length!==ids.length||current.recordIds.some((id,index)=>id!==ids[index]))?{...current,recordIds:ids}:current);
  },[review.detail,review.records,review.messageId,review.revision,sendPreviewPages]);
  const recordCategoryMessageIds=useMemo(()=>{
    if(!recordCategory)return;
    if(recordCategory.label!=='审核')return new Set(recordCategory.recordIds);
    if(review.lostReadAccess||review.target?.restricted)return new Set([recordCategory.targetId]);
    const current=activeReviewContext&&review.detail&&!review.lostReadAccess&&!review.target?.restricted
      ?selectReviewDiscussion(messages.filter((message):message is DemoMessage&{parts:import('@gonglun/core').Part[]}=>!!message.parts),activeReviewContext,review.detail.summary.caseId).map(message=>message.id):[];
    const hidden=new Set(messages.filter(isReviewProcessRecord).map(message=>message.id));
    return new Set([recordCategory.targetId,...recordCategory.recordIds,...current].filter(id=>!hidden.has(id)));
  },[recordCategory,activeReviewContext,review.detail?.summary.caseId,review.lostReadAccess,review.target?.restricted,messages]);
  const visibleCorrectionVersions=useMemo(()=>{
    if(recordCategory?.label!=='审核')return correctionVersions;
    const versions=new Map(correctionVersions);versions.delete(recordCategory.targetId);return versions;
  },[correctionVersions,recordCategory?.label,recordCategory?.targetId]);
  const correctionCompareTimerRef=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>()=>{if(correctionCompareTimerRef.current)clearTimeout(correctionCompareTimerRef.current);},[]);
  const [mergeInfoPopup, setMergeInfoPopup] = useState<{
    relMsgId: string;
    x: number; y: number;
  } | null>(null);
  const [minSelfStake, setMinSelfStake] = useState(1);
  const recommendationRef = useRef(0);
  const viewedCorrectionsRef=useRef(correctionVersions);viewedCorrectionsRef.current=correctionVersions;
  recommendationRef.current = typeof recommendationAmount === 'number' ? recommendationAmount : 0;
  const contributionRef=useRef<(type:string)=>ContributionDraft>(()=>({truth:1,value:0}));
  const reviewMinimumRef=useRef(2);
  contributionRef.current=type=>contributionFor(type,composer.contributions,{
    truth:type==='REVIEW'?reviewMinimumRef.current:type==='TEXT'?stakeAmount:type===primaryContributionType(relationType,secondaryRelationType)?relStakeAmount:1,
    value:type===primaryContributionType(relationType,secondaryRelationType)?recommendationAmount:0,
  });
  const textRecommendationRef=useRef(0);
  textRecommendationRef.current=Number(contributionRef.current('TEXT').value)||0;
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
  const [onlineAvailablePoints, setAvailablePoints] = useState(100);
  const availablePoints = localMessageData ? Number.MAX_SAFE_INTEGER : onlineAvailablePoints; // Phase 2: balance cap
  const [sendError, setSendErrorState] = useState<string | null>(null);
  const setSendError = useCallback<React.Dispatch<React.SetStateAction<string | null>>>(error => {
    // Composer actions can report validation errors after staging a text message.
    // A failed relation must also prevent that text from being saved on its own.
    if (typeof error === 'string' && error) localDraftRef.current?.cancel(new Error(error));
    setSendErrorState(error);
  }, []);
  const [sendInFlight, setSendInFlight] = useState(false);
  const sendingProgress = useWorkbenchSendingProgress(sendInFlight, localMessageData ? 'local' : 'server');
  const sendInFlightRef = useRef(false);
  const sentMessageTargetsRef = useRef<string[]>([]);
  const sentMessageRelatedViewsRef = useRef(new Set<string>());
  const [sentMessageTargets, setSentMessageTargets] = useState<string[]>([]);
  const activeSentMessageRef = useRef<string | null>(null);
  const sentMessagePlacementRef = useRef<ReturnType<typeof beginPositioning> | null>(null);

  useLayoutEffect(() => {
    // Keep one owner across snapshot arrival, navigation retries and overlay commits.
    // Individual positioning attempts may finish before a placement JOIN arrives.
    if (sentMessageTargets.length > 0) {
      if (sentMessagePlacementRef.current) return;
      const task = beginPositioning();
      sentMessagePlacementRef.current = task;
      task.onCancel(() => {
        if (sentMessagePlacementRef.current !== task) return;
        sentMessagePlacementRef.current = null;
        activeSentMessageRef.current = null;
        setSentMessageTargets([]);
        scrollRequestIdRef.current++;
        cancelScrollRafs();
        cancelViewNavigation();
        setSendError('消息已发送，但绘制或定位尚未完成，请核对消息记录，勿重复发送。');
      });
    } else {
      sentMessagePlacementRef.current?.complete();
      sentMessagePlacementRef.current = null;
    }
  }, [sentMessageTargets.length, beginPositioning]);
  useLayoutEffect(() => () => { sentMessagePlacementRef.current?.cancel(); }, []);

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
    // Reading annotations update the target's marker and active filters in place.
    if (target.relationType === 'read' || target.relationType === 'unread') { advance(); return; }
    // A committed review opens its target's summary without locating a hidden feed card.
    if (isReviewDiscussion(target)) {
      const reference=reviewRecordTarget(target);
      if(reference)reviewNavigator.current(reference.messageId,reference.revision);
      advance();return;
    }
    // A width edit has already updated the selected card in place.
    if (target.relationType === 'correct' && target.relationPayload?.correctionKind === 'WIDTH') { advance(); return; }
    // Votes on JOIN/correction update the selected structure in place.
    const isInPlaceStance = ['agree', 'disagree'].includes(target.relationType ?? '')
      && [...target.targetRefs ?? [], ...target.declaredTargetRefs ?? [],
        ...(target.executedStance?.target ? [{kind:'message' as const,messageId:target.executedStance.target.messageId}] : [])].some(ref => {
        const id = ref.kind === 'relation' ? ref.relationId : ref.messageId;
        return messages.some(message => message.id === id && (message.kind === 'join' || ['join', 'correct'].includes(String(message.relationType))));
      });
    if (isInPlaceStance) { advance(); return; }
    activeSentMessageRef.current = sentMessageTarget;
    if (!renderedMessageIdsRef.current.has(sentMessageTarget)) setHomeFilterMode(null);
    handleNavigateToMessage(sentMessageTarget, { select: false, preserveScope: true,
      onComplete: located => {
        if (activeSentMessageRef.current !== sentMessageTarget) return;
        // Prepare the next target immediately; its overlay replaces this one
        // as soon as it is ready, without waiting for the display timer.
        if (located) advance();
        else {
          // A failed label lookup can also be a rendering bug in the same scope.
          // Show its related context once, then retry the actual message label.
          if (['reference', 'reply', 'annotation', 'agree', 'disagree'].includes(target.relationType ?? '')) {
            if (!sentMessageRelatedViewsRef.current.has(sentMessageTarget)) {
              sentMessageRelatedViewsRef.current.add(sentMessageTarget);
              void viewRelatedRelation(sentMessageTarget).then(opened => {
                if (activeSentMessageRef.current !== sentMessageTarget) return;
                if (opened) {
                  activeSentMessageRef.current = null;
                  setSentMessageTargets(queue => [...queue]);
                } else {
                  advance();
                  setSendError('消息已发送，暂时未能完成定位，可通过消息 ID 查看。');
                }
              });
              return;
            }
            advance();
            setSendError('消息已发送，暂时未能完成定位，可通过消息 ID 查看。');
            return;
          }
          // Placement JOINs can arrive in a later snapshot. Keep this target
          // queued until that render rather than silently dropping the message.
          activeSentMessageRef.current = null;
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
  const [settlementOpenType, setSettlementOpenType] = useState<'TRUTH' | 'VALUE' | 'REVIEW' | null>(null);
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
  const openSettlement = useCallback((msgId: string, type: 'TRUTH' | 'VALUE' | 'REVIEW' = 'TRUTH') => {
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
  const leaderboardRef = useRef<LeaderboardHandle>(null);
  const openLeaderboard = useCallback(() => leaderboardRef.current?.open(), []);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [confirmStandaloneSend, setConfirmStandaloneSend] = useState(false);

  const showAlert = useCallback((message: string) => {
    if (sendInFlightRef.current) { if (localDraftRef.current) localDraftRef.current.cancel(new Error(message)); else api.cancelCommandBatch(new Error(message)); }
    setAlertMessage(message);
  }, []);

  const requestedViewerScope = {
    classificationId: classifyRelMsgId,
    ...(onDemand && !isPreloaded ? { viewMode, bodyPaging: !recordCategory && !joinFilterTargetId && !correctionFilterTargetId } : {}),
    ...(onDemand && !isPreloaded ? { pinnedIds: [...(lastClickedMessageId ? [lastClickedMessageId] : []), ...sendPreviewMessageIds ?? []] } : {}),
    ...(traceEntries.length ? { trace: { ids: traceEntries.at(-1)!.ids, depths: traceDepths,
      expandedIds: [...traceExpandedFrameIds].sort() } } : {}),
    full: cleanMode || homeFilterMode !== null || comparisonMode || comparisonReviewed
      || previewClassifyId !== null || containerPreviewId !== null || isTemporaryFrameCategory,
    includeJoinRecords: !msgFilter.hideJoin,
    recordIds: [...(recordCategory?.label==='审核'&&!isPreloaded?[recordCategory.targetId]:recordCategoryMessageIds ?? []), ...(joinFilterTargetId
      ? viewerStructure?.joinRecordIds(joinFilterTargetId, joinFilterDirection) ?? [] : [])],
    extraIds: [...new Set([...draftUnits, ...sourceUnits, ...targetUnits].map(unit => unit.messageId))],
  };
  const requestedViewerScopeKey = structuralScopeKey(requestedViewerScope);
  const scopedViewerSource = useRef<typeof loadedExport>(null);
  useLayoutEffect(() => {
    if (!viewerStructure) return;
    // The first projection has already loaded the saved navigation. Wait for
    // its restore above to install the category state before requesting a layer.
    if (scopedViewerSource.current !== loadedExport) { scopedViewerSource.current = loadedExport; return; }
    void loadViewerScope(requestedViewerScope).catch(error => showAlert(error instanceof Error ? error.message : '分类加载失败'));
  }, [loadedExport, viewerStructure, requestedViewerScopeKey, loadViewerScope, showAlert]);

  function renderAlertMessage(message: string): React.ReactNode {
    return runRenderAlertMessage({ handleNavigateToMessage }, message);
  }

  const mergeStakeSnapshot = useCallback((messageId: string, stakes: MessageStakes) => {
    setMessages(previous=>{
      const message=previous.find(message=>message.id===messageId);if(!message)return previous;
      const authorInvestment=messageAuthorInvestment(message,stakes);
      if(JSON.stringify(message.authorInvestment)===JSON.stringify(authorInvestment))return previous;
      return previous.map(item=>item.id===messageId?{...item,authorInvestment}:item);
    });
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
  }, [setMessages]);

  async function blockCorrectionForSecondBettor(messageId: string): Promise<boolean> {
    if (localMessageData) return false;
    return runBlockCorrectionForSecondBettor({ mergeStakeSnapshot, showAlert }, messageId);
  }

  // Phase 5: Refs to avoid stale closure in points-navigate handler
  // (initialized empty; values synced via useEffect below after all useMemos run)
  const traceEntriesRef = useRef<TraceEntry[]>([]);
  const classifyRelMsgIdRef = useRef<string | null>(null);
  const relationsRef = useRef<Relation[]>([]);
  const relationByIdRef = useRef<Map<string, Relation>>(new Map());
  const relationTypeByRelMsgIdRef = useRef<Map<string, string>>(new Map());
  const navigateToMessageRef = useRef<((messageId:string)=>void)|null>(null);

  // Phase 5: Listen for points-navigate custom event (in-place navigation from PointsBadge)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        messageId: string; scopeMessageId: string; roundId: string | null; txType: string;
        txData?: Record<string, unknown> | null; username?: string;
      };
      const { messageId, roundId, txType, txData, username } = detail;

      setActiveTextSelectId(null);
      if (roundId) sessionStorage.setItem('settlementHighlightRound', roundId);

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
      // Use the shared resolver: ledger sources may be hidden settlement records
      // or messages that have not been loaded into the current scope yet.
      navigateToMessageRef.current?.(messageId);
    };

    window.addEventListener('points-navigate', handler);
    return () => window.removeEventListener('points-navigate', handler);
  }, []);

  // Transitive vote stats drive both canvas visibility and JOIN recovery cost.
  const voteStats = useMemo(
    () => computeTransitiveVoteStats(edges, messages),
    [edges, messages]
  );
  // Keep the entering view's scope when the chooser replaces its canvas.
  // Only relations whose effects change the view can be compared.
  const comparisonScopeMessageIds = comparisonOrigin.current?.messageIds;
  const comparisonTargets = useMemo(
    () => messages.filter(message => {
      if (!comparisonScopeMessageIds?.has(message.id) || !hasComparisonDisplayEffect(message)) return false;
      const stats = voteStats[message.id];
      return Math.max(stats?.agreeCount ?? 0, message.state?.supportCount ?? 0)
        + Math.max(stats?.disagreeCount ?? 0, message.state?.oppositionCount ?? 0) > 0;
    }),
    [messages, voteStats, comparisonScopeMessageIds],
  );
  const comparisonTargetIds = useMemo(() => new Set(comparisonTargets.map(message => message.id)), [comparisonTargets]);
  const comparisonRecommendedDisplay = useMemo(() => {
    if (!comparisonTargetId) return 'agree' as const;
    const statistics = deriveContainerEffect({messages,relations,edges,username:null,stakeCounts});
    const joinStatus = statistics.context.joinStatusByMessage.get(comparisonTargetId);
    const inactive = joinStatus ? joinStatus !== 'valid' : statistics.suppressed.has(comparisonTargetId);
    return inactive ? 'disagree' as const : 'agree' as const;
  }, [messages,relations,edges,stakeCounts,comparisonTargetId]);
  const containerEffect = useMemo(() => {
    const effect = deriveContainerEffect({messages,relations,edges,username:displayUser?.username??null,stakeCounts});
    if (viewerStructure) {
      effect.ownership.memberCounts = viewerStructure.memberCounts;
      effect.context.getMemberCounts = viewerStructure.memberCounts;
    }
    return effect;
  },[messages,relations,edges,displayUser?.username,stakeCounts,viewerStructure]);
  const effectiveSuppressedRelIdsForLayout = containerEffect.suppressed;
  const rejectedContainerIds = containerEffect.rejectedContainerIds;
  const rejectedJoinRelationIds = containerEffect.rejectedJoinRelationIds;
  const frameScopeIds=useMemo(()=>{
    const entry=[...classifyStackRef.current].reverse().find(item=>item.frameScopeIds);
    if(!entry?.frameScopeIds)return undefined;
    const captured=new Set(entry.frameScopeIds),known=new Set(entry.frameKnownIds??[]);
    // Keep the entered range, while allowing new members and their records to
    // appear through the live membership model.
    const candidates=containerEffect.messages.filter(message=>captured.has(message.id)||!known.has(message.id));
    return new Set(expandedFrameScope(entry.relMsgId,candidates,containerEffect.traceEdges));
  },[classifyKey,currentClassifyRelMsgId,containerEffect]);
  useLayoutEffect(() => {
    if (loading || !autoClassifyMsgId) return;
    const target=messages.find(message=>message.id===autoClassifyMsgId);
    if(isSettlementRecord(target)||target?.kind==='join'){
      // Initial URL navigation must use the same record entry as an in-app link.
      setAutoClassifyMsgId(null);
      handleNavigateToMessage(autoClassifyMsgId,{recordHistory:false});
      return;
    }
    // Locate in the same effective, innermost scope that renders the message.
    // Historical target declarations may still mention members moved elsewhere.
    const containerId = findContainingClassification(autoClassifyMsgId);
    if (containerId !== classifyRelMsgId) {
      if (classifyRelMsgId) exitClassification({ restoreSnapshot: false });
      if (containerId) enterClassification(containerId, false);
      else setClassifyRelMsgId(null);
    }
    if (hiddenInGraphView.has(autoClassifyMsgId)) setViewMode('list');
    setAutoClassifyMsgId(null);
  }, [loading, autoClassifyMsgId, containerEffect, hiddenInGraphView]);

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
    if (sourceUnits.length !== 1) return null;
    const source = relations.find(relation => relation.id === sourceUnits[0].messageId);
    return source?.relationType?.toUpperCase() === relationType.toUpperCase() ? relationType.toUpperCase() : null;
  })();
  const joinOnlyAction = appendContainerType !== null;
  const reclassificationJoinCount = useMemo(() => deriveReclassificationJoinCount({ relationType, draftUnits, targetUnits, relations, rejectedJoinRelationIds }), [relationType, draftUnits, targetUnits, relations, rejectedJoinRelationIds]);

  const costContext=useMemo(()=>contributionContext({relationType,draftUnits,targetUnits,sourceUnits,relations,containerEffect,joinOnlyAction}),
    [relationType,draftUnits,targetUnits,sourceUnits,relations,containerEffect,joinOnlyAction]);
  const { effectiveMinStake, totalConsumption: onlineConsumption, stakeFeeAmountRef,setProtocolFee,setReviewPolicy,reviewMinimum } = useStakeCalculation({
    relationType, secondaryRelationType, subType, ...costContext, sourceUnits, newMessageContent: joinOnlyAction ? '' : newMessageContent,
    stakeAmount, relStakeAmount, recommendationAmount, relationStakeMap, subTypeStakeMap,
    contributions:composer.contributions,scopeParentId:compositionParentId,
    existingJoinCount,
    joinOnlyAction,
    reclassificationJoinCount,
    onRelStakeChange: (min) => { setMinSelfStake(min); setRelStakeAmount(min); },
    stakeDefaultLoaded,
  });
  const totalConsumption = localMessageData && onlineConsumption ? { ...onlineConsumption, contributionError: null, total: 0 } : onlineConsumption;
  reviewMinimumRef.current=reviewMinimum;

  useEffect(() => {
    if (!settlementOpenMsgId) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Keep panel open if clicking inside it or on the settlement toggle buttons
      if (
        target.closest('[data-settlement-panel]') ||
        target.closest('[data-settlement-toggle-truth]') ||
        target.closest('[data-settlement-toggle-value]') ||
        target.closest('[data-settlement-toggle-review]') ||
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
    if (isViewerRoute || preloadedData) return;
    const update = () => {
      Promise.all([
        api.getPointsBalance(),
        api.getCurrentRules().catch(() => null),
      ]).then(([b, rule]) => {
        const feeAmount=rule?.parameters?.protocolFee??rule?.parameters?.stakeFeeAmount;
        if(typeof feeAmount==='number'&&Number.isSafeInteger(feeAmount)&&feeAmount>=0)setProtocolFee(feeAmount);
        if(rule?.parameters?.moderation)setReviewPolicy(rule.parameters.moderation as import('@gonglun/core').ModerationPolicy);
        setAvailablePoints(b.points.available);
        // Set initial default from rule on first load only
        if (!stakeDefaultLoaded.current) {
          const defaultStake = 1;
          relationStakeMap.current = {};
          subTypeStakeMap.current = {};
          setMinSelfStake(1);
          setStakeAmount(Math.max(0, Math.min(defaultStake, b.points.available)));
          stakeDefaultLoaded.current = true;
        } else {
          // Clamp to available on refresh
          setStakeAmount(prev => {
            if (typeof prev !== 'number') return prev;
            return Math.max(0, Math.min(prev, Math.max(0, b.points.available)));
          });
        }
      }).catch(() => { });
    };
    update();
    window.addEventListener('points-refresh', update);
    return () => window.removeEventListener('points-refresh', update);
  }, [isViewerRoute, !!preloadedData]);

  // Listen for stake count refreshes (triggered after vote/settle)
  useEffect(() => {
    if (isViewerRoute || preloadedData) return;
    const handler = (e: Event) => {
      const messageId = (e as CustomEvent<{ messageId?: string }>).detail?.messageId;
      if(!messageId)return;
      if (!isPreloaded) api.getMessageStakes(messageId).then(s => {
        mergeStakeSnapshot(messageId, s);
      }).catch(() => { });
    };
    window.addEventListener('stakes-refresh', handler);
    return () => window.removeEventListener('stakes-refresh', handler);
  }, [mergeStakeSnapshot, isViewerRoute, !!preloadedData]);

  const currentTraceEntry = traceEntries.length > 0 ? traceEntries[traceEntries.length - 1] : null;
  const currentTraceIds = currentTraceEntry?.ids ?? null;
  const standaloneMessageIds=useMemo(()=>currentTraceIds||readingMessageIds.length?new Set([...currentTraceIds??[],...readingMessageIds]):undefined,[currentTraceIds,readingMessageIds]);
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
    const upsert = <T extends {id:string}>(items:T[], item:T) => items.some(value=>value.id===item.id)
      ? items.map(value=>value.id===item.id?item:value) : [...items,item];
    relationsRef.current=upsert(relationsRef.current,backendRel);
    setRelations(prev=>upsert(prev,backendRel));
    setMessages(prev=>upsert(prev,buildRelationDemoMessage(backendRel)));
    const relType = backendRel.relationType?.toUpperCase();
    const targetMsgIds: string[] = [];
    if (relType === 'AGREE' || relType === 'DISAGREE' || relType === 'RECOMMEND' || relType === 'ARCHIVE' || relType?.startsWith('REVIEW') || backendRel.payload?.annotationStance) {
      const executedTarget=backendRel.executedStance?.target.messageId;
      if(executedTarget)targetMsgIds.push(executedTarget);
      targetMsgIds.push(...backendRel.targetRefs
        .filter((ref) =>
          (ref.kind === 'message' || ref.kind === 'text-fragment') && 'messageId' in ref)
        .map(ref => (ref as { messageId: string }).messageId));
      targetMsgIds.push(...backendRel.targetRefs
        .filter((ref): ref is { kind: 'relation'; relationId: string } =>
          ref.kind === 'relation' && 'relationId' in ref)
        .map(ref => ref.relationId));
      // Publish the returned stance or annotation immediately, including relation targets.
      const srcMsgId = backendRel.sourceMessageId ?? null;
      const fromMsgId = srcMsgId || `anon:${backendRel.id}`;
      for (const ref of backendRel.targetRefs) {
        const edge: DemoEdge = {
          id: nextId("edge"),
          relationMessageId: backendRel.id,
          relationType: relType.toLowerCase() as RelationType,
          from: backendRel.sourceRefs?.[0] ? referenceToUnit(backendRel.sourceRefs[0]) : { messageId: fromMsgId, selection: { kind: "whole" } },
          to: targetRefToUnit(ref),
          relationLabel: backendRel.payload?.label || relationTypeName(relType.toLowerCase()),
        };
        setEdges(prev => prev.some(existing => existing.relationMessageId === backendRel.id
          && selKey(existing.to) === selKey(edge.to)) ? prev : [...prev, edge]);
      }
    }
    // Self-stake amount for the relation message itself
    const rawPayload2 = (backendRel as unknown as Record<string, unknown>).relationPayload
      ?? backendRel.payload;
    const relPayload2 = rawPayload2 as Record<string, unknown> | null;
    const selfStake = targetInvestmentDimension(relType??'')?0:backendRel.spending?.wager??(relPayload2?.amount as number)??relStakeRef.current;
    setAuthorStakes(prev => ({ ...prev, [backendRel.id]: selfStake }));
    // Re-fetch stakeCounts from backend (authoritative, avoids client-side sync issues)
    const allIds = [backendRel.id, ...targetMsgIds];
    for (const mid of allIds) {
      if (!isPreloaded) api.getMessageStakes(mid).then(s => {
        mergeStakeSnapshot(mid, s);
      }).catch(() => { });
    }
    if (!isPreloaded) window.dispatchEvent(new Event('points-refresh'));
    // Notify SettlementPanel to reload stakes for target messages
    for (const mid of targetMsgIds) {
      window.dispatchEvent(new CustomEvent('stakes-refresh', { detail: { messageId: mid } }));
    }
    return Promise.resolve(null);
  }, [scopeMessageId, mergeStakeSnapshot, isPreloaded]);

  const createRel = useCallback(async (scopeMessageId: string, data: Parameters<typeof api.createRelation>[1]) => {
    if ((isViewerRoute || preloadedData) && !localMessageData) throw new Error('阅览文件只能在本地调整关系');
    const type = data.relationType.toLowerCase();
    const join=contributionRef.current('JOIN');
    const currentMessages = new Map(messagesRef.current.map(message => [message.id, message]));
    const selectedSources = sourceUnitsRef.current.filter(unit => unit.messageId === data.sourceMessageId);
    const sourceRefs = (data.sourceRefs ?? (selectedSources.length
      ? selectedSources.map(unit => unitSelectionToReference(unit, currentMessages))
      : data.sourceMessageId ? [{ messageId: data.sourceMessageId }] : [])).map(ref=>bindViewedReference(ref,type,currentMessages.get(ref.messageId),viewedCorrectionsRef.current.get(ref.messageId)?.current,true));
    const targetRefs = data.targetRefs.map(ref => ref.reference ? ref : {
      ...ref,
      reference: ['classify', 'summary', 'merge', 'arrange', 'join'].includes(type) && ref.kind !== 'text-fragment'
        ? { messageId: ref.kind === 'relation' ? ref.relationId : ref.messageId }
        : unitSelectionToReference(targetRefToUnit(ref), currentMessages),
    }).map(ref=>({...ref,reference:bindViewedReference(ref.reference!,type,currentMessages.get(ref.reference!.messageId),viewedCorrectionsRef.current.get(ref.reference!.messageId)?.current)}));
    const effectiveType=targetRefs.length===1?contributionTypeForTarget(type,currentMessages.get(targetRefs[0]!.reference!.messageId),targetRefs[0]!.reference!,(id,revision)=>{const message=currentMessages.get(id);return message?.parts&&(!revision||message.revision===revision)?message as unknown as import('@gonglun/core').Message:undefined;}):type.toUpperCase();
    if(['READ','UNREAD'].includes(effectiveType))throw new Error('已阅是个人查看状态，请在消息提示中标记已阅');
    const investment=contributionRef.current(effectiveType);
    const explicit=!sendInFlightRef.current?{[effectiveType]:{truth:data.wager??data.stakeAmount??investment.truth,value:data.recommendation??investment.value}}:undefined;
    const normalizedInvestment=contributionFor(effectiveType,explicit,investment);
    const amount=Number(normalizedInvestment.truth)||0,value=Number(normalizedInvestment.value)||0;
    if (type === 'disagree') for (const ref of targetRefs) {
      const target = currentMessages.get(ref.reference!.messageId);
      const error = target && annotationStanceError(target, ref.reference!);
      if (error) throw new Error(error);
    }
    if (localMessageData) {
      const relation = await localWrite(draft => draft.createRelation(classifyRelMsgIdRef.current ?? scopeMessageId, { ...data, sourceRefs, targetRefs }));
      if (sendInFlightRef.current && type !== 'join') recordSentMessage(relation.id);
      return relation;
    }
    try {
      const relation = await api.createRelation(activeReviewContext?compositionParentId:classifyRelMsgIdRef.current ?? scopeMessageId, {
        ...data, targetRefs, sourceRefs, stakeAmount: 0,
        wager: effectiveType==='REVIEW'?0:amount, ...(effectiveType==='REVIEW'?{reviewWager:amount}:{}),selfAgree: effectiveType!=='REVIEW' && type !== 'agree' && type !== 'disagree' && amount > 0,
        recommendation:value,
        ...((Number(join.truth)||Number(join.value))?{joinContribution:data.joinContribution??{wager:Number(join.truth)||0,recommendation:Number(join.value)||0}}:{}),
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
  }, [logout, navigate, isViewerRoute, preloadedData,activeReviewContext,compositionParentId,localMessageData,viewerUser?.username]);

  // Vote results include truth stances and value annotations.
  useEffect(() => {
    if (isViewerRoute || preloadedData) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Relation>).detail;
      if (detail && detail.id && detail.relationType) {
        appendCreatedRelation(detail);

      }
    };
    window.addEventListener('relation-created', handler);
    return () => window.removeEventListener('relation-created', handler);
  }, [appendCreatedRelation, isViewerRoute, !!preloadedData]);

  const embeddedMessageIds = useMemo(() => new Set(messages.filter(message=>presentationTarget(message)).map(message=>message.id)),[messages]);

  const effectiveJoinRelationIds = containerEffect.effectiveJoinIds;

  const joinRelationsByTarget = useMemo(() => indexJoinRelationsByTarget(viewerStructure?.joinRelations ?? relations), [relations, viewerStructure]);
  const joinRelationsBySource = useMemo(() => {
    const map = new Map<string, Relation[]>();
    for (const relation of viewerStructure?.joinRelations ?? relations) {
      if (relation.relationType?.toUpperCase() !== 'JOIN' || !relation.sourceMessageId) continue;
      const existing = map.get(relation.sourceMessageId) ?? [];
      existing.push(relation);
      map.set(relation.sourceMessageId, existing);
    }
    return map;
  }, [relations, viewerStructure]);

  const traceContainerMemberships = containerEffect.memberships;

  const readStatusByMessageId = useMemo(() => {
    const currentUserId = isPreloaded ? null : user?.id;
    const currentUsername = displayUser?.username;
    if (!currentUserId && !currentUsername) return new Map<string, 'READ' | 'UNREAD'>();
    const status=new Map<string,'READ'|'UNREAD'>();
    const bodies=new Map(messages.map(message=>[message.id,messageReadingKey(message.id)]));
      for(const mark of readingState.marks)if(mark.format===3&&mark.scope==='message'&&!mark.unknownContext){
      if(bodies.get(mark.messageId)===mark.bodySignature)status.set(mark.messageId,mark.state==='UNREAD'?'UNREAD':'READ');
    }
    return status;
  }, [displayUser?.username, isPreloaded, relations, user?.id,readingState.marks,messages,edges,personalCorrectionVersions]);

  const isRelatedView = traceEntries.some(entry => entry.relatedView);
  // The unread/home filter describes the view we came from. An explicit related
  // view must retain both endpoints, including already-read context messages.
  const homeFilterResult = useMemo(() => isRelatedView || homeFilterMode===null ? null : workerFilters ? globalFilters.result?.home ?? null : deriveHomeFilterResult({ displayUser, homeFilterMode, msgMap, messages, readStatusByMessageId, edges, traceContainerMemberships,relations,readingMarks:homeFilterReadingMarks,corrections:personalCorrectionVersions }), [isRelatedView, workerFilters, globalFilters.result, displayUser?.username, displayUser?.id, edges, effectiveSuppressedRelIdsForLayout, homeFilterMode, isPreloaded, messages, msgMap, readStatusByMessageId, relations, traceContainerMemberships, user?.id,homeFilterReadingMarks,personalCorrectionVersions]);
  const homeNavigationRef=useRef({mode:homeFilterMode,result:homeFilterResult});
  homeNavigationRef.current={mode:homeFilterMode,result:homeFilterResult};

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
  const joinStatusByMessage = viewerStructure?.joinStatusByMessage ?? containerEffect.context.joinStatusByMessage;

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
  const fullContainerOwnership = useMemo(() => collectAllContainerOwnership([...relationById.values()], rejectedJoinRelationIds),
    [relationById, rejectedJoinRelationIds]);
  const classifyOwnership = fullContainerOwnership.classify;

  // Active ownership: only non-rejected CLASSIFY relations.
  // Used by visibility logic — rejected classifies don't hide their messages.
  const activeClassifyOwnership = useMemo(() => containerEffect.ownership.active('CLASSIFY'),[containerEffect]);
  const mergeOwnership = fullContainerOwnership.merge;
  // Full ownership: all SUMMARY relations regardless of approval status.
  const summaryOwnership = fullContainerOwnership.summary;

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
  const { leftPanelRef, rightPanelRef, viewModeScrollRef, TOTAL_FLEX, MIN_LEFT_PX, MIN_RIGHT_PX, MAX_RIGHT_PX, leftFlex, effectiveContainerWidth, splitterActive, panelContainerRef, handleSplitterPointerDown, handleLeftPanelTouchStart, handleLeftPanelTouchMove, handleLeftPanelTouchEnd } = useWorkbenchViewport({ loading });
  useReadingViewportAnchor(leftPanelRef,readingAnchorId);
  const [messagePulse, setMessagePulse] = useState<{ messageId: string; element: HTMLElement; rect: DOMRect } | null>(null);
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
  const positioningTaskRef = useRef<ReturnType<typeof beginPositioning> | null>(null);
  const navigationTaskRef = useRef<ReturnType<typeof beginPositioning> | null>(null);
  const pendingViewportRestoreRef = useRef<{ snapshot: TraceSnapshot } | null>(null);

  function startPositioning() {
    positioningTaskRef.current?.cancel();
    const task = beginPositioning();
    positioningTaskRef.current = task;
    return task;
  }

  function cancelScrollRafs(): void {
    positioningTaskRef.current?.cancel();
    positioningTaskRef.current = null;
    return runCancelScrollRafs({ scrollRafRef, scrollRaf2Ref });
  }

  function cancelViewNavigation(): void {
    const pendingReading=pendingReadingLoadRef.current;
    pendingReadingLoadRef.current=null;
    pendingReading?.reject(new DOMException('已取消消息加载','AbortError'));
    navigationTaskRef.current?.cancel();
    navigationTaskRef.current = null;
    if (viewNavigationTimerRef.current !== null) clearTimeout(viewNavigationTimerRef.current);
    viewNavigationTimerRef.current = null;
    if (messagePulseRafRef.current !== null) cancelAnimationFrame(messagePulseRafRef.current);
    messagePulseRafRef.current = null;
    if (messagePulseTimerRef.current !== null) clearTimeout(messagePulseTimerRef.current);
    messagePulseTimerRef.current = null;
    setMessagePulse(null);
    leftPanelRef.current?.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } }));
  }

  function scheduleViewNavigation(targetId: string, delay = 100): void {
    navigationTaskRef.current?.cancel();
    const task = beginPositioning();
    navigationTaskRef.current = task;
    task.onCancel(() => {
      if (viewNavigationTimerRef.current !== null) clearTimeout(viewNavigationTimerRef.current);
      viewNavigationTimerRef.current = null;
    });
    return runScheduleViewNavigation({ viewNavigationTimerRef, scrollMsgToCenter: id => {
      task.run(() => { scrollMsgToCenter(id); task.complete(); });
    } }, targetId, delay);
  }

  // A new archive/scope must not inherit callbacks positioning the old scene.
  useLayoutEffect(() => {
    setMessagePulse(null);
    return () => {
      scrollRequestIdRef.current++;
      cancelScrollRafs();
      navigationTaskRef.current?.cancel();
      if (viewNavigationTimerRef.current !== null) clearTimeout(viewNavigationTimerRef.current);
      viewNavigationTimerRef.current = null;
      if (messagePulseRafRef.current !== null) cancelAnimationFrame(messagePulseRafRef.current);
      if (messagePulseTimerRef.current !== null) clearTimeout(messagePulseTimerRef.current);
    };
  }, [preloadedData, scopeMessageId]);

  // Check auth before sending: redirect to login if not logged in
  function requireAuth(): boolean {
    if (localMessageData) { if (viewerUser?.username.trim()) return true; setSendError('请先输入本地发言人'); return false; }
    if (isViewerRoute || preloadedData) return false;
    return runRequireAuth({ user, logout, navigate });
  }

  // Handle auth errors: logout and redirect to login
  async function handleAuthError(err: unknown): Promise<boolean> {
    return runHandleAuthError({ logout, navigate }, err);
  }

  // Scroll the left panel canvas so the message with the given ID is centered.
  // Wait for layout, then retry until the target is visible or attempts run out.
  const MAX_SCROLL_ATTEMPTS = 60;
  const highlightedMessageIds=useMemo(()=>new Set(readingMessageIds.length&&traceEntries.length?readingMessageIds:[
    ...currentTraceIds??[],...[containerPreviewId,comparisonReviewed?comparisonTargetId:null,correctionFilterTargetId,joinFilterTargetId].filter((id):id is string=>!!id),
  ]),[readingMessageIds,currentTraceIds,traceEntries.length,containerPreviewId,comparisonReviewed,comparisonTargetId,correctionFilterTargetId,joinFilterTargetId]);
  const viewTargetMessageIds = useMemo(() => new Set([...highlightedMessageIds, ...notificationFocusIds]), [highlightedMessageIds, notificationFocusIds]);

  function showMessagePulse(targetId: string, element: HTMLElement, requestId = scrollRequestIdRef.current, onShown?: (shown: boolean) => void): void {
    return runShowMessagePulse({ task: positioningTaskRef.current, scrollRequestIdRef, messagePulseTimerRef, messagePulseRafRef, leftPanelRef, findMessageElements, setMessagePulse }, targetId, element, requestId, onShown);
  }



  function scrollMsgToCenter(msgId: string, options?: ScrollMessageOptions): void {
    return runScrollMsgToCenter({ startPositioning, scrollRequestIdRef, pendingScrollMsgIdRef, MAX_SCROLL_ATTEMPTS, pendingScrollDependencyIdsRef, leftPanelRef, scrollRafRef, findMessageElements, relationsRef, edgesRef, showMessagePulse, cancelScrollRafs }, msgId, options);
  }

  function hasTraceOverlay(category=recordCategory):boolean{
    return category!==null||joinFilterTargetId!==null||correctionFilterTargetId!==null||containerPreviewId!==null||comparisonMode||comparisonReviewed;
  }

  function captureSnapshot(): TraceSnapshot {
    const viewport = runCaptureSnapshot({ viewMode, leftPanelRef, rightPanelRef, traceDistance, readingAnchorId });
    const pending = pendingViewportRestoreRef.current?.snapshot;
    // React can already show the restored scope while its layout is still
    // pending. Re-entering now must save that scope's intended viewport.
    if (pending?.viewMode === viewMode) {
      viewport.leftScroll = pending.leftScroll;
      viewport.pageScroll = pending.pageScroll;
      viewport.rightScroll = pending.rightScroll;
      viewport.readingViewportAnchor=pending.readingViewportAnchor;
    }
    const classifyStack = [...classifyStackRef.current];
    const temporaryStack = [...temporaryCategoryStackRef.current];
    const previewStack = [...containerPreviewStack.current];
    const expandedFrames = new Set(traceExpandedFrameIds);
    const comparison = comparisonOrigin.current;
    const rules=cleanFilters.map(rule=>({...rule})),skipSender=skipCleanSenderInitRef.current;
    return {
      ...viewport,
      graphFrameViewState:{...(pending?.graphFrameViewState??graphFrameViewStateRef.current)},
      traceDirection,traceDepths:{...traceDepths},readingOrder,readingFocusId,readingMessageIds:[...readingMessageIds],
      readingAnchorId:pending?pending.readingAnchorId??null:readingAnchorId,
      messageFilter:{...msgFilter},overlayView:hasTraceOverlay(currentRecordCategory),
      modeScroll:{graph:viewModeScrollRef.current.graph?{...viewModeScrollRef.current.graph}:null,list:viewModeScrollRef.current.list?{...viewModeScrollRef.current.list}:null},
      displayHintWindow:pending?pending.displayHintWindow??null:displayHintWindow.capture(),
      // Viewport and scope must return together when tracing and temporary
      // categories are entered from one another. Records remain in the store.
      restoreScope: restoreViewState({
        refs: [[classifyStackRef, classifyStack], [temporaryCategoryStackRef, temporaryStack], [containerPreviewStack, previewStack],
          [comparisonOrigin, comparison], [skipCleanSenderInitRef, skipSender], [prevTraceLenRef, traceEntries.length]],
        values: [[setRecordCategory, currentRecordCategory], [setClassifyRelMsgId, classifyRelMsgId], [setHomeFilterMode, homeFilterMode],
          [setTraceDepths, { ...traceDepths }], [setReadingOrder, readingOrder], [setReadingFocusAnchorId, readingFocusId],
          [setReadingMessageIds, [...readingMessageIds]], [setReadingAnchorId, null], [setTemporaryReadingIds, new Set(temporaryReadingIds)],
          [setTraceEntries, traceEntries], [setTraceExpandedFrameIds, expandedFrames], [setPreviewClassifyId, previewClassifyId],
          [setContainerPreviewId, containerPreviewId], [setJoinFilterTargetId, joinFilterTargetId], [setJoinFilterDirection, joinFilterDirection],
          [setCorrectionFilterTargetId, correctionFilterTargetId], [setComparisonMode, comparisonMode], [setComparisonReviewed, comparisonReviewed],
          [setComparisonTargetId, comparisonTargetId], [setComparisonSide, comparisonSide],
          [setComparisonReviewBaseMessages, comparisonReviewBaseMessages], [setComparisonReviewBaseEdges, comparisonReviewBaseEdges]],
        filters: { clear: clearCleanFilters, add: addCleanFilter, rules },
      }),
    };
  }

  function captureBrowsingSnapshot(): TraceSnapshot {
    const snapshot = captureSnapshot();
    const filter = { ...msgFilter }, rules = cleanFilters.map(rule => ({ ...rule }));
    const modeScroll = {
      graph: viewModeScrollRef.current.graph ? { ...viewModeScrollRef.current.graph } : null,
      list: viewModeScrollRef.current.list ? { ...viewModeScrollRef.current.list } : null,
    };
    const skipSender = skipCleanSenderInitRef.current;
    return { ...snapshot, restoreScope: restoreViewState({ before: snapshot.restoreScope,
      values: [[setMsgFilter, filter], [setHomeFilterMode, homeFilterMode]],
      refs: [[skipCleanSenderInitRef, skipSender], [viewModeScrollRef, { ...modeScroll, [snapshot.viewMode]: null }]],
      filters: { clear: clearCleanFilters, add: addCleanFilter, rules },
    }) };
  }

  function restoreBrowsingSnapshot(snapshot: TraceSnapshot): void {
    relatedViewAbortRef.current?.abort();
    setAutoClassifyMsgId(null);
    pendingScrollMsgRef.current = null;
    pendingScrollMsgIdRef.current = null;
    pendingScrollDependencyIdsRef.current = [];
    pendingScrollCompletionRef.current = undefined;
    pendingRemoteNavigationRef.current = null;
    pendingCorrectionNavigationRef.current = null;
    activeSentMessageRef.current = null;
    setSentMessageTargets([]);
    closeSettlement();
    restoreSnapshot(snapshot);
    setClassifyKey(key => key + 1);
    setTraceKey(key => key + 1);
  }

  const browsingHistoryKey = useMemo(() => ({ scopeMessageId, loadedExport, username: displayUser?.username }),
    [scopeMessageId, loadedExport, displayUser?.username]);
  const browsingHistory = useBrowsingHistory(browsingHistoryKey, captureBrowsingSnapshot, restoreBrowsingSnapshot, { browser: true, routeState });
  function recordBrowsingNavigation(url?: string): void { if (!loading) browsingHistory.record(url); }
  const readingHistory = useBrowsingHistory(browsingHistoryKey, captureSnapshot, restoreBrowsingSnapshot);
  function recordReadingNavigation():void {if(!loading&&traceEntries.length&&readingFocusId)readingHistory.record();}
  const historyReadingIds=(snapshot:TraceSnapshot|undefined)=>snapshot?.readingMessageIds??(snapshot?.readingFocusId?[snapshot.readingFocusId]:[]);
  useEffect(()=>setNotificationFocusIds([]),[lastClickedMessageId]);
  useViewedMessageHighlight(leftPanelRef,[...viewTargetMessageIds],traceEntries.length?{
    current:readingMessageIds,previous:historyReadingIds(readingHistory.backSnapshot),next:historyReadingIds(readingHistory.forwardSnapshot),
    continue:readingNavigation.current===readingFocusId?readingNavigation.continue:null,
  }:undefined);

  // Both presentations enter and navigate the same ordinary workbench scope.
  function prepareComparisonReview(targetId:string, view?:{messages:DemoMessage[];edges:DemoEdge[]}):void {
    recordBrowsingNavigation();
    cancelScrollRafs();
    const containingClassifyId=view?null:findContainingClassification(targetId);
    if(containingClassifyId && containingClassifyId!==currentClassifyRelMsgId){
      if(currentClassifyRelMsgId)exitClassification({restoreSnapshot:false});
      enterClassification(containingClassifyId, false);
    }
    closeSettlement();
    setComparisonReviewBaseMessages(view?.messages??(containingClassifyId?null:(isInsideClassify?normalGraphProjection.scopedMessages:normalGraphProjection.messages)));
    setComparisonReviewBaseEdges(view?.edges??(containingClassifyId?null:normalGraphProjection.edges));
    setLastClickedMessageId(targetId);
    setViewMode('graph');
    if (!view) scheduleViewNavigation(targetId, 150);
    pendingViewportRestoreRef.current = null;
  }
  function viewRelatedContainer(id:string):void {
    if(!['classify','summary','arrange','merge'].includes(msgMap.get(id)?.relationType??'')&&!isRejectedRelation(msgMap.get(id),containerPreview?.suppressed??suppressedRelIds))return;
    viewMessageEffect(id);
  }
  function viewMessageEffect(id:string):void {
    if(id===containerPreviewId)return;
    recordBrowsingNavigation();
    containerPreviewStack.current.push({
      id:containerPreviewId,snapshot:captureSnapshot(),filter:{...msgFilter},
      classifyId:classifyRelMsgId,classifyStack:[...classifyStackRef.current],
      traceEntries,expandedFrames:new Set(traceExpandedFrameIds),previewClassifyId,
      baseMessages:comparisonReviewBaseMessages,baseEdges:comparisonReviewBaseEdges,
    });
    const originalId=msgMap.get(id)?.relationType==='correct'?edges.find(edge=>edge.relationMessageId===id&&edge.relationType==='correct')?.to.messageId:undefined;
    prepareComparisonReview(originalId??id);
    resetFrameExpansion();
    setContainerPreviewId(id);
  }
  function exitContainerPreview():void {
    recordBrowsingNavigation();
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



  function restoreSnapshot(s: TraceSnapshot | null, opts?: RestoreSnapshotOptions): void {
    if (!s) return;
    graphFrameViewStateRef.current={...s.graphFrameViewState};
    setFrameViewRestoreKey(value=>value+1);
    displayHintWindow.clear();
    cancelViewNavigation();
    if(opts?.restoreScope!==false&&opts?.restoreMessageFilter!==false&&s.messageFilter)setMsgFilter({...s.messageFilter});
    const pending = { snapshot: s };
    pendingViewportRestoreRef.current = pending;
    const onRestored = () => {
      if (pendingViewportRestoreRef.current === pending) {
        pendingViewportRestoreRef.current = null;
        displayHintWindow.restore(s.displayHintWindow??null);
        setReadingAnchorId(s.readingAnchorId??null);
      }
    };
    const startRestoring = () => {
      const task = startPositioning();
      // A new entry may cancel this task immediately before capturing its
      // origin. Let that synchronous capture consume the intended position;
      // failures and abandoned restores release it at the microtask boundary.
      task.onCancel(() => queueMicrotask(onRestored));
      return task;
    };
    // Switching presentation also restores its per-mode position. The complete
    // snapshot takes precedence over positions recorded inside the category.
    viewModeScrollRef.current = {
      graph:s.modeScroll?.graph?{...s.modeScroll.graph}:null,list:s.modeScroll?.list?{...s.modeScroll.list}:null,[s.viewMode]:null,
    };
    return runRestoreSnapshot({ startPositioning: startRestoring, onRestored, showMessagePulse, scrollRequestIdRef, setTraceDistance, setTraceDepths, setViewMode, cancelScrollRafs, scrollRafRef, scrollRaf2Ref, clampAndSetScroll, leftPanelRef, rightPanelRef }, s, opts);
  }

  function startComparison(): void {
    comparisonChooser.current = null;
    recordBrowsingNavigation();
    cancelViewNavigation();
    cancelScrollRafs();
    const viewMessages = previewMessages ?? graphMessagesFinal;
    const messageIds = comparisonViewMessageIds({
      viewMode, messages: viewMessages, edges: edgesToRender, traceExpandedFrameIds, isTraceWindow: traceEntries.length > 0,
      rejectedContainerIds: containerPreview?.rejectedContainerIds ?? rejectedContainerIds,
      rejectedRelationIds: containerPreview?.suppressed ?? suppressedRelIds, hiddenMessageIds: hideMessageIds,
      catalogMessages: containerPreview?.allMessages ?? containerEffect.messages, catalogEdges: containerPreview?.edges ?? edges,
      standaloneMessageIds: recordCategoryMessageIds ?? correctionTemporaryViewIds ?? standaloneMessageIds,
      showJoinRecords: joinFilterTargetId !== null || recordCategory !== null,
      scopeId: currentClassifyRelMsgId,
    });
    comparisonOrigin.current = {
      snapshot: captureSnapshot(), filter: {...msgFilter},
      classifyId: classifyRelMsgId, classifyStack: [...classifyStackRef.current],
      traceEntries, expandedFrames: new Set(traceExpandedFrameIds),
      previewId: containerPreviewId,
      messages: viewMessages, edges: edgesToRender, messageIds,
    };
    pendingViewportRestoreRef.current = null;
    setContainerPreviewId(null);
    setComparisonMode(true);
    setComparisonReviewed(false);
    setComparisonTargetId(null);
    setComparisonReviewBaseMessages(null);
    setComparisonReviewBaseEdges(null);
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
    recordBrowsingNavigation();
    const origin = comparisonOrigin.current;
    restoreComparisonScope();
    comparisonOrigin.current = null;
    comparisonChooser.current = null;
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

  function returnToComparisonChooser(): void {
    recordBrowsingNavigation();
    const saved = comparisonChooser.current;
    if (saved) {
      restoreSnapshot(saved.snapshot);
      setComparisonTargetId(saved.targetId);
      setLastClickedMessageId(saved.targetId);
      setDraftUnits(saved.selection);
    } else {
      restoreComparisonScope();
      setComparisonReviewed(false); setComparisonMode(true); setViewMode('list');
      setComparisonReviewBaseMessages(null); setComparisonReviewBaseEdges(null);
    }
  }

  function enterTemporaryCategory(force = false): void {
    recordBrowsingNavigation();
    cancelViewNavigation();
    cancelScrollRafs();
    runEnterTemporaryCategory({ joinFilterTargetId, correctionFilterTargetId, comparisonMode, comparisonReviewed, temporaryCategoryStackRef, captureSnapshot, msgFilter, joinFilterDirection, comparisonTargetId, comparisonSide, comparisonReviewBaseMessages, comparisonReviewBaseEdges }, force);
    setRecordCategory(null);
    pendingViewportRestoreRef.current = null;
  }

  function handleJoinRecords(messageId: string, direction: 'incoming' | 'outgoing'): void {
    if (joinFilterTargetId === messageId && joinFilterDirection === direction) { exitTemporaryCategory(); return; }
    enterTemporaryCategory(joinFilterTargetId === null && (comparisonMode || comparisonReviewed || correctionFilterTargetId !== null));
    setMsgFilter(previous => ({ ...previous, hideJoin: false }));
    setComparisonMode(false); setComparisonReviewed(false); setCorrectionFilterTargetId(null);
    setJoinFilterDirection(direction); setJoinFilterTargetId(messageId);
    if(direction==='outgoing')setViewMode('list');
  }

  function exitTemporaryCategory(options?: { restoreMessageFilter?: boolean; recordHistory?: boolean }): void {
    if (options?.recordHistory !== false) recordBrowsingNavigation();
    return runExitTemporaryCategory({ temporaryCategoryStackRef, setMsgFilter, setJoinFilterTargetId, setJoinFilterDirection, setCorrectionFilterTargetId, setComparisonMode, setComparisonReviewed, setComparisonTargetId, setComparisonSide, setComparisonReviewBaseMessages, setComparisonReviewBaseEdges, restoreSnapshot }, options);
  }

  function exitAllTemporaryCategories(options?: { restoreMessageFilter?: boolean }): void {
    setRecordCategory(null);
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

  function restoreExistingTrace(ids:string[]):boolean{
    const identity=[...ids].sort().join('\0');
    const index=traceEntries.findIndex((entry,index)=>{
      if(entry.mode==='scope'||entry.relatedView)return false;
      const snapshot=traceEntries[index+1]?.snapshot;
      if(snapshot?.overlayView)return false;
      return [...entry.ids].sort().join('\0')===identity
        &&JSON.stringify(snapshot?.traceDepths??legacyTraceDepths(snapshot?.traceDistance??traceDistance,snapshot?.traceDirection??traceDirection))===JSON.stringify(traceDepths);
    });
    if(index<0)return false;
    if(index<traceEntries.length-1){recordReadingNavigation();recordBrowsingNavigation();cancelViewNavigation();restoreSnapshot(traceEntries[index+1].snapshot);setTraceEntries(traceEntries.slice(0,index+1));setTraceKey(key=>key+1);}
    return true;
  }
  function suspendTraceOverlay():void{
    setRecordCategory(null);
    // The new trace has its own view; its snapshot retains the origin overlay.
    temporaryCategoryStackRef.current=[];containerPreviewStack.current=[];comparisonOrigin.current=null;
    setJoinFilterTargetId(null);setCorrectionFilterTargetId(null);setContainerPreviewId(null);setPreviewClassifyId(null);
    setComparisonMode(false);setComparisonReviewed(false);setComparisonTargetId(null);setComparisonSide('agree');
    setComparisonReviewBaseMessages(null);setComparisonReviewBaseEdges(null);
  }
  function initializeTraceReading(ids:string[],mode?:'trace'|'scope'):void{
    const id=mode==='scope'?null:ids.find(Boolean)??null;
    setReadingFocusAnchorId(id);setReadingMessageIds(mode==='scope'?[]:[...new Set(ids)]);setReadingAnchorId(null);setTemporaryReadingIds(new Set());
    if(!id)return;
    pendingScrollCompletionRef.current?.(false,true);
    pendingScrollMsgRef.current=id;pendingScrollDependencyIdsRef.current=[];
    pendingScrollCompletionRef.current=located=>{if(located)setReadingAnchorId(id);};
    setScrollKey(key=>key+1);
  }
  function enterTrace(messageId: string, options?: { replace?: boolean; mode?: "trace" | "scope"; scopeRelationMessageId?: string; relatedView?: boolean }): void {
    if(!hasTraceOverlay()&&!options?.replace&&!options?.relatedView&&options?.mode!=='scope'&&restoreExistingTrace([messageId]))return;
    recordReadingNavigation();
    recordBrowsingNavigation();
    if (!isPreloaded && onDemand) void ensureMessages([messageId]).catch(error => showAlert(error.message));
    cancelViewNavigation();
    runEnterTrace({ captureSnapshot, classifyRelMsgId, classifyStackRef, setTraceExpandedFrameIds, setTraceEntries, setClassifyRelMsgId, setClassifyKey, cancelScrollRafs, scrollRequestIdRef, leftPanelRef }, messageId, options);
    resetFrameExpansion();
    setRecordCategory(null);
    if(options?.mode!=='scope')viewModeScrollRef.current={graph:null,list:null};
    initializeTraceReading([messageId],options?.mode);
    pendingViewportRestoreRef.current = null;
  }

  function enterTraceMultiple(messageIds: string[], options?: { replace?: boolean; mode?: "trace" | "scope"; scopeRelationMessageId?: string }): void {
    if(!hasTraceOverlay()&&!options?.replace&&options?.mode!=='scope'&&restoreExistingTrace(messageIds))return;
    recordReadingNavigation();
    recordBrowsingNavigation();
    cancelViewNavigation();
    runEnterTraceMultiple({ captureSnapshot, classifyRelMsgId, classifyStackRef, setTraceExpandedFrameIds, setTraceEntries, setClassifyRelMsgId, setClassifyKey, cancelScrollRafs, scrollRequestIdRef, leftPanelRef, setTraceKey }, messageIds, options);
    resetFrameExpansion();
    setRecordCategory(null);
    if(options?.mode!=='scope')viewModeScrollRef.current={graph:null,list:null};
    initializeTraceReading(messageIds,options?.mode);
    pendingViewportRestoreRef.current = null;
  }

  function exitAllTrace(): void {
    recordBrowsingNavigation();
    runExitAllTrace({ traceEntries, setTraceEntries, setTraceExpandedFrameIds, setTraceKey, classifyStackRef, setClassifyRelMsgId, setClassifyKey, restoreSnapshot });
    setRelatedTraceContext(null);
  }

  const relatedViewAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => relatedViewAbortRef.current?.abort(), [scopeMessageId, classifyKey, traceKey]);
  useEffect(() => {
    if (!traceEntries.length) setRelatedTraceContext(null);
  }, [traceEntries.length, setRelatedTraceContext]);
  async function viewRelatedRelation(messageId: string): Promise<boolean> {
    if (!msgMap.has(messageId)) return false;
    relatedViewAbortRef.current?.abort();
    const controller = new AbortController();
    relatedViewAbortRef.current = controller;
    return new Promise<boolean>(resolve => {
      let cancelPreparation = () => {};
      const cancel = () => { cancelPreparation(); };
      controller.signal.addEventListener('abort', cancel, { once: true });
      // Paint progress before loading endpoints or replacing the scene. Keep
      // the preparation registered across the request, then let layout and
      // positioning tasks own the dialog until the destination is visible.
      flushSync(() => { cancelPreparation = prepareCategoryDrawing(async () => {
        try {
          const context = await loadRelatedTraceContext(messageId, messages, edges, async ids => {
            if (viewerStructure) return viewerStructure.readContext(ids);
            if (isPreloaded) throw new Error('导出的数据不包含关联消息的另一端');
            return api.getMessageContext(ids, controller.signal);
          });
          if (controller.signal.aborted) { resolve(false); return; }
          if (context.messages.length) setRelatedTraceContext(previous => ({
            messages: [...previous?.messages ?? [], ...context.messages],
            edges: [...previous?.edges ?? [], ...context.edges], relations: [...previous?.relations ?? [], ...context.relations],
          }));
          enterTrace(messageId, { relatedView: true });
          setTraceDepths({...DEFAULT_TRACE_DEPTHS});
          setViewMode('graph');
          closeSettlement();
          setContainerPreviewId(null);
          setComparisonMode(false); setComparisonReviewed(false);
          setJoinFilterTargetId(null); setCorrectionFilterTargetId(null);
          setComparisonReviewBaseMessages(null); setComparisonReviewBaseEdges(null);
          setLastClickedMessageId(messageId);
          pendingScrollMsgRef.current=messageId;
          pendingScrollDependencyIdsRef.current=[];
          setScrollKey(key=>key+1);
          setTraceKey(key => key + 1);
          resolve(true);
        } catch (error) {
          if (!controller.signal.aborted) showAlert(error instanceof Error ? error.message : '关联消息加载失败，请重试');
          resolve(false);
        } finally { controller.signal.removeEventListener('abort', cancel); }
      }, () => {
        controller.signal.removeEventListener('abort', cancel);
        controller.abort();
        resolve(false);
      }, 'loading'); });
    });
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

  async function handleSendMessageOnly(overrideContent?: string): Promise<DemoMessage | null> {
    const text=contributionRef.current('TEXT'),join=contributionRef.current('JOIN');
    return runHandleSendMessageOnly({ local: !!localMessageData, createMessage: localMessageData ? (parent, input) => localWrite(draft => draft.createMessage(parent, input)) : undefined, requireAuth, newMessageContent, scopeMessageId:activeReviewContext?'root':scopeMessageId, stakeAmount:text.truth, setSendError, selectedRelationRef, recommendationRef:textRecommendationRef, stakeFeeAmountRef, isInsideClassify:activeReviewContext?compositionParentId!=='root':isInsideClassify, availablePoints, currentClassifyRelMsgId:activeReviewContext?(compositionParentId==='root'?null:compositionParentId):currentClassifyRelMsgId, setMessages, mergeStakeSnapshot, setAuthorStakes, setStakeAmount, minSelfStake, setNewMessageContent, scrollMsgToCenter, setClassifyKey, handleAuthError,
      joinContribution:{wager:Number(join.truth)||0,recommendation:Number(join.value)||0},
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

  function handleMessageDoubleClick(e: React.MouseEvent, messageId: string): void | Promise<void> {
    if(isRejectedRelation(msgMap.get(messageId),containerPreview?.suppressed??suppressedRelIds)&&relationType!=='correct'){
      e.stopPropagation();undoRecentClickActionsForMessage(messageId);viewMessageEffect(messageId);return;
    }
    const open = () => runHandleMessageDoubleClick({ undoRecentClickActionsForMessage, msgMap, setLastClickedMessageId, activeTextSelectId, viewMode, setComparisonPopup, edges, enterTemporaryCategory, setJoinFilterTargetId, setCorrectionFilterTargetId, setViewMode, traceFrameIds, setTraceExpandedFrameIds, setTraceKey, relationType, setActiveTextSelectId, enterClassification, rejectedContainerIds:containerPreview?.rejectedContainerIds??rejectedContainerIds, setPreviewClassifyId, setStanceHighlight, stanceHighlightTimerRef, relations, settlementOpenMsgId, closeSettlement, openSettlement, lastAddedFragmentRef, setDraftUnits }, e, messageId);
    // Correcting a container only toggles text selection; it does not open a new scene.
    if (relationType !== 'correct' && ["classify","summary"].includes(msgMap.get(messageId)?.relationType ?? "")) {
      e.stopPropagation();
      return new Promise<void>(resolve => flushSync(() => prepareCategoryDrawing(() => { open(); resolve(); })));
    } else open();
  }

  function handleTextMouseUp(e: React.MouseEvent, messageId: string): void {
    return runHandleTextMouseUp({ msgMap, activeTextSelectId, setActiveTextSelectId, setDraftUnits, sourceUnits, setSendError, lastAddedFragmentRef, lastDragOrSelectTimeRef, undoRecentClickActionsForMessage }, e, messageId);
  }

  function handleFragmentAnchorClick(messageId: string, start: number, len: number, text: string): void {
    return runHandleFragmentAnchorClick({ setActiveTextSelectId, toggleFragmentSelection, setLastClickedMessageId, undoRecentClickActionsForMessage }, messageId, start, len, text);
  }

  function commitDraftTo(role: "source" | "target"): void {
    if (zhihuData) {
      const ids = [...new Set(draftUnits.map(unit => unit.messageId))];
      if (localRelationType === 'agree' || localRelationType === 'disagree') {
        const localMessages = new Map(zhihuData.messages.map(message => [message.id, message]));
        if (draftUnits.some(unit => !zhihuStanceReference(zhihuData, unit, localMessages))) {
          showAlert('请选择当前文档中的有效消息、片段或关系。'); return;
        }
        return runCommitDraftTo({ draftUnits, targetUnits, sourceUnits, setSendError, setSourceUnits, setTargetUnits, setDraftUnits, setActiveTextSelectId }, role);
      }
      if (ids.some(id => !msgMap.has(id) || localInactiveRelationIds.has(id)) || draftUnits.some(unit => !zhihuWholeMessageUnit(zhihuData, unit))) {
        showAlert('请选择当前文档中仍可见的完整消息或关系类型。'); return;
      }
      const opposite = role === 'source' ? targetUnits : sourceUnits;
      if (ids.some(id => opposite.some(unit => unit.messageId === id))) {
        showAlert('同一条消息不能同时放入来源集合和目标集合。'); return;
      }
      const update = (previous: UnitSelection[]): UnitSelection[] => [...new Set([...previous.map(unit => unit.messageId), ...ids])]
        .map(messageId => ({ messageId, selection: { kind: 'whole' } }));
      if (role === 'source') setSourceUnits(update); else setTargetUnits(update);
      setDraftUnits([]); setActiveTextSelectId(null); return;
    }
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
    return runGetGroupedTargetTextMessageIds({ msgMap, relationTypeByRelMsgId, relationById, containerEffect }, units);
  }

  function promoteCompleteContainerSelections(units: UnitSelection[]): UnitSelection[] {
    return runPromoteCompleteContainerSelections({ relations, containerEffect }, units);
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
    return runGetContainerMembershipTargetError({ relations, containerEffect,reviewContext:activeReviewContext }, units);
  }

  function getContainerCycleError(units: UnitSelection[]): string | null {
    return runGetContainerCycleError({ currentClassifyRelMsgId, latestClassifyRelMsgIdRef, relationById, relations }, units);
  }

  function getJoinContainerCycleError(sourceContainerId: string, targetIds: string[]): string | null {
    return runGetJoinContainerCycleError({ relationById, relations }, sourceContainerId, targetIds);
  }

  function getDependentDisplayTargets(units: UnitSelection[]): { messageId: string; dependencyId: string; }[] {
    return runGetDependentDisplayTargets({ relationById,reviewContext:activeReviewContext }, units);
  }

  function getDependentDisplayTarget(messageId: string): { messageId: string; dependencyId: string; } | null {
    return runGetDependentDisplayTarget({ getDependentDisplayTargets }, messageId);
  }

  /**
   * Check whether any selected text messages have non-reference edges to
   * text messages that are NOT part of the current selection.
   */
  function hasCrossNonReferenceTextLinkForClassifyTargets(targetTextIds: string[], selectionUnits: UnitSelection[] = effectiveTargetUnits): string | null {
    return runHasCrossNonReferenceTextLinkForClassifyTargets({ effectiveTargetUnits, msgMap, relationTypeByRelMsgId, relationById, relations, edges, containerEffect }, targetTextIds, selectionUnits);
  }

  function enterClassification(relMsgId: string, recordHistory = true): void {
    if (recordHistory) recordBrowsingNavigation(messageNavigationUrl(window.location.href, relMsgId));
    cancelViewNavigation();
    if (viewMode === 'graph') beginWorkbenchDrawing();
    runEnterClassification({ captureSnapshot, cancelScrollRafs, scrollRequestIdRef, leftPanelRef, classifyStackRef, setClassifyRelMsgId, setClassifyKey }, relMsgId);
    setRecordCategory(current=>current?.label==='审核'&&sameReviewContext(activeReviewContext,reviewContextOf(msgMap.get(relMsgId)))?current:null);
    graphFrameViewStateRef.current={};
    pendingViewportRestoreRef.current = null;
  }
  function enterExpandedFrameCategory(e:React.MouseEvent,relMsgId:string):void{
    e.stopPropagation();undoRecentClickActionsForMessage(relMsgId);
    const ids=expandedFrameScope(relMsgId,previewMessages??(comparisonReviewed?comparisonGraphMessages:graphMessagesFinal),edgesToRender);
    enterClassification(relMsgId);
    classifyStackRef.current.at(-1)!.frameScopeIds=ids;
    classifyStackRef.current.at(-1)!.frameKnownIds=messages.map(message=>message.id);
    setTraceEntries([]);setTraceExpandedFrameIds(new Set());
    setContainerPreviewId(null);setComparisonReviewed(false);setComparisonMode(false);
    setJoinFilterTargetId(null);setCorrectionFilterTargetId(null);setPreviewClassifyId(null);
    setActiveTextSelectId(null);setReadingAnchorId(null);window.getSelection()?.removeAllRanges();
  }
  function findContainingClassification(messageId: string): string | null {
    if (viewerStructure) return viewerStructure.containingClassification(messageId);
    return runFindContainingClassification({ relationById, relations, rejectedContainerIds, rejectedJoinRelationIds,
      containerOwnership: containerEffect.ownership, edges, msgMap }, messageId);
  }

  function exitClassification(_options?: { restoreSnapshot?: boolean; clearSelectionOnRootExit?: boolean; preserveViewMode?: ViewMode }): void {
    if (_options?.restoreSnapshot !== false) recordBrowsingNavigation(messageNavigationUrl(window.location.href, classifyStackRef.current.at(-2)?.relMsgId ?? null));
    if (viewMode === 'graph') beginWorkbenchDrawing();
    return runExitClassification({ classifyStackRef, setClassifyRelMsgId, setClassifyKey, setPreviewClassifyId, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setLastClickedMessageId, restoreSnapshot, setViewMode }, _options);
  }

  function handleExitClassification(): void {
    return runHandleExitClassification({ exitClassification });
  }
  useEffect(() => {
    if (currentClassifyRelMsgId && localInactiveRelationIds.has(currentClassifyRelMsgId)) {
      exitClassification({ restoreSnapshot: false, clearSelectionOnRootExit: true });
    }
  }, [currentClassifyRelMsgId, localInactiveRelationIds]);

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
  async function sendTagRelation(target: UnitSelection, tagLabel: string, subType?: string, customLabel?: string,sources?:UnitSelection[]): Promise<DemoEdge | null> {
    return runSendTagRelation({ scopeMessageId, msgMap, secondaryRelationType, newMessageContent, createRel, registerCreatedRelationInCurrentClassify, showAlert }, target, tagLabel, subType, customLabel,sources);
  }

  async function handleCreateRelationWithSourcesAndTargets(params: {
    sources: UnitSelection[]; targets: UnitSelection[]; label: string;
  }): Promise<void> {
    return runHandleCreateRelationWithSourcesAndTargets({ requireAuth, scopeMessageId, relationType, msgMap, newMessageContent, createRel, registerCreatedRelationInCurrentClassify, showAlert, secondaryRelationType, subType, sendTagRelation, subTypeCustomLabel, setEdges }, params);
  }

  /**
   * Create "join" relations for each target of a container.
   * A join relation is: sourceMessageId=container, targetRefs=[target].
   * This enables resolveMessageCanvas / getActiveJoinRelationsForMessage
   * to find which container a message belongs to (bottom-up lookup).
   */
  async function createJoinRelationsForContainer(containerId: string, _containerType: string, targetMids: Array<string | TargetRef>): Promise<boolean> {
    return runCreateJoinRelationsForContainer({ getDependentDisplayTarget, setSendError, msgMap, containerRelationTypes, relationsRef, createRel, scopeMessageId, appendCreatedRelation, effectiveJoinRelationIds }, containerId, _containerType, targetMids);
  }

  async function handleQuickSendAndRelateFromDraftTargets(): Promise<void> {
    const correction = { current: null as typeof comparisonPopup };
    const captureCorrection: typeof setComparisonPopup = value => { correction.current = typeof value === 'function' ? value(correction.current) : value; };
    await runHandleQuickSendAndRelateFromDraftTargets({ local: !!localMessageData, requireAuth, singleButtonEnabled, newMessageContent, savedTextOnTypeSwitchRef, draftUnits, targetUnits, setSendError, sourceUnits, resolveEffectiveTargetUnits, relationType, hasTextContent, stakeAmount, containerRelationTypes, appendContainerType, relStakeAmount, effectiveMinStake, subType, subTypeCustomLabel, subTypeStakeMap, relationStakeMap, totalConsumption, availablePoints, handleSendMessageOnly, guideTargetIdRef, setNewMessageContent, getContainerMembershipTargetError, joinOnlyAction, getContainerCycleError, showAlert, relationsRef, getJoinContainerCycleError, createJoinRelationsForContainer, setEdges, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setSubType, setRelationType, setSecondaryRelationType, relationLabel, handleCreateRelationWithSourcesAndTargets, secondaryRelationType, correctionWidth: composer.correctionWidth, msgMap, createRel, scopeMessageId, registerCreatedRelationInCurrentClassify, edgesRef, sendTagRelation, subTypeCustomBufferRef, setSubTypeCustomLabel, setComparisonPopup: isCapturingPreview() ? captureCorrection : setComparisonPopup, correctionVersions, blockCorrectionForSecondBettor, edges, relationById, organizationTargetRef, getGroupedTargetTextMessageIds, relationTypeByRelMsgId, hasCrossNonReferenceTextLinkForClassifyTargets, getClassifyTargetRefs, isInsideClassify, currentClassifyRelMsgId, classifyStackRef, appendCreatedRelation, setTraceKey, isGovernanceOrOpsType, relations, setRelations, hasTargetsAvailable, user: localMessageData ? viewerUser : user, setMessages, relStakeRef, setAuthorStakes, mergeStakeSnapshot });
    if (correction.current?.reversePreview) await confirmReverseCorrection(correction.current, true);
  }

  const sendPreview = useSendPreview({ composer, owner: user?.id ?? '', scope: compositionParentId, liveSequence,
    canPrepare: () => canSubmitDraft && containerPreviewId === null && !sentMessagePlacementRef.current?.active,
    reviewContext:compositionReviewContext,
    sendInFlightRef, viewport:leftPanelRef, captureTransient, showSendPreview, clearSendPreview,
    confirmSendPreview: pages=>{
      if(previewReviewContext&&recordCategory!==currentRecordCategory){
        openRecordCategory(previewReviewContext.messageId,'审核',sendPreviewMessageIds??[],previewReviewContext.revision);
        setViewMode(viewMode);
      }
      confirmSendPreview(pages);
    }, error: setSendError,
    onCommitted: prepared => {
      const reviewIds=prepared.envelope.commands.filter(command=>command.path==='/relations'&&command.method==='POST'
        &&typeof command.body.reviewWager==='number'&&command.body.reviewWager>0).map(command=>command.id);
      if(reviewIds.length)setSentMessageTargets(queue=>[...new Set([...queue,...reviewIds])]);
      const command = prepared.envelope.commands.length === 1 ? prepared.envelope.commands[0] : null;
      if (command?.path === '/messages' && command.method === 'POST') {
        guideTargetIdRef.current = command.id;
        window.dispatchEvent(new CustomEvent('guide-text-message-sent', { detail: {messageId:command.id,title:String(command.body.content ?? '').slice(0,40)} }));
      }
    },
    work: async () => { sentMessageTargetsRef.current = []; sentMessageRelatedViewsRef.current.clear(); await handleQuickSendAndRelateFromDraftTargets(); } });

  async function handleSendClick(confirmedStandalone = false): Promise<void> {
    if (sendPreview.active) return sendPreview.confirm();
    if (!canSubmitDraft || sendInFlightRef.current || sentMessagePlacementRef.current?.active) return;
    if (!confirmedStandalone && relationType === null && newMessageContent.trim()
      && (draftUnits.length > 0 || sourceUnits.length > 0 || targetUnits.length > 0)) {
      setConfirmStandaloneSend(true);
      return;
    }
    sentMessageTargetsRef.current = [];
    sentMessageRelatedViewsRef.current.clear();
    const joinedContainerId = joinOnlyAction ? sourceUnits[0]?.messageId : undefined;
    return runHandleSendClick({ withCommandBatch: localMessageData ? runLocalBatch : undefined, composer, captureOptimisticRollback, sendInFlightRef, setSendInFlight, handleQuickSendAndRelateFromDraftTargets, setSendError,
      reviewContext:compositionReviewContext,
      prepare: () => {
        cancelScrollRafs();
        cancelViewNavigation();
        return sendingProgress.prepare();
      },
      onSettled: sendingProgress.finish,
      onCommitted: () => {
        if (joinedContainerId) {
          handleNavigateToMessage(joinedContainerId, {select:false});
          return;
        }
        const committedTargets = [...sentMessageTargetsRef.current];
        setSentMessageTargets(queue => [...queue, ...committedTargets.filter(id => !queue.includes(id))]);
      },
    });
  }


  const draftGroups: DraftGroup[] = useMemo(() => groupDraftSelections(draftUnits), [draftUnits]);
  const localEffectiveTargetUnits = (draftUnits.length ? draftUnits : targetUnits).map(unit => zhihuData ? zhihuWholeMessageUnit(zhihuData, unit) ?? unit : unit);

  const previousDraftSelectionRef = useRef({ count: draftUnits.length, activeTextSelectId });
  useEffect(() => {
    const previous = previousDraftSelectionRef.current;
    previousDraftSelectionRef.current = { count: draftUnits.length, activeTextSelectId };
    // Double-click enters text selection while undoing its first click's staged
    // card. That empty draft must not cancel the selection mode just entered.
    if (previous.count > 0 && draftUnits.length === 0 && activeTextSelectId !== null
      && previous.activeTextSelectId === activeTextSelectId) setActiveTextSelectId(null);
  }, [draftUnits, activeTextSelectId]);

  // Scroll to center the traced message when entering trace mode.
  useEffect(() => {
    const newLen = traceEntries.length;
    if (newLen <= prevTraceLenRef.current) { prevTraceLenRef.current = newLen; return; }
    prevTraceLenRef.current = newLen;
    if (viewMode !== "graph") return;
    const entry = traceEntries[newLen - 1];
    if (!entry || entry.ids.length === 0) return;
    // An explicit jump owns positioning, including its completion and pulse.
    // Starting a second trace-centering task here would cancel that jump.
    if (pendingScrollMsgRef.current || pendingScrollMsgIdRef.current || pendingViewportRestoreRef.current) return;
    const traceId = entry.ids[0];
    cancelScrollRafs();
    const task = startPositioning();
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRaf2Ref.current = requestAnimationFrame(() => {
        task.run(() => {
          scrollRafRef.current = null;
          scrollRaf2Ref.current = null;
          const container = leftPanelRef.current;
          if (!container) { task.complete(); return; }
          const el = container.querySelector(`[data-msgid="${traceId}"]`) as HTMLElement | null;
          if (!el) { task.complete(); return; }
          const elRect = el.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          const elCenterX = elRect.left - containerRect.left + container.scrollLeft + elRect.width / 2;
          const elCenterY = elRect.top - containerRect.top + container.scrollTop + elRect.height / 2;
          container.scrollLeft = Math.max(0, Math.min(elCenterX - container.clientWidth / 2, container.scrollWidth - container.clientWidth));
          container.scrollTop = Math.max(0, Math.min(elCenterY - container.clientHeight / 2, container.scrollHeight - container.clientHeight));
          task.complete();
        });
      });
    });
    task.onCancel(cancelScrollRafs);
  }, [traceEntries, viewMode]);

  // Restore saved scroll position after view mode switch so switching does not auto-scroll to top.
  useEffect(() => {
    const saved = viewModeScrollRef.current[viewMode];
    if (saved !== null) {
      cancelScrollRafs();
      const task = startPositioning();
      const restore=()=>{
        scrollRafRef.current=null;scrollRaf2Ref.current=null;
        // Expanded reading information may still be changing the scene. Only
        // consume the saved viewport once the settled layout can restore it.
        if(viewModeScrollRef.current[viewMode]===saved)viewModeScrollRef.current[viewMode]=null;
        clampAndSetScroll(leftPanelRef.current,saved.top,saved.left);task.complete();
      };
      if(task.afterLayout)task.afterLayout(restore);
      else scrollRafRef.current=requestAnimationFrame(()=>{scrollRaf2Ref.current=requestAnimationFrame(()=>task.run(restore));});
      task.onCancel(cancelScrollRafs);
    }
  }, [viewMode]);

  function getSelectedWholeMessageIds(): string[] {
    return runGetSelectedWholeMessageIds({ draftUnits });
  }


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
  const notificationRecipients = useNotificationRecipients(isNotifyType&&!isPreloaded,user?.id,notifyTargets.map(target=>target.messageId));
  const attentionTargetMessageIds = useMemo(() => {
    const followers = new Map(Object.entries(attentionUsersByTarget).map(([id,users]) => [id,new Set(users)]));
    for (const relation of [...relations].sort((a,b) => (a.sequence ?? Date.parse(a.createdAt)) - (b.sequence ?? Date.parse(b.createdAt)))) {
      if (relation.relationType.toUpperCase() !== 'ATTENTION') continue;
      for (const targetRef of relation.targetRefs) {
        if (targetRef.kind === 'message' || targetRef.kind === 'text-fragment') {
          const users = followers.get(targetRef.messageId) ?? new Set<string>();
          if (relation.payload?.subType === 'YES') users.add(relation.createdBy.id);
          else if (relation.payload?.subType === 'NO') users.delete(relation.createdBy.id);
          followers.set(targetRef.messageId,users);
        }
      }
    }
    return new Set([...followers].filter(([,users]) => users.size>0).map(([id]) => id));
  }, [attentionUsersByTarget, relations]);
  const hasAttentionNotifyTarget = localMessageData ? notifyTargets.length > 0 : isPreloaded ? notifyTargets.length > 0 && notifyTargets.every(target => attentionTargetMessageIds.has(target.messageId))
    : notificationRecipients.users.length>0&&!notificationRecipients.loading;
  const notifyRecipientLabel = notificationRecipients.loading ? '正在确认通知接收者…' : notificationRecipients.error ? `接收者加载失败：${notificationRecipients.error}`
    : notificationRecipients.users.length ? `发送通知（${notificationRecipients.users.slice(0,3).map(user=>user.username).join('、')}${notificationRecipients.users.length>3?'等':''}，共 ${notificationRecipients.users.length} 人）` : undefined;

  // Whether any draft unit points to a relation message (vs. text message or fragment)
  const draftHasRelationTarget = draftUnits.some(u => msgMap.get(u.messageId)?.kind === 'relation' && !msgMap.get(u.messageId)?.parts);
  const hasTargetsAvailable = draftUnits.length > 0 || targetUnits.length > 0;
  const effectiveTargetUnits = useMemo(
    () => resolveEffectiveTargetUnits(draftUnits, targetUnits, relationType),
    [draftUnits, targetUnits, relationType, relations, msgMap, containerEffect],
  );
  const processedTargetUnits = effectiveTargetUnits;
  const isWidthCorrection = (zhihuData ? localRelationType : relationType) === 'correct' && secondaryRelationType === 'width-adjustment';
  const cardWidths = useMemo(() => effectiveCardWidths(messages, edges, displayUser?.username ?? null), [messages, edges, displayUser?.username]);
  const widthTargetUnits = zhihuData ? localEffectiveTargetUnits : effectiveTargetUnits;
  const widthTarget = isWidthCorrection && widthTargetUnits.length === 1
    && isWholeMessageSelection(widthTargetUnits[0], widthTargetUnits[0].messageId)
    && widthTargetUnits[0].reference?.revision === undefined
    && (!zhihuData || !sourceUnits.length && !(draftUnits.length && targetUnits.length) && !localInactiveRelationIds.has(widthTargetUnits[0].messageId))
    ? widthTargetUnits[0].messageId : null;
  const previousWidthTarget = useRef<string | null>(null);
  useEffect(() => {
    if (widthTarget && widthTarget !== previousWidthTarget.current) composer.setCorrectionWidth(cardWidths[widthTarget] ?? 320);
    previousWidthTarget.current = widthTarget;
  }, [widthTarget, cardWidths, composer.setCorrectionWidth]);
  const cardWidthContext = useMemo(() => ({ widths: cardWidths,
    editing: widthTarget ? { messageId: widthTarget, width: composer.correctionWidth, onChange: composer.setCorrectionWidth } : null,
  }), [cardWidths, widthTarget, composer.correctionWidth, composer.setCorrectionWidth]);
  const annotationOppositionError = relationType === 'disagree' ? effectiveTargetUnits.reduce<string | null>((error, unit) => {
    const message = msgMap.get(unit.messageId);
    return error || (message ? annotationStanceError(message, unitSelectionToReference(unit, msgMap)) : null);
  }, null) : null;
  const hasCorrectionRelationTarget = relationType === 'correct' && !isWidthCorrection
    && effectiveTargetUnits.some(unit => msgMap.get(unit.messageId)?.kind === 'relation' && !msgMap.get(unit.messageId)?.parts
      && !isCorrectableCorrectionTarget(msgMap.get(unit.messageId)));
  const hasInvalidCorrectTarget = relationType === 'correct' && !hasCorrectionRelationTarget && (
    sourceUnits.length > 0
    || effectiveTargetUnits.length !== 1
    || (isWidthCorrection ? !widthTarget : !msgMap.get(effectiveTargetUnits[0]?.messageId)?.parts && (
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
    || relationType === "operations"
    || relationType === "correct"
    || relationType === "delegation";

  // Send button enabled logic (single button):
  //   - No relation type: just send message → need text
  //   - Relation target + reply/correct with secondary selector: text must be empty, source must be empty
  //   - agree/disagree/arrange (pure-stance): draft or target collection not empty
  //   - sourceUnits + targetUnits explicitly set (draft empty): can build relation without new text
  //   - Other types: (draft or target collection) not empty AND text not empty
  // Note: draftUnits (候选区) is a quick substitute for targetUnits (目标集合).
  // If draftUnits is non-empty it takes precedence; otherwise targetUnits is used.
  const hasTextContent = !joinOnlyAction && newMessageContent.trim().length > 0;
  const singleButtonEnabled = !annotationOppositionError && deriveSingleButtonEnabled({ local: !!localMessageData, relationType, newMessageContent, hasTextContent, stakeAmount, joinOnlyAction, relStakeAmount, effectiveMinStake, totalConsumption, availablePoints, draftUnits, targetUnits, hasInvalidCorrectTarget, hasInvalidContainerSource, hasInvalidJoinTarget, hasCrossLinkValidationError, hasOrphanContainerLabel, hasClassifyCycle, hasInvalidDelegationFormat, hasInvalidProposalFormat, hasCorrectionRelationTarget, isClassifyType, sourceUnits, relations, hasTargetsAvailable, isSummaryType, isMergeType, secondaryRelationType, effectiveTargetUnits, isGovernanceOrOpsType, msgMap, isTagWithInlineBadge, subType, subTypeCustomLabel, isTagWithQuickAnnotate, isAgreeDisagreeType, isArrangeType, isNotifyType, hasAttentionNotifyTarget });
  const canSubmitDraft = singleButtonEnabled && !sendInFlight && sentMessageTargets.length === 0
    && !comparisonReviewed && (!isPreloaded || !!localMessageData) && !isPreviewMode;

  // Dynamic label describing what the send button will do
  const singleButtonLabel = deriveSingleButtonLabel({ notifyRecipientLabel, relationType, newMessageContent, draftUnits, isClassifyType, sourceUnits, relations, getClassifyTargetRefs, targetUnits, joinOnlyAction, hasTargetsAvailable, isSummaryType, isMergeType, hasCorrectionRelationTarget, hasInvalidCorrectTarget, hasTextContent, isNotifyType, hasAttentionNotifyTarget, isGovernanceOrOpsType, secondaryRelationType, msgMap, isAgreeDisagreeType, isArrangeType, isTagWithInlineBadge, subType, subTypeCustomLabel, isTagWithQuickAnnotate });

  const sendValidationLabel = annotationOppositionError ?? deriveSendValidationLabel({ singleButtonEnabled, relationType, hasTextContent, draftUnits, targetUnits, stakeAmount, joinOnlyAction, relStakeAmount, effectiveMinStake, totalConsumption, availablePoints, hasCorrectionRelationTarget, hasInvalidCorrectTarget, hasInvalidContainerSource, hasInvalidJoinTarget, invalidJoinTargetMessage, hasCrossLinkValidationError, crossLinkValidationMessage, hasOrphanContainerLabel, hasClassifyCycle, hasInvalidDelegationFormat, secondaryRelationType, hasInvalidProposalFormat, hasTargetsAvailable, isClassifyType, isGovernanceOrOpsType, isAgreeDisagreeType, isArrangeType, isMergeType, isTagWithQuickAnnotate, isTagWithInlineBadge });

  // Secondary relation options for CORRECT type: relations of the same PresentationKind as the targeted relation message, plus "none".
  const correctSecondaryOptions = ['width-adjustment', 'text-correction'];

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
    return ['recommend', 'archive', 'attention', 'block', ...Array.from(existingTagLabels)];
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

  const { messagesToShow, edgesToShow, traceExpandableContainerIds, traceAncestorContainerIds, traceScopeIds } = useMemo(() => deriveMessagesToShow({ traceEntries, messages, edges:containerEffect.traceEdges, traceContainerMemberships, effectiveSuppressedRelIdsForLayout, traceDistance, traceDepths, traceDirection, traceExpandedFrameIds }), [containerEffect, messages, edges, traceContainerMemberships, effectiveSuppressedRelIdsForLayout, traceEntries, traceDistance, traceDepths, traceDirection, msgMap, traceExpandedFrameIds]);
  const defaultTraceFrameKey=useMemo(()=>{
    const ids=new Set([...traceAncestorContainerIds,...traceExpandableContainerIds]);
    // Open the selected container's entire tree at once. Ancestors retain only
    // the members already reached by the trace, without adding their siblings.
    for(const id of currentTraceEntry?.ids??[])if(getPresentationSpec(msgMap.get(id)?.relationType??'').isContainer){
      ids.add(id);
      for(const child of containerEffect.ownership.owned(id).relationIds)ids.add(child);
    }
    return JSON.stringify([...ids].filter(id=>['classify','summary'].includes(msgMap.get(id)?.relationType??'')
      &&!rejectedContainerIds.has(id)).sort());
  },[traceAncestorContainerIds,traceExpandableContainerIds,currentTraceEntry,containerEffect,msgMap,rejectedContainerIds]);
  const initializedTraceFrames = useRef(new WeakMap<TraceEntry, {range:string;ids:Set<string>}>());
  useLayoutEffect(() => {
    if (!currentTraceEntry) return;
    const range=JSON.stringify(traceDepths);
    let initialized=initializedTraceFrames.current.get(currentTraceEntry);
    if(initialized?.range!==range){
      initialized={range,ids:new Set()};
      initializedTraceFrames.current.set(currentTraceEntry,initialized);
    }
    // Initialize each new frame once. A manual collapse changes the visible
    // projection, but must not reopen frames already initialized in this range.
    const ids=(JSON.parse(defaultTraceFrameKey) as string[]).filter(id=>!initialized.ids.has(id));
    for(const id of ids)initialized.ids.add(id);
    if (ids.length) setTraceExpandedFrameIds(previous => new Set([...previous, ...ids]));
  }, [defaultTraceFrameKey, currentTraceEntry, traceDepths]);

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
    () => currentClassifyRelMsgId ? [...collectOwnedByRelation(currentClassifyRelMsgId, relationById).textIds].filter(id=>!frameScopeIds||frameScopeIds.has(id)).length : 0,
    [currentClassifyRelMsgId, relationById,frameScopeIds]
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
  const currentSourceMeta = currentClassifyRelMsg ? zhihuData?.zhihu.byMessageId[currentClassifyRelMsg.id] : undefined;
  const currentZhihuQuestion = currentSourceMeta?.kind === 'question' ? currentSourceMeta : undefined;
  const currentQuestionFields = currentZhihuQuestion && zhihuData && currentClassifyRelMsg ? getZhihuDisplayFields(zhihuData, currentClassifyRelMsg.id) : undefined;
  const classificationTitle = currentClassifyRelMsg
    ? currentZhihuQuestion ? currentQuestionFields?.title || currentZhihuQuestion.questionTitle || (currentZhihuQuestion.titleCompleteness === 'complete' ? '（空标题）' : '问题标题未取得')
      : (correctionVersions.get(currentClassifyRelMsg.id)?.current?.content ?? getRelationTitle(currentClassifyRelMsg.relationPayload) ?? `${classifyKindLabel}（${classifyTargetCount}）`)
    : "";
  const isTemporaryJoinCategory = joinFilterTargetId !== null;
  const temporaryJoinCount = joinFilterTargetId
    ? (joinFilterDirection === 'outgoing'
      ? (joinRelationsBySource.get(joinFilterTargetId)?.length ?? 0)
      : (joinRelationsByTarget.get(joinFilterTargetId)?.length ?? 0))
    : 0;

  const { graphMessagesToRender, graphEdgesToRender, listMessagesToRender, listEdgesToRender, hideMessageIds } = useMemo(() => deriveGraphMessagesToRender({ frameScopeIds,containerOwnership:containerEffect.ownership,traceEntries, messagesToShow, messages, edgesToShow, edges:traceEntries.length > 0 ? containerEffect.traceEdges : edges, traceContainerMemberships, effectiveSuppressedRelIdsForLayout, traceDistance, traceDepths, traceDirection, traceExpandedFrameIds, isInsideClassify, currentClassifyRelMsgId, relationById, relations, rejectedContainerIds, rejectedJoinRelationIds, msgMap, activeClassifyOwnership, classifiedTargetSummaryRelMsgIds, listExclusiveRelMsgIds, replacedRelationMsgIds, classifiedTargetTextIds, graphOwnedRelationIds, traceRelationMsgIds, classifiedTargetClassifyRelMsgIds, classifiedTargetMergeRelMsgIds, classifiedTargetARRANGERelMsgIds, activeSummaryOwnership, graphExclusiveRelMsgIds, graphHiddenTextIds }), [frameScopeIds,containerEffect,messages, edges, traceContainerMemberships, relationById, relations, messagesToShow, edgesToShow, traceEntries, isInsideClassify, currentClassifyRelMsgId, msgMap, classifiedTargetTextIds, classifiedTargetClassifyRelMsgIds, classifiedTargetMergeRelMsgIds, classifiedTargetARRANGERelMsgIds, classifiedTargetSummaryRelMsgIds, listExclusiveRelMsgIds, replacedRelationMsgIds, activeClassifyOwnership, classifyOwnership, summaryOwnership, graphExclusiveRelMsgIds, graphHiddenTextIds, traceRelationMsgIds, traceExpandedFrameIds, traceDepths, traceDirection, rejectedContainerIds, rejectedJoinRelationIds]);

  const normalGraphProjection = useMemo(() => deriveNormalGraphProjection({ graphMessagesToRender, correctionVersions, cleanVisibleIds, homeFilterResult, msgFilter, edges, messages, displayUser, graphEdgesToRender, relations, effectiveJoinRelationIds }), [messages, graphMessagesToRender, graphEdgesToRender, correctionVersions, cleanVisibleIds, homeFilterResult, msgFilter, edges, displayUser?.username, relations, effectiveJoinRelationIds]);

  // Use the rendered scope, including effective JOINs and expanded frames.
  const { crossCanvasRelations, relatedEdges } = useMemo(() => {
    const scene = projectGraphScene({ ...normalGraphProjection, traceExpandedFrameIds,
      isTraceWindow: traceEntries.length > 0, rejectedContainerIds, hiddenMessageIds: hideMessageIds });
    const allowed = new Set(applyMessageFilter(messages, msgFilter).map(message => message.id));
    const relatedEdges = edges.filter(edge => !containerEffect.suppressed.has(edge.relationMessageId) && allowed.has(edge.relationMessageId));
    return { relatedEdges, crossCanvasRelations: deriveCrossCanvasRelations({ edges: relatedEdges,
      visibleMessageIds: new Set([...scene.normalIds, ...scene.frameBlocks.map(frame => frame.relMsgId)]), renderedEdges: scene.layoutEdges }) };
  }, [normalGraphProjection, traceExpandedFrameIds, traceEntries, rejectedContainerIds, hideMessageIds, edges, containerEffect.suppressed, msgMap, messages, msgFilter]);

  const comparisonInput = useMemo<DeriveComparisonGraphProjectionsInput>(() => ({
    comparisonReviewed,comparisonTargetId,username:displayUser?.username??null,scopeId:currentClassifyRelMsgId,
    baseScopeId:comparisonReviewed?comparisonOrigin.current?.classifyId:undefined,
    sourceEffect:containerEffect,messages,relations,edges,traceEntries,traceDistance,traceDepths,traceDirection,traceExpandedFrameIds,traceRelationMsgIds,traceContainerMemberships,
    collectExclusiveRelationMsgIds,replacedRelationMsgIds,comparisonReviewBaseMessages,comparisonReviewBaseEdges,isInsideClassify,normalGraphProjection,
    displayedCorrections:correctionVersions,showMembershipFrames:true,
    filterMessages:values=>applyMessageFilter(values.filter(message=>
      (!cleanVisibleIds||cleanVisibleIds.visibleTextIds.has(message.id)||cleanVisibleIds.visibleRelIds.has(message.id))
      &&(!homeFilterResult||homeFilterResult.displayIds.has(message.id))),msgFilter),
  }),[containerEffect,comparisonReviewed,comparisonTargetId,comparisonScopeMessageIds,currentClassifyRelMsgId,displayUser?.username,messages,relations,edges,traceEntries,traceDistance,traceDepths,traceDirection,traceExpandedFrameIds,traceRelationMsgIds,traceContainerMemberships,replacedRelationMsgIds,comparisonReviewBaseMessages,comparisonReviewBaseEdges,isInsideClassify,normalGraphProjection,cleanVisibleIds,homeFilterResult,msgFilter,correctionVersions]);
  const comparisonGraphProjections=useMemo(()=>deriveComparisonGraphProjections(comparisonInput),[comparisonInput]);
  const containerPreview=useMemo(()=>{
    if(!containerPreviewId || joinFilterTargetId !== null)return null;
    const projection=projectComparisonSide({...comparisonInput,comparisonReviewed:true,comparisonTargetId:containerPreviewId},'agree')!;
    const {effect}=projection;
    return {...projection,allMessages:effect.messages,relations:effect.relations,target:effect.msgMap.get(containerPreviewId)!,
      rejectedContainerIds:effect.rejectedContainerIds,effectiveJoinIds:effect.effectiveJoinIds};
  },[containerPreviewId,comparisonInput,joinFilterTargetId]);
  const displayHintsInput = useMemo(() => ({messages,relations,edges,username:displayUser?.username ?? null,userId:displayUser?.id,
    unloadedContainers: unloadedViewerContainers,
    readStatus:readStatusByMessageId,readingMarks:readingState.marks,personalEffect:containerEffect,displayEffect:containerPreview?.effect,corrections:personalCorrectionVersions,recommendedCorrections:recommendedCorrectionVersions,displayCorrections:correctionVersions}),
    [messages,relations,edges,displayUser?.username,displayUser?.id,readStatusByMessageId,readingState.marks,containerEffect,containerPreview?.effect,personalCorrectionVersions,recommendedCorrectionVersions,correctionVersions,unloadedViewerContainers]);
  const hintContainerId=containerPreview&&['classify','summary','merge','arrange'].includes(containerPreview.target.relationType??'')
    ?containerPreviewId:previewClassifyId??currentClassifyRelMsgId??scopeMessageId;
  async function viewDisplayHint(id:string,_event:React.MouseEvent,record:boolean):Promise<void> {
    const destination=displayHintDestination(displayHintsInput,id,record);
    if(msgMap.get(id)?.kind==='join'&&destination.kind==='container'
      &&createCurrentContainerLookup(displayHintsInput.displayEffect??displayHintsInput.personalEffect,hintContainerId)(id).has(destination.id))return;
    const token=displayHintWindow.suspend();
    try {
      if(record&&msgMap.get(destination.id)?.kind==='join')handleNavigateToMessage(destination.id,{select:false});
      else if(destination.kind==='container'){viewRelatedContainer(destination.id);scheduleViewNavigation(destination.id);}
      else if(destination.kind==='corrections'||destination.kind==='correction')openCorrectionRecords(destination.id);
      else await viewRelatedRelation(destination.id);
    } finally {displayHintWindow.finishNavigation(token);}
  }
  const comparisonAgreeSuppressedRelIds = comparisonGraphProjections?.agree.suppressed??effectiveSuppressedRelIdsForLayout;
  const comparisonDisagreeSuppressedRelIds = comparisonGraphProjections?.disagree.suppressed??effectiveSuppressedRelIdsForLayout;

  function handleCanvasBlankClick(): void {
    return runHandleCanvasBlankClick({ setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setLastClickedMessageId });
  }

  async function confirmReverseCorrection(popup = comparisonPopup, rehearsal = false): Promise<void> {
    if (sentMessageTargets.length > 0 || sentMessagePlacementRef.current?.active) return;
    return runConfirmReverseCorrection({ sendInFlightRef: rehearsal ? { current:false } : sendInFlightRef, comparisonPopup:popup, scopeMessageId, setSendInFlight:rehearsal ? () => {} : setSendInFlight, createRel, msgMap, registerCreatedRelationInCurrentClassify, setEdges, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setNewMessageContent, setRelationType, setSecondaryRelationType, setRecommendationAmount, setComparisonPopup: rehearsal ? () => {} : setComparisonPopup, showAlert,
      onCreated: messageId => {
        if (rehearsal) return;
        lastDragOrSelectTimeRef.current = 0;
        setSentMessageTargets(queue => [...queue, messageId]);
      },
    });
  }

  async function handleDecorationIconClick(messageId: string, kind: "agree" | "disagree"): Promise<void> {
    if(isPreviewMode)return;
    return runHandleDecorationIconClick({ comparisonReviewed, scopeMessageId, msgMap, correctionVersions, showAlert, createRel, registerCreatedRelationInCurrentClassify }, messageId, kind);
  }

  async function handleComparisonVote(side: 'agree' | 'disagree' = 'agree'): Promise<void> {
    return runHandleComparisonVote({ isPreloaded: isPreloaded && !localMessageData, comparisonReviewed, requireAuth, comparisonTargetId, draftUnits, scopeMessageId, relStakeAmount, recommendationAmount, protocolFee:stakeFeeAmountRef.current, effectiveMinStake, setSendError, availablePoints, createRel, msgMap, registerCreatedRelationInCurrentClassify, showAlert }, side);
  }

  function handleDecorationBodyClick(e: React.MouseEvent, messageId: string, kind: "agree" | "disagree"): void {
    return runHandleDecorationBodyClick({ edges:displayStanceEdges, homeFilterResult, setLastClickedMessageId, setDraftUnits }, e, messageId, kind);
  }

  function handleDecorationDoubleClick(e: React.MouseEvent, messageId: string, kind: "agree" | "disagree"): void {
    e.stopPropagation();
    const recordIds=[...new Set(displayStanceEdges.filter(edge=>edge.relationType===kind&&isWholeMessageSelection(edge.to,messageId)
      &&(!homeFilterResult||homeFilterResult.displayIds.has(edge.relationMessageId))).map(edge=>edge.relationMessageId))];
    openRecordCategory(messageId,relationTypeName(kind),recordIds);
  }

  function handleTagBodyClick(e: React.MouseEvent, messageId: string, _tagLabel: string, relMsgIds: string[]): void {
    return runHandleTagBodyClick({ setLastClickedMessageId, setDraftUnits }, e, messageId, _tagLabel, relMsgIds);
  }

  function handleTagDoubleClick(e: React.MouseEvent, messageId: string, tagLabel: string, relMsgIds: string[]): void {
    e.stopPropagation();openRecordCategory(messageId,tagLabel,relMsgIds);
  }

  function openRecordCategory(targetId:string,label:string,recordIds:string[],revision?:number):void{
    if(!recordIds.length&&label!=='审核')return;
    recordBrowsingNavigation();enterTemporaryCategory(true);
    setJoinFilterTargetId(null);setCorrectionFilterTargetId(null);setContainerPreviewId(null);
    setComparisonMode(false);setComparisonReviewed(false);setComparisonPopup(null);setTagPopup(null);setDecorationPopup(null);
    closeSettlement();setRecordCategory({targetId,label,recordIds:[...new Set(recordIds)],revision});setViewMode(label==='审核'?'graph':'list');
    setLastClickedMessageId(recordIds[0]??targetId);
  }

  const reviewNavigator=useRef<(id:string,revision?:number)=>void>(()=>{});
  function openReviewSummary(id:string,revision?:number):void{
    const currentRevision=recordCategory?.revision??messagesRef.current.find(message=>message.id===id)?.moderation?.revision;
    if(recordCategory?.label==='审核'&&recordCategory.targetId===id&&(!revision||currentRevision===revision)){
      closeSettlement();return;
    }
    openRecordCategory(id,'审核',[],revision);
  }
  reviewNavigator.current=openReviewSummary;
  useEffect(()=>{
    const update=(event:Event)=>{const data=(event as CustomEvent<{messageId:string;summary:import('@gonglun/core').ModerationSummary}>).detail;
      if(data?.summary)setMessages(previous=>{
        const current=previous.find(message=>message.id===data.messageId&&(!message.revision||message.revision===data.summary.revision));
        return !current||JSON.stringify(current.moderation)===JSON.stringify(data.summary)?previous:previous.map(message=>message===current?{...message,moderation:data.summary}:message);
      });};
    window.addEventListener('review-summary',update);return()=>window.removeEventListener('review-summary',update);
  },[]);
  useEffect(()=>{
    if(isPreloaded)return;
    const open=(event:Event)=>{const data=(event as CustomEvent<{messageId?:string;revision?:number}>).detail;if(data?.messageId)reviewNavigator.current(data.messageId,data.revision);};
    window.addEventListener('gonglun:open-review',open);return()=>window.removeEventListener('gonglun:open-review',open);
  },[isPreloaded]);
  useEffect(()=>{const id=searchParams.get('review');if(!isPreloaded&&id){reviewNavigator.current(id,Number(searchParams.get('reviewRevision'))||undefined);setSearchParams(previous=>{const next=new URLSearchParams(previous);next.delete('review');next.delete('reviewRevision');return next;},{replace:true});}},[searchParams,isPreloaded,setSearchParams]);

  function handleGroupFrameClick(e: React.MouseEvent, relMsgId: string): void {
    return runHandleGroupFrameClick({ setLastClickedMessageId, toggleWholeUnit }, e, relMsgId);
  }

  function handleGroupFrameDoubleClick(e: React.MouseEvent, relMsgId: string): void {
    if (relationType === 'correct' && ['classify', 'summary'].includes(msgMap.get(relMsgId)?.relationType ?? '')) {
      handleMessageDoubleClick(e, relMsgId);
      return;
    }
    return runHandleGroupFrameDoubleClick({ setLastClickedMessageId, edges, relationTypeByRelMsgId, traceFrameIds, setTraceExpandedFrameIds, setTraceKey, enterClassification, setMergeInfoPopup, enterTrace }, e, relMsgId);
  }
  function handleFrameHeaderDoubleClick(e:React.MouseEvent,relMsgId:string):void{
    if(relationType!=='correct'&&['classify','summary'].includes(msgMap.get(relMsgId)?.relationType??''))enterExpandedFrameCategory(e,relMsgId);
    else handleGroupFrameDoubleClick(e,relMsgId);
  }

  function handleInlineBadgeClick(e: React.MouseEvent, relMsgId: string): void {
    const edge=edgesRef.current.find(edge=>edge.relationMessageId===relMsgId&&edge.relationType==='correct');
    if(edge){
      e.stopPropagation();
      if(correctionCompareTimerRef.current)clearTimeout(correctionCompareTimerRef.current);
      correctionCompareTimerRef.current=null;
      if(e.detail>1)return;
      const popup={relMsgId,x:e.clientX,y:e.clientY,compareCurrent:msgMap.get(relMsgId)?.relationPayload?.correctionKind!=='WIDTH'};
      if(!e.detail)setComparisonPopup(popup);
      else correctionCompareTimerRef.current=setTimeout(()=>{correctionCompareTimerRef.current=null;setComparisonPopup(popup);},500);
      return;
    }
    return runHandleInlineBadgeClick({ setLastClickedMessageId, toggleWholeUnit }, e, relMsgId);
  }

  /** Navigate to a message: switch canvas if needed, scroll, select (clear + add to candidates) */
  const handleNavigateToMessage = useCallback((messageId: string, options?: { select?: boolean; preserveScope?: boolean; recordHistory?: boolean; enterCategory?: boolean; onComplete?: ScrollMessageOptions['onComplete'] }) => {
    const recordLocation = () => {
      if (!options?.preserveScope && options?.recordHistory !== false) {
        // A jump locates the card; refreshing a container ID must not enter it.
        // Notifications locate without selecting and retain their enclosing route.
        recordBrowsingNavigation(options?.select === false ? undefined : messageNavigationUrl(window.location.href, messageId, true));
      }
    };
    const settlement = messagesRef.current.find(message=>message.id===messageId);
    if(isSettlementRecord(settlement)){
      if(!settlement?.settlementTargetId){
        pendingRemoteNavigationRef.current=null;
        pendingScrollMsgRef.current=null;
        pendingScrollDependencyIdsRef.current=[];
        pendingScrollCompletionRef.current=undefined;
        setAutoClassifyMsgId(null);
        options?.onComplete?.(false);
        showAlert('这条结算记录没有保存目标消息，请从原消息的结算入口查看');return;
      }
      messageId=settlement.settlementTargetId;
      if(typeof settlement.roundPayload?.roundId==='string')sessionStorage.setItem('settlementHighlightRound',settlement.roundPayload.roundId);
      openSettlement(messageId,settlement.roundPayload?.settlementType==='VALUE'?'VALUE':'TRUTH');
    }
    if (options?.enterCategory && ['classify', 'summary', 'arrange', 'merge'].includes(settlement?.relationType ?? '')) {
      pendingRemoteNavigationRef.current = null;
      pendingScrollMsgRef.current = null;
      pendingScrollDependencyIdsRef.current = [];
      pendingScrollCompletionRef.current = undefined;
      setAutoClassifyMsgId(null);
      exitAllTemporaryCategories();
      setTraceEntries([]); setTraceExpandedFrameIds(new Set());
      setContainerPreviewId(null); setComparisonMode(false); setComparisonReviewed(false);
      setCorrectionFilterTargetId(null); setHomeFilterMode(null); clearCleanView();
      setRecordCategory(null); setPreviewClassifyId(null);
      classifyStackRef.current = [];
      enterClassification(messageId, options.recordHistory !== false);
      setDraftUnits([]); setActiveTextSelectId(null); setLastClickedMessageId(messageId);
      options.onComplete?.(true);
      return;
    }
    if (findVisibleMessageElement(leftPanelRef.current, messageId, relationsRef.current, edgesRef.current)) {
      // Locating a message already on screen must preserve the current scope,
      // reading trace, filters, expanded frames and composer selections.
      if (options?.select !== false) recordLocation();
      pendingRemoteNavigationRef.current = null;
      pendingScrollMsgRef.current = null;
      pendingScrollDependencyIdsRef.current = [];
      pendingScrollCompletionRef.current = undefined;
      pendingViewportRestoreRef.current = null;
      setAutoClassifyMsgId(null);
      navigationTaskRef.current?.cancel();
      if (viewNavigationTimerRef.current !== null) clearTimeout(viewNavigationTimerRef.current);
      viewNavigationTimerRef.current = null;
      if (options?.select !== false) setDraftUnits([{ messageId, selection: { kind: 'whole' } }]);
      setLastClickedMessageId(messageId);
      scrollMsgToCenter(messageId, { onComplete: options?.onComplete });
      return;
    }
    if ((viewerStructure || !isPreloaded) && !messagesRef.current.some(message => message.id === messageId)) {
      const request = { messageId, options };
      pendingRemoteNavigationRef.current = request;
      const task = beginLoading();
      task.onCancel(() => { if (pendingRemoteNavigationRef.current === request) pendingRemoteNavigationRef.current = null; });
      void ensureMessages([messageId]).then(() => {
        requestAnimationFrame(() => {
          if (pendingRemoteNavigationRef.current === request && !messagesRef.current.some(message => message.id === messageId)) {
            pendingRemoteNavigationRef.current = null;
            showAlert('未找到该消息，消息可能已删除或不在当前可访问范围内');
            options?.onComplete?.(false);
          }
        });
      }).catch(error => {
        if (pendingRemoteNavigationRef.current === request) {
          pendingRemoteNavigationRef.current = null;
          showAlert(error instanceof Error ? error.message : '消息加载失败');
          options?.onComplete?.(false);
        }
      }).finally(task.complete);
      return;
    }
    if (!messagesRef.current.some(message => message.id === messageId)) {
      showAlert('未找到该消息，消息可能已删除或不在当前可访问范围内');
      options?.onComplete?.(false);
      return;
    }
    // Wait for a remote target to exist before replacing the shareable destination.
    // Record before changing scope or selection so Back restores the origin.
    recordLocation();
    const joinMessage=messagesRef.current.find(message=>message.id===messageId);
    if(isReviewDiscussion(joinMessage)){
      if(!openReviewRecords(messageId,options)){showAlert('这条审核记录没有保存目标消息');options?.onComplete?.(false);}
      return;
    }
    if(joinMessage?.kind==='join'){
      const record=relationsRef.current.find(relation=>relation.id===messageId);
      const members=(record?.targetRefs??joinMessage.targetRefs??[]).map(ref=>ref.kind==='relation'?ref.relationId:ref.messageId);
      const parent=record?.sourceMessageId??joinMessage.joinInfo?.containerId??joinMessage.sourceMessageId;
      const inRecordCategory=recordCategory?.recordIds.includes(messageId);
      const inJoinCategory=joinFilterTargetId!==null&&(joinFilterDirection==='outgoing'?joinFilterTargetId===parent:members.includes(joinFilterTargetId));
      if(!inRecordCategory&&!inJoinCategory){
        const anchor=members[0]??parent;
        if(!anchor){showAlert('这条加入记录没有保存目标或容器消息');return;}
        handleJoinRecords(anchor,members.length?'incoming':'outgoing');
      }
      scrollRequestIdRef.current++;
      setReadingAnchorId(null);
      if(options?.select!==false)setDraftUnits([{messageId,selection:{kind:'whole'}}]);
      setLastClickedMessageId(messageId);
      pendingScrollDependencyIdsRef.current=[];
      pendingScrollMsgRef.current=messageId;
      pendingScrollCompletionRef.current=options?.onComplete;
      setScrollKey(key=>key+1);
      return;
    }
    if(!options?.preserveScope&&messagesRef.current.find(message=>message.id===messageId)?.relationType==='correct'){
      openCorrectionRecords(messageId,options);
      return;
    }
    scrollRequestIdRef.current++;
    const wasTemporaryCategoryActive = temporaryCategoryStackRef.current.length > 0
      || joinFilterTargetId !== null;
    const targetMessage = messagesRef.current.find(message => message.id === messageId);
    const navigationFilterState = navigationVisibilityRef.current;
    const targetCleanFiltered = navigationFilterState.cleanMode
      && navigationFilterState.cleanVisibleIds
      && !navigationFilterState.cleanVisibleIds.visibleRelIds.has(messageId)
      && !navigationFilterState.cleanVisibleIds.visibleTextIds.has(messageId);
    const targetTypeFiltered = navigationFilterState.msgFilter.hideJoin && targetMessage?.kind === 'join';
    const canAutoClearTargetFilters = Boolean(targetCleanFiltered || targetTypeFiltered);
    if (canAutoClearTargetFilters) {
      if (targetCleanFiltered) {
        clearCleanView();
      }
      if (targetTypeFiltered) {
        setMsgFilter(previous => ({
          ...previous,
          hideJoin: targetMessage?.kind === 'join' ? false : previous.hideJoin,
        }));
      }
    }
    setReadingAnchorId(null);
    if (!options?.preserveScope) {
      setReadingFocusId(null);setTemporaryReadingIds(new Set());
      activeSentMessageRef.current = null;
      setSentMessageTargets([]);
      if (wasTemporaryCategoryActive) {
        // JOIN history temporarily reveals JOIN cards. Restore the original
        // filter when following its member/container labels; keep JOINs visible
        // only when the requested destination is itself a JOIN record.
        exitAllTemporaryCategories({ restoreMessageFilter: targetMessage?.kind !== 'join' });
        if (targetMessage?.kind === 'join') {
          setClassifyRelMsgId(null);
          setClassifyKey(k => k + 1);
        }
      } else {
        setJoinFilterTargetId(null);
      }
      // A jump supersedes delayed restore/preview positioning from the old view.
      cancelViewNavigation();
      cancelScrollRafs();
      pendingViewportRestoreRef.current=null;
      containerPreviewStack.current=[];
      setContainerPreviewId(null);
      comparisonOrigin.current=null;
      setComparisonMode(false);
      setComparisonReviewed(false);
      setComparisonTargetId(null);
      setComparisonReviewBaseMessages(null);
      setComparisonReviewBaseEdges(null);
      setCorrectionFilterTargetId(null);
      if(homeNavigationRef.current.mode&&!homeNavigationRef.current.result?.displayIds.has(messageId))setHomeFilterMode(null);
      setTraceEntries([]);
      setTraceExpandedFrameIds(new Set());
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
    setLastClickedMessageId(messageId);
    // Scroll after canvas switch; bump scrollKey so the scroll effect re-triggers even
    // when the target is already on the current canvas (no classifyKey change).
    pendingScrollDependencyIdsRef.current = [];
    pendingScrollMsgRef.current = messageId;
    pendingScrollCompletionRef.current = options?.onComplete;
    setScrollKey(k => k + 1);
  }, [cleanMode, joinFilterTargetId, joinFilterDirection, recordCategory, correctionFilterTargetId, msgFilter, clearCleanView, showAlert, hiddenInGraphView, isPreloaded, onDemand, viewerStructure, ensureMessages, openSettlement, beginLoading]);
  navigateToMessageRef.current=handleNavigateToMessage;

  const pendingRemoteNavigationRef = useRef<{ messageId: string; options?: { select?: boolean; preserveScope?: boolean; recordHistory?: boolean; enterCategory?: boolean; onComplete?: ScrollMessageOptions['onComplete'] } } | null>(null);
  useMessageLinkNavigation(!loading && !loadError, handleNavigateToMessage, browsingHistory.handlesCurrentLocation);
  useNotificationNavigation({ready:!loading&&!isPreloaded&&!loadError,navigate:handleNavigateToMessage,openSettlement,openReview:openReviewSummary,onError:showAlert,
    onLocated:(source,target)=>setNotificationFocusIds(target?[source,target]:[source])});
  useEffect(() => {
    const pending = pendingRemoteNavigationRef.current;
    if (!pending || !messages.some(message => message.id === pending.messageId)) return;
    pendingRemoteNavigationRef.current = null;
    handleNavigateToMessage(pending.messageId, pending.options);
  }, [messages, handleNavigateToMessage]);

  const activePageParent = recordCategory?`related:${recordCategory.targetId}`:joinFilterTargetId ? `related:${joinFilterTargetId}` : correctionFilterTargetId ? `related:${correctionFilterTargetId}` : containerPreviewId ?? currentClassifyRelMsgId ?? scopeMessageId;

  function confirmMessageIdNavigation(value: string): void {
    const id = value.trim();
    if (id && (viewerStructure || !isPreloaded) && !messagesRef.current.some(message => message.id === id)) { handleNavigateToMessage(id); return; }
    return runConfirmMessageIdNavigation({ messageIdInput: value, showAlert, messagesRef, handleNavigateToMessage });
  }

  async function runLocalBatch(work: () => Promise<void>, onCommitted: (count: number) => void) {
    if (!localMessageData || localDraftRef.current) throw new Error('本地文件正在保存，请稍候');
    const draft = new LocalDiscussion(localMessageData, viewerUser?.username ?? '');
    localDraftRef.current = draft;
    try { await work(); onCommitted(await draft.commit(saveLocalDiscussion)); }
    finally { localDraftRef.current = null; }
  }
  async function localWrite<T>(work: (draft: LocalDiscussion) => Promise<T>): Promise<T> {
    if (localDraftRef.current) return work(localDraftRef.current);
    let result!: T;
    await runLocalBatch(async () => { result = await work(localDraftRef.current!); }, () => {});
    return result;
  }
  async function saveLocalDiscussion(next: ExportData) {
    await persistPreloadedExport({ ...next, view: {
      username: next.viewerUsername ?? null, mode: viewMode,
      messageFilter: { ...msgFilter }, homeFilter: homeFilterMode,
      cleanFilters: cleanFilters.map(rule => ({ ...rule })), classificationId: currentClassifyRelMsgId,
      discussion: copyDiscussionView(discussion.value),
    } });
  }

  async function saveLocalEditingView(next: NonNullable<typeof zhihuData>) {
    await persistPreloadedExport({ ...(nativeZhihuData ? next === zhihuData ? nativeZhihuData : nativeZhihuDocument(next)
      : next), view: {
      username: displayUser?.username ?? null, mode: viewMode,
      messageFilter: { ...msgFilter }, homeFilter: homeFilterMode,
      cleanFilters: cleanFilters.map(rule => ({ ...rule })), classificationId: currentClassifyRelMsgId,
      discussion: copyDiscussionView(discussion.value),
    } });
  }

  const handleNavigateFromCorrectionTemporaryCategory = useCallback((messageId: string, switchToList: boolean) => {
    if (correctionFilterTargetId === null) {
      handleNavigateToMessage(messageId);
      return;
    }
    recordBrowsingNavigation();
    pendingCorrectionNavigationRef.current = { messageId };
    exitTemporaryCategory({ recordHistory: false });
    setCorrectionFilterTargetId(null);
    if (switchToList) setViewMode('list');
  }, [correctionFilterTargetId, handleNavigateToMessage, viewMode]);

  function handleInlineBadgeDoubleClick(e: React.MouseEvent, relMsgId: string, detail?: { relMsgIds?: string[]; subDetails?: Array<{ subType: string; customLabel?: string; count: number }> }): void {
    if(correctionCompareTimerRef.current)clearTimeout(correctionCompareTimerRef.current);
    correctionCompareTimerRef.current=null;
    setComparisonPopup(null);
    const edge=edgesRef.current.find(edge=>edge.relationMessageId===relMsgId);
    if(edge&&getPresentationSpec(edge.relationType).kind==='inline-badge'){
      e.stopPropagation();
      const ids=detail?.relMsgIds??[...new Set(edgesRef.current.filter(value=>value.relationType===edge.relationType&&isWholeMessageSelection(value.to,edge.to.messageId)).map(value=>value.relationMessageId))];
      openRecordCategory(edge.to.messageId,relationTypeName(edge.relationType),ids);return;
    }
    return runHandleInlineBadgeDoubleClick({ edges, setTagPopup, enterTemporaryCategory, setJoinFilterTargetId, setCorrectionFilterTargetId, setViewMode, setComparisonPopup }, e, relMsgId, detail);
  }

  function openCorrectionRecords(messageId:string,options?:{recordHistory?:boolean;onComplete?:ScrollMessageOptions['onComplete'];readingContext?:ReadingTask[]}):boolean{
    const targetId=edgesRef.current.find(edge=>edge.relationMessageId===messageId&&edge.relationType==='correct')?.to.messageId;
    if(!targetId)return false;
    const changed=readingMessageIds.length!==1||readingFocusId!==messageId||correctionFilterTargetId!==targetId;
    if(changed)recordReadingNavigation();
    if(changed&&options?.recordHistory!==false)recordBrowsingNavigation();
    cancelViewNavigation();cancelScrollRafs();pendingViewportRestoreRef.current=null;setAutoClassifyMsgId(null);
    if(correctionFilterTargetId!==targetId)enterTemporaryCategory(true);
    if((traceEntries.length||options?.readingContext)&&!(traceEntries.at(-1)?.ids.length===1&&traceEntries.at(-1)?.ids[0]===messageId))alignReadingTrace([messageId],options?.readingContext??[]);
    setJoinFilterTargetId(null);setContainerPreviewId(null);setComparisonMode(false);setComparisonReviewed(false);
    setCorrectionFilterTargetId(targetId);setViewMode('list');
    setLastClickedMessageId(messageId);setReadingFocusId(messageId);setReadingAnchorId(null);
    pendingScrollMsgRef.current=messageId;pendingScrollDependencyIdsRef.current=[];
    pendingScrollCompletionRef.current=options?.onComplete;
    setScrollKey(key=>key+1);
    return true;
  }

  function openReviewRecords(messageId:string,options?:{select?:boolean;onComplete?:ScrollMessageOptions['onComplete']}):boolean{
    const record=messagesRef.current.find(message=>message.id===messageId);
    const reference=record&&reviewRecordTarget(record),targetId=reference?.messageId;
    if(!targetId)return false;
    const revision=reference.revision;
    const process=isReviewProcessRecord(record),focusId=process?targetId:messageId;
    if(recordCategory?.label!=='审核'||recordCategory.targetId!==targetId||recordCategory.revision!==revision)openRecordCategory(targetId,'审核',process?[]:[messageId],revision);
    if(!process)setRecordCategory(current=>current?{...current,recordIds:[...new Set([...current.recordIds,messageId])]}:current);
    if(options?.select!==false)setDraftUnits([{messageId:focusId,selection:{kind:'whole'}}]);
    setLastClickedMessageId(focusId);setReadingAnchorId(null);
    pendingScrollMsgRef.current=focusId;pendingScrollDependencyIdsRef.current=[];
    pendingScrollCompletionRef.current=options?.onComplete;setScrollKey(key=>key+1);
    return true;
  }

  function toggleWholeUnit(msgId: string): void {
    return runToggleWholeUnit({ setDraftUnits }, msgId);
  }

  // Composer edits and progress-dialog updates do not change the graph.
  // Keep its input arrays stable so they do not restart layout and measurement.
  const reviewFolderIds=useMemo(()=>{
    if(!activeReviewContext||!currentClassifyRelMsgId||!sameReviewContext(activeReviewContext,reviewContextOf(msgMap.get(currentClassifyRelMsgId))))return;
    const owned=containerEffect.ownership.owned(currentClassifyRelMsgId);
    return new Set([activeReviewContext.messageId,...owned.textIds,...owned.relationIds]);
  },[activeReviewContext,currentClassifyRelMsgId,msgMap,containerEffect]);
  const { messagesToRenderFiltered, comparisonViewIds, correctionTemporaryViewIds,
    rawEdgesToRender, effectiveSuppressedRelIds,
    temporaryEdgesToRender, suppressedRelIds, previewMessages, edgesToRender, graphMessagesFinal } = useMemo(() => {
  const messagesToRender = viewMode === "list" ? listMessagesToRender : graphMessagesToRender;
  const correctedMessages = messagesToRender.map(message => {
    const correction = correctionVersions.get(message.id)?.current;
    return correction ? withCorrectionContent(message, correction.content, correction.changes, correction.snapshot) : message;
  });
  // Phase 6: Apply clean mode filter (multi-dimensional rules via useCleanView)
  const messagesToRenderClean = cleanVisibleIds
    ? correctedMessages.filter(m =>
      cleanVisibleIds.visibleTextIds.has(m.id) || cleanVisibleIds.visibleRelIds.has(m.id))
    : correctedMessages;
  const homeFilteredMessages = homeFilterResult
    ? messagesToRenderClean.filter(message => homeFilterResult.displayIds.has(message.id)||temporaryReadingIds.has(message.id))
    : messagesToRenderClean;
  // Message type filter: hide settlement/join messages
  const typeFilteredMessages = [...new Map([...applyMessageFilter(homeFilteredMessages, msgFilter),...correctedMessages.filter(message=>temporaryReadingIds.has(message.id))].map(message=>[message.id,message])).values()];
  const temporaryJoinViewIds = joinFilterTargetId
    ? new Set((joinFilterDirection === 'outgoing'
      ? (joinRelationsBySource.get(joinFilterTargetId) ?? [])
      : (joinRelationsByTarget.get(joinFilterTargetId) ?? [])
    ).map(join => join.id))
    : null;
  // The chooser uses the scope captured before switching to the candidate list.
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
  const messagesToRenderFiltered = (comparisonViewIds
    ? Array.from(comparisonViewIds)
      .map(id => msgMap.get(id))
      .filter((message): message is DemoMessage => Boolean(message))
    : recordCategory
      ? [...reviewFolderIds??recordCategoryMessageIds!].flatMap(id=>{
        const message=recordCategory.label==='审核'&&id===recordCategory.targetId&&!isPreloaded?reviewedMessage:msgMap.get(id);
        return message?[message]:[];
      })
    : correctionTemporaryViewIds
      ? Array.from(correctionTemporaryViewIds)
        .map(id => msgMap.get(id))
        .filter((message): message is DemoMessage => Boolean(message))
      : temporaryJoinViewIds
        ? Array.from(temporaryJoinViewIds)
          .map(id => msgMap.get(id))
          .filter((message): message is DemoMessage => Boolean(message))
          .filter(message => !msgFilter.hideJoin || message.kind !== 'join')
        : typeFilteredMessages).filter(message=>recordCategory?.label==='审核'&&message.id===recordCategory.targetId||!localInactiveRelationIds.has(message.id)&&!isSettlementRecord(message)&&(!isReviewDiscussion(message)||recordCategory?.label==='审核')&&(message.kind!=='join'||comparisonMode||joinFilterTargetId!==null||recordCategory!==null)).map(message=>{
          if(message===reviewedMessage)return message;
          const state=containerEffect.msgMap.get(message.id)?.state;
          return state&&state!==message.state?{...message,state}:message;
        });

  const recordCategoryIds = reviewFolderIds??recordCategoryMessageIds;
  const graphMessageIdsForProjection = new Set(graphMessagesToRender.map(message=>message.id));
  const projectionEdgesToRender = recordCategoryIds?edges.filter(edge=>recordCategoryIds.has(edge.relationMessageId)):[
    ...(viewMode === "list" ? listEdgesToRender : graphEdgesToRender),
    ...(viewMode !== "list"
      ? (traceEntries.length > 0 ? graphEdgesToRender : edges).filter(edge =>
        getPresentationSpec(edge.relationType).isContainer &&
        (traceRelationMsgIds.has(edge.relationMessageId) ||
          graphMessageIdsForProjection.has(edge.relationMessageId))
      )
      : []),
  ];
  const declaredEdgeIds = new Set<string>();
  const declaredEdgesToRender = filterContainerEdgesByEffectiveJoins(
    projectionEdgesToRender,
    relations,
    effectiveJoinRelationIds,
    containerEffect.joinByTarget,
  ).filter(edge => {
    if (declaredEdgeIds.has(edge.id)) return false;
    declaredEdgeIds.add(edge.id);
    return true;
  });
  const visibleContainerIds=new Set(messagesToRenderFiltered.map(message=>message.id));
  const rawEdgesToRender=projectJoinMembershipEdges(declaredEdgesToRender,relations,effectiveJoinRelationIds,visibleContainerIds,containerEffect.joinByTarget);
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
  const effectiveSuppressedRelIds = containerEffect.suppressed;
  const comparisonSuppressedRelIds = comparisonReviewed && comparisonTargetId
    ? comparisonSide === 'agree' ? comparisonAgreeSuppressedRelIds : comparisonDisagreeSuppressedRelIds
    : effectiveSuppressedRelIds;
  const filteredEdgesToRender = temporaryEdgesToRender.filter(edge =>
    edge.relationType === 'correct' || !comparisonSuppressedRelIds.has(edge.relationMessageId),
  );
  // The linear list keeps the annotation and its DISAGREE relation so the
  // user's stance can be shown on the source message. The non-linear graph
  // uses the suppressed relation set as a visual projection only.
  const previewMessages=containerPreview?applyMessageFilter(containerPreview.messages,msgFilter).filter(message=>!localInactiveRelationIds.has(message.id)&&(recordCategory?.label==='审核'||!isReviewDiscussion(message))):null;
  const edgesToRender = (containerPreview?.edges??(viewMode === "list" ? temporaryEdgesToRender : filteredEdgesToRender))
    .filter(edge=>!localInactiveRelationIds.has(edge.relationMessageId)&&!localInactiveRelationIds.has(edge.from.messageId)&&!localInactiveRelationIds.has(edge.to.messageId)&&(recordCategory?.label==='审核'||!isReviewRecord(edge)&&!isReviewDiscussion(msgMap.get(edge.relationMessageId))));
  const suppressedRelIds = comparisonSuppressedRelIds;
  const graphMessagesFinal = (previewMessages ?? messagesToRenderFiltered).map(message => {
    const correction = visibleCorrectionVersions.get(message.id)?.current;
    return correction ? withCorrectionContent(message, correction.content, correction.changes, correction.snapshot) : message;
  });
  return { messagesToRenderFiltered, comparisonViewIds, correctionTemporaryViewIds,
    rawEdgesToRender, rawEdgesToRenderClean, effectiveSuppressedRelIds,
    temporaryEdgesToRender, suppressedRelIds, previewMessages, edgesToRender, graphMessagesFinal };
  }, [viewMode, listMessagesToRender, graphMessagesToRender, visibleCorrectionVersions, cleanVisibleIds,
    homeFilterResult, msgFilter, joinFilterTargetId, joinFilterDirection, joinRelationsBySource,
    joinRelationsByTarget, comparisonMode, comparisonTargets, correctionFilterTargetId, edges, msgMap,
    listEdgesToRender, graphEdgesToRender, traceEntries.length, traceRelationMsgIds, relations,
    effectiveJoinRelationIds, messages, displayUser?.username, comparisonReviewed, comparisonTargetId,
    comparisonSide, comparisonAgreeSuppressedRelIds, comparisonDisagreeSuppressedRelIds, containerPreview, containerEffect, temporaryReadingIds, recordCategory, recordCategoryMessageIds, reviewFolderIds,reviewedMessage, isPreloaded, localInactiveRelationIds]);
  const canvasHideMessageIds=useMemo(()=>recordCategory?.label==='审核'?new Set([...(hideMessageIds??[])].filter(id=>!recordCategoryMessageIds?.has(id))):hideMessageIds,[recordCategory?.label,recordCategoryMessageIds,hideMessageIds]);
  const reviewDiscussionEdges=useMemo(()=>recordCategory?.label==='审核'?projectReviewDiscussionEdges(edgesToRender,relations):edgesToRender,[recordCategory?.label,edgesToRender,relations]);
  const reviewedCardIds=useMemo(()=>recordCategory?.label==='审核'?new Set([recordCategory.targetId]):undefined,[recordCategory?.label,recordCategory?.targetId]);
  const reviewStandaloneIds=useMemo(()=>reviewedCardIds?new Set([...reviewedCardIds,...graphMessagesFinal.filter(message=>!isReviewRecord(message)&&isCardMessage(message)).map(message=>message.id)]):undefined,[reviewedCardIds,graphMessagesFinal]);
  const messageWindow = useMessageWindow(
    viewMode === 'list' ? previewMessages ?? messagesToRenderFiltered : graphMessagesFinal,
    edgesToRender, onDemand && !isPreloaded && !comparisonReviewed && !containerPreview && traceEntries.length === 0,
    JSON.stringify([scopeMessageId, activePageParent, viewMode, cleanFilters, homeFilterMode, msgFilter, comparisonMode]),
    [lastClickedMessageId ?? '', ...sendPreview.ids, ...draftUnits.map(unit => unit.messageId), ...sourceUnits.map(unit => unit.messageId), ...targetUnits.map(unit => unit.messageId)],
    !comparisonReviewed && !containerPreview && traceEntries.length === 0,'time',
    viewerBodyPage ? { ...viewerBodyPage, loadMore: loadMoreViewerBodies } : undefined);
  const readingScope=traceScopeIds;
  const readingAllowed=useMemo(()=>new Set([...applyMessageFilter(messages.filter(message=>(!cleanVisibleIds||cleanVisibleIds.visibleTextIds.has(message.id)||cleanVisibleIds.visibleRelIds.has(message.id))
    &&(!homeFilterResult||homeFilterResult.displayIds.has(message.id))),msgFilter).map(message=>message.id),...readingMessageIds]),[messages,cleanVisibleIds,homeFilterResult,msgFilter,readingMessageIds]);
  const readingScopeKey=JSON.stringify([scopeMessageId,traceEntries.map(entry=>entry.ids),traceDepths,readingOrder,cleanFilters,homeFilterMode,msgFilter]);
  function alignReadingTrace(ids:string[],tasks:ReadingTask[]):void{
    if(!traceEntries.length){
      if(ids.length>1)enterTraceMultiple(ids);else enterTrace(ids[0]);
      if(tasks.length)setTraceEntries(entries=>entries.map((entry,index)=>index===entries.length-1?{...entry,readingContext:tasks}:entry));
    }else{
      recordBrowsingNavigation();
      // Reading history owns each visited scope. Retarget the current trace
      // without stacking an extra trace layer for every message in the queue.
      setTraceEntries(entries=>entries.map((entry,index)=>index===entries.length-1?{
        ...entry,ids:[...ids],mode:'trace',scopeRelationMessageId:undefined,relatedView:undefined,readingContext:tasks,
      }:entry));
      setTraceExpandedFrameIds(new Set());
      resetFrameExpansion();
      classifyStackRef.current=[];setClassifyRelMsgId(null);setClassifyKey(key=>key+1);setTraceKey(key=>key+1);
    }
  }
  async function navigateReading(id:string,tasks:ReadingTask[]=[],forceTrace=false,groupIds=[id]):Promise<void>{
    pendingReadingLoadRef.current?.reject(new DOMException('已切换到其他消息','AbortError'));
    pendingReadingLoadRef.current=null;
    const missing=groupIds.filter(id=>!messagesRef.current.some(message=>message.id===id));
    if(missing.length&&(viewerStructure||!isPreloaded&&onDemand)){
      return new Promise<void>((resolve,reject)=>{
        const request={id,ids:[...groupIds],tasks,force:forceTrace,loaded:false,resolve,reject};pendingReadingLoadRef.current=request;
        const task=beginLoading();
        task.onCancel(()=>{if(pendingReadingLoadRef.current===request){pendingReadingLoadRef.current=null;reject(new DOMException('已取消消息加载','AbortError'));}});
        void ensureMessages(missing).then(()=>{if(pendingReadingLoadRef.current===request){request.loaded=true;setScrollKey(key=>key+1);}})
          .catch(error=>{if(pendingReadingLoadRef.current===request){pendingReadingLoadRef.current=null;reject(error);}}).finally(task.complete);
      });
    }
    if(groupIds.some(id=>!messagesRef.current.some(message=>message.id===id)))throw new Error('目标消息暂未加载，请重试');
    const roots=new Set(traceEntries.at(-1)?.ids??[]);
    const sameTraceGroup=traceEntries.at(-1)?.mode!=='scope'&&roots.size===groupIds.length&&groupIds.every(id=>roots.has(id));
    const sameReadingGroup=readingMessageIds.length===groupIds.length&&groupIds.every(id=>readingMessageIds.includes(id));
    const currentCorrection=groupIds.length===1&&correctionFilterTargetId!==null
      &&edgesRef.current.some(edge=>edge.relationMessageId===id&&edge.relationType==='correct'&&edge.to.messageId===correctionFilterTargetId);
    if(sameTraceGroup&&sameReadingGroup&&readingAnchorId===id&&(!hasTraceOverlay()||currentCorrection))return;
    if(!sameTraceGroup||!sameReadingGroup||hasTraceOverlay()&&!currentCorrection)recordReadingNavigation();
    setReadingDecorationExpansion(previous=>({requestId:previous.requestId+1,messageIds:[...new Set([...groupIds,...tasks.flatMap(task=>task.influence?[task.influence.messageId]:[])])]}));
    if(groupIds.length===1&&isReviewRecord(messagesRef.current.find(message=>message.id===id))){
      return new Promise<void>((resolve,reject)=>{
        const opened=openReviewRecords(id,{select:false,onComplete:(located,cancelled)=>{
          if(located){setReadingAnchorId(id);resolve();}
          else reject(cancelled?new DOMException('已取消消息定位','AbortError'):new Error('目标审核记录未能定位，请重试'));
        }});
        if(!opened)reject(new Error('未找到审核记录的目标'));
      });
    }
    if(groupIds.length===1&&messagesRef.current.find(message=>message.id===id)?.relationType==='correct'){
      return new Promise<void>((resolve,reject)=>{
        const opened=openCorrectionRecords(id,{readingContext:tasks,onComplete:(located,cancelled)=>{
          if(located){setReadingAnchorId(id);resolve();}
          else reject(cancelled?new DOMException('已取消消息定位','AbortError'):new Error('目标消息未能定位，请重试'));
        }});
        if(!opened)reject(new Error('未找到更正消息的目标'));
      });
    }
    if(correctionFilterTargetId!==null){
      const origin=temporaryCategoryStackRef.current.at(-1)?.snapshot;
      if(origin)setViewMode(origin.viewMode);
    }
    cancelViewNavigation();cancelScrollRafs();pendingViewportRestoreRef.current=null;setAutoClassifyMsgId(null);setReadingAnchorId(null);
    if(!sameTraceGroup||hasTraceOverlay()){
      alignReadingTrace(groupIds,tasks);
      suspendTraceOverlay();
      cancelScrollRafs();pendingViewportRestoreRef.current=null;
    }
    const reveal=new Set(groupIds),ancestors=new Set<string>(),parents=new Map<string,Set<string>>();
    for(const membership of traceContainerMemberships)for(const target of membership.targetIds){const values=parents.get(target)??new Set<string>();values.add(membership.containerId);parents.set(target,values);}
    for(const target of reveal)for(const parent of parents.get(target)??[]){reveal.add(parent);ancestors.add(parent);}
    const frames=[...ancestors].filter(target=>getPresentationSpec(msgMap.get(target)?.relationType??'').isContainer);
    setTraceExpandedFrameIds(previous=>new Set([...previous,...frames]));
    setReadingFocusAnchorId(id);setReadingMessageIds([...groupIds]);setTemporaryReadingIds(reveal);setLastClickedMessageId(id);
    pendingScrollCompletionRef.current?.(false,true);
    pendingScrollDependencyIdsRef.current=[];
    return new Promise<void>((resolve,reject)=>{
      pendingScrollMsgRef.current=id;
      pendingScrollCompletionRef.current=(located,cancelled)=>{if(located){setReadingAnchorId(id);resolve();}else reject(cancelled?new DOMException('已取消消息定位','AbortError'):new Error('目标消息未能定位，请重试'));};
      setScrollKey(key=>key+1);
    });
  }
  async function navigateReadingGroup(ids:string[],tasks:ReadingTask[],forceTrace=false):Promise<void>{
    const group=[...new Set(ids)];
    if(group.length)await navigateReading(group[0],tasks,forceTrace,group);
  }
  useEffect(()=>{
    const pending=pendingReadingLoadRef.current;
    if(!pending)return;
    if(pending.ids.every(id=>messages.some(message=>message.id===id))){
      pendingReadingLoadRef.current=null;
      void navigateReading(pending.id,pending.tasks,pending.force,pending.ids).then(pending.resolve,pending.reject);
    }else if(pending.loaded){pendingReadingLoadRef.current=null;pending.reject(new Error('未找到目标消息'));}
  },[messages,scrollKey]);
  function jumpWithinTrace(id:string):void{void navigateReading(id).catch(error=>{if(error.name!=='AbortError')showAlert(error.message);});}
  function returnReadingTrace(){
    recordReadingNavigation();
    recordBrowsingNavigation();cancelViewNavigation();
    runExitTrace({traceEntries,setTraceEntries,setTraceExpandedFrameIds,setTraceKey,classifyStackRef,setClassifyRelMsgId,setClassifyKey,restoreSnapshot});
  }
  renderedMessageIdsRef.current = new Set(messageWindow.messages.map(message => message.id));
  renderedRelationIdsRef.current = new Set(edgesToRender.map(edge => edge.relationMessageId));
  const comparisonAgreeGraph = comparisonGraphProjections?.agree;
  const comparisonDisagreeGraph = comparisonGraphProjections?.disagree;
  const comparisonGraphMessages = comparisonAgreeGraph?.messages ?? messagesToRenderFiltered;
  const invalidCorrectionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) if (message.relationPayload?.correctionKind === 'WIDTH' && effectiveSuppressedRelIds.has(message.id)) ids.add(message.id);
    for (const entry of correctionVersions.values()) {
      for (const version of entry.versions) if (!version.valid || version.conflicted) ids.add(version.correctionId);
    }
    return ids;
  }, [correctionVersions, messages, effectiveSuppressedRelIds]);

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
  const activeStanceMap = useMemo(() => computeUserActiveStanceRelIds(edges, messages, displayUser?.username ?? null),
    [edges, messages, displayUser?.username]);
  // Reverse map: stance relation message ID → { target, type } for quick lookup.
  const activeStanceByRelMsgId = useMemo(() => {
    const m = new Map<string, { targetRelId: string; type: 'agree' | 'disagree' }>();
    for (const [targetId, v] of activeStanceMap) m.set(v.relMsgId, { targetRelId: targetId, type: v.type });
    return m;
  }, [activeStanceMap]);
  // Overridden stances: the user's previous stance messages that are no longer active.
  const overriddenStanceRelIds = useMemo(() => computeUserOverriddenStanceRelIds(rawEdgesToRender, messages, displayUser?.username ?? null),
    [rawEdgesToRender, messages, displayUser?.username]);
  // Navigation identities contain view choices, never live message/reading data.
  const recentViewOwner = JSON.stringify([scopeMessageId, displayUser?.username, !!loadedExport]);
  const readingPresentationActive = !isPreloaded && readingState.ready && !sendPreview.active && !comparisonMode && !containerPreview && (homeReadingStatus === 'pending' || traceEntries.length > 0);
  const recentViewKey = JSON.stringify({
    mode:viewMode,classify:classifyRelMsgId,
    classifyPath:classifyStackRef.current.map(entry=>[entry.relMsgId,entry.frameScopeIds,entry.frameKnownIds]),
    trace:traceEntries.map(entry=>[entry.ids,entry.mode,entry.scopeRelationMessageId,entry.classifyRelMsgId,
      entry.classifyStack.map(scope=>[scope.relMsgId,scope.frameScopeIds,scope.frameKnownIds])]),depths:traceDepths,
    reading:readingMessageIds,frames:[...traceExpandedFrameIds].sort(),
    records:recordCategory?.label==='审核'?{targetId:recordCategory.targetId,label:recordCategory.label,revision:recordCategory.revision}:recordCategory,preview:previewClassifyId,effect:containerPreviewId,
    joins:[joinFilterTargetId,joinFilterDirection],corrections:correctionFilterTargetId,
    // Choosing a candidate updates selection within the same list. Replacing its
    // cached view would discard measured row heights and clamp the scroll offset.
    comparison:[comparisonMode,comparisonReviewed,
      comparisonReviewed ? comparisonTargetId : null,comparisonReviewed ? comparisonSide : null],
    filters:[msgFilter,homeFilterMode,cleanFilters],
    versions:[...readingVersions.keys()].sort().map(id=>[id,selectedReadingVersion(readingVersions,id)])
      .filter(([,value])=>value!=='current'&&value!=='personal'),
    pending:!!globalFilterPending,
  });
  if (!isViewerRoute && !authLoading && !preloadedData && !user) return null;
  if (loading) return null;
  if (loadError) {
    return (
      <div style={{ padding: 16, background: "var(--surface-101010)", color: "var(--ink-eee)", height: "100%" }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>加载失败</div>
        <pre style={{ whiteSpace: "pre-wrap", color: "var(--ink-ff8080)" }}>{loadError}</pre>
        {isViewerRoute && <button onClick={() => window.dispatchEvent(new Event('open-export-viewer'))}>选择阅览文件</button>}
      </div>
    );
  }
  const relationSpringWidth = Math.max(0, effectiveContainerWidth - relationBarMinWidth);
  const panelStickyTop = relationBarHeight;
  const isRouteScope = scopeMessageId !== 'root' && !isInsideClassify && traceEntries.length === 0;
  const classificationHeader = (recordCategory||isInsideClassify||isRouteScope||isTemporaryJoinCategory||correctionFilterTargetId!==null||comparisonMode)?<DeferredWorkbench label="分类标题" blocksDrawing><ClassificationHeader recordCategory={recordCategory} reviewFolder={!!reviewFolderIds} isTemporaryFrameCategory={isTemporaryFrameCategory} isInsideClassify={isInsideClassify || isRouteScope} isRouteScope={isRouteScope} isTemporaryJoinCategory={isTemporaryJoinCategory} correctionFilterTargetId={correctionFilterTargetId} comparisonMode={comparisonMode}
                zhihuQuestion={currentZhihuQuestion ? { description: currentQuestionFields?.body ?? currentClassifyRelMsg?.content ?? '', known: currentZhihuQuestion.descriptionKnown === true,
                  completeness: currentZhihuQuestion.descriptionCompleteness ?? 'unknown', createdAt: currentZhihuQuestion.createdAt, createdAtText: currentZhihuQuestion.createdAtText,
                  locallyCorrectedBody: Boolean(currentQuestionFields?.bodyCorrectionId), locallyCorrectedTitle: Boolean(currentQuestionFields?.titleCorrectionId) } : undefined}
                correctionRecords={currentClassifyRelMsg&&correctionVersions.get(currentClassifyRelMsg.id)?.versions.length?<span>
                  <span role="button" tabIndex={0} title="双击查看更正记录" style={{color:'var(--ink-fbbf24)',fontSize:10,cursor:'pointer'}}
                    onClick={event=>handleInlineBadgeClick(event,correctionVersions.get(currentClassifyRelMsg.id)!.versions[0].correctionId)}
                    onDoubleClick={event=>handleInlineBadgeDoubleClick(event,correctionVersions.get(currentClassifyRelMsg.id)!.versions[0].correctionId)}
                    onKeyDown={event=>{if(event.key==='Enter')handleInlineBadgeDoubleClick(event as unknown as React.MouseEvent,correctionVersions.get(currentClassifyRelMsg.id)!.versions[0].correctionId);}}>
                    ✏更正 {correctionVersions.get(currentClassifyRelMsg.id)!.versions.length}
                  </span>
                </span>:undefined}
                comparisonTargetCount={comparisonViewIds?.size ?? 0} correctionCount={correctionTemporaryViewIds?.size ?? 0} temporaryJoinCount={temporaryJoinCount} classificationTitle={isRouteScope ? (correctionVersions.get(scopeMessageId)?.current?.content ?? scope?.title ?? '分类') : classificationTitle} classifyKindLabel={classifyKindLabel}
                comparisonTargetId={comparisonTargetId} joinFilterTargetId={joinFilterTargetId} joinFilterDirection={joinFilterDirection} currentClassifyRelMsg={currentClassifyRelMsg}
                classifyTargetCount={isRouteScope ? messages.filter(message => message.kind !== 'relation').length : classifyTargetCount} classifyExitLabel={classifyExitLabel} onExitTemporary={comparisonMode?exitComparison:exitTemporaryCategory} onExitClassify={isRouteScope ? () => navigate('/messages') : handleExitClassification} /></DeferredWorkbench>:null;

  return (
    <ReviewDetailContext.Provider value={review}><ModerationContext.Provider value={isPreloaded?null:{summaries:new Map([...messages,...reviewedMessage?[reviewedMessage]:[]].flatMap(m=>m.moderation?[[m.id,m.moderation] as const]:[])),open:id=>openReviewSummary(id,reviewedMessage?.id===id?reviewedMessage.revision:undefined),arbitrate:id=>settlementOpenMsgId===id&&settlementOpenType==='REVIEW'?closeSettlement():openSettlement(id,'REVIEW'),activeId:settlementOpenType==='REVIEW'?settlementOpenMsgId??undefined:undefined}}>
    <DeferredWorkbench label="显示提示" blocksDrawing>
    <CardWidthContext.Provider value={cardWidthContext}>
    <ReadingTextLinksContext.Provider value={readingTextLinks}>
    <MessageDisplayHintsProvider input={displayHintsInput} onView={viewDisplayHint} onMarkRead={async (...args)=>{if(!sendPreview.active)await readingState.markRead?.(...args);}} readingError={readingState.error} onReadNavigate={(id,tasks)=>void navigateReading(id,tasks,traceEntries.length===0).catch(error=>{if(error.name!=='AbortError')showAlert(error.message);})}
      windowState={displayHintWindow} currentContainerId={hintContainerId} versionHistory={readingVersionHistory}>
      <AuthoredReadingBackfill enabled={!sendPreview.active&&!isPreloaded&&!loading&&readingState.ready} userId={user?.id}/>
      <ErrorBoundary onError={reportDrawingFailure}>
        <div className="workbench-shell" style={{ flex: "1 0 auto", width: effectiveContainerWidth, minWidth: MIN_LEFT_PX + MIN_RIGHT_PX + 12, margin: 0, display: "flex", flexDirection: "column", background: "var(--surface-101010)", color: "var(--ink-eee)", fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif", overflowX: "visible" }}>
          <DeferredWorkbench label="关系工具栏" blocksDrawing><RelationToolbar barRef={relationBarRef} leftControlsRef={relationLeftControlsRef} rightControlsRef={relationRightControlsRef}
            top={0} springWidth={relationSpringWidth} rightOffset={relationControlsRightOffset} viewer={isPreloaded && !localMessageData}
            localMode={localRelationMode}
            knownIds={knownMessageIds} onJump={confirmMessageIdNavigation}
            composer={{ relationType, secondaryRelationType, newMessageContent, subType, setRelationType, setSecondaryRelationType, setNewMessageContent, lastTagSecondaryRef, lastDelegationSecondaryRef, savedTextOnTypeSwitchRef, subTypeCustomBufferRef, guideTargetIdRef }} /></DeferredWorkbench>

          {/* 两侧内容必须自然展开，不得给内容层添加 height/maxHeight 等高度上限。
              滚动由独立悬浮视口承接，并跟随手机缩放后的实际可见范围，不能用 vh/dvh 截短内容。
              两侧独立滚动；当前侧到边界后只向整页传递剩余距离，不带动另一侧。
              保留页面边界传递和快捷符入口。 */}
          <div ref={panelContainerRef} className="workbench-panels" style={{ display: "flex", flex: "1 0 auto", width: "100%", minWidth: 0 }}>
            <div className="workbench-message-pane" data-workbench-panel-surface="true" style={{ flex: leftFlex, display: "flex", flexDirection: "column", minWidth: MIN_LEFT_PX, alignSelf: 'flex-start', position: 'sticky', top: panelStickyTop, overflow: "visible", paddingBottom: 8 }}>
              <DeferredWorkbench label="视图工具栏" blocksDrawing><WorkbenchViewToolbar top={panelStickyTop}
                onJump={confirmMessageIdNavigation}
                history={browsingHistory}
                scopeHeader={!containerPreview && !comparisonReviewed ? classificationHeader : undefined}
                scopeMessageId={scopeMessageId} exportTitle={scope?.title ?? 'export'} showAlert={showAlert}
                exportData={loadedExport ?? preloadedData} exportUsername={displayUser?.username ?? null}
                discussion={discussion}
                onLocalExport={localMessageData ? view => {
                  downloadExport(new Blob([JSON.stringify({ ...localMessageData, view, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' }), `${localMessageData.scope.title || '本地讨论'}.json`);
                } : zhihuData && !nativeZhihuData ? view => {
                  try {
                    const content = serializeGonglunZhihuViewingData({ ...zhihuData, view });
                    downloadExport(new Blob([content], { type: 'application/json' }), '知乎阅览.json');
                  } catch (error) { showAlert(error instanceof Error ? error.message : '下载失败'); }
                } : undefined}
                home={{ mode: homeFilterMode, onChange: setHomeFilterMode }}
                clean={{ pending: globalFilterPending || (onDemand && !isPreloaded && !catalogReady), active: cleanMode, filters: cleanFilters, matchCount: cleanMatchCount, totalCount: contentMsgCount, onAdd: addCleanFilter, onRemove: removeCleanFilter, onUpdate: updateCleanFilter, onClear: clearCleanView }}
                filter={{ settings: msgFilter, onChange: setMsgFilter }}
                view={{ viewMode, setViewMode, leftPanelRef, viewModeScrollRef, draftUnits, targetUnits, traceCount: traceEntries.length, currentClassifyRelMsgId, messages, relations, findContainingClassification, exitClassification, enterClassification, scheduleViewNavigation }}
                comparison={{ singleSideReview:Boolean(containerPreview), comparisonMode, comparisonReviewed, comparisonTargetId, setComparisonTargetId, onStartComparison: startComparison }}
                correctionFilterTargetId={correctionFilterTargetId} onLeaderboard={openLeaderboard} /></DeferredWorkbench>

              {loadedExport && (zhihuData || isNativeZhihuView(loadedExport)) && <ZhihuDirectorySync data={loadedExport} onUpdate={persistPreloadedExport} />}
              <WorkbenchScrollViewport ref={leftPanelRef}
                data-workbench-left-panel="true"
                data-send-preview-scene={sendPreview.active ? 'true' : undefined}
                onClickCapture={event=>{if(sendPreview.active){event.preventDefault();event.stopPropagation();}}}
                onDoubleClickCapture={event=>{if(sendPreview.active){event.preventDefault();event.stopPropagation();}}}
                onMouseUpCapture={event=>{if(sendPreview.active)event.stopPropagation();}}
                className={`workbench-left-panel ${previewClassifyId !== null && !containerPreview ? "preview-mode" : ""}`}
                style={{ flex: "1 1 auto", minHeight: 0, boxSizing: "border-box", overflowY: "auto", overflowX: "auto", touchAction: "pan-x pan-y pinch-zoom", WebkitOverflowScrolling: "touch", padding: 8, paddingBottom: 24, position: "relative" }}
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
                <ReadingCanvasPresentation viewport={leftPanelRef} active={readingPresentationActive} />
                {messagePulse && <MessageJumpOverlay messageId={messagePulse.messageId} targetElement={messagePulse.element} targetRect={messagePulse.rect} />}
                {!isPreloaded&&recordCategory?.label==='审核'&&(review.error||!review.detail)&&<p role={review.error?'alert':'status'} style={{padding:8}}>{review.error||'正在加载审核记录…'}</p>}
                <RecentWorkbenchViews key={recentViewOwner} ownerKey={recentViewOwner} viewKey={recentViewKey}
                  pending={!!viewerStructure && appliedScopeKey !== requestedViewerScopeKey}>
                {globalFilterPending ? (
                  <div role="status" style={{ padding: 48, textAlign: 'center', color: 'var(--ink-94a3b8)' }}>
                    {globalFilters.error ?? '正在准备全局筛选结果…'}
                    {globalFilters.error && <button onClick={globalFilters.retry}>重试筛选</button>}
                  </div>
                ) : (previewMessages??messagesToRenderFiltered).length === 0 && !containerPreview && !comparisonReviewed ? (
                  <div style={{ padding: 48, textAlign: "center", color: "var(--ink-666)", fontSize: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                    <div style={{ fontSize: 36, opacity: 0.3 }}>📭</div>
                    <div>{comparisonMode ? "没有可对比的消息" : isInsideClassify ? `当前${classifyKindLabel}中暂无消息` : traceEntries.length > 0 ? "追溯范围内没有可见消息" : isPreloaded ? "当前文档中暂无可见记录" : "暂无消息，请先发送一条消息或创建关系"}</div>
                    <div style={{ fontSize: 12, opacity: 0.7, maxWidth: 360, lineHeight: 1.6 }}>
                      {comparisonMode ? "仅列出当前视图内已有赞同或反对记录、且会改变显示效果的关系消息。" : isPreloaded ? "当前阅览范围内没有匹配的记录。可以调整筛选、退出分类或追溯；文件在本机阅览。" : isInsideClassify ? "该分类下还没有消息。你可以退出分类视图，在完整画布中发送消息。" : traceEntries.length > 0 ? "当前追溯范围内没有匹配的消息。尝试退出追溯或调整追溯距离。" : "发送消息需支付协议费，真假和价值至少一项大于 0，也可以同时投入。选中消息或正文片段后，选择关系并发送，即可继续讨论。"}
                    </div>
                    {isInsideClassify && (
                      <button className="workbench-scope-exit" onClick={handleExitClassification} style={{ marginTop: 8, padding: "4px 16px", borderRadius: 6, border: "1px solid var(--line-555)", background: "var(--surface-333)", color: "var(--ink-ccc)", cursor: "pointer", fontSize: 13 }}>
                        {classifyExitLabel}
                      </button>
                    )}
                  </div>
                ) : viewMode === "list" ? (
                  <DeferredWorkbench label="消息列表" blocksDrawing>
                  <WorkbenchMessageList
                    highlightedMessageIds={viewTargetMessageIds}
                    crossCanvasRelations={containerPreview?.context.crossCanvasRelations??crossCanvasRelations} onRelatedRelationView={viewRelatedRelation}
                    onRelatedNavigate={viewRelatedContainer} standaloneMessageIds={recordCategoryMessageIds??comparisonViewIds??correctionTemporaryViewIds??standaloneMessageIds}
                    showJoinRecords={comparisonMode||joinFilterTargetId!==null||recordCategory!==null}
                    visibleMessages={messageWindow.messages}
                    joinRecordContext={joinFilterTargetId&&joinFilterDirection==='outgoing'?{containerId:joinFilterTargetId,effect:containerPreview?.effect??containerEffect}:undefined}
                    catalog={{ messages:containerPreview?.allMessages??containerEffect.messages, edges:containerPreview?.edges??edges, msgMap:containerPreview?new Map(containerPreview.allMessages.map(message=>[message.id,message])):containerEffect.msgMap, relationById:containerPreview?new Map(containerPreview.relations.map(relation=>[relation.id,relation])):containerEffect.relationById, relationTypeByRelMsgId, joinRelationsByTarget, joinRelationsBySource, effectiveJoinRelationIds:containerPreview?.effectiveJoinIds??effectiveJoinRelationIds, joinStatusByMessage:containerPreview?.context.joinStatusByMessage??joinStatusByMessage, joinEffectSourcesByMessage:containerPreview?.context.joinEffectSourcesByMessage??containerEffect.context.joinEffectSourcesByMessage, containerOwnership:containerPreview?.effect.ownership??containerEffect.ownership, summaryCoverageByMessageId, correctionVersions }}
                    display={{ embeddedMessageIds:comparisonMode?new Set<string>():embeddedMessageIds, suppressedRelIds:containerPreview?.suppressed??suppressedRelIds, rejectedContainerIds:containerPreview?.rejectedContainerIds??rejectedContainerIds, overriddenStanceRelIds, readStatusByMessageId, preserveReadingLayout:readingPresentationActive, homeMatchIds: homeFilterResult?.matchIds, homeReasonByMessageId: homeFilterResult?.reasonByMessageId, homeDisplayRoleByMessageId, authorStakes, stakeCounts:correctionStances.counts, correctionFilterTargetId, joinFilterTargetId }}
                    comparison={{ comparisonReviewed, comparisonTargetId, comparisonRecommendedDisplay, activeStanceByRelMsgId, activeStanceMap }}
                    settlement={{ settlementOpenMsgId, settlementOpenType, settlementEntryHighlight, closeSettlement, openSettlement }}
                    selection={{ draftUnits, activeTextSelectId, lastClickedMessageId }}
                    cardHandlers={{ onClick: handleMessageClick, onDoubleClick: handleMessageDoubleClick, onMouseDown: handleMessageMouseDown, onMouseUp: handleMessageMouseUp, onContentMouseUp: handleTextMouseUp }}
                    scopeMessageId={scopeMessageId}
                    onJoinFilter={handleJoinRecords}
                    onNavigate={traceEntries.length?jumpWithinTrace:handleNavigateToMessage} onCorrectionNavigate={handleNavigateFromCorrectionTemporaryCategory}
                    onCorrectionHistory={handleInlineBadgeDoubleClick} onCorrectionCompare={handleInlineBadgeClick}
                    renderRelation={renderRelationContentWithTargets} renderContent={renderMessageContentWithAnchorsForList}
                  />
                  </DeferredWorkbench>
                ) : (
                  <DeferredWorkbench label="消息画布" blocksDrawing>
                  <GraphView
                    getMemberCounts={(containerPreview?.effect.ownership??containerEffect.ownership).memberCounts}
                    discussionView={recordCategory?.label==='审核'?{...discussion.value,mode:'discussion'}:discussion.value} onDiscussionViewChange={discussion.onChange}
                    onDiscussionBranchCollapse={scrollMsgToCenter}
                    pendingMessageIds={sendPreview.ids}
                    relatedEdges={containerPreview?.context.relatedEdges??relatedEdges} onRelatedRelationView={viewRelatedRelation}
                    relatedMessages={containerPreview?.allMessages??containerEffect.messages}
                    comparisonScopeHeader={correctionPreviewId||comparisonReviewed&&!containerPreview?undefined:classificationHeader}
                    comparisonSingle={Boolean(containerPreview)}
                    comparisonDisplay={containerPreview?'agree':undefined}
                    comparisonSuppressedRelIds={containerPreview?.suppressed}
                    rejectedContainerIds={containerPreview?.rejectedContainerIds??rejectedContainerIds}
                    rejectedRelationIds={containerPreview?.suppressed??suppressedRelIds}
                    onRelatedMessageNavigate={viewRelatedContainer}
                    standaloneMessageIds={reviewStandaloneIds??recordCategoryMessageIds??standaloneMessageIds}
                    forceCardMessageIds={reviewedCardIds}
                    showJoinRecords={joinFilterTargetId!==null||recordCategory!==null}
                    messages={!containerPreview&&comparisonReviewed ? comparisonGraphMessages : graphMessagesFinal} edges={!containerPreview&&comparisonReviewed ? (comparisonAgreeGraph?.edges ?? temporaryEdgesToRender) : reviewDiscussionEdges} invalidCorrectionIds={containerPreview?.suppressed??invalidCorrectionIds} correctionVersions={containerPreview?.corrections??visibleCorrectionVersions} cardWidths={containerPreview?.widths} draftUnits={draftUnits}
                    visibleMessageIds={messageWindow.enabled ? messageWindow.visibleIds : undefined}
                    visibleEdgeIds={messageWindow.enabled ? messageWindow.edgeIds : undefined}
                    structureOrder={messageWindow.enabled ? messageWindow.structureOrder : undefined}
                    joinFilterTargetId={joinFilterTargetId}
                    comparisonPair={!containerPreview&&comparisonReviewed} comparisonTargetId={containerPreview?containerPreviewId:comparisonTargetId} comparisonRecommendedDisplay={comparisonRecommendedDisplay}
                    comparisonAgreeMessages={comparisonAgreeGraph?.messages} comparisonAgreeEdges={comparisonAgreeGraph?.edges}
                    comparisonAgreeCorrectionVersions={comparisonAgreeGraph?.corrections}
                    comparisonAgreeCardWidths={comparisonAgreeGraph?.widths}
                    comparisonAgreeContext={comparisonAgreeGraph?.context}
                    comparisonAgreeHideMessageIds={comparisonAgreeGraph?.hideMessageIds}
                    comparisonDisagreeMessages={comparisonDisagreeGraph?.messages} comparisonDisagreeEdges={comparisonDisagreeGraph?.edges}
                    comparisonDisagreeCorrectionVersions={comparisonDisagreeGraph?.corrections}
                    comparisonDisagreeCardWidths={comparisonDisagreeGraph?.widths}
                    comparisonDisagreeContext={comparisonDisagreeGraph?.context}
                    comparisonDisagreeHideMessageIds={comparisonDisagreeGraph?.hideMessageIds}
                    comparisonAgreeSuppressedRelIds={comparisonAgreeSuppressedRelIds} comparisonDisagreeSuppressedRelIds={comparisonDisagreeSuppressedRelIds}
                    autoCenterMessageId={!containerPreview&&comparisonReviewed ? comparisonTargetId : null}
                    homeMatchIds={homeFilterResult?.matchIds}
                    homeReasonByMessageId={homeFilterResult?.reasonByMessageId}
                    homeContextRoleByMessageId={homeDisplayRoleByMessageId}
                    activeTextSelectId={activeTextSelectId} lastClickedMessageId={lastClickedMessageId}
                    onMessageClick={handleMessageClick} onMessageDoubleClick={handleMessageDoubleClick}
                    onTextMouseUp={handleTextMouseUp} onEdgeLabelSingleClick={handleEdgeLabelSingleClick}
                    onEdgeLabelDoubleClick={handleEdgeLabelDoubleClick} onFragmentAnchorClick={handleFragmentAnchorClick}
                    isFragmentSelected={isFragmentSelected} onCanvasBlankClick={handleCanvasBlankClick}
                    onMessageMouseDown={handleMessageMouseDown} onMessageMouseUp={handleMessageMouseUp}
                    excludedStanceEdges={correctionStances.excludedEdges}
                    onDecorationIconClick={handleDecorationIconClick}
                    onDecorationBodyClick={handleDecorationBodyClick}
                    onDecorationDoubleClick={handleDecorationDoubleClick}
                    selectedDecorations={selectedDecorations}
                    onTagBodyClick={handleTagBodyClick}
                    onTagDoubleClick={handleTagDoubleClick}
                    onGroupFrameClick={handleGroupFrameClick}
                    onGroupFrameDoubleClick={handleGroupFrameDoubleClick}
                    onFrameHeaderDoubleClick={handleFrameHeaderDoubleClick}
                    containerEntryEnabled={relationType!=='correct'}
                    onInlineBadgeClick={handleInlineBadgeClick}
                    onInlineBadgeDoubleClick={handleInlineBadgeDoubleClick}
                    hideMessageIds={containerPreview?containerPreview.hideMessageIds:canvasHideMessageIds}
                    traceExpandedFrameIds={traceExpandedFrameIds}
                    expandAllFrames={traceEntries.length>0||!!containerPreview}
                    frameViewStateRef={graphFrameViewStateRef}
                    frameViewRestoreKey={frameViewRestoreKey}
                    highlightedMessageIds={highlightedMessageIds}
                    locatedMessageIds={viewTargetMessageIds}
                    decorationExpansion={traceEntries.length&&readingDecorationExpansion.messageIds[0]===readingFocusId?readingDecorationExpansion:undefined}
                    traceFrameIds={traceFrameIds}
                    stakeCounts={correctionStances.counts}
                    onSettlementToggleTruth={(msgId) => { if (settlementOpenMsgId === msgId && settlementOpenType === 'TRUTH') { closeSettlement(); } else { openSettlement(msgId, 'TRUTH'); } }}
                    onSettlementToggleValue={(msgId) => { if (settlementOpenMsgId === msgId && settlementOpenType === 'VALUE') { closeSettlement(); } else { openSettlement(msgId, 'VALUE'); } }}
                    scopeMessageId={scopeMessageId ?? undefined}
                    settlementOpenMsgId={settlementOpenMsgId}
                    settlementOpenType={settlementOpenType}
                    stanceHighlight={stanceHighlight}
                    settlementEntryHighlight={settlementEntryHighlight}
                    crossCanvasRelations={containerPreview?.context.crossCanvasRelations??crossCanvasRelations}
                    onNavigateToMessage={traceEntries.length?jumpWithinTrace:handleNavigateToMessage}
                    joinRelationsByTarget={joinRelationsByTarget}
                    joinRelationsBySource={joinRelationsBySource}
                    joinStatusByMessage={containerPreview?.context.joinStatusByMessage??joinStatusByMessage}
                    joinEffectSourcesByMessage={containerPreview?.context.joinEffectSourcesByMessage??containerEffect.context.joinEffectSourcesByMessage}
                    onJoinFilterClick={handleJoinRecords}
                  />
                  </DeferredWorkbench>
                )}
                </RecentWorkbenchViews>
                {!isPreloaded && onDemand && <React.Suspense fallback={null}>
                  {!globalFilterPending && <MessagePagination parent={activePageParent} loadedCount={messageWindow.messages.length}
                    hasMore={messageWindow.hasMore} loading={messageWindow.loading} showLoadingNotice={false}
                    panelRef={leftPanelRef} onMore={messageWindow.more} onError={showAlert} />}
                </React.Suspense>}
                <div aria-hidden="true" style={{ height: 96, flexShrink: 0 }} />
              </WorkbenchScrollViewport>
              {!isPreloaded && onDemand && <div style={{ position: 'absolute', bottom: 16, right: 16, maxWidth: 'calc(100% - 32px)', zIndex: 26, pointerEvents: 'none' }}>
                <React.Suspense fallback={null}>
                  {catalog && <CatalogStatus client={catalog} inline />}
                  {globalFilters.error && !globalFilterPending && <div role="alert" style={{ padding: '6px 10px', background: 'var(--surface-141414)', color: 'var(--ink-94a3b8)', fontSize: 12, pointerEvents: 'auto' }}>
                    筛选结果更新失败：{globalFilters.error} <button type="button" onClick={globalFilters.retry}>重试筛选</button>
                  </div>}
                </React.Suspense>
              </div>}
            </div>

            <WorkbenchSplitter active={splitterActive} onPointerDown={handleSplitterPointerDown} />


            <DeferredWorkbench label="发言操作" blocksDrawing><WorkbenchPanel
              relationChoices={<RelationChoices placement="desk" localMode={localRelationMode} composer={{ relationType, secondaryRelationType, newMessageContent, subType, setRelationType, setSecondaryRelationType, setNewMessageContent, lastTagSecondaryRef, lastDelegationSecondaryRef, savedTextOnTypeSwitchRef, subTypeCustomBufferRef, guideTargetIdRef }} />}
              rightPanelRef={rightPanelRef}
              leftPanelRef={leftPanelRef}
              TOTAL_FLEX={TOTAL_FLEX}
              leftFlex={leftFlex}
              minWidth={MIN_RIGHT_PX}
              maxWidth={MAX_RIGHT_PX}
              stickyTop={panelStickyTop}
              isPreviewMode={isPreviewMode}
              singleSideReview={containerPreview ? {
                title: correctionPreviewId?'更正后的正文':getRelationTitle(containerPreview.target.relationPayload) || containerPreview.target.id,
                kind: correctionPreviewId?'correction':isContainerType(containerPreview.target.relationType)?'container':'relation',
                onExit: exitContainerPreview,
              } : undefined}
              isViewerMode={isPreloaded}
              localEditing={!!localMessageData}
              hideViewerUser={isNativeZhihuView(loadedExport)}
              localReplyEditor={zhihuData ? renderSendControls => <DeferredWorkbench label="本地消息整理" blocksDrawing><ZhihuReplyEditor data={zhihuData} sourceUnits={sourceUnits} targetUnits={targetUnits} draftUnits={draftUnits}
                nativeDocument={!!nativeZhihuData} buildRelation={nativeZhihuData ? input => sendPagedZhihuRelation(nativeZhihuData, input) : undefined}
                relationType={localRelationType} renderSendControls={renderSendControls} onBusyChange={setLocalSending}
                correctionMode={secondaryRelationType === 'width-adjustment' ? 'width-adjustment' : 'text-correction'}
                onCorrectionModeChange={setSecondaryRelationType}
                correctionWidth={composer.correctionWidth} onCorrectionWidthChange={composer.setCorrectionWidth}
                currentClassificationId={currentClassifyRelMsgId}
                organizationError={localRelationType && ['classify', 'summary', 'merge', 'arrange'].includes(localRelationType)
                  ? getContainerMembershipTargetError(localEffectiveTargetUnits) ?? (sourceUnits.length === 1 ? getJoinContainerCycleError(sourceUnits[0].messageId, localEffectiveTargetUnits.map(unit => unit.messageId)) : getContainerCycleError(localEffectiveTargetUnits)) : null}
                onSelectCorrection={messageId => {
                  setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); setLocalRelationType('correct'); setSecondaryRelationType('text-correction');
                  if (messageId === currentClassifyRelMsgId) {
                    setDraftUnits([{ messageId, selection: { kind: 'whole' } }]); setLastClickedMessageId(messageId);
                  } else handleNavigateToMessage(messageId);
                }}
                onSent={handleCanvasBlankClick}
                onSave={saveLocalEditingView} /></DeferredWorkbench> : undefined}
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
              onExitViewer={() => { saveViewerPosition(); navigate('/'); }}
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
              traceDepths={traceDepths} onTraceDepthChange={changeTraceDepth}
              traceReadingControls={traceEntries.length>0?<DeferredWorkbench label="追溯阅读" blocksDrawing><TraceReadingController scopeKey={readingScopeKey} scopeIds={readingScope} allowedIds={readingAllowed}
                direction={traceDirection} order={readingOrder} onOrder={setReadingOrder} placementOrder={messageWindow.structureOrder}
                path={traceEntries.map(entry=>entry.ids)} focusId={readingFocusId} focusLocated={!!readingFocusId&&readingAnchorId===readingFocusId} incoming={currentTraceEntry?.readingContext??[]}
                onNavigationChange={changeReadingNavigation}
                focusIds={readingMessageIds} recentSelectedIds={recentSelectedMessageIds} onNavigateGroup={navigateReadingGroup} canGoBack={readingHistory.canGoBack} canGoForward={readingHistory.canGoForward} onBackward={readingHistory.back} onForward={readingHistory.forward}
                ready={!loading&&!globalFilterPending&&!messageWindow.loading} onNavigate={navigateReading} onBack={returnReadingTrace}/></DeferredWorkbench>:undefined}
              canSetTrace={canSetTrace}
              canExitTrace={canExitTrace}
              isRelatedView={isRelatedView}
              getSelectedWholeMessageIds={getSelectedWholeMessageIds}
              lastClickedMessageId={lastClickedMessageId}
              enterTraceMultiple={enterTraceMultiple}
              enterTrace={enterTrace}
              exitAllTrace={exitAllTrace}
              onNavigateToMessage={messageId => {if(traceEntries.length)jumpWithinTrace(messageId);else handleNavigateToMessage(messageId,{select:false});}}
              currentTraceIds={currentTraceIds}
              viewCacheOwner={browsingHistoryKey}
              messages={localPanelData.messages}
              edges={localPanelData.edges}
              user={user}
              relationType={relationType}
              secondaryRelationType={secondaryRelationType}
              setSecondaryRelationType={setSecondaryRelationType}
              hasSecondaryRelationSelector={hasSecondaryRelationSelector}
              tagSecondaryOptions={tagSecondaryOptions}
              correctSecondaryOptions={correctSecondaryOptions}
              correctionWidth={composer.correctionWidth}
              setCorrectionWidth={composer.setCorrectionWidth}
              proposalSecondaryOptions={proposalSecondaryOptions}
              isArrangeType={isArrangeType}
              isClassifyType={isClassifyType}
              isSummaryType={isSummaryType}
              isMergeType={isMergeType}
              joinOnlyAction={joinOnlyAction}
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
              contributionGroups={totalConsumption?totalConsumption.groups:[{type:primaryContributionType(relationType,secondaryRelationType),label:relationType?relationTypeName(relationType):'文本',count:0,...contributionRef.current(primaryContributionType(relationType,secondaryRelationType)),total:0}]}
              onContributionChange={composer.setContribution}
              recommendationAmount={recommendationAmount}
              setRecommendationAmount={setRecommendationAmount}
              stakeAmount={stakeAmount}
              setStakeAmount={setStakeAmount}
              relStakeAmount={relStakeAmount}
              setRelStakeAmount={setRelStakeAmount}
              availablePoints={availablePoints}
              effectiveMinStake={effectiveMinStake}
              singleButtonEnabled={canSubmitDraft}
              singleButtonLabel={singleButtonLabel}
              sendValidationLabel={sendValidationLabel}
              totalConsumption={totalConsumption}
              stakeFeeAmountRef={stakeFeeAmountRef}
              subTypeStakeMap={subTypeStakeMap}
              relationStakeMap={relationStakeMap}
              handleQuickSendAndRelateFromDraftTargets={handleSendClick}
              sendPreview={localMessageData ? undefined : { active:sendPreview.active, phase:sendPreview.phase, stale:sendPreview.stale, uncertain:sendPreview.uncertain, ready:sendPreview.ready,
                canPrepare:canSubmitDraft && containerPreviewId === null && !sendPreview.uncertain,
                onPreview:sendPreview.prepare, onCancel:sendPreview.cancel }}
              sendError={sendError}
              sendWarning={sendWarning}
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
              comparisonTargetIds={comparisonTargetIds}
              comparisonSide={comparisonSide}
              onComparisonSideChange={setComparisonSide}
              onComparisonReview={() => {
                const target = draftUnits.length === 1 ? draftUnits[0] : null;
                if (!target || !isWholeMessageSelection(target, target.messageId) || !comparisonTargetIds.has(target.messageId)) return;
                const targetId = target.messageId;
                comparisonChooser.current = { snapshot: captureSnapshot(), targetId, selection: [...draftUnits] };
                prepareComparisonReview(targetId, comparisonOrigin.current ?? undefined);
                setComparisonTargetId(targetId);
                setComparisonSide('agree');
                setComparisonReviewed(true);
                setComparisonMode(false);
              }}
              onComparisonVote={handleComparisonVote}
              onReturnToComparisonCategory={returnToComparisonChooser}
              onExitComparison={exitComparison}
            /></DeferredWorkbench>
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
      {showRegistrationGuide && <DeferredWorkbench label="新手提示"><RegistrationGuideHint
        open={showRegistrationGuide}
        onClose={() => setShowRegistrationGuide(false)}
      /></DeferredWorkbench>}

      <PromptModal
        open={confirmStandaloneSend}
        title="确认发送文本消息"
        message="候选区、来源集合或目标集合中已有消息，但尚未选择关系类型。继续发送将只发布文本消息，不会建立关系。"
        confirmText="仍然发送"
        onConfirm={() => { setConfirmStandaloneSend(false); void handleSendClick(true); }}
        onCancel={() => setConfirmStandaloneSend(false)}
      />

      <LeaderboardController ref={leaderboardRef}
        catalogVersion={catalogVersion} useCatalogRows={catalogComputationsCurrent}
        catalog={catalog} globalReady={!onDemand || isPreloaded || catalogReady} globalRows={onDemand && !isPreloaded ? globalRows : undefined}
        onRefresh={refreshLeaderboard}
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

      {(decorationPopup || tagPopup || mergeInfoPopup) && <DeferredWorkbench label="关系记录">
        <RelationRecordPopups messages={messages} edges={displayStanceEdges} decorationPopup={decorationPopup} tagPopup={tagPopup} mergeInfoPopup={mergeInfoPopup}
          onCloseDecoration={() => setDecorationPopup(null)} onCloseTag={() => setTagPopup(null)} onCloseMerge={() => setMergeInfoPopup(null)} />
      </DeferredWorkbench>}
      {comparisonPopup && (
        <DeferredWorkbench label="更正对比">
        <CorrectionComparisonPopup
          popup={comparisonPopup}
          messages={messages}
          edges={edges}
          invalidCorrectionIds={invalidCorrectionIds}
          displayedBodies={correctionVersions}
          onClose={() => setComparisonPopup(null)}
          isSending={sendInFlight}
          reversePreview={comparisonPopup.reversePreview ? {
            correctionKind: comparisonPopup.reversePreview.correctionKind,
            before: comparisonPopup.reversePreview.before,
            after: comparisonPopup.reversePreview.after,
            onConfirm: confirmReverseCorrection,
          } : undefined}
        />
        </DeferredWorkbench>
      )}
    </MessageDisplayHintsProvider>
    </ReadingTextLinksContext.Provider>
    </CardWidthContext.Provider>
    </DeferredWorkbench>
    </ModerationContext.Provider></ReviewDetailContext.Provider>
  );
}

import {bindViewedReference} from '../utils/bodyVersions';
import { restoreViewState } from './workbench/restoreViewState';
