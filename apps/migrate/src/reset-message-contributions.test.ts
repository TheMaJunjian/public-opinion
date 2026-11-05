import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { replayArchive, type Message, type Part } from '@gonglun/core';
import { Mutation, Store } from '../../server/src/db.js';
import { terminate } from '../../server/src/economy.js';
import { chargeMessage } from '../../server/src/message-spending.js';
import { snapshot, stakesFor } from '../../server/src/ui-projections.js';
import { cleanupTestDatabases, createTestApp, testDatabaseUrl } from '../../server/src/test-database.js';
import { updateUsagePoints } from '../../server/src/usage-points.js';
import { resetContributionPoints } from './reset-contribution-points.js';
import { fundResetMessageContributions, resetMessageContributionPlan } from './reset-message-contributions.js';
import { financialFingerprint } from './financial-fingerprint.js';

afterEach(async () => { vi.restoreAllMocks(); await cleanupTestDatabases(); });

async function setup(paidJoin = false) {
  const app = await createTestApp(), agent = request.agent(app), store = app.store;
  const { body: session } = await agent.post('/api/register').send({ name: '旧消息补扣', password: 'password' });
  const send = async (parts: Part[], extra: object = { recommendation: 4 }) => {
    const result = await agent.post('/api/messages').set('x-csrf-token', session.csrf)
      .send({ requestId: randomUUID(), parts, ...extra });
    expect(result.status, result.text).toBe(201);
    return result.body.message as Message;
  };
  const text = await send([{ id: 'body', type: 'text', text: '普通旧正文' }]);
  const stance = await send([{ id: 'relation', type: 'relation', relation: 'agree', roles: {
    target: [{ id: 'target', reference: { messageId: text.id } }],
  } }], { wager: 7 });
  const annotation = await send([{ id: 'relation', type: 'relation', relation: 'follow', reason: 'YES', roles: {
    target: [{ id: 'target', reference: { messageId: text.id } }],
  } }]);
  await store.transaction(async () => {
    const tx = new Mutation(store);
    await tx.create(session.user.id, [{ id: 'relation', type: 'relation', relation: 'settlement', roles: {} }]);
    await tx.create(session.user.id, [
      { id: 'relation', type: 'relation', relation: 'member-of', roles: { member: [{ id: 'member', reference: { messageId: text.id } }] } },
      { id: 'data', type: 'data', value: { generatedBy: text.id } },
    ]);
    if (paidJoin) {
      const join = await tx.create(session.user.id, [
        { id: 'relation', type: 'relation', relation: 'member-of', roles: { member: [{ id: 'member', reference: { messageId: text.id } }] } },
        { id: 'data', type: 'data', value: { generatedBy: text.id } },
      ], { protocol: 1, recommendation: 1, wager: 0 });
      await chargeMessage(store, join);
    }
    await tx.commit();
    await store.db.prepare("DELETE FROM settings WHERE key='usage-points-start'").run();
    await resetContributionPoints(store);
  });
  return { app, agent, store, userId: session.user.id as string, text, stance, annotation, send };
}

async function replayMatches(store: Store, userId: string) {
  const changes = (await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row => JSON.parse(String(row.body)));
  const replay = replayArchive({ format: 'gonglun-2', changes });
  expect(replay.accounts.get(userId)).toEqual(await store.account(userId));
  for (const message of replay.messages) expect(await store.message(message.id)).toEqual(message);
}

