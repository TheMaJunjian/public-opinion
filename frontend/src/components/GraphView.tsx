import { useGraphOverlays } from '../hooks/useGraphOverlays';
import { projectGraphScene } from '../utils/graphProjection';
import { unionLayoutRects, getGroupHeaderHeight, getGroupHeaderRect, getMergeCardHeaderRect, getEdgeDecorationLeft, getDecorationColumnWidth, getAnnotationPlacement, GROUP_HEADER_HEIGHT, DEC_W, DEC_H, DEC_GAP, DEC_RIGHT_GAP, DEC_RIGHT_TOP, DEC_ICON_W, EDGE_HINT_W, TAG_H, TAG_MIN_W, TAG_V_GAP, TAG_HIT_PAD, TAG_HIT_PAD_X, FRAME_RADIUS, GROUP_FRAME_STROKE, SHOW_SELECTED_ACTUAL_RECTS, INLINE_BADGE_COLOR } from '../utils/graphPresentationGeometry';
import { unitEquals, selectionIsText, extractTextTargetsForMessage, relationTypeName, buildAnnoTree, renderAnnoNodes } from '../utils/graphTextSelection';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DemoMessage, DemoEdge, UnitSelection } from '../utils/modelBridge';
import { getRelationMessageLabel } from '../utils/attachedRelationLabels';
import { getJoinStatusPresentation, type JoinStatus } from '../pages/workbench/model/membership';
import type { JoinEffectSource } from '../pages/workbench/model/joinDisplay';
import { computeCorrectionVersions, isCardMessage } from '../utils/modelBridge';
import { useSceneComputation } from '../hooks/useSceneComputation';
import { useCardMeasurements } from '../hooks/useCardMeasurements';
import { useVirtualMessageMounts } from '../hooks/useVirtualMessageMounts';
import { intersectsViewport } from '../hooks/useCanvasViewport';
import { createMessageJumpGroups, registerMessageJumpGroups } from '../utils/messageJumpDisplay';
import { getMessageProminence, getOrganizationTitle, isBodyCorrection, needsSeparateStanceCard } from '../utils/messageDisplay';
import { activateMessageFromKeyboard } from '../utils/messageKeyboard';
import MessageTextPart from './MessageTextPart';
import { describeUnit } from '../utils/selectionLabel';
import { PART_SELECTION_EVENT, isMessageElementSelected, isWholeMessageSelection, messageTypeReference } from '../utils/messageElementSelection';
import MessageElement from './MessageElement';
import ClassificationCard from './graph/ClassificationCard';
import OrganizationFrameHeader from './graph/OrganizationFrameHeader';
import { MessageDisplayMarker, MessageDisplayHintsScope } from './MessageDisplayHints';
import MessageSettlementActions from './MessageSettlementActions';
import SettlementPanel from './SettlementPanel';
import RoundHistory from './RoundHistory';
import RelatedMessages from './RelatedMessages';
import CrossCanvasRelatedMessages from './CrossCanvasRelatedMessages';
import { deriveCrossCanvasRelations } from '../utils/crossCanvasRelations';
import JoinRecordBadges from './JoinRecordBadges';
import ComparisonPane, { COMPARISON_HEADER_HEIGHT } from './ComparisonPane';
import {indexRelatedMessages,isRejectedContainer} from '../utils/relatedMessages';
import { CARD_W, GRID_LEFT, CANVAS_BOTTOM_PAD, CANVAS_RIGHT_PAD, FRAME_PAD, MERGE_CARD_H } from '../utils/layout';
import { getPresentationSpec, type Relation } from '../types';
import { noteWorkbenchDrawingProgress, reportWorkbenchDrawingDuration } from '../utils/workbenchActivity';
import { useWorkbenchDrawingCommit, useWorkbenchDrawingTask } from '../context/WorkbenchDrawingContext';

// ========================= Layout types =========================

type LayoutBox = { x: number; y: number; width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };



export interface GraphViewProps {
  messages: DemoMessage[];
  visibleMessageIds?: ReadonlySet<string>;
  visibleEdgeIds?: ReadonlySet<string>;
  structureOrder?: string[];
  relatedMessages?:DemoMessage[];
  relatedEdges?:DemoEdge[];
  onRelatedRelationView?:(id:string)=>void;
  standaloneMessageIds?:ReadonlySet<string>;
  rejectedContainerIds?:ReadonlySet<string>;
  onRelatedMessageNavigate?:(id:string)=>void;
  edges: DemoEdge[];
  homeMatchIds?: Set<string>;
  homeContextRoleByMessageId?: Map<string, 'source' | 'target' | 'source-target'>;
  invalidCorrectionIds?: Set<string>;
  draftUnits: UnitSelection[];
  activeTextSelectId: string | null;
  lastClickedMessageId: string | null;
  onMessageClick: (e: React.MouseEvent, messageId: string) => void;
  onMessageDoubleClick: (e: React.MouseEvent, messageId: string) => void;
  onTextMouseUp: (e: React.MouseEvent, messageId: string) => void;
  onEdgeLabelSingleClick: (e: React.MouseEvent, relationMessageId: string, edgeId: string) => void;
  onEdgeLabelDoubleClick: (e: React.MouseEvent, relationMessageId: string) => void;
  onFragmentAnchorClick: (messageId: string, start: number, len: number, text: string) => void;
  isFragmentSelected: (messageId: string, start: number, len: number, text: string) => boolean;
  onCanvasBlankClick?: () => void;
  onMessageMouseDown?: (e: React.MouseEvent, messageId: string) => void;
  onMessageMouseUp?: (e: React.MouseEvent, messageId: string) => void;
  /** Click on the icon area of a decoration badge — quick send empty agree/disagree */
  onDecorationIconClick?: (messageId: string, kind: "agree" | "disagree") => void;
  /** Click on the body (non-icon area) of a decoration badge — toggles selection */
  onDecorationBodyClick?: (e: React.MouseEvent, messageId: string, kind: "agree" | "disagree") => void;
  /** Double-click on a decoration badge — shows sender info popup */
  onDecorationDoubleClick?: (e: React.MouseEvent, messageId: string, kind: "agree" | "disagree") => void;
  /** Which decoration badges are currently selected: keys are `${messageId}::agree` / `${messageId}::disagree` */
  selectedDecorations?: Set<string>;
  /** Click on an aggregated tag badge — toggles selection of all relation messages in the group */
  onTagBodyClick?: (e: React.MouseEvent, messageId: string, tagLabel: string, relMsgIds: string[]) => void;
  /** Double-click on a tag badge — shows details popup */
  onTagDoubleClick?: (e: React.MouseEvent, messageId: string, tagLabel: string, relMsgIds: string[]) => void;
  /**
   * Single-click on a group frame border (frame-group: CLASSIFY/MERGE) — selects the relation
   * or opens "add message to group" UI.  Falls back to onMessageClick if not provided.
   */
  onGroupFrameClick?: (e: React.MouseEvent, relMsgId: string) => void;
  /**
   * Double-click on a group frame border (frame-group: CLASSIFY/MERGE) — expands the classification view
   * for this group, or shows group details.  Falls back to onMessageDoubleClick if not provided.
   */
  onGroupFrameDoubleClick?: (e: React.MouseEvent, relMsgId: string) => void;
  /**
   * Single-click on an inline badge (RECOMMEND / ARCHIVE) — selects the relation message.
   * Falls back to onMessageClick if not provided.
   */
  onInlineBadgeClick?: (e: React.MouseEvent, relMsgId: string) => void;
  /**
   * Double-click on an inline badge (RECOMMEND / ARCHIVE) — shows operation details
   * (who operated, when, etc.).  Falls back to onMessageDoubleClick if not provided.
   */
  onInlineBadgeDoubleClick?: (e: React.MouseEvent, relMsgId: string, detail?: { relMsgIds?: string[]; subDetails?: Array<{subType:string;customLabel?:string;count:number}> }) => void;
  /** Optional message IDs to hide from card rendering while keeping layout/frame computation. */
  hideMessageIds?: Set<string>;
  /** In trace mode, these CLASSIFY/SUMMARY IDs render as frames instead of cards. */
  traceExpandedFrameIds?: Set<string>;
  /** Directly traced CLASSIFY/SUMMARY IDs use exclusive card/frame rendering. */
  traceFrameIds?: Set<string>;
  /** Render two aligned comparison projections using the same graph layout. */
  comparisonPair?: boolean;
  comparisonSingle?: boolean;
  comparisonScopeHeader?: React.ReactNode;
  comparisonTargetId?: string | null;
  excludedStanceEdges?: ReadonlySet<string>;
  comparisonDisplay?: 'agree' | 'disagree';
  comparisonRecommendedDisplay?: 'agree' | 'disagree';
  comparisonAgreeMessages?: DemoMessage[];
  comparisonAgreeContext?: Pick<GraphViewProps,'relatedMessages'|'relatedEdges'|'rejectedContainerIds'|'joinStatusByMessage'|'joinEffectSourcesByMessage'|'crossCanvasRelations'>;
  comparisonAgreeEdges?: DemoEdge[];
  comparisonAgreeHideMessageIds?: Set<string>;
  comparisonDisagreeMessages?: DemoMessage[];
  comparisonDisagreeContext?: Pick<GraphViewProps,'relatedMessages'|'relatedEdges'|'rejectedContainerIds'|'joinStatusByMessage'|'joinEffectSourcesByMessage'|'crossCanvasRelations'>;
  comparisonDisagreeEdges?: DemoEdge[];
  comparisonDisagreeHideMessageIds?: Set<string>;
  comparisonAgreeSuppressedRelIds?: Set<string>;
  comparisonDisagreeSuppressedRelIds?: Set<string>;
  comparisonSuppressedRelIds?: Set<string>;
  autoCenterMessageId?: string | null;
  /** Phase 2: stake counts per message (truth/value split) for display on cards */
  stakeCounts?: Record<string, { truth: { pro: number; con: number }; value: { pro: number; con: number } }>;
  /** Phase 3: callback when ⚖️ truth settlement toggle is clicked */
  onSettlementToggleTruth?: (messageId: string) => void;
  /** Phase 3: callback when 💎 value settlement toggle is clicked */
  onSettlementToggleValue?: (messageId: string) => void;
  /** Classification ID for SettlementPanel message creation */
  scopeMessageId?: string;
  /** Phase 3: currently open settlement message ID (for active state styling) */
  settlementOpenMsgId?: string | null;
  /** Phase 3: currently open settlement type (TRUTH or VALUE) */
  settlementOpenType?: 'TRUTH' | 'VALUE' | null;
  onSettlementMessageCreated?: (m: { id: string; content: string; createdAt: string; author: string; kind: string }) => void;
  /** Phase 5: Stance path highlight — { stanceMsgId, evidenceMsgIds } */
  stanceHighlight?: { stanceMsgId: string; evidenceMsgIds: string[] } | null;
  /** Phase 5: Settlement entry highlight filter for SettlementPanel */
  settlementEntryHighlight?: { side?: 'PRO' | 'CON'; vote?: 'TRUE' | 'FALSE'; username?: string } | null;
  /** Cross-canvas directed relations grouped by direction and message type. */
  crossCanvasRelations?: Map<string, { outgoing: Record<string, string[]>; incoming: Record<string, string[]> }>;
  /** 点击加入消息标签；incoming 查看消息的“加入”，outgoing 查看容器的“被加入” */
  onNavigateToMessage?: (messageId: string) => void;
  /** JOIN records grouped by their target message, used by the target filter badge. */
  joinRelationsByTarget?: Map<string, Relation[]>;
  /** JOIN records emitted by each container. */
  joinRelationsBySource?: Map<string, Relation[]>;
  onJoinFilterClick?: (messageId: string, direction: 'incoming' | 'outgoing') => void;
  joinStatusByMessage?: Map<string, JoinStatus>;
  joinEffectSourcesByMessage?: ReadonlyMap<string, ReadonlySet<JoinEffectSource>>;
}

const EMPTY_COMPARISON_SUPPRESSED_REL_IDS = new Set<string>();
const EMPTY_SCENE_LAYOUT = { layout: {} as Record<string, LayoutBox>, frameRects: {} as Record<string, LayoutBox>, colOf: {} as Record<string, number>, canvasHeight: 0 };

const COMPARISON_CANVAS_EXTRA_RIGHT_PAD = 96;

function ComparisonGraphPair(props: GraphViewProps) {
  const startPositioning = useWorkbenchDrawingTask('positioning');
  const startMeasurement = useWorkbenchDrawingTask('measurement');
  const pairRef = useRef<HTMLDivElement | null>(null);
  const agreeViewportRef = useRef<HTMLDivElement | null>(null);
  const disagreeViewportRef = useRef<HTMLDivElement | null>(null);
  const verticalScrollRef = useRef<HTMLDivElement | null>(null);
  const horizontalScrollRef = useRef<HTMLDivElement | null>(null);
  const syncingScrollRef = useRef(false);
  const splitDragRef = useRef<{ startX: number; startAgreeRatio: number } | null>(null);
  const [agreeRatio, setAgreeRatio] = useState(0.5);
  const [contentSize, setContentSize] = useState({ width: 0, height: 0 });
  const [scrollHostSize, setScrollHostSize] = useState({ height: 0, viewportHeight: 0 });

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = splitDragRef.current;
      const pair = pairRef.current;
      if (!drag || !pair) return;
      const pairWidth = pair.getBoundingClientRect().width;
      const availableWidth = Math.max(1, pairWidth - 14 - 16);
      const nextRatio = (drag.startAgreeRatio * availableWidth + event.clientX - drag.startX) / availableWidth;
      setAgreeRatio(Math.max(0.25, Math.min(0.75, nextRatio)));
    };
    const handlePointerUp = () => { splitDragRef.current = null; };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, []);

  const handleSplitPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    splitDragRef.current = { startX: event.clientX, startAgreeRatio: agreeRatio };
  };

  const setSharedScroll = (top: number, left: number) => {
    const scrollHost = pairRef.current?.closest('[data-workbench-left-panel]') as HTMLDivElement | null;
    const viewports = [agreeViewportRef.current, disagreeViewportRef.current].filter(Boolean) as HTMLDivElement[];
    for (const viewport of viewports) {
      viewport.scrollTop = 0;
      viewport.scrollLeft = left;
    }
    if (scrollHost) scrollHost.scrollTop = top;
    if (verticalScrollRef.current) verticalScrollRef.current.scrollTop = top;
    if (horizontalScrollRef.current) horizontalScrollRef.current.scrollLeft = left;
  };

  useEffect(() => {
    const targetId = props.autoCenterMessageId;
    const agreeViewport = agreeViewportRef.current;
    const verticalScroll = verticalScrollRef.current;
    if (!targetId || !agreeViewport || !verticalScroll) return;
    const task = startPositioning();
    const centerTarget = () => {
      const target = Array.from(agreeViewport.querySelectorAll<HTMLElement>('[data-msgid]'))
        .find(element => element.getAttribute('data-msgid') === targetId);
      if (!target) return;
      const targetRect = target.getBoundingClientRect();
      const viewportRect = agreeViewport.getBoundingClientRect();
      const scrollHost = pairRef.current?.closest('[data-workbench-left-panel]') as HTMLDivElement | null;
      const scrollRect = scrollHost?.getBoundingClientRect() ?? viewportRect;
      const scrollTop = scrollHost?.scrollTop ?? agreeViewport.scrollTop;
      const scrollHeight = scrollHost?.scrollHeight ?? contentSize.height;
      const clientHeight = scrollHost?.clientHeight ?? agreeViewport.clientHeight;
      const nextTop = Math.max(0, Math.min(
        scrollTop + targetRect.top - scrollRect.top + targetRect.height / 2 - clientHeight / 2,
        Math.max(0, scrollHeight - clientHeight),
      ));
      const nextLeft = Math.max(0, Math.min(
        agreeViewport.scrollLeft + targetRect.left - viewportRect.left + targetRect.width / 2 - agreeViewport.clientWidth / 2,
        Math.max(0, contentSize.width - agreeViewport.clientWidth),
      ));
      setSharedScroll(nextTop, nextLeft);
    };
    const frame = requestAnimationFrame(() => task.run(() => { centerTarget(); task.complete(); }));
    task.onCancel(() => cancelAnimationFrame(frame));
    return () => { cancelAnimationFrame(frame); task.cancel(); };
  }, [props.autoCenterMessageId, props.messages, props.edges, contentSize, startPositioning]);

  useEffect(() => {
    const updateContentSize = () => {
      const task = startMeasurement();
      task.run(() => {
        const scrollHost = pairRef.current?.closest('[data-workbench-left-panel]') as HTMLDivElement | null;
        const dimensions = [agreeViewportRef.current, disagreeViewportRef.current].map(viewport => ({
          width: viewport?.scrollWidth ?? 0,
          height: viewport?.scrollHeight ?? 0,
        }));
        setContentSize({
          width: Math.max(...dimensions.map(dimension => dimension.width), 0),
          height: Math.max(...dimensions.map(dimension => dimension.height), agreeViewportRef.current?.clientHeight ?? 0),
        });
        setScrollHostSize({ height: scrollHost?.scrollHeight ?? 0, viewportHeight: scrollHost?.clientHeight ?? 0 });
        task.complete();
      });
    };
    updateContentSize();
    const observer = new ResizeObserver(updateContentSize);
    if (agreeViewportRef.current) observer.observe(agreeViewportRef.current);
    if (disagreeViewportRef.current) observer.observe(disagreeViewportRef.current);
    const scrollHost = pairRef.current?.closest('[data-workbench-left-panel]') as HTMLDivElement | null;
    if (scrollHost) observer.observe(scrollHost);
    for (const canvas of [agreeViewportRef.current, disagreeViewportRef.current]
      .flatMap(viewport => viewport ? Array.from(viewport.querySelectorAll<HTMLElement>('[data-jump-canvas]')) : [])) {
      observer.observe(canvas);
    }
    window.addEventListener('resize', updateContentSize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateContentSize);
    };
  }, [props.messages, props.edges, startMeasurement]);

  useEffect(() => {
    const viewports = [agreeViewportRef.current, disagreeViewportRef.current].filter(Boolean) as HTMLDivElement[];
    const scrollHost = pairRef.current?.closest('[data-workbench-left-panel]') as HTMLDivElement | null;
    const verticalScroll = verticalScrollRef.current;
    const horizontalScroll = horizontalScrollRef.current;
    if (!verticalScroll || !horizontalScroll) return;
    const getHorizontalMax = (element: HTMLElement) => Math.max(0, element.scrollWidth - element.clientWidth);
    const getScrollProgress = (element: HTMLElement) => {
      const max = getHorizontalMax(element);
      return max > 0 ? element.scrollLeft / max : 0;
    };
    const setHorizontalProgress = (progress: number) => {
      const clampedProgress = Math.max(0, Math.min(1, progress));
      for (const viewport of viewports) viewport.scrollLeft = getHorizontalMax(viewport) * clampedProgress;
      horizontalScroll.scrollLeft = getHorizontalMax(horizontalScroll) * clampedProgress;
    };
    const syncFromViewport = (source: HTMLDivElement) => {
      if (syncingScrollRef.current) return;
      syncingScrollRef.current = true;
      for (const viewport of viewports) {
        viewport.scrollTop = 0;
      }
      setHorizontalProgress(getScrollProgress(source));
      if (scrollHost) scrollHost.scrollTop = source.scrollTop;
      verticalScroll.scrollTop = source.scrollTop;
      requestAnimationFrame(() => { syncingScrollRef.current = false; });
    };
    const syncFromVerticalScroll = () => {
      if (syncingScrollRef.current) return;
      syncingScrollRef.current = true;
      if (scrollHost) scrollHost.scrollTop = verticalScroll.scrollTop;
      for (const viewport of viewports) viewport.scrollTop = 0;
      requestAnimationFrame(() => { syncingScrollRef.current = false; });
    };
    const syncFromHorizontalScroll = () => {
      if (syncingScrollRef.current) return;
      syncingScrollRef.current = true;
      setHorizontalProgress(getScrollProgress(horizontalScroll));
      requestAnimationFrame(() => { syncingScrollRef.current = false; });
    };
    const handlers = viewports.map(viewport => {
      const handler = () => syncFromViewport(viewport);
      viewport.addEventListener('scroll', handler, { passive: true });
      return [viewport, handler] as const;
    });
    const handleScrollHost = () => {
      if (syncingScrollRef.current) return;
      syncingScrollRef.current = true;
      verticalScroll.scrollTop = scrollHost?.scrollTop ?? 0;
      const source = scrollHost ?? viewports[0];
      setHorizontalProgress(source ? getScrollProgress(source) : 0);
      for (const viewport of viewports) viewport.scrollTop = 0;
      requestAnimationFrame(() => { syncingScrollRef.current = false; });
    };
    verticalScroll.addEventListener('scroll', syncFromVerticalScroll, { passive: true });
    horizontalScroll.addEventListener('scroll', syncFromHorizontalScroll, { passive: true });
    scrollHost?.addEventListener('scroll', handleScrollHost, { passive: true });
    return () => {
      for (const [viewport, handler] of handlers) viewport.removeEventListener('scroll', handler);
      verticalScroll.removeEventListener('scroll', syncFromVerticalScroll);
      horizontalScroll.removeEventListener('scroll', syncFromHorizontalScroll);
      scrollHost?.removeEventListener('scroll', handleScrollHost);
    };
  }, []);

  const viewportStyle: React.CSSProperties = {
    flex: '0 0 auto',
    minWidth: 0,
    minHeight: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
  };

  return (
    <div ref={pairRef} data-comparison-pair="true" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 8, width: '100%', minHeight: '100%' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `${agreeRatio}fr 30px ${1 - agreeRatio}fr`, gap: 8, alignItems: 'stretch' }}>
      <ComparisonPane side="agree" recommended={props.comparisonRecommendedDisplay === 'agree'}>
        {props.comparisonScopeHeader}
        <div ref={agreeViewportRef} data-comparison-viewport="agree" style={viewportStyle}>
          <GraphView {...props} {...props.comparisonAgreeContext} messages={props.comparisonAgreeMessages ?? props.messages} edges={props.comparisonAgreeEdges ?? props.edges} hideMessageIds={props.comparisonAgreeMessages ? props.comparisonAgreeHideMessageIds : props.hideMessageIds} comparisonPair={false} comparisonSingle={false} comparisonDisplay="agree" comparisonSuppressedRelIds={props.comparisonAgreeSuppressedRelIds} autoCenterMessageId={null} />
        </div>
      </ComparisonPane>
      <div data-comparison-divider="true" style={{ minHeight: 0, marginTop: COMPARISON_HEADER_HEIGHT, display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr)', gap: 4, position: 'sticky', top: 0, alignSelf: 'start', height: Math.max(scrollHostSize.viewportHeight, 1), overflow: 'hidden', background: '#2a2a2a', borderRadius: 4 }}>
        <div ref={verticalScrollRef} data-comparison-scroll-vertical="true" aria-label="对比视图垂直滚动条" style={{ minHeight: 0, minWidth: 0, height: '100%', overflowY: 'scroll', overflowX: 'hidden', scrollbarGutter: 'stable', borderRadius: 4 }}>
          <div style={{ height: Math.max(scrollHostSize.height, contentSize.height, 1), width: 1 }} />
        </div>
        <div onPointerDown={handleSplitPointerDown} role="separator" aria-label="调整对比视图宽度" style={{ minWidth: 0, cursor: 'col-resize', background: '#3a3a3a', borderRadius: 4, touchAction: 'none', userSelect: 'none' }} />
      </div>
      <ComparisonPane side="disagree" recommended={props.comparisonRecommendedDisplay === 'disagree'}>
        {props.comparisonScopeHeader}
        <div ref={disagreeViewportRef} data-comparison-viewport="disagree" style={viewportStyle}>
          <GraphView {...props} {...props.comparisonDisagreeContext} messages={props.comparisonDisagreeMessages ?? props.messages} edges={props.comparisonDisagreeEdges ?? props.edges} hideMessageIds={props.comparisonDisagreeMessages ? props.comparisonDisagreeHideMessageIds : props.hideMessageIds} comparisonPair={false} comparisonSingle={false} comparisonDisplay="disagree" comparisonSuppressedRelIds={props.comparisonDisagreeSuppressedRelIds} autoCenterMessageId={null} />
        </div>
      </ComparisonPane>
      </div>
      <div ref={horizontalScrollRef} data-comparison-scroll-horizontal="true" aria-label="对比视图水平滚动条" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 1, opacity: 0, pointerEvents: 'none', overflowX: 'scroll', overflowY: 'hidden' }}>
        <div style={{ width: Math.max(contentSize.width, 1), height: 1 }} />
      </div>
    </div>
  );
}

