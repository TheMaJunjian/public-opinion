import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { bindRoles, relations, replayArchive, type Part, type Reference } from '@gonglun/core';
import { Mutation } from '../../server/src/db.js';
import { createTestApp, cleanupTestDatabases } from '../../server/src/test-database.js';
import { placeWager } from '../../server/src/economy.js';
import { statesFor } from '../../server/src/projections.js';
import { messageView, tagCountsFor } from '../../server/src/ui-projections.js';
import { financialFingerprint } from './financial-fingerprint.js';
import { voteContractFingerprint } from './repair-value-vote-messages.js';
import { annotationStanceMessageRepairPlan, repairAnnotationStanceMessages } from './repair-annotation-stance-messages.js';
import { migrationsFor, runMigrations } from './migrations.js';

afterEach(cleanupTestDatabases);
async function fixture(name = 'recommend', payload: Record<string, string> = {}) {
  const app = await createTestApp(), store = app.store, agent = request.agent(app);
  const registered = await agent.post('/api/register').send({ name: '标注迁移者', password: 'a-good-password' });
  expect(registered.status, registered.text).toBe(201);
  const user = registered.body.user;
  const relation = (name: string, reference: Reference): Part => ({ id: 'relation', type: 'relation', relation: name, roles: bindRoles({ target: [reference] }) });
  await store.transaction(async () => {
    const tx = new Mutation(store);
    await tx.create(user.id, [{ id: 'body', type: 'text', text: '原消息' }], undefined, 'subject');
    const part = relation(name, { messageId: 'subject', revision: 1 });
    if (part.type === 'relation' && (name === 'follow' || name === 'block')) part.reason = payload.subType as 'YES' | 'NO';
    await tx.create(user.id, [part, { id: 'reason', type: 'text', text: '标注的正文理由' },
      { id: 'data', type: 'data', value: { ...payload, uiType: name.toUpperCase() } }], undefined, 'annotation');
    await tx.commit();
  });
  async function oldStance(id: string, name: string, reference: Reference, amount = 0) {
    return store.transaction(async () => {
      const tx = new Mutation(store);
      const message = await tx.create(user.id, [relation(name, reference), { id: 'data', type: 'data', value: { uiType: name.toUpperCase() } }],
        { protocol: 1, recommendation: 0, wager: amount }, id);
      await store.ledger(user.id, id, -1, 0, '协议费'); await store.operating(1, true);
      // Reproduce the old send path before annotation normalization was introduced.
      await placeWager(tx, message, amount); await tx.commit(); return store.message(id);
    });
  }
  return { store, user, oldStance };
}

it('converts the recommendation agreement and removes its old decoration, preserving original truth stances and money', async () => {
  const { store, user, oldStance } = await fixture();
  const old = await oldStance('old-annotation-agreement', 'agree', { messageId: 'annotation' }, 3);
  const truth = await oldStance('ordinary-truth-agreement', 'agree', { messageId: 'subject' }, 2);
  const cached = await messageView(store, old);
  await store.db.prepare('INSERT INTO command_requests VALUES($1,$2,$3,$4)').run(user.id, 'cached-command', 'signed-original-input', JSON.stringify({ results: [cached] }));
  expect((await statesFor(store, ['annotation']))[0]?.supportCount).toBe(1);
  const money = await financialFingerprint(store.db), contracts = await voteContractFingerprint(store.db), cursor = await store.latestSequence();
  expect(await store.read(() => annotationStanceMessageRepairPlan(store.db))).toMatchObject({ pending: 1, unresolved: 0 });
  expect(await store.transaction(() => repairAnnotationStanceMessages(store))).toBe(1);
  const repaired = await store.message(old.id);
  expect(repaired).toMatchObject({ ...old, parts: expect.any(Array) });
  expect(relations(repaired)[0]).toMatchObject({ relation: 'recommend', roles: { target: [{ reference: { messageId: 'subject', revision: 1 } }] } });
  expect((await statesFor(store, ['annotation']))[0]?.supportCount).toBe(0);
  expect((await statesFor(store, ['subject']))[0]?.supportCount).toBe(1);
  expect(await store.message(truth.id)).toEqual(truth);
  expect(await financialFingerprint(store.db)).toBe(money);
  expect(await voteContractFingerprint(store.db)).toBe(contracts);
  expect(await tagCountsFor(store, ['subject'])).toEqual({ subject: { RECOMMEND: 2 } });
  const receipt = JSON.parse(String((await store.db.prepare('SELECT result FROM command_requests WHERE "requestId"=$1').get('cached-command'))!.result));
  expect(receipt.results[0]).toMatchObject({ relationType: 'RECOMMEND', targetRefs: [{ reference: { messageId: 'subject', revision: 1 } }], content: expect.stringContaining('推荐') });
  expect((await store.db.prepare('SELECT input FROM command_requests WHERE "requestId"=$1').get('cached-command'))?.input).toBe('signed-original-input');
  const changes = (await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row => JSON.parse(String(row.body)));
  const replay = replayArchive({ format: 'gonglun-2', changes });
  expect(replay.messages.find(message => message.id === old.id)).toEqual(repaired);
  expect(replay.accounts.get(user.id)).toEqual(await store.account(user.id));
  expect(changes.at(-1).states.find((state: {messageId:string}) => state.messageId === 'annotation')?.supportCount).toBe(0);
  const backups = await store.db.prepare('SELECT * FROM annotation_stance_message_backups ORDER BY table_name,row_key').all();
  expect(backups.some(row => row.table_name === 'display_stances')).toBe(true);
  expect(await store.transaction(() => repairAnnotationStanceMessages(store))).toBe(0);
  expect(await store.latestSequence()).toBe(cursor + 1);
  expect(await store.db.prepare('SELECT * FROM annotation_stance_message_backups ORDER BY table_name,row_key').all()).toEqual(backups);
});