it('只对清零前的付费用户消息按当前最低标准补扣，允许负余额，保留新积分及原始正文、关系和执行依据', async () => {
  const { store, userId, text, stance, annotation } = await setup();
  const at = Date.now(), first = await updateUsagePoints(store, userId, { action: 'start' }, at);
  await updateUsagePoints(store, userId, { action: 'tick', roundId: first.roundId }, at + 1000);
  await store.transaction(async () => store.set('rules', { ...await store.rules(), protocolFee: 2 }));
  const originals = await Promise.all([text, stance, annotation].map(message => store.message(message.id)));
  const ledger = await store.db.prepare('SELECT * FROM ledger ORDER BY position').all();
  const memberships = await store.db.prepare('SELECT * FROM memberships ORDER BY "memberId"').all();
  const executions = await store.db.prepare('SELECT * FROM execution_stances ORDER BY "sourceId",revision,"partId"').all();
  const display = await store.db.prepare('SELECT * FROM display_stances ORDER BY "sourceId"').all();
  expect(await resetMessageContributionPlan(store)).toMatchObject({ pending: 3, protocolFee: 2, total: 9 });
  expect(await store.transaction(() => fundResetMessageContributions(store))).toBe(3);
  expect(await store.account(userId)).toEqual({ available: -8, locked: 2, earned: 1, spent: 7 });
  expect(await store.setting('minted')).toBe(1);
  expect(await store.setting('operating')).toBe(7);
  expect((await store.db.prepare('SELECT * FROM ledger ORDER BY position').all()).slice(0, ledger.length)).toEqual(ledger);
  expect(await store.db.prepare('SELECT * FROM memberships ORDER BY "memberId"').all()).toEqual(memberships);
  expect(await store.db.prepare('SELECT * FROM execution_stances ORDER BY "sourceId",revision,"partId"').all()).toEqual(executions);
  expect(await store.db.prepare('SELECT * FROM display_stances ORDER BY "sourceId"').all()).toEqual(display);
  for (const original of originals) {
    const message = await store.message(original.id);
    expect(message.parts).toEqual(original.parts);
    expect(message.revision).toBe(original.revision);
    expect(message.spending.protocol).toBe(2);
    expect(message.spending.wager + message.spending.recommendation).toBe(1);
  }
  const stakes = (await stakesFor(store, [text.id]))[text.id]!;
  expect(stakes.countsByType).toEqual({ TRUTH: { pro: 1, con: 0 }, VALUE: { pro: 1, con: 0 } });
  expect(stakes.pool).toEqual({ lockedPro: 2, lockedCon: 0 });
  expect(await resetMessageContributionPlan(store)).toMatchObject({ pending: 0 });
  const sequence = await store.latestSequence();
  expect(await store.transaction(() => fundResetMessageContributions(store))).toBe(0);
  expect(await store.latestSequence()).toBe(sequence);
  await replayMatches(store, userId);
});

it('使用贡献抵扣欠额，负余额仍拒绝普通透支发送，补扣押注可以结算返还', async () => {
  const { store, userId, text, send } = await setup();
  await store.transaction(() => fundResetMessageContributions(store));
  expect((await store.account(userId)).available).toBe(-6);
  const at = Date.now(), progress = await updateUsagePoints(store, userId, { action: 'start' }, at);
  await updateUsagePoints(store, userId, { action: 'tick', roundId: progress.roundId }, at + 1000);
  expect((await store.account(userId)).available).toBe(-5);
  await expect(send([{ id: 'body', type: 'text', text: '仍不能透支发言' }], { recommendation: 1 })).rejects.toThrow();
  await store.transaction(async () => {
    const tx = new Mutation(store), message = await tx.create(userId, [{ id: 'relation', type: 'relation', relation: 'terminate', roles: {
      target: [{ id: 'target', reference: { messageId: text.id, revision: 1 } }],
    } }]);
    await terminate(tx, message);await tx.commit();
  });
  expect((await store.account(userId)).available).toBe(-4);
  expect((await store.account(userId)).locked).toBe(1);
  await replayMatches(store, userId);
});

