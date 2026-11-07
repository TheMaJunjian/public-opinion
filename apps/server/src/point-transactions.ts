import { z } from 'zod';
import { RELATION_LABELS } from '@gonglun/core';
import { integer, type Store } from './db.js';
import { dataOf } from './economy.js';
import { contentView, parentOf, primaryRelation } from './ui-projections.js';

const pagination = z.object({
  page: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
type TransactionRow = {
  id: string; amount: number; position: number; count: number; day: string | null;
  createdAt: string; reason: string; messageId: string; messageRevision: number;
  lockedDelta: number; ruleVersion: number; balanceAfter: number;
  messages: Array<{ messageId: string; revision: number }>;
};

/** Group recurring rewards before pagination; retain the immutable ledger for audit and exports. */
export async function pointTransactions(store: Store, userId: string, query: unknown) {
  const { page, limit } = pagination.parse(query), offset = integer((page - 1) * limit, '分页位置');
  const start = await store.setting<{ ledgerPosition: number }>('usage-points-start');
  const result = await store.db.prepare(`WITH entries AS (
    SELECT l.id,l."userId",l."messageId",l.amount,l."lockedDelta",l.reason,l."createdAt",l."ruleVersion",l."messageRevision",l.position,
      COALESCE(l."balanceAfter",(SUM(amount) OVER (ORDER BY position))::bigint) AS "balanceAfter",
      CASE WHEN reason=ANY($3::text[]) AND amount>0 AND "lockedDelta"=0
        THEN to_char("createdAt"::timestamptz AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') END AS day
    FROM ledger l WHERE "userId"=$1 AND position>$2
  ), grouped AS (
    SELECT COALESCE('usage:'||day,id) AS id, MAX(position) AS position,
      SUM(amount)::bigint AS amount, SUM(CASE WHEN day IS NOT NULL THEN amount ELSE 1 END)::integer AS count,
      jsonb_agg(DISTINCT jsonb_build_object('messageId',"messageId",'revision',"messageRevision")) AS messages
    FROM entries GROUP BY COALESCE('usage:'||day,id)
  ), selected AS (
    SELECT g.*,e."createdAt",e.reason,e."messageId",e."messageRevision",e."lockedDelta",e."ruleVersion",e."balanceAfter",e.day
    FROM grouped g JOIN entries e USING(position) ORDER BY g.position DESC LIMIT $4 OFFSET $5
  ) SELECT (SELECT COUNT(*)::integer FROM grouped) AS total,
    COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.position DESC) FROM selected s),'[]'::jsonb) AS rows`)
    .get<{total:number;rows:TransactionRow[]}>(userId, start.ledgerPosition, ['使用公论计时奖励', '每日刷新等待补发', '使用奖励汇总', '使用公论计时贡献', '使用贡献汇总'], limit, offset);
  const describeMessage = async (reference: TransactionRow['messages'][number]) => {
    const message = await store.message(reference.messageId, reference.revision), relation = primaryRelation(message), value = dataOf(message);
    const inputs = value.inputs as Record<string, unknown> | undefined;
    const roundId = relation?.relation === 'distribution' && typeof inputs?.roundId === 'string' ? inputs.roundId : undefined;
    const messageType = relation
      ? RELATION_LABELS[relation.relation] ?? ({ 'open-settlement': '发起结算', settlement: '结算' } as Record<string, string>)[relation.relation] ?? relation.relation
      : message.parts.some(part => part.type === 'code') ? '代码' : message.parts.some(part => part.type === 'web') ? '网页' : '文本';
    const summary = (await contentView(store, message)).replace(/\s+/g, ' ').trim().slice(0, 240);
    return { messageId: message.id, messageRevision: reference.revision, messageType, summary, scopeMessageId: await parentOf(store, message.id), ...(roundId ? { roundId } : {}) };
  };
  const messageCache = new Map<string, ReturnType<typeof describeMessage>>();
  const data = await Promise.all((result?.rows ?? []).map(async row => {
    const amount = integer(Number(row.amount)), balanceAfter = integer(Number(row.balanceAfter));
    const messages = await Promise.all(row.messages.filter(reference => reference.messageId).map(reference => {
      const key = JSON.stringify(reference);
      if (!messageCache.has(key)) messageCache.set(key, describeMessage(reference));
      return messageCache.get(key)!;
    }));
    if (row.day) return {
      id: row.id, type: 'USAGE_REWARD', amount, balanceAfter, createdAt: row.createdAt, messages,
      data: { day: row.day, count: row.count },
    };
    return {
      id: row.id, userId, amount, balanceAfter, createdAt: row.createdAt, messages,
      lockedDelta: row.lockedDelta, reason: row.reason, messageId: row.messageId,
      messageRevision: row.messageRevision, ruleVersion: row.ruleVersion,
      type: row.lockedDelta > 0 ? 'LOCK' : row.lockedDelta < 0 ? 'UNLOCK' : amount < 0 ? 'SPEND' : 'TRANSFER',
      data: { reason: row.reason, messageId: row.messageId, messageRevision: row.messageRevision,
        scopeMessageId: messages[0]?.scopeMessageId ?? null,
        ...(messages[0]?.roundId ? { roundId: messages[0].roundId } : {}),
        lockedDelta: row.lockedDelta, ruleVersion: row.ruleVersion },
    };
  }));
  const total = result?.total ?? 0;
  return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
