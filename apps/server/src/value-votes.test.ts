import {withTestCommandContributions} from './test-database.js';
import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { bindRoles, relations } from '@gonglun/core';
import { createTestApp, cleanupTestDatabases } from './test-database.js';
import { personalMarks } from './personal.js';
import { roundView, tagCountsFor } from './ui-projections.js';

const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); await cleanupTestDatabases(); });
async function setup() {
  const app = await createTestApp(); apps.push(app);
  const agent = request.agent(app);
  const registered = await agent.post('/api/register').send({ name: '投票者', password: 'a-good-password' });
  expect(registered.status, registered.text).toBe(201);
  const session = registered.body;
  const post = async (path: string, body = {}, requestId = randomUUID()) => {
    const response = await agent.post(`/api/ui${path}`).set('x-csrf-token', session.csrf).set('x-request-id', requestId).send(withTestCommandContributions(path,body as Record<string,unknown>));
    expect(response.status, response.text).toBe(201); return response.body;
  };
  const message = await post('/messages', { content: '待仲裁的消息' });
  return { app, agent, session, post, message };
}

it.each([['TRUE', 'recommend', 'pro'], ['FALSE', 'archive', 'con']] as const)(
  '价值仲裁 %s 直接保存 %s 消息，标注原消息，押注和重试只执行一次', async (vote, name, side) => {
    const { app, agent, session, post, message } = await setup();
    const round = await post(`/messages/${message.id}/rounds`, { settlementType: 'VALUE' });
    const before = await app.store.account(session.user.id), requestId = randomUUID();
    const created = await post(`/rounds/${round.id}/votes`, { vote, amount: 5 }, requestId);
    expect(created).toMatchObject({ relationType: name.toUpperCase(), targetRefs: [{ reference: { messageId: message.id, revision: 1 } }],
      spending: { protocol: 1, recommendation: 5, wager: 0 } });
    expect(relations(await app.store.message(created.id)).map(part => part.relation)).toEqual([name]);
    expect(created.executedStance).toMatchObject({ target: round.reference, side });
    expect(await app.store.account(session.user.id)).toMatchObject({ available: before.available - 6, locked: before.locked + 5 });
    expect(await tagCountsFor(app.store, [message.id])).toEqual({ [message.id]: { [name.toUpperCase()]: 1 } });
    expect((await personalMarks(app.store, session.user.id, [message.id]))[0]?.archived).toBe(name === 'archive');
    const detail = await roundView(app.store, round.id);
    expect(detail.votes).toEqual([expect.objectContaining({ id: created.id, vote, amount: 5 })]);
    expect(detail.weights[vote]).toBe(5);
    const history = (await agent.get(`/api/ui/users/${session.user.id}/stances`)).body;
    expect(history.stances.tags).toContainEqual(expect.objectContaining({ relationMessageId: created.id, targetMessageId: message.id, relationType: name.toUpperCase() }));
    const account = await app.store.account(session.user.id);
    expect((await post(`/rounds/${round.id}/votes`, { vote, amount: 5 }, requestId)).id).toBe(created.id);
    expect(await app.store.account(session.user.id)).toEqual(account);
    expect((await app.store.db.prepare('SELECT COUNT(*)::int AS n FROM bets').get())?.n).toBe(1);
  });

it('直接发送推荐、冷藏与仲裁面板共用价值轮次，真假投票仍发送赞同、反对', async () => {
  const { app, post, message } = await setup();
  const recommend = await post('/relations', { relationType: 'RECOMMEND', targetRefs: [{ kind: 'message', messageId: message.id }], recommendation: 4 });
  const value = await post(`/messages/${message.id}/rounds`, { settlementType: 'VALUE' });
  expect(value.votes).toEqual([expect.objectContaining({ id: recommend.id, vote: 'TRUE', amount: 4 })]);
  const archive = await post('/relations', { relationType: 'ARCHIVE', targetRefs: [{ kind: 'message', messageId: message.id }], recommendation: 3 });
  const detail = await roundView(app.store, value.id);
  expect(detail.weights).toEqual({ TRUE: 4, FALSE: 3, UNKNOWN: 0 });
  expect(detail.votes.map((vote: { id: string }) => vote.id)).toEqual([recommend.id, archive.id]);
  for (const created of [recommend, archive]) expect(relations(await app.store.message(created.id))).toHaveLength(1);
  const truth = await post(`/messages/${message.id}/rounds`, { settlementType: 'TRUTH' });
  for (const [vote, type] of [['TRUE', 'AGREE'], ['FALSE', 'DISAGREE']]) {
    const result = await post(`/rounds/${truth.id}/votes`, { vote, amount: 2 });
    expect(result).toMatchObject({ relationType: type, targetRefs: [{ reference: truth.reference }] });
  }
  expect((await roundView(app.store, value.id)).weights).toEqual({ TRUE: 4, FALSE: 3, UNKNOWN: 0 });
  expect((await roundView(app.store, truth.id)).weights).toEqual({ TRUE: 2, FALSE: 2, UNKNOWN: 0 });
});

