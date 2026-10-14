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
import { nextId, selKey } from '../model/selection';
import type { DraftSendDependencies } from "./sendDraftTypes";

export async function sendMergeDraft(dependencies: Pick<DraftSendDependencies, "handleSendMessageOnly" | "getGroupedTargetTextMessageIds" | "msgMap" | "relationTypeByRelMsgId" | "relationById" | "showAlert" | "hasCrossNonReferenceTextLinkForClassifyTargets" | "organizationTargetRef" | "createRel" | "scopeMessageId" | "appendCreatedRelation" | "setEdges" | "setDraftUnits" | "setSourceUnits" | "setTargetUnits" | "setActiveTextSelectId" | "setNewMessageContent" | "setRelationType" | "setSecondaryRelationType">, { text, effectiveTargets }: { text: string; effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { handleSendMessageOnly, getGroupedTargetTextMessageIds, msgMap, relationTypeByRelMsgId, relationById, showAlert, hasCrossNonReferenceTextLinkForClassifyTargets, organizationTargetRef, createRel, scopeMessageId, appendCreatedRelation, setEdges, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setNewMessageContent, setRelationType, setSecondaryRelationType } = dependencies;
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
  const crossLinkError = hasCrossNonReferenceTextLinkForClassifyTargets(mergeTargetTextIds, effectiveTargets);
  if (crossLinkError) {
    showAlert(crossLinkError);
    return;
  }
  const mergeTargetRefs = Array.from(new Map(
    effectiveTargets.map(u => {
      const ref = organizationTargetRef(u);
      return [selKey(u), ref] as const;
    })
  ).values());
  if (mergeTargetRefs.length === 0) {
    showAlert("归并关系至少需要一个文本消息或关系消息作为目标");
    return;
  }
  try {
    const backendRel = await createRel(scopeMessageId!, {
      relationType: 'MERGE',
      sourceMessageId: null,
      targetRefs: mergeTargetRefs,
      payload: buildRelationPayload({ relationType: 'MERGE', targetLayout: 'multi-column' }),
    });
    const relId = backendRel.id;
    await appendCreatedRelation(backendRel);
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
  } catch (e) {
    showAlert(`建立归并关系失败: ${sendErrorMessage(e)}`);
    return;
  }
  setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  setNewMessageContent("");
  setRelationType(null); setSecondaryRelationType("none");
  return;
}
