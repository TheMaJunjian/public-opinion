import {withTestCommandContributions} from './test-database.js';
import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, cleanupTestDatabases } from './test-database.js';
import type { Reference } from '@gonglun/core';

const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); await cleanupTestDatabases(); });
async function setup() {
  const app = await createTestApp(); apps.push(app);
  const actors = [];
  for (const username of ['原作者', '修订者', '判定者', '另一判定者']) {
    const agent = request.agent(app), response = await agent.post('/api/register').send({ username, password: 'test-password-123' });
    expect(response.status, response.text).toBe(201);
    const post = async (path: string, body: object = {}) => {
      const sent = await agent.post(`/api/ui${path}`).set('x-csrf-token', response.body.csrf).set('x-request-id', randomUUID()).send(withTestCommandContributions(path,body as Record<string,unknown>));
      expect(sent.status, sent.text).toBe(201); return sent.body;
    };
    actors.push({ agent, post, id: response.body.user.id, csrf: response.body.csrf });
  }
  const [author, editor, voter, other] = actors as [typeof actors[number], typeof actors[number], typeof actors[number], typeof actors[number]];
  const original = await author.post('/messages', { content: '地求是圆的。' });
  const originalRef: Reference = { messageId: original.id, revision: 1 };
  const beforeCorrection = (await voter.agent.get('/api/ui/snapshot')).body;
  const corrected = await editor.post('/relations', { relationType: 'CORRECT', targetRefs: [{ kind: 'message', messageId: original.id, reference: { ...originalRef, partId: 'body', path: ['text'] } }], payload: { correctionContent: '地球是圆的。' } });
  expect(corrected.payload.correctionKind).toBe('TEXT');
  const correctionRef: Reference = { messageId: corrected.id, revision: 1 };
  const stance = (actor: typeof author, ref: Reference, side = 'AGREE', amount = 0) => actor.post('/relations', { relationType: side, targetRefs: [{ kind: 'message', messageId: ref.messageId, reference: ref }], stakeAmount: amount });
  const stakes = async (ref: Reference) => {
    const response = await author.agent.get(`/api/ui/messages/${ref.messageId}/stakes`);
    expect(response.status, response.text).toBe(200); return response.body;
  };
  return { app, author, editor, voter, other, original, corrected, originalRef, correctionRef, stance, stakes, beforeCorrection };
}

it('delivers a correction to another user immediately and updates public counts from each user’s latest choice', async () => {
  const { author, voter, other, corrected, correctionRef, stance, beforeCorrection } = await setup();
  const delta = await voter.agent.get(`/api/ui/snapshot?after=${beforeCorrection.sequence}`);
  expect(delta.status, delta.text).toBe(200);
  expect(delta.body.messages.find((record: { id: string }) => record.id === corrected.id).payload)
    .toMatchObject({ correctionBeforeContent: '地求是圆的。', correctionAfterContent: '地球是圆的。' });
  const state = async () => (await other.agent.get('/api/ui/snapshot')).body.messages
    .find((record: { id: string }) => record.id === corrected.id).state;
  await stance(author, correctionRef, 'DISAGREE');
  expect(await state()).toMatchObject({ supportCount: 0, oppositionCount: 1, suppressed: true });
  await stance(voter, correctionRef, 'AGREE');
  expect(await state()).toMatchObject({ supportCount: 1, oppositionCount: 1, suppressed: false });
  await stance(voter, { ...correctionRef, partId: 'relation' }, 'DISAGREE');
  expect(await state()).toMatchObject({ supportCount: 0, oppositionCount: 2, suppressed: true });
  await stance(voter, { ...correctionRef, partId: 'corrected-body', range: { start: 0, end: 2 } }, 'AGREE');
  expect(await state()).toMatchObject({ supportCount: 0, oppositionCount: 2, suppressed: true });
});

it('pins an unversioned text correction to the original revision used for its comparison', async () => {
  const { app, editor, original } = await setup();
  const correction = await editor.post('/relations', { relationType: 'CORRECT',
    targetRefs: [{ kind: 'message', messageId: original.id, reference: { messageId: original.id, partId: 'body', path: ['text'] } }],
    payload: { correctionContent: '修订后的正文' } });
  const expected = { messageId: original.id, revision: 1, partId: 'body', path: ['text'] };
  expect(correction.targetRefs[0].reference).toEqual(expected);
  const saved = await app.store.message(correction.id);
  expect(saved.parts.find(part => part.type === 'relation' && part.relation === 'correct'))
    .toMatchObject({ roles: { target: [{ reference: expected }] } });
  const snapshot = (await editor.agent.get('/api/ui/snapshot')).body;
  expect(snapshot.relations.find((record: { id: string }) => record.id === correction.id).targetRefs[0].reference).toEqual(expected);
});

it('rejects meaning changes before charging and directs the user to a new message',async()=>{
  const {app,author,original,originalRef}=await setup(),before=await app.store.account(author.id),sequence=await app.store.latestSequence();
  const result=await author.agent.post('/api/ui/relations').set('x-csrf-token',author.csrf).set('x-request-id',randomUUID()).send({relationType:'CORRECT',targetRefs:[{kind:'message',messageId:original.id,reference:{...originalRef,partId:'body'}}],payload:{correctionKind:'MEANING',correctionContent:'新主张'},recommendation:1});
  expect(result.status).toBe(400);expect(await app.store.account(author.id)).toEqual(before);expect(await app.store.latestSequence()).toBe(sequence);
});

