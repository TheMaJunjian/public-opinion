import type { Json } from "@gonglun/core";
import React from "react";
import { api } from "../../../api";
import type { Relation } from "../../../types";
import { clearBrowserSelection, relationTypeName } from '../../../utils/graphTextSelection';
import { isWholeMessageSelection } from '../../../utils/messageElementSelection';
import type {
  DemoEdge,
  DemoMessage,
  RelationType,
  UnitSelection
} from "../../../utils/modelBridge";
import { isCorrectionProposal, unitSelectionToTargetRef } from "../../../utils/modelBridge";
import { nextId, unitEquals } from '../model/selection';
import type { ViewMode } from '../types';

interface ConfirmReverseCorrectionDependencies {
  sendInFlightRef: React.MutableRefObject<boolean>;
  comparisonPopup: { relMsgId: string; x: number; y: number; reversePreview?: { before: string; after: string; target: UnitSelection; mode?: "direct"; label?: string; value?: Json; correctionKind?: 'TEXT' | 'MEANING'; }; } | null;
  scopeMessageId: string;
  setSendInFlight: React.Dispatch<React.SetStateAction<boolean>>;
  createRel: (scopeMessageId: string, data: Parameters<typeof api.createRelation>[1]) => Promise<Relation>;
  msgMap: Map<string, DemoMessage>;
  registerCreatedRelationInCurrentClassify: (backendRel: Relation) => Promise<string | null>;
  setEdges: React.Dispatch<React.SetStateAction<DemoEdge[]>>;
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setSourceUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setTargetUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
  setActiveTextSelectId: React.Dispatch<React.SetStateAction<string | null>>;
  setNewMessageContent: React.Dispatch<React.SetStateAction<string>>;
  setRelationType: React.Dispatch<React.SetStateAction<RelationType | null>>;
  setSecondaryRelationType: React.Dispatch<React.SetStateAction<string>>;
  setRecommendationAmount: React.Dispatch<React.SetStateAction<number | "">>;
  setComparisonPopup: React.Dispatch<React.SetStateAction<{ relMsgId: string; x: number; y: number; reversePreview?: { before: string; after: string; target: UnitSelection; mode?: "direct"; label?: string; value?: Json; correctionKind?: 'TEXT' | 'MEANING'; }; } | null>>;
  showAlert: (message: string) => void;
  onCreated?: (messageId: string) => void;
}

export async function confirmReverseCorrection(dependencies: ConfirmReverseCorrectionDependencies): Promise<void> {
  const { sendInFlightRef, comparisonPopup, scopeMessageId, setSendInFlight, createRel, msgMap, registerCreatedRelationInCurrentClassify, setEdges, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setNewMessageContent, setRelationType, setSecondaryRelationType, setRecommendationAmount, setComparisonPopup, showAlert } = dependencies;
  if (sendInFlightRef.current) return;
  const preview = comparisonPopup?.reversePreview;
  if (!preview || !scopeMessageId) return;
  sendInFlightRef.current = true;
  setSendInFlight(true);
  try {
    const backendRel = await createRel(scopeMessageId, {
      relationType: 'CORRECT',
      sourceMessageId: null,
      targetRefs: [unitSelectionToTargetRef(preview.target, msgMap)],
      payload: { correctionContent: preview.after, correctionKind: preview.correctionKind ?? 'TEXT', ...(preview.value !== undefined ? { correctionValue: preview.value } : {}) },
    });
    await registerCreatedRelationInCurrentClassify(backendRel);
    setEdges(prev => prev.some(edge => edge.relationMessageId === backendRel.id) ? prev : [...prev, {
      id: nextId('edge'),
      relationMessageId: backendRel.id,
      relationType: 'correct',
      from: { messageId: `anon:${backendRel.id}`, selection: { kind: 'whole' } },
      to: preview.target,
      proposalOnly: isCorrectionProposal(backendRel),
      relationLabel: relationTypeName('correct'),
    }]);
    setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
    setNewMessageContent(''); setRelationType(null); setSecondaryRelationType('none');
    setRecommendationAmount(0);
    setComparisonPopup(null);
    dependencies.onCreated?.(backendRel.id);
  } catch (e: any) {
    showAlert(`建立反向更正失败: ${e?.message ?? e}`);
  } finally {
    sendInFlightRef.current = false;
    setSendInFlight(false);
  }
}