it('标注的价值投入与反对标注继续进入同一价值轮次', async () => {
  const { app, agent, session, post, message } = await setup();
  const recommend = await post('/relations', { relationType: 'RECOMMEND', targetRefs: [{ kind: 'message', messageId: message.id }] });
  const round = await post(`/messages/${message.id}/rounds`, { settlementType: 'VALUE' });
  expect(round.weights).toEqual({ TRUE: 1, FALSE: 0, UNKNOWN: 0 });
  const response = await agent.post('/api/messages').set('x-csrf-token', session.csrf).send({ requestId: randomUUID(), recommendation: 3,
    parts: [{ id: 'relation', type: 'relation', relation: 'disagree', roles: bindRoles({ target: [{ messageId: recommend.id }] }) }] });
  expect(response.status, response.text).toBe(201);
  expect(relations(response.body.message).map(part => part.relation)).toEqual(['archive']);
  expect((await roundView(app.store, round.id)).weights).toEqual({ TRUE: 1, FALSE: 3, UNKNOWN: 0 });
  expect((await app.store.db.prepare('SELECT COUNT(*)::int AS n FROM rounds').get())?.n).toBe(1);
});

it('旧版以原消息正文为目标的价值轮次也发送标注并沿用原轮次', async () => {
  const { app, agent, session, post, message } = await setup();
  const opened = await agent.post('/api/messages').set('x-csrf-token', session.csrf).send({ requestId: randomUUID(), recommendation:1, parts: [
    { id: 'relation', type: 'relation', relation: 'open-settlement', roles: bindRoles({ target: [{ messageId: message.id, revision: 1, partId: 'body' }] }) },
  ] });
  expect(opened.status, opened.text).toBe(201);
  const row = (await app.store.db.prepare('SELECT id,body FROM rounds').get())!;
  const saved = { ...JSON.parse(String(row.body)), settlementType: 'VALUE', subjectId: message.id };
  await app.store.transaction(() => app.store.db.prepare('UPDATE rounds SET body=$1 WHERE id=$2').run(JSON.stringify(saved), row.id));
  const vote = await post(`/rounds/${row.id}/votes`, { vote: 'FALSE', amount: 2 });
  expect(vote).toMatchObject({ relationType: 'ARCHIVE', targetRefs: [{ reference: { messageId: message.id, revision: 1 } }] });
  expect(vote.targetRefs[0].reference.partId).toBeUndefined();
  expect((await roundView(app.store, String(row.id))).votes).toEqual([expect.objectContaining({ id: vote.id, vote: 'FALSE', amount: 2 })]);
  expect((await app.store.db.prepare('SELECT COUNT(*)::int AS n FROM rounds').get())?.n).toBe(1);
});

it('标注押注失败会回滚消息、价值轮次和个人标记，保持资金记录完整', async () => {
  const { app, agent, session, message } = await setup();
  const before = await app.store.account(session.user.id), sequence = await app.store.latestSequence();
  const response = await agent.post('/api/ui/relations').set('x-csrf-token', session.csrf).set('x-request-id', randomUUID())
    .send({ relationType: 'ARCHIVE', targetRefs: [{ kind: 'message', messageId: message.id }], recommendation: before.available + 1 });
  expect(response.status).toBe(400);
  expect(await app.store.account(session.user.id)).toEqual(before);
  expect(await app.store.latestSequence()).toBe(sequence);
  expect((await app.store.db.prepare('SELECT COUNT(*)::int AS n FROM rounds').get())?.n).toBe(0);
  expect(await tagCountsFor(app.store, [message.id])).toEqual({ [message.id]: {} });
  expect((await personalMarks(app.store, session.user.id, [message.id]))[0]?.archived).toBe(false);
});
