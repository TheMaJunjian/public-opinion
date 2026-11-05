import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { Mutation } from './db.js';
import { grant } from './economy.js';
import { allUsers, snapshot } from './ui-projections.js';
import { cleanupTestDatabases, createTestApp } from './test-database.js';
import { nextUsageRefresh, refreshUsagePoints, updateUsagePoints } from './usage-points.js';
import { resetContributionPoints } from '../../migrate/src/reset-contribution-points.js';

afterEach(cleanupTestDatabases);

it('充值贡献只统计清零后的实际到账，使用贡献含零点补发，支出或负余额不影响累计；范围与导出一致', async () => {
  const app = await createTestApp(), store = app.store;
  const { body: session } = await request(app).post('/api/register').send({ name: '贡献统计', password: 'password' });
  const userId = session.user.id as string;
  const recharge = async (amount: number, revenuePoolShare: number) => store.transaction(async () => {
    const tx = new Mutation(store), proposal = await tx.create(userId, [
      { id: 'relation', type: 'relation', relation: 'credit', roles: {} },
      { id: 'data', type: 'data', value: { amount, revenuePoolShare } },
    ]);
    await grant(tx, proposal, undefined);await tx.commit();
  });
  await recharge(100, 20);
  await store.transaction(async () => {
    await store.db.prepare("DELETE FROM settings WHERE key='usage-points-start'").run();
    await resetContributionPoints(store);
  });
  expect((await allUsers(store))[0]).toMatchObject({ rechargeContribution: 0, usageContribution: 0 });
  let scopeId = '';
  await store.transaction(async () => {
    const tx = new Mutation(store), scope = await tx.create(userId, [
      { id: 'relation', type: 'relation', relation: 'classify', roles: {} },
    ]);
    scopeId = scope.id;await tx.commit();
  });
  const after = await store.latestSequence();
  await recharge(50, 10);
  const at = Date.parse('2026-11-01T23:59:58+08:00');
  const progress = await updateUsagePoints(store, userId, { action: 'start' }, at);
  await updateUsagePoints(store, userId, { action: 'tick', roundId: progress.roundId }, at + 1000);
  await refreshUsagePoints(store, nextUsageRefresh(at));
  await store.transaction(async () => {
    const tx = new Mutation(store), message = await tx.create(userId, [{ id: 'body', type: 'text', text: '支出形成欠额' }]);
    await store.ledger(userId, message.id, -45, 0, '价值投入', true);
    await store.operating(45);await tx.commit();
  });
  expect((await store.account(userId)).available).toBe(-3);
  const expected = { id: userId, rechargeContribution: 40, usageContribution: 2 };
  expect((await allUsers(store))[0]).toMatchObject(expected);
  const scoped = await snapshot(store, scopeId, {});
  expect(scoped.messages).toEqual([]);
  expect(scoped.users[0]).toMatchObject(expected);
  const delta = await snapshot(store, scopeId, { after });
  expect(delta.users.find(user => user.id === userId)).toMatchObject(expected);
  const users = await request(app).get('/api/ui/users');
  expect(users.body.data[0]).toMatchObject(expected);
  const exported = await request(app).get('/api/ui/export').query({ parent: scopeId });
  expect(exported.status, exported.text).toBe(200);
  expect(exported.body.users[0]).toMatchObject(expected);
});
