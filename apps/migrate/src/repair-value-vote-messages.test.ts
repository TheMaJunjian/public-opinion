import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { bindRoles, relations, replayArchive } from '@gonglun/core';
import { cleanupTestDatabases, createTestApp } from '../../server/src/test-database.js';
import { messageView, tagCountsFor } from '../../server/src/ui-projections.js';
import { personalMarks } from '../../server/src/personal.js';
import { financialFingerprint } from './financial-fingerprint.js';
import { repairValueVoteMessages, valueVoteMessageRepairPlan } from './repair-value-vote-messages.js';
import { migrationsFor, runMigrations } from './migrations.js';

afterEach(cleanupTestDatabases);
async function fixture() {
  const app = await createTestApp(), agent = request.agent(app);
  const registered = await agent.post('/api/register').send({ name: '迁移投票者', password: 'a-good-password' });
  expect(registered.status, registered.text).toBe(201);
  const session = registered.body;
  const post = async (path: string, body: object) => {
    const response = await agent.post(`/api/ui${path}`).set('x-csrf-token', session.csrf).set('x-request-id', randomUUID()).send(body);
    expect(response.status, response.text).toBe(201); return response.body;
  };
  const subject = await post('/messages', { content: '原消息' });
  const round = await post(`/messages/${subject.id}/rounds`, { settlementType: 'VALUE' });
  const votes = [];
  for (const relation of ['agree', 'disagree']) {
    const requestId = randomUUID();
    const response = await agent.post('/api/messages').set('x-csrf-token', session.csrf).send({ requestId, wager: 3, parts: [
      { id: 'relation', type: 'relation', relation, roles: bindRoles({ target: [round.reference] }) },
      { id: 'data', type: 'data', value: { roundId: round.id } },
    ] });
    expect(response.status, response.text).toBe(201); votes.push({ message: response.body.message, requestId });
  }
  // A later recommendation must remain the user's latest personal choice after repairing the older cold vote.
  await post('/relations', { relationType: 'RECOMMEND', targetRefs: [{ kind: 'message', messageId: subject.id }] });
  return { app, store: app.store, agent, session, post, subject, round, votes };
}
async function contracts(store: Awaited<ReturnType<typeof fixture>>['store']) {
  const result: Record<string, unknown> = {};
  for (const [table, key] of [['rounds', 'id'], ['bets', 'id'], ['stake_positions', 'id'], ['execution_stances', '"sourceId"'], ['signatures', '"messageId"']])
    result[table] = await store.db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all();
  return result;
}

it('repairs old value-vote messages, replay, cached responses, references and personal marks without executing any money movement', async () => {
  const { store, subject, votes, session } = await fixture();
  const commandId = randomUUID(), view = await messageView(store, votes[0].message);
  await store.transaction(async () => {
    await store.db.prepare('INSERT INTO command_requests VALUES($1,$2,$3,$4)').run(session.user.id, commandId, 'original command input', JSON.stringify({ results: [view] }));
    await store.db.prepare('INSERT INTO signatures VALUES($1,$2,$3,$4,$5,$6,$7)').run(votes[0].message.id, session.user.id,
      'device', 'public-key', 'original signed input', 'retained-signature', votes[0].message.createdAt);
  });
  const before = await financialFingerprint(store.db), originalContracts = await contracts(store), cursor = await store.latestSequence();
  const inputs = await store.db.prepare('SELECT input FROM requests ORDER BY "requestId"').all();
  expect(await store.read(() => valueVoteMessageRepairPlan(store.db))).toMatchObject({ pending: 2, recommendations: 1, archives: 1, unresolved: 0 });
  expect(await store.latestSequence()).toBe(cursor);
  expect(await store.transaction(() => repairValueVoteMessages(store))).toBe(2);
  expect(await financialFingerprint(store.db)).toBe(before);
  expect(await contracts(store)).toEqual(originalContracts);
  expect(await store.db.prepare('SELECT input FROM requests ORDER BY "requestId"').all()).toEqual(inputs);
  for (const [index, { message, requestId }] of votes.entries()) {
    const current = await store.message(message.id), type = index === 0 ? 'recommend' : 'archive';
    expect(current).toMatchObject({ ...message, parts: expect.any(Array) });
    expect(relations(current)[0]).toMatchObject({ id: 'relation', relation: type, roles: { target: [{ reference: { messageId: subject.id, revision: 1 } }] } });
    expect(await store.message(message.id, 1)).toEqual(current);
    expect(await store.db.prepare('SELECT "targetId" FROM refs WHERE "sourceId"=$1').all(message.id)).toEqual([{ targetId: subject.id }]);
    const result = JSON.parse(String((await store.db.prepare('SELECT result FROM requests WHERE "requestId"=$1').get(requestId))!.result));
    expect(result.message).toEqual(current);
  }
  const cached = JSON.parse(String((await store.db.prepare('SELECT result FROM command_requests WHERE "requestId"=$1').get(commandId))!.result));
  expect(cached.results[0]).toMatchObject({ relationType: 'RECOMMEND', targetRefs: [{ reference: { messageId: subject.id, revision: 1 } }] });
  expect((await store.db.prepare('SELECT input FROM command_requests WHERE "requestId"=$1').get(commandId))?.input).toBe('original command input');
  expect((await personalMarks(store, session.user.id, [subject.id]))[0]?.archived).toBe(false);
  expect(await tagCountsFor(store, [subject.id])).toEqual({ [subject.id]: { RECOMMEND: 2, ARCHIVE: 1 } });
  const changes = (await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row => JSON.parse(String(row.body)));
  const replay = replayArchive({ format: 'gonglun-2', changes });
  for (const { message } of votes) expect(replay.messages.find(value => value.id === message.id)).toEqual(await store.message(message.id));
  expect(replay.accounts.get(session.user.id)).toEqual(await store.account(session.user.id));
  expect(changes.at(-1).ledger).toEqual([]);
  const backups = await store.db.prepare('SELECT * FROM value_vote_message_backups ORDER BY table_name,row_key').all();
  expect(backups.some(row => row.table_name === 'revisions')).toBe(true);
  expect(await store.transaction(() => repairValueVoteMessages(store))).toBe(0);
  expect(await store.latestSequence()).toBe(cursor + 1);
  expect(await store.db.prepare('SELECT * FROM value_vote_message_backups ORDER BY table_name,row_key').all()).toEqual(backups);
});

