import { relations, type Change, type Membership, type Message } from '@gonglun/core';
import { Mutation, type Store } from '../../server/src/db.js';
import { retiredOrganizationIds, retiredOrganizationsKey } from '../../server/src/retired-organizations.js';
import { querySchema } from '../../server/src/query-schema.js';
import type {MigrationChange} from './migration-types.js';

/** Only the synthetic Topic itself has a legacyTopicId equal to its message ID. */
export function isConvertedTopic(message: Message): boolean {
  return relations(message).some(part => part.relation === 'classify') && message.parts.some(part =>
    part.type === 'data' && part.value && typeof part.value === 'object' && !Array.isArray(part.value)
    && (part.value.legacyTopicId === message.id || !!part.value.origin && typeof part.value.origin==='object'&&!Array.isArray(part.value.origin)
      && part.value.origin.kind==='topic-classification'&&part.value.origin.id===message.id) && part.value.uiType === 'CLASSIFY');
}

export async function planTopicRetirement(store: Pick<Store, 'db'>) {
  const retired = await retiredOrganizationIds(store);
  const messages = (await store.db.prepare('SELECT body FROM messages ORDER BY id').all())
    .map(row => JSON.parse(String(row.body)) as Message);
  const topicIds = messages.filter(message => isConvertedTopic(message) && !retired.has(message.id)).map(message => message.id);
  const releasedMemberships = await store.db.prepare(`SELECT "memberId","parentId","sourceId","sourcePartId","bindingId","sourceRevision"
    FROM memberships WHERE "parentId"=ANY($1::text[]) OR "memberId"=ANY($1::text[]) ORDER BY "memberId"`).all(topicIds);
  // Include legacy multi-target JOINs as well as native immutable JOIN messages.
  const retiredJoinIds = messages.filter(message => relations(message).some(part => {
    const hasTopic = (role: string) => part.roles[role]?.some(binding => topicIds.includes(binding.reference.messageId));
    return part.relation === 'member-of' && part.roles.member?.length && (hasTopic('parent') || hasTopic('member'))
      || part.relation === 'legacy-join' && hasTopic('source');
  }))
    .map(message => message.id);
  return { topicIds, releasedMemberships: releasedMemberships as unknown as Membership[], retiredJoinIds };
}

/** Called inside the same cross-process transaction as schema upgrades. No message is deleted or rewritten. */
export async function retireLegacyTopics(store: Store): Promise<MigrationChange | null> {
  const plan = await planTopicRetirement(store);
  if (!plan.topicIds.length) return null;
  await store.db.exec(querySchema);
  await store.set(retiredOrganizationsKey, [...new Set([...await retiredOrganizationIds(store), ...plan.topicIds])].sort());
  const tx = new Mutation(store);
  for (const membership of plan.releasedMemberships) {
    tx.removed.add(membership.memberId);
    tx.affected.add(membership.memberId);
    tx.affected.add(membership.parentId);
  }
  plan.topicIds.forEach(id => tx.affected.add(id));
  plan.retiredJoinIds.forEach(id => tx.affected.add(id));
  await store.db.prepare('DELETE FROM memberships WHERE "parentId"=ANY($1::text[]) OR "memberId"=ANY($1::text[])').run(plan.topicIds);
  // Keep the immutable action body and predecessor intact. Retirement is a separate, auditable state.
  await store.db.prepare("UPDATE membership_actions SET disabled=TRUE WHERE body->>'parentId'=ANY($1::text[]) OR body->>'memberId'=ANY($1::text[])").run(plan.topicIds);
  const change:MigrationChange = await tx.commit();
  change.upgrade = { kind: 'retire-legacy-topics', version: 1, ...plan };
  await store.db.prepare('UPDATE changes SET body=$1 WHERE sequence=$2').run(JSON.stringify(change), change.sequence);
  return change;
}
