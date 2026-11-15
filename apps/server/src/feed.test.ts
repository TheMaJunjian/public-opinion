import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { bindRoles, type Message, type Part, type Session, type FeedPage } from '@gonglun/core';
import { createTestApp, cleanupTestDatabases, testDatabaseUrl, testInvitation, withTestContribution } from './test-database.js';
import { Mutation, Store } from './db.js';
import { migrateDiscoveryFeed } from '../../migrate/src/discovery-feed.js';
import { financialFingerprint } from '../../migrate/src/financial-fingerprint.js';
import { indexFeedMessages } from './feed-index.js';

afterEach(cleanupTestDatabases);
type App = Awaited<ReturnType<typeof createTestApp>>;
async function actor(app: App, name: string) {
  const agent = request.agent(app);
  const response = await agent.post('/api/register').send({ name, password: 'feed-password', inviteCode: await testInvitation(app) });
  expect(response.status, response.text).toBe(201);
  return { agent, session: response.body as Session };
}
type Actor = Awaited<ReturnType<typeof actor>>;
const text = (value: string): Part => ({ id: 'body', type: 'text', text: value });
const rel = (relation: string, target: string, reason: 'YES' | 'NO' = 'YES'): Part => ({ id: 'relation', type: 'relation', relation,
  roles: bindRoles({ target: [{ messageId: target }] }), reason });
async function send(who: Actor, parts: Part[]) {
  const response = await who.agent.post('/api/messages').set('x-csrf-token', who.session.csrf)
    .send(withTestContribution({ requestId: randomUUID(), parts }));
  expect(response.status, response.text).toBe(201); return response.body.message as Message;
}
async function page(who: Actor, query: Record<string, unknown> = {}): Promise<FeedPage> {
  const response = await who.agent.get('/api/ui/feed').query(query);
  expect(response.status, response.text).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers['server-timing']).toContain('feed;dur=');
  return response.body;
}
async function seed(app: App, who: Actor, count: number) {
  return app.store.transaction(async () => {
    const tx = new Mutation(app.store), messages: Message[] = [];
    for (let index = 0; index < count; index++) messages.push(await tx.create(who.session.user.id, [text(`批量讨论 ${index} ${'正文'.repeat(400)}`)]));
    await tx.commit(); return messages;
  });
}

it('requires a live session, validates input and returns bounded previews without a global snapshot', async () => {
  const app = await createTestApp(), alice = await actor(app, 'alice');
  await seed(app, alice, 35);
  const before = await app.store.latestSequence();
  expect((await request(app).get('/api/ui/feed')).status).toBe(401);
  expect((await alice.agent.get('/api/ui/feed?limit=2000')).status).toBe(400);
  const result = await page(alice);
  expect(result.items).toHaveLength(20); expect(result.nextCursor).not.toBeNull();
  expect(Object.keys(result).sort()).toEqual(['items', 'mode', 'nextCursor']);
  expect(result.items.every(item => item.excerpt.length <= 420 && !('parts' in item))).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(40_000);
  expect(await app.store.latestSequence()).toBe(before);
  expect((await alice.agent.get('/api/ui/reading-state')).body.marks).toEqual([]);
});

it('finds followed discussions beyond the recent pool and groups their direct members', async () => {
  const app = await createTestApp(), alice = await actor(app, 'alice'), bob = await actor(app, 'bob');
  const parent = await send(bob, [text('持续关注的讨论'), { id: 'category', type: 'relation', relation: 'classify', roles: {} }]);
  await send(alice, [rel('follow', parent.id)]);
  const member = await send(bob, [text('讨论的新进展'), { id: 'parent', type: 'relation', relation: 'member-of', roles: bindRoles({ parent: [{ messageId: parent.id }] }) }]);
  await seed(app, bob, 200);
  const following = await page(alice, { mode: 'following' });
  expect(following.items).toHaveLength(1);
  expect(following.items[0]).toMatchObject({ id: parent.id, reasons: ['你关注的消息或分类'], updates: [{ id: member.id }] });
  expect((await page(alice)).items[0]?.id).toBe(parent.id);
  await send(alice, [rel('follow', parent.id, 'NO')]);
  expect((await page(alice, { mode: 'following' })).items).toEqual([]);
}, 30_000);

