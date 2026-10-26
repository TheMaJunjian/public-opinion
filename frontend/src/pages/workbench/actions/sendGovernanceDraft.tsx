import { sendErrorMessage } from './sendErrors';
import { api } from "../../../api";
import { clearBrowserSelection, relationTypeName } from "../../../utils/graphTextSelection";
import type {
  DemoEdge,
  DemoMessage,
  MessageKind,
  RelationType,
  UnitSelection,
} from "../../../utils/modelBridge";
import { isContentKind, unitSelectionToTargetRef } from "../../../utils/modelBridge";
import { buildRelationPayload } from '../model/relationComposition';
import { nextId } from '../model/selection';
import type { DraftSendDependencies } from "./sendDraftTypes";

export async function sendGovernanceDraft(dependencies: Pick<DraftSendDependencies, "newMessageContent" | "relationType" | "secondaryRelationType" | "setSendError" | "msgMap" | "hasTargetsAvailable" | "showAlert" | "createRel" | "scopeMessageId" | "user" | "setMessages" | "registerCreatedRelationInCurrentClassify" | "setEdges" | "relStakeRef" | "setAuthorStakes" | "mergeStakeSnapshot" | "setDraftUnits" | "setSourceUnits" | "setTargetUnits" | "setActiveTextSelectId" | "setNewMessageContent" | "setRelationType" | "setSecondaryRelationType">, { effectiveTargets }: { effectiveTargets: UnitSelection[]; }): Promise<void> {
  const { newMessageContent, relationType, secondaryRelationType, setSendError, msgMap, hasTargetsAvailable, showAlert, createRel, scopeMessageId, user, setMessages, registerCreatedRelationInCurrentClassify, setEdges, relStakeRef, setAuthorStakes, mergeStakeSnapshot, setDraftUnits, setSourceUnits, setTargetUnits, setActiveTextSelectId, setNewMessageContent, setRelationType, setSecondaryRelationType } = dependencies;
  if (!relationType) return;
  let proposalContent = newMessageContent.trim();
  let payloadExtraForOperation: Record<string, unknown> = {};

  // 分配收入：内置文案
  if (relationType === 'proposal' && secondaryRelationType === '分配收入') {
    proposalContent = '提案：将当前收入池余额按规则分配给社区成员';
  }
  const readProposalField = (labels: string[]): string | null => {
    for (const label of labels) {
      const match = proposalContent.match(new RegExp(`${label}\\s*[=:：]\\s*([^\\n;；]+)`, 'i'));
      if (match?.[1]?.trim()) return match[1].trim();
    }
    return null;
  };
  if (relationType === 'proposal' && secondaryRelationType === '充值分账') {
    const amount = Number(readProposalField(['充值总额', '总额', 'amount']));
    const revenuePoolShare = Number(readProposalField(['收入池分成', '分成', 'revenuePoolShare']));
    const recipientUserId = readProposalField(['指定与会者', 'recipientUserId']);
    if (!Number.isInteger(amount) || amount <= 0 || !Number.isInteger(revenuePoolShare) || revenuePoolShare < 0 || revenuePoolShare > amount || !recipientUserId) {
      setSendError('充值分账提案格式：充值总额=1000；收入池分成=100；指定与会者=user-id');
      return;
    }
    proposalContent = `充值分账提案\n充值总额：${amount}\n收入池分成：${revenuePoolShare}\n指定与会者：${recipientUserId}`;
    payloadExtraForOperation = { operationType: 'RECHARGE', amount, revenuePoolShare, recipientUserId };
  }
  if (relationType === 'proposal' && secondaryRelationType === '运营收入注入') {
    const amount = Number(readProposalField(['收入金额', '金额', 'amount']));
    const source = readProposalField(['来源', 'source']);
    if (!Number.isInteger(amount) || amount <= 0 || !source) {
      setSendError('运营收入提案格式：收入金额=1000；来源=服务收入');
      return;
    }
    proposalContent = `运营收入注入提案\n收入金额：${amount}\n来源：${source}`;
    payloadExtraForOperation = { operationType: 'REVENUE_INJECTION', amount, source };
  }
  // 终止结算：内置文案带目标信息
  else if (relationType === 'proposal' && secondaryRelationType === '终止结算') {
    const targetInfos: string[] = [];
    for (const t of effectiveTargets) {
      const m = msgMap.get(t.messageId);
      if (m?.kind === 'governance') {
        const preview = m.content ? m.content.slice(0, 80) : '(无内容)';
        targetInfos.push(`「${preview}」— ${m.author}`);
      }
    }
    proposalContent = `终止结算提案\n目标提案：${targetInfos.join('; ')}`;
  }
  else if (!proposalContent && !hasTargetsAvailable) {
    showAlert("请输入内容或选择目标消息");
    return;
  }
  // Auto-fill content from target text messages when input is empty
  if (!proposalContent && hasTargetsAvailable) {
    const targetContents: string[] = [];
    for (const t of effectiveTargets) {
      const m = msgMap.get(t.messageId);
      if (m && isContentKind(m.kind) && m.content) {
        targetContents.push(m.content);
      }
    }
    proposalContent = targetContents.join('\n\n---\n\n');
  }
  try {
    const payloadExtra: Record<string, unknown> = {};
    if (relationType === 'proposal' && secondaryRelationType !== 'none') {
      const opMap: Record<string, string> = { '分配收入': 'DISTRIBUTE_REVENUE', '充值分账': 'RECHARGE', '运营收入注入': 'REVENUE_INJECTION', '终止结算': 'TERMINATE_SETTLEMENT' };
      payloadExtra.operationType = opMap[secondaryRelationType] ?? secondaryRelationType.toUpperCase();
    }
    Object.assign(payloadExtra, payloadExtraForOperation);
    // 终止结算：传递目标消息 ID 给后端
    if (secondaryRelationType === '终止结算') {
      const targetMsgIds: string[] = [];
      for (const t of effectiveTargets) {
        const m = msgMap.get(t.messageId);
        if (m?.kind === 'governance') targetMsgIds.push(t.messageId);
      }
      if (targetMsgIds.length > 0) payloadExtra.targetMessageIds = targetMsgIds;
    }
    const backendRel = await createRel(scopeMessageId!, {
      relationType: relationType.toUpperCase(),
      sourceMessageId: null,
      targetRefs: [],
      payload: buildRelationPayload({
        relationType: relationType.toUpperCase(),
        content: proposalContent || '',
        title: (proposalContent || '').slice(0, 200) || undefined,
        ...payloadExtra,
      }),
    });
    // Add as governance/code/operations content message (not relation), so it renders as a card
    const govKind: MessageKind = relationType === "proposal" ? "governance" : relationType === "code_change" ? "code" : "operations";
    const govMsg: DemoMessage = {
      id: backendRel.id,
      author: backendRel.createdBy?.username ?? user?.username ?? '?',
      createdAt: backendRel.createdAt,
      content: proposalContent,
      kind: govKind,
      backendKind: relationType === "proposal" ? "GOVERNANCE" : relationType === "code_change" ? "CODE" : "OPERATIONS",
      sourceMessageId: backendRel.sourceMessageId,
      relationType: backendRel.relationType.toLowerCase() as RelationType,
      relationPayload: backendRel.payload,
      targetRefs: backendRel.targetRefs,
    };
    setMessages(prev => [...prev, govMsg]);
    // Governance/ops messages are content-kind — add as message target
    // Create REFERENCE relations from governance message to each target.
    if (hasTargetsAvailable) {
      for (const t of effectiveTargets) {
        try {
          const targetRef = unitSelectionToTargetRef(t, msgMap);
          const refRel = await createRel(scopeMessageId!, {
            relationType: 'REFERENCE',
            sourceMessageId: backendRel.id,
            targetRefs: [targetRef],
            stakeAmount: 0,
            wager: 1,
            selfAgree: true,
            recommendation: 0,
          });
          await registerCreatedRelationInCurrentClassify(refRel);
          setEdges(prev => [...prev, {
            id: nextId("edge"),
            relationMessageId: refRel.id,
            relationType: "reference",
            from: { messageId: backendRel.id, selection: { kind: "whole" } },
            to: { ...t },
            relationLabel: "reference",
          } as DemoEdge]);
        } catch (e) {
          api.cancelCommandBatch(e);
          throw e;
        }
      }
    }
    // Auto-self-stake
    const selfStake = relStakeRef.current;
    setAuthorStakes(prev => ({ ...prev, [backendRel.id]: selfStake }));
    api.getMessageStakes(backendRel.id).then(s => {
      mergeStakeSnapshot(backendRel.id, s);
    }).catch(() => { });
    window.dispatchEvent(new Event('points-refresh'));
  } catch (e) {
    showAlert(`建立${relationTypeName(relationType)}关系失败: ${sendErrorMessage(e)}`);
    return;
  }
  setDraftUnits([]); setSourceUnits([]); setTargetUnits([]); setActiveTextSelectId(null); clearBrowserSelection();
  setNewMessageContent("");
  setRelationType(null); setSecondaryRelationType("none");
  return;
}
