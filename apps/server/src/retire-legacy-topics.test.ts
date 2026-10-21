import { afterEach, expect, it } from 'vitest';
import { bindRoles, replayArchive, resolveMemberships, type Membership } from '@gonglun/core';
import { Mutation } from './db.js';
import { applyOrganization, reconcileOrganizationEffects, validateJoinApproval } from './organizations.js';
import { planTopicRetirement, retireLegacyTopics } from './retire-legacy-topics.js';
import { statesFor, recordStance } from './projections.js';
import { viewsFor, parentOf, snapshot } from './ui-projections.js';
import { createTestStore, cleanupTestDatabases } from './test-database.js';
import { convertMessagesToDemoModel } from '../../../frontend/src/utils/modelBridge.js';
import { deriveContainerEffect } from '../../../frontend/src/pages/workbench/model/containerEffect.js';
import { projectContainerCanvas } from '../../../frontend/src/pages/workbench/projections/containerCanvas.js';
import { indexRelatedMessages } from '../../../frontend/src/utils/relatedMessages.js';

afterEach(cleanupTestDatabases);

async function fixture() {
  const store = await createTestStore();
  await store.transaction(async () => {
    const tx = new Mutation(store);
    for (const id of ['topic-a', 'topic-b', 'inside', 'outside']) {
      await tx.create('system', [{ id: 'body', type: 'text', text: id }, { id: 'relation', type: 'relation', relation: 'classify', roles: {} },
        { id: 'data', type: 'data', value: { kind: 'RELATION', uiType: 'CLASSIFY', legacyTopicId: id.startsWith('topic-') ? id : 'topic-a', legacyTitle: id } }], undefined, id);
    }
    for (const id of ['direct', 'leaf', 'moved', 'cross-topic']) await tx.create('system', [{ id: 'body', type: 'text', text: id }], undefined, id);
    const memberships: Membership[] = [
      { memberId: 'direct', parentId: 'topic-a', sourceId: 'direct' },
      { memberId: 'inside', parentId: 'topic-a', sourceId: 'inside' },
      { memberId: 'leaf', parentId: 'inside', sourceId: 'inside' },
      { memberId: 'moved', parentId: 'topic-a', sourceId: 'moved' },
      { memberId: 'cross-topic', parentId: 'topic-b', sourceId: 'cross-topic' },
    ];
    for (const m of memberships) {
      await store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES ($1,$2,$3)').run(m.memberId, m.parentId, m.sourceId);
      tx.memberships.set(m.memberId, m);
    }
    await tx.commit();
  });
  const join = async (id: string, memberId: string, parentId: string) => store.transaction(async () => {
    const tx = new Mutation(store);
    const message = await tx.create('system', [{ id: 'relation', type: 'relation', relation: 'member-of', roles: bindRoles({ parent: [{ messageId: parentId }], member: [{ messageId: memberId }] }) }], undefined, id);
    await applyOrganization(tx, message); await reconcileOrganizationEffects(tx); await tx.commit();
  });
  await join('move-out', 'moved', 'outside');
  return { store, join };
}

