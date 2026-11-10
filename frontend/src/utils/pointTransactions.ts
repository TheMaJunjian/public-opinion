import type { PointTransaction, PointTransactionMessage } from '../types';

/** Moderation may remove nested metadata while preserving the ledger source. */
export function transactionReferences(tx:PointTransaction):PointTransactionMessage[]{
  if(tx.messages?.length)return tx.messages;
  const data=tx.data,sourceId=tx.messageId??(typeof data?.messageId==='string'?data.messageId:undefined);
  return sourceId?[{messageId:sourceId,messageRevision:tx.messageRevision,
    messageType:typeof data?.messageType==='string'?data.messageType:'消息',
    scopeMessageId:typeof data?.scopeMessageId==='string'?data.scopeMessageId:'root',
    roundId:typeof data?.roundId==='string'?data.roundId:undefined}]:[];
}

export function transactionSummaryQuery(tx:PointTransaction){
  if(tx.type==='USAGE_REWARD'&&typeof tx.data?.day==='string')return {mode:'summary' as const,day:tx.data.day,limit:1};
  if(tx.operationId)return {mode:'summary' as const,operationId:tx.operationId,limit:1};
  const messageId=transactionReferences(tx)[0]?.messageId;
  return messageId?{mode:'summary' as const,messageId,limit:1}:undefined;
}

export const signedPoints=(amount:number)=>`${amount>=0?'+':''}${amount.toLocaleString()}`;
export const balanceChange=(entry:PointTransaction)=>`${(entry.balanceAfter-entry.amount).toLocaleString()} → ${entry.balanceAfter.toLocaleString()}`;

export function transactionReasonBreakdown(tx: PointTransaction) {
  if (tx.type === 'USAGE_REWARD' || ['使用公论计时奖励','每日刷新等待补发','使用奖励汇总','使用公论计时贡献','使用贡献汇总']
    .includes(tx.reason ?? String(tx.data?.reason ?? ''))) return [];
  const entries = tx.entries ?? tx.reasonDetails ?? (tx.reason || typeof tx.data?.reason === 'string' ? [tx] : []);
  const groups = new Map<string, { reason: string; entryCount: number; amount: number; lockedDelta: number }>();
  for (const entry of entries) {
    const reason = entry.reason ?? ('data' in entry ? String(entry.data?.reason ?? '收支记录') : '收支记录');
    const lockedDelta = entry.lockedDelta ?? 0;
    // A payment and its refund must stay visible even when their net is zero.
    const key = JSON.stringify([reason, Math.sign(entry.amount), Math.sign(lockedDelta)]);
    const group = groups.get(key) ?? { reason, entryCount: 0, amount: 0, lockedDelta: 0 };
    group.entryCount++; group.amount += entry.amount; group.lockedDelta += lockedDelta;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function pointsReasonExplanation(reason: string): string | undefined {
  const explanations: Record<string, string> = {
    '协议费': '发布正文或关系消息所收取的协议费用。',
    '对赌锁定': '立场投入（含消息自押）转入锁定，随对应的真假或价值结算处理。',
    '价值投入': '消息的价值投入，按发生时的规则计入运营资金。',
    '审核费冻结': '预留审核参与报酬，未使用的预算在审核结算时退还。',
    '审核自押冻结': '发布或申请复核时的审核自押，按对应立场参与审核结算。',
    '审核押注冻结': '参与审核时提交的立场押注，转入审核押注池。',
    '审核费支付': '释放已锁定的审核报酬预算，用于支付报酬及退还剩余预算。',
    '审核参与报酬': '参加审核获得的报酬，不随所选立场的输赢变化。',
    '未使用审核费退还': '审核报酬预算的未使用部分退回可用余额。',
    '审核押注解除锁定': '结算时移出审核押注池；实际到账另列结算记录。',
    '审核自押解除锁定': '结算时移出审核自押；实际到账另列结算记录。',
    '审核押注结算': '按审核结论和对应投入计算的结算到账。',
    '结束对赌锁定': '结算时解除立场投入的锁定；本金及收益另列结算记录。',
    '撤回先前对赌分配': '重新结算前撤回上次的结算到账。',
    '恢复先前对赌本金': '重新结算前恢复上次已结算的本金锁定。',
    '历史消息真假补扣': '为历史消息补齐当时要求的真假投入，并转入锁定。',
    '旧消息最低投入补扣': '为旧消息补齐最低投入，并按对应立场锁定。',
  };
  return explanations[reason];
}
