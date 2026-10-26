import { messageDisplayDependency, relations, type LedgerEntry, type Membership, type Message } from '@gonglun/core';
import { Mutation, type Store } from '../../server/src/db.js';

/** Explicit, one-time conversion. Runtime never repairs old placement records. */
export async function dependentMembershipRemovalPlan(store: Pick<Store, 'db'>) {
  const messages = (await store.db.prepare('SELECT body FROM messages ORDER BY id').all())
    .map(row => JSON.parse(String(row.body)) as Message);
  const dependent = new Set(messages.filter(message => messageDisplayDependency(message) !== null).map(message => message.id));
  const joinIds = messages.filter(message => relations(message).some(part => part.relation === 'member-of'
    && part.roles.member?.some(binding => dependent.has(binding.reference.messageId)))).map(message => message.id);
  const releasedMemberships = await store.db.prepare(`SELECT "memberId","parentId","sourceId","sourcePartId","bindingId","sourceRevision"
    FROM memberships WHERE "sourceId"=ANY($1::text[]) OR "memberId"=ANY($2::text[]) ORDER BY "memberId"`).all(joinIds, [...dependent]);
  return { joinIds, releasedMemberships: releasedMemberships as unknown as Membership[] };
}

/** Refund actual net charges and outstanding principal, including completed settlement payouts. */
export async function removeDependentMemberships(store: Store): Promise<number> {
  const plan = await dependentMembershipRemovalPlan(store);
  if (!plan.joinIds.length && !plan.releasedMemberships.length) return 0;
  const ids = plan.joinIds;
  const rounds = await store.db.prepare(`SELECT id,"targetKey",body::jsonb #>> '{target,messageId}' AS target FROM rounds
    WHERE COALESCE(body::jsonb->>'subjectId',body::jsonb #>> '{target,messageId}')=ANY($1::text[])`).all(ids);
  const keys = [...new Set(rounds.map(row => String(row.targetKey)))];
  const bets = await store.db.prepare('SELECT DISTINCT "messageId" FROM bets WHERE "targetKey"=ANY($1::text[])').all(keys);
  const outputs = (await store.db.prepare(`SELECT body FROM messages WHERE id IN
    (SELECT "sourceId" FROM refs WHERE "targetId"=ANY($1::text[]))`).all([...ids,...rounds.map(row=>String(row.target))]))
    .map(row => JSON.parse(String(row.body)) as Message)
    .filter(message => relations(message).some(part => part.relation === 'distribution')
      && message.parts.some(part => part.type === 'data' && part.value && typeof part.value === 'object'
        && !Array.isArray(part.value) && ['wager', 'reversal'].includes(String(part.value.source))))
    .map(message => message.id);
  const ledger = await store.db.prepare(`SELECT * FROM ledger WHERE "messageId"=ANY($1::text[])
    OR ("messageId"=ANY($2::text[]) AND reason IN ('对赌锁定','历史消息真假补扣')) ORDER BY position`)
    .all([...ids, ...outputs], bets.map(row => String(row.messageId)));
  const refunds = new Map<string, { amount: number; locked: number }>();
  for (const row of ledger) {
    const userId = String(row.userId), refund = refunds.get(userId) ?? { amount: 0, locked: 0 };
    refund.amount -= Number(row.amount); refund.locked -= Number(row.lockedDelta);
    refunds.set(userId, refund);
  }
  const tx = new Mutation(store);
  const start = store.db.ledger.length;
  for (const [userId, refund] of refunds) {
    if (refund.amount || refund.locked)
      await store.ledger(userId, ids[0]!, refund.amount, refund.locked, '附属消息旧加入记录删除退款', true);
  }
  await store.operating(-[...refunds.values()].reduce((sum, refund) => sum + refund.amount + refund.locked, 0), true);
  for (const membership of plan.releasedMemberships) {
    tx.removed.add(membership.memberId); tx.affected.add(membership.memberId); tx.affected.add(membership.parentId);
  }
  await store.db.prepare('DELETE FROM memberships WHERE "sourceId"=ANY($1::text[]) OR "memberId"=ANY($2::text[])')
    .run(ids, plan.releasedMemberships.map(row => row.memberId));
  await store.db.prepare('DELETE FROM membership_actions WHERE id=ANY($1::text[])').run(ids);
  await store.db.prepare('DELETE FROM bets WHERE "targetKey"=ANY($1::text[]) OR "messageId"=ANY($2::text[])').run(keys, ids);
  await store.db.prepare('DELETE FROM stake_positions WHERE "subjectId"=ANY($1::text[]) OR "roundId"=ANY($2::text[])').run(ids, rounds.map(row => String(row.id)));
  await store.db.prepare('DELETE FROM rounds WHERE id=ANY($1::text[])').run(rounds.map(row => String(row.id)));
  await store.db.prepare('DELETE FROM execution_stances WHERE "sourceId"=ANY($1::text[]) OR target::jsonb->>\'messageId\'=ANY($1::text[])').run(ids);
  await store.db.prepare('DELETE FROM display_stances WHERE "sourceId"=ANY($1::text[]) OR "targetId"=ANY($1::text[])').run(ids);
  await store.db.prepare('DELETE FROM refs WHERE "sourceId"=ANY($1::text[])').run(ids);
  for (const table of ['pool_checkpoints', 'message_state_checkpoints', 'settlement_access'])
    await store.db.prepare(`DELETE FROM ${table} WHERE "messageId"=ANY($1::text[])`).run(ids);
  await store.db.prepare('DELETE FROM messages WHERE id=ANY($1::text[])').run(ids);
  // Original versions and ledger entries remain auditable; current records are removed.
  const change = await tx.commit();
  change.removedMessageIds = ids;
  const audit: { deletedJoinIds: string[]; reversedLedgerIds: string[]; refundedLedger: LedgerEntry[] } = {
    deletedJoinIds: ids, reversedLedgerIds: ledger.map(row => String(row.id)), refundedLedger: store.db.ledger.slice(start),
  };
  await store.db.exec('CREATE TABLE IF NOT EXISTS dependent_membership_removals(sequence BIGINT PRIMARY KEY,body JSONB NOT NULL)');
  await store.db.prepare('INSERT INTO dependent_membership_removals VALUES($1,$2)').run(change.sequence, JSON.stringify(audit));
  await store.db.prepare('UPDATE changes SET body=$1 WHERE sequence=$2').run(JSON.stringify(change), change.sequence);
  return ids.length;
}
