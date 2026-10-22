import type { Json } from "@gonglun/core";
import React from "react";
import type { Relation } from "../../../types";
import { clearBrowserSelection } from '../../../utils/graphTextSelection';
import { isWholeMessageSelection } from '../../../utils/messageElementSelection';
import type {
  DemoEdge,
  DemoMessage,
  RelationType,
  UnitSelection
} from "../../../utils/modelBridge";
import { unitSelectionToReference } from "../../../utils/modelBridge";
import { capturePartSelection } from "../../../utils/partSelection";
import { mergeUnits, unitEquals } from '../model/selection';
import type { ViewMode } from '../types';

/** Keep selected visible elements distinct from selecting their containing card. */
export function groupDraftSelections(units: UnitSelection[]) {
  const groups = new Map<string, { messageId: string; wholeSelected: boolean; wholeUnits: UnitSelection[]; fragments: UnitSelection[] }>();
  for (const unit of units) {
    const group = groups.get(unit.messageId) ?? { messageId: unit.messageId, wholeSelected: false, wholeUnits: [], fragments: [] };
    if (isWholeMessageSelection(unit, unit.messageId)) {
      group.wholeSelected = true;
      group.wholeUnits.push(unit);
    } else group.fragments.push(unit);
    groups.set(unit.messageId, group);
  }
  return [...groups.values()];
}

interface ClearDraftAllDependencies {
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setActiveTextSelectId: React.Dispatch<React.SetStateAction<string | null>>;
}

export function clearDraftAll(dependencies: ClearDraftAllDependencies): void {
  const { setDraftUnits, setActiveTextSelectId } = dependencies;
  setDraftUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
}

interface ToggleFragmentSelectionDependencies {
  msgMap: Map<string, DemoMessage>;
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  sourceUnits: UnitSelection[];
  setSendError: React.Dispatch<React.SetStateAction<string | null>>;
}

export function toggleFragmentSelection(dependencies: ToggleFragmentSelectionDependencies, messageId: string, start: number, len: number, text: string): void {
  const { msgMap, setDraftUnits, sourceUnits, setSendError } = dependencies;
  const u: UnitSelection = { messageId, selection: { kind: "text", start, len, text } };
  u.reference = unitSelectionToReference(u, msgMap);
  setDraftUnits(prev => {
    const exists = prev.some(x => unitEquals(x, u));
    if (!exists && sourceUnits.some(unit => unit.messageId === messageId)) {
      setSendError('消息已在来源集合中，不能同时加入候选暂存区');
      return prev;
    }
    setSendError(null);
    return exists ? prev.filter(x => !unitEquals(x, u)) : [...prev, u];
  });
}

interface HandleMessageMouseDownDependencies {
  mouseDownRef: React.MutableRefObject<{ x: number; y: number; messageId: string | null; } | null>;
}

export function handleMessageMouseDown(dependencies: HandleMessageMouseDownDependencies, e: React.MouseEvent, messageId: string): void {
  const { mouseDownRef } = dependencies;
  if (e.button !== 0) return;
  mouseDownRef.current = { x: e.clientX, y: e.clientY, messageId };
}

interface UndoRecentClickActionsForMessageDependencies {
  lastClickActionsRef: React.MutableRefObject<{ type: "toggleWhole"; messageId: string; prevExisted: boolean; time: number; }[]>;
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
}

