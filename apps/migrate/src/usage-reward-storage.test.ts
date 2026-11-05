import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { Mutation, Store } from '../../server/src/db.js';
import { cleanupTestDatabases, createTestApp, testDatabaseUrl } from '../../server/src/test-database.js';
import { financialFingerprint } from './financial-fingerprint.js';

afterEach(cleanupTestDatabases);
it('升级旧账本时只补充历史余额缓存，保留账户和每笔旧流水，重新打开不会重复变更', async () => {
  const app = await createTestApp({ initialGrant: 0 }), store = app.store;
  const { body: session } = await request(app).post('/api/register').send({ name: '旧版账目', password: 'password' });
  await store.transaction(async () => {
    const tx = new Mutation(store), message = await tx.create('system', [{ id: 'body', type: 'text', text: '原发放' }]);
    for (let i = 0; i < 3; i++) await store.ledger(session.user.id, message.id, 1, 0, '使用公论计时奖励');
    await store.set('minted', 3);await tx.commit();
    await store.db.exec('ALTER TABLE ledger DROP COLUMN "balanceAfter"; DROP TABLE usage_reward_days; DELETE FROM schema_migrations WHERE version>=29');
  });
  const before = await financialFingerprint(store.db), account = await store.account(session.user.id), sequence = await store.latestSequence();
  const upgraded = await Store.open(testDatabaseUrl(), { schema: store.db.schema });
  try {
    expect(await financialFingerprint(upgraded.db)).toBe(before);
    expect(await upgraded.account(session.user.id)).toEqual(account);
    expect(await upgraded.db.prepare('SELECT "balanceAfter" FROM ledger ORDER BY position').all()).toEqual([{ balanceAfter: 1 }, { balanceAfter: 2 }, { balanceAfter: 3 }]);
    expect(await upgraded.latestSequence()).toBe(sequence);
    expect(await upgraded.db.prepare('SELECT * FROM usage_reward_days').all()).toEqual([]);
  } finally { await upgraded.close(); }
});