function GraphViewCanvas(props: GraphViewProps) {
  const startPositioning = useWorkbenchDrawingTask('positioning');
  const renderStartedAt = performance.now();
  const {
    messages: inputMessages, edges: inputEdges, invalidCorrectionIds, draftUnits, activeTextSelectId, lastClickedMessageId,
    onMessageClick, onMessageDoubleClick, onTextMouseUp,
    onEdgeLabelSingleClick, onEdgeLabelDoubleClick,
    onFragmentAnchorClick, isFragmentSelected, onCanvasBlankClick,
    onMessageMouseDown, onMessageMouseUp,
    onDecorationIconClick, onDecorationBodyClick, onDecorationDoubleClick,
    selectedDecorations,
    onTagBodyClick, onTagDoubleClick,
    onGroupFrameClick, onGroupFrameDoubleClick,
    onInlineBadgeClick, onInlineBadgeDoubleClick,
    stakeCounts,
    onSettlementToggleTruth,
    onSettlementToggleValue,
    scopeMessageId,
    settlementOpenMsgId,
    settlementOpenType,
    onSettlementMessageCreated,
    stanceHighlight,
    settlementEntryHighlight,
    crossCanvasRelations,
    onNavigateToMessage,
    joinRelationsByTarget,
    joinRelationsBySource,
    onJoinFilterClick,
    joinStatusByMessage,
  } = props;

  const isJoinEffective = (record: Relation) => joinStatusByMessage
    ? joinStatusByMessage.get(record.id) === 'valid' : record.state?.membershipActive === true;
  const renderJoinRecords = (messageId: string, isContainer = false, compact = false) => <JoinRecordBadges
    messageId={messageId} memberRecords={joinRelationsByTarget?.get(messageId)} containerRecords={joinRelationsBySource?.get(messageId)}
    isContainer={isContainer} isEffective={isJoinEffective} onOpen={onJoinFilterClick} compact={compact}/>;

  const messages = inputMessages;
  const relatedByTarget=useMemo(()=>indexRelatedMessages(props.relatedMessages??messages,props.rejectedContainerIds),[props.relatedMessages,messages,props.rejectedContainerIds]);
  const edges = inputEdges;
  const traceFrameIds = props.traceFrameIds ?? new Set<string>();
  // Expanded frame IDs are only meaningful inside an active trace window.
  // Do not let stale expansion state turn the ordinary graph into a trace view.
  const isTraceWindow = traceFrameIds.size > 0;
  // An entering trace can briefly render with the previous expansion state.
  // Only frames belonging to the current trace may be rendered as expanded.
  const traceExpandedFrameIds = useMemo(
    () => new Set(props.traceExpandedFrameIds ?? []),
    [props.traceExpandedFrameIds],
  );
  const comparisonSuppressedRelIds = props.comparisonSuppressedRelIds ?? EMPTY_COMPARISON_SUPPRESSED_REL_IDS;
  const effectiveHideMessageIds = useMemo(() => props.hideMessageIds
    ? new Set([...props.hideMessageIds, ...comparisonSuppressedRelIds])
    : comparisonSuppressedRelIds, [props.hideMessageIds, comparisonSuppressedRelIds]);

  const canvasRef = useRef<HTMLDivElement|null>(null);
  const cardRefs = useRef<Record<string,HTMLDivElement|null>>({});
  const contentRefs = useRef<Record<string,HTMLDivElement|null>>({});
  const headerRefs = useRef<Record<string,HTMLDivElement|null>>({});
  const textRefs = useRef<Record<string,SVGTextElement|null>>({});
  const [expandedFrameIds, setExpandedFrameIds] = useState<string[]>([]);
  const [revealedFrameIds, setRevealedFrameIds] = useState<string[]>([]);
  const [expandedDecorationIds,setExpandedDecorationIds]=useState<Set<string>>(()=>new Set());
  const [revealedDecorationIds,setRevealedDecorationIds]=useState<Set<string>>(()=>new Set());
  const visibleDecorationIds=useMemo(()=>new Set([...expandedDecorationIds,...revealedDecorationIds]),[expandedDecorationIds,revealedDecorationIds]);
  const [expandedAnnotationIds,setExpandedAnnotationIds]=useState<Set<string>>(()=>new Set());
  const [revealedAnnotationIds,setRevealedAnnotationIds]=useState<Set<string>>(()=>new Set());
  const visibleAnnotationIds=useMemo(()=>new Set([...expandedAnnotationIds,...revealedAnnotationIds]),[expandedAnnotationIds,revealedAnnotationIds]);
  const renderDecorationToggle=(ids:string|string[],style?:React.CSSProperties,annotations=false)=>{
    const messageIds=typeof ids==='string'?[ids]:ids;
    const expanded=messageIds.some(id=>(annotations?visibleAnnotationIds:visibleDecorationIds).has(id));
    const label=annotations?'标注':'装饰';
    return <button key={`${annotations?'annotation':'decoration'}-toggle-${messageIds[0]}`} type="button"
      data-decoration-toggle={annotations?undefined:messageIds[0]} data-annotation-toggle={annotations?messageIds[0]:undefined} data-rel-overlay="true"
      aria-label={`${expanded?'收起':'显示'}${label} ${messageIds[0]}`} aria-expanded={expanded}
      title={`${expanded?'收起':'显示'}${annotations?'标注':'赞同／反对'}`}
      onMouseDown={event=>event.stopPropagation()} onMouseUp={event=>event.stopPropagation()}
      onKeyDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}
      onClick={event=>{
        event.stopPropagation();
        (annotations?setExpandedAnnotationIds:setExpandedDecorationIds)(previous=>{
          const next=new Set(previous);
          for(const id of messageIds){
            if(expanded)next.delete(id);
            else next.add(id);
          }
          return next;
        });
        if(expanded)(annotations?setRevealedAnnotationIds:setRevealedDecorationIds)(previous=>new Set([...previous].filter(id=>!messageIds.includes(id))));
      }}
      style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:EDGE_HINT_W,height:EDGE_HINT_W,
        padding:0,border:'1px solid #444',borderRadius:3,background:'#1f1f1f',color:'#cbd5e1',fontSize:10,
        lineHeight:1,flexShrink:0,cursor:'pointer',pointerEvents:'auto',...style}}>{expanded?'▾':'▸'}</button>;
  };
  const cardFrameIds = useMemo(() => new Set([...expandedFrameIds, ...revealedFrameIds,
    ...(props.comparisonDisplay&&props.comparisonTargetId?[props.comparisonTargetId]:[])]), [expandedFrameIds, revealedFrameIds,props.comparisonDisplay,props.comparisonTargetId]);
  const resolveRevealIds = useCallback((ids: string[]) => {
    const targets = new Set(ids);
    const decorationEdges=new Map<string,DemoEdge[]>();
    for(const edge of edges)if(['agree','disagree','tag'].includes(edge.relationType)||getPresentationSpec(edge.relationType).kind==='inline-badge')
      decorationEdges.set(edge.relationMessageId,[...(decorationEdges.get(edge.relationMessageId)??[]),edge]);
    const revealedDecorations=new Set<string>(),revealedAnnotations=new Set<string>(),visited=new Set<string>(),queue=[...ids];
    for(let index=0;index<queue.length;index++)for(const edge of decorationEdges.get(queue[index])??[]){
      const target=edge.to.messageId;
      (['agree','disagree'].includes(edge.relationType)?revealedDecorations:revealedAnnotations).add(target);
      if(visited.has(target))continue;
      visited.add(target);targets.add(target);queue.push(target);
    }
    const frames = messages.filter(message => message.relationType === 'arrange' && targets.has(message.id)).map(message => message.id);
    setRevealedDecorationIds(previous=>previous.size===revealedDecorations.size&&[...previous].every(id=>revealedDecorations.has(id))?previous:revealedDecorations);
    setRevealedAnnotationIds(previous=>previous.size===revealedAnnotations.size&&[...previous].every(id=>revealedAnnotations.has(id))?previous:revealedAnnotations);
    setRevealedFrameIds(previous => previous.length === frames.length && previous.every((id, index) => id === frames[index]) ? previous : frames);
    // Mount the temporary card as well as the requested badge, including when
    // navigation starts outside the viewport. Clearing the pulse collapses it.
    return [...new Set([...ids,...revealedDecorations,...revealedAnnotations,...frames])];
  }, [messages, edges]);

  const { msgMap, edgesByRelMsg, classifyRelMsgIds, relationCardMsgIds, normals,
    layoutEdges, hiddenTargetIds, correctionsByTargetMsgId, frameBlocks, frameDepthMap,
    correctedEdgeIdsByRelMsg, pipelineCol, pipelineMaxCol } = useMemo(() => projectGraphScene({
      messages, edges, traceExpandedFrameIds, isTraceWindow,standaloneMessageIds:props.standaloneMessageIds,rejectedContainerIds:props.rejectedContainerIds,hiddenMessageIds:effectiveHideMessageIds,cardFrameIds,
    }), [messages, edges, traceExpandedFrameIds, isTraceWindow,props.standaloneMessageIds,props.rejectedContainerIds,props.hideMessageIds,comparisonSuppressedRelIds,cardFrameIds]);

  const measuredHeights = useCardMeasurements(canvasRef, cardRefs);
  useWorkbenchDrawingCommit();
  // Reserved: populate via ResizeObserver when cards need variable widths (e.g. MERGE headers).
  const [measuredWidths] = useState<Record<string,number>>({});
  const [selectedActualRects, setSelectedActualRects] = useState<Record<string, Rect>>({});

  const canvasRightPad = props.comparisonDisplay ? CANVAS_RIGHT_PAD + COMPARISON_CANVAS_EXTRA_RIGHT_PAD : CANVAS_RIGHT_PAD;
  const canvasWidth = GRID_LEFT + CARD_W + canvasRightPad;
  const selectedAnnotationRelMsgIds = useMemo(() => {
    const selected = new Set<string>();
    if (lastClickedMessageId) selected.add(lastClickedMessageId);
    for (const u of draftUnits) selected.add(u.messageId);
    const annotationIds = new Set<string>();
    for (const relId of selected) {
      const relType = edgesByRelMsg.get(relId)?.[0]?.relationType
        ?? (msgMap.get(relId)?.kind === 'relation' ? msgMap.get(relId)?.relationType : undefined);
      if (relType === 'annotation') annotationIds.add(relId);
    }
    return annotationIds;
  }, [lastClickedMessageId, draftUnits, edgesByRelMsg, msgMap]);

  const annotationTargetFragmentHints = useMemo(() => {
    const fragmentKeys = new Set<string>();
    if (selectedAnnotationRelMsgIds.size === 0) return fragmentKeys;
    for (const e of edges) {
      if (e.relationType !== 'annotation') continue;
      if (!selectedAnnotationRelMsgIds.has(e.relationMessageId)) continue;
      if (selectionIsText(e.to.selection)) {
        fragmentKeys.add(e.id);
      }
    }
    return fragmentKeys;
  }, [edges, selectedAnnotationRelMsgIds]);

  const notifyUsersByRelationMsg = useMemo(() => {
    const result = new Map<string, Array<{ id: string; username: string }>>();
    for (const message of messages) {
      if (message.kind !== 'relation' || message.relationType !== 'notify') continue;
      const payloadUsers = Array.isArray(message.relationPayload?.notifyUsers)
        ? message.relationPayload.notifyUsers.filter(user => user && typeof user.id === 'string' && typeof user.username === 'string')
        : [];
      if (payloadUsers.length > 0) {
        result.set(message.id, Array.from(new Map(payloadUsers.map(user => [user.id, user])).values()));
        continue;
      }
      const ids = Array.isArray(message.relationPayload?.notifyUserIds)
        ? message.relationPayload.notifyUserIds.filter((id): id is string => typeof id === 'string')
        : [];
      if (ids.length > 0) result.set(message.id, Array.from(new Set(ids), id => ({ id, username: `与会者 ${id}` })));
    }
    return result;
  }, [messages]);

  const correctionVersionsByTargetMsgId = useMemo(
    () => computeCorrectionVersions(messages, edges, invalidCorrectionIds),
    [messages, edges, invalidCorrectionIds],
  );

  // Organizations are measured bottom-up once. Their measured dimensions are
  // known before placing the outer scene, so no correction/avoidance passes run.
  const layoutJob = useMemo(
    () => ({ kind: 'layout' as const, input: {
      normals, colOf: pipelineCol, measuredHeights, measuredWidths,
      maxCol: pipelineMaxCol, correctedTargetIds: hiddenTargetIds,
      frameBlocks, allMessages: messages, edges: layoutEdges, traceMode: isTraceWindow,
      structureOrder: props.structureOrder,
    } }),
    [normals, pipelineCol, pipelineMaxCol, measuredHeights, measuredWidths,
      hiddenTargetIds, frameBlocks, messages, layoutEdges, isTraceWindow, props.structureOrder],
  );
  const sceneLayout = useSceneComputation(layoutJob, true);
  const { layout, frameRects: finalFrameRects, colOf, canvasHeight } = sceneLayout ?? EMPTY_SCENE_LAYOUT;
  const visibleNormals = useMemo(() => props.visibleMessageIds ? normals.filter(message => props.visibleMessageIds!.has(message.id)) : normals, [normals, props.visibleMessageIds]);
  const visibleNormalIds = useMemo(() => visibleNormals.map(message => message.id), [visibleNormals]);
  const visibleEdges = useMemo(() => props.visibleEdgeIds ? edges.filter(edge => props.visibleEdgeIds!.has(edge.id)) : edges, [edges, props.visibleEdgeIds]);
  const measuredIds = useMemo(() => {
    const frameIds = new Set(visibleEdges.map(edge => edge.relationMessageId));
    return [...visibleNormals.map(message => message.id), ...frameBlocks.filter(frame => (frame.isMerge || frame.hasCardHeader || frame.hasGroupHeader)
      && (!props.visibleMessageIds || props.visibleMessageIds.has(frame.relMsgId) || frameIds.has(frame.relMsgId))).map(frame => frame.relMsgId)];
  }, [visibleNormals, visibleEdges, frameBlocks, props.visibleMessageIds]);
  const virtualBoxes = useMemo(() => {
    const boxes = { ...layout };
    for (const frame of frameBlocks) {
      const rect = finalFrameRects[frame.relMsgId];
      if (!rect) continue;
      if (frame.isMerge || frame.hasCardHeader) boxes[frame.relMsgId] = { ...getMergeCardHeaderRect(rect), height: measuredHeights[frame.relMsgId] ?? MERGE_CARD_H };
      else if (frame.hasGroupHeader) boxes[frame.relMsgId] = getGroupHeaderRect(rect, getGroupHeaderHeight(measuredHeights, frame.relMsgId));
    }
    return boxes;
  }, [layout, finalFrameRects, frameBlocks, measuredHeights]);
  const virtualPins = useMemo(() => new Set([lastClickedMessageId, activeTextSelectId, settlementOpenMsgId, props.autoCenterMessageId]
    .filter((id): id is string => !!id)), [lastClickedMessageId, activeTextSelectId, settlementOpenMsgId, props.autoCenterMessageId]);
  const revealGroups = useMemo(() => createMessageJumpGroups(messages, edges, new Map(frameBlocks.map(frame => [frame.relMsgId,
    new Set([...frame.cardIds, ...frame.childRelMsgIds])]))), [messages, edges, frameBlocks]);
  useLayoutEffect(() => {
    if (canvasRef.current) return registerMessageJumpGroups(canvasRef.current, revealGroups);
  }, [revealGroups]);
  const virtual = useVirtualMessageMounts(canvasRef, measuredIds, virtualBoxes, measuredHeights, virtualPins, false, revealGroups, resolveRevealIds);
  const mountedNormals = useMemo(() => visibleNormals.filter(message => virtual.mounted.has(message.id)), [visibleNormals, virtual.mounted]);
  const visibleBottom = useMemo(() => {
    let bottom = 0;
    for (const [id, box] of [...Object.entries(layout), ...Object.entries(finalFrameRects)]) {
      if (!props.visibleMessageIds || props.visibleMessageIds.has(id)) bottom = Math.max(bottom, box.y + box.height);
    }
    return bottom;
  }, [layout, finalFrameRects, props.visibleMessageIds]);
  const actualCanvasWidth = useMemo(() => {
    let w = canvasWidth;
    for (const box of Object.values(layout)) w = Math.max(w, box.x + box.width + canvasRightPad);
    for (const r of Object.values(finalFrameRects)) w = Math.max(w, r.x + r.width + canvasRightPad);
    return w;
  }, [canvasWidth, canvasRightPad, layout, finalFrameRects]);
  const actualCanvasHeight = useMemo(() => {
    // Reserve geometry in the layout model, not empty scrollable DOM space.
    // End/scrollbar navigation must reach the mounted boundary and load onward.
    if (props.visibleMessageIds) return visibleBottom + CANVAS_BOTTOM_PAD;
    let h = canvasHeight;
    for (const box of Object.values(layout)) h = Math.max(h, box.y + box.height + CANVAS_BOTTOM_PAD);
    for (const r of Object.values(finalFrameRects)) h = Math.max(h, r.y + r.height + CANVAS_BOTTOM_PAD);
    return h;
  }, [canvasHeight, layout, finalFrameRects, props.visibleMessageIds, visibleBottom]);
  const anonCorrectedRelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of edges) {
      if (e.relationType === 'correct' && !e.proposalOnly && !isBodyCorrection(e, msgMap) && e.from.messageId.startsWith('anon:')) {
        if (msgMap.get(e.to.messageId)?.kind === 'relation') {
          ids.add(e.to.messageId);
        }
      }
    }
    return ids;
  }, [edges, msgMap]);

  const overlays = useGraphOverlays({
    excludedStanceEdges:props.excludedStanceEdges, visibleDecorationIds, visibleAnnotationIds,
    pendingMeasurements: virtual.pending,
    labelViewport: virtual.viewport, labelRetainedIds: virtual.retained,
    canvasRef, normalIds: visibleNormalIds, msgMap, relationCardMsgIds, cardRefs, colOf, layout, normals: visibleNormals, headerRefs, contentRefs, edges: visibleEdges, messages, isTraceWindow, anonCorrectedRelMsgIds, finalFrameRects, traceExpandedFrameIds, edgesByRelMsg, comparisonSuppressedRelIds, correctedEdgeIdsByRelMsg, textRefs, actualCanvasWidth, actualCanvasHeight,
  });
  const { labelBboxes, decorationsByMsgState, relDecByRelMsgState, tagsByRelMsgState } = overlays;
  const overlayRetained = useMemo(() => {
    const retained = new Set(virtual.retained);
    // A vote/tag is drawn beside its target. Reveal that decoration even when
    // the relation itself has no card; cached geometry avoids mounting members.
    for (const id of virtual.retained) for (const edge of edgesByRelMsg.get(id) ?? []) {
      retained.add(edge.from.messageId); retained.add(edge.to.messageId);
    }
    return retained;
  }, [virtual.retained, edgesByRelMsg]);
  const { positionedEdges, decorationRectsState, tagDecorationsByMsg, arrangeFrames, groupFrames, inlineBadgesByMsg, annotationToggleRects } = useMemo(() => {
    const keep = (id: string, rect: Rect) => overlayRetained.has(id) || virtual.mounted.has(id) || intersectsViewport(rect, virtual.viewport, 100);
    return {
      positionedEdges: overlays.positionedEdges.filter(edge => keep(edge.edge.relationMessageId, {
        x: Math.min(edge.start.x, edge.ctrl.x, edge.end.x, edge.labelX), y: Math.min(edge.start.y, edge.ctrl.y, edge.end.y, edge.labelY),
        width: Math.max(edge.start.x, edge.ctrl.x, edge.end.x, edge.labelX) - Math.min(edge.start.x, edge.ctrl.x, edge.end.x, edge.labelX),
        height: Math.max(edge.start.y, edge.ctrl.y, edge.end.y, edge.labelY) - Math.min(edge.start.y, edge.ctrl.y, edge.end.y, edge.labelY) })),
      decorationRectsState: overlays.decorationRectsState && Object.fromEntries(Object.entries(overlays.decorationRectsState).filter(([, value]) => keep(value.messageId, value.rect))),
      tagDecorationsByMsg: Object.fromEntries(Object.entries(overlays.tagDecorationsByMsg).map(([id, groups]) => [id, groups.filter(group => keep(id, group.rect))])),
      arrangeFrames: overlays.arrangeFrames.map(frame => ({ ...frame, rect: finalFrameRects[frame.relMsgId] ?? frame.rect })).filter(frame => keep(frame.relMsgId, frame.rect)),
      groupFrames: overlays.groupFrames.filter(frame => keep(frame.relMsgId, finalFrameRects[frame.relMsgId] ?? frame.rect)),
      inlineBadgesByMsg: new Map([...overlays.inlineBadgesByMsg].map(([id, badges]) => [id, badges.filter(badge => keep(id, badge.rect))])),
      annotationToggleRects: Object.fromEntries(Object.entries(overlays.annotationToggleRects).filter(([id, rect])=>keep(id,rect))),
    };
  }, [overlays, overlayRetained, virtual.mounted, virtual.viewport, finalFrameRects]);

  useLayoutEffect(() => {
    reportWorkbenchDrawingDuration(performance.now() - renderStartedAt);
    noteWorkbenchDrawingProgress();
  });

  const visibleArrangeFrames = useMemo(() => arrangeFrames.filter(frame => !effectiveHideMessageIds.has(frame.relMsgId)), [arrangeFrames, effectiveHideMessageIds]);
  const renderedGroupFrames = useMemo(() => groupFrames.map(frame => {
    const rect = finalFrameRects[frame.relMsgId];
    return rect ? { ...frame, rect } : frame;
  }), [groupFrames, finalFrameRects]);
  const visibleGroupFrames = useMemo(() => renderedGroupFrames.filter(frame =>
    !effectiveHideMessageIds.has(frame.relMsgId) &&
    (!isTraceWindow || !['classify', 'summary'].includes(frame.relType)
      || traceExpandedFrameIds.has(frame.relMsgId)),
  ), [renderedGroupFrames, effectiveHideMessageIds, isTraceWindow, traceExpandedFrameIds]);

  const relatedCatalog = useMemo(() => new Map((props.relatedMessages ?? messages).map(message => [message.id, message])), [props.relatedMessages, messages]);
  const relatedConnections = useMemo(() => props.relatedEdges ? deriveCrossCanvasRelations({
    edges: props.relatedEdges,
    visibleMessageIds: new Set([...visibleNormalIds.filter(id => !effectiveHideMessageIds.has(id)),
      ...overlays.groupFrames.filter(frame => !effectiveHideMessageIds.has(frame.relMsgId)
        && (!isTraceWindow || !['classify', 'summary'].includes(frame.relType) || traceExpandedFrameIds.has(frame.relMsgId))).map(frame => frame.relMsgId),
      ...overlays.arrangeFrames.filter(frame => !effectiveHideMessageIds.has(frame.relMsgId)).map(frame => frame.relMsgId),
      ...overlays.positionedEdges.map(positioned => positioned.edge.relationMessageId)]),
    renderedEdges: overlays.positionedEdges.map(positioned => positioned.edge),
  }) : crossCanvasRelations, [props.relatedEdges, visibleNormalIds, effectiveHideMessageIds, overlays, isTraceWindow, traceExpandedFrameIds, crossCanvasRelations]);
  const renderRelatedConnections = (messageId: string) => <CrossCanvasRelatedMessages groups={relatedConnections?.get(messageId)}
    messages={relatedCatalog} selectedUnits={draftUnits} onView={props.onRelatedRelationView ?? onNavigateToMessage} />;

  const selectedMessageIds = useMemo(() => new Set([
    ...draftUnits
      .filter(unit => isWholeMessageSelection(unit, unit.messageId))
      .map(unit => unit.messageId),
    ...(lastClickedMessageId ? [lastClickedMessageId] : []),
  ]), [draftUnits, lastClickedMessageId]);

  useLayoutEffect(() => {
    // Disabled debug geometry must not enqueue state updates during drawing.
    if (!SHOW_SELECTED_ACTUAL_RECTS) return;
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const canvasRect = canvasEl.getBoundingClientRect();
    const scaleX = canvasEl.offsetWidth > 0 ? canvasRect.width / canvasEl.offsetWidth : 1;
    const scaleY = canvasEl.offsetHeight > 0 ? canvasRect.height / canvasEl.offsetHeight : 1;
    const next: Record<string, Rect> = {};
    const toCanvasRect = (rect: DOMRect): Rect => ({
      x: (rect.left - canvasRect.left) / scaleX,
      y: (rect.top - canvasRect.top) / scaleY,
      width: rect.width / scaleX,
      height: rect.height / scaleY,
    });
    for (const messageId of selectedMessageIds) {
      const element = cardRefs.current[messageId];
      const actualRect = element?.getBoundingClientRect();
      let selectedRect = actualRect && actualRect.width > 1 && actualRect.height > 1
        ? toCanvasRect(actualRect)
        : undefined;
      const selectedFrame = visibleGroupFrames.find(frame => frame.relMsgId === messageId);
      const frameRect = selectedFrame?.rect ?? (selectedFrame ? finalFrameRects[messageId] : undefined);
      selectedRect = unionLayoutRects(selectedRect, frameRect);
      if (selectedRect) next[messageId] = selectedRect;
    }
    setSelectedActualRects(prev => {
      const prevIds = Object.keys(prev);
      const nextIds = Object.keys(next);
      if (prevIds.length === nextIds.length && nextIds.every(id => {
        const before = prev[id];
        const after = next[id];
        return before && Math.abs(before.x - after.x) < 0.5 && Math.abs(before.y - after.y) < 0.5
          && Math.abs(before.width - after.width) < 0.5 && Math.abs(before.height - after.height) < 0.5;
      })) return prev;
      return next;
    });
  }, [selectedMessageIds, visibleGroupFrames, finalFrameRects, layout, actualCanvasWidth, actualCanvasHeight, measuredHeights]);

  useLayoutEffect(() => {
    if (!props.autoCenterMessageId) return;
    const target = cardRefs.current[props.autoCenterMessageId];
    if (!target) return;
    const task = startPositioning();
    task.run(() => {
      target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      task.complete();
    });
  }, [props.autoCenterMessageId, layout, startPositioning]);

  // Map: target relation-message ID → [{corrRelMsgId, srcMsgId}] for CORRECT relations targeting relation messages.
  // Used to embed correction badge in the target relation's hit area.
  const correctedRelMsgTargets = useMemo(() => {
    const map = new Map<string, Array<{corrRelMsgId: string; srcMsgId: string}>>();
    for (const e of edges) {
      if (e.relationType !== 'correct' || isBodyCorrection(e, msgMap)) continue;
      const targetId = e.to.messageId;
      if (msgMap.get(targetId)?.kind !== 'relation') continue;
      const arr = map.get(targetId) ?? [];
      arr.push({ corrRelMsgId: e.relationMessageId, srcMsgId: e.from.messageId });
      map.set(targetId, arr);
    }
    return map;
  }, [edges, msgMap]);

  // Set of relation-message IDs that are targeted by a CORRECT relation with an anon: source
  // (i.e. correction with no replacement relation). These are displayed as a blank label with
  // only the correction badge visible — the original arrow and text are hidden.

  // Map: new relation-message ID (source of CORRECT) → [{corrRelMsgId, targetRelMsgId}]
  // for CORRECT relations where both source and target are relation messages.
  // Used to show a correction badge on the replacement relation's edge label.
  const correctionSrcByNewRelMsg = useMemo(() => {
    const map = new Map<string, Array<{corrRelMsgId: string; targetRelMsgId: string}>>();
    for (const e of edges) {
      if (e.relationType !== 'correct' || e.proposalOnly) continue;
      const srcId = e.from.messageId;
      if (srcId.startsWith('anon:')) continue;
      if (msgMap.get(srcId)?.kind !== 'relation') continue;
      const targetId = e.to.messageId;
      if (msgMap.get(targetId)?.kind !== 'relation') continue;
      const arr = map.get(srcId) ?? [];
      arr.push({ corrRelMsgId: e.relationMessageId, targetRelMsgId: targetId });
      map.set(srcId, arr);
    }
    return map;
  }, [edges, msgMap]);


  function isEdgeLabelFragSel(relId:string,edgeId:string) {
    return draftUnits.some(x=>unitEquals(x,{messageId:relId,selection:{kind:"edge",edgeId}}));
  }
  function isRelWholeSel(relId:string) {
    return draftUnits.some(unit => isWholeMessageSelection(unit, relId));
  }

  function isDecorationSelected(relId:string, kind:"agree"|"disagree") {
    const decoration = relDecByRelMsgState.get(relId);
    const selectedIds = kind === "agree" ? decoration?.agreeRelMsgIds : decoration?.disagreeRelMsgIds;
    return selectedIds?.some(isRelWholeSel) ?? false;
  }

  function renderContent(message: DemoMessage, partId?: string) {
    const fontSize = getMessageProminence(message).fontSize;
    const part = message.parts?.find(candidate => candidate.id === partId);
    const text = part?.type === 'text' ? part.text : part?.type === 'web' ? part.excerpt : part?.type === 'code' ? part.source : message.content;
    const targets = extractTextTargetsForMessage(message.id, edges, partId, message.revision);
    if (!targets.length) return <pre style={{margin:0,whiteSpace:"pre-wrap",overflowWrap:"anywhere",fontFamily:"Menlo,Monaco,Consolas,'Courier New',monospace",fontSize}}>{text}</pre>;
    const validItems = targets
      .filter(t => t.start >= 0 && t.start + t.len <= text.length && t.len > 0)
      .map(t => ({ start: t.start, end: t.start + t.len, relationType: t.relationType, edgeId: t.edgeId }));
    const tree = buildAnnoTree(validItems);
    const nodes = renderAnnoNodes(
      text,
      tree,
      0,
      text.length,
      0,
      message.id,
      (id, start, len, fragment) => partId
        ? draftUnits.some(unit => unit.messageId === id && unit.reference?.partId === partId
          && (unit.reference.revision === undefined || unit.reference.revision === (message.revision ?? 1))
          && unit.reference.range?.start === start && unit.reference.range.end === start + len)
        : isFragmentSelected(id, start, len, fragment),
      (id, start, len, fragment) => partId
        ? window.dispatchEvent(new CustomEvent(PART_SELECTION_EVENT, { detail: { reference: { messageId: id, revision: message.revision ?? 1, partId, range: { start, end: start + len } }, label: fragment } }))
        : onFragmentAnchorClick?.(id, start, len, fragment),
      (_id, start, len, relationType) => targets.some(target => target.start === start && target.len === len
        && target.relationType === relationType && annotationTargetFragmentHints.has(target.edgeId))
    );
    return <pre style={{margin:0,whiteSpace:"pre-wrap",overflowWrap:"anywhere",fontFamily:"Menlo,Monaco,Consolas,'Courier New',monospace",fontSize}}>{nodes}</pre>;
  }

  function renderCorrectionRecords(messageId: string) {
    const records = [...new Set((correctionsByTargetMsgId.get(messageId) ?? []).map(record => record.relMsgId))];
    if (!records.length) return null;
    const latest = records[records.length - 1];
    const active = records.filter(id => !invalidCorrectionIds?.has(id)).length;
    return <span style={{display:'inline-flex',alignItems:'center'}}><span data-msgid={latest} data-jump-msgids={records.join(' ')} data-rel-overlay="true"
      title={`更正关系：${latest}；共${records.length}次更正，单击选中，双击查看历史`}
      onClick={event => { event.stopPropagation(); onInlineBadgeClick?.(event, latest); }}
      onDoubleClick={event => { event.stopPropagation(); onInlineBadgeDoubleClick?.(event, latest); }}
      style={{background:isRelWholeSel(latest)?'#fbbf24':'rgba(170,110,0,0.9)',color:isRelWholeSel(latest)?'#111827':'#fff',
        borderRadius:3,fontSize:9,padding:'0 4px',fontWeight:600,cursor:'pointer',pointerEvents:'auto',
        whiteSpace:'nowrap',userSelect:'none',opacity:active ? 1 : 0.45}}>
      ✏更正 {active}/{records.length}
    </span><MessageDisplayMarker messageId={messageId} scope="corrections" /></span>;
  }

  const homeRoleLabel = (messageId: string) => {
    if (props.homeMatchIds?.has(messageId)) return '命中';
    const role = props.homeContextRoleByMessageId?.get(messageId);
    return role === 'source' ? '来源' : role === 'target' ? '目标' : role === 'source-target' ? '来源/目标' : null;
  };

  return (
    <div ref={canvasRef} data-jump-canvas="true" style={{position:"relative",width:actualCanvasWidth,height:actualCanvasHeight,zIndex:0}}
      onDoubleClick={e=>{const t=e.target as HTMLElement;if(!canvasRef.current)return;if(t.closest&&(t.closest("[data-msgid]")||t.closest("svg")||t.closest('[title^="relation="]')||t.closest("[data-rel-overlay]")))return;onCanvasBlankClick?.();}}>
      {props.visibleMessageIds && <div data-message-window-boundary="true" aria-hidden="true" style={{ position: 'absolute', top: visibleBottom, left: 0, height: 1, width: 1 }} />}
      <div style={{position:"absolute",left:0,top:0,width:actualCanvasWidth,height:actualCanvasHeight,zIndex:1}}>
        {mountedNormals.map(msg=><div key={msg.id} aria-hidden={!virtual.isOnscreen(msg.id) || undefined}
          style={{ visibility: virtual.isOnscreen(msg.id) ? undefined : 'hidden', pointerEvents: virtual.isOnscreen(msg.id) ? undefined : 'none' }}>{(() => {
          const box=layout[msg.id]; if(!box) return null;
          const prominence = getMessageProminence(msg);
          if (effectiveHideMessageIds.has(msg.id) || traceExpandedFrameIds.has(msg.id)) return null;
          // Hidden targets: corrected targets (replaced by correction source) and
          // summarized targets (covered by summary card). Chained sources remain visible.
          if (hiddenTargetIds.has(msg.id)) return null;

          // CLASSIFY relation messages are shown as classification cards on the main canvas.
          // SUMMARY messages fall through to normal card rendering below.
          if (msg.kind === "relation" && classifyRelMsgIds.has(msg.id)) {
            // Count unique text-message targets from ALL edges (not just visible ones).
            // The graphEdges filter may exclude edges whose targets are hidden (classified),
            // so we count from the raw edges prop directly. Deduplicate by to.messageId
            // because secondary relation types create duplicate edges.
            const targetCount = (() => {
              const seen = new Set<string>();
              if(isRejectedContainer(msg,props.rejectedContainerIds)) {
                for(const ref of [...msg.targetRefs??[],...msg.declaredTargetRefs??[]]) seen.add(ref.kind==='relation'?ref.relationId:ref.messageId);
                for(const join of joinRelationsBySource?.get(msg.id)??[])for(const ref of join.targetRefs)seen.add(ref.kind==='relation'?ref.relationId:ref.messageId);
              }
              for (const e of edges) {
                if (e.relationMessageId !== msg.id) continue;
                if (e.to.messageId.startsWith('anon:')) continue;
                seen.add(e.to.messageId);
              }
              return seen.size;
            })();
            const classificationTitle = getOrganizationTitle(msg, targetCount);
            const relatedJoinRelations = joinRelationsByTarget?.get(msg.id) ?? [];
            const outgoingJoinRelations = joinRelationsBySource?.get(msg.id) ?? [];
            const isWhole = draftUnits.some(u => isWholeMessageSelection(u, msg.id));
            const isActive = lastClickedMessageId === msg.id;
            const isClassificationStanceTarget = stanceHighlight?.stanceMsgId === msg.id;
            return <ClassificationCard key={msg.id} msg={msg} selectedUnits={draftUnits} box={box} targetCount={targetCount} title={classificationTitle}
              correctionRecords={renderCorrectionRecords(msg.id)}
              activeText={activeTextSelectId === msg.id} isWhole={isWhole} isActive={isActive} isStanceTarget={isClassificationStanceTarget}
              homeLabel={homeRoleLabel(msg.id)} stakes={stakeCounts?.[msg.id]}
              relatedJoinRelations={relatedJoinRelations} outgoingJoinRelations={outgoingJoinRelations}
              relatedMessages={<><RelatedMessages rows={relatedByTarget.get(msg.id)} selectedUnits={draftUnits} onNavigate={props.onRelatedMessageNavigate??onNavigateToMessage}/>{renderRelatedConnections(msg.id)}</>}
              isJoinEffective={isJoinEffective}
              cardRef={el => { cardRefs.current[msg.id] = el; }} headerRef={el => { headerRefs.current[msg.id] = el; }} contentRef={el => { contentRefs.current[msg.id] = el; }}
              onMessageClick={onMessageClick} onMessageDoubleClick={onMessageDoubleClick} onMessageMouseDown={onMessageMouseDown} onMessageMouseUp={onMessageMouseUp}
              onTextMouseUp={onTextMouseUp} onSettlementToggleTruth={onSettlementToggleTruth} onSettlementToggleValue={onSettlementToggleValue}
              onJoinFilterClick={onJoinFilterClick} settlementOpenMsgId={settlementOpenMsgId} settlementOpenType={settlementOpenType} />;
          }

          const isWhole=draftUnits.some(u => isWholeMessageSelection(u, msg.id));
          const isCorrectableRelation = msg.kind === 'relation'
            && isCardMessage(msg);
          const isText=activeTextSelectId===msg.id&&(msg.kind==="normal" || isCorrectableRelation);
          const corrBadges = correctionsByTargetMsgId.get(msg.id) ?? [];
          const uniqueCorrBadges = Array.from(new Map(corrBadges.map(b => [b.relMsgId, b])).values());
          const correctionBadge = uniqueCorrBadges[uniqueCorrBadges.length - 1];
          const correctionCount = uniqueCorrBadges.length;
          const correctionBadgeJumpIds = uniqueCorrBadges.map(b => b.relMsgId).join(' ');
          const versionState = correctionVersionsByTargetMsgId.get(msg.id);
          const validCorrectionIds = new Set(
            versionState?.versions
              .filter(version => version.valid && !version.conflicted)
              .map(version => version.correctionId) ?? [],
          );
          const validCorrectionCount = uniqueCorrBadges.filter(b => validCorrectionIds.has(b.relMsgId)).length;
          const correctionBadgeOpacity = validCorrectionCount === 0 ? 0.45 : 1;
          const correctionBadgeLabel = `✏更正 ${validCorrectionCount}/${correctionCount}`;

          // Phase 5: Stance path highlighting
          const isStanceTarget = stanceHighlight?.stanceMsgId === msg.id;
          const isStanceEvidence = stanceHighlight?.evidenceMsgIds.includes(msg.id) ?? false;
          const stanceBorder = isStanceTarget
            ? '2px solid #f59e0b'
            : isStanceEvidence
              ? '1px solid rgba(245,158,11,0.6)'
              : undefined;
          const stanceShadow = isStanceTarget
            ? '0 0 16px rgba(245,158,11,0.35), 0 4px 10px rgba(0,0,0,0.5)'
            : isStanceEvidence
              ? '0 0 8px rgba(245,158,11,0.18), 0 4px 10px rgba(0,0,0,0.5)'
              : undefined;
          const stanceBg = isStanceTarget
            ? '#2a2410'
            : isStanceEvidence
              ? '#242015'
              : undefined;

          // Kind-based styling for governance / code / settlement messages
          const kindMeta = (() => {
            if (msg.kind === 'governance') return { color: '#f59e0b', label: getRelationMessageLabel(msg) ?? '提案', bg: 'rgba(245,158,11,0.08)' };
            if (msg.kind === 'code')        return { color: '#14b8a6', label: '代码', bg: 'rgba(20,184,166,0.08)' };
            if (msg.kind === 'operations')  return { color: '#06b6d4', label: '📊 运营', bg: 'rgba(6,182,212,0.08)' };
            if (msg.kind === 'relation' && msg.relationType === 'delegation') {
              const isFulfill = msg.relationPayload?.delegationKind === 'FULFILL';
              return { color: '#f97316', label: isFulfill ? '完成委托' : '创建委托', bg: 'rgba(249,115,22,0.1)' };
            }
            if (msg.kind === 'round') {
              const isValue = (msg as any).roundPayload?.settlementType === 'VALUE';
              return isValue
                ? { color: '#fcd34d', label: '💎 结算中', bg: 'rgba(252,211,77,0.08)' }
                : { color: '#a5b4fc', label: '⚖️ 结算中', bg: 'rgba(165,180,252,0.08)' };
            }
            if (msg.kind === 'round_result') {
              const isValue = (msg as any).roundPayload?.settlementType === 'VALUE';
              return isValue
                ? { color: '#f59e0b', label: '💎 已结算', bg: 'rgba(245,158,11,0.12)' }
                : { color: '#818cf8', label: '⚖️ 已结算', bg: 'rgba(129,140,248,0.12)' };
            }
            if (msg.kind === 'relation' && msg.relationType === 'summary') return { color: '#34d399', label: '总结', bg: 'rgba(52,211,153,0.08)' };
            if (msg.kind === 'relation') return { color: '#c4b5fd', label: getRelationMessageLabel(msg) ?? relationTypeName(msg.relationType ?? 'relation'), bg: 'rgba(196,181,253,0.08)' };
            if (msg.kind === 'normal') return { color: '#94a3b8', label: '文本', bg: 'rgba(148,163,184,0.08)' };
            return null;
          })();
          const kindBorder = kindMeta ? `3px solid ${kindMeta.color}` : undefined;
          const kindBg = kindMeta ? kindMeta.bg : undefined;
          const joinStatus = joinStatusByMessage?.get(msg.id);
          const joinPresentation = joinStatus ? getJoinStatusPresentation(joinStatus, props.joinEffectSourcesByMessage?.get(msg.id)) : undefined;
          const joinIsInvalid = !!joinStatus && joinStatus !== 'valid';

          return (
            <div key={msg.id} data-msgid={msg.id} ref={el=>{cardRefs.current[msg.id]=el;}}
              role="group" tabIndex={0} aria-label={`消息 ${msg.id}，${isWhole ? '已选中' : '未选中'}`}
              aria-keyshortcuts="Enter Space Shift+Enter" onKeyDown={activateMessageFromKeyboard}
              onClick={e=>onMessageClick(e,msg.id)} onDoubleClick={e=>onMessageDoubleClick(e,msg.id)}
              onMouseDown={e=>onMessageMouseDown?.(e,msg.id)} onMouseUp={e=>onMessageMouseUp?.(e,msg.id)}
              style={{position:"absolute",left:box.x,top:box.y,width:box.width,boxSizing:"border-box",backgroundColor:isWhole?"#5b4100":stanceBg||kindBg||"#1f1f1f",backgroundImage:isWhole?undefined:prominence.backgroundImage,borderRadius:6,borderTop:stanceBorder||(isText?"2px dashed #0b84ff":isWhole?"2px solid #fbbf24":"1px solid #444"),borderRight:stanceBorder||(isText?"2px dashed #0b84ff":isWhole?"2px solid #fbbf24":"1px solid #444"),borderBottom:stanceBorder||(isText?"2px dashed #0b84ff":isWhole?"2px solid #fbbf24":"1px solid #444"),borderLeft:kindBorder||(stanceBorder?undefined:(isText?"2px dashed #0b84ff":isWhole?"2px solid #fbbf24":"1px solid #444")),padding:"12px 16px",boxShadow:stanceShadow||(isText?"0 6px 18px rgba(11,132,255,0.06)":isWhole?"0 4px 18px rgba(251,191,36,0.45)":prominence.boxShadow||"0 4px 10px rgba(0,0,0,0.5)"),display:"flex",flexDirection:"column",gap:8,cursor:"pointer",outline:isWhole?"none":lastClickedMessageId===msg.id?"1px dashed #0b84ff":"none",userSelect:activeTextSelectId===msg.id?"text":"auto"}}>
              {/* Correction badges: for text messages, shown centered in the same header row as author/msgId */}
              <div ref={el=>{headerRefs.current[msg.id]=el;}} style={{fontSize:11,opacity:0.85,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{flex:1,display:"flex",alignItems:"center",gap:4}}>
                  {/* For non-text (relation) messages, keep badges left-aligned in header */}
                  {msg.kind!=="normal" && correctionBadge && (
                    <div key={`corr-hdr-${correctionBadge.relMsgId}`}
                      data-msgid={correctionBadge.relMsgId} data-jump-msgids={correctionBadgeJumpIds} data-rel-overlay="true"
                      onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,correctionBadge.relMsgId);}}
                      onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,correctionBadge.relMsgId);}}
                      title={`更正关系：${correctionBadge.relMsgId}；共${correctionCount}次更正，单击选中，双击查看历史`}
                      style={{background:isRelWholeSel(correctionBadge.relMsgId)?"#fbbf24":"rgba(170,110,0,0.9)",
                        color:isRelWholeSel(correctionBadge.relMsgId)?"#111827":"#fff",borderRadius:3,fontSize:9,padding:"0 4px",fontWeight:600,
                        cursor:"pointer",pointerEvents:"auto",
                        border:isRelWholeSel(correctionBadge.relMsgId)?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.15)",
                        boxShadow:isRelWholeSel(correctionBadge.relMsgId)?"0 1px 4px rgba(251,191,36,0.35)":"none",
                        whiteSpace:"nowrap",userSelect:"none",flexShrink:0,opacity:correctionBadgeOpacity}}>
                      {correctionBadgeLabel}
                    </div>
                  )}
                  {msg.kind!=="normal" && correctionBadge && <MessageDisplayMarker messageId={msg.id} scope="corrections" />}
                  {homeRoleLabel(msg.id) && <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,background:homeRoleLabel(msg.id)==='命中'?"#0e7490":"#374151",color:homeRoleLabel(msg.id)==='命中'?"#cffafe":"#d1d5db"}}>{homeRoleLabel(msg.id)}</span>}
                  {kindMeta && (
                    <MessageElement reference={messageTypeReference(msg)} selected={isMessageElementSelected(draftUnits, messageTypeReference(msg))} label={kindMeta.label} style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,background:isWhole?"#fbbf24":`${kindMeta.color}22`,color:isWhole?"#111827":kindMeta.color,lineHeight:"16px",border:isWhole?"1px solid #fbbf24":`1px solid ${kindMeta.color}44`}}>
                      {kindMeta.label}
                    </MessageElement>
                  )}
                  <span>{msg.author}</span>
                </div>
                {/* Correction votes expand as a vertical column to the right of the correction badge. */}
                {msg.kind==="normal" && correctionBadge && (
                  <div style={{flex:1,display:"flex",justifyContent:"center",gap:4,flexWrap:"wrap"}}>
                    {(() => {
                      const b = correctionBadge;
                      const corrDec=relDecByRelMsgState?.get(b.relMsgId);
                      return (
                        <div key={`corr-hdr-${b.relMsgId}`} style={{display:'inline-flex',alignItems:'center',gap:4,flexShrink:0,whiteSpace:'nowrap'}}>
                          <div
                            data-msgid={b.relMsgId} data-jump-msgids={correctionBadgeJumpIds} data-rel-overlay="true"
                            onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,b.relMsgId);}}
                            onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,b.relMsgId);}}
                            title={`更正关系：${b.relMsgId}；共${correctionCount}次更正，单击选中，双击查看历史`}
                            style={{background:isRelWholeSel(b.relMsgId)?"#fbbf24":"rgba(170,110,0,0.9)",
                              color:isRelWholeSel(b.relMsgId)?"#111827":"#fff",borderRadius:3,fontSize:9,padding:"0 4px",fontWeight:600,
                              cursor:"pointer",pointerEvents:"auto",
                              border:isRelWholeSel(b.relMsgId)?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.15)",
                              boxShadow:isRelWholeSel(b.relMsgId)?"0 1px 4px rgba(251,191,36,0.35)":"none",
                              whiteSpace:"nowrap",userSelect:"none",flexShrink:0,opacity:correctionBadgeOpacity}}>
                            {correctionBadgeLabel}
                          </div>
                          <MessageDisplayMarker messageId={msg.id} scope="corrections" />
                          {corrDec&&(corrDec.agreeCount>0||corrDec.disagreeCount>0)&&renderDecorationToggle(b.relMsgId)}
                          {visibleDecorationIds.has(b.relMsgId)&&<div style={{display:'inline-flex',flexDirection:'column',gap:2}}>
                          {corrDec && corrDec.agreeCount>0 && (
                            <div data-msgid={b.relMsgId} data-jump-msgids={corrDec.agreeRelMsgIds.join(' ')} data-rel-overlay="true"
                              onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,b.relMsgId,"agree");}}
                              onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,b.relMsgId,"agree");}}
                              title={`赞同更正：${b.relMsgId}；单击选中，双击展开详情`}
                              style={{background:"rgba(2,150,80,0.9)",color:"#fff",borderRadius:3,fontSize:9,padding:"0 4px",
                                fontWeight:600,cursor:"pointer",pointerEvents:"auto",border:"1px solid rgba(255,255,255,0.15)",
                                whiteSpace:"nowrap",userSelect:"none",flexShrink:0}}>
                              👍{corrDec.agreeCount}
                            </div>
                          )}
                          {corrDec && corrDec.disagreeCount>0 && (
                            <div data-msgid={b.relMsgId} data-jump-msgids={corrDec.disagreeRelMsgIds.join(' ')} data-rel-overlay="true"
                              onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,b.relMsgId,"disagree");}}
                              onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,b.relMsgId,"disagree");}}
                              title={`反对更正：${b.relMsgId}；单击选中，双击展开详情`}
                              style={{background:"rgba(200,40,40,0.9)",color:"#fff",borderRadius:3,fontSize:9,padding:"0 4px",
                                fontWeight:600,cursor:"pointer",pointerEvents:"auto",border:"1px solid rgba(255,255,255,0.15)",
                                whiteSpace:"nowrap",userSelect:"none",flexShrink:0}}>
                              👎{corrDec.disagreeCount}
                            </div>
                          )}
                          </div>}
                        </div>
                      );
                    })()}
                  </div>
                )}
                <div style={{flex:1,display:"flex",justifyContent:"flex-end",flexDirection:"column",alignItems:"flex-end"}}>
                  <span style={{display:'inline-flex',alignItems:'center'}}>
                  {msg.kind === "join" && onNavigateToMessage ? (
                    <span
                      data-rel-overlay="true"
                      onClick={e => { e.stopPropagation(); onNavigateToMessage(msg.id); }}
                      style={{opacity:0.95,fontFamily:"monospace",fontSize:10,color:"#93c5fd",cursor:"pointer",padding:"1px 4px",borderRadius:3,background:"rgba(59,130,246,0.15)",textDecoration:"underline",textUnderlineOffset:2}}
                      title={`跳转到加入消息 ${msg.id} 的当前实际位置`}
                    >{msg.id}</span>
                  ) : (
                    <span style={{opacity:0.7}}>{msg.id}</span>
                  )}
                  <MessageDisplayMarker messageId={msg.id} />
                  </span>
                  <MessageSettlementActions messageId={msg.id} counts={stakeCounts?.[msg.id]}
                    openMessageId={settlementOpenMsgId} openType={settlementOpenType}
                    onTruth={onSettlementToggleTruth} onValue={onSettlementToggleValue} />
                </div>
              </div>
              {msg.state?.suppressed && ['summary', 'merge', 'arrange', 'classify'].includes(msg.relationType ?? '') && (
                <div style={{ fontSize: 11, color: '#fcd34d' }}>{msg.relationType === 'summary' ? '覆盖已取消' : '显示组织已取消'} · 原消息已恢复，仍可查看和表态</div>
              )}
              {joinStatus && (
                <div title={joinPresentation?.hint} style={{ fontSize: 10, fontWeight: 600, color: joinIsInvalid ? '#fca5a5' : '#86efac', alignSelf: 'flex-start', padding: '1px 6px', borderRadius: 4, background: joinIsInvalid ? 'rgba(239,68,68,0.16)' : 'rgba(34,197,94,0.15)', border: `1px solid ${joinIsInvalid ? 'rgba(239,68,68,0.35)' : 'rgba(34,197,94,0.3)'}` }}>
                  {joinPresentation?.label}
                </div>
              )}
              {msg.executedStance && needsSeparateStanceCard(msg, msgMap) && (
                <div style={{ fontSize: 11, color: msg.executedStance.side === 'pro' ? '#86efac' : '#fca5a5', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {msg.executedStance.side === 'pro' ? '赞同' : '反对'}：{describeUnit({ messageId: msg.executedStance.target.messageId, reference: msg.executedStance.target, selection: { kind: 'whole' } }, msgMap.get(msg.executedStance.target.messageId))}
                </div>
              )}
              {isText&&<div style={{fontSize:11,color:"#0b84ff",marginBottom:4}}>拖选文字即可选择片段，或点击已有高亮片段</div>}
              {/* Settlement: content with inline target tag on first line */}
              {(msg.kind === 'round' || msg.kind === 'round_result') ? (() => {
                const settleTargetId = (msg as any).settlementTargetId as string | undefined;
                const targetMsg = settleTargetId ? msgMap.get(settleTargetId) : undefined;
                const targetContent = targetMsg?.content ?? '';
                const targetPreview = targetContent.length > 40
                  ? targetContent.slice(0, 40) + '…'
                  : targetContent;
                const isValue = (msg as any).roundPayload?.settlementType === 'VALUE';
                const isRound = msg.kind === 'round';
                const tagColor = isValue
                  ? (isRound ? '#fcd34d' : '#f59e0b')
                  : (isRound ? '#a5b4fc' : '#818cf8');
                const lines = (msg.content ?? '').split('\n');
                const firstLine = lines[0];
                const restLines = lines.slice(1).join('\n');
                return (
                  <div ref={el=>{contentRefs.current[msg.id]=el;}} style={{fontSize:13,color:"#f5f5f5"}} onMouseUp={e=>onTextMouseUp(e,msg.id)}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 4, flexWrap: "wrap" }}>
                      <span style={{ whiteSpace: "pre-wrap", fontFamily: "Menlo,Monaco,Consolas,'Courier New',monospace", fontSize: 13 }}>{firstLine}</span>
                      {settleTargetId && (
                        onNavigateToMessage ? (
                          <span
                            onClick={(e) => { e.stopPropagation(); onNavigateToMessage(settleTargetId); }}
                            style={{
                              fontSize: 10, fontWeight: 500, padding: "1px 6px", borderRadius: 4,
                              background: `${tagColor}15`, color: tagColor, border: `1px solid ${tagColor}40`,
                              cursor: "pointer", maxWidth: 240, overflow: "hidden",
                              textOverflow: "ellipsis", whiteSpace: "nowrap",
                            }}
                            title={`点击跳转到目标消息 ${settleTargetId.slice(-6)}${targetContent ? '：' + targetContent : ''}`}
                          >
                            → {settleTargetId.slice(-6)}{targetPreview ? `「${targetPreview}」` : ''}
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, color: "#6b7280", padding: "1px 4px", borderRadius: 3, background: "rgba(107,114,128,0.1)" }}>
                            {settleTargetId.slice(-6)}
                          </span>
                        )
                      )}
                    </div>
                    {restLines && (
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "Menlo,Monaco,Consolas,'Courier New',monospace", fontSize: 13 }}>{restLines}</pre>
                    )}
                  </div>
                );
              })() : (
              <div ref={el=>{contentRefs.current[msg.id]=el;}} style={{fontSize:13,color:"#f5f5f5"}}>
                {msg.parts?.some(part => ['text', 'web', 'code'].includes(part.type))
                  ? msg.parts.filter(part => ['text', 'web', 'code'].includes(part.type)).map(part =>
                    <MessageTextPart key={part.id} message={msg} partId={part.id} activeText={activeTextSelectId === msg.id} onMouseUp={onTextMouseUp}>{renderContent(msg, part.id)}</MessageTextPart>)
                  : <MessageTextPart message={msg} activeText={activeTextSelectId === msg.id} onMouseUp={onTextMouseUp}>{renderContent(msg)}</MessageTextPart>}
              </div>
              )}
              <RelatedMessages rows={relatedByTarget.get(msg.id)} selectedUnits={draftUnits} onNavigate={props.onRelatedMessageNavigate??onNavigateToMessage}/>
              {renderRelatedConnections(msg.id)}
              {renderJoinRecords(msg.id, ['classify','summary','merge','arrange'].includes(msg.relationType ?? ''))}
              {(notifyUsersByRelationMsg.get(msg.id)?.length ?? 0) > 0 && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#67e8f9' }}>
                  通知与会者：
                  {notifyUsersByRelationMsg.get(msg.id)!.map((notifyUser, index) => (
                    <React.Fragment key={notifyUser.id}>
                      {index > 0 && '、'}
                      <span
                        style={{ color: '#a5f3fc' }}
                        title={`通知与会者 ${notifyUser.username}`}
                      >
                        {notifyUser.username}
                      </span>
                    </React.Fragment>
                  ))}
                </div>
              )}
              {/* 加入容器消息：显示容器和目标消息 ID 标签（可点击跳转） */}
              {msg.joinInfo && (() => {
                const { containerId, containerType, targetIds } = msg.joinInfo;
                const containerTypeLabel = containerType === 'CLASSIFY' ? '分类' : containerType === 'SUMMARY' ? '总结' : containerType === 'ARRANGE' ? '排列' : containerType === 'MERGE' ? '归并' : '容器';
                return (
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 10, color: "#9ca3af", flexShrink: 0 }}>容器:</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: "#a78bfa", padding: "1px 4px", borderRadius: 3, background: "rgba(167,139,250,0.15)", flexShrink: 0 }}>{containerTypeLabel}</span>
                      {onNavigateToMessage ? (
                        <span
                            onClick={(e) => { e.stopPropagation(); onNavigateToMessage(containerId); }}
                          style={{ fontSize: 10, fontFamily: "monospace", color: "#93c5fd", cursor: "pointer", padding: "1px 4px", borderRadius: 3, background: "rgba(59,130,246,0.15)", textDecoration: "underline", textUnderlineOffset: 2 }}
                          title={`跳转到 ${containerTypeLabel}消息 ${containerId}`}
                        >{containerId}</span>
                      ) : (
                        <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6b7280", padding: "1px 4px", borderRadius: 3, background: "rgba(107,114,128,0.1)" }}>{containerId}</span>
                      )}
                    </div>
                    {targetIds.length > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 10, color: "#9ca3af", flexShrink: 0 }}>目标:</span>
                        {targetIds.map(tid => (
                          onNavigateToMessage ? (
                            <span
                              key={tid}
                              onClick={(e) => { e.stopPropagation(); onNavigateToMessage(tid); }}
                              style={{ fontSize: 10, fontFamily: "monospace", color: "#93c5fd", cursor: "pointer", padding: "1px 4px", borderRadius: 3, background: "rgba(59,130,246,0.15)", textDecoration: "underline", textUnderlineOffset: 2 }}
                              title={`跳转到消息 ${tid}`}
                            >{tid}</span>
                          ) : (
                            <span key={tid} style={{ fontSize: 10, fontFamily: "monospace", color: "#6b7280", padding: "1px 4px", borderRadius: 3, background: "rgba(107,114,128,0.1)" }}>{tid}</span>
                          )
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })()}</div>)}
      </div>
      {SHOW_SELECTED_ACTUAL_RECTS && Object.entries(selectedActualRects).map(([messageId, rect]) => (
        <div
          key={`actual-rect-${messageId}`}
          data-actual-message-rect={messageId}
          title={`实际矩形：${messageId}（${Math.round(rect.width)} × ${Math.round(rect.height)}）`}
          style={{
            position: 'absolute',
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
            boxSizing: 'border-box',
            border: '2px solid #ff3b30',
            background: 'rgba(255,59,48,0.08)',
            pointerEvents: 'none',
            zIndex: 30,
          }}
        />
      ))}
      {/* Phase 3: Floating settlement panel in graph view */}
      {settlementOpenMsgId && (() => {
        const cardBox = layout[settlementOpenMsgId];
        const gf = groupFrames.find(f => f.relMsgId === settlementOpenMsgId);
        const sf = arrangeFrames.find(f => f.relMsgId === settlementOpenMsgId);
        const box = cardBox || (gf ? { x: gf.rect.x, y: gf.rect.y, width: gf.rect.width, height: gf.rect.height } : null) || (sf ? { x: sf.rect.x, y: sf.rect.y, width: sf.rect.width, height: sf.rect.height } : null);
        if (!box) return null;
        return (
        <div data-settlement-panel style={{
          position: "absolute",
          left: box.x,
          top: box.y + box.height + 8,
          width: 360,
          zIndex: 100,
        }}>
          <SettlementPanel messageId={settlementOpenMsgId} scopeMessageId={scopeMessageId ?? ''} highlightRoundId={sessionStorage.getItem('settlementHighlightRound')} entryHighlight={settlementEntryHighlight} onMessageCreated={onSettlementMessageCreated} filterSettlementType={settlementOpenType ?? undefined} />
          <RoundHistory messageId={settlementOpenMsgId} compact />
        </div>
        );
      })()}
      {/* SVG layer: frame visuals (behind cards, zIndex:0) so cards float above frames.
          Wide arrange frames (spanning multiple columns) no longer visually encompass
          unrelated cards that happen to share the same horizontal range. */}
      {(arrangeFrames.length>0||groupFrames.length>0)&&(
        <svg width={actualCanvasWidth} height={actualCanvasHeight} style={{position:"absolute",left:0,top:0,zIndex:0,pointerEvents:"none"}}>
          {/* arrange frames — stroke and fill reflect selection state; hidden when blank-corrected */}
          {visibleArrangeFrames.map(sf=>{
            if (sf.isBlankCorrected) return null;
            const isWhole=isRelWholeSel(sf.relMsgId);
            return (
              <rect key={`supp-frame-${sf.relMsgId}`} data-jump-visual-msgids={sf.relMsgId} x={sf.rect.x} y={sf.rect.y} width={sf.rect.width} height={sf.rect.height}
                rx={FRAME_RADIUS} ry={FRAME_RADIUS}
                fill={isWhole?"rgba(251,191,36,0.22)":"rgba(130,80,200,0.04)"}
                stroke={isWhole?"rgba(251,191,36,1)":"rgba(130,80,200,0.55)"}
                strokeWidth={isWhole?3:2} strokeDasharray={isWhole?undefined:"5 3"}/>
            );
          })}
          {/* GROUP frames (CLASSIFY/MERGE) and REPLACE-OVERLAY (SUMMARY); hidden when blank-corrected */}
          {visibleGroupFrames.map(gf=>{
            if (gf.isBlankCorrected) return null;
            const isWhole=isRelWholeSel(gf.relMsgId);
            const isReplaceOverlay = gf.relKind === 'replace-overlay';
            const strokeColor = isWhole
              ? 'rgba(251,191,36,1)'
              : (isReplaceOverlay ? (GROUP_FRAME_STROKE[gf.relColor] ?? 'rgba(180,120,0,0.7)') : (GROUP_FRAME_STROKE[gf.relColor] ?? 'rgba(140,140,150,0.55)'));
            const fillColor = isWhole ? 'rgba(251,191,36,0.22)' : isReplaceOverlay ? 'rgba(200,150,0,0.04)' : 'rgba(130,130,140,0.03)';
            return (
              <rect key={`gf-${gf.relMsgId}`} data-jump-visual-msgids={gf.relMsgId} x={gf.rect.x} y={gf.rect.y} width={gf.rect.width} height={gf.rect.height}
                rx={FRAME_RADIUS} ry={FRAME_RADIUS}
                fill={fillColor} stroke={strokeColor}
                strokeWidth={isWhole?3:2} strokeDasharray={isReplaceOverlay?undefined:(isWhole?undefined:"6 3")}/>
            );
          })}
        </svg>
      )}
      {/* SVG layer: edge paths and labels (raised above relation overlays to avoid label clipping/occlusion) */}
      {positionedEdges.length>0&&(
        <svg width={actualCanvasWidth} height={actualCanvasHeight} style={{position:"absolute",left:0,top:0,zIndex:12,pointerEvents:"none"}}>
          {positionedEdges.map(pe=>{
            const {edge,start,ctrl,end,edgeLabelText,labelX,labelY}=pe;
            const path=`M ${start.x} ${start.y} Q ${ctrl.x} ${ctrl.y} ${end.x} ${end.y}`;
            const angle=Math.atan2(end.y-ctrl.y,end.x-ctrl.x),al=7,aa=Math.PI/7;
            const ax1=end.x-al*Math.cos(angle-aa),ay1=end.y-al*Math.sin(angle-aa),ax2=end.x-al*Math.cos(angle+aa),ay2=end.y-al*Math.sin(angle+aa);
            // Phase 5: Stance highlight edge coloring
            const isStanceEdge = stanceHighlight && (
              (edge.relationType === 'agree' || edge.relationType === 'disagree') &&
              edge.to.messageId === stanceHighlight.stanceMsgId &&
              stanceHighlight.evidenceMsgIds.includes(edge.from.messageId)
            );
            const isEvidenceEdge = stanceHighlight && (
              edge.relationType === 'reference' &&
              (edge.relationLabel === '证据' || edge.relationLabel === 'evidence') &&
              stanceHighlight.evidenceMsgIds.includes(edge.from.messageId) &&
              stanceHighlight.evidenceMsgIds.includes(edge.to.messageId)
            );
            const color = isEvidenceEdge
              ? 'rgba(245,158,11,0.95)'  // gold for evidence edges
              : isStanceEdge
                ? (edge.relationType === 'agree' ? 'rgba(34,197,94,0.95)' : 'rgba(239,68,68,0.95)')  // brighter green/red for stance edges
                : edge.relationType === 'annotation' ? 'rgba(255,215,0,0.92)'
                : edge.relationType === 'reference' ? 'rgba(80,180,255,0.92)'
                : edge.relationType === 'reply' ? 'rgba(160,255,140,0.72)'
                : edge.relationType === 'agree' ? 'rgba(2,170,90,0.92)'
                : edge.relationType === 'disagree' ? 'rgba(210,50,50,0.92)'
                : 'rgba(120,120,120,0.72)';
            const edgeStrokeWidth = (isStanceEdge || isEvidenceEdge) ? 2.0 : edge.relationType === 'reply' ? 1.0 : 1.2;
            const relId=edge.relationMessageId,isWhole=isRelWholeSel(relId),isFrag=isEdgeLabelFragSel(relId,edge.id);
            const labelOpacity=isWhole||isFrag?1:edge.relationType==="reply"?0.65:0.9;
            const labelStroke="rgba(0,0,0,0.85)";
            // Blank-corrected: anon-source CORRECT targets a relation message → hide arrow/text, keep bbox for badge
            const isBlankCorrected=anonCorrectedRelMsgIds.has(relId);
            return (
              <g key={pe.drawId} data-jump-visual-msgids={edge.relationMessageId}>
                {!isBlankCorrected&&<path d={path} stroke={color} strokeWidth={edgeStrokeWidth} fill="none" strokeDasharray={isEvidenceEdge?"6 3":undefined}/>}
                {!isBlankCorrected&&<path d={`M ${ax1} ${ay1} L ${end.x} ${end.y} L ${ax2} ${ay2}`} fill={color}/>}
                {/* Text always rendered (opacity 0 when blank) so labelBboxes are stable for badge positioning */}
                {/* Text with stroke for readability against any background */}
                <text ref={el=>{textRefs.current[pe.drawId]=el;}} x={labelX} y={labelY} fill={color} opacity={isBlankCorrected?0:labelOpacity} fontSize={10} textAnchor="middle" dominantBaseline="central" style={{paintOrder:"stroke",stroke:labelStroke,strokeWidth:2} as any}>
                  {edgeLabelText}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {/* Edge label HTML hit areas */}
      {(()=>{
        const corrRendered=new Set<string>();
        const statusRendered=new Set<string>();
        return positionedEdges.map(pe=>{
          const bb=labelBboxes[pe.drawId]; if (!bb) return null;
          const CORR_BADGE_W_EDGE=44;
          const relId=pe.edge.relationMessageId;
          const showStatisticalStatus=!statusRendered.has(relId)&&!visibleNormalIds.includes(relId);
          if(showStatisticalStatus)statusRendered.add(relId);
          // A correction badge is shown either when this relation's edge label has been corrected
          // (correctedRelMsgTargets: R1 is corrected) OR when this relation IS the replacement
          // (correctionSrcByNewRelMsg: R2 replaced R1).
          // For corrInfo: only show the badge if NO specific edge fragments were individually corrected
          // (i.e., the correction is whole-relation, not partial/fragment-level).  When specific edges
          // are marked in correctedEdgeIdsByRelMsg, those edges are already hidden from positionedEdges;
          // the remaining edges are uncorrected fragments and must NOT show the correction badge.
          const corrInfo=correctedRelMsgTargets.get(relId);
          const newCorrInfo=correctionSrcByNewRelMsg.get(relId);
          const hasCorrectedFragments=(correctedEdgeIdsByRelMsg.get(relId)?.size??0)>0;
          const showCorrBadge=((!!corrInfo?.length&&!hasCorrectedFragments)||!!newCorrInfo?.length)&&!corrRendered.has(relId);
          if (showCorrBadge) corrRendered.add(relId);
          const padX=8,padY=6;
          const extraLeft=showCorrBadge?CORR_BADGE_W_EDGE+4:0;
          const box:LayoutBox={x:bb.x-padX-extraLeft,y:bb.y-padY,width:bb.width+padX*2+extraLeft+(showStatisticalStatus?DEC_RIGHT_GAP+EDGE_HINT_W:0),height:bb.height+padY*2};
          const isWhole=isRelWholeSel(relId),isFrag=isEdgeLabelFragSel(relId,pe.edge.id);
          return (
            <div key={`hit-${pe.drawId}`} role="group" tabIndex={0} aria-label={`关系消息 ${relId}`} aria-keyshortcuts="Enter Space Shift+Enter" onKeyDown={activateMessageFromKeyboard} data-msgid={relId} data-jump-msgids={relId} data-rel-overlay="true" onClick={e=>onEdgeLabelSingleClick(e,relId,pe.edge.id)} onDoubleClick={e=>onEdgeLabelDoubleClick(e,relId)}
              style={{position:"absolute",left:box.x,top:box.y,width:box.width,height:box.height,zIndex:13,cursor:"pointer",pointerEvents:"auto",background:isWhole||isFrag?"rgba(91,65,0,0.35)":"transparent",borderRadius:6,border:isWhole||isFrag?"1px solid rgba(251,191,36,0.95)":"1px solid transparent",boxShadow:isWhole||isFrag?"0 1px 4px rgba(251,191,36,0.35)":"none"}}
              title={`relation=${pe.edge.relationMessageId} edge=${pe.edge.id}`}>
              {showStatisticalStatus&&<div style={{position:'absolute',left:extraLeft+padX+bb.width+DEC_RIGHT_GAP,top:'50%',transform:'translateY(-50%)',display:'flex',alignItems:'center',background:'#101010',borderRadius:3}}>
                <MessageDisplayMarker messageId={relId} />
              </div>}
              {showCorrBadge&&(()=>{
                // Prefer newCorrInfo (this relation IS the replacement) over corrInfo (this relation was corrected)
                const corrRelMsgId = newCorrInfo?.length
                  ? newCorrInfo[0].corrRelMsgId
                  : corrInfo?.length ? corrInfo[0].corrRelMsgId : null;
                if (!corrRelMsgId) return null;
                const isCorrSel=isRelWholeSel(corrRelMsgId);
                return (
                  <div key={`corr-edge-${corrRelMsgId}`} data-msgid={corrRelMsgId} data-jump-msgids={corrRelMsgId} data-rel-overlay="true"
                    onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,corrRelMsgId);}}
                    onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,corrRelMsgId);}}
                    title={`更正关系：${corrRelMsgId}；单击选中，双击查看历史`}
                    style={{position:"absolute",left:2,top:"50%",transform:"translateY(-50%)",
                      width:CORR_BADGE_W_EDGE-4,background:isCorrSel?"#fbbf24":"rgba(170,110,0,0.9)",
                      color:isCorrSel?"#111827":"#fff",borderRadius:3,fontSize:9,padding:"0 3px",fontWeight:600,
                      cursor:"pointer",pointerEvents:"auto",
                      border:isCorrSel?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.15)",
                      boxShadow:isCorrSel?"0 1px 4px rgba(251,191,36,0.35)":"none",
                      whiteSpace:"nowrap",userSelect:"none",display:"flex",alignItems:"center",
                      justifyContent:"center",boxSizing:"border-box" as const}}>
                    ✏更正
                  </div>
                );
              })()}
            </div>
          );
        });
      })()}

      {/* Edge-label relation decoration badges — AGREE/DISAGREE + TAG badges on annotation/reference/reply
          relations, with collapsible vote columns to the RIGHT of the status marker. */}
      {(()=>{
        const rendered=new Set<string>();
        const items: React.ReactNode[]=[];
        for (const pe of positionedEdges) {
          // Only annotation / reference / reply carry edge-label decorations
          const rt=pe.edge.relationType;
          if (rt!=="annotation"&&rt!=="reference"&&rt!=="reply") continue;
          const bb=labelBboxes[pe.drawId]; if (!bb) continue;
          const relId=pe.edge.relationMessageId;
          if (rendered.has(relId)) continue;
          const dec=relDecByRelMsgState.get(relId);
          const tagItems=tagsByRelMsgState.get(relId)??[];
          if ((!dec||(dec.agreeCount===0&&dec.disagreeCount===0))&&tagItems.length===0) continue;
          rendered.add(relId);
          const rowLeft=getEdgeDecorationLeft(bb,!visibleNormalIds.includes(relId));
          const decLeft=rowLeft+EDGE_HINT_W+DEC_GAP;
          const voteCount=((dec?.agreeCount??0)>0?1:0)+((dec?.disagreeCount??0)>0?1:0);
          const expanded=visibleDecorationIds.has(relId);
          const stackHeight=voteCount*DEC_H+Math.max(0,voteCount-1)*DEC_GAP;
          let decTop=bb.y+bb.height/2-stackHeight/2;
          if(voteCount>0)items.push(<React.Fragment key={`reldec-toggle-${relId}`}>
            {renderDecorationToggle(relId,{position:'absolute',left:rowLeft,top:bb.y+(bb.height-EDGE_HINT_W)/2,zIndex:15})}
          </React.Fragment>);
          for (const kind of ["agree","disagree"] as const) {
            if(!expanded)continue;
            const count=kind==="agree"?dec?.agreeCount??0:dec?.disagreeCount??0;
            if (count<=0) continue;
            const isSelected=isDecorationSelected(relId,kind);
            const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
            const icon=kind==="agree"?"👍":"👎";
            const label=kind==="agree"?"赞":"反";
            items.push(
              <div key={`reldec-${kind}-${relId}`} data-msgid={relId}
                data-jump-msgids={(kind==='agree'?dec?.agreeRelMsgIds:dec?.disagreeRelMsgIds)?.join(' ')} data-rel-overlay="true"
                onClick={ev=>{ev.stopPropagation();}}
                onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,relId,kind);}}
                title={`${kind==="agree"?"赞同":"反对"}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
                style={{position:"absolute",left:decLeft,top:decTop,width:DEC_W,height:DEC_H,zIndex:14,
                  background:isSelected?"#fbbf24":bgColor,color:isSelected?"#111827":"#fff",borderRadius:4,display:"flex",alignItems:"center",
                  fontSize:11,pointerEvents:"auto",boxShadow:isSelected?"0 2px 6px rgba(0,0,0,0.5)":"0 2px 6px rgba(0,0,0,0.5)",border:isSelected?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.08)",
                  overflow:"hidden"}}>
                <div onClick={ev=>{ev.stopPropagation();onDecorationIconClick?.(relId,kind);}}
                  style={{width:DEC_ICON_W,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                    cursor:"pointer",flexShrink:0,background:"rgba(0,0,0,0.15)",fontSize:12}}
                  title={`点击：快速发送${kind==="agree"?"赞同":"反对"}`}>{icon}</div>
                <div onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,relId,kind);}}
                  style={{flex:1,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:2,cursor:"pointer"}}>
                  <span style={{fontWeight:700}}>{count}</span>
                  <span style={{fontSize:9,opacity:0.85}}>{label}</span>
                </div>
              </div>
            );
            decTop+=DEC_H+DEC_GAP;
          }
          let voteWidth=voteCount>0?getDecorationColumnWidth(expanded):0;
          for(const ci of correctionSrcByNewRelMsg.get(relId)??[]){
            const correctionDec=relDecByRelMsgState.get(ci.corrRelMsgId);
            const count=((correctionDec?.agreeCount??0)>0?1:0)+((correctionDec?.disagreeCount??0)>0?1:0);
            if(count>0)voteWidth+=getDecorationColumnWidth(visibleDecorationIds.has(ci.corrRelMsgId))+DEC_GAP;
          }
          const annotation=getAnnotationPlacement({x:rowLeft-DEC_RIGHT_GAP,y:bb.y,width:0,height:bb.height},voteWidth);
          if(tagItems.length>0)items.push(<React.Fragment key={`reltag-toggle-${relId}`}>
            {renderDecorationToggle(relId,{position:'absolute',left:annotation.toggle.x,top:annotation.toggle.y,zIndex:15},true)}
          </React.Fragment>);
          decTop=annotation.y;
          // TAG badges on this relation message — aggregated by label text
          const tagGroupMap=new Map<string,{label:string;relMsgIds:string[]}>();
          for (const {label:itemLabel,relMsgId:tagRelMsgId} of tagItems) {
            const existing=tagGroupMap.get(itemLabel);
            if (existing) { existing.relMsgIds.push(tagRelMsgId); }
            else { tagGroupMap.set(itemLabel,{label:itemLabel,relMsgIds:[tagRelMsgId]}); }
          }
          for (const {label:tagLabel,relMsgIds} of tagGroupMap.values()) {
            if(!visibleAnnotationIds.has(relId))continue;
            const count=relMsgIds.length;
            const displayLabel=count>1?`${tagLabel}（${count}人）`:tagLabel;
            const tagW=Math.max(TAG_MIN_W,displayLabel.length*8+8+28);
            items.push(
              <div key={`reltag-${relMsgIds[0]}`} data-msgid={relId} data-jump-msgids={[relId, ...relMsgIds].join(' ')} data-rel-overlay="true"
                onClick={ev=>{ev.stopPropagation();onTagBodyClick?.(ev,relId,tagLabel,relMsgIds);}}
                onDoubleClick={ev=>{ev.stopPropagation();onTagDoubleClick?.(ev,relId,tagLabel,relMsgIds);}}
                title={`标注：${displayLabel}；单击选中，双击展开详情`}
                style={{position:"absolute",left:annotation.x-TAG_HIT_PAD_X,top:decTop-TAG_HIT_PAD,
                  width:tagW+2*TAG_HIT_PAD_X,height:TAG_H+2*TAG_HIT_PAD,
                  zIndex:14,cursor:"pointer",pointerEvents:"auto",background:"transparent",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  padding:`${TAG_HIT_PAD}px ${TAG_HIT_PAD_X}px`,boxSizing:"border-box"}}>
                <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",
                  width:tagW,height:TAG_H,boxSizing:"border-box",
                  background:"rgba(180,150,0,0.85)",color:"#fff",borderRadius:3,
                  fontSize:10,padding:"0 4px",boxShadow:"0 1px 4px rgba(0,0,0,0.4)",
                  border:"1px solid rgba(255,255,255,0.15)",
                  whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  🏷{displayLabel}
                </span>
              </div>
            );
            decTop+=TAG_H+TAG_V_GAP;
          }
        }
        return items;
      })()}

      {/* Correction-badge AGREE/DISAGREE decoration badges — shown to the RIGHT of the edge label
          for the replacement relation (R2) that carries a correction badge (✏更正).
          These decorations target the CORRECT relation message (R_correct) itself, shown next to
          the correction badge consistent with how text-message correction decorations are displayed. */}
      {(()=>{
        const corrDecRendered=new Set<string>();
        const items: React.ReactNode[]=[];
        for (const pe of positionedEdges) {
          const relId=pe.edge.relationMessageId;
          const bb=labelBboxes[pe.drawId]; if (!bb) continue;
          // Only process edge labels that ARE the replacement (correctionSrcByNewRelMsg maps R2 → correction info)
          const newCorrInfo=correctionSrcByNewRelMsg.get(relId);
          if (!newCorrInfo?.length) continue;
          if (corrDecRendered.has(relId)) continue;
          corrDecRendered.add(relId);
          // Keep each correction's votes in its own collapsible column.
          const r2Dec=relDecByRelMsgState.get(relId);
          const hasR2Votes=['annotation','reference','reply'].includes(pe.edge.relationType);
          const r2Count=hasR2Votes?((r2Dec?.agreeCount??0)>0?1:0)+((r2Dec?.disagreeCount??0)>0?1:0):0;
          let columnLeft=getEdgeDecorationLeft(bb,!visibleNormalIds.includes(relId))
            +(r2Count>0?getDecorationColumnWidth(visibleDecorationIds.has(relId))+DEC_GAP:0);
          for (const ci of newCorrInfo) {
            const dec=relDecByRelMsgState.get(ci.corrRelMsgId);
            if (!dec||(dec.agreeCount===0&&dec.disagreeCount===0)) continue;
            const expanded=visibleDecorationIds.has(ci.corrRelMsgId);
            items.push(<React.Fragment key={`corr-reldec-toggle-${ci.corrRelMsgId}`}>
              {renderDecorationToggle(ci.corrRelMsgId,{position:'absolute',left:columnLeft,top:bb.y+(bb.height-EDGE_HINT_W)/2,zIndex:15})}
            </React.Fragment>);
            const decLeft=columnLeft+EDGE_HINT_W+DEC_GAP;
            const count=(dec.agreeCount>0?1:0)+(dec.disagreeCount>0?1:0);
            let decTop=bb.y+bb.height/2-(count*DEC_H+(count-1)*DEC_GAP)/2;
            columnLeft+=getDecorationColumnWidth(expanded)+DEC_GAP;
            for (const kind of ["agree","disagree"] as const) {
              if(!expanded)continue;
              const count=kind==="agree"?dec.agreeCount:dec.disagreeCount;
              if (count<=0) continue;
              const isSelected=isDecorationSelected(ci.corrRelMsgId,kind);
              const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
              const icon=kind==="agree"?"👍":"👎";
              const label=kind==="agree"?"赞":"反";
              items.push(
                <div key={`corr-reldec-${kind}-${ci.corrRelMsgId}`} data-msgid={ci.corrRelMsgId}
                  data-jump-msgids={(kind==='agree'?dec.agreeRelMsgIds:dec.disagreeRelMsgIds).join(' ')} data-rel-overlay="true"
                  onClick={ev=>{ev.stopPropagation();}}
                  onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,ci.corrRelMsgId,kind);}}
                  title={`${kind==="agree"?"赞同":"反对"}更正：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
                  style={{position:"absolute",left:decLeft,top:decTop,width:DEC_W,height:DEC_H,zIndex:14,
                    background:isSelected?"#fbbf24":bgColor,color:isSelected?"#111827":"#fff",borderRadius:4,display:"flex",alignItems:"center",
                    fontSize:11,pointerEvents:"auto",boxShadow:isSelected?"0 2px 6px rgba(251,191,36,0.35)":"0 2px 6px rgba(0,0,0,0.5)",border:isSelected?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.08)",
                    overflow:"hidden"}}>
                  <div onClick={ev=>{ev.stopPropagation();onDecorationIconClick?.(ci.corrRelMsgId,kind);}}
                    style={{width:DEC_ICON_W,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                      cursor:"pointer",flexShrink:0,background:"rgba(0,0,0,0.15)",fontSize:12}}
                    title={`点击：快速发送${kind==="agree"?"赞同":"反对"}`}>{icon}</div>
                  <div onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,ci.corrRelMsgId,kind);}}
                    style={{flex:1,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:2,cursor:"pointer"}}>
                    <span style={{fontWeight:700}}>{count}</span>
                    <span style={{fontSize:9,opacity:0.85}}>{label}</span>
                  </div>
                </div>
              );
              decTop+=DEC_H+DEC_GAP;
            }
          }
        }
        return items;
      })()}

      {/* arrange frame border-strip hit areas — 4 thin divs at zIndex:4 covering the frame border,
          one strip per side.  Each strip is FRAME_PAD wide (half inside, half outside the rect),
          so it exactly covers the padding zone between the visible SVG border and the message cards.
          arrange relation messages are treated as first-class messages: single-click toggles whole
          selection (like a normal message card), double-click uses the message double-click handler.
          When isBlankCorrected, the frame border is invisible so border strips are omitted; only the
          correction badge is rendered so users can interact with the correction. */}
      {visibleArrangeFrames.map(sf=>{
        const handleClick=(e: React.MouseEvent)=>{e.stopPropagation();onMessageClick(e,sf.relMsgId);};
        const handleDblClick=(e: React.MouseEvent)=>{e.stopPropagation();onMessageDoubleClick(e,sf.relMsgId);};
        const {x,y,width,height}=sf.rect;
        const HH=FRAME_PAD;
        // Nested frames need higher zIndex so clicks hit inner frame before outer
        const frameZ = 4 + (frameDepthMap.get(sf.relMsgId) ?? 0);
        const stripBase: React.CSSProperties={position:"absolute",zIndex:frameZ,cursor:"pointer",pointerEvents:"auto",background:"transparent"};
        const title=`排列关系：${sf.relMsgId}；单击选中，双击展开详情`;
        const sfCorrInfo=correctedRelMsgTargets.get(sf.relMsgId);
        const cardHeaderRect = getMergeCardHeaderRect(sf.rect);
        return (
          <React.Fragment key={`supp-hit-${sf.relMsgId}`}>
            {/* Border strips — omitted when blank-corrected (no visible frame border) */}
            {!sf.isBlankCorrected&&<>
              {/* Top strip — full width including corners */}
              <div data-msgid={sf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y-HH,width:width+HH*2,height:HH*2}}/>
              {/* Bottom strip — full width including corners */}
              <div data-msgid={sf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y+height-HH,width:width+HH*2,height:HH*2}}/>
              {/* Left strip — between top and bottom strips */}
              <div data-msgid={sf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y+HH,width:HH*2,height:height-HH*2}}/>
              {/* Right strip — between top and bottom strips */}
              <div data-msgid={sf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x+width-HH,top:y+HH,width:HH*2,height:height-HH*2}}/>
            </>}
            {!sf.isBlankCorrected && <button type="button" data-arrange-card-toggle={sf.relMsgId}
              aria-label={`${cardFrameIds.has(sf.relMsgId) ? '收起' : '显示'}排列消息卡 ${sf.relMsgId}`}
              aria-expanded={cardFrameIds.has(sf.relMsgId)} title={`${cardFrameIds.has(sf.relMsgId) ? '收起' : '显示'}排列消息卡`}
              onMouseDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
              onClick={event => { event.stopPropagation(); setExpandedFrameIds(previous => previous.includes(sf.relMsgId)
                ? previous.filter(id => id !== sf.relMsgId) : [...previous, sf.relMsgId]); }}
              style={{position:'absolute',left:x+(sfCorrInfo?100:8),top:y-HH+1,zIndex:frameZ+2,
                height:16,padding:'0 6px',border:'1px solid rgba(167,139,250,0.4)',borderRadius:4,
                background:'#171324',color:'#c4b5fd',fontSize:10,cursor:'pointer',pointerEvents:'auto'}}>
              {cardFrameIds.has(sf.relMsgId) ? '▾' : '▸'}
            </button>}
            {!cardFrameIds.has(sf.relMsgId) && <div data-rel-overlay="true"
              style={{position:'absolute',left:x+(sfCorrInfo?100:8)+26,top:y-HH+1,zIndex:frameZ+2,pointerEvents:'auto',background:'#101010',display:'flex',alignItems:'center',gap:6}}>
              <MessageDisplayMarker messageId={sf.relMsgId} />
              {relatedConnections?.has(sf.relMsgId) && <div data-msgid={sf.relMsgId} data-rel-overlay="true">
                {renderRelatedConnections(sf.relMsgId)}
              </div>}
            </div>}
            {cardFrameIds.has(sf.relMsgId) && virtual.mounted.has(sf.relMsgId) && <div data-msgid={sf.relMsgId} data-rel-overlay="true" data-frame-header="true"
              data-measure-min-height={MERGE_CARD_H} ref={el => { cardRefs.current[sf.relMsgId] = el; }}
              role="group" tabIndex={0} aria-label={`组织消息 ${sf.relMsgId}`} aria-keyshortcuts="Enter Space Shift+Enter"
              onKeyDown={activateMessageFromKeyboard} onClick={handleClick} onDoubleClick={handleDblClick} title={title}
              style={{ position: 'absolute', left: cardHeaderRect.x, top: cardHeaderRect.y, width: cardHeaderRect.width, minHeight: cardHeaderRect.height,
                zIndex: frameZ + 1, cursor: 'pointer', pointerEvents: 'auto', userSelect: 'none', boxSizing: 'border-box',
                color: '#f5f5f5', borderRadius: 6, padding: '4px 10px',
                background: isRelWholeSel(sf.relMsgId) ? 'rgba(91,65,0,0.55)' : '#1f1f1f',
                border: isRelWholeSel(sf.relMsgId) ? '2px solid #fbbf24' : lastClickedMessageId === sf.relMsgId ? '1px solid rgba(56,189,248,0.8)' : '1px solid #444',
                outline: lastClickedMessageId === sf.relMsgId ? '1px dashed #0b84ff' : 'none',
                boxShadow: '0 6px 14px rgba(0,0,0,0.35)' }}>
              <OrganizationFrameHeader message={msgMap.get(sf.relMsgId)} messageId={sf.relMsgId} kind="arrange"
                joinBadges={renderJoinRecords(sf.relMsgId,true,true)}
                memberCount={new Set((edgesByRelMsg.get(sf.relMsgId) ?? []).filter(edge => !edge.to.messageId.startsWith('anon:')).map(edge => edge.to.messageId)).size}
                selectedUnits={draftUnits} activeText={activeTextSelectId === sf.relMsgId} onTextMouseUp={onTextMouseUp}
                counts={stakeCounts?.[sf.relMsgId]} openMessageId={settlementOpenMsgId} openType={settlementOpenType}
                onTruth={onSettlementToggleTruth} onValue={onSettlementToggleValue} />
              {renderRelatedConnections(sf.relMsgId)}
            </div>}
            {/* Correction badge — embedded in frame top border when this arrange is a CORRECT target */}
            {sfCorrInfo&&(()=>{
              const ci=sfCorrInfo[0];
              const isCorrSel=isRelWholeSel(ci.corrRelMsgId);
              return (
                <div key={`corr-supp-${ci.corrRelMsgId}`} data-jump-visual-msgids={`${sf.relMsgId} ${ci.corrRelMsgId}`} data-rel-overlay="true"
                  onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,ci.corrRelMsgId);}}
                  onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,ci.corrRelMsgId);}}
                  title={`更正关系：${ci.corrRelMsgId}；单击选中，双击查看历史`}
                  style={{position:"absolute",left:x+4,top:y-HH+1,zIndex:5,
                    background:isCorrSel?"#fbbf24":"rgba(170,110,0,0.9)",
                    color:isCorrSel?"#111827":"#fff",borderRadius:3,fontSize:9,padding:"0 4px",fontWeight:600,
                    cursor:"pointer",pointerEvents:"auto",
                    border:isCorrSel?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.15)",
                    boxShadow:isCorrSel?"0 1px 4px rgba(251,191,36,0.35)":"none",
                    whiteSpace:"nowrap",userSelect:"none",
                    height:HH*2-2,display:"flex",alignItems:"center"}}>
                  ✏更正
                </div>
              );
            })()}
          </React.Fragment>
        );
      })}

      {/* GROUP frame hit strips (CLASSIFY/MERGE/CORRECT/SUMMARY) */}
      {visibleGroupFrames.map(gf=>{
        const handleClick=(e: React.MouseEvent)=>{e.stopPropagation();(onGroupFrameClick??onMessageClick)(e,gf.relMsgId);};
        const handleDblClick=(e: React.MouseEvent)=>{e.stopPropagation();(onGroupFrameDoubleClick??onMessageDoubleClick)(e,gf.relMsgId);};
        const {x,y,width,height}=gf.rect;
        const HH=FRAME_PAD;
        const groupHeaderRect = getGroupHeaderRect(gf.rect, getGroupHeaderHeight(measuredHeights, gf.relMsgId));
        const gfZ = 4 + (frameDepthMap.get(gf.relMsgId) ?? 0);
        const isSummaryHeader = gf.relType === "summary";
        const headerKindColor = isSummaryHeader ? "#34d399" : "#a78bfa";
        const stripBase: React.CSSProperties={position:"absolute",zIndex:gfZ,cursor:"pointer",pointerEvents:"auto",background:"transparent"};
        const title=(gf.relType === "classify" || gf.relType === "summary")
          ? `${gf.relType === "summary" ? "总结" : "分类"}：${gf.relMsgId}；单击选中，双击进入${gf.relType === "summary" ? "总结" : "分类"}`
          : `${gf.relLabel}关系：${gf.relMsgId}；单击选中，双击展开详情`;
        const gfCorrInfo=correctedRelMsgTargets.get(gf.relMsgId);
        return (
          <React.Fragment key={`gf-hit-${gf.relMsgId}`}>
            {/* Border strips — omitted when blank-corrected (no visible frame border) */}
            {!gf.isBlankCorrected&&<>
              <div data-msgid={gf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y-HH,width:width+HH*2,height:HH*2}}/>
              <div data-msgid={gf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y+height-HH,width:width+HH*2,height:HH*2}}/>
              <div data-msgid={gf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y+HH,width:HH*2,height:height-HH*2}}/>
              <div data-msgid={gf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x+width-HH,top:y+HH,width:HH*2,height:height-HH*2}}/>
            </>}
            {/* Correction badge — embedded in frame top border when this group frame is a CORRECT target */}
            {gfCorrInfo&&(()=>{
              const ci=gfCorrInfo[0];
              const isCorrSel=isRelWholeSel(ci.corrRelMsgId);
              return (
                <div key={`corr-gf-${ci.corrRelMsgId}`} data-jump-visual-msgids={`${gf.relMsgId} ${ci.corrRelMsgId}`} data-rel-overlay="true"
                  onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,ci.corrRelMsgId);}}
                  onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,ci.corrRelMsgId);}}
                  title={`更正关系：${ci.corrRelMsgId}；单击选中，双击查看历史`}
                  style={{position:"absolute",left:x+4,top:y-HH+1,zIndex:5,
                    background:isCorrSel?"#fbbf24":"rgba(170,110,0,0.9)",
                    color:isCorrSel?"#111827":"#fff",borderRadius:3,fontSize:9,padding:"0 4px",fontWeight:600,
                    cursor:"pointer",pointerEvents:"auto",
                    border:isCorrSel?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.15)",
                    boxShadow:isCorrSel?"0 1px 4px rgba(251,191,36,0.35)":"none",
                    whiteSpace:"nowrap",userSelect:"none",
                    height:HH*2-2,display:"flex",alignItems:"center"}}>
                  ✏更正
                </div>
              );
            })()}
            {virtual.mounted.has(gf.relMsgId) && (gf.relType === "classify" || gf.relType === "summary" || gf.relType === "merge") && (
              <div data-msgid={gf.relMsgId} data-rel-overlay="true" data-frame-header="true"
                data-measure-min-height={gf.relType === 'merge' ? MERGE_CARD_H : GROUP_HEADER_HEIGHT}
                ref={el => { cardRefs.current[gf.relMsgId] = el; }}
                role="group" tabIndex={0} aria-label={`组织消息 ${gf.relMsgId}`} aria-keyshortcuts="Enter Space Shift+Enter" onKeyDown={activateMessageFromKeyboard}
                onClick={handleClick}
                onDoubleClick={handleDblClick}
                title={title}
                style={{
                  ...(gf.relType === "merge"
                    ? (() => {
                        const mergeCardHeaderRect = getMergeCardHeaderRect(gf.rect);
                        return {
                          left: mergeCardHeaderRect.x,
                          top: mergeCardHeaderRect.y,
                          width: mergeCardHeaderRect.width,
                          minHeight: mergeCardHeaderRect.height,
                          color: "#f5f5f5",
                          borderRadius: 6,
                          background: isRelWholeSel(gf.relMsgId) ? "rgba(91,65,0,0.55)" : "#1f1f1f",
                          border: isRelWholeSel(gf.relMsgId) ? "2px solid #fbbf24" : (lastClickedMessageId===gf.relMsgId ? "1px solid rgba(56,189,248,0.8)" : "1px solid #444"),
                          boxShadow: isRelWholeSel(gf.relMsgId) ? "0 8px 20px rgba(251,191,36,0.28)" : (lastClickedMessageId===gf.relMsgId ? "0 6px 16px rgba(56,189,248,0.14)" : "0 6px 14px rgba(0,0,0,0.35)"),
                          outline: lastClickedMessageId===gf.relMsgId ? "1px dashed #0b84ff" : "none",
                          padding: "4px 10px",
                        } as React.CSSProperties;
                      })()
                    : {
                        left: groupHeaderRect.x,
                        top: groupHeaderRect.y,
                        width: groupHeaderRect.width,
                        minHeight: GROUP_HEADER_HEIGHT,
                        background: isRelWholeSel(gf.relMsgId) ? "#5b4100" : isSummaryHeader ? "rgba(52,211,153,0.08)" : "#1f1f1f",
                        color: "#f5f5f5",
                        borderRadius: 6,
                        borderTop: isRelWholeSel(gf.relMsgId) ? "2px solid #fbbf24" : lastClickedMessageId===gf.relMsgId ? "1px solid rgba(56,189,248,0.8)" : "1px solid #444",
                        borderRight: isRelWholeSel(gf.relMsgId) ? "2px solid #fbbf24" : lastClickedMessageId===gf.relMsgId ? "1px solid rgba(56,189,248,0.8)" : "1px solid #444",
                        borderBottom: isRelWholeSel(gf.relMsgId) ? "2px solid #fbbf24" : lastClickedMessageId===gf.relMsgId ? "1px solid rgba(56,189,248,0.8)" : "1px solid #444",
                        borderLeft: isRelWholeSel(gf.relMsgId) ? "2px solid #fbbf24" : lastClickedMessageId===gf.relMsgId ? "1px solid rgba(56,189,248,0.8)" : `3px solid ${headerKindColor}`,
                        boxShadow: isRelWholeSel(gf.relMsgId) ? "0 8px 20px rgba(251,191,36,0.28)" : (lastClickedMessageId===gf.relMsgId ? "0 6px 16px rgba(56,189,248,0.14)" : "0 4px 10px rgba(0,0,0,0.5)"),
                        outline: lastClickedMessageId===gf.relMsgId ? "1px dashed #0b84ff" : "none",
                        padding: "12px 16px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }),
                  position: "absolute",
                  zIndex: 5,
                  cursor: "pointer",
                  pointerEvents: "auto",
                  userSelect: "none",
                  boxSizing: "border-box",
                }}>
                <OrganizationFrameHeader message={msgMap.get(gf.relMsgId)} messageId={gf.relMsgId} kind={gf.relType} joinBadges={renderJoinRecords(gf.relMsgId,true,true)}
                  correctionRecords={renderCorrectionRecords(gf.relMsgId)}
                  memberCount={new Set((edgesByRelMsg.get(gf.relMsgId) ?? []).filter(edge => !edge.to.messageId.startsWith('anon:')).map(edge => edge.to.messageId)).size}
                  selectedUnits={draftUnits} activeText={activeTextSelectId === gf.relMsgId} onTextMouseUp={onTextMouseUp}
                  counts={stakeCounts?.[gf.relMsgId]} openMessageId={settlementOpenMsgId} openType={settlementOpenType}
                  onTruth={onSettlementToggleTruth} onValue={onSettlementToggleValue} />
                {renderRelatedConnections(gf.relMsgId)}
              </div>
            )}
          </React.Fragment>
        );
      })}

      {/* arrange frame decoration badges — full-size AGREE/DISAGREE badges to the RIGHT of the frame,
          styled and interactive identically to text-message decoration badges.
          Icon area: quick-send agree/disagree targeting the arrange relation message.
          Body area: toggle selection of all agree/disagree relation messages on this arrange. */}
      {visibleArrangeFrames.map(sf=>{
        const sfDecLeft=sf.rect.x+sf.rect.width+DEC_RIGHT_GAP;
        let sfDecTop=sf.rect.y+DEC_RIGHT_TOP;
        const nodes: React.ReactNode[]=[];
        // Shown cards keep an arbitration entry even when offscreen.
        if (onSettlementToggleTruth && cardFrameIds.has(sf.relMsgId) && !virtual.mounted.has(sf.relMsgId)) {
          const sc = stakeCounts?.[sf.relMsgId];
          const truthPro = sc?.truth.pro ?? 0;
          const truthCon = sc?.truth.con ?? 0;
          const valuePro = sc?.value.pro ?? 0;
          const valueCon = sc?.value.con ?? 0;
          nodes.push(
            <div key={`sf-settle-${sf.relMsgId}`} data-jump-visual-msgids={sf.relMsgId} data-rel-overlay="true"
              style={{position:"absolute",left:sfDecLeft,top:sfDecTop,zIndex:7,
                display:"flex",gap:4,alignItems:"center",pointerEvents:"auto"}}>
              {(truthPro > 0 || truthCon > 0) && <span style={{fontSize:10}}><span style={{color:"#a5b4fc"}}>⚖️</span>{truthPro > 0 && <span style={{color:"#4ade80"}}>👍{truthPro}</span>}{truthCon > 0 && <span style={{color:"#f87171"}}>👎{truthCon}</span>}</span>}
              {(valuePro > 0 || valueCon > 0) && <span style={{fontSize:10}}><span style={{color:"#fcd34d"}}>💎</span>{valuePro > 0 && <span style={{color:"#4ade80"}}>👍{valuePro}</span>}{valueCon > 0 && <span style={{color:"#f87171"}}>👎{valueCon}</span>}</span>}
              <button
                onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new Event('guide-settlement-opened')); onSettlementToggleTruth(sf.relMsgId); }}
                data-guide-settlement-entry="true" data-guide-target-message={sf.relMsgId}
                style={{ fontSize: 13, cursor: "pointer", background: settlementOpenMsgId === sf.relMsgId && settlementOpenType === 'TRUTH' ? "rgba(99,102,241,0.2)" : "none", border: settlementOpenMsgId === sf.relMsgId && settlementOpenType === 'TRUTH' ? "1px solid #6366f1" : "1px solid transparent", borderRadius: 4, padding: "0 3px", color: settlementOpenMsgId === sf.relMsgId && settlementOpenType === 'TRUTH' ? "#a5b4fc" : "#6b7280", lineHeight: 1 }}
                title="真假仲裁"
              >⚖️</button>
              {onSettlementToggleValue && (
                <button
                  onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new Event('guide-settlement-opened')); onSettlementToggleValue(sf.relMsgId); }}
                  data-guide-settlement-entry="true" data-guide-target-message={sf.relMsgId}
                  style={{ fontSize: 13, cursor: "pointer", background: settlementOpenMsgId === sf.relMsgId && settlementOpenType === 'VALUE' ? "rgba(245,158,11,0.2)" : "none", border: settlementOpenMsgId === sf.relMsgId && settlementOpenType === 'VALUE' ? "1px solid #f59e0b" : "1px solid transparent", borderRadius: 4, padding: "0 3px", color: settlementOpenMsgId === sf.relMsgId && settlementOpenType === 'VALUE' ? "#fcd34d" : "#6b7280", lineHeight: 1 }}
                  title="价值仲裁"
                >💎</button>
              )}
            </div>
          );
          sfDecTop += DEC_H + DEC_GAP;
        }
        if(sf.relAgreeCount>0||sf.relDisagreeCount>0){
          nodes.push(<React.Fragment key={`sf-vote-toggle-${sf.relMsgId}`}>
            {renderDecorationToggle(sf.relMsgId,{position:'absolute',left:sfDecLeft,top:sfDecTop,zIndex:8})}
          </React.Fragment>);
        }
        for (const kind of ["agree","disagree"] as const) {
          if (!visibleDecorationIds.has(sf.relMsgId)) continue;
          const count=kind==="agree"?sf.relAgreeCount:sf.relDisagreeCount;
          if (count<=0) continue;
          const isSelected=isDecorationSelected(sf.relMsgId,kind);
          const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
          const icon=kind==="agree"?"👍":"👎";
          const label=kind==="agree"?"赞":"反";
          nodes.push(
            <div key={`sf-${kind}-${sf.relMsgId}`} data-msgid={sf.relMsgId}
              data-jump-msgids={(kind === 'agree' ? sf.relAgreeMsgIds : sf.relDisagreeMsgIds).join(' ')} data-rel-overlay="true"
              onClick={ev=>{ev.stopPropagation();}}
              onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,sf.relMsgId,kind);}}
              title={`${kind==="agree"?"赞同":"反对"}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
              style={{position:"absolute",left:sfDecLeft+EDGE_HINT_W+DEC_GAP,top:sfDecTop,width:DEC_W,height:DEC_H,zIndex:7,
                background:isSelected?"#fbbf24":bgColor,color:isSelected?"#111827":"#fff",borderRadius:4,display:"flex",alignItems:"center",
                fontSize:11,pointerEvents:"auto",boxShadow:isSelected?"0 2px 6px rgba(0,0,0,0.5)":"0 2px 6px rgba(0,0,0,0.5)",border:isSelected?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.08)",
                overflow:"hidden"}}>
              <div onClick={ev=>{ev.stopPropagation();onDecorationIconClick?.(sf.relMsgId,kind);}}
                style={{width:DEC_ICON_W,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                  cursor:"pointer",flexShrink:0,background:"rgba(0,0,0,0.15)",fontSize:12}}
                title={`点击：快速发送${kind==="agree"?"赞同":"反对"}`}>{icon}</div>
              <div onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,sf.relMsgId,kind);}}
                style={{flex:1,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:2,cursor:"pointer"}}>
                <span style={{fontWeight:700}}>{count}</span>
                <span style={{fontSize:9,opacity:0.85}}>{label}</span>
              </div>
            </div>
          );
          sfDecTop+=DEC_H+DEC_GAP;
        }
        return <React.Fragment key={`supp-dec-${sf.relMsgId}`}>{nodes}</React.Fragment>;
      })}

      {/* GROUP frame decoration badges — AGREE/DISAGREE badges to the RIGHT of the group frame */}
      {visibleGroupFrames.map(gf=>{
        if (gf.relAgreeCount===0&&gf.relDisagreeCount===0) return null;
        const gfDecLeft=gf.rect.x+gf.rect.width+DEC_RIGHT_GAP;
        let gfDecTop=gf.rect.y+DEC_RIGHT_TOP;
        const nodes: React.ReactNode[]=[renderDecorationToggle(gf.relMsgId,{position:'absolute',left:gfDecLeft,top:gfDecTop,zIndex:8})];
        for (const kind of ["agree","disagree"] as const) {
          if(!visibleDecorationIds.has(gf.relMsgId))continue;
          const count=kind==="agree"?gf.relAgreeCount:gf.relDisagreeCount;
          if (count<=0) continue;
          const isSelected=isDecorationSelected(gf.relMsgId,kind);
          const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
          const icon=kind==="agree"?"👍":"👎";
          const label=kind==="agree"?"赞":"反";
          nodes.push(
            <div key={`gf-${kind}-${gf.relMsgId}`} data-msgid={gf.relMsgId}
              data-jump-msgids={(kind==='agree'?gf.relAgreeMsgIds:gf.relDisagreeMsgIds).join(' ')} data-jump-visual-msgids={gf.relMsgId} data-rel-overlay="true"
              onClick={ev=>{ev.stopPropagation();}}
              onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,gf.relMsgId,kind);}}
              title={`${kind==="agree"?"赞同":"反对"}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
              style={{position:"absolute",left:gfDecLeft+EDGE_HINT_W+DEC_GAP,top:gfDecTop,width:DEC_W,height:DEC_H,zIndex:7,
                background:isSelected?"#fbbf24":bgColor,color:isSelected?"#111827":"#fff",borderRadius:4,display:"flex",alignItems:"center",
                fontSize:11,pointerEvents:"auto",boxShadow:isSelected?"0 2px 6px rgba(0,0,0,0.5)":"0 2px 6px rgba(0,0,0,0.5)",border:isSelected?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.08)",
                overflow:"hidden"}}>
              <div onClick={ev=>{ev.stopPropagation();onDecorationIconClick?.(gf.relMsgId,kind);}}
                style={{width:DEC_ICON_W,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                  cursor:"pointer",flexShrink:0,background:"rgba(0,0,0,0.15)",fontSize:12}}
                title={`点击：快速发送${kind==="agree"?"赞同":"反对"}`}>{icon}</div>
              <div onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,gf.relMsgId,kind);}}
                style={{flex:1,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:2,cursor:"pointer"}}>
                <span style={{fontWeight:700}}>{count}</span>
                <span style={{fontSize:9,opacity:0.85}}>{label}</span>
              </div>
            </div>
          );
          gfDecTop+=DEC_H+DEC_GAP;
        }
        return <React.Fragment key={`gf-dec-${gf.relMsgId}`}>{nodes}</React.Fragment>;
      })}

      {/* TAG decoration labels — aggregated by label text, interactive */}
      {Object.entries(tagDecorationsByMsg).map(([_mid,groups])=>
        groups.map(group=>{
          if(!visibleAnnotationIds.has(_mid))return null;
          const count=group.relMsgIds.length;
          const displayLabel=count>1?`${group.label}（${count}人）`:group.label;
          // Full-size agree/disagree decoration badges to the right of the tag badge, stacked vertically.
          // For icon click: quick-send targeting the first tag relation message in the group.
          // For body click: toggle selection of agree/disagree relations targeting any tag in the group.
          const tagBadgeRight = group.rect.x + group.rect.width;
          const tagIconRelMsgId = group.relMsgIds[0]; // first tag in group for icon-click quick-send
          // Guard: tagIconRelMsgId is always defined here (group.relMsgIds is non-empty when a group exists),
          // but the check ensures TypeScript and runtime safety.
          if (!tagIconRelMsgId) return (
            <React.Fragment key={`tag-${_mid}-${group.label}`}>
              <div
                data-msgid={_mid} data-jump-msgids={[_mid, ...group.relMsgIds].join(' ')} data-rel-overlay="true"
                onClick={ev=>{ev.stopPropagation();onTagBodyClick?.(ev,_mid,group.label,group.relMsgIds);}}
                onDoubleClick={ev=>{ev.stopPropagation();onTagDoubleClick?.(ev,_mid,group.label,group.relMsgIds);}}
                title={`标注：${group.label}（${count}人）；单击选中，双击展开详情`}
                style={{position:"absolute",left:group.rect.x-TAG_HIT_PAD_X,top:group.rect.y-TAG_HIT_PAD,
                  width:group.rect.width+2*TAG_HIT_PAD_X,height:group.rect.height+2*TAG_HIT_PAD,
                  zIndex:7,cursor:"pointer",pointerEvents:"auto",background:"transparent",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  padding:`${TAG_HIT_PAD}px ${TAG_HIT_PAD_X}px`,boxSizing:"border-box"}}>
                <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",
                  width:group.rect.width,height:group.rect.height,boxSizing:"border-box",
                  background:"rgba(180,150,0,0.85)",color:"#fff",borderRadius:3,
                  fontSize:10,padding:"0 4px",boxShadow:"0 1px 4px rgba(0,0,0,0.4)",
                  border:"1px solid rgba(255,255,255,0.15)",
                  whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  🏷{displayLabel}
                </span>
              </div>
            </React.Fragment>
          );
          return (
            <React.Fragment key={`tag-${_mid}-${group.label}`}>
              <div
                data-msgid={_mid} data-jump-msgids={[_mid, ...group.relMsgIds].join(' ')} data-rel-overlay="true"
                onClick={ev=>{ev.stopPropagation();onTagBodyClick?.(ev,_mid,group.label,group.relMsgIds);}}
                onDoubleClick={ev=>{ev.stopPropagation();onTagDoubleClick?.(ev,_mid,group.label,group.relMsgIds);}}
                title={`标注：${group.label}（${count}人）；单击选中，双击展开详情`}
                style={{position:"absolute",left:group.rect.x-TAG_HIT_PAD_X,top:group.rect.y-TAG_HIT_PAD,
                  width:group.rect.width+2*TAG_HIT_PAD_X,height:group.rect.height+2*TAG_HIT_PAD,
                  zIndex:7,cursor:"pointer",pointerEvents:"auto",background:"transparent",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  padding:`${TAG_HIT_PAD}px ${TAG_HIT_PAD_X}px`,boxSizing:"border-box"}}>
                <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",
                  width:group.rect.width,height:group.rect.height,boxSizing:"border-box",
                  background:"rgba(180,150,0,0.85)",color:"#fff",borderRadius:3,
                  fontSize:10,padding:"0 4px",boxShadow:"0 1px 4px rgba(0,0,0,0.4)",
                  border:"1px solid rgba(255,255,255,0.15)",
                  whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  🏷{displayLabel}
                </span>
              </div>
              {/* Full-size AGREE/DISAGREE decoration badges on this TAG relation group, stacked vertically */}
              {(group.relAgreeCount>0||group.relDisagreeCount>0)&&renderDecorationToggle(group.relMsgIds,
                {position:'absolute',left:tagBadgeRight+DEC_RIGHT_GAP,top:group.rect.y+(group.rect.height-EDGE_HINT_W)/2,zIndex:8})}
              {(()=>{
                if(!group.relMsgIds.some(id=>visibleDecorationIds.has(id)))return null;
                const tagDecLeft=tagBadgeRight+DEC_RIGHT_GAP+EDGE_HINT_W+DEC_GAP;
                let curTop=group.rect.y+Math.floor((group.rect.height-DEC_H)/2);
                return (["agree","disagree"] as const).map(kind=>{
                  const cnt=kind==="agree"?group.relAgreeCount:group.relDisagreeCount;
                  if (cnt<=0) return null;
                  const selectedDecorationIds=kind==="agree"?group.relAgreeMsgIds:group.relDisagreeMsgIds;
                  const isDecorationSel=selectedDecorationIds.some(isRelWholeSel);
                  const top=curTop; curTop+=DEC_H+DEC_GAP;
                  const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
                  const icon=kind==="agree"?"👍":"👎";
                  const label=kind==="agree"?"赞":"反";
                  return (
                    <div key={`tag-dec-${kind}-${_mid}-${group.label}`} data-msgid={tagIconRelMsgId} data-jump-msgids={selectedDecorationIds.join(' ')}
                      data-jump-visual-msgids={[...group.relMsgIds, ...selectedDecorationIds].join(' ')} data-rel-overlay="true"
                      onClick={ev=>{ev.stopPropagation();}}
                      onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,tagIconRelMsgId,kind);}}
                      title={`${kind==="agree"?"赞同":"反对"}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
                      style={{position:"absolute",left:tagDecLeft,top:top,width:DEC_W,height:DEC_H,zIndex:7,
                        background:bgColor,color:"#fff",borderRadius:4,display:"flex",alignItems:"center",
                        fontSize:11,pointerEvents:"auto",boxShadow:isDecorationSel?"0 2px 6px rgba(0,0,0,0.5)":"0 2px 6px rgba(0,0,0,0.5)",border:isDecorationSel?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.08)",
                        overflow:"hidden"}}>
                      <div onClick={ev=>{ev.stopPropagation();onDecorationIconClick?.(tagIconRelMsgId,kind);}}
                        style={{width:DEC_ICON_W,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                          cursor:"pointer",flexShrink:0,background:"rgba(0,0,0,0.15)",fontSize:12}}
                        title={`点击：快速发送${kind==="agree"?"赞同":"反对"}`}>{icon}</div>
                      <div onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,tagIconRelMsgId,kind);}}
                        style={{flex:1,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:2,cursor:"pointer"}}>
                        <span style={{fontWeight:700}}>{cnt}</span>
                        <span style={{fontSize:9,opacity:0.85}}>{label}</span>
                      </div>
                    </div>
                  );
                });
              })()}
            </React.Fragment>
          );
        })
      )}

      {/* Decoration badges (agree/disagree) — right side, with icon + body areas */}
      {(()=>{
        const anchors=new Map<string,{x:number;y:number}>();
        const frames=new Set([...visibleArrangeFrames,...visibleGroupFrames].map(frame=>frame.relMsgId));
        for(const value of Object.values(decorationRectsState??{}))if(!anchors.has(value.messageId))
          anchors.set(value.messageId,{x:value.rect.x-EDGE_HINT_W-DEC_GAP,y:value.rect.y});
        return [...anchors].map(([id,anchor])=>{
          if(frames.has(id))return null;
          return <React.Fragment key={`dec-toggle-${id}`}>
            {renderDecorationToggle(id,{position:'absolute',left:anchor.x,top:anchor.y,zIndex:8})}
          </React.Fragment>;
        });
      })()}
      {Object.entries(annotationToggleRects).map(([id,rect])=>renderDecorationToggle(id,
        {position:'absolute',left:rect.x,top:rect.y,zIndex:8},true))}
      {decorationRectsState&&decorationsByMsgState&&Object.entries(decorationRectsState).map(([,v])=>{
        if(!visibleDecorationIds.has(v.messageId))return null;
        const counts=decorationsByMsgState[v.messageId]; if (!counts) return null;
        const cnt=v.kind==="agree"?counts.agreeCount:counts.disagreeCount;
        const baseBg=v.kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
        const icon=v.kind==="agree"?"👍":"👎";
        const decKey=`${v.messageId}::${v.kind}`;
        const isSel=selectedDecorations?.has(decKey)??false;
        const bgColor=isSel
          ? "rgba(91,65,0,0.55)"
          : baseBg;
        const borderStyle=isSel
          ?"2px solid #fbbf24"
          :"1px solid rgba(255,255,255,0.08)";
        const shadowStyle=isSel
          ?"0 2px 8px rgba(251,191,36,0.35)"
          :"0 2px 6px rgba(0,0,0,0.5)";
        return (
          <div key={`dec-${v.key}`}
            data-msgid={v.messageId}
            data-jump-msgids={edges
              .filter(edge => edge.relationType === v.kind && edge.to.messageId === v.messageId)
              .map(edge => edge.relationMessageId)
              .join(' ') || undefined}
            data-rel-overlay="true"
            onClick={ev=>{ev.stopPropagation();}}
            onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,v.messageId,v.kind);}}
            title={`${v.kind==="agree"?"赞同":"反对"}${isSel?"（已选中）":""}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
            style={{position:"absolute",left:v.rect.x,top:v.rect.y,width:v.rect.width,height:v.rect.height,zIndex:7,
              background:bgColor,color:"#fff",borderRadius:4,display:"flex",alignItems:"center",
              fontSize:11,pointerEvents:"auto",boxShadow:shadowStyle,border:borderStyle,
              overflow:"hidden"}}>
            {/* Icon area: click = quick send */}
            <div
              onClick={ev=>{ev.stopPropagation();onDecorationIconClick?.(v.messageId,v.kind);}}
              style={{width:DEC_ICON_W,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                cursor:"pointer",flexShrink:0,background:"rgba(0,0,0,0.15)",fontSize:12}}
              title={`点击：快速发送${v.kind==="agree"?"赞同":"反对"}`}>
              {icon}
            </div>
            {/* Body area: click = toggle selection */}
            <div
              onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,v.messageId,v.kind);}}
              style={{flex:1,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                gap:2,cursor:"pointer"}}>
              <span style={{fontWeight:700}}>{cnt}</span>
              <span style={{fontSize:9,opacity:0.85}}>{v.kind==="agree"?"赞":"反"}</span>
            </div>
          </div>
        );
      })}

      {/* Annotation badges have their own upper-right toggle. */}
      {Array.from(inlineBadgesByMsg.entries()).map(([targetId, badges]) => {
        if(!visibleAnnotationIds.has(targetId))return null;
        let voteColumn=0;
        return badges.map(badge => {
          const isWholeSel = isRelWholeSel(badge.relMsgId);
          const bg = INLINE_BADGE_COLOR[badge.relColor] ?? 'rgba(100,100,120,0.9)';
          const badgeIds=badge.relMsgIds??[badge.relMsgId];
          const voteGroups=badgeIds.flatMap(id=>{
            const votes=relDecByRelMsgState.get(id);
            return votes&&(votes.agreeCount>0||votes.disagreeCount>0)?[{id,votes}]:[];
          });
          let voteLeft=badge.rect.x+badge.rect.width+DEC_RIGHT_GAP*3+EDGE_HINT_W;
          if(visibleDecorationIds.has(targetId)){
            for(const decoration of Object.values(decorationRectsState??{}))if(decoration.messageId===targetId)
              voteLeft=Math.max(voteLeft,decoration.rect.x+decoration.rect.width+DEC_RIGHT_GAP);
            for(const group of tagDecorationsByMsg[targetId]??[]){
              const tagVotes=group.relAgreeCount>0||group.relDisagreeCount>0;
              const expanded=group.relMsgIds.some(id=>visibleDecorationIds.has(id));
              voteLeft=Math.max(voteLeft,group.rect.x+group.rect.width+DEC_RIGHT_GAP
                +(tagVotes?getDecorationColumnWidth(expanded):0)+DEC_RIGHT_GAP);
            }
            const frame=[...visibleArrangeFrames,...visibleGroupFrames].find(item=>item.relMsgId===targetId);
            if(frame&&(frame.relAgreeCount>0||frame.relDisagreeCount>0))
              voteLeft=Math.max(voteLeft,frame.rect.x+frame.rect.width+DEC_RIGHT_GAP+getDecorationColumnWidth(true)+DEC_RIGHT_GAP);
          }
          const firstColumn=voteColumn;
          voteColumn+=voteGroups.length;
          const tooltip = badge.subDetails && badge.subDetails.length > 0
            ? `${badge.relLabel}\n${badge.subDetails.map(d => {
                const stLabels: Record<string,string> = { SPAM:'垃圾', OFFTOPIC:'跑题', LOWVALUE:'低质', IMPORTANT:'重要', CUSTOM:'自定义', YES:'是', NO:'否' };
                return `  ${d.customLabel || stLabels[d.subType] || d.subType}: ${d.count}人`;
              }).join('\n')}\n双击查看详情`
            : `${badge.relLabel}；双击展开操作详情`;
          return <React.Fragment key={`inline-${badge.relMsgId}`}>
            <div key={`badge-${badge.relMsgId}`} data-msgid={badge.relMsgId} data-jump-msgids={[badge.relMsgId, ...(badge.relMsgIds ?? [])].join(' ')} data-rel-overlay="true"
              onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,badge.relMsgId);}}
              onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,badge.relMsgId, { relMsgIds: badge.relMsgIds, subDetails: badge.subDetails });}}
              title={tooltip}
              style={{position:"absolute",left:badge.rect.x,top:badge.rect.y,width:badge.rect.width,height:badge.rect.height,
                zIndex:7,boxSizing:'border-box',background:isWholeSel?"#fbbf24":bg,color:isWholeSel?"#111827":"#fff",borderRadius:3,display:"flex",alignItems:"center",justifyContent:"center",
                fontSize:9,pointerEvents:"auto",cursor:"pointer",padding:"0 4px",
                boxShadow:isWholeSel?"0 2px 8px rgba(251,191,36,0.35)":"0 1px 4px rgba(0,0,0,0.5)",
                border:isWholeSel?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.15)",
                whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",fontWeight:600}}>
              <span style={{minWidth:0,overflow:'hidden',textOverflow:'ellipsis'}}>{badge.relLabel}</span>
              {voteGroups.length>0&&renderDecorationToggle(badgeIds,{marginLeft:2,border:0,background:'transparent',color:'inherit'})}
            </div>
            {voteGroups.flatMap(({id,votes},index)=>{
              if(!visibleDecorationIds.has(id))return [];
              let top=badge.rect.y;
              return (['agree','disagree'] as const).flatMap(kind=>{
                const ids=kind==='agree'?votes.agreeRelMsgIds:votes.disagreeRelMsgIds;
                const count=kind==='agree'?votes.agreeCount:votes.disagreeCount;
                if(!count)return [];
                const y=top;top+=DEC_H+DEC_GAP;
                const selected=ids.some(isRelWholeSel);
                return <div key={`inline-vote-${id}-${kind}`} data-msgid={id} data-jump-msgids={ids.join(' ')} data-rel-overlay="true"
                  onClick={event=>event.stopPropagation()}
                  onDoubleClick={event=>{event.stopPropagation();onDecorationDoubleClick?.(event,id,kind);}}
                  title={`${kind==='agree'?'赞同':'反对'}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
                  style={{position:'absolute',left:voteLeft+(firstColumn+index)*(DEC_W+DEC_GAP),top:y,width:DEC_W,height:DEC_H,zIndex:14,
                    background:selected?'#fbbf24':kind==='agree'?'rgba(2,150,80,0.9)':'rgba(200,40,40,0.9)',color:selected?'#111827':'#fff',
                    display:'flex',alignItems:'center',borderRadius:4,fontSize:11,pointerEvents:'auto',overflow:'hidden',
                    border:selected?'2px solid #fbbf24':'1px solid rgba(255,255,255,0.08)',boxShadow:'0 2px 6px rgba(0,0,0,0.5)'}}>
                  <div onClick={event=>{event.stopPropagation();onDecorationIconClick?.(id,kind);}}
                    title={`点击：快速发送${kind==='agree'?'赞同':'反对'}`}
                    style={{width:DEC_ICON_W,height:'100%',display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',
                      flexShrink:0,background:'rgba(0,0,0,0.15)',fontSize:12}}>{kind==='agree'?'👍':'👎'}</div>
                  <div onClick={event=>{event.stopPropagation();onDecorationBodyClick?.(event,id,kind);}}
                    style={{flex:1,height:'100%',display:'flex',alignItems:'center',justifyContent:'center',gap:2,cursor:'pointer'}}>
                    <span style={{fontWeight:700}}>{count}</span><span style={{fontSize:9,opacity:0.85}}>{kind==='agree'?'赞':'反'}</span>
                  </div>
                </div>;
              });
            })}
          </React.Fragment>;
        });
      })}

    </div>
  );
}

export default function GraphView(props: GraphViewProps) {
  const content=props.comparisonPair
    ? <ComparisonGraphPair {...props} />
    : props.comparisonSingle && props.comparisonDisplay
      ? <ComparisonPane side={props.comparisonDisplay}>
          {props.comparisonScopeHeader}
          <div data-comparison-viewport={props.comparisonDisplay} style={{ minWidth: 0, minHeight: 0, overflowX: 'auto', overflowY: 'hidden' }}><GraphViewCanvas {...props} /></div>
        </ComparisonPane>
      : <GraphViewCanvas {...props} />;
  return props.comparisonDisplay&&!props.comparisonSingle
    ?<MessageDisplayHintsScope messageId={props.comparisonTargetId} side={props.comparisonDisplay}>{content}</MessageDisplayHintsScope>:content;
}