export function undoRecentClickActionsForMessage(dependencies: UndoRecentClickActionsForMessageDependencies, messageId: string): void {
  const { lastClickActionsRef, setDraftUnits } = dependencies;
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

interface HandleMessageMouseUpDependencies {
  mouseDownRef: React.MutableRefObject<{ x: number; y: number; messageId: string | null; } | null>;
  lastDragOrSelectTimeRef: React.MutableRefObject<number>;
  undoRecentClickActionsForMessage: (messageId: string) => void;
}

export function handleMessageMouseUp(dependencies: HandleMessageMouseUpDependencies, e: React.MouseEvent, messageId: string): void {
  const { mouseDownRef, lastDragOrSelectTimeRef, undoRecentClickActionsForMessage } = dependencies;
  if (!mouseDownRef.current) return;
  const md = mouseDownRef.current; mouseDownRef.current = null;
  if (md.messageId !== messageId) return;
  const dx = Math.abs(md.x - e.clientX), dy = Math.abs(md.y - e.clientY);
  const moved = dx > 6 || dy > 6;
  if (moved) { lastDragOrSelectTimeRef.current = Date.now(); undoRecentClickActionsForMessage(messageId); }
}

interface HandleMessageClickDependencies {
  lastDragOrSelectTimeRef: React.MutableRefObject<number>;
  comparisonMode: boolean;
  setComparisonTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setComparisonReviewed: React.Dispatch<React.SetStateAction<boolean>>;
  setComparisonReviewBaseMessages: React.Dispatch<React.SetStateAction<DemoMessage[] | null>>;
  setComparisonReviewBaseEdges: React.Dispatch<React.SetStateAction<DemoEdge[] | null>>;
  setComparisonSide: React.Dispatch<React.SetStateAction<"agree" | "disagree">>;
  setLastClickedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  sourceUnits: UnitSelection[];
  setSendError: React.Dispatch<React.SetStateAction<string | null>>;
  lastClickActionsRef: React.MutableRefObject<{ type: "toggleWhole"; messageId: string; prevExisted: boolean; time: number; }[]>;
}

export function handleMessageClick(dependencies: HandleMessageClickDependencies, e: React.MouseEvent, messageId: string): void {
  const { lastDragOrSelectTimeRef, comparisonMode, setComparisonTargetId, setComparisonReviewed, setComparisonReviewBaseMessages, setComparisonReviewBaseEdges, setComparisonSide, setLastClickedMessageId, setDraftUnits, sourceUnits, setSendError, lastClickActionsRef } = dependencies;
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
    setSendError(null);
    const next = exists
      ? prev.filter(u => !unitEquals(u, wholeUnit))
      : [...prev, wholeUnit];
    lastClickActionsRef.current.push({ type: "toggleWhole", messageId, prevExisted: exists, time: Date.now() });
    const now = Date.now();
    lastClickActionsRef.current = lastClickActionsRef.current.filter(a => now - a.time < 2000);
    return next;
  });
}

interface HandleMessageDoubleClickDependencies {
  undoRecentClickActionsForMessage: (messageId: string) => void;
  msgMap: Map<string, DemoMessage>;
  setLastClickedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  activeTextSelectId: string | null;
  viewMode: ViewMode;
  setComparisonPopup: React.Dispatch<React.SetStateAction<{ relMsgId: string; x: number; y: number; reversePreview?: { before: string; after: string; target: UnitSelection; mode?: "direct"; label?: string; value?: Json; }; } | null>>;
  edges: DemoEdge[];
  enterTemporaryCategory: (force?: boolean) => void;
  setJoinFilterTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setCorrectionFilterTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;
  traceFrameIds: Set<string>;
  setTraceExpandedFrameIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTraceKey: React.Dispatch<React.SetStateAction<number>>;
  relationType: RelationType | null;
  setActiveTextSelectId: React.Dispatch<React.SetStateAction<string | null>>;
  enterClassification: (relMsgId: string) => void;
  rejectedContainerIds: Set<string>;
  setPreviewClassifyId: React.Dispatch<React.SetStateAction<string | null>>;
  setStanceHighlight: React.Dispatch<React.SetStateAction<{ stanceMsgId: string; evidenceMsgIds: string[]; } | null>>;
  stanceHighlightTimerRef: React.MutableRefObject<number | null>;
  relations: Relation[];
  settlementOpenMsgId: string | null;
  closeSettlement: () => void;
  openSettlement: (msgId: string, type?: "TRUTH" | "VALUE") => void;
  lastAddedFragmentRef: React.MutableRefObject<{ messageId: string; unit: UnitSelection; time: number; } | null>;
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
}

export function handleMessageDoubleClick(dependencies: HandleMessageDoubleClickDependencies, e: React.MouseEvent, messageId: string): void {
  const { undoRecentClickActionsForMessage, msgMap, setLastClickedMessageId, activeTextSelectId, viewMode, setComparisonPopup, edges, enterTemporaryCategory, setJoinFilterTargetId, setCorrectionFilterTargetId, setViewMode, traceFrameIds, setTraceExpandedFrameIds, setTraceKey, relationType, setActiveTextSelectId, enterClassification, rejectedContainerIds, setPreviewClassifyId, setStanceHighlight, stanceHighlightTimerRef, relations, settlementOpenMsgId, closeSettlement, openSettlement, lastAddedFragmentRef, setDraftUnits } = dependencies;
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
        if (currentlyActive) { setActiveTextSelectId(null); clearBrowserSelection(); }
        else { setActiveTextSelectId(messageId); clearBrowserSelection(); }
        return;
      }
      if (traceFrameIds.has(messageId)) {
        setTraceExpandedFrameIds(prev => {
          const next = new Set(prev);
          if (next.has(messageId)) next.delete(messageId);
          else next.add(messageId);
          return next;
        });
        setTraceKey(key => key + 1);
        return;
      }
      // Always clear any text selection before entering classification to prevent
      // the browser's native double-click text selection from persisting into the new view.
      setActiveTextSelectId(null);
      clearBrowserSelection();
      enterClassification(messageId);
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
    if (classifyRel) enterClassification(classifyRel.id);
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