it.each([
  ['recommend', 'agree', 'recommend', {}], ['recommend', 'disagree', 'archive', {}],
  ['archive', 'agree', 'archive', {}], ['archive', 'disagree', 'recommend', {}],
  ['read', 'disagree', 'unread', {}], ['unread', 'disagree', 'read', {}],
  ['follow', 'disagree', 'follow', { subType: 'YES' }], ['block', 'disagree', 'block', { subType: 'NO' }],
  ['tag', 'agree', 'tag', { label: '可靠' }],
] as const)('converts historical %s %s into %s using the same annotation rules', async (name, side, expected, payload) => {
  const { store, oldStance } = await fixture(name, payload);
  await oldStance('old-stance', side, { messageId: 'annotation' });
  await store.transaction(() => repairAnnotationStanceMessages(store));
  const view = await messageView(store, await store.message('old-stance'));
  expect(relations(await store.message('old-stance'))[0]).toMatchObject({ relation: expected, roles: { target: [{ reference: { messageId: 'subject', revision: 1 } }] } });
  if (name === 'follow' || name === 'block') expect(view.payload.subType).toBe(payload.subType === 'YES' ? 'NO' : 'YES');
  if (name === 'tag') expect(view.payload.label).toBe('可靠');
});

it('resolves nested old annotation stances and preserves body-fragment discussions and custom-tag objections', async () => {
  const { store, oldStance } = await fixture();
  await oldStance('first', 'agree', { messageId: 'annotation' });
  await oldStance('second', 'disagree', { messageId: 'first' });
  const body = await oldStance('body-discussion', 'disagree', { messageId: 'annotation', revision: 1, partId: 'reason', range: { start: 0, end: 2 } });
  expect(await store.read(() => annotationStanceMessageRepairPlan(store.db))).toMatchObject({ pending: 2 });
  await store.transaction(() => repairAnnotationStanceMessages(store));
  expect(relations(await store.message('second'))[0]).toMatchObject({ relation: 'archive', roles: { target: [{ reference: { messageId: 'subject', revision: 1 } }] } });
  expect(await store.message(body.id)).toEqual(body);
  const custom = await fixture('tag', { label: '独立标注' });
  const objection = await custom.oldStance('old-tag-objection', 'disagree', { messageId: 'annotation' });
  expect(await custom.store.transaction(() => repairAnnotationStanceMessages(custom.store))).toBe(0);
  expect(await custom.store.message(objection.id)).toEqual(objection);
});

it('applies version 10 to a version-9 database exactly once', async () => {
  const { store, oldStance } = await fixture();
  await oldStance('old-agreement', 'agree', { messageId: 'annotation' });
  await store.db.exec('DELETE FROM schema_migrations WHERE version>=10');
  const cursor = await store.latestSequence();
  await runMigrations(store.db, migrationsFor(store));
  expect(await store.db.prepare('SELECT name FROM schema_migrations WHERE version=10').get()).toEqual({ name: 'normalize-historical-annotation-stances' });
  expect((await statesFor(store, ['annotation']))[0]?.supportCount).toBe(0);
  await runMigrations(store.db, migrationsFor(store));
  expect(await store.latestSequence()).toBe(cursor + 1);
});
