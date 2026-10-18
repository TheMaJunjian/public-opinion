import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { cleanupTestDatabases, createTestApp } from './test-database.js';

afterEach(cleanupTestDatabases);

it.each([{ length: 1, password: '1' }, { length: 200, password: '密码'.repeat(100) }])('registers and logs in with a password of $length characters', async ({ password }) => {
  const app = await createTestApp();
  try {
    const registration = await request(app).post('/api/register').send({ name: 'password-test', password });
    expect(registration.status, registration.text).toBe(201);
    const login = await request(app).post('/api/login').send({ name: 'password-test', password });
    expect(login.status, login.text).toBe(200);
    expect(login.body.user.id).toBe(registration.body.user.id);
    const incorrect = await request(app).post('/api/login').send({ name: 'password-test', password: `${password}x` });
    expect(incorrect.status).toBe(401);
  } finally {
    await app.close();
  }
});