it('keeps recommendation pagination stable during new publications and binds cursors to their owner and mode', async () => {
  const app = await createTestApp(), alice = await actor(app, 'alice'), bob = await actor(app, 'bob');
  await seed(app, bob, 25);
  const first = await page(alice, { limit: 5 });
  const later = await send(bob, [text('分页期间的新消息')]);
  expect((await bob.agent.get('/api/ui/feed').query({ cursor: first.nextCursor })).status).toBe(409);
  expect((await alice.agent.get('/api/ui/feed').query({ mode: 'following', cursor: first.nextCursor })).status).toBe(409);
  const ids = first.items.map(item => item.id);
  let cursor = first.nextCursor;
  while (cursor) {
    const next = await page(alice, { limit: 5, cursor });
    ids.push(...next.items.map(item => item.id)); cursor = next.nextCursor;
  }
  expect(ids).toHaveLength(25); expect(new Set(ids).size).toBe(25); expect(ids).not.toContain(later.id);
  expect((await page(alice, { mode: 'latest' })).items[0]?.id).toBe(later.id);
});

it('hides discussions privately with CSRF protection, supports undo and respects existing blocks', async () => {
  const app = await createTestApp(), alice = await actor(app, 'alice'), bob = await actor(app, 'bob');
  const message = await send(bob, [text('可减少的讨论')]);
  const sequence = await app.store.latestSequence(), balance = await app.store.account(alice.session.user.id);
  const hide = (hidden: boolean) => alice.agent.post('/api/ui/feed/hidden').set('x-csrf-token', alice.session.csrf).send({ messageId: message.id, hidden });
  expect((await alice.agent.post('/api/ui/feed/hidden').send({ messageId: message.id, hidden: true })).status).toBe(403);
  expect((await hide(true)).status).toBe(200);
  expect((await page(alice)).items).toEqual([]); expect((await page(bob)).items.map(item => item.id)).toContain(message.id);
  expect(await app.store.latestSequence()).toBe(sequence); expect(await app.store.account(alice.session.user.id)).toEqual(balance);
  await hide(false); expect((await page(alice)).items.map(item => item.id)).toContain(message.id);
  await send(alice, [rel('block', message.id)]); expect((await page(alice, { mode: 'latest' })).items).toEqual([]);
});

it('rechecks moderation on later pages and never exposes rejected previews or their dependent excerpts', async () => {
  const app = await createTestApp({ moderation: true }), alice = await actor(app, 'alice'), bob = await actor(app, 'bob');
  const secret = await send(bob, [text('随后被否决的正文')]);
  const quote = await send(bob, [text('引用了被否决正文的摘录'), rel('reference', secret.id)]);
  await send(bob, [text('第一条安全的内容')]);
  const first = await page(alice, { mode: 'following', limit: 1 });
  expect(first.items).toEqual([]);
  const initial = await page(alice, { limit: 1 });
  await app.store.transaction(async () => { await app.store.db.prepare("UPDATE moderation_cases SET status='rejected' WHERE \"messageId\"=$1").run(secret.id); });
  const remaining = await page(alice, { limit: 20, cursor: initial.nextCursor! });
  expect(JSON.stringify(remaining)).not.toContain('被否决');
  const latest = await page(alice, { mode: 'latest' });
  expect(latest.items.map(item => item.id)).not.toContain(secret.id); expect(latest.items.map(item => item.id)).not.toContain(quote.id);
  expect((await page(bob, { mode: 'latest' })).items.map(item => item.id)).toContain(secret.id);
});