it('rejects malformed stance context before charging or saving a relation', async () => {
  const { app, author, original, originalRef } = await setup();
  const sequence = await app.store.latestSequence(), account = await app.store.account(author.id);
  const response = await author.agent.post('/api/ui/relations').set('x-csrf-token', author.csrf).set('x-request-id', randomUUID()).send({
    relationType: 'AGREE', targetRefs: [{ kind: 'message', messageId: original.id, reference: originalRef }],
    payload: { stanceCorrections: { [original.id]: { invalid: true } } }, stakeAmount: 5,
  });
  expect(response.status, response.text).toBe(400);
  expect(await app.store.latestSequence()).toBe(sequence);
  expect(await app.store.account(author.id)).toEqual(account);
});

it('keeps original and correction wagers separate through the existing settlement flow', async () => {
  const { app, author, editor, voter, original, corrected, originalRef, correctionRef, stance, stakes } = await setup();
  const originalVote = await stance(author, originalRef, 'AGREE', 20);
  const correctionVote = await stance(editor, correctionRef, 'DISAGREE', 10);
  await stance(voter, correctionRef, 'AGREE');
  expect((await stakes(originalRef)).pool).toEqual({ lockedPro: 20, lockedCon: 0 });
  expect((await stakes(correctionRef)).pool).toEqual({ lockedPro: 1, lockedCon: 10 });
  const rounds = await editor.agent.get(`/api/ui/messages/${corrected.id}/rounds`);
  expect(rounds.status, rounds.text).toBe(200);
  const active = rounds.body.data.find((round: { status: string }) => round.status !== 'SETTLED');
  const settled = await editor.post(`/rounds/${active.id}/close-and-settle`);
  expect(settled).toMatchObject({ result: 'FALSE', totalPro: 1, totalCon: 10 });
  expect((await app.store.account(author.id)).locked).toBe(20);
  expect((await app.store.account(editor.id)).locked).toBe(0);
  const bets = await app.store.db.prepare('SELECT "targetKey","messageId" FROM bets WHERE "messageId"=ANY($1::text[])').all([originalVote.id, correctionVote.id]);
  expect(new Set(bets.map(row => row.targetKey)).size).toBe(2);
  const saved = await app.store.message(original.id);
  expect(saved.revision).toBe(1);
  expect(saved.parts.find(part => part.type === 'text')).toMatchObject({ text: '地求是圆的。' });
});

it.each(['TEXT'] as const)('records %s as the correction attachment without changing the original or its pool', async correctionKind => {
  const { app, author, editor, original, originalRef, stance, stakes } = await setup();
  await stance(author, originalRef, 'AGREE', 12);
  const correction = await editor.post('/relations', { relationType: 'CORRECT', targetRefs: [{ kind: 'message', messageId: original.id,
    reference: { ...originalRef, partId: 'body', range: { start: 1, end: 2 } } }], payload: { correctionContent: '球', correctionKind } });
  expect(correction.payload).toMatchObject({ correctionKind, correctionBeforeContent: '地求是圆的。', correctionAfterContent: '地球是圆的。', correctionValue: '球' });
  expect(correction.payload).not.toHaveProperty('correctionBodyReference');
  expect(correction.payload).not.toHaveProperty('correctionDecision');
  expect((await stakes(originalRef)).pool).toEqual({ lockedPro: 12, lockedCon: 0 });
  const snapshot = (await author.agent.get('/api/ui/snapshot')).body;
  expect(snapshot.messages.find((message: { id: string }) => message.id === original.id).content).toBe('地求是圆的。');
  expect((await app.store.message(original.id)).revision).toBe(1);
});

it('compares long full bodies without duplicating after text beyond the message size limit', async () => {
  const { author, editor } = await setup();
  const before = '甲'.repeat(20000), after = '乙'.repeat(25000);
  const original = await author.post('/messages', { content: before });
  const correction = await editor.post('/relations', { relationType: 'CORRECT', targetRefs: [{ kind: 'message', messageId: original.id,
    reference: { messageId: original.id, revision: 1, partId: 'body', path: ['text'] } }], payload: { correctionContent: after } });
  expect(correction.payload.correctionBeforeContent).toBe(before);
  expect(correction.payload.correctionAfterContent).toBe(after);
});

it('rejects a correction chain so each new edit must address the original', async () => {
  const { app, editor, corrected } = await setup();
  const sequence = await app.store.latestSequence(), account = await app.store.account(editor.id);
  const response = await editor.agent.post('/api/ui/relations').set('x-csrf-token', editor.csrf).set('x-request-id', randomUUID()).send({
    relationType: 'CORRECT', targetRefs: [{ kind: 'relation', relationId: corrected.id,
      reference: { messageId: corrected.id, revision: 1, partId: 'corrected-body', range: { start: 0, end: 2 } } }],
    payload: { correctionContent: '新的文字' },
  });
  expect(response.status, response.text).toBe(400);
  expect(response.body.error).toContain('原消息');
  expect(await app.store.latestSequence()).toBe(sequence);
  expect(await app.store.account(editor.id)).toEqual(account);
});
