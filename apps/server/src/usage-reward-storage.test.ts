import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { replayArchive } from '@gonglun/core';
import { Mutation } from './db.js';
import { cleanupTestDatabases, createTestApp } from './test-database.js';
import { updateUsagePoints, nextUsageRefresh, refreshUsagePoints } from './usage-points.js';
import { pointTransactions } from './point-transactions.js';
import { windowSnapshot } from './window-snapshot.js';
import { migrateViewFile } from '../../migrate/src/migrate-view-file.js';
import { validateExportForViewing } from '../../../frontend/src/utils/exportArchive.js';

afterEach(async () => { vi.restoreAllMocks(); await cleanupTestDatabases(); });
async function setup() {
  const app = await createTestApp({ initialGrant: 0 }), agent = request.agent(app);
  const { body: session } = await agent.post('/api/register').send({ name: '存储优化', password: 'password' });
  return { app, store: app.store, userId: session.user.id as string };
}
const base = Date.parse('2026-11-01T00:00:00+08:00');

it('一天领取两百次只存一条奖励账目、一条消息和一个正文版本；增量历史可复算且同步累计值', async () => {
  const { app, store, userId } = await setup();
  let at = base, progress = await updateUsagePoints(store, userId, { action: 'start' }, at);
  let firstSequence = 0, messageId = '';
  for (let i = 0; i < 200; i++) {
    at += progress.remainingMs;
    progress = await updateUsagePoints(store, userId, { action: 'tick', roundId: progress.roundId }, at);
    if (!i) { firstSequence = await store.latestSequence(); messageId = String((await store.db.prepare('SELECT "messageId" FROM usage_reward_days').get())!.messageId); }
  }
  expect((await store.db.prepare('SELECT COUNT(*) AS n FROM ledger').get())!.n).toBe(1);
  expect((await store.db.prepare('SELECT COUNT(*) AS n FROM messages').get())!.n).toBe(1);
  expect((await store.db.prepare('SELECT COUNT(*) AS n FROM revisions').get())!.n).toBe(1);
  expect(await store.db.prepare('SELECT total FROM usage_reward_days').get()).toEqual({ total: 200 });
  expect(await store.db.prepare('SELECT amount,"balanceAfter" FROM ledger').get()).toEqual({ amount: 200, balanceAfter: 200 });
  const changes = (await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row => JSON.parse(String(row.body)));
  expect(changes.filter(change => change.messages.length > 0)).toHaveLength(1);
  expect(changes.filter(change => change.usageRewardTotals?.length)).toHaveLength(199);
  const replay = replayArchive({ format: 'gonglun-2', changes });
  expect(replay.accounts.get(userId)).toEqual(await store.account(userId));
  expect(replay.messages[0]).toEqual(await store.message(messageId));
  expect(JSON.stringify(replay.messages[0])).toContain('累计 200 贡献点');
  const delta = await store.read(() => windowSnapshot(store, { mode: 'window', parent: 'root', knownIds: [messageId], after: firstSequence }));
  expect(JSON.stringify(delta.messages.find(message => message.id === messageId))).toContain('累计 200 贡献点');
  const exported = await request(app).get('/api/ui/export');
  expect(exported.status, exported.text).toBe(200);
  const converted = migrateViewFile(exported.body);
  expect(replayArchive(converted).accounts.get(userId)).toEqual(await store.account(userId));
  expect(JSON.stringify(validateExportForViewing(converted).data.messages)).toContain('累计 200 贡献点');
}, 30_000);

it('累计奖励穿插支出时保持历史余额，跨日补发与当天奖励共用一条当天记录', async () => {
  const { store, userId } = await setup();
  const beforeMidnight = Date.parse('2026-11-01T23:59:57+08:00');
  const first = await updateUsagePoints(store, userId, { action: 'start' }, beforeMidnight);
  await updateUsagePoints(store, userId, { action: 'tick', roundId: first.roundId }, beforeMidnight + 1000);
  const midnight = nextUsageRefresh(beforeMidnight);
  await refreshUsagePoints(store, midnight);
  const next = await updateUsagePoints(store, userId, { action: 'start' }, midnight);
  const progress = await updateUsagePoints(store, userId, { action: 'tick', roundId: next.roundId }, midnight + 1000);
  await store.transaction(async () => {
    const tx = new Mutation(store), message = await tx.create('system', [{ id: 'body', type: 'text', text: '支出' }]);
    await store.ledger(userId, message.id, -2, 0, '协议费');await store.operating(2);await tx.commit();
  });
  await updateUsagePoints(store, userId, { action: 'tick', roundId: progress.roundId }, midnight + 3000);
  const rows = await pointTransactions(store, userId, {});
  expect(rows.data[0]).toMatchObject({ type: 'USAGE_REWARD', amount: 3, data: { day: '2026-11-02', count: 3 } });
  expect(rows.data[1]).toMatchObject({ type: 'SPEND', amount: -2, balanceAfter: 1 });
  expect((await store.account(userId)).available).toBe(2);
  expect(await store.db.prepare('SELECT day,total FROM usage_reward_days ORDER BY day').all()).toEqual([
    { day: '2026-11-01', total: 1 }, { day: '2026-11-02', total: 3 },
  ]);
});

it('累计途中写入失败时原金额、消息和计时轮次全部保留，可安全重试', async () => {
  const { store, userId } = await setup();
  const first = await updateUsagePoints(store, userId, { action: 'start' }, base);
  const second = await updateUsagePoints(store, userId, { action: 'tick', roundId: first.roundId }, base + 1000);
  const ledger = await store.db.prepare('SELECT * FROM ledger').get(), message = await store.message(String(ledger!.messageId)), sequence = await store.latestSequence();
  const failure = vi.spyOn(store, 'ledger').mockRejectedValueOnce(new Error('模拟累计失败'));
  await expect(updateUsagePoints(store, userId, { action: 'tick', roundId: second.roundId }, base + 3000)).rejects.toThrow('模拟累计失败');
  failure.mockRestore();
  expect(await store.db.prepare('SELECT * FROM ledger').get()).toEqual(ledger);
  expect(await store.message(message.id)).toEqual(message);
  expect(await store.latestSequence()).toBe(sequence);
  expect(await store.db.prepare('SELECT total FROM usage_reward_days').get()).toEqual({ total: 1 });
  expect((await updateUsagePoints(store, userId, { action: 'tick', roundId: second.roundId }, base + 3000)).awarded).toBe(true);
});
