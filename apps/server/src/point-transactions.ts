import { z } from 'zod';
import { RELATION_LABELS, type Message } from '@gonglun/core';
import { integer, type Store } from './db.js';
import { dataOf } from './economy.js';
import { contentView, parentOf, primaryRelation } from './ui-projections.js';
import { valueSubjects } from './value-subjects.js';

const pagination = z.object({
  page: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  mode: z.enum(['history','summary']).default('history'),
  messageId: z.string().min(1).max(200).optional(),
  operationId: z.string().min(1).max(200).optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
type TransactionRow = {
  id: string; amount: number; position: number; count: number; day: string | null;
  createdAt: string; reason: string; messageId: string; messageRevision: number;
  lockedDelta: number; ruleVersion: number; balanceAfter: number;
  lockedTotal: number; operationId: string | null;
  entries: Array<Omit<TransactionRow,'messages'|'entries'|'lockedTotal'|'count'|'day'>> | null;
  messages: Array<{ messageId: string; revision: number }>;
};

/** Group committed operations before pagination; daily usage remains a separate aggregate. */
export async function pointTransactions(store: Store, userId: string, query: unknown) {
  const { page, limit, mode, messageId, day, operationId } = pagination.parse(query), offset = integer((page - 1) * limit, '分页位置');
  const start = await store.setting<{ ledgerPosition: number }>('usage-points-start');
  const result = await store.db.prepare(`WITH entries AS (
    SELECT l.id,l."userId",l."messageId",l.amount,l."lockedDelta",l.reason,l."createdAt",l."ruleVersion",l."messageRevision",l.position,o."operationId",
      COALESCE(l."balanceAfter",(SUM(amount) OVER (ORDER BY position))::bigint) AS "balanceAfter",
      CASE WHEN reason=ANY($3::text[]) AND amount>0 AND "lockedDelta"=0
        THEN to_char("createdAt"::timestamptz AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') END AS day
    FROM ledger l LEFT JOIN ledger_operations o ON o."entryId"=l.id WHERE l."userId"=$1 AND position>$2
  ), keyed AS (
    SELECT e.*,COALESCE('usage:'||day,CASE WHEN NOT $6::boolean OR $9::text IS NOT NULL THEN 'operation:'||"operationId" END,
      CASE WHEN $6::boolean THEN 'message:'||NULLIF("messageId",'') END,id) AS key FROM entries e
    WHERE ($7::text IS NULL OR ("messageId"=$7 AND day IS NULL)) AND ($8::text IS NULL OR day=$8)
      AND ($9::text IS NULL OR ("operationId"=$9 AND day IS NULL))
  ), grouped AS (
    SELECT key AS id, (array_agg(position ORDER BY "createdAt"::timestamptz DESC,position DESC))[1] AS position,
      MAX("createdAt"::timestamptz) AS "latestAt",
      SUM(amount)::bigint AS amount, SUM(CASE WHEN day IS NOT NULL THEN amount ELSE 1 END)::integer AS count,
      SUM("lockedDelta")::bigint AS "lockedTotal",
      jsonb_agg(to_jsonb(e)-'key' ORDER BY "createdAt"::timestamptz DESC,position DESC) FILTER(WHERE day IS NULL) AS entries,
      jsonb_agg(jsonb_build_object('messageId',"messageId",'revision',"messageRevision") ORDER BY position) AS messages
    FROM keyed e GROUP BY key
  ), selected AS (
    SELECT g.*,e."createdAt",e.reason,e."messageId",e."messageRevision",e."lockedDelta",e."ruleVersion",e."balanceAfter",e.day,e."operationId"
    FROM grouped g JOIN entries e USING(position) ORDER BY g."latestAt" DESC,g.position DESC LIMIT $4 OFFSET $5
  ) SELECT (SELECT COUNT(*)::integer FROM grouped) AS total,
    COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s."latestAt" DESC,s.position DESC) FROM selected s),'[]'::jsonb) AS rows`)
    .get<{total:number;rows:TransactionRow[]}>(userId, start.ledgerPosition, ['使用公论计时奖励', '每日刷新等待补发', '使用奖励汇总', '使用公论计时贡献', '使用贡献汇总'], limit, offset, mode==='summary', messageId??null, day??null, operationId??null);
  const describeMessage = async (message: Message) => {
    const relation = primaryRelation(message), value = dataOf(message);
    const inputs = value.inputs as Record<string, unknown> | undefined;
    const roundId = relation?.relation === 'distribution' && typeof inputs?.roundId === 'string' ? inputs.roundId : undefined;
    const messageType = relation
      ? RELATION_LABELS[relation.relation] ?? ({ 'open-settlement': '发起结算', settlement: '结算' } as Record<string, string>)[relation.relation] ?? relation.relation
      : message.parts.some(part => part.type === 'code') ? '代码' : message.parts.some(part => part.type === 'web') ? '网页' : '文本';
    const content = (await contentView(store, message)).replace(/\s+/g, ' ').trim();
    const summary = mode==='summary'?content:content.slice(0, 240);
    return { messageId: message.id, messageRevision: message.revision, messageType, summary, scopeMessageId: await parentOf(store, message.id), ...(roundId ? { roundId } : {}) };
  };
  const describeRelatedMessages = async (reference: TransactionRow['messages'][number]) => {
    const source = await store.message(reference.messageId, reference.revision), relation = primaryRelation(source);
    const targets = relation?.relation === 'distribution' ? (relation.roles.target ?? []).map(binding => binding.reference) : [];
    const subjects = await valueSubjects(store, targets);
    // Keep the ledger source first for detail queries, followed by its logical targets.
    const seen = new Set([source.id]), messages = [source];
    for (const target of subjects.values()) {
      if (seen.has(target.messageId)) continue;
      seen.add(target.messageId);
      messages.push(await store.message(target.messageId, target.revision));
    }
    return Promise.all(messages.map(describeMessage));
  };
  const messageCache = new Map<string, ReturnType<typeof describeRelatedMessages>>();
  const data = await Promise.all((result?.rows ?? []).map(async row => {
    const amount = integer(Number(row.amount)), balanceAfter = integer(Number(row.balanceAfter));
    const operation = row.id === `operation:${row.operationId}`;
    const references=row.day||operation?row.messages:[{messageId:row.messageId,revision:row.messageRevision}];
    const uniqueReferences=[...new Map(references.filter(reference=>reference.messageId).map(reference=>[JSON.stringify(reference),reference])).values()];
    const described = (await Promise.all(uniqueReferences.map(reference => {
      const key = JSON.stringify(reference);
      if (!messageCache.has(key)) messageCache.set(key, describeRelatedMessages(reference));
      return messageCache.get(key)!;
    }))).flat();
    const messages=[...new Map(described.map(message=>[`${message.messageId}:${message.messageRevision}`,message])).values()];
    if (row.day) return {
      id: row.id, type: 'USAGE_REWARD', amount, balanceAfter, createdAt: row.createdAt, messages,
      data: { day: row.day, count: row.count },
    };
    // Retain source identities until response sanitization has run. The client
    // groups these economic reasons after restricted metadata is removed.
    const reasonDetails = row.entries!.map(entry => ({ messageId: entry.messageId, messageRevision: entry.messageRevision,
      reason: entry.reason, amount: Number(entry.amount), lockedDelta: Number(entry.lockedDelta) }));
    if (operation) return {
      id:row.id,operationId:row.operationId!,userId,type:'OPERATION_GROUP',amount,balanceAfter,
      createdAt:row.createdAt,lockedDelta:Number(row.lockedTotal),entryCount:row.count,messages,reasonDetails,
      ...(mode==='summary'?{entries:row.entries!.map(entry=>({
        id:entry.id,messageId:entry.messageId,messageRevision:entry.messageRevision,createdAt:entry.createdAt,
        amount:Number(entry.amount),lockedDelta:Number(entry.lockedDelta),balanceAfter:Number(entry.balanceAfter),reason:entry.reason,
        type:entry.lockedDelta>0?'LOCK':entry.lockedDelta<0?'UNLOCK':entry.amount<0?'SPEND':'TRANSFER',
      }))}:{}),
    };
    const grouped=row.count>1;
    return {
      id: row.id, userId, amount, balanceAfter, createdAt: row.createdAt, messages,reasonDetails,
      lockedDelta: Number(row.lockedTotal), reason: row.reason, messageId: row.messageId,
      messageRevision: row.messageRevision, ruleVersion: row.ruleVersion,
      type: grouped?'MESSAGE_GROUP':row.lockedDelta > 0 ? 'LOCK' : row.lockedDelta < 0 ? 'UNLOCK' : amount < 0 ? 'SPEND' : 'TRANSFER',
      ...(grouped?{entryCount:row.count,entries:row.entries!.map(entry=>({
        id:entry.id,messageId:entry.messageId,messageRevision:entry.messageRevision,createdAt:entry.createdAt,
        amount:Number(entry.amount),lockedDelta:Number(entry.lockedDelta),balanceAfter:Number(entry.balanceAfter),reason:entry.reason,
        type:entry.lockedDelta>0?'LOCK':entry.lockedDelta<0?'UNLOCK':entry.amount<0?'SPEND':'TRANSFER',
      }))}:{}),
      data: { reason: row.reason, messageId: row.messageId, messageRevision: row.messageRevision,
        scopeMessageId: messages[0]?.scopeMessageId ?? null,
        ...(messages[0]?.roundId ? { roundId: messages[0].roundId } : {}),
        lockedDelta: Number(row.lockedTotal), ruleVersion: row.ruleVersion },
    };
  }));
  const total = result?.total ?? 0;
  return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
