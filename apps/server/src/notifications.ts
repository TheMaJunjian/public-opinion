import { relations, textOf, type Change, type Message, type Reference, type NotificationCategory,
  type NotificationContent, type NotificationItem, type NotificationPage, type NotificationQuery,
  type NotificationSeenInput, type NotificationDeleteInput, type NotificationSummary } from '@gonglun/core';
import { z } from 'zod';
import { DomainError, type Store } from './db.js';
import {membershipNotifications,type MembershipNotification} from './notification-memberships.js';

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const notificationQuerySchema = z.object({
  category: z.enum(['all', 'direct', 'following', 'financial']).optional(),
  unread: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
  cursor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  through: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
export const notificationSeenSchema = z.object({
  through: safeInteger, ids: z.array(safeInteger).min(1).max(100).optional(),
  category: z.enum(['all', 'direct', 'following', 'financial']).optional(),
}).strict();
export const notificationDeleteSchema = notificationSeenSchema.extend({seenOnly:z.boolean().optional()})
  .refine(input=>Boolean(input.ids?.length)||input.seenOnly===true,'请选择通知或仅清除已查看通知');
export const notificationMuteSchema = z.object({ targetId: z.string().min(1).max(100), muted: z.boolean() }).strict();
export const notificationRecipientsSchema = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(50) }).strict();

const directActions: Record<string, string> = {
  reply: '回复了消息', reference: '引用了消息', annotation: '注释了消息', evidence: '补充了证据',
  correct: '提出了更正', amend: '提出了修改', notify: '邀请你查看',
  agree: '赞同了消息', disagree: '反对了消息', recommend: '推荐了消息',
  fulfill: '提交了委托完成说明', terminate: '发起了结算截止',
  'member-of': '添加了新成员消息',
};
const quietRelations = new Set(['follow', 'unfollow', 'block', 'unblock', 'read', 'unread', 'archive', 'unarchive']);
const highFrequency = new Set(['agree', 'disagree', 'recommend', 'tag']);
const priority: Record<NotificationCategory, number> = { following: 0, direct: 1, financial: 2 };
const excerpt = (message: Message) => textOf(message).replace(/\s+/g, ' ').slice(0, 180);
function dataOf(message: Message): Record<string, unknown> {
  const data = message.parts.find(part => part.type === 'data');
  return data?.type === 'data' && data.value && typeof data.value === 'object' && !Array.isArray(data.value) ? data.value : {};
}

/** Traverse ancestors at event time, so later moves/unfollows cannot rewrite recipients. */
async function followers(store: Store, ids: string[]) {
  if (!ids.length) return [];
  return store.db.prepare(`WITH RECURSIVE scopes(id) AS (
    SELECT unnest($1::text[]) UNION SELECT m."parentId" FROM memberships m JOIN scopes s ON m."memberId"=s.id
  ) SELECT DISTINCT p."authorId" AS "userId",p."targetId" FROM personal_marks p
    JOIN scopes s ON s.id=p."targetId" JOIN users u ON u.id=p."authorId"
    WHERE p.family='follow' AND p.action='follow'`).all<{userId: string; targetId: string}>(ids);
}

/** Shared by sending previews and authoritative explicit-notification receipts. */
export async function notificationRecipients(store: Store, targetIds: string[], senderId: string) {
  const rows = await store.db.prepare('SELECT id,"authorId" FROM messages WHERE id=ANY($1::text[])').all<{id:string;authorId:string}>(targetIds);
  if (rows.length !== new Set(targetIds).size) throw new DomainError('通知目标消息不存在', 404);
  const candidates: Array<{userId:string;scopes:Set<string>}> = [];
  for (const target of rows) {
    const audience = new Map<string,Set<string>>([[target.authorId,new Set([target.id])]]);
    for (const follower of await followers(store,[target.id])) {
      const scopes=audience.get(follower.userId)??new Set([target.id]);
      scopes.add(follower.targetId);audience.set(follower.userId,scopes);
    }
    for(const [userId,scopes] of audience)if(userId!==senderId&&userId!=='system')candidates.push({userId,scopes});
  }
  if(!candidates.length)return [];
  const blocked=await store.db.prepare(`SELECT "userId","targetId" FROM notification_preferences WHERE muted AND "userId"=ANY($1::text[]) AND "targetId"=ANY($2::text[])
    UNION SELECT "authorId" AS "userId","targetId" FROM personal_marks WHERE family='block' AND action='block' AND "authorId"=ANY($1::text[]) AND "targetId"=ANY($2::text[])`)
    .all<{userId:string;targetId:string}>([...new Set(candidates.map(candidate=>candidate.userId))],[...new Set(candidates.flatMap(candidate=>[...candidate.scopes]))]);
  const ids=new Set(candidates.filter(candidate=>!blocked.some(row=>row.userId===candidate.userId&&candidate.scopes.has(row.targetId))).map(candidate=>candidate.userId));
  return store.db.prepare('SELECT id,name AS username FROM users WHERE id=ANY($1::text[]) ORDER BY name,id')
    .all<{id:string;username:string}>([...ids]);
}

