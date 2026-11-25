import { randomUUID } from 'node:crypto';
import { PARTICIPATION_AGREEMENT_VERSION } from '@gonglun/core';
import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { openMigratingStore } from '../../migrate/src/migrations.js';
import { cleanupTestDatabases, createTestApp, newTestSchema, testDatabaseUrl } from './test-database.js';

afterEach(cleanupTestDatabases);
const credentials = { name: '参与者甲', password: 'test-password' };
const acceptance = { acceptedAgreementVersion: PARTICIPATION_AGREEMENT_VERSION };

it('creates an ordinary account only on explicit acceptance and keeps the receipt private', async () => {
  const app = await createTestApp(), agent = request.agent(app);
  for (const input of [{}, {acceptedAgreementVersion:'old'}]) {
    const rejected = await agent.post('/api/register').send({...credentials,...input});
    expect(rejected.status).toBe(428);
    expect(rejected.body.code).toBe('AGREEMENT_REQUIRED');
    expect(rejected.headers['set-cookie']).toBeUndefined();
  }
  const joined = await agent.post('/api/register').send({...credentials,...acceptance});
  expect(joined.status,joined.text).toBe(201);
  expect(joined.body.user.founder).toBe(false);
  const receipts = () => app.store.db.prepare('SELECT version,"acceptedAt" FROM participation_acceptances WHERE "userId"=$1').all(joined.body.user.id);
  const saved = await receipts();
  expect(saved).toEqual([{version:PARTICIPATION_AGREEMENT_VERSION,acceptedAt:expect.anything()}]);
  expect((await agent.post('/api/login').send(credentials)).status).toBe(200);
  expect(await receipts()).toEqual(saved);
  expect((await agent.get('/api/export')).text).not.toContain(PARTICIPATION_AGREEMENT_VERSION);
});

it('preserves accounts across an upgrade and requires fresh consent without reviving an old session', async () => {
  const schema = newTestSchema(), app = await createTestApp({databaseSchema:schema}), old = request.agent(app);
  const joined = await old.post('/api/register').send({...credentials,...acceptance});
  const before = await app.store.account(joined.body.user.id);
  await app.store.db.exec('DROP TABLE participation_acceptances; ALTER TABLE sessions DROP COLUMN "agreementVersion"; DELETE FROM schema_migrations WHERE version>=49');
  const upgraded = await openMigratingStore(testDatabaseUrl(), {schema});
  try {
    expect((await old.get('/api/session')).body).toBeNull();
    const agent = request.agent(app);
    expect((await agent.post('/api/login').send({...credentials, password:'wrong',...acceptance})).status).toBe(401);
    expect((await agent.post('/api/login').send(credentials)).status).toBe(428);
    expect(await upgraded.db.prepare('SELECT 1 FROM participation_acceptances').get()).toBeUndefined();
    expect((await agent.post('/api/login').send({...credentials,...acceptance})).status).toBe(200);
    expect((await old.get('/api/session')).body).toBeNull();
    expect(await upgraded.account(joined.body.user.id)).toEqual(before);
    await upgraded.db.prepare('INSERT INTO disabled_accounts VALUES ($1,$2,$3)').run(joined.body.user.id,new Date().toISOString(),'historical');
    expect((await agent.get('/api/session')).body).toBeNull();
    expect((await agent.post('/api/login').send({...credentials,...acceptance})).body.code).toBe('ACCOUNT_DISABLED');
  } finally { await upgraded.close(); }
});

it('gives historical founders the same permissions on accounts and public funds', async () => {
  const app = await createTestApp(), agent = request.agent(app);
  const {body:session} = await agent.post('/api/register').send({...credentials,...acceptance});
  await app.store.db.prepare('UPDATE users SET founder=1 WHERE id=$1').run(session.user.id);
  expect((await agent.get('/api/admin/accounts')).status).toBe(404);
  expect((await agent.post('/api/admin/invites').set('x-csrf-token',session.csrf).send({expiresInDays:1})).status).toBe(404);
  expect((await agent.post('/api/admin/accounts/other/status').set('x-csrf-token',session.csrf).send({disabled:true})).status).toBe(404);
  const mint = await agent.post('/api/messages').set('x-csrf-token',session.csrf).send({
    requestId:randomUUID(),recommendation:1,parts:[{id:'credit',type:'relation',relation:'credit',roles:{}},{id:'data',type:'data',value:{amount:100}}]});
  expect(mint.status).toBe(403);
  expect(await app.store.account(session.user.id)).toEqual(session.account);
});