interface HandleDecorationIconClickDependencies {
  comparisonReviewed: boolean;
  scopeMessageId: string;
  msgMap: Map<string, DemoMessage>;
  correctionVersions: Map<string, { current?: import("../../../utils/modelBridge").CorrectionVersion; versions: import("../../../utils/modelBridge").CorrectionVersion[]; }>;
  showAlert: (message: string) => void;
  createRel: (scopeMessageId: string, data: Parameters<typeof api.createRelation>[1]) => Promise<Relation>;
  registerCreatedRelationInCurrentClassify: (backendRel: Relation) => Promise<string | null>;
}

export async function handleDecorationIconClick(dependencies: HandleDecorationIconClickDependencies, messageId: string, kind: "agree" | "disagree"): Promise<void> {
  const { comparisonReviewed, scopeMessageId, msgMap, showAlert, createRel, registerCreatedRelationInCurrentClassify } = dependencies;
  // Quick send: pure-stance agree/disagree — relation messages are first-class, persist to backend
  if (comparisonReviewed) return;
  if (!scopeMessageId) return;

  try {
    const backendRel = await createRel(scopeMessageId, {
      relationType: kind.toUpperCase(),
      sourceMessageId: null,
      targetRefs: [unitSelectionToTargetRef({ messageId, selection: { kind: "whole" } }, msgMap)],
    });
    await registerCreatedRelationInCurrentClassify(backendRel);
  } catch (e: any) { showAlert(`建立关系失败: ${e?.message ?? e}`); }
}

interface HandleComparisonVoteDependencies {
  isPreloaded: boolean;
  comparisonReviewed: boolean;
  requireAuth: () => boolean;
  comparisonTargetId: string | null;
  draftUnits: UnitSelection[];
  scopeMessageId: string;
  relStakeAmount: number | "";
  effectiveMinStake: number;
  setSendError: React.Dispatch<React.SetStateAction<string | null>>;
  availablePoints: number;
  createRel: (scopeMessageId: string, data: Parameters<typeof api.createRelation>[1]) => Promise<Relation>;
  msgMap: Map<string, DemoMessage>;
  registerCreatedRelationInCurrentClassify: (backendRel: Relation) => Promise<string | null>;
  showAlert: (message: string) => void;
}