type Audience = { category: NotificationCategory; reference: Reference; reasons: Set<string>; watchedIds: Set<string> };

/** Called inside the business transaction, including scheduled settlements. Idempotent per source revision. */
export async function recordNotifications(store: Store, change: Change) {
  if (!change.messages.length&&!change.states.length) return;
  // Historical migrations do not replay deliveries. Version 32 enables the inbox at a precise boundary.
  if (!await store.db.prepare("SELECT 1 FROM settings WHERE key='notifications-start-sequence'").get()) return;
  const membershipEvents=await membershipNotifications(store,change);
  const events:Array<{message:Message;membership?:MembershipNotification}>=[
    ...change.messages.filter(message=>!membershipEvents.some(event=>event.message.id===message.id&&event.previousActive===undefined)).map(message=>({message})),
    ...membershipEvents.map(membership=>({message:membership.message,membership})),
  ];
  const operation=change.messages.find(message=>message.revision===1&&message.authorId!=='system');
  for (const {message,membership} of events) {
    const parts = relations(message).filter(part => !quietRelations.has(part.relation));
    const data = dataOf(message);
    const inputs = data.inputs && typeof data.inputs === 'object' ? data.inputs as Record<string, unknown> : {};
    const distribution = parts.some(part => part.relation === 'distribution') && message.authorId === 'system';
    // Ordinary messages may contain arbitrary metadata; only system payouts
    // can qualify for the automatic usage-contribution notification exemption.
    if (distribution && typeof inputs.reason === 'string' && inputs.reason.startsWith('usage-')) continue;
    const actorId = membership ? operation?.authorId??'system' : message.revision > 1 ? operation?.authorId ?? message.authorId : message.authorId;
    if (message.authorId === 'system' && !distribution) continue;
    if (!parts.length && relations(message).length) continue;

    // Inline placement produces a canonical JOIN record in the same transaction.
    // Deliver that one record, including the new member's body, instead of two alerts.
    if(parts.some(part=>part.relation==='member-of'&&!part.roles.member?.length)
      && parts.every(part=>part.relation==='member-of'||part.id==='self-stance')
      && change.memberships.some(item=>item.memberId===message.id&&item.sourceId!==message.id))continue;

    const primary = parts.find(part => part.relation === 'notify') ?? (membership?parts.find(part=>part.relation==='member-of'):undefined) ?? parts.find(part => directActions[part.relation]) ?? parts[0];
    const kind = membership?'member-of':distribution ? String(data.source ?? 'distribution') : message.revision > 1 ? 'updated' : primary?.relation ?? 'message';
    const references = [...(membership?[{messageId:membership.parentId},{messageId:membership.memberId}]:[]),...parts.flatMap(part => (part.roles.target ?? []).map(binding => binding.reference))]
      .filter(reference => reference.messageId !== message.id);
    const relatedIds = [...new Set([message.id, ...parts.flatMap(part => Object.values(part.roles).flat().map(binding => binding.reference.messageId))])];
    const audience = new Map<string, Audience>();
    function add(userId: string, category: NotificationCategory, reference: Reference, reason: string, watchedId?: string) {
      if (userId === 'system' || userId === actorId && category !== 'financial') return;
      let recipient = audience.get(userId);
      if (!recipient) {
        recipient = { category, reference, reasons: new Set(), watchedIds: new Set() };
        audience.set(userId, recipient);
      } else if (priority[category] > priority[recipient.category]) { recipient.category = category; recipient.reference = reference; }
      recipient.reasons.add(reason);
      if (watchedId) recipient.watchedIds.add(watchedId);
    }
    if(message.revision>1&&!membership)add(message.authorId,'direct',{messageId:message.id},'你的消息正文已更新');
    if(membership){
      const parent=await store.message(membership.parentId);
      add(parent.authorId,'direct',{messageId:parent.id},relations(parent).some(part=>part.relation==='classify')?'你创建了这个分类':'你创建了这个组织');
      const member=await store.message(membership.memberId);
      add(member.authorId,'direct',{messageId:parent.id},'你是成员消息的作者');
      if(membership.previousActive!==undefined)add(message.authorId,'direct',{messageId:parent.id},'你创建了这条加入记录');
    }
    for (const part of message.revision===1&&!membership?parts:[]) {
      if (!directActions[part.relation]) continue;
      for (const binding of part.roles.target ?? []) {
        const original = await store.message(binding.reference.messageId);
        add(original.authorId, part.relation === 'fulfill' ? 'financial' : 'direct', binding.reference,
          part.relation === 'notify' ? '有人邀请你查看' : part.relation === 'fulfill' ? '你发布了这项委托' : '你是目标消息的作者');
        if (part.relation === 'notify') {
          for (const recipient of await notificationRecipients(store, [original.id], message.authorId)) {
            add(recipient.id, 'direct', binding.reference, '有人邀请你查看');
          }
        }
      }
    }
    for (const follower of await followers(store, relatedIds)) {
      add(follower.userId, 'following', references[0] ?? {messageId: message.id}, '你关注了相关消息或分类', follower.targetId);
    }
    const financialEntries = distribution ? change.ledger.filter(entry => entry.messageId === message.id) : [];
    for (const entry of financialEntries) add(entry.userId, 'financial', references[0] ?? {messageId:message.id}, '本次结果影响了你的贡献点');
    if (!audience.size) continue;
    const users=await store.db.prepare('SELECT id,name FROM users WHERE id=ANY($1::text[])').all<{id:string;name:string}>([...audience.keys(),actorId]);
    const names=new Map(users.map(user=>[user.id,user.name]));
    for(const recipient of audience.keys())if(!names.has(recipient))audience.delete(recipient);
    if(!audience.size)continue;
    const actorName = actorId === 'system' ? '公论规则' : names.get(actorId) ?? actorId;
    const member=membership?await store.message(membership.memberId):undefined;
    const financialActions: Record<string,string> = { wager:'结算已完成', reversal:'结算或分配结果已调整', delegation:'委托报酬已处理', penalty:'评价处罚已执行', operations:'运营收入已分配', grant:'贡献点已发放' };
    let roundId = typeof inputs.roundId === 'string' ? inputs.roundId : undefined;
    if(!roundId&&distribution&&typeof inputs.distributionId==='string'){
      const parent=dataOf(await store.message(inputs.distributionId));
      const parentInputs=parent.inputs as Record<string,unknown>|undefined;
      if(typeof parentInputs?.roundId==='string')roundId=parentInputs.roundId;
    }
    const round = roundId ? await store.db.prepare('SELECT body FROM rounds WHERE id=$1').get<{body:string}>(roundId) : undefined;
    const roundBody=round?JSON.parse(round.body):undefined;
    const settlementType = roundBody ? roundBody.settlementType === 'VALUE' ? 'VALUE' as const : 'TRUTH' as const : undefined;
    const settlementTargetId=roundBody?.subjectId??roundBody?.target?.messageId;
    for (const [userId, recipient] of audience) {
      const mutedIds = [...new Set([recipient.reference.messageId, ...recipient.watchedIds, ...(membership?[membership.memberId]:[])])];
      if (recipient.category !== 'financial') {
        const blocked = await store.db.prepare(`SELECT 1 FROM personal_marks WHERE "authorId"=$1 AND family='block' AND action='block' AND "targetId"=ANY($2::text[])
          UNION ALL SELECT 1 FROM notification_preferences WHERE "userId"=$1 AND muted AND "targetId"=ANY($3::text[]) LIMIT 1`)
          .get(userId, [message.id, ...mutedIds], mutedIds);
        if (blocked) continue;
      }
      const target = recipient.reference.messageId === message.id ? message : await store.message(recipient.reference.messageId, recipient.reference.revision);
      const entries = financialEntries.filter(entry => entry.userId === userId);
      const body: NotificationContent = {
        actorName, action: membership ? membership.active ? membership.previousActive===undefined?'加入已生效':'加入已恢复' : membership.previousActive===undefined?'加入未生效':'加入已失效'
          : distribution ? financialActions[kind] ?? '资金记录已更新' : kind === 'updated' ? '更新了消息正文' : directActions[kind] ?? '有新的讨论进展',
        excerpt: excerpt(member??message), targetExcerpt: excerpt(target), sourceRevision: message.revision,
        references: [...new Map([recipient.reference, ...references].map(reference => [JSON.stringify(reference), reference])).values()],
        reasons: [...recipient.reasons], watchedIds: [...recipient.watchedIds],
        ...(membership?{membershipActive:membership.active,navigationId:membership.previousActive===undefined?membership.memberId:message.id}:{}),
        ...(roundId ? {roundId, settlementType, settlementTargetId} : {}),
        ...(entries.length ? { availableDelta: entries.reduce((sum, entry) => sum + entry.amount, 0), lockedDelta: entries.reduce((sum, entry) => sum + entry.lockedDelta, 0) } : {}),
      };
      const eventId = JSON.stringify(membership?.previousActive!==undefined?[message.id,'membership',change.sequence]:[message.id, message.revision]);
      const createdAt=membership?operation?.updatedAt??change.messages[0]?.updatedAt??message.updatedAt:message.updatedAt;
      // Only high frequency actions aggregate; exact event records remain available when expanded.
      const groupKey = highFrequency.has(kind) ? JSON.stringify([recipient.reference.messageId, kind, Math.floor(Date.parse(message.updatedAt) / 3600_000)]) : eventId;
      await store.db.prepare(`INSERT INTO notifications("userId","eventId","sourceId","targetId","actorId",category,kind,"groupKey","createdAt","changeSequence",body)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT("userId","eventId") DO NOTHING`)
        .run(userId,eventId,message.id,recipient.reference.messageId,actorId,recipient.category,kind,groupKey,createdAt,change.sequence,JSON.stringify(body));
    }
  }
}

