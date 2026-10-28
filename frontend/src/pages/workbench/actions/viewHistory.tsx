import React from "react";
import type { WorkbenchDrawingTask } from '../../../context/WorkbenchDrawingContext';
import { REVEAL_VIRTUAL_MESSAGE } from '../../../hooks/useVirtualMessageMounts';
import { findMessageElements } from './scrollNavigation';
import { type MessageFilterSettings } from "../../../components/MessageFilterPanel";
import { operationLog } from "../../../utils/debugLog";
import type {
  DemoEdge,
  DemoMessage,
  UnitSelection
} from "../../../utils/modelBridge";
import { findContainingClassification as findClassification, type FindContainingClassificationInput } from '../model/ownership';
import type { ClassifyStackEntry, TraceEntry, TraceSnapshot, ViewMode } from '../types';

interface CaptureSnapshotDependencies {
  viewMode: ViewMode;
  leftPanelRef: React.MutableRefObject<HTMLDivElement | null>;
  rightPanelRef: React.MutableRefObject<HTMLDivElement | null>;
  traceDistance: number;
  readingAnchorId?:string|null;
}

export function captureSnapshot(dependencies: CaptureSnapshotDependencies): TraceSnapshot {
  const { viewMode, leftPanelRef, rightPanelRef, traceDistance } = dependencies;
  const pageScroll = document.scrollingElement;
  const panel=leftPanelRef.current,id=dependencies.readingAnchorId;
  const candidates=panel&&id?findMessageElements(panel,id):[];
  const target=candidates.find(element=>!element.hasAttribute('data-rel-overlay'))??candidates[0];
  let readingViewportAnchor:TraceSnapshot['readingViewportAnchor']=null;
  if(panel&&target&&id){
    const rect=target.getBoundingClientRect(),bounds=panel.getBoundingClientRect();
    if(rect.width>0&&rect.height>0&&rect.bottom>bounds.top&&rect.top<bounds.bottom&&rect.right>bounds.left&&rect.left<bounds.right){
      const x=panel.offsetWidth>0?bounds.width/panel.offsetWidth:1,y=panel.offsetHeight>0?bounds.height/panel.offsetHeight:1;
      readingViewportAnchor={messageId:id,top:(rect.top-bounds.top)/(y||1),left:(rect.left-bounds.left)/(x||1)};
    }
  }
  return {
    viewMode,
    leftScroll: leftPanelRef.current ? { top: leftPanelRef.current.scrollTop, left: leftPanelRef.current.scrollLeft } : null,
    pageScroll: pageScroll ? { top: pageScroll.scrollTop, left: pageScroll.scrollLeft } : null,
    rightScroll: rightPanelRef.current ? { top: rightPanelRef.current.scrollTop, left: rightPanelRef.current.scrollLeft } : null,
    traceDistance,
    readingViewportAnchor,
  };
}

interface RestoreSnapshotDependencies {
  setTraceDepths?: (depths:import('../../../utils/traceRange').TraceDepths)=>void;
  startPositioning?: () => WorkbenchDrawingTask;
  onRestored?: () => void;
  showMessagePulse?: (targetId: string, element: HTMLElement, requestId: number, onShown: (shown: boolean) => void) => void;
  scrollRequestIdRef: React.MutableRefObject<number>;
  setTraceDistance: React.Dispatch<React.SetStateAction<number>>;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;
  cancelScrollRafs: () => void;
  scrollRafRef: React.MutableRefObject<number | null>;
  scrollRaf2Ref: React.MutableRefObject<number | null>;
  clampAndSetScroll: (container: HTMLDivElement | null, top: number | null, left: number | null) => void;
  leftPanelRef: React.MutableRefObject<HTMLDivElement | null>;
  rightPanelRef: React.MutableRefObject<HTMLDivElement | null>;
}

export interface RestoreSnapshotOptions {
  restoreScope?: boolean;
  restoreMessageFilter?: boolean;
  pulseMessageId?: string;
}

