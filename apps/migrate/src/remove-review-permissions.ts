import type { SendResult } from '@gonglun/core';
import { Mutation, type Store } from '../../server/src/db.js';
import type { Postgres } from '../../server/src/postgres.js';
import { pruneReviewPermissionHistory } from './prune-review-permission-history.js';
import { migrateAppealVisibility } from './appeal-visibility.js';

const oldPolicyKeys = ['stages', 'assignmentTtlMs', 'exposureMultiplier'];
const obsoleteNotices = `(category='review' AND kind IN ('review-assigned','review-revoked','review-expanded'))
  OR "sourceId"=ANY($1::text[]) OR "targetId"=ANY($1::text[])`;

async function obsoleteReviewMessageIds(db: Postgres, hasLedger = true): Promise<string[]> {
  const rows = await db.prepare(`SELECT id FROM messages m WHERE
    body::jsonb->'parts' @> '[{"type":"relation","relation":"reviewer-authorize"}]'
    OR ("authorId"='system' AND body::jsonb->'parts' @> '[{"type":"relation","relation":"review-record"}]'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(body::jsonb->'parts') p
        WHERE p->>'type'='data' AND (p->'value') ?| ARRAY['assigned','revoked','stageSize'])
      ${hasLedger ? 'AND NOT EXISTS (SELECT 1 FROM ledger WHERE "messageId"=m.id)' : ''}
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(body::jsonb->'parts') p
        WHERE p->>'type'='data' AND (p->'value') ?| ARRAY['verdict','payouts','releaseAt','previousSettlementId','migration']))
    ORDER BY id`).all<{id:string}>();
  return rows.map(row => row.id);
}

export async function reviewPermissionRemovalPlan(db: Postgres, tables: ReadonlySet<string>) {
  const ids = tables.has('messages') ? await obsoleteReviewMessageIds(db, tables.has('ledger')) : [];
  const count = tables.has('notifications')
    ? await db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${obsoleteNotices}`).get<{n:number}>(ids)
    : undefined;
  return {messages:ids.length, notifications:count?.n ?? 0};
}

/** Keep retry keys and genuine command outcomes when an old send also generated assignments. */
async function cleanReceipts(store: Store, ids: string[]) {
  const removed = new Set(ids);
  const rows = await store.db.prepare(`SELECT "userId","requestId",result FROM requests
    WHERE result::jsonb#>>'{message,id}'=ANY($1::text[]) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(result::jsonb#>'{change,messages}') m WHERE m->>'id'=ANY($1::text[]))`)
    .all<{userId:string;requestId:string;result:string}>(ids);
  for (const row of rows) {
    const result: SendResult = JSON.parse(row.result);
    result.change.messages = result.change.messages.filter(message => !removed.has(message.id));
    result.change.states = result.change.states.filter(state => !removed.has(state.messageId));
    result.change.memberships = result.change.memberships.filter(row =>
      !removed.has(row.sourceId) && !removed.has(row.memberId) && !removed.has(row.parentId));
    const message = removed.has(result.message.id) ? {id:result.message.id, removed:true} : result.message;
    await store.db.prepare('UPDATE requests SET result=$3 WHERE "userId"=$1 AND "requestId"=$2')
      .run(row.userId, row.requestId, JSON.stringify({...result, message}));
  }
  // Each result occupies the same slot as its original batch command.
  await store.db.prepare(`UPDATE command_requests SET result=jsonb_set(result::jsonb,'{results}',(
    SELECT jsonb_agg(CASE WHEN item->>'id'=ANY($1::text[])
      THEN jsonb_build_object('id',item->>'id','removed',true) ELSE item END ORDER BY position)
    FROM jsonb_array_elements(result::jsonb->'results') WITH ORDINALITY AS r(item,position)))::text
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(result::jsonb->'results') item
      WHERE item->>'id'=ANY($1::text[]))`).run(ids);
}

