import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { replayArchive } from '@gonglun/core';
import { cleanupTestDatabases, createTestApp } from './test-database.js';
import { nextUsageRefresh, refreshUsagePoints, updateUsagePoints, usageDay } from './usage-points.js';

afterEach(async () => { vi.restoreAllMocks(); await cleanupTestDatabases(); });
async function setup() {
  const app = await createTestApp({ initialGrant: 0 }), agent = request.agent(app);
  const registered = await agent.post('/api/register').send({ name: '计时测试', password: 'password' });
  expect(registered.status, registered.text).toBe(201);
  return { app, agent, store: app.store, session: registered.body, userId: registered.body.user.id as string };
}
const base = Date.parse('2026-10-31T12:00:00+08:00');

it('注册从零开始，自动计时请求按服务器时间发放，每轮递增且重试不多发', async () => {
  const { store, userId } = await setup();
  expect(await store.account(userId)).toEqual({ available: 0, locked: 0, earned: 0, spent: 0 });
  const first = await updateUsagePoints(store, userId, { action: 'start' }, base);
  expect(first).toMatchObject({ earned: 0, waitSeconds: 1, remainingMs: 1000, awarded: false });
  expect(await updateUsagePoints(store, userId, { action: 'tick', roundId: first.roundId }, base + 999)).toMatchObject({ awarded: false, remainingMs: 1 });
  expect(await updateUsagePoints(store, userId, { action: 'start' }, base + 1000)).toMatchObject({ awarded: false, remainingMs: 0 });
  const second = await updateUsagePoints(store, userId, { action: 'tick', roundId: first.roundId }, base + 60_000);
  expect(second).toMatchObject({ earned: 1, totalEarned: 1, waitSeconds: 2, remainingMs: 2000, awarded: true });
  expect(await updateUsagePoints(store, userId, { action: 'tick', roundId: first.roundId }, base + 65_000)).toMatchObject({ awarded: false, earned: 1 });
  const third = await updateUsagePoints(store, userId, { action: 'tick', roundId: second.roundId }, base + 65_000);
  expect(third).toMatchObject({ earned: 2, totalEarned: 2, waitSeconds: 3, remainingMs: 3000, awarded: true });
  const changes = (await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row => JSON.parse(String(row.body)));
  expect(replayArchive({ format: 'gonglun-2', changes }).accounts.get(userId)).toEqual(await store.account(userId));
  expect((await store.account(userId)).available).toBe(2);
  expect(await store.setting('minted')).toBe(2);
});

it('多个页面、并发操作和重复请求不会多领，同一账户共用一轮', async () => {
  const { store, userId } = await setup();
  const first = await updateUsagePoints(store, userId, { action: 'start' }, base);
  expect((await updateUsagePoints(store, userId, { action: 'start' }, base + 100)).roundId).toBe(first.roundId);
  const results = await Promise.all(Array.from({ length: 8 }, () => updateUsagePoints(store, userId, { action: 'tick', roundId: first.roundId }, base + 1000)));
  expect(results.filter(result => result.awarded)).toHaveLength(1);
  expect((await store.account(userId)).available).toBe(1);
  expect((await store.db.prepare('SELECT earned FROM usage_points WHERE "userId"=$1').get(userId))!.earned).toBe(1);
});

it('北京时间零点自动补发未等满的一轮，等待次数重置，离线数天不会重复补发', async () => {
  const { store, userId } = await setup();
  const beforeMidnight = Date.parse('2026-10-31T23:59:58.500+08:00'), midnight = nextUsageRefresh(beforeMidnight);
  const first = await updateUsagePoints(store, userId, { action: 'start' }, beforeMidnight);
  await updateUsagePoints(store, userId, { action: 'tick', roundId: first.roundId }, beforeMidnight + 1000);
  await refreshUsagePoints(store, midnight);
  expect(await store.db.prepare('SELECT earned,"readyAt",day,"totalEarned" FROM usage_points WHERE "userId"=$1').get(userId))
    .toEqual({ earned: 0, readyAt: null, day: '2026-11-01', totalEarned: 2 });
  await Promise.all([refreshUsagePoints(store, midnight), refreshUsagePoints(store, midnight + 5 * 86400_000)]);
  expect((await store.account(userId)).available).toBe(2);
  const returned = await updateUsagePoints(store, userId, { action: 'start' }, midnight + 6 * 86400_000);
  expect(returned).toMatchObject({ totalEarned: 2, earned: 0, waitSeconds: 1, remainingMs: 1000, awarded: false });
  expect(usageDay(midnight - 1)).toBe('2026-10-31');
  expect(usageDay(midnight)).toBe('2026-11-01');
});

it('服务停机后首次返回只补一轮；零点操作与后台任务竞争也只补发一次', async () => {
  const { store, userId } = await setup();
  const first = await updateUsagePoints(store, userId, { action: 'start' }, base);
  const returned = await updateUsagePoints(store, userId, { action: 'tick', roundId: first.roundId }, base + 5 * 86400_000);
  expect(returned).toMatchObject({ awarded: true, totalEarned: 1, waitSeconds: 1, remainingMs: 1000 });
  const midnight = nextUsageRefresh(base + 5 * 86400_000);
  await Promise.all([refreshUsagePoints(store, midnight), updateUsagePoints(store, userId, { action: 'tick', roundId: returned.roundId }, midnight)]);
  expect((await store.account(userId)).available).toBe(2);
  expect(await store.setting('minted')).toBe(2);
});

it('奖励写入失败全部回滚，原轮次可安全重试', async () => {
  const { store, userId } = await setup();
  const first = await updateUsagePoints(store, userId, { action: 'start' }, base), sequence = await store.latestSequence();
  const fail = vi.spyOn(store, 'ledger').mockRejectedValueOnce(new Error('模拟账本失败'));
  await expect(updateUsagePoints(store, userId, { action: 'tick', roundId: first.roundId }, base + 1000)).rejects.toThrow('模拟账本失败');
  fail.mockRestore();
  expect((await store.account(userId)).available).toBe(0);
  expect(await store.latestSequence()).toBe(sequence);
  expect(await store.setting('minted')).toBe(0);
  expect((await updateUsagePoints(store, userId, { action: 'tick', roundId: first.roundId }, base + 1000)).awarded).toBe(true);
});

it('计时接口需要登录和会话校验，不接受客户端指定等待时间或奖励数量', async () => {
  const { app, agent, session } = await setup();
  expect((await request(app).post('/api/ui/points/activity').send({ action: 'start' })).status).toBe(401);
  expect((await agent.post('/api/ui/points/activity').send({ action: 'start' })).status).toBe(403);
  const post = (body: object) => agent.post('/api/ui/points/activity').set('x-csrf-token', session.csrf).send(body);
  expect((await post({ action: 'start', elapsedMs: 999999, amount: 100 })).status).toBe(400);
  const start = await post({ action: 'start' });
  expect(start.status, start.text).toBe(200);
  expect(start.body).toMatchObject({ waitSeconds: 1, awarded: false });
  expect((await post({ action: 'tick', roundId: start.body.roundId })).body.awarded).toBe(false);
  await app.store.db.prepare('UPDATE usage_points SET "readyAt"=$2 WHERE "userId"=$1').run(session.user.id, Date.now()-1);
  expect((await post({action:'tick',roundId:start.body.roundId})).body.awarded).toBe(true);
  expect((await post({action:'tick',roundId:start.body.roundId})).body.awarded).toBe(false);
});