export async function notificationSummary(store: Store, userId: string): Promise<NotificationSummary> {
  const row = await store.db.prepare(`SELECT (SELECT COUNT(*) FROM notifications WHERE "userId"=$1 AND "seenAt" IS NULL AND "deletedAt" IS NULL) AS "unseenCount",
    (SELECT COALESCE(MAX(id),0) FROM notifications WHERE "userId"=$1) AS through`)
    .get<{unseenCount:number;through:number}>(userId);
  return {...row!, sequence: await store.latestSequence()};
}

export async function notificationPage(store: Store, userId: string, query: NotificationQuery): Promise<NotificationPage> {
  const summary = await notificationSummary(store, userId);
  const through = Math.min(query.through ?? summary.through, summary.through);
  const rows = await store.db.prepare(`SELECT n.*,COALESCE(p.muted,false) AS muted FROM notifications n
    LEFT JOIN notification_preferences p ON p."userId"=n."userId" AND p."targetId"=n."targetId"
    WHERE n."userId"=$1 AND n."deletedAt" IS NULL AND n.id<=$2 AND ($3::bigint IS NULL OR n.id<$3)
    AND ($4='all' OR n.category=$4) AND (NOT $5::boolean OR n."seenAt" IS NULL)
    ORDER BY n.id DESC LIMIT $6`).all<{id:number;sourceId:string;targetId:string;actorId:string;category:NotificationCategory;kind:string;groupKey:string;createdAt:string;seenAt:string|null;muted:boolean;body:NotificationContent}>
    (userId, through, query.cursor ?? null, query.category ?? 'all', query.unread ?? false, (query.limit ?? 30) + 1);
  const items: NotificationItem[] = rows.slice(0, query.limit ?? 30).map(row => ({
    ...row.body, id:row.id, sourceId:row.sourceId, targetId:row.targetId, actorId:row.actorId, category:row.category,
    kind:row.kind, groupKey:row.groupKey, createdAt:row.createdAt, seenAt:row.seenAt, muted:row.muted,
  }));
  return {...summary, through, items, nextCursor: rows.length > items.length ? items.at(-1)!.id : null};
}

