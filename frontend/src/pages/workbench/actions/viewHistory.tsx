import React from "react";
import { type MessageFilterSettings } from "../../../components/MessageFilterPanel";
import type { Relation } from "../../../types";
import { operationLog } from "../../../utils/debugLog";
import type {
  DemoEdge,
  DemoMessage,
  UnitSelection
} from "../../../utils/modelBridge";
import { collectOwnedByRelation } from '../model/ownership';
import type { ClassifyStackEntry, TraceEntry, TraceSnapshot, ViewMode } from '../types';

interface CaptureSnapshotDependencies {
  viewMode: ViewMode;
  leftPanelRef: React.MutableRefObject<HTMLDivElement | null>;
  rightPanelRef: React.MutableRefObject<HTMLDivElement | null>;
  draftUnits: UnitSelection[];
  sourceUnits: UnitSelection[];
  targetUnits: UnitSelection[];
  activeTextSelectId: string | null;
  lastClickedMessageId: string | null;
  traceDistance: number;
}

export function captureSnapshot(dependencies: CaptureSnapshotDependencies): TraceSnapshot {
  const { viewMode, leftPanelRef, rightPanelRef, draftUnits, sourceUnits, targetUnits, activeTextSelectId, lastClickedMessageId, traceDistance } = dependencies;
  const pageScroll = document.scrollingElement;
  return {
    viewMode,
    leftScroll: leftPanelRef.current ? { top: leftPanelRef.current.scrollTop, left: leftPanelRef.current.scrollLeft } : null,
    pageScroll: pageScroll ? { top: pageScroll.scrollTop, left: pageScroll.scrollLeft } : null,
    rightScroll: rightPanelRef.current ? { top: rightPanelRef.current.scrollTop, left: rightPanelRef.current.scrollLeft } : null,
    draftUnits: draftUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })),
    sourceUnits: sourceUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })),
    targetUnits: targetUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })),
    activeTextSelectId,
    lastClickedMessageId,
    traceDistance,
  };
}

interface RestoreSnapshotDependencies {
  scrollRequestIdRef: React.MutableRefObject<number>;
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setSourceUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setTargetUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setActiveTextSelectId: React.Dispatch<React.SetStateAction<string | null>>;
  setLastClickedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  setTraceDistance: React.Dispatch<React.SetStateAction<number>>;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;
  cancelScrollRafs: () => void;
  scrollRafRef: React.MutableRefObject<number | null>;
  scrollRaf2Ref: React.MutableRefObject<number | null>;
  clampAndSetScroll: (container: HTMLDivElement | null, top: number | null, left: number | null) => void;
  leftPanelRef: React.MutableRefObject<HTMLDivElement | null>;
  rightPanelRef: React.MutableRefObject<HTMLDivElement | null>;
}

export function restoreSnapshot(dependencies: RestoreSnapshotDependencies, s: TraceSnapshot | null, opts?: { restoreSelection?: boolean }): void {
  const { scrollRequestIdRef, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setLastClickedMessageId, setTraceDistance, setViewMode, cancelScrollRafs, scrollRafRef, scrollRaf2Ref, clampAndSetScroll, leftPanelRef, rightPanelRef } = dependencies;
  if (!s) return;
  scrollRequestIdRef.current++;
  const restoreSel = opts?.restoreSelection !== false; // 默认 true，追溯模式恢复候选区
  if (restoreSel) {
    setDraftUnits(s.draftUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })));
    setSourceUnits(s.sourceUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })));
    setTargetUnits(s.targetUnits.map(u => ({ ...u, selection: { ...(u.selection as any) } })));
  }
  setActiveTextSelectId(s.activeTextSelectId);
  setLastClickedMessageId(s.lastClickedMessageId);
  setTraceDistance(s.traceDistance);
  setViewMode(s.viewMode);
  // Cancel any in-flight scroll rAF before scheduling new ones so that stale
  // callbacks never touch DOM nodes after React has reconciled them away.
  cancelScrollRafs();
  scrollRafRef.current = requestAnimationFrame(() => {
    scrollRaf2Ref.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      scrollRaf2Ref.current = null;
      clampAndSetScroll(leftPanelRef.current, s.leftScroll?.top ?? null, s.leftScroll?.left ?? null);
      clampAndSetScroll(document.scrollingElement as HTMLDivElement | null, s.pageScroll?.top ?? null, s.pageScroll?.left ?? null);
      clampAndSetScroll(rightPanelRef.current, s.rightScroll?.top ?? null, s.rightScroll?.left ?? null);
    });
  });
}

