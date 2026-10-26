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

export async function sendClassificationDraft(dependencies: Pick<DraftSendDependencies, "getGroupedTargetTextMessageIds" | "msgMap" | "relationTypeByRelMsgId" | "relationById" | "showAlert" | "hasCrossNonReferenceTextLinkForClassifyTargets" | "edges" | "newMessageContent" | "getClassifyTargetRefs" | "isInsideClassify" | "currentClassifyRelMsgId" | "classifyStackRef" | "createRel" | "scopeMessageId" | "appendCreatedRelation" | "setEdges" | "setDraftUnits" | "setSourceUnits" | "setTargetUnits" | "setActiveTextSelectId" | "setNewMessageContent" | "setRelationType" | "setSecondaryRelationType" | "setTraceKey">, { effectiveTargets }: { effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { getGroupedTargetTextMessageIds, msgMap, relationTypeByRelMsgId, relationById, showAlert, hasCrossNonReferenceTextLinkForClassifyTargets, edges, newMessageContent, getClassifyTargetRefs, isInsideClassify, currentClassifyRelMsgId, classifyStackRef, createRel, scopeMessageId, appendCreatedRelation, setEdges, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setNewMessageContent, setRelationType, setSecondaryRelationType } = dependencies;
  const targetTextIds = getGroupedTargetTextMessageIds(effectiveTargets);
  // Warn if non-grouping relation labels (TAG/RECOMMEND/ARCHIVE etc.) are selected
  // but their target text message is not among the messages being classified.
  const orphanLabels: string[] = [];
  for (const u of effectiveTargets) {
    const targetMsg = msgMap.get(u.messageId);
    const isContentRelation = targetMsg?.kind === 'relation'
      && ['delegation', 'proposal', 'code_change', 'operations'].includes(targetMsg.relationType ?? '');
    if (targetMsg && (isContentKind(targetMsg.kind) || isContentRelation)) continue;
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
    showAlert(`选中的${orphanLabels.join('、')}标签对应的消息不在分类目标中，请先选择目标消息再选择其标签，或取消选择无关标签`);
    return;
  }
  const crossLinkError = hasCrossNonReferenceTextLinkForClassifyTargets(targetTextIds, effectiveTargets);
  if (crossLinkError) {
    showAlert(crossLinkError);
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
      showAlert(`同一条排列关系关联了 ${uniqueMids.length} 条文本消息，分类前需全部选中`);
      return;
    }
  }
  const classifyTitle = newMessageContent.trim();
  if (!classifyTitle) {
    showAlert("分类名称不能为空");
    return;
  }
  const targetRefs = getClassifyTargetRefs(effectiveTargets);

  // Prevent circular nesting: a classify created from within the
  // classify hierarchy must not target any ancestor (including the
  // current classify and all its parents).
  if (isInsideClassify) {
    const ancestorIds = new Set<string>();
    if (currentClassifyRelMsgId) ancestorIds.add(currentClassifyRelMsgId);
    for (const entry of classifyStackRef.current) {
      ancestorIds.add(entry.relMsgId);
    }
    const targetsAncestor = targetRefs.some(ref =>
      ancestorIds.has(ref.kind === 'relation' ? ref.relationId : ref.messageId)
    );
    if (targetsAncestor) {
      showAlert('不能将当前分类或其上级分类作为新分类的目标');
      return;
    }
  }

  try {
    const backendRel = await createRel(scopeMessageId!, {
      relationType: 'CLASSIFY',
      sourceMessageId: null,
      targetRefs,
      payload: buildRelationPayload({ relationType: 'CLASSIFY', title: classifyTitle }),
    });
    const relId = backendRel.id;
    await appendCreatedRelation(backendRel);


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
  } catch (e) {
    showAlert(`建立关系失败: ${sendErrorMessage(e)}`);
    return;
  }
  setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  setNewMessageContent("");
  setRelationType(null); setSecondaryRelationType("none");
  // Bump key to force GraphView clean remount after adding classify edges,
  // avoiding React 18 concurrent reconciliation removeChild errors.
  return;
}