it('releases only current Topic members, preserving all messages, old versions, moved members, internal structure and replay', async () => {
  const { store } = await fixture();
  const originalMessages = await store.db.prepare('SELECT * FROM messages ORDER BY id').all();
  const originalVersions = await store.db.prepare('SELECT * FROM revisions ORDER BY position').all();
  const originalChanges = await store.db.prepare('SELECT * FROM changes ORDER BY sequence').all();
  const actionBodies = await store.db.prepare('SELECT id,body FROM membership_actions ORDER BY id').all();
  const plan = await store.read(() => planTopicRetirement(store));
  expect(plan.topicIds).toEqual(['topic-a', 'topic-b']);
  expect(plan.releasedMemberships.map(row => row.memberId).sort()).toEqual(['cross-topic', 'direct', 'inside']);
  const change = await store.transaction(() => retireLegacyTopics(store));
  expect(change?.upgrade).toMatchObject({ kind: 'retire-legacy-topics', topicIds: ['topic-a', 'topic-b'] });
  expect(await parentOf(store, 'direct')).toBe('root');
  expect(await parentOf(store, 'inside')).toBe('root');
  expect(await parentOf(store, 'cross-topic')).toBe('root');
  expect(await parentOf(store, 'leaf')).toBe('inside');
  expect(await parentOf(store, 'moved')).toBe('outside');
  expect(await store.db.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(originalMessages);
  expect(await store.db.prepare('SELECT * FROM revisions ORDER BY position').all()).toEqual(originalVersions);
  expect((await store.db.prepare('SELECT * FROM changes ORDER BY sequence').all()).slice(0, -1)).toEqual(originalChanges);
  expect(await store.db.prepare('SELECT id,body FROM membership_actions ORDER BY id').all()).toEqual(actionBodies);
  const retired = (await statesFor(store, ['topic-a']))[0];
  expect(retired).toMatchObject({ suppressed: true, organizationRetired: true });
  const changes = await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all();
  const replay = replayArchive({ format: 'gonglun-2', changes: changes.map(row => JSON.parse(row.body)) });
  expect(replay.memberships.map(row => [row.memberId, row.parentId]).sort()).toEqual([['leaf', 'inside'], ['moved', 'outside']]);
  expect(replay.states.find(state => state.messageId === 'topic-a')?.organizationRetired).toBe(true);
  const archive = { format: 'gonglun-2', changes: changes.map(row => JSON.parse(row.body)) };
  const maliciousRemoval = structuredClone(archive);
  maliciousRemoval.changes.at(-1).removedMemberships.push('moved');
  expect(() => replayArchive(maliciousRemoval)).toThrow('升级记录不一致');
  const incompleteRetirement = structuredClone(archive);
  delete incompleteRetirement.changes.at(-1).states.find((state: any) => state.messageId === 'topic-a').organizationRetired;
  expect(() => replayArchive(incompleteRetirement)).toThrow('升级记录不一致');
  const forgedTopic = structuredClone(archive);
  forgedTopic.changes.at(-1).upgrade.topicIds.push('inside');
  expect(() => replayArchive(forgedTopic)).toThrow('升级记录不一致');
  const alteredTreasury = structuredClone(archive);
  alteredTreasury.changes.at(-1).treasury.operating++;
  alteredTreasury.changes.at(-1).treasury.issued++;
  expect(() => replayArchive(alteredTreasury)).toThrow('升级记录不一致');
  expect(await store.transaction(() => retireLegacyTopics(store))).toBeNull();
  expect(await store.latestSequence()).toBe(change!.sequence);
});

it('does not delete a moved message or restore the cancelled Topic when its new JOIN is opposed', async () => {
  const { store, join } = await fixture();
  await store.transaction(() => retireLegacyTopics(store));
  await store.transaction(async () => {
    const tx = new Mutation(store);
    const stance = await tx.create('system', [{ id: 'stance', type: 'relation', relation: 'disagree', roles: bindRoles({ target: [{ messageId: 'move-out' }] }) }]);
    await recordStance(store, stance, { target: { messageId: 'move-out' }, side: 'con' });
    tx.affected.add('move-out');
    await reconcileOrganizationEffects(tx); await tx.commit();
  });
  expect(await parentOf(store, 'moved')).toBe('root');
  expect((await store.message('moved')).parts[0]).toMatchObject({ text: 'moved' });
  await expect(join('cannot-restore', 'moved', 'topic-a')).rejects.toThrow('已取消');
  expect(await store.db.prepare('SELECT 1 FROM messages WHERE id=$1').get('cannot-restore')).toBeUndefined();
  const prior = (await store.db.prepare("SELECT id FROM membership_actions WHERE body->>'memberId'='moved' AND body->>'parentId'='topic-a'").get())!.id;
  await expect(validateJoinApproval(store, { messageId: prior }, 'pro', 'system')).rejects.toThrow('不能恢复');
});

it('maps a retired placement to root rather than reviving an even older container', () => {
  const actions = [
    { id: 'a', memberId: 'leaf', parentId: 'old-category', previousId: null, previousParentId: null, order: 1 },
    { id: 'b', memberId: 'leaf', parentId: 'topic', previousId: 'a', previousParentId: 'old-category', order: 2 },
    { id: 'c', memberId: 'leaf', parentId: 'new-category', previousId: 'b', previousParentId: 'topic', order: 3 },
  ];
  expect(resolveMemberships(actions, new Set(), new Set(['topic'])).effective.get('leaf')?.id).toBe('c');
  expect(resolveMemberships(actions, new Set(['c']), new Set(['topic'])).effective.has('leaf')).toBe(false);
});

it('keeps cancelled Topics out of normal canvases while history remains available to API and explicit inspection', async () => {
  const { store } = await fixture();
  await store.transaction(() => retireLegacyTopics(store));
  const view = await snapshot(store, 'root', {});
  const relations = view.relations;
  const model = convertMessagesToDemoModel(view.messages, relations);
  for (const stakeCounts of [undefined, {}]) for (const username of [null, '公论规则']) {
    const effect = deriveContainerEffect({ ...model, relations, username, stakeCounts, assumption: { messageId: 'topic-a', side: 'agree' } });
    const root = projectContainerCanvas(effect, { kind: 'root' });
    const visible = root.messages.map(message => message.id);
    expect(visible).not.toContain('topic-a'); expect(visible).not.toContain('topic-b');
    expect(visible).toContain('inside'); expect(visible).toContain('direct');
    expect(visible).not.toContain('leaf'); expect(visible).not.toContain('moved');
    expect(effect.ownership.direct('topic-a').textIds.size).toBe(0);
    expect([...indexRelatedMessages(effect.messages, effect.rejectedContainerIds).values()].flat().some(row => row.message.state?.organizationRetired)).toBe(false);
  }
  expect((await viewsFor(store, [await store.message('topic-a', 1)]))[0]).toMatchObject({ id: 'topic-a', state: { organizationRetired: true } });
});

it('rolls back the complete retirement and its history when a later step fails', async () => {
  const { store } = await fixture();
  const before = await store.db.prepare('SELECT * FROM memberships ORDER BY "memberId"').all();
  const sequence = await store.latestSequence();
  await expect(store.transaction(async () => { await retireLegacyTopics(store); throw new Error('stop'); })).rejects.toThrow('stop');
  expect(await store.db.prepare('SELECT * FROM memberships ORDER BY "memberId"').all()).toEqual(before);
  expect(await store.latestSequence()).toBe(sequence);
  expect((await statesFor(store, ['topic-a']))[0].organizationRetired).toBeUndefined();
});