interface HandleTextMouseUpDependencies {
  msgMap: Map<string, DemoMessage>;
  activeTextSelectId: string | null;
  setActiveTextSelectId: React.Dispatch<React.SetStateAction<string | null>>;
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  sourceUnits: UnitSelection[];
  setSendError: React.Dispatch<React.SetStateAction<string | null>>;
  lastAddedFragmentRef: React.MutableRefObject<{ messageId: string; unit: UnitSelection; time: number; } | null>;
  lastDragOrSelectTimeRef: React.MutableRefObject<number>;
  undoRecentClickActionsForMessage: (messageId: string) => void;
}

export function handleTextMouseUp(dependencies: HandleTextMouseUpDependencies, e: React.MouseEvent, messageId: string): void {
  const { msgMap, activeTextSelectId, setActiveTextSelectId, setDraftUnits, sourceUnits, setSendError, lastAddedFragmentRef, lastDragOrSelectTimeRef, undoRecentClickActionsForMessage } = dependencies;
  const m = msgMap.get(messageId);
  if (!m) return;
  // The second mouse-up belongs to the double-click gesture, not a drag selection.
  if (e.detail > 1) return;
  const organizationText = m.relationType === 'classify' || m.relationType === 'summary';
  if (activeTextSelectId !== messageId && !organizationText) return;
  const container = e.currentTarget as HTMLElement;
  const fragmentUnit = capturePartSelection(container, m);
  if (!fragmentUnit) return;
  e.stopPropagation();
  clearBrowserSelection();
  setActiveTextSelectId(messageId);
  setDraftUnits(prev => {
    const exists = prev.some(u => unitEquals(u, fragmentUnit));
    if (!exists && sourceUnits.some(unit => unit.messageId === messageId)) {
      setSendError('消息已在来源集合中，不能同时加入候选暂存区');
      return prev;
    }
    setSendError(null);
    return exists ? prev.filter(u => !unitEquals(u, fragmentUnit)) : [...prev, fragmentUnit];
  });
  lastAddedFragmentRef.current = { messageId, unit: fragmentUnit, time: Date.now() };
  lastDragOrSelectTimeRef.current = Date.now();
  undoRecentClickActionsForMessage(messageId);
}

interface HandleFragmentAnchorClickDependencies {
  setActiveTextSelectId: React.Dispatch<React.SetStateAction<string | null>>;
  toggleFragmentSelection: (messageId: string, start: number, len: number, text: string) => void;
  setLastClickedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  undoRecentClickActionsForMessage: (messageId: string) => void;
}

export function handleFragmentAnchorClick(dependencies: HandleFragmentAnchorClickDependencies, messageId: string, start: number, len: number, text: string): void {
  const { setActiveTextSelectId, toggleFragmentSelection, setLastClickedMessageId, undoRecentClickActionsForMessage } = dependencies;
  setActiveTextSelectId(messageId); clearBrowserSelection();
  toggleFragmentSelection(messageId, start, len, text);
  setLastClickedMessageId(messageId);
  undoRecentClickActionsForMessage(messageId);
}

interface CommitDraftToDependencies {
  draftUnits: UnitSelection[];
  targetUnits: UnitSelection[];
  sourceUnits: UnitSelection[];
  setSendError: React.Dispatch<React.SetStateAction<string | null>>;
  setSourceUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setTargetUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setActiveTextSelectId: React.Dispatch<React.SetStateAction<string | null>>;
}

export function commitDraftTo(dependencies: CommitDraftToDependencies, role: "source" | "target"): void {
  const { draftUnits, targetUnits, sourceUnits, setSendError, setSourceUnits, setTargetUnits, setDraftUnits, setActiveTextSelectId } = dependencies;
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

interface ToggleWholeUnitDependencies {
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
}

export function toggleWholeUnit(dependencies: ToggleWholeUnitDependencies, msgId: string): void {
  const { setDraftUnits } = dependencies;
  const wholeUnit: UnitSelection = { messageId: msgId, selection: { kind: "whole" } };
  setDraftUnits(prev => {
    const exists = prev.some(u => unitEquals(u, wholeUnit));
    return exists ? prev.filter(u => !unitEquals(u, wholeUnit)) : [...prev, wholeUnit];
  });
}

interface HandleCanvasBlankClickDependencies {
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setSourceUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setTargetUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setActiveTextSelectId: React.Dispatch<React.SetStateAction<string | null>>;
  setLastClickedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
}

export function handleCanvasBlankClick(dependencies: HandleCanvasBlankClickDependencies): void {
  const { setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setLastClickedMessageId } = dependencies;
  setDraftUnits([]); setSourceUnits([]); setTargetUnits([]);
  setActiveTextSelectId(null); clearBrowserSelection(); setLastClickedMessageId(null);
}
