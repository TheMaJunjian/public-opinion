import { testInvitation } from './test-database.js';
import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { Mutation } from './db.js';
import { cleanupTestDatabases, createTestApp } from './test-database.js';
import { updateUsagePoints } from './usage-points.js';
import { distribution } from './economy.js';
import { bindRoles } from '@gonglun/core';

afterEach(cleanupTestDatabases);
it('既有逐点奖励与新的累计奖励按北京时间归并，在合并后分页，保留普通收支余额和账户隔离', async () => {
  const app = await createTestApp({ initialGrant: 0 }), agent = request.agent(app), store = app.store;
  const { body: session } = await agent.post('/api/register').send({ name: '奖励汇总', password: 'password' });
  await request(app).post('/api/register').send({inviteCode:await testInvitation(app), name: '另一用户', password: 'password' });
  const sourceIds: string[] = [];
  await store.transaction(async () => {
    const tx = new Mutation(store), message = await tx.create('system', [{ id: 'body', type: 'text', text: '历史奖励' }]);
    const secondMessage = await tx.create('system', [{ id: 'body', type: 'text', text: '另一历史奖励' }]);
    sourceIds.push(message.id, secondMessage.id);
    for (let i = 0; i < 120; i++) {
      const entry = await store.ledger(session.user.id, sourceIds[i % 2], 1, 0, '使用公论计时奖励');
      await store.db.prepare('UPDATE ledger SET "createdAt"=$2 WHERE id=$1').run(entry.id, '2026-10-31T15:59:59.000Z');
    }
    const spend = await store.ledger(session.user.id, message.id, -10, 0, '协议费');
    await store.db.prepare('UPDATE ledger SET "createdAt"=$2 WHERE id=$1').run(spend.id, '2026-10-31T15:59:59.500Z');
    await tx.put({ ...message, revision: 2, parts: [{ id: 'body', type: 'text', text: '后来修改的正文' }] });
    await store.operating(10);await store.set('minted', 120);await tx.commit();
  });
  const time = Date.parse('2026-11-01T00:00:00+08:00');
  const first = await updateUsagePoints(store, session.user.id, { action: 'start' }, time);
  const second = await updateUsagePoints(store, session.user.id, { action: 'tick', roundId: first.roundId }, time + 1000);
  await updateUsagePoints(store, session.user.id, { action: 'tick', roundId: second.roundId }, time + 3000);
  const before = await store.account(session.user.id), ledgerCount = (await store.db.prepare('SELECT COUNT(*) AS n FROM ledger').get())!.n;
  const response = await agent.get('/api/ui/points/transactions?limit=2');
  expect(response.status, response.text).toBe(200);
  expect(response.body.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
  expect(response.body.data[0]).toMatchObject({ type: 'USAGE_REWARD', amount: 2, data: { day: '2026-11-01', count: 2 } });
  expect(response.body.data[1]).toMatchObject({ type: 'SPEND', amount: -10, balanceAfter: 110, data: { reason: '协议费' } });
  expect(response.body.data[1].messages).toEqual([{ messageId: sourceIds[0], messageRevision: 1, messageType: '文本', summary: '历史奖励', scopeMessageId: 'root' }]);
  expect(response.body.data[0].messages).toHaveLength(1);
  const older = await agent.get('/api/ui/points/transactions?page=2&limit=2');
  expect(older.body.data).toHaveLength(1);
  expect(older.body.data[0]).toMatchObject({ type: 'USAGE_REWARD', amount: 120, data: { day: '2026-10-31', count: 120 } });
  expect(older.body.data[0].messages).toHaveLength(2);
  expect(older.body.data[0].messages.map((message: { messageId: string }) => message.messageId).sort()).toEqual([...sourceIds].sort());
  const empty = await agent.get('/api/ui/points/transactions?page=3&limit=2');
  expect(empty.body.data).toEqual([]);expect(empty.body.pagination.total).toBe(3);
  expect(await store.account(session.user.id)).toEqual(before);
  expect((await store.db.prepare('SELECT COUNT(*) AS n FROM ledger').get())!.n).toBe(ledgerCount);
  const other = request.agent(app);await other.post('/api/login').send({ name: '另一用户', password: 'password' });
  expect((await other.get('/api/ui/points/transactions')).body.data).toEqual([]);
});

it('关系消息摘要沿用正文投影，结算流水保留分配正文和实际轮次', async () => {
  const app = await createTestApp(), agent = request.agent(app), store = app.store;
  const { body: session } = await agent.post('/api/register').send({ name: '消息入口', password: 'password' });
  let relationId = '', resultId = '';
  await store.transaction(async () => {
    const tx = new Mutation(store);
    const target = await tx.create('system', [{ id: 'body', type: 'text', text: '支持公开讨论' }]);
    const relation = await tx.create(session.user.id, [{ id: 'relation', type: 'relation', relation: 'agree', roles: bindRoles({ target: [{ messageId: target.id, revision: 1 }] }) }]);
    relationId = relation.id;
    await store.ledger(session.user.id, relation.id, -1, 0, '协议费');
    await store.operating(1);
    const result = await distribution(tx, { messageId: target.id }, { source: 'wager', total: 0, ruleVersion: 1, inputs: { roundId: 'fixture-round' }, allocations: [] });
    resultId = result.id;
    await store.ledger(session.user.id, result.id, 0, 0, '结算记录');
    await tx.commit();
  });
  const response = await agent.get('/api/ui/points/transactions');
  expect(response.status, response.text).toBe(200);
  const relation = response.body.data.find((row: { messageId: string }) => row.messageId === relationId);
  expect(relation.messages).toEqual([expect.objectContaining({ messageId: relationId, messageType: '赞同', summary: '赞同：「支持公开讨论」' })]);
  const result = response.body.data.find((row: { messageId: string }) => row.messageId === resultId);
  expect(result.data.roundId).toBe('fixture-round');
  expect(result.messages).toEqual([expect.objectContaining({ messageId: resultId, messageType: '分配', summary: '对赌分配：0 贡献点。', roundId: 'fixture-round' })]);
});