/** Run in the migration transaction. Ledger entries keep their original journal evidence. */
export async function removeReviewPermissions(store: Store): Promise<void> {
  const { db } = store;
  // Early v49 databases were stamped before the previous appeal verdict was recorded.
  if (!await db.prepare(`SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name='moderation_cases' AND column_name='appealFrom'`).get()) await migrateAppealVisibility(store);
  const rules = await store.rules();
  if (rules.moderation && oldPolicyKeys.some(key => key in rules.moderation!)) {
    const moderation = { ...rules.moderation };
    for (const key of oldPolicyKeys) Reflect.deleteProperty(moderation, key);
    await store.set('rules', { ...rules, moderation });
  }
  await db.prepare(`UPDATE rule_versions SET body=jsonb_set(body::jsonb,'{moderation}',
    (body::jsonb->'moderation')-$2::text[])::text WHERE version=$1 AND (body::jsonb->'moderation') ?| $2::text[]`)
    .run(rules.version, oldPolicyKeys);
  await db.prepare('UPDATE moderation_cases SET policy=policy-$1::text[] WHERE policy ?| $1::text[]').run(oldPolicyKeys);

  const tx = new Mutation(store);
  // Cached restricted bodies and their dependent views must be checked against the new access rule.
  const restricted = await db.prepare(`SELECT DISTINCT "messageId" FROM moderation_cases
    WHERE to_regclass('moderation_assignments') IS NOT NULL AND (
      status='appeal' AND COALESCE("appealFrom",'reject')='reject'
      OR status='rejected' AND settlement->>'finalized'='false')`).all<{messageId:string}>();
  for (const row of restricted) tx.affected.add(row.messageId);
  await db.exec(`DROP TABLE IF EXISTS moderation_assignments,moderation_candidate_preferences,moderation_reviewers;
    ALTER TABLE moderation_cases DROP COLUMN IF EXISTS stage,DROP COLUMN IF EXISTS "assignmentCheckAt";
    ALTER TABLE sessions DROP COLUMN IF EXISTS "lastActiveAt";`);

  const ids = await obsoleteReviewMessageIds(db);
  const prunedIds = await pruneReviewPermissionHistory(store, ids);
  await db.prepare(`DELETE FROM notifications WHERE ${obsoleteNotices}`).run(ids);
  await db.prepare(`UPDATE notifications SET body=jsonb_set(body,'{action}',to_jsonb($1::text))
    WHERE category='review' AND kind='review-reopened' AND body->>'action'=$2`)
    .run('已发起审核复核','已发起审核复核，重新分配本轮审核任务');
  if (ids.length) {
    await cleanReceipts(store, ids);
    const membershipFilter = '"sourceId"=ANY($1::text[]) OR "memberId"=ANY($1::text[]) OR "parentId"=ANY($1::text[])';
    const released = await db.prepare(`DELETE FROM memberships WHERE ${membershipFilter} RETURNING "memberId","parentId"`)
      .all<{memberId:string;parentId:string}>(ids);
    for (const row of released) {
      tx.removed.add(row.memberId);
      tx.affected.add(row.memberId);
      tx.affected.add(row.parentId);
    }
    await db.prepare(`DELETE FROM recommended_memberships WHERE ${membershipFilter}`).run(ids);
    await db.prepare(`DELETE FROM membership_actions WHERE id=ANY($1::text[])
      OR body->>'memberId'=ANY($1::text[]) OR body->>'parentId'=ANY($1::text[])`).run(ids);
    const links = await db.prepare('DELETE FROM refs WHERE "sourceId"=ANY($1::text[]) RETURNING "targetId"').all<{targetId:string}>(ids);
    for (const link of links) tx.affected.add(link.targetId);
    for (const table of ['notification_receipts','personal_actions','personal_marks','display_stances','feed_corrections']) {
      await db.prepare(`DELETE FROM ${table} WHERE "sourceId"=ANY($1::text[]) OR "targetId"=ANY($1::text[])`).run(ids);
    }
    for (const table of ['revisions','signatures','reading_marks','feed_hidden','message_state_checkpoints','notification_membership_states']) {
      await db.prepare(`DELETE FROM ${table} WHERE "messageId"=ANY($1::text[])`).run(ids);
    }
    await db.prepare('DELETE FROM notification_preferences WHERE "targetId"=ANY($1::text[])').run(ids);
    await db.prepare('DELETE FROM moderation_dependencies WHERE "sourceId"=ANY($1::text[])').run(ids);
    await db.prepare('DELETE FROM execution_stances WHERE "sourceId"=ANY($1::text[])').run(ids);
    await db.prepare('DELETE FROM feed_entries WHERE id=ANY($1::text[])').run(ids);
    await db.prepare('DELETE FROM messages WHERE id=ANY($1::text[])').run(ids);
  }
  if (ids.length || tx.affected.size) {
    const change = await tx.commit();
    if (ids.length) {
      change.removedMessageIds = ids;
      if (prunedIds.length) change.prunedMessageIds = prunedIds;
      await db.prepare('UPDATE changes SET body=$1 WHERE sequence=$2').run(JSON.stringify(change), change.sequence);
    }
  }
}