export async function handleComparisonVote(dependencies: HandleComparisonVoteDependencies, side: 'agree' | 'disagree' = 'agree'): Promise<void> {
  const { isPreloaded, comparisonReviewed, requireAuth, comparisonTargetId, draftUnits, scopeMessageId, relStakeAmount, effectiveMinStake, setSendError, availablePoints, createRel, msgMap, registerCreatedRelationInCurrentClassify, showAlert } = dependencies;
  if (isPreloaded || !comparisonReviewed) return;
  if (!requireAuth()) return;
  const targetId = comparisonTargetId ?? (draftUnits.length === 1 ? draftUnits[0].messageId : null);
  if (!scopeMessageId || !targetId) return;
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
    const relation = await createRel(scopeMessageId, {
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

interface HandleDecorationBodyClickDependencies {
  edges: DemoEdge[];
  homeFilterResult: { matchIds: Set<string>; displayIds: Set<string>; } | null;
  setLastClickedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
}

export function handleDecorationBodyClick(dependencies: HandleDecorationBodyClickDependencies, e: React.MouseEvent, messageId: string, kind: "agree" | "disagree"): void {
  const { edges, homeFilterResult, setLastClickedMessageId, setDraftUnits } = dependencies;
  e.stopPropagation();
  // Toggle selection of all agree/disagree relation messages targeting this message
  const matchingRelMsgs = edges.filter(edge =>
    edge.relationType === kind &&
    edge.to.messageId === messageId &&
    isWholeMessageSelection(edge.to, messageId) &&
    (!homeFilterResult || (
      homeFilterResult.displayIds.has(edge.relationMessageId) &&
      (edge.from.messageId.startsWith('anon:') || homeFilterResult.displayIds.has(edge.from.messageId)) &&
      homeFilterResult.displayIds.has(edge.to.messageId)
    ))
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

interface HandleDecorationDoubleClickDependencies {
  edges: DemoEdge[];
  setStanceHighlight: React.Dispatch<React.SetStateAction<{ stanceMsgId: string; evidenceMsgIds: string[]; } | null>>;
  stanceHighlightTimerRef: React.MutableRefObject<number | null>;
  setDecorationPopup: React.Dispatch<React.SetStateAction<{ messageId: string; kind: "agree" | "disagree"; x: number; y: number; } | null>>;
}

export function handleDecorationDoubleClick(dependencies: HandleDecorationDoubleClickDependencies, e: React.MouseEvent, messageId: string, kind: "agree" | "disagree"): void {
  const { edges, setStanceHighlight, stanceHighlightTimerRef, setDecorationPopup } = dependencies;
  e.stopPropagation();

  // Phase 5: Stance path highlight — trace the argumentation chain
  // 1. Find all AGREE/DISAGREE edges pointing to this message
  const stanceEdges = edges.filter(
    edge => edge.relationType === kind &&
      edge.to.messageId === messageId &&
      isWholeMessageSelection(edge.to, messageId)
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

interface HandleTagBodyClickDependencies {
  setLastClickedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
}

export function handleTagBodyClick(dependencies: HandleTagBodyClickDependencies, e: React.MouseEvent, messageId: string, _tagLabel: string, relMsgIds: string[]): void {
  const { setLastClickedMessageId, setDraftUnits } = dependencies;
  e.stopPropagation();
  setLastClickedMessageId(messageId);
  setDraftUnits(prev => {
    const anySelected = relMsgIds.some(id => prev.some(u => isWholeMessageSelection(u, id)));
    if (anySelected) {
      return prev.filter(u => !(relMsgIds.includes(u.messageId) && isWholeMessageSelection(u, u.messageId)));
    } else {
      const toAdd = relMsgIds.filter(id => !prev.some(u => isWholeMessageSelection(u, id)));
      return [...prev, ...toAdd.map(id => ({ messageId: id, selection: { kind: "whole" as const } }))];
    }
  });
}

interface HandleTagDoubleClickDependencies {
  setTagPopup: React.Dispatch<React.SetStateAction<{ messageId: string; tagLabel: string; relMsgIds: string[]; x: number; y: number; subDetails?: Array<{ subType: string; customLabel?: string; count: number; }>; } | null>>;
}

export function handleTagDoubleClick(dependencies: HandleTagDoubleClickDependencies, e: React.MouseEvent, messageId: string, tagLabel: string, relMsgIds: string[]): void {
  const { setTagPopup } = dependencies;
  e.stopPropagation();
  setTagPopup({ messageId, tagLabel, relMsgIds, x: e.clientX, y: e.clientY });
}

interface HandleGroupFrameClickDependencies {
  setLastClickedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  toggleWholeUnit: (msgId: string) => void;
}

export function handleGroupFrameClick(dependencies: HandleGroupFrameClickDependencies, e: React.MouseEvent, relMsgId: string): void {
  const { setLastClickedMessageId, toggleWholeUnit } = dependencies;
  e.stopPropagation();
  setLastClickedMessageId(relMsgId);
  toggleWholeUnit(relMsgId);
}

interface HandleGroupFrameDoubleClickDependencies {
  setLastClickedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  edges: DemoEdge[];
  relationTypeByRelMsgId: Map<string, RelationType>;
  traceFrameIds: Set<string>;
  setTraceExpandedFrameIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTraceKey: React.Dispatch<React.SetStateAction<number>>;
  enterClassification: (relMsgId: string) => void;
  setMergeInfoPopup: React.Dispatch<React.SetStateAction<{ relMsgId: string; x: number; y: number; } | null>>;
  enterTrace: (messageId: string, options?: { replace?: boolean; mode?: "trace" | "scope"; scopeRelationMessageId?: string; }) => void;
}

export function handleGroupFrameDoubleClick(dependencies: HandleGroupFrameDoubleClickDependencies, e: React.MouseEvent, relMsgId: string): void {
  const { setLastClickedMessageId, edges, relationTypeByRelMsgId, traceFrameIds, setTraceExpandedFrameIds, setTraceKey, enterClassification, setMergeInfoPopup, enterTrace } = dependencies;
  e.stopPropagation();
  setLastClickedMessageId(relMsgId);
  const relEdges = edges.filter(ed => ed.relationMessageId === relMsgId);
  const relType = relEdges[0]?.relationType ?? relationTypeByRelMsgId.get(relMsgId) ?? "";
  if (relType === "classify" || relType === "summary") {
    if (traceFrameIds.has(relMsgId)) {
      setTraceExpandedFrameIds(prev => {
        const next = new Set(prev);
        if (next.has(relMsgId)) next.delete(relMsgId);
        else next.add(relMsgId);
        return next;
      });
      setTraceKey(key => key + 1);
      return;
    }
    enterClassification(relMsgId);
    return;
  }
  if (relType === "merge") {
    setMergeInfoPopup({ relMsgId, x: e.clientX, y: e.clientY });
    return;
  }
  enterTrace(relMsgId);
}

interface HandleInlineBadgeClickDependencies {
  setLastClickedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  toggleWholeUnit: (msgId: string) => void;
}

export function handleInlineBadgeClick(dependencies: HandleInlineBadgeClickDependencies, e: React.MouseEvent, relMsgId: string): void {
  const { setLastClickedMessageId, toggleWholeUnit } = dependencies;
  e.stopPropagation();
  setLastClickedMessageId(relMsgId);
  toggleWholeUnit(relMsgId);
}

interface HandleCrossRefTagClickDependencies {
  setLastClickedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  setDraftUnits: React.Dispatch<React.SetStateAction<UnitSelection[]>>;
}

export function handleCrossRefTagClick(dependencies: HandleCrossRefTagClickDependencies, e: React.MouseEvent, relMsgIds: string[]): void {
  const { setLastClickedMessageId, setDraftUnits } = dependencies;
  e.stopPropagation();
  if (relMsgIds.length === 0) return;
  setLastClickedMessageId(relMsgIds[0]);
  setDraftUnits(prev => {
    const anySelected = relMsgIds.some(id => prev.some(u => isWholeMessageSelection(u, id)));
    if (anySelected) {
      return prev.filter(u => !(relMsgIds.includes(u.messageId) && isWholeMessageSelection(u, u.messageId)));
    } else {
      const toAdd = relMsgIds.filter(id => !prev.some(u => isWholeMessageSelection(u, id)));
      return [...prev, ...toAdd.map(id => ({ messageId: id, selection: { kind: "whole" as const } }))];
    }
  });
}

interface HandleInlineBadgeDoubleClickDependencies {
  edges: DemoEdge[];
  setTagPopup: React.Dispatch<React.SetStateAction<{ messageId: string; tagLabel: string; relMsgIds: string[]; x: number; y: number; subDetails?: Array<{ subType: string; customLabel?: string; count: number; }>; } | null>>;
  enterTemporaryCategory: (force?: boolean) => void;
  setJoinFilterTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setCorrectionFilterTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;
  setComparisonPopup: React.Dispatch<React.SetStateAction<{ relMsgId: string; x: number; y: number; reversePreview?: { before: string; after: string; target: UnitSelection; mode?: "direct"; label?: string; value?: Json; correctionKind?: 'TEXT' | 'MEANING'; }; } | null>>;
}

export function handleInlineBadgeDoubleClick(dependencies: HandleInlineBadgeDoubleClickDependencies, e: React.MouseEvent, relMsgId: string, detail?: { relMsgIds?: string[]; subDetails?: Array<{ subType: string; customLabel?: string; count: number }> }): void {
  const { edges, setTagPopup, enterTemporaryCategory, setJoinFilterTargetId, setCorrectionFilterTargetId, setViewMode, setComparisonPopup } = dependencies;
  e.stopPropagation();
  // Recommend/archive: show aggregated badge detail with subType breakdown
  const relEdges = edges.filter(ed => ed.relationMessageId === relMsgId);
  const relType = relEdges[0]?.relationType;
  if (relType === 'recommend' || relType === 'archive') {
    const targetMid = relEdges[0]?.to.messageId;
    if (!targetMid) return;
    const typeName = relationTypeName(relType);
    const allRelMsgIds = detail?.relMsgIds ?? Array.from(new Set(
      edges.filter(ed => ed.relationType === relType && isWholeMessageSelection(ed.to, targetMid))
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