it('keeps ordinary truth votes and text discussions unchanged, including legacy rounds sharing an address', async () => {
  const { store, subject, post } = await fixture();
  const truth = await post(`/messages/${subject.id}/rounds`, { settlementType: 'TRUTH' });
  const vote = await post(`/rounds/${truth.id}/votes`, { vote: 'TRUE', amount: 1 });
  const before = await store.message(vote.id);
  await store.transaction(async () => {
    const row = (await store.db.prepare('SELECT body FROM rounds WHERE id=$1').get(truth.id))!;
    const historical = { ...JSON.parse(String(row.body)), id: 'shared-old-value', settlementType: 'VALUE', status: 'settled' };
    await store.db.prepare('INSERT INTO rounds(id,"targetKey",body,"createdAt") VALUES($1,$2,$3,$4)').run(historical.id, historical.targetKey, JSON.stringify(historical), historical.createdAt);
  });
  expect(await store.read(() => valueVoteMessageRepairPlan(store.db))).toMatchObject({ pending: 2, unresolved: 0 });
  await store.transaction(() => repairValueVoteMessages(store));
  expect(await store.message(vote.id)).toEqual(before);
});

it('stops and rolls back if the original round and executed vote disagree instead of guessing a target', async () => {
  const { store, votes, post } = await fixture();
  const other = await post('/messages', { content: '另一目标' });
  const round = await post(`/messages/${other.id}/rounds`, { settlementType: 'VALUE' });
  await store.transaction(async () => {
    const broken = structuredClone(votes[0].message);
    broken.parts.find((part: any) => part.type === 'data').value.roundId = round.id;
    await store.db.prepare('UPDATE revisions SET body=$1 WHERE "messageId"=$2').run(JSON.stringify(broken), broken.id);
    await store.db.prepare('UPDATE messages SET body=$1 WHERE id=$2').run(JSON.stringify(broken), broken.id);
  });
  const before = await store.db.prepare('SELECT * FROM messages ORDER BY id').all(), cursor = await store.latestSequence();
  await store.db.exec('DELETE FROM schema_migrations WHERE version>=9');
  expect(await store.read(() => valueVoteMessageRepairPlan(store.db))).toMatchObject({ unresolved: 1 });
  await expect(runMigrations(store.db, migrationsFor(store))).rejects.toThrow('原价值轮次不一致');
  expect(await store.db.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(before);
  expect(await store.latestSequence()).toBe(cursor);
  expect(await store.db.prepare('SELECT version FROM schema_migrations WHERE version=9').get()).toBeUndefined();
});

it('upgrades an already migrated version-8 database through version 9 exactly once', async () => {
  const { store, subject, votes } = await fixture();
  await store.db.exec('DELETE FROM schema_migrations WHERE version>=9');
  const cursor = await store.latestSequence(), before = await financialFingerprint(store.db);
  await runMigrations(store.db, migrationsFor(store));
  expect(await store.db.prepare('SELECT name FROM schema_migrations WHERE version=9').get()).toEqual({ name: 'correct-historical-value-vote-messages' });
  expect(await financialFingerprint(store.db)).toBe(before);
  expect((await messageView(store, await store.message(votes[0].message.id))).targetRefs[0].reference?.messageId).toBe(subject.id);
  await runMigrations(store.db, migrationsFor(store));
  expect(await store.latestSequence()).toBe(cursor + 1);
});
