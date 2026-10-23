import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { Store } from './db.js';
import { cleanupTestDatabases, createTestApp, newTestSchema, testDatabaseUrl } from './test-database.js';

afterEach(cleanupTestDatabases);

it('shares the password attempt budget with signing-key rotation', async () => {
  const app = await createTestApp();
  const agent = request.agent(app);
  const registered = await agent.post('/api/register').send({name:'release-user',password:'release-password'});
  expect(registered.status).toBe(201);
  for (let attempt = 0; attempt < 29; attempt++) {
    const response = await agent.post('/api/ui/auth/signing-key').set('x-csrf-token',registered.body.csrf).send({password:'wrong-password'});
    expect(response.status).toBe(401);
  }
  expect((await agent.post('/api/ui/auth/signing-key').set('x-csrf-token',registered.body.csrf).send({password:'release-password'})).status).toBe(429);
  expect((await agent.post('/api/login').send({name:'release-user',password:'release-password'})).status).toBe(429);
});

it('refuses to initialize new tables alongside a legacy production schema', async () => {
  const schema = newTestSchema();
  const pool = new Pool({connectionString:testDatabaseUrl()});
  try {
    await pool.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}"."User" (id TEXT PRIMARY KEY)`);
    await expect(Store.open(testDatabaseUrl(),{schema})).rejects.toThrow('迁移');
    const result = await pool.query('SELECT to_regclass($1) AS table_name',[`${schema}.settings`]);
    expect(result.rows[0].table_name).toBeNull();
  } finally { await pool.end(); }
});
