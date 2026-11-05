import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { cleanupTestDatabases, createTestApp } from '../../server/src/test-database.js';
import { updateUsagePoints, refreshUsagePoints, nextUsageRefresh } from '../../server/src/usage-points.js';
import { migrateDailyUsagePoints } from './daily-usage-points.js';
import { financialFingerprint } from './financial-fingerprint.js';

afterEach(cleanupTestDatabases);
it('将早期计时记录备份并转换到每日规则，保留新积分、递增次数和等待进度，不重复转换', async () => {
  const app = await createTestApp({ initialGrant: 0 }), agent = request.agent(app), store = app.store;
  const { body: session } = await agent.post('/api/register').send({ name: '早期计时', password: 'password' });
  const at = Date.now(), first = await updateUsagePoints(store, session.user.id, { action: 'start' }, at);
  await updateUsagePoints(store, session.user.id, { action: 'tick', roundId: first.roundId }, at + 1000);
  await store.db.exec(`DROP TABLE usage_points;
    CREATE TABLE usage_points("userId" TEXT PRIMARY KEY,earned BIGINT NOT NULL,"roundId" TEXT NOT NULL,
      "elapsedMs" BIGINT NOT NULL,"lastSeenAt" BIGINT NOT NULL,"activeUntil" BIGINT NOT NULL,owner TEXT NOT NULL);`);
  await store.db.prepare('INSERT INTO usage_points VALUES($1,1,$2,500,$3,$3,$4)').run(session.user.id, 'pending-round', Date.now(), 'tab');
  const original = await store.db.prepare('SELECT * FROM usage_points').get(), before = await financialFingerprint(store.db);
  await store.transaction(() => migrateDailyUsagePoints(store));
  expect(await financialFingerprint(store.db)).toBe(before);
  expect((await store.db.prepare('SELECT body FROM usage_points_v27_archive').get())!.body).toEqual(original);
  const progress = await updateUsagePoints(store, session.user.id, { action: 'start' });
  expect(progress).toMatchObject({ roundId: 'pending-round', earned: 1, totalEarned: 1, waitSeconds: 2 });
  expect(progress.remainingMs).toBeGreaterThan(0);
  expect(progress.remainingMs).toBeLessThanOrEqual(1500);
  await store.transaction(() => migrateDailyUsagePoints(store));
  await refreshUsagePoints(store, nextUsageRefresh(at));
  expect((await store.account(session.user.id)).available).toBe(2);
});
