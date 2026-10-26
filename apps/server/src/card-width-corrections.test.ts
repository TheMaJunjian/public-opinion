import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { cleanupTestDatabases, createTestApp, withTestCommandContributions } from './test-database.js';
import { parseSend } from './validation.js';

const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); await cleanupTestDatabases(); });

it('persists width corrections of text and every organization as voted display records without changing the target', async () => {
  const app = await createTestApp(); apps.push(app);
  const agent = request.agent(app);
  const registration = await agent.post('/api/register').send({ username: '宽度编辑者', password: 'test-password-123' });
  expect(registration.status).toBe(201);
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await agent.post(`/api/ui${path}`).set('x-csrf-token', registration.body.csrf)
      .set('x-request-id', randomUUID()).send(withTestCommandContributions(path, body));
    expect(response.status, response.text).toBe(201); return response.body;
  };
  const original = await post('/messages', { content: '原始正文保留' });
  const targets = [original];
  for (const relationType of ['MERGE', 'ARRANGE', 'CLASSIFY', 'SUMMARY']) targets.push(await post('/relations', {
    relationType, targetRefs: [{ kind: 'message', messageId: original.id }], payload: { title: relationType, content: relationType },
  }));
  const corrections: Array<{ id: string }> = [];
  for (const target of targets) {
    const width = await post('/relations', { relationType: 'CORRECT', targetRefs: [{ kind: 'message', messageId: target.id }],
      payload: { correctionKind: 'WIDTH', correctionWidth: 640, correctionContent: '不会替换正文' } });
    corrections.push(width);
    expect(width.payload).toMatchObject({ correctionKind: 'WIDTH', correctionWidth: 640 });
    expect(width.payload.correctionAfterContent).toBeUndefined();
    expect(width.parts.some((part: { type: string; relation?: string }) => part.type === 'relation' && part.relation === 'correct')).toBe(true);
    expect(width.parts.some((part: { type: string; relation?: string }) => part.relation === 'amend')).toBe(false);
  }
  await post('/relations', { relationType: 'DISAGREE', targetRefs: [{ kind: 'message', messageId: corrections[0].id }] });
  const snapshot = await agent.get('/api/ui/snapshot');
  expect(snapshot.status).toBe(200);
  for (const target of targets) {
    const saved = snapshot.body.messages.find((message: { id: string }) => message.id === target.id);
    expect(saved.revision).toBe(target.revision);
    expect(saved.parts).toEqual(target.parts);
  }
  const rejected = snapshot.body.messages.find((message: { id: string }) => message.id === corrections[0].id);
  expect(rejected.state.oppositionCount).toBe(1);
  expect(rejected.relationPayload ?? rejected.payload).toMatchObject({ correctionKind: 'WIDTH', correctionWidth: 640 });
  for (const width of [0, 319, 2401, 500.5, '640']) {
    const response = await agent.post('/api/ui/relations').set('x-csrf-token', registration.body.csrf).set('x-request-id', randomUUID())
      .send({ relationType: 'CORRECT', targetRefs: [{ kind: 'message', messageId: original.id }], payload: { correctionKind: 'WIDTH', correctionWidth: width }, recommendation: 1 });
    expect(response.status).toBe(400);
  }
});

it('validates native width records against the same range and whole-message addressing rule', () => {
  const input = (width: unknown, reference: Record<string, unknown> = { messageId: 'target' }) => ({ requestId: randomUUID(), parts: [
    { id: 'relation', type: 'relation', relation: 'correct', roles: { target: [{ id: 'target', reference }] } },
    { id: 'data', type: 'data', value: { correctionKind: 'WIDTH', correctionWidth: width } },
  ] });
  expect(() => parseSend(input(640))).not.toThrow();
  expect(() => parseSend(input(319))).toThrow();
  expect(() => parseSend(input(640, { messageId: 'target', partId: 'body' }))).toThrow();
  expect(() => parseSend(input(640, { messageId: 'target', revision: 1 }))).toThrow();
});
