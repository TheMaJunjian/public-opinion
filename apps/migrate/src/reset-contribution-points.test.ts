import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { replayArchive } from '@gonglun/core';
import { cleanupTestDatabases, createTestApp } from '../../server/src/test-database.js';
import { processDue } from '../../server/src/messages.js';
import { updateUsagePoints } from '../../server/src/usage-points.js';
import { accountView, stakesFor } from '../../server/src/ui-projections.js';
import { resetContributionPoints } from './reset-contribution-points.js';
import { financialFingerprint } from './financial-fingerprint.js';
import { minimumContributionCandidates } from './backfill-minimum-contributions.js';

afterEach(cleanupTestDatabases);
async function legacy() {
  const app = await createTestApp(), agent = request.agent(app);
  const { body: session } = await agent.post('/api/register').send({ name: '旧账户', password: 'password' });
  const response = await agent.post('/api/messages').set('x-csrf-token', session.csrf).send({ requestId: randomUUID(), wager: 3, recommendation: 2, selfStance: 'pro', parts: [{ id: 'body', type: 'text', text: '保留原始内容' }] });
  expect(response.status, response.text).toBe(201);
  await app.store.db.prepare("DELETE FROM settings WHERE key='usage-points-start'").run();
  return { app, agent, store: app.store, session, message: response.body.message };
}

it('逐行归档旧账户、押注、流水和消息后清零，保留消息图和原历史，新旧执行记录均可复算，重复升级不重置', async () => {
  const { store, agent, session, message } = await legacy();
  const account = await store.account(session.user.id), original = await store.message(message.id);
  const ledger = await store.db.prepare('SELECT * FROM ledger ORDER BY position').all();
  const refs = await store.db.prepare('SELECT * FROM refs ORDER BY "sourceId","targetId"').all();
  await store.transaction(() => resetContributionPoints(store));
  expect(await store.account(session.user.id)).toEqual({ available: 0, locked: 0, earned: 0, spent: 0 });
  expect(await store.db.prepare('SELECT * FROM ledger ORDER BY position').all()).toEqual(ledger);
  expect(await store.db.prepare('SELECT * FROM refs ORDER BY "sourceId","targetId"').all()).toEqual(refs);
  expect((await store.message(message.id)).parts).toEqual(original.parts);
  expect((await store.message(message.id)).spending).toEqual({ protocol: 0, recommendation: 0, wager: 0 });
  expect(await store.db.prepare('SELECT * FROM rounds').all()).toEqual([]);
  expect((await stakesFor(store, [message.id]))[message.id].stakes).toEqual([]);
  expect(await minimumContributionCandidates(store.db)).toEqual([]);
  expect((await accountView(store, session.user.id)).breakdown).toEqual({ initialMinted: 0, totalEarned: 0, totalLost: 0, totalProtocolFees: 0 });
  expect((await agent.get('/api/ui/points/transactions')).body.data).toEqual([]);
  const archive = (await store.db.prepare('SELECT * FROM points_archives').get())!;
  expect((await store.db.prepare('SELECT body FROM points_archive_rows WHERE "archiveId"=$1 AND "tableName"=$2').get(archive.id, 'accounts'))!.body)
    .toEqual({ userId: session.user.id, ...account });
  const oldChanges = (await store.db.prepare('SELECT body FROM points_archive_rows WHERE "archiveId"=$1 AND "tableName"=$2 ORDER BY position').all(archive.id, 'changes')).map(row => JSON.parse(row.body.body));
  expect(replayArchive({ format: 'gonglun-2', changes: oldChanges }).accounts.get(session.user.id)).toEqual(account);
  const changes = (await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row => JSON.parse(String(row.body)));
  expect(replayArchive({ format: 'gonglun-2', changes }).accounts.get(session.user.id)).toEqual(await store.account(session.user.id));
  const sequence = await store.latestSequence();
  await store.transaction(() => resetContributionPoints(store));
  await processDue(store);
  expect(await store.latestSequence()).toBe(sequence);
  const time = Date.now(), first = await updateUsagePoints(store, session.user.id, { action: 'start' }, time);
  await updateUsagePoints(store, session.user.id, { action: 'tick', roundId: first.roundId }, time + 1000);
  expect((await store.account(session.user.id)).available).toBe(1);
  expect((await accountView(store, session.user.id)).breakdown.initialMinted).toBe(0);
  expect((await store.rules()).initialGrant).toBe(0);
});

it('归档校验不通过时保留全部旧数据，归档和清零一起回滚', async () => {
  const { store, session } = await legacy();
  const before = await financialFingerprint(store.db), sequence = await store.latestSequence(), account = await store.account(session.user.id);
  await store.db.exec(`CREATE FUNCTION corrupt_points_archive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."tableName"='accounts' THEN NEW.body=jsonb_set(NEW.body,'{available}','999999'::jsonb); END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER corrupt_points_archive BEFORE INSERT ON points_archive_rows FOR EACH ROW EXECUTE FUNCTION corrupt_points_archive();`);
  await expect(store.transaction(() => resetContributionPoints(store))).rejects.toThrow('旧贡献点归档校验失败：accounts');
  expect(await financialFingerprint(store.db)).toBe(before);
  expect(await store.account(session.user.id)).toEqual(account);
  expect(await store.latestSequence()).toBe(sequence);
  expect(await store.db.prepare('SELECT * FROM points_archives').all()).toEqual([]);
  expect(await store.db.prepare("SELECT 1 FROM settings WHERE key='usage-points-start'").get()).toBeUndefined();
});