export async function markNotificationsSeen(store: Store, userId: string, input: NotificationSeenInput) {
  await store.db.prepare(`UPDATE notifications SET "seenAt"=COALESCE("seenAt",$2)
    WHERE "userId"=$1 AND id<=$3 AND ($4::bigint[] IS NULL OR id=ANY($4::bigint[])) AND ($5='all' OR category=$5)`)
    .run(userId,new Date().toISOString(),input.through,input.ids ?? null,input.category ?? 'all');
}

/** Keep the delivery tombstone so retries cannot resurrect a deleted notification. */
export async function deleteNotifications(store: Store, userId: string, input: NotificationDeleteInput) {
  await store.db.prepare(`UPDATE notifications SET "deletedAt"=COALESCE("deletedAt",$2)
    WHERE "userId"=$1 AND id<=$3 AND ($4::bigint[] IS NULL OR id=ANY($4::bigint[]))
    AND ($5='all' OR category=$5) AND (NOT $6::boolean OR "seenAt" IS NOT NULL)`)
    .run(userId,new Date().toISOString(),input.through,input.ids??null,input.category??'all',input.seenOnly??false);
}

export async function muteNotifications(store: Store, userId: string, targetId: string, muted: boolean) {
  await store.message(targetId);
  await store.db.prepare(`INSERT INTO notification_preferences("userId","targetId",muted) VALUES($1,$2,$3)
    ON CONFLICT("userId","targetId") DO UPDATE SET muted=excluded.muted`).run(userId,targetId,muted);
}