interface EnterTemporaryCategoryDependencies {
  joinFilterTargetId: string | null;
  correctionFilterTargetId: string | null;
  comparisonMode: boolean;
  comparisonReviewed: boolean;
  temporaryCategoryStackRef: React.MutableRefObject<{ snapshot: TraceSnapshot; hideJoin: boolean; joinFilterTargetId: string | null; joinFilterDirection: "incoming" | "outgoing"; correctionFilterTargetId: string | null; comparisonMode: boolean; comparisonReviewed: boolean; comparisonTargetId: string | null; comparisonSide: "agree" | "disagree"; comparisonReviewBaseMessages: DemoMessage[] | null; comparisonReviewBaseEdges: DemoEdge[] | null; }[]>;
  captureSnapshot: () => TraceSnapshot;
  msgFilter: MessageFilterSettings;
  joinFilterDirection: "incoming" | "outgoing";
  comparisonTargetId: string | null;
  comparisonSide: "agree" | "disagree";
  comparisonReviewBaseMessages: DemoMessage[] | null;
  comparisonReviewBaseEdges: DemoEdge[] | null;
}

export function enterTemporaryCategory(dependencies: EnterTemporaryCategoryDependencies, force = false): void {
  const { joinFilterTargetId, correctionFilterTargetId, comparisonMode, comparisonReviewed, temporaryCategoryStackRef, captureSnapshot, msgFilter, joinFilterDirection, comparisonTargetId, comparisonSide, comparisonReviewBaseMessages, comparisonReviewBaseEdges } = dependencies;
  const isTemporaryCategoryActive = joinFilterTargetId !== null
    || correctionFilterTargetId !== null
    || comparisonMode
    || comparisonReviewed;
  if (isTemporaryCategoryActive && !force) return;
  temporaryCategoryStackRef.current.push({
    snapshot: captureSnapshot(),
    hideJoin: msgFilter.hideJoin,
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

interface ExitTemporaryCategoryDependencies {
  temporaryCategoryStackRef: React.MutableRefObject<{ snapshot: TraceSnapshot; hideJoin: boolean; joinFilterTargetId: string | null; joinFilterDirection: "incoming" | "outgoing"; correctionFilterTargetId: string | null; comparisonMode: boolean; comparisonReviewed: boolean; comparisonTargetId: string | null; comparisonSide: "agree" | "disagree"; comparisonReviewBaseMessages: DemoMessage[] | null; comparisonReviewBaseEdges: DemoEdge[] | null; }[]>;
  setMsgFilter: React.Dispatch<React.SetStateAction<MessageFilterSettings>>;
  setJoinFilterTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setJoinFilterDirection: React.Dispatch<React.SetStateAction<"incoming" | "outgoing">>;
  setCorrectionFilterTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setComparisonMode: React.Dispatch<React.SetStateAction<boolean>>;
  setComparisonReviewed: React.Dispatch<React.SetStateAction<boolean>>;
  setComparisonTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setComparisonSide: React.Dispatch<React.SetStateAction<"agree" | "disagree">>;
  setComparisonReviewBaseMessages: React.Dispatch<React.SetStateAction<DemoMessage[] | null>>;
  setComparisonReviewBaseEdges: React.Dispatch<React.SetStateAction<DemoEdge[] | null>>;
  restoreSnapshot: (s: TraceSnapshot | null, opts?: { restoreSelection?: boolean; }) => void;
}

export function exitTemporaryCategory(dependencies: ExitTemporaryCategoryDependencies, options?: { restoreMessageFilter?: boolean }): void {
  const { temporaryCategoryStackRef, setMsgFilter, setJoinFilterTargetId, setJoinFilterDirection, setCorrectionFilterTargetId, setComparisonMode, setComparisonReviewed, setComparisonTargetId, setComparisonSide, setComparisonReviewBaseMessages, setComparisonReviewBaseEdges, restoreSnapshot } = dependencies;
  const entry = temporaryCategoryStackRef.current.pop();
  if (!entry) return;
  if (options?.restoreMessageFilter !== false) {
    setMsgFilter(previous => ({ ...previous, hideJoin: entry.hideJoin }));
  }
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

interface ExitAllTemporaryCategoriesDependencies {
  temporaryCategoryStackRef: React.MutableRefObject<{ snapshot: TraceSnapshot; hideJoin: boolean; joinFilterTargetId: string | null; joinFilterDirection: "incoming" | "outgoing"; correctionFilterTargetId: string | null; comparisonMode: boolean; comparisonReviewed: boolean; comparisonTargetId: string | null; comparisonSide: "agree" | "disagree"; comparisonReviewBaseMessages: DemoMessage[] | null; comparisonReviewBaseEdges: DemoEdge[] | null; }[]>;
  restoreSnapshot: (s: TraceSnapshot | null, opts?: { restoreSelection?: boolean; }) => void;
  setMsgFilter: React.Dispatch<React.SetStateAction<MessageFilterSettings>>;
  setJoinFilterTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setCorrectionFilterTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setComparisonMode: React.Dispatch<React.SetStateAction<boolean>>;
  setComparisonReviewed: React.Dispatch<React.SetStateAction<boolean>>;
  setComparisonTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setComparisonReviewBaseMessages: React.Dispatch<React.SetStateAction<DemoMessage[] | null>>;
  setComparisonReviewBaseEdges: React.Dispatch<React.SetStateAction<DemoEdge[] | null>>;
}

export function exitAllTemporaryCategories(dependencies: ExitAllTemporaryCategoriesDependencies, options?: { restoreMessageFilter?: boolean }): void {
  const { temporaryCategoryStackRef, restoreSnapshot, setMsgFilter, setJoinFilterTargetId, setCorrectionFilterTargetId, setComparisonMode, setComparisonReviewed, setComparisonTargetId, setComparisonReviewBaseMessages, setComparisonReviewBaseEdges } = dependencies;
  const entries = temporaryCategoryStackRef.current.splice(0);
  const firstEntry = entries[0];
  if (firstEntry) restoreSnapshot(firstEntry.snapshot);
  if (firstEntry && options?.restoreMessageFilter !== false) {
    setMsgFilter(previous => ({ ...previous, hideJoin: firstEntry.hideJoin }));
  }
  setJoinFilterTargetId(null);
  setCorrectionFilterTargetId(null);
  setComparisonMode(false);
  setComparisonReviewed(false);
  setComparisonTargetId(null);
  setComparisonReviewBaseMessages(null);
  setComparisonReviewBaseEdges(null);
}

interface EnterTraceDependencies {
  captureSnapshot: () => TraceSnapshot;
  classifyRelMsgId: string | null;
  classifyStackRef: React.MutableRefObject<ClassifyStackEntry[]>;
  setTraceExpandedFrameIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTraceEntries: React.Dispatch<React.SetStateAction<TraceEntry[]>>;
  setClassifyRelMsgId: React.Dispatch<React.SetStateAction<string | null>>;
  setClassifyKey: React.Dispatch<React.SetStateAction<number>>;
  cancelScrollRafs: () => void;
  scrollRequestIdRef: React.MutableRefObject<number>;
  leftPanelRef: React.MutableRefObject<HTMLDivElement | null>;
}

export function enterTrace(dependencies: EnterTraceDependencies, messageId: string, options?: { replace?: boolean; mode?: "trace" | "scope"; scopeRelationMessageId?: string }): void {
  const { captureSnapshot, classifyRelMsgId, classifyStackRef, setTraceExpandedFrameIds, setTraceEntries, setClassifyRelMsgId, setClassifyKey, cancelScrollRafs, scrollRequestIdRef, leftPanelRef } = dependencies;
  if (!messageId) return;
  operationLog(`进入${options?.mode === 'scope' ? '分类' : '追溯'}`, `message=${messageId}`);
  const snapshot = captureSnapshot();
  const entry: TraceEntry = {
    ids: [messageId], snapshot, mode: options?.mode ?? "trace", scopeRelationMessageId: options?.scopeRelationMessageId,
    classifyRelMsgId, classifyStack: [...classifyStackRef.current],
  };
  setTraceExpandedFrameIds(new Set());
  setTraceEntries(prev => options?.replace ? [entry] : [...prev, entry]);
  if (options?.mode !== 'scope') {
    classifyStackRef.current = [];
    setClassifyRelMsgId(null);
    setClassifyKey(key => key + 1);
    cancelScrollRafs();
    scrollRequestIdRef.current++;
    if (leftPanelRef.current) {
      leftPanelRef.current.scrollTop = 0;
      leftPanelRef.current.scrollLeft = 0;
    }
    if (document.scrollingElement) {
      document.scrollingElement.scrollTop = 0;
      document.scrollingElement.scrollLeft = 0;
    }
  }
}

interface EnterTraceMultipleDependencies {
  captureSnapshot: () => TraceSnapshot;
  classifyRelMsgId: string | null;
  classifyStackRef: React.MutableRefObject<ClassifyStackEntry[]>;
  setTraceExpandedFrameIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTraceEntries: React.Dispatch<React.SetStateAction<TraceEntry[]>>;
  setClassifyRelMsgId: React.Dispatch<React.SetStateAction<string | null>>;
  setClassifyKey: React.Dispatch<React.SetStateAction<number>>;
  cancelScrollRafs: () => void;
  scrollRequestIdRef: React.MutableRefObject<number>;
  leftPanelRef: React.MutableRefObject<HTMLDivElement | null>;
  setTraceKey: React.Dispatch<React.SetStateAction<number>>;
}

export function enterTraceMultiple(dependencies: EnterTraceMultipleDependencies, messageIds: string[], options?: { replace?: boolean; mode?: "trace" | "scope"; scopeRelationMessageId?: string }): void {
  const { captureSnapshot, classifyRelMsgId, classifyStackRef, setTraceExpandedFrameIds, setTraceEntries, setClassifyRelMsgId, setClassifyKey, cancelScrollRafs, scrollRequestIdRef, leftPanelRef, setTraceKey } = dependencies;
  if (!messageIds || messageIds.length === 0) return;
  operationLog(`进入${options?.mode === 'scope' ? '分类' : '追溯'}`, `messages=${messageIds.join(',')}`);
  const snapshot = captureSnapshot();
  const entry: TraceEntry = {
    ids: messageIds, snapshot, mode: options?.mode ?? "trace", scopeRelationMessageId: options?.scopeRelationMessageId,
    classifyRelMsgId, classifyStack: [...classifyStackRef.current],
  };
  setTraceExpandedFrameIds(new Set());
  setTraceEntries(prev => options?.replace ? [entry] : [...prev, entry]);
  if (options?.mode !== 'scope') {
    classifyStackRef.current = [];
    setClassifyRelMsgId(null);
    setClassifyKey(key => key + 1);
    cancelScrollRafs();
    scrollRequestIdRef.current++;
    if (leftPanelRef.current) {
      leftPanelRef.current.scrollTop = 0;
      leftPanelRef.current.scrollLeft = 0;
    }
    if (document.scrollingElement) {
      document.scrollingElement.scrollTop = 0;
      document.scrollingElement.scrollLeft = 0;
    }
  }
  // Bump exit key to force GraphView clean remount when entering trace,
  // avoiding React 18 concurrent reconciliation removeChild errors.
  setTraceKey(k => k + 1);
}

interface ExitTraceDependencies {
  traceEntries: TraceEntry[];
  setTraceEntries: React.Dispatch<React.SetStateAction<TraceEntry[]>>;
  setTraceExpandedFrameIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTraceKey: React.Dispatch<React.SetStateAction<number>>;
  classifyStackRef: React.MutableRefObject<ClassifyStackEntry[]>;
  setClassifyRelMsgId: React.Dispatch<React.SetStateAction<string | null>>;
  setClassifyKey: React.Dispatch<React.SetStateAction<number>>;
  restoreSnapshot: (s: TraceSnapshot | null, opts?: { restoreSelection?: boolean; }) => void;
}

export function exitTrace(dependencies: ExitTraceDependencies): void {
  const { traceEntries, setTraceEntries, setTraceExpandedFrameIds, setTraceKey, classifyStackRef, setClassifyRelMsgId, setClassifyKey, restoreSnapshot } = dependencies;
  // Pop the trace stack and bump the exit key to force GraphView remount,
  // avoiding React 18 concurrent reconciliation bugs (removeChild errors).
  const entry = traceEntries.length > 0 ? traceEntries[traceEntries.length - 1] : null;
  const snapshot = entry?.snapshot ?? null;
  operationLog('退出追溯', `depth=${traceEntries.length}`);
  setTraceEntries(prev => {
    if (prev.length === 0) return prev;
    return prev.slice(0, -1);
  });
  setTraceExpandedFrameIds(new Set());
  setTraceKey(k => k + 1);
  classifyStackRef.current = entry?.classifyStack ?? [];
  setClassifyRelMsgId(entry?.classifyRelMsgId ?? null);
  setClassifyKey(key => key + 1);
  if (snapshot) restoreSnapshot(snapshot, { restoreSelection: true });
}

interface ExitAllTraceDependencies {
  traceEntries: TraceEntry[];
  setTraceEntries: React.Dispatch<React.SetStateAction<TraceEntry[]>>;
  setTraceExpandedFrameIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTraceKey: React.Dispatch<React.SetStateAction<number>>;
  classifyStackRef: React.MutableRefObject<ClassifyStackEntry[]>;
  setClassifyRelMsgId: React.Dispatch<React.SetStateAction<string | null>>;
  setClassifyKey: React.Dispatch<React.SetStateAction<number>>;
  restoreSnapshot: (s: TraceSnapshot | null, opts?: { restoreSelection?: boolean; }) => void;
}

export function exitAllTrace(dependencies: ExitAllTraceDependencies): void {
  const { traceEntries, setTraceEntries, setTraceExpandedFrameIds, setTraceKey, classifyStackRef, setClassifyRelMsgId, setClassifyKey, restoreSnapshot } = dependencies;
  const snapshot = traceEntries.length > 0 ? traceEntries[0].snapshot : null;
  operationLog('退出全部追溯', `depth=${traceEntries.length}`);
  setTraceEntries(prev => {
    if (prev.length === 0) return prev;
    return [];
  });
  setTraceExpandedFrameIds(new Set());
  setTraceKey(k => k + 1);
  classifyStackRef.current = traceEntries.length > 0 ? traceEntries[0].classifyStack : [];
  setClassifyRelMsgId(traceEntries.length > 0 ? traceEntries[0].classifyRelMsgId : null);
  setClassifyKey(key => key + 1);
  if (snapshot) restoreSnapshot(snapshot);
}

interface EnterClassificationDependencies {
  captureSnapshot: () => TraceSnapshot;
  cancelScrollRafs: () => void;
  scrollRequestIdRef: React.MutableRefObject<number>;
  leftPanelRef: React.MutableRefObject<HTMLDivElement | null>;
  classifyStackRef: React.MutableRefObject<ClassifyStackEntry[]>;
  setClassifyRelMsgId: React.Dispatch<React.SetStateAction<string | null>>;
  setClassifyKey: React.Dispatch<React.SetStateAction<number>>;
}

export function enterClassification(dependencies: EnterClassificationDependencies, relMsgId: string): void {
  const { captureSnapshot, cancelScrollRafs, scrollRequestIdRef, leftPanelRef, classifyStackRef, setClassifyRelMsgId, setClassifyKey } = dependencies;
  // Save snapshot so we can restore on exit
  const snapshot = captureSnapshot();
  cancelScrollRafs();
  scrollRequestIdRef.current++;
  if (leftPanelRef.current) {
    leftPanelRef.current.scrollTop = 0;
    leftPanelRef.current.scrollLeft = 0;
  }
  if (document.scrollingElement) {
    document.scrollingElement.scrollTop = 0;
    document.scrollingElement.scrollLeft = 0;
  }
  classifyStackRef.current.push({ relMsgId, snapshot });
  setClassifyRelMsgId(relMsgId);
  setClassifyKey(k => k + 1);
}

interface FindContainingClassificationDependencies {
  relationById: Map<string, Relation>;
  relations: Relation[];
  rejectedContainerIds: Set<string>;
  rejectedJoinRelationIds: Set<string>;
}

export function findContainingClassification(dependencies: FindContainingClassificationDependencies, messageId: string): string | null {
  const { relationById, relations, rejectedContainerIds, rejectedJoinRelationIds } = dependencies;
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
    if (!['CLASSIFY', 'SUMMARY'].includes(relation.relationType) || rejectedContainerIds.has(relation.id)) continue;
    const owned = collectOwnedByRelation(
      relation.id,
      relationById,
      new Set(),
      rejectedContainerIds,
      rejectedJoinRelationIds,
    );
    if (!owned.textIds.has(anchorId) && !owned.relationIds.has(anchorId)) continue;
    const size = owned.textIds.size + owned.relationIds.size;
    if (!match || size < match.size) match = { id: relation.id, size };
  }
  return match?.id ?? null;
}

interface ExitClassificationDependencies {
  classifyStackRef: React.MutableRefObject<ClassifyStackEntry[]>;
  setClassifyRelMsgId: React.Dispatch<React.SetStateAction<string | null>>;
  setClassifyKey: React.Dispatch<React.SetStateAction<number>>;
  setPreviewClassifyId: React.Dispatch<React.SetStateAction<string | null>>;
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setSourceUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setTargetUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setActiveTextSelectId: React.Dispatch<React.SetStateAction<string | null>>;
  setLastClickedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  restoreSnapshot: (s: TraceSnapshot | null, opts?: { restoreSelection?: boolean; }) => void;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;
}

export function exitClassification(dependencies: ExitClassificationDependencies, _options?: { restoreSnapshot?: boolean; clearSelectionOnRootExit?: boolean; preserveViewMode?: ViewMode }): void {
  const { classifyStackRef, setClassifyRelMsgId, setClassifyKey, setPreviewClassifyId, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setLastClickedMessageId, restoreSnapshot, setViewMode } = dependencies;
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
  if (!prev && _options?.clearSelectionOnRootExit) {
    setDraftUnits([]);
    setSourceUnits([]);
    setTargetUnits([]);
    setActiveTextSelectId(null);
    setLastClickedMessageId(null);
  }
  if (_options?.restoreSnapshot !== false && entry?.snapshot) {
    restoreSnapshot(entry.snapshot, { restoreSelection: false });
  }
  if (_options?.preserveViewMode) setViewMode(_options.preserveViewMode);
}

interface HandleExitClassificationDependencies {
  draftUnits: UnitSelection[];
  lastClickedMessageId: string | null;
  exitClassification: (_options?: { restoreSnapshot?: boolean; clearSelectionOnRootExit?: boolean; preserveViewMode?: ViewMode; }) => void;
  viewMode: ViewMode;
  scrollMsgToCenter: (msgId: string, options?: { dependencyIds?: string[]; }) => void;
}

export function handleExitClassification(dependencies: HandleExitClassificationDependencies): void {
  const { draftUnits, lastClickedMessageId, exitClassification, viewMode, scrollMsgToCenter } = dependencies;
  const targetId = draftUnits[draftUnits.length - 1]?.messageId ?? lastClickedMessageId;
  exitClassification({ preserveViewMode: viewMode });
  if (targetId) setTimeout(() => scrollMsgToCenter(targetId), 150);
}

interface ConfirmMessageIdNavigationDependencies {
  messageIdInput: string;
  showAlert: (message: string) => void;
  messagesRef: React.MutableRefObject<DemoMessage[]>;
  handleNavigateToMessage: (messageId: string) => void;
  setAutoClassifyMsgId: React.Dispatch<React.SetStateAction<string | null>>;
}

export function confirmMessageIdNavigation(dependencies: ConfirmMessageIdNavigationDependencies): void {
  const { messageIdInput, showAlert, messagesRef, handleNavigateToMessage, setAutoClassifyMsgId } = dependencies;
  const messageId = messageIdInput.trim();
  if (!messageId) {
    showAlert('请输入消息 ID');
    return;
  }
  if (!messagesRef.current.some(message => message.id === messageId)) {
    showAlert(`未找到消息 ${messageId}`);
    return;
  }
  handleNavigateToMessage(messageId);
  setAutoClassifyMsgId(messageId);
}
