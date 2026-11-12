import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { bindRoles, type Message, type Part, type Session, type WorkbenchSnapshot } from '@gonglun/core';
import { createTestApp, cleanupTestDatabases, testInvitation, withTestContribution } from './test-database.js';
import { Mutation } from './db.js';

afterEach(cleanupTestDatabases);
type App = Awaited<ReturnType<typeof createTestApp>>;
async function actor(app: App, name = 'window-reader') {
  const agent = request.agent(app);
  const response = await agent.post('/api/register').send({ name, password: 'test-password', inviteCode: await testInvitation(app) });
  expect(response.status).toBe(201);
  return { agent, session: response.body as Session };
}
const body = (text: string): Part => ({ id: 'body', type: 'text', text });
const relation = (name: string, roles: Record<string, Array<{messageId:string}>>): Part => ({ id: 'relation', type: 'relation', relation: name, roles: bindRoles(roles) });
async function seed(app: App, userId: string, parts: Part[][]) {
  return app.store.transaction(async () => {
    const tx = new Mutation(app.store), messages: Message[] = [];
    for (const value of parts) messages.push(await tx.create(userId, value));
    await tx.commit(); return messages;
  });
}
async function page(who: Awaited<ReturnType<typeof actor>>, query: object): Promise<WorkbenchSnapshot> {
  const response = await who.agent.post('/api/ui/snapshot/discussion').send(query);
  expect(response.status, response.text).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers['server-timing']).toContain('projection;dur=');
  return response.body;
}

it('loads a direct message independently of unrelated records and writes no reading or public state', async () => {
  const app = await createTestApp(), who = await actor(app);
  const [focus, ...unrelated] = await seed(app, who.session.user.id, Array.from({length:150}, (_, n) => [body(`讨论 ${n}`)]));
  const sequence = await app.store.latestSequence();
  const result = await page(who, {focusId:focus!.id});
  expect(result.messages.map(row => row.id)).toEqual([focus!.id]);
  expect(result.messages.some(row => unrelated.some(other => other.id === row.id))).toBe(false);
  expect(result.discussion?.nextCursor).toBeNull();
  expect(await app.store.latestSequence()).toBe(sequence);
  expect((await who.agent.get('/api/ui/reading-state')).body.marks).toEqual([]);
  expect((await request(app).post('/api/ui/snapshot/discussion').send({focusId:focus!.id})).status).toBe(401);
  expect((await who.agent.post('/api/ui/snapshot/discussion').send({focusId:focus!.id, limit:5000})).status).toBe(400);
});

it('pages a wide classification without loading unopened descendants, and binds the cursor to its scope and reader', async () => {
  const app = await createTestApp(), who = await actor(app), other = await actor(app, 'other-reader');
  const [category, nested] = await seed(app, who.session.user.id, [[body('分类'), relation('classify',{})], [body('尚未打开的分类'), relation('classify',{})]]);
  const children = await seed(app, who.session.user.id, Array.from({length:65}, (_, n) => [body(`分类内 ${n}`)]));
  const [hidden] = await seed(app, who.session.user.id, [[body('尚未打开的正文')]]);
  await app.store.transaction(async () => {
    for (const row of [...children, nested!]) await app.store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES($1,$2,$2)').run(row.id,category!.id);
    await app.store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES($1,$2,$2)').run(hidden!.id,nested!.id);
  });
  const first = await page(who,{focusId:category!.id});
  expect(first.discussion?.pageIds).toHaveLength(20);
  expect(first.messages.length).toBeLessThanOrEqual(21);
  expect(first.messages.some(row => row.id === hidden!.id)).toBe(false);
  expect(first.discussion?.memberCounts[category!.id]).toEqual({direct:66,total:67});
  expect(first.messages.find(row=>row.id===category!.id)?.targetRefs).toHaveLength(20);
  const withSelection = await page(who,{focusId:category!.id,cursor:first.discussion!.nextCursor,extraIds:[first.discussion!.pageIds[0]]});
  expect(withSelection.messages.some(row=>row.id===first.discussion!.pageIds[0])).toBe(true);
  expect(withSelection.discussion!.pageIds.some(id=>first.discussion!.pageIds.includes(id))).toBe(false);
  const seen = new Set(first.discussion!.pageIds);
  let next = first.discussion!.nextCursor;
  while(next) {
    const result = await page(who,{focusId:category!.id,cursor:next});
    for (const id of result.discussion!.pageIds) { expect(seen.has(id)).toBe(false); seen.add(id); }
    expect(result.messages.length).toBeLessThanOrEqual(22);
    next = result.discussion!.nextCursor;
  }
  expect(seen.size).toBe(66);
  expect((await other.agent.post('/api/ui/snapshot/discussion').send({focusId:category!.id,cursor:first.discussion!.nextCursor})).status).toBe(409);
  expect((await who.agent.post('/api/ui/snapshot/discussion').send({focusId:nested!.id,cursor:first.discussion!.nextCursor})).status).toBe(409);
  const inside = await page(who,{focusId:category!.id,classificationId:nested!.id});
  expect(inside.messages.some(row => row.id === hidden!.id)).toBe(true);
});