export function restoreSnapshot(dependencies: RestoreSnapshotDependencies, s: TraceSnapshot | null, opts?: RestoreSnapshotOptions): void {
  const { scrollRequestIdRef, setTraceDistance, setViewMode, cancelScrollRafs, scrollRafRef, scrollRaf2Ref, clampAndSetScroll, leftPanelRef, rightPanelRef } = dependencies;
  if (!s) return;
  if (opts?.restoreScope !== false) s.restoreScope?.();
  const requestId = ++scrollRequestIdRef.current;
  if(dependencies.setTraceDepths)dependencies.setTraceDepths(s.traceDepths??{up:s.traceDirection==='down'?0:s.traceDistance,down:s.traceDirection==='up'?0:s.traceDistance});
  else setTraceDistance(s.traceDistance);
  setViewMode(s.viewMode);
  // Cancel any in-flight scroll rAF before scheduling new ones so that stale
  // callbacks never touch DOM nodes after React has reconciled them away.
  cancelScrollRafs();
  const task = dependencies.startPositioning?.();
  task?.onCancel(()=>{
    if(requestId===scrollRequestIdRef.current&&s.readingViewportAnchor)leftPanelRef.current?.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:[]}}));
  });
  const afterLayout=(work:()=>void)=>{
    if(task?.afterLayout)task.afterLayout(work);
    else scrollRafRef.current=requestAnimationFrame(()=>{scrollRaf2Ref.current=requestAnimationFrame(()=>{if(task)task.run(work);else work();});});
  };
  const finishRestore = () => {
    if(requestId!==scrollRequestIdRef.current){task?.complete();return;}
    dependencies.onRestored?.();
    const messageId = opts?.pulseMessageId;
    const showPulse = dependencies.showMessagePulse;
    if (messageId && showPulse && leftPanelRef.current) {
      // Re-pin the origin after restoring its scene, then highlight it without
      // recentering and overwriting the saved viewport.
      leftPanelRef.current.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [messageId] } }));
      const pulse = () => {
        if (requestId !== scrollRequestIdRef.current) { task?.complete(); return; }
        const element = leftPanelRef.current && findMessageElements(leftPanelRef.current, messageId)[0];
        if (element) showPulse(messageId, element, requestId, () => task?.complete());
        else {
          leftPanelRef.current?.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } }));
          task?.complete();
        }
      };
      if (task?.afterLayout) task.afterLayout(pulse);
      else scrollRaf2Ref.current = requestAnimationFrame(pulse);
      return;
    }
    if(s.readingViewportAnchor)leftPanelRef.current?.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:[]}}));
    task?.complete();
  };
  const restore = () => {
    scrollRafRef.current = null;
    scrollRaf2Ref.current = null;
    if(requestId!==scrollRequestIdRef.current){task?.complete();return;}
    clampAndSetScroll(leftPanelRef.current, s.leftScroll?.top ?? null, s.leftScroll?.left ?? null);
    clampAndSetScroll(document.scrollingElement as HTMLDivElement | null, s.pageScroll?.top ?? null, s.pageScroll?.left ?? null);
    clampAndSetScroll(rightPanelRef.current, s.rightScroll?.top ?? null, s.rightScroll?.left ?? null);
    const anchor=s.readingViewportAnchor,panel=leftPanelRef.current;
    if(!anchor||!panel){finishRestore();return;}
    // A background insertion can move the saved reading card. Pin it through
    // virtual mounting, then restore its screen position against the new layout.
    panel.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:[anchor.messageId]}}));
    afterLayout(()=>{
      if(requestId!==scrollRequestIdRef.current){task?.complete();return;}
      const candidates=findMessageElements(panel,anchor.messageId);
      const target=candidates.find(element=>!element.hasAttribute('data-rel-overlay'))??candidates[0];
      if(target){
        const rect=target.getBoundingClientRect(),bounds=panel.getBoundingClientRect();
        if(rect.width>0&&rect.height>0){
          const x=panel.offsetWidth>0?bounds.width/panel.offsetWidth:1,y=panel.offsetHeight>0?bounds.height/panel.offsetHeight:1;
          clampAndSetScroll(panel,panel.scrollTop+(rect.top-bounds.top)/(y||1)-anchor.top,panel.scrollLeft+(rect.left-bounds.left)/(x||1)-anchor.left);
        }
      }
      afterLayout(finishRestore);
    });
  };
  if (task?.afterLayout) task.afterLayout(restore);
  else scrollRafRef.current = requestAnimationFrame(() => {
    scrollRaf2Ref.current = requestAnimationFrame(() => {
      if (task) task.run(restore); else restore();
    });
  });
  task?.onCancel(cancelScrollRafs);
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
  restoreSnapshot: (s: TraceSnapshot | null, options?: RestoreSnapshotOptions) => void;
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
  restoreSnapshot(entry.snapshot, { restoreMessageFilter: options?.restoreMessageFilter });
}

