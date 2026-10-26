import { sendErrorMessage } from './sendErrors';
import React from "react";
import { api } from "../../../api";
import { ApiError } from "../../../api/client";
import type { MessageStakes, Relation, TargetRef } from "../../../types";
import { operationLog } from "../../../utils/debugLog";
import type {
  DemoMessage,
  RelationType
} from "../../../utils/modelBridge";

interface HandleSendMessageOnlyDependencies {
  requireAuth: () => boolean;
  newMessageContent: string;
  scopeMessageId: string;
  stakeAmount: number | "";
  joinContribution?:{wager:number;recommendation:number};
  setSendError: React.Dispatch<React.SetStateAction<string | null>>;
  selectedRelationRef: React.MutableRefObject<RelationType | null>;
  recommendationRef: React.MutableRefObject<number>;
  stakeFeeAmountRef: React.MutableRefObject<number>;
  isInsideClassify: boolean;
  availablePoints: number;
  currentClassifyRelMsgId: string | null;
  setMessages: React.Dispatch<React.SetStateAction<DemoMessage[]>>;
  mergeStakeSnapshot: (messageId: string, stakes: MessageStakes) => void;
  setAuthorStakes: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setStakeAmount: React.Dispatch<React.SetStateAction<number | "">>;
  minSelfStake: number;
  setNewMessageContent: React.Dispatch<React.SetStateAction<string>>;
  scrollMsgToCenter: (msgId: string, options?: { dependencyIds?: string[]; }) => void;
  onCreated?: (messageId: string) => void;
  setClassifyKey: React.Dispatch<React.SetStateAction<number>>;
  handleAuthError: (err: unknown) => Promise<boolean>;
}

export async function handleSendMessageOnly(dependencies: HandleSendMessageOnlyDependencies, overrideContent?: string): Promise<DemoMessage | null> {
  const { requireAuth, newMessageContent, scopeMessageId, stakeAmount, setSendError, recommendationRef, stakeFeeAmountRef, isInsideClassify, availablePoints, currentClassifyRelMsgId, setMessages, mergeStakeSnapshot, setAuthorStakes, setStakeAmount, minSelfStake, setNewMessageContent, scrollMsgToCenter, setClassifyKey, handleAuthError } = dependencies;
  if (!requireAuth()) return null;
  const text = overrideContent ?? newMessageContent;
  if (text.trim().length === 0) return null;
  if (!scopeMessageId) return null;
  const pts = typeof stakeAmount === 'number' ? stakeAmount : 0;
  if (pts < 0) {
    setSendError('真假投入不能为负数');
    return null;
  }
  const recommendation = recommendationRef.current;
  if (pts === 0 && recommendation === 0) {
    setSendError('真假和价值至少一项须大于 0');
    return null;
  }
  const join=dependencies.joinContribution??{wager:1,recommendation:0};
  const inContainer=(currentClassifyRelMsgId??scopeMessageId)!=='root';
  const totalNeeded = pts + recommendation + stakeFeeAmountRef.current
    +(inContainer?join.wager+join.recommendation+stakeFeeAmountRef.current:0);
  if (totalNeeded > availablePoints) {
    const parts = [`真假 ${pts}`, `协议费 ${stakeFeeAmountRef.current}`];
    if (recommendation > 0) parts.push(`价值 ${recommendation}`);
    if (inContainer) parts.push(`加入消息 ${join.wager+join.recommendation+stakeFeeAmountRef.current}`);
    setSendError(`贡献点余额不足（可用 ${availablePoints}，需要 ${totalNeeded} 点 = ${parts.join(' + ')}）`);
    return null;
  }
  setSendError(null);
  try {
    const backendMsg = await api.createMessage(currentClassifyRelMsgId ?? scopeMessageId, { content: text, contentType: 'TEXT', stakeAmount: 0, wager: pts, selfAgree: pts > 0, recommendation,...(inContainer?{joinContribution:join}:{}) });
    operationLog('发送消息', `message=${backendMsg.id} length=${text.length} stake=${pts}`);
    const msg: DemoMessage = {
      id: backendMsg.id,
      revision: backendMsg.revision,
      parts: backendMsg.parts,
      executedStance: backendMsg.executedStance,
      spending: backendMsg.spending,
      state: backendMsg.state,
      author: backendMsg.createdBy.username,
      authorId: backendMsg.createdBy.id,
      createdAt: backendMsg.createdAt,
      content: backendMsg.content,
      kind: "normal",
    };
    setMessages(prev => [...prev, msg]);
    // Fetch real stake counts from backend (not optimistic)
    api.getMessageStakes(msg.id).then(s => {
      mergeStakeSnapshot(msg.id, s);
      setAuthorStakes(prev => ({ ...prev, [msg.id]: s.stakes.find(st => st.side === 'PRO' && st.user.username === msg.author)?.amount ?? 0 }));
    }).catch(() => { });
    // Reset to rule default
    setStakeAmount(minSelfStake);
    if (!overrideContent) setNewMessageContent("");
    if (dependencies.onCreated) dependencies.onCreated(msg.id);
    else scrollMsgToCenter(msg.id);
    window.dispatchEvent(new Event('points-refresh'));
    // The committed message/placement updates the existing canvas. Remounting
    // here briefly collapses its scroll range before final positioning.
    if (isInsideClassify && !dependencies.onCreated) setClassifyKey(key => key + 1);
    return msg;
  } catch (e) {
    api.cancelCommandBatch(e);
    if (await handleAuthError(e)) return null;
    const detail = e instanceof ApiError
      ? `${e.message}（HTTP ${e.status}，接口 ${e.path}${e.code ? `，错误码 ${e.code}` : ''}）`
      : (sendErrorMessage(e));
    setSendError(detail);
    setTimeout(() => setSendError(null), 4000);
    return null;
  }
}

interface AttachMessageToCurrentClassifyDependencies {
  isInsideClassify: boolean;
  currentClassifyRelMsgId: string | null;
  relationsRef: React.MutableRefObject<Relation[]>;
  createJoinRelationsForContainer: (containerId: string, _containerType: string, targetMids: Array<string | TargetRef>) => Promise<boolean>;
}

export async function attachMessageToCurrentClassify(dependencies: AttachMessageToCurrentClassifyDependencies, messageId: string): Promise<void> {
  const { isInsideClassify, currentClassifyRelMsgId, relationsRef, createJoinRelationsForContainer } = dependencies;
  if (!isInsideClassify || !currentClassifyRelMsgId || !messageId) return;
  const currentClassifyRel = relationsRef.current.find(r => r.id === currentClassifyRelMsgId);
  if (!currentClassifyRel) return;
  const joinType = currentClassifyRel.relationType?.toUpperCase() === 'SUMMARY' ? 'SUMMARY' : 'CLASSIFY';

  // A message sent inside a container is completed by one JOIN request:
  // source=container, target=message. The backend records the container
  // target in the same transaction as the JOIN message.
  await createJoinRelationsForContainer(currentClassifyRelMsgId, joinType, [messageId]);
}

interface RegisterCreatedRelationInCurrentClassifyDependencies {
  appendCreatedRelation: (backendRel: Relation) => Promise<null>;
}

export async function registerCreatedRelationInCurrentClassify(dependencies: RegisterCreatedRelationInCurrentClassifyDependencies, backendRel: Relation): Promise<string | null> {
  const { appendCreatedRelation } = dependencies;
  // The server records placement with the message in one transaction.
  return appendCreatedRelation(backendRel);
}
