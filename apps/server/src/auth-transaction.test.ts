import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { cleanupTestDatabases, createTestApp } from './test-database.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTestDatabases();
});

const publicKey = () => JSON.stringify(generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }));
const credentials = () => ({ username: 'transaction-test', password: 'transaction-password', deviceId: 'test-device', publicKey: publicKey() });
const registrations = ['users', 'accounts', 'signing_keys', 'messages', 'revisions', 'ledger', 'changes', 'sessions'] as const;

describe('authentication transactions', () => {
  it('registers, reads its signed session, logs out and logs back in without repeating the initial grant', async () => {
    const app = await createTestApp(), agent = request.agent(app), input = credentials();
    const registered = await agent.post('/api/register').send(input);
    expect(registered.status, registered.text).toBe(201);
    expect(registered.body.user).toMatchObject({ name: input.username, founder: true, publicKey: input.publicKey });
    expect(registered.headers['set-cookie']).toBeDefined();
    expect((await agent.get('/api/session')).body.user).toEqual(registered.body.user);
    const sequence = await app.store.latestSequence(), grant = (await app.store.rules()).initialGrant;
    expect(registered.body.account.available).toBe(grant);
    expect((await agent.post('/api/logout').set('x-csrf-token', registered.body.csrf).send({})).status).toBe(200);
    expect((await agent.get('/api/session')).body).toBeNull();

    const wrong = await agent.post('/api/login').send({ ...input, password: 'incorrect' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();
    const loggedIn = await agent.post('/api/login').send(input);
    expect(loggedIn.status, loggedIn.text).toBe(200);
    expect(loggedIn.body.user).toEqual(registered.body.user);
    expect((await agent.get('/api/session')).body.csrf).toBe(loggedIn.body.csrf);
    expect(loggedIn.body.account.available).toBe(grant);
    expect(await app.store.latestSequence()).toBe(sequence);
    expect(await app.store.setting<number>('minted')).toBe(grant);
  });

  it.each(['session insert', 'transaction commit'] as const)('rolls back registration when %s fails and permits a clean retry', async failure => {
    const app = await createTestApp(), input = credentials();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const minted = await app.store.setting<number>('minted'), sequence = await app.store.latestSequence();
    await app.store.db.exec(`
      CREATE FUNCTION reject_session() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'session creation failed'; END;
      $$;
      ${failure === 'session insert'
        ? 'CREATE TRIGGER reject_session BEFORE INSERT ON sessions'
        : 'CREATE CONSTRAINT TRIGGER reject_session AFTER INSERT ON sessions DEFERRABLE INITIALLY DEFERRED'}
      FOR EACH ROW EXECUTE FUNCTION reject_session();
    `);

    const rejected = await request(app).post('/api/register').send(input);
    expect(rejected.status, rejected.text).toBe(500);
    expect(rejected.headers['set-cookie']).toBeUndefined();
    for (const table of registrations) {
      expect(Number((await app.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get())!.n), table).toBe(0);
    }
    expect(await app.store.setting<number>('minted')).toBe(minted);
    expect(await app.store.latestSequence()).toBe(sequence);
    expect((await request(app).get('/api/setup')).body.initialized).toBe(false);

    await app.store.db.exec('DROP TRIGGER reject_session ON sessions');
    const agent = request.agent(app), retry = await agent.post('/api/register').send(input);
    expect(retry.status, retry.text).toBe(201);
    expect(retry.body.user).toMatchObject({ founder: true, publicKey: input.publicKey });
    expect((await agent.get('/api/session')).body.user.id).toBe(retry.body.user.id);
    expect(retry.body.account.available).toBe((await app.store.rules()).initialGrant);
    expect(await app.store.setting<number>('minted')).toBe((await app.store.rules()).initialGrant);
    expect(Number((await app.store.db.prepare('SELECT COUNT(*) AS n FROM ledger').get())!.n)).toBe(1);
  });

  it('keeps the previous device key and expired sessions when login session creation fails', async () => {
    const app = await createTestApp(), agent = request.agent(app), input = credentials();
    const registered = await agent.post('/api/register').send(input);
    expect(registered.status, registered.text).toBe(201);
    const userId = registered.body.user.id, replacement = { ...input, publicKey: publicKey() };
    await app.store.db.prepare('INSERT INTO sessions(token,"userId",csrf,expires,"deviceId") VALUES ($1,$2,$3,0,$4)').run('expired-session', userId, 'expired-csrf', input.deviceId);
    await app.store.db.exec(`
      CREATE FUNCTION reject_session() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'session creation failed'; END;
      $$;
      CREATE TRIGGER reject_session BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION reject_session();
    `);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const failed = await request(app).post('/api/login').send(replacement);
    expect(failed.status, failed.text).toBe(500);
    expect(failed.headers['set-cookie']).toBeUndefined();
    expect((await app.store.db.prepare('SELECT "publicKey" FROM signing_keys WHERE "userId"=$1 AND "deviceId"=$2').get(userId, input.deviceId))!.publicKey).toBe(input.publicKey);
    expect(await app.store.db.prepare('SELECT token FROM sessions WHERE token=$1').get('expired-session')).toBeDefined();
    expect((await agent.get('/api/session')).body.user.publicKey).toBe(input.publicKey);

    await app.store.db.exec('DROP TRIGGER reject_session ON sessions');
    const retried = await agent.post('/api/login').send(replacement);
    expect(retried.status, retried.text).toBe(200);
    expect((await agent.get('/api/session')).body.user.publicKey).toBe(replacement.publicKey);
    expect(await app.store.db.prepare('SELECT token FROM sessions WHERE token=$1').get('expired-session')).toBeUndefined();
    expect(retried.body.account).toEqual(registered.body.account);
  });
});