it('补扣写入失败时账户、消息、账目和审计一起回滚，重试只补扣一次', async () => {
  const { store } = await setup();
  const before = await financialFingerprint(store.db), sequence = await store.latestSequence();
  const messages = await store.db.prepare('SELECT * FROM messages ORDER BY id').all();
  const failure = vi.spyOn(store, 'ledger').mockRejectedValueOnce(new Error('模拟补扣失败'));
  await expect(store.transaction(() => fundResetMessageContributions(store))).rejects.toThrow('模拟补扣失败');
  failure.mockRestore();
  expect(await financialFingerprint(store.db)).toBe(before);
  expect(await store.latestSequence()).toBe(sequence);
  expect(await store.db.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(messages);
  expect(await resetMessageContributionPlan(store)).toMatchObject({ pending: 3 });
  expect(await store.transaction(() => fundResetMessageContributions(store))).toBe(3);
});

it('归档内容被改动时停止补扣，不改余额或消息', async () => {
  const { store } = await setup();
  const before = await financialFingerprint(store.db);
  await store.db.prepare(`UPDATE points_archive_rows SET body=jsonb_set(body,'{body}',to_jsonb((body->>'body')||' ')) WHERE "tableName"='messages'`).run();
  await expect(store.transaction(() => fundResetMessageContributions(store))).rejects.toThrow('旧消息归档校验失败');
  expect(await financialFingerprint(store.db)).toBe(before);
});

it('曾独立付费的自动JOIN仍补扣，免费派生记录不收费，冻结目标只开放实际新增投入的地址', async () => {
  const { store, userId, text } = await setup(true);
  await store.db.prepare('INSERT INTO settlement_access VALUES($1,$2) ON CONFLICT("messageId") DO UPDATE SET allowed_keys=excluded.allowed_keys')
    .run(text.id, []);
  expect(await store.transaction(() => fundResetMessageContributions(store))).toBe(4);
  expect((await store.account(userId)).available).toBe(-8);
  expect((await store.db.prepare('SELECT COUNT(*) AS n FROM reset_message_contributions').get())!.n).toBe(4);
  expect((await store.db.prepare('SELECT allowed_keys FROM settlement_access WHERE "messageId"=$1').get(text.id))!.allowed_keys).toHaveLength(1);
  await store.transaction(async () => {
    const tx = new Mutation(store), message = await tx.create(userId, [{ id: 'relation', type: 'relation', relation: 'terminate', roles: {
      target: [{ id: 'target', reference: { messageId: text.id, revision: 1 } }],
    } }]);
    await terminate(tx, message);await tx.commit();
  });
  expect((await store.account(userId)).available).toBe(-7);
  await replayMatches(store, userId);
});

it('已清零的版本30数据库自动补扣一次，保留切换后已付费消息和新积分', async () => {
  const { store, userId, send } = await setup();
  const at = Date.now();let progress = await updateUsagePoints(store, userId, { action: 'start' }, at), time = at;
  for (let i = 0; i < 3; i++) {
    time += progress.remainingMs;
    progress = await updateUsagePoints(store, userId, { action: 'tick', roundId: progress.roundId }, time);
  }
  const recent = await send([{ id: 'body', type: 'text', text: '新规则已付费' }], { recommendation: 1 });
  const original = await store.message(recent.id);
  await store.db.prepare('DELETE FROM schema_migrations WHERE version=31').run();
  const upgraded = await Store.open(testDatabaseUrl(), { schema: store.db.schema });
  try {
    expect((await upgraded.account(userId)).available).toBe(-5);
    expect(await upgraded.message(recent.id)).toEqual(original);
    expect((await snapshot(upgraded, 'root', {})).users.find(user => user.id === userId))
      .toMatchObject({ usageContribution: 3, rechargeContribution: 0 });
    expect(await resetMessageContributionPlan(upgraded)).toMatchObject({ pending: 0 });
    await replayMatches(upgraded, userId);
    const sequence = await upgraded.latestSequence();
    const again = await Store.open(testDatabaseUrl(), { schema: store.db.schema });
    try { expect(await again.latestSequence()).toBe(sequence); } finally { await again.close(); }
  } finally { await upgraded.close(); }
});
