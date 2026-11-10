import { isReviewAudit, reviewContextOf, reviewContextPart, sameReviewContext, selectReviewDiscussion,
  REVIEW_CONTEXT_RELATION, REVIEW_RECORD_RELATIONS, REVIEW_RELATIONS, type Message, type SendInput } from '@gonglun/core';
import { DomainError, type Store } from './db.js';
import { moderationCase, type ModerationCase } from './moderation.js';
import { assertMessageReadable } from './moderation-visibility.js';

/** Validate explicit scopes and inherit a single review scope from addressed
 * reasons. Normal discussion still pays its normal publication costs. */
export async function normalizeReviewDiscussion(store: Store, input: SendInput, userId: string): Promise<SendInput> {
  const markers = input.parts.filter(part => part.type === 'relation' && part.relation === REVIEW_CONTEXT_RELATION);
  let context = markers.length ? reviewContextOf(input) : undefined;
  if (markers.length && (markers.length !== 1 || !context || markers[0]!.type !== 'relation'
    || Object.keys(markers[0]!.roles).some(role => role !== 'target'))) throw new DomainError('审核讨论需要一个明确的完整消息版本');
  const audit = input.parts.some(part => part.type === 'relation' && REVIEW_RECORD_RELATIONS.has(part.relation));
  const referenced = new Map<string, Message>();
  for (const part of input.parts) {
    if (part.type !== 'relation' || REVIEW_RECORD_RELATIONS.has(part.relation) || part.relation === REVIEW_CONTEXT_RELATION) continue;
    for (const bindings of Object.values(part.roles)) for (const { reference } of bindings) {
      const key = `${reference.messageId}:${reference.revision ?? 'current'}`;
      if (!referenced.has(key)) referenced.set(key, await store.message(reference.messageId, reference.revision));
    }
    if (['correct', 'amend'].includes(part.relation)) for (const { reference } of part.roles.target ?? []) {
      const target = referenced.get(`${reference.messageId}:${reference.revision ?? 'current'}`)!;
      if (!isReviewAudit(target)) continue;
      const data = Object.assign({}, ...input.parts.flatMap(part => part.type === 'data' && part.value && typeof part.value === 'object' && !Array.isArray(part.value) ? [part.value] : []));
      const body = target.parts.find(part => part.id === reference.partId);
      const width = part.relation === 'correct' && data.correctionKind === 'WIDTH';
      if (!width && (part.relation !== 'correct' || body?.type !== 'text' || reference.memberId
        || reference.path?.length && (reference.path.length !== 1 || reference.path[0] !== 'text')))
        throw new DomainError('审核只能更正理由文字；改变判断请新增审核消息', 409);
    }
  }
  if (!context && !audit) {
    const inherited = [...referenced.values()].flatMap(message => { const scope = reviewContextOf(message); return scope ? [scope] : []; });
    if (inherited.length && inherited.every(scope => sameReviewContext(scope, inherited[0]))) context = inherited[0];
  }
  if (!context) return input;
  const review = await moderationCase(store, context.messageId, context.revision);
  if (!review) throw new DomainError('审核讨论的目标版本不存在', 404);
  await assertMessageReadable(store, context.messageId, userId, context.revision);
  if (audit) {
    const target = input.parts.find(part => part.type === 'relation' && REVIEW_RELATIONS.has(part.relation));
    if (target?.type === 'relation' && target.roles.target?.some(({reference}) => reference.messageId !== context!.messageId || reference.revision !== undefined && reference.revision !== context!.revision))
      throw new DomainError('审核操作与当前审核讨论的目标不一致');
    return { ...input, parts: input.parts.filter(part => !markers.includes(part)) };
  }
  if (markers.length) return input;
  if (input.parts.some(part => part.id === 'review-context')) throw new DomainError('审核讨论部件编号已被占用');
  return { ...input, parts: [...input.parts, reviewContextPart(context)] };
}

/** Follow indexed references from this case, without walking back through the
 * reviewed original into its ordinary discussion or another review case. */
export async function reviewDiscussionRecords(store: Store, review: ModerationCase): Promise<Message[]> {
  const rows = await store.db.prepare(`SELECT m.body FROM messages m JOIN refs r ON r."sourceId"=m.id WHERE r."targetId"=$1
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(m.body::jsonb->'parts') p WHERE p->>'relation'=ANY($2::text[])) ORDER BY m.sequence,m.id`)
    .all<{body: string}>(review.messageId, [...REVIEW_RECORD_RELATIONS, REVIEW_CONTEXT_RELATION]);
  const context = { messageId: review.messageId, revision: review.revision };
  const seeds = selectReviewDiscussion(rows.map(row => JSON.parse(row.body) as Message), context, review.id);
  if (!seeds.length) return [];
  const records = await store.db.prepare(`WITH RECURSIVE discussion(id) AS (
    SELECT unnest($1::text[]) UNION
    SELECT candidate.id FROM discussion host CROSS JOIN LATERAL (
      SELECT r."sourceId" AS id FROM refs r WHERE r."targetId"=host.id
      UNION SELECT binding.value #>> '{reference,messageId}' FROM messages source,
        jsonb_array_elements(source.body::jsonb->'parts') part,
        jsonb_array_elements(COALESCE(part.value #> '{roles,source}','[]'::jsonb)) binding
        WHERE source.id=host.id AND part.value->>'relation' IN ('reply','reference','annotation')
    ) candidate JOIN messages m ON m.id=candidate.id WHERE m.id<>$2
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.body::jsonb->'parts') part
        WHERE part->>'relation'=ANY($3::text[]))
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m.body::jsonb->'parts') part
        WHERE part->>'relation'='review-context' AND (part #>> '{roles,target,0,reference,messageId}'<>$2
          OR part #>> '{roles,target,0,reference,revision}'<>$4))
  ) SELECT m.body FROM discussion d JOIN messages m ON m.id=d.id ORDER BY m.sequence,m.id`)
    .all<{body: string}>(seeds.map(message => message.id), review.messageId, [...REVIEW_RECORD_RELATIONS], String(review.revision));
  return selectReviewDiscussion(records.map(row => JSON.parse(row.body) as Message), context, review.id);
}