it('includes complete correction and stance chains plus competing membership records', async () => {
  const app = await createTestApp(), who = await actor(app);
  const [focus, category, unrelated] = await seed(app,who.session.user.id,[[body('原文')],[body('分类'),relation('classify',{})],[body('无关正文')]]);
  const [correction] = await seed(app,who.session.user.id,[[body('更正'),relation('correct',{target:[{messageId:focus!.id}]})]]);
  const [stance] = await seed(app,who.session.user.id,[[relation('disagree',{target:[{messageId:correction!.id}]})]]);
  const [against, join] = await seed(app,who.session.user.id,[[relation('disagree',{target:[{messageId:stance!.id}]})],[relation('member-of',{parent:[{messageId:category!.id}],member:[{messageId:focus!.id}]})]]);
  const result = await page(who,{focusId:focus!.id});
  expect(new Set(result.messages.map(row=>row.id))).toEqual(new Set([focus,category,correction,stance,against,join].map(row=>row!.id)));
  expect(result.messages.some(row=>row.id===unrelated!.id)).toBe(false);
  expect(result.messages.find(row=>row.id===focus!.id)?.parts).toEqual((await app.store.message(focus!.id)).parts);
});

it('traces each direction from the selected message without crossing into sibling discussions', async () => {
  const app = await createTestApp(), who = await actor(app);
  const [upstream] = await seed(app, who.session.user.id, [[body('共同上游')]]);
  const [focus, sibling] = await seed(app, who.session.user.id, [
    [body('当前讨论'), relation('reply', { target: [{ messageId: upstream!.id }] })],
    [body('另一段讨论'), relation('reply', { target: [{ messageId: upstream!.id }] })],
  ]);
  const [downstream] = await seed(app, who.session.user.id, [[body('当前讨论的后续'), relation('reply', { target: [{ messageId: focus!.id }] })]]);
  const result = await page(who, { focusId: focus!.id, trace: { ids: [focus!.id], depths: { up: 1, down: 1 }, expandedIds: [] } });
  expect(new Set(result.discussion!.pageIds)).toEqual(new Set([upstream!.id, downstream!.id]));
  expect(result.messages.some(row => row.id === sibling!.id)).toBe(false);
});

it.each(['up', 'down'] as const)('traces %s through source/target relations without reversing their direction', async direction => {
  const app = await createTestApp(), who = await actor(app);
  const [upstream, focus, downstream, sibling] = await seed(app, who.session.user.id,
    ['依据', '当前消息', '后续消息', '旁支消息'].map(text => [body(text)]));
  const [reference, reply] = await seed(app, who.session.user.id, [
    [relation('reference', { source: [{ messageId: focus!.id }], target: [{ messageId: upstream!.id }] })],
    [relation('reply', { source: [{ messageId: downstream!.id }], target: [{ messageId: focus!.id }] })],
    [relation('reply', { source: [{ messageId: sibling!.id }], target: [{ messageId: upstream!.id }] })],
  ]);
  const result = await page(who, { focusId: focus!.id, trace: { ids: [focus!.id], depths: { up: direction === 'up' ? 1 : 0, down: direction === 'down' ? 1 : 0 }, expandedIds: [] } });
  const expected = direction === 'up' ? [focus, upstream, reference] : [focus, downstream, reply];
  expect(new Set(result.messages.map(row => row.id))).toEqual(new Set(expected.map(row => row!.id)));
});

it('revalidates moderation for every page and refuses a restricted focus', async () => {
  const app = await createTestApp({moderation:true}), author = await actor(app), reader = await actor(app,'reader');
  const [focus] = await seed(app,author.session.user.id,[[body('原文')]]);
  const sent = await author.agent.post('/api/messages').set('x-csrf-token', author.session.csrf).send(withTestContribution({requestId:randomUUID(),parts:[body('关联正文')]}));
  expect(sent.status,sent.text).toBe(201);
  const reply = sent.body.message as Message;
  const before = await page(reader,{focusId:focus!.id,extraIds:[reply!.id]});
  expect(before.messages.find(row=>row.id===reply!.id)?.content).toBe('关联正文');
  await app.store.transaction(async()=>{
    await app.store.db.prepare(`UPDATE moderation_cases SET status='rejected' WHERE "messageId"=$1`).run(reply.id);
  });
  const after = await page(reader,{focusId:focus!.id,extraIds:[reply!.id]});
  expect(JSON.stringify(after)).not.toContain('关联正文');
  expect((await reader.agent.post('/api/ui/snapshot/discussion').send({focusId:reply!.id})).status).toBe(403);
});
