import { bindRoles, type Change, type Message, type Reference } from '@gonglun/core';
import { Mutation, now, type Store } from '../../server/src/db.js';

/** Repair placement with a new revision; the original migration journal and funds stay intact. */
export async function migrateReviewEnrollmentAttachments(store: Store): Promise<number> {
  const rows = await store.db.prepare(`SELECT body FROM messages WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(body::jsonb->'parts') part
    WHERE part->>'relation'='review-enrollment'
  ) ORDER BY sequence,id`).all<{body:string}>();
  const tx = new Mutation(store);
  for (const row of rows) {
    const message = JSON.parse(row.body) as Message;
    const enrollment = message.parts.find(part => part.type === 'relation' && part.relation === 'review-enrollment');
    if (enrollment?.type !== 'relation' || enrollment.roles.target?.length) continue;
    const data = message.parts.find(part => part.type === 'data' && part.value && typeof part.value === 'object'
      && !Array.isArray(part.value) && part.value.migration === 'content-moderation');
    const ids = data?.type === 'data' ? (data.value as {messageIds?:unknown}).messageIds : undefined;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string'))
      throw new Error(`审核迁移记录缺少原始目标：${message.id}`);
    const journal = await store.db.prepare('SELECT body FROM changes WHERE sequence=$1').get<{body:string}>(message.sequence);
    if (!journal) throw new Error(`审核迁移记录缺少原始执行历史：${message.id}`);
    const change = JSON.parse(journal.body) as Change;
    const versions = new Map(change.states.map(state => [state.messageId, state.revision]));
    const cases = await store.db.prepare('SELECT "messageId",revision FROM moderation_cases WHERE "messageId"=ANY($1::text[])')
      .all<{messageId:string;revision:number}>(ids);
    const targets: Reference[] = [];
    for (const messageId of new Set(ids as string[])) {
      // Early batches also included generated assignment records in tx.affected.
      const reviews = cases.filter(review => review.messageId === messageId);
      if (!reviews.length) continue;
      const revision = versions.get(messageId);
      if (!reviews.some(review => review.revision === revision))
        throw new Error(`审核迁移记录无法确认原始目标版本：${message.id} → ${messageId}`);
      targets.push({messageId, revision: revision!});
    }
    if (!targets.length) throw new Error(`审核迁移记录没有可恢复的审核目标：${message.id}`);
    await tx.put({...message, revision:message.revision + 1, updatedAt:now(), parts:message.parts.map(part =>
      part === enrollment ? {...part, roles:{...part.roles, ...bindRoles({target:targets})}} : part)});
  }
  if (tx.messages.size) await tx.commit();
  return tx.messages.size;
}
