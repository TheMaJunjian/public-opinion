import { sendErrorMessage } from './sendErrors';
import { clearBrowserSelection, relationTypeName } from "../../../utils/graphTextSelection";
import type {
  DemoEdge,
  RelationType,
  UnitSelection
} from "../../../utils/modelBridge";
import { unitSelectionToTargetRef,unitSelectionToReference } from "../../../utils/modelBridge";
import { mergeUnits, nextId } from '../model/selection';
import type { DraftSendDependencies } from "./sendDraftTypes";

export async function sendNotifyDraft(dependencies: Pick<DraftSendDependencies, "sourceUnits" | "handleSendMessageOnly" | "setSendError" | "handleCreateRelationWithSourcesAndTargets" | "setDraftUnits" | "setSourceUnits" | "setTargetUnits" | "setActiveTextSelectId" | "setNewMessageContent" | "setSubType" | "setRelationType" | "setSecondaryRelationType">, { text, effectiveTargets }: { text: string; effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { sourceUnits, handleSendMessageOnly, setSendError, handleCreateRelationWithSourcesAndTargets, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setNewMessageContent, setSubType, setRelationType, setSecondaryRelationType } = dependencies;
  let notifySources = sourceUnits;
  if (notifySources.length === 0 && text.length > 0) {
    const sourceMessage = await handleSendMessageOnly(text);
    if (!sourceMessage) return;
    notifySources = [{ messageId: sourceMessage.id, selection: { kind: "whole" } }];
  }
  if (notifySources.length === 0) {
    setSendError('通知需要来源消息，请输入通知内容或选择来源消息');
    return;
  }
  await handleCreateRelationWithSourcesAndTargets({
    sources: notifySources,
    targets: effectiveTargets,
    label: '通知',
  });
  setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  setNewMessageContent(''); setSubType(''); setRelationType(null); setSecondaryRelationType('none');
  return;
}

export async function sendSelectedTagDraft(dependencies: Pick<DraftSendDependencies, "secondaryRelationType" | "msgMap" | "subType" | "newMessageContent" | "createRel" | "scopeMessageId" | "registerCreatedRelationInCurrentClassify" | "edgesRef" | "showAlert" | "setEdges" | "sendTagRelation" | "setDraftUnits" | "setSourceUnits" | "setTargetUnits" | "setActiveTextSelectId" | "setNewMessageContent" | "setSubType" | "setRelationType" | "setSecondaryRelationType" | "subTypeCustomBufferRef" | "setSubTypeCustomLabel" | "subTypeCustomLabel" | "sourceUnits" | "handleSendMessageOnly">, { effectiveTargets }: { effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { secondaryRelationType, msgMap, subType, newMessageContent, createRel, scopeMessageId, registerCreatedRelationInCurrentClassify, edgesRef, showAlert, setEdges, sendTagRelation, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setNewMessageContent, setSubType, setRelationType, setSecondaryRelationType, subTypeCustomBufferRef, setSubTypeCustomLabel } = dependencies;
  const secType = secondaryRelationType;
  if(secType==='read'||secType==='unread'){showAlert('已阅是个人查看状态，请在消息提示中标记已阅');return;}
  const newEdgesList: DemoEdge[] = [];
  if(subType==='CUSTOM'&&!dependencies.subTypeCustomLabel.trim()){showAlert('请输入自定义标注原因');return;}
  let sources=mergeUnits([],dependencies.sourceUnits);
  if(newMessageContent.trim()){
    const source=await dependencies.handleSendMessageOnly(newMessageContent.trim());
    if(!source)return;
    sources=[...sources,{messageId:source.id,selection:{kind:'whole'}}];
  }
  if (secType === "recommend" || secType === "archive" || secType === "attention" || secType === "block") {
    // One annotation per target; accompanying text is referenced as its source.
    for (const target of mergeUnits([], effectiveTargets)) {
      const tgtMid = target.messageId;
      const backendTargetRef = unitSelectionToTargetRef(target, msgMap);
      try {
        const relPayload: Record<string, unknown> = {};
        if (subType) {
          relPayload.subType = subType;
          if (subType === 'CUSTOM') {
            const customText = dependencies.subTypeCustomLabel.trim();
            if (customText) relPayload.customLabel = customText.slice(0, 20);
          }
        }
        const backendRel = await createRel(scopeMessageId!, { relationType: secType.toUpperCase(), sourceMessageId: sources[0]?.messageId??null,
          ...(sources.length?{sourceRefs:sources.map(unit=>unitSelectionToReference(unit,msgMap))}:{}),targetRefs: [backendTargetRef], payload: relPayload });
        const relId = backendRel.id;
        await registerCreatedRelationInCurrentClassify(backendRel);
        // Only add edge if not already present for this relation-target pair
        const alreadyHasEdge = edgesRef.current.some(e =>
          e.relationMessageId === relId && e.to.messageId === tgtMid);
        if (!alreadyHasEdge) {
          const anonSrcId = sources[0]?.messageId??`anon:${backendRel.id}`;
          newEdgesList.push({ id: nextId("edge"), relationMessageId: relId, relationType: secType as RelationType, from: { messageId: anonSrcId, selection: { kind: "whole" } }, to: target, relationLabel: relationTypeName(secType) } as DemoEdge);
        }
      } catch (e) { showAlert(`建立关系失败: ${sendErrorMessage(e)}`); }
    }
    setEdges(prev => [...prev, ...newEdgesList]);
  } else {
    // Existing tag labels use the same optional accompanying source text.
    const tagLabel = secType;
    const newTagEdges: DemoEdge[] = [];
    for (const target of mergeUnits([], effectiveTargets)) {
      const edge = await sendTagRelation(target, tagLabel,undefined,undefined,sources);
      if (edge) newTagEdges.push(edge);
    }
    setEdges(prev => [...prev, ...newTagEdges]);
  }
  setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  setNewMessageContent(""); setSubType(""); setRelationType(null); setSecondaryRelationType("none");
  subTypeCustomBufferRef.current = ""; setSubTypeCustomLabel("");
  return;
}

export async function sendAuthorizationDraft(dependencies: Pick<DraftSendDependencies, "createRel" | "scopeMessageId" | "msgMap" | "registerCreatedRelationInCurrentClassify" | "setDraftUnits" | "setSourceUnits" | "setTargetUnits" | "setNewMessageContent" | "setRelationType">, { effectiveTargets }: { effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { createRel, scopeMessageId, msgMap, registerCreatedRelationInCurrentClassify, setDraftUnits, setSourceUnits, setTargetUnits, setNewMessageContent, setRelationType } = dependencies;
  for (const target of effectiveTargets) {
    const relation = await createRel(scopeMessageId!, { relationType: 'AUTHORIZE', targetRefs: [unitSelectionToTargetRef(target, msgMap)] });
    await registerCreatedRelationInCurrentClassify(relation);
  }
  setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setNewMessageContent(''); setRelationType(null);
  return;
}

export async function sendWrittenTagDraft(dependencies: Pick<DraftSendDependencies, "sendTagRelation" | "setEdges" | "setDraftUnits" | "setSourceUnits" | "setTargetUnits" | "setActiveTextSelectId" | "setNewMessageContent" | "setRelationType" | "setSecondaryRelationType">, { text, effectiveTargets }: { text: string; effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { sendTagRelation, setEdges, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setNewMessageContent, setRelationType, setSecondaryRelationType } = dependencies;
  const tagLabel = text;
  const newTagEdges: DemoEdge[] = [];
  for (const target of mergeUnits([], effectiveTargets)) {
    const edge = await sendTagRelation(target, tagLabel);
    if (edge) newTagEdges.push(edge);
  }
  setEdges(prev => [...prev, ...newTagEdges]);
  setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  setNewMessageContent("");
  setRelationType(null); setSecondaryRelationType("none");
  return;
}