interface ExitAllTemporaryCategoriesDependencies {
  temporaryCategoryStackRef: React.MutableRefObject<{ snapshot: TraceSnapshot; hideJoin: boolean; joinFilterTargetId: string | null; joinFilterDirection: "incoming" | "outgoing"; correctionFilterTargetId: string | null; comparisonMode: boolean; comparisonReviewed: boolean; comparisonTargetId: string | null; comparisonSide: "agree" | "disagree"; comparisonReviewBaseMessages: DemoMessage[] | null; comparisonReviewBaseEdges: DemoEdge[] | null; }[]>;
  restoreSnapshot: (s: TraceSnapshot | null, options?: RestoreSnapshotOptions) => void;
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
  if (firstEntry) restoreSnapshot(firstEntry.snapshot, { restoreMessageFilter: options?.restoreMessageFilter });
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

export function enterTrace(dependencies: EnterTraceDependencies, messageId: string, options?: { replace?: boolean; mode?: "trace" | "scope"; scopeRelationMessageId?: string; relatedView?: boolean }): void {
  const { captureSnapshot, classifyRelMsgId, classifyStackRef, setTraceExpandedFrameIds, setTraceEntries, setClassifyRelMsgId, setClassifyKey, cancelScrollRafs, scrollRequestIdRef, leftPanelRef } = dependencies;
  if (!messageId) return;
  operationLog(`进入${options?.mode === 'scope' ? '分类' : '追溯'}`, `message=${messageId}`);
  const snapshot = captureSnapshot();
  const entry: TraceEntry = {
    ids: [messageId], snapshot, mode: options?.mode ?? "trace", scopeRelationMessageId: options?.scopeRelationMessageId, relatedView: options?.relatedView,
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
  restoreSnapshot: (s: TraceSnapshot | null) => void;
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
  if (snapshot) restoreSnapshot(snapshot);
}

interface ExitAllTraceDependencies {
  traceEntries: TraceEntry[];
  setTraceEntries: React.Dispatch<React.SetStateAction<TraceEntry[]>>;
  setTraceExpandedFrameIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTraceKey: React.Dispatch<React.SetStateAction<number>>;
  classifyStackRef: React.MutableRefObject<ClassifyStackEntry[]>;
  setClassifyRelMsgId: React.Dispatch<React.SetStateAction<string | null>>;
  setClassifyKey: React.Dispatch<React.SetStateAction<number>>;
  restoreSnapshot: (s: TraceSnapshot | null) => void;
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

export function findContainingClassification(dependencies: FindContainingClassificationInput,messageId:string):string|null {
  return findClassification(dependencies,messageId);
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
  restoreSnapshot: (s: TraceSnapshot | null, opts?: RestoreSnapshotOptions) => void;
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
    // Classification navigation changes the current layer within the active
    // trace/comparison view; those surrounding modes keep their own history.
    restoreSnapshot(entry.snapshot, { restoreScope: false, pulseMessageId: entry.relMsgId });
  }
  if (_options?.preserveViewMode) setViewMode(_options.preserveViewMode);
}

interface HandleExitClassificationDependencies {
  exitClassification: (_options?: { restoreSnapshot?: boolean; clearSelectionOnRootExit?: boolean; preserveViewMode?: ViewMode; }) => void;
}

export function handleExitClassification(dependencies: HandleExitClassificationDependencies): void {
  // The saved mode and scroll position describe the view the user left.
  // Centering the current selection afterwards would overwrite that position.
  dependencies.exitClassification();
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