it('rebuilds the derived index idempotently without changing public history or balances', async () => {
  const app = await createTestApp(), alice = await actor(app, 'alice');
  const original = await send(alice, [text('消息正文')]);
  await send(alice, [rel('follow', original.id)]);
  const balance = await app.store.account(alice.session.user.id), sequence = await app.store.latestSequence();
  await app.store.transaction(async () => {
    await app.store.db.exec('DROP TABLE feed_entries,feed_corrections,feed_hidden');
    await migrateDiscoveryFeed(app.store); await migrateDiscoveryFeed(app.store);
  });
  expect((await page(alice, { mode: 'latest' })).items.map(item => item.id)).toEqual([original.id]);
  expect(await app.store.message(original.id)).toEqual(original);
  expect(await app.store.account(alice.session.user.id)).toEqual(balance); expect(await app.store.latestSequence()).toBe(sequence);
});

it('repairs an already stamped version 45 missing its correction index on concurrent startup', async () => {
  const app = await createTestApp(), alice = await actor(app, 'alice');
  const original = await send(alice, [text('原文')]);
  const correction = await app.store.transaction(async () => {
    const tx = new Mutation(app.store);
    const value = await tx.create(alice.session.user.id, [text('更正内容'), rel('correct', original.id)]);
    await tx.commit();
    await app.store.db.prepare('INSERT INTO feed_hidden VALUES($1,$2)').run(alice.session.user.id, value.id);
    return value;
  });
  const before = {
    messages: await app.store.db.prepare('SELECT * FROM messages ORDER BY id').all(),
    history: await app.store.db.prepare('SELECT * FROM changes ORDER BY sequence').all(),
    finances: await financialFingerprint(app.store.db),
    hidden: await app.store.db.prepare('SELECT * FROM feed_hidden').all(),
  };
  await app.store.transaction(async () => {
    await app.store.db.exec('DROP TABLE feed_corrections');
    await app.store.db.prepare('DELETE FROM schema_migrations WHERE version>45').run();
  });
  const stores = await Promise.all([Store.open(testDatabaseUrl(), {schema:app.store.db.schema}), Store.open(testDatabaseUrl(), {schema:app.store.db.schema})]);
  try {
    const repaired = stores[0]!;
    expect((await repaired.db.prepare("SELECT to_regclass('feed_corrections') AS name").get())?.name).toBe('feed_corrections');
    expect(await repaired.db.prepare('SELECT * FROM feed_corrections').all()).toEqual([{sourceId:correction.id,targetId:original.id}]);
    expect(await repaired.db.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(before.messages);
    expect(await repaired.db.prepare('SELECT * FROM changes ORDER BY sequence').all()).toEqual(before.history);
    expect(await financialFingerprint(repaired.db)).toBe(before.finances);
    expect(await repaired.db.prepare('SELECT * FROM feed_hidden').all()).toEqual(before.hidden);
    const migration = await repaired.db.prepare('SELECT * FROM schema_migrations WHERE version=46').all();
    expect(migration).toHaveLength(1);
    const reopened = await Store.open(testDatabaseUrl(), {schema:app.store.db.schema});
    try { expect(await reopened.db.prepare('SELECT * FROM schema_migrations WHERE version=46').all()).toEqual(migration); }
    finally { await reopened.close(); }
    expect((await page(alice, {mode:'latest'})).items.find(item => item.id === original.id)?.hasCorrections).toBe(true);
    await send(alice, [text('修复后正常提交')]);
  } finally { await Promise.all(stores.map(store => store.close())); }
});

it('skips an incomplete feed index while historical migrations are still running', async () => {
  const app = await createTestApp(), alice = await actor(app, 'alice');
  const message = await send(alice, [text('迁移前的消息')]);
  await app.store.transaction(async () => {
    await app.store.db.exec('DROP TABLE feed_corrections');
    await expect(indexFeedMessages(app.store, [message])).resolves.toBeUndefined();
  });
});
