import { sendErrorMessage } from './sendErrors';
import type {
  UnitSelection
} from "../../../utils/modelBridge";
import { unitSelectionToTargetRef } from "../../../utils/modelBridge";
import { buildRelationPayload } from '../model/relationComposition';
import type { DraftSendDependencies } from "./sendDraftTypes";

export async function sendDelegationDraft(dependencies: Pick<DraftSendDependencies, "newMessageContent" | "secondaryRelationType" | "msgMap" | "relations" | "setSendError" | "createRel" | "scopeMessageId" | "registerCreatedRelationInCurrentClassify" | "setRelations" | "setNewMessageContent" | "setRelationType" | "setSecondaryRelationType">, { effectiveTargets }: { effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { newMessageContent, secondaryRelationType, msgMap, relations, setSendError, createRel, scopeMessageId, registerCreatedRelationInCurrentClassify, setRelations, setNewMessageContent, setRelationType, setSecondaryRelationType } = dependencies;
  const content = newMessageContent.trim();
  const readField = (labels: string[]): string | null => {
    for (const field of labels) {
      const match = content.match(new RegExp(`${field}\\s*[=:：]\\s*([^\\n;；]+)`, 'i'));
      if (match?.[1]?.trim()) return match[1].trim();
    }
    return null;
  };
  const isFulfill = secondaryRelationType === 'fulfill';
  const targetRelation = isFulfill && effectiveTargets.length === 1 && msgMap.get(effectiveTargets[0].messageId)?.kind === 'relation'
    ? relations.find(rel => rel.id === effectiveTargets[0].messageId)
    : undefined;
  const isCreateDelegation = targetRelation?.payload?.delegationKind === 'CREATE';
  const amountText = readField(['报酬数量', '数量']);
  const ratioText = readField(['报酬比例', '比例']);
  const description = readField([isFulfill ? '完成说明' : '委托内容']);
  const amount = amountText ? Number(amountText) : undefined;
  const ratio = ratioText ? Number(ratioText.replace(/%$/, '')) : undefined;
  const validReward = isFulfill
    ? amount === undefined && ratio === undefined
    : amount !== undefined && Number.isInteger(amount) && amount > 0 && ratio === undefined;
  if (!content || !description || !validReward || (isFulfill && (effectiveTargets.length !== 1 || !targetRelation || targetRelation.relationType.toUpperCase() !== 'DELEGATION' || !isCreateDelegation))) {
    setSendError(isFulfill
      ? '完成委托格式：完成说明=...，并且必须选中一条创建委托消息'
      : '创建委托格式：报酬数量=100；委托内容=...（报酬数量必须放在第一行）');
    return;
  }
  try {
    const backendRel = await createRel(scopeMessageId!, {
      relationType: 'DELEGATION',
      sourceMessageId: null,
      targetRefs: isFulfill && targetRelation
        ? [unitSelectionToTargetRef({ messageId: targetRelation!.id, selection: { kind: 'whole' } }, msgMap)]
        : [],
      payload: buildRelationPayload({
        relationType: 'DELEGATION', content,
        delegationKind: isFulfill ? 'FULFILL' : 'CREATE',
        rewardAmount: isFulfill ? undefined : amount, rewardRatio: isFulfill ? undefined : ratio,
      }),
    });
    await registerCreatedRelationInCurrentClassify(backendRel);
    setRelations(prev => [...prev, backendRel]);
    setNewMessageContent(''); setRelationType(null); setSecondaryRelationType('none');
  } catch (e) { setSendError(`${isFulfill ? '建立完成委托' : '建立委托'}失败：${sendErrorMessage(e)}`); }
  return;
}
