import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, createTestStore, cleanupTestDatabases } from './test-database.js';
import { executeBatch } from './ui-commands.js';
import { queueCommand, runCommandBatch, type CommandEnvelope } from '../../../frontend/src/api/commandBatch.js';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(),
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); }, key: index => [...values.keys()][index] ?? null };
}
afterEach(async () => { await cleanupTestDatabases(); vi.unstubAllGlobals(); });

it('reconciles a lost committed response with one database receipt, then accepts a new identical send', async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('window', new EventTarget());
  const app = await createTestApp();
  const registration = await request(app).post('/api/register').send({ username: '合成重试验收', password: 'only-for-local-retry-test' });
  expect(registration.status, registration.text).toBe(201);
  const user = registration.body.user;
  localStorage.setItem('user', JSON.stringify(user));
  const envelopes: CommandEnvelope[] = [];
  let loseResponse = true;
  const commit = async (input: CommandEnvelope) => {
    envelopes.push(input);
    const result = await executeBatch(app.store, user, input);
    if (loseResponse) {
      loseResponse = false;
      throw Object.assign(new Error('合成：已提交但响应丢失'), { unknownOutcome: true });
    }
    return result;
  };
  const completed = vi.fn();
  const send = () => runCommandBatch(async () => {
    const target = queueCommand('/messages', { method: 'POST', body: JSON.stringify({ content: '合成：同一意图与后续重复发言', recommendation:1 }) })!;
    queueCommand('/relations', { method: 'POST', body: JSON.stringify({ relationType: 'AGREE', wager:1, targetRefs: [{ kind: 'message', messageId: target.id }] }) });
    return target.id;
  }, commit, completed, { apiBase: 'http://synthetic-retry.invalid/api' });
  await expect(send()).rejects.toMatchObject({ unknownOutcome: true });
  expect((await app.store.db.prepare('SELECT COUNT(*) AS n FROM command_requests WHERE "userId"=$1').get(user.id))!.n).toBe(1);
  const recovered = await send();
  expect(envelopes[1]).toEqual(envelopes[0]);
  expect(recovered).toBe(envelopes[0].commands[0].id);
  expect(completed).toHaveBeenCalledExactlyOnceWith(2);
  expect((await app.store.db.prepare('SELECT COUNT(*) AS n FROM command_requests WHERE "userId"=$1').get(user.id))!.n).toBe(1);
  const subsequent = await send();
  expect(subsequent).not.toBe(recovered);
  expect(envelopes[2].requestId).not.toBe(envelopes[0].requestId);
  expect((await app.store.db.prepare('SELECT COUNT(*) AS n FROM command_requests WHERE "userId"=$1').get(user.id))!.n).toBe(2);
  expect((await app.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE "authorId"=$1 AND body::jsonb @> $2::jsonb').get(user.id,
    JSON.stringify({ parts: [{ type: 'text', text: '合成：同一意图与后续重复发言' }] })))!.n).toBe(2);
});

it('commits overlapping retries from separate database connections only once', async () => {
  const app = await createTestApp();
  const registration = await request(app).post('/api/register').send({ username: '并发重试验收', password: 'only-for-local-retry-test' });
  expect(registration.status, registration.text).toBe(201);
  const user = registration.body.user;
  const other = await createTestStore(app.store.db.schema);
  const messageId = randomUUID();
  const input: CommandEnvelope = { requestId: randomUUID(), commands: [
    { id: messageId, method: 'POST', path: '/messages', body: { content: '并发重试仅创建一次', recommendation:1 } },
    { id: randomUUID(), method: 'POST', path: '/relations', body: { wager:1, relationType: 'AGREE', targetRefs: [{ kind: 'message', messageId }] } },
  ] };
  const [first, retry] = await Promise.all([executeBatch(app.store, user, input), executeBatch(other, user, input)]);
  expect(retry.results).toEqual(first.results);
  expect(retry.sequence).toBe(first.sequence);
  expect((await app.store.db.prepare('SELECT COUNT(*) AS n FROM command_requests WHERE "userId"=$1').get(user.id))!.n).toBe(1);
  expect((await app.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id=$1').get(messageId))!.n).toBe(1);
  expect((await app.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id=$1').get(input.commands[1].id))!.n).toBe(1);
});
