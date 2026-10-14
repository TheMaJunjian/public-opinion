import { sendErrorMessage } from './sendErrors';
import { clearBrowserSelection, relationTypeName } from "../../../utils/graphTextSelection";
import type { TargetRef } from "../../../types";
import { getPresentationSpec } from "../../../types";
import type {
  RelationType,
  UnitSelection
} from "../../../utils/modelBridge";
import { isContentKind } from "../../../utils/modelBridge";
import { buildRelationPayload } from '../model/relationComposition';
import { nextId } from '../model/selection';
import type { DraftSendDependencies } from "./sendDraftTypes";

export async function sendSummaryDraft(dependencies: Pick<DraftSendDependencies, "newMessageContent" | "showAlert" | "getGroupedTargetTextMessageIds" | "msgMap" | "relationTypeByRelMsgId" | "relationById" | "hasCrossNonReferenceTextLinkForClassifyTargets" | "getClassifyTargetRefs" | "isInsideClassify" | "currentClassifyRelMsgId" | "classifyStackRef" | "createRel" | "scopeMessageId" | "appendCreatedRelation" | "setEdges" | "setDraftUnits" | "setSourceUnits" | "setTargetUnits" | "setActiveTextSelectId" | "setNewMessageContent" | "setRelationType" | "setSecondaryRelationType">, { effectiveTargets }: { effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { newMessageContent, showAlert, getGroupedTargetTextMessageIds, msgMap, relationTypeByRelMsgId, relationById, hasCrossNonReferenceTextLinkForClassifyTargets, getClassifyTargetRefs, isInsideClassify, currentClassifyRelMsgId, classifyStackRef, createRel, scopeMessageId, appendCreatedRelation, setEdges, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setNewMessageContent, setRelationType, setSecondaryRelationType } = dependencies;
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
  const crossLinkError = hasCrossNonReferenceTextLinkForClassifyTargets(targetTextIds, effectiveTargets);
  if (crossLinkError) {
    showAlert(crossLinkError);
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
    const backendRel = await createRel(scopeMessageId!, {
      relationType: 'SUMMARY',
      sourceMessageId: null,
      targetRefs: summaryTargetRefs,
      payload: buildRelationPayload({ relationType: 'SUMMARY', title: summaryTitle, targetLayout: 'multi-column' }),
    });
    const relId = backendRel.id;
    await appendCreatedRelation(backendRel);
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
  } catch (e) {
    showAlert(`建立总结关系失败: ${sendErrorMessage(e)}`);
    return;
  }
  setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  setNewMessageContent("");
  setRelationType(null); setSecondaryRelationType("none");
  return;
}
