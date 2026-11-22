import { PARTICIPATION_AGREEMENT_VERSION } from '@gonglun/core';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { bindRoles, type Message, type Part, type Session, type FeedPage } from '@gonglun/core';
import { createTestApp, cleanupTestDatabases, testDatabaseUrl, withTestContribution } from './test-database.js';
import { Mutation, Store } from './db.js';
import { migrateDiscoveryFeed } from '../../migrate/src/discovery-feed.js';
import { financialFingerprint } from '../../migrate/src/financial-fingerprint.js';
import { feedEntry, indexFeedMessages } from './feed-index.js';
import { convertMessagesToDemoModel } from '../../../frontend/src/utils/modelBridge.js';
import { deriveContainerEffect } from '../../../frontend/src/pages/workbench/model/containerEffect.js';
import { recommendedClassificationPath } from './recommended-memberships.js';

afterEach(cleanupTestDatabases);
type App = Awaited<ReturnType<typeof createTestApp>>;
async function actor(app: App, name: string) {
  const agent = request.agent(app);
  const response = await agent.post('/api/register').send({acceptedAgreementVersion: PARTICIPATION_AGREEMENT_VERSION,  name, password: 'feed-password' });
  expect(response.status, response.text).toBe(201);
  return { agent, session: response.body as Session };
}
type Actor = Awaited<ReturnType<typeof actor>>;
const text = (value: string): Part => ({ id: 'body', type: 'text', text: value });
const rel = (relation: string, target: string, reason: 'YES' | 'NO' = 'YES'): Extract<Part, { type: 'relation' }> => ({ id: 'relation', type: 'relation', relation,
  roles: bindRoles({ target: [{ messageId: target }] }), reason });
async function send(who: Actor, parts: Part[], investment: { wager?: number; recommendation?: number } = {}) {
  const response = await who.agent.post('/api/messages').set('x-csrf-token', who.session.csrf)
    .send(withTestContribution({ requestId: randomUUID(), parts, ...investment }));
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
  expect((await request(app).post('/api/ui/feed/refresh').send({})).status).toBe(401);
  expect((await alice.agent.post('/api/ui/feed/refresh').send({ limit: 401 })).status).toBe(400);
  const refreshed = await alice.agent.post('/api/ui/feed/refresh').send({ limit: 35, retain: result.items.map(item => item.id) });
  expect(refreshed.status, refreshed.text).toBe(200);
  expect(refreshed.headers['cache-control']).toBe('private, no-store');
  expect(refreshed.body.items).toHaveLength(35);
  expect(await app.store.latestSequence()).toBe(before);
});

it('finds followed discussions beyond the recent pool and recommends each member independently', async () => {
  const app = await createTestApp(), alice = await actor(app, 'alice'), bob = await actor(app, 'bob');
  const parent = await send(bob, [text('持续关注的讨论'), { id: 'category', type: 'relation', relation: 'classify', roles: {} }]);
  await send(alice, [rel('follow', parent.id)]);
  const member = await send(bob, [text('讨论的新进展'), { id: 'parent', type: 'relation', relation: 'member-of', roles: bindRoles({ parent: [{ messageId: parent.id }] }) }]);
  await seed(app, bob, 200);
  const following = await page(alice, { mode: 'following' });
  expect(following.items).toHaveLength(2);
  expect(following.items[0]).toMatchObject({ id: member.id, reasons: ['你关注的消息或分类'], updates: [] });
  expect(following.items[1]?.id).toBe(parent.id);
  expect((await page(alice)).items[0]?.id).toBe(member.id);
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

it('includes every classification depth and more than three siblings, with explicit child exclusions', async () => {
  const app = await createTestApp(), alice = await actor(app, 'alice'), bob = await actor(app, 'bob');
  const categories: Message[] = [];
  for (let depth = 0; depth < 5; depth++) categories.push(await send(bob, [text(`第 ${depth + 1} 层分类`),
    { id: 'category', type: 'relation', relation: 'classify', roles: {} },
    ...(depth ? [{ id: 'parent', type: 'relation' as const, relation: 'member-of', roles: bindRoles({ parent: [{ messageId: categories.at(-1)!.id }] }) }] : [])]));
  const members: Message[] = [];
  for (let index = 0; index < 6; index++) members.push(await send(bob, [text(`深层独立内容 ${index}`),
    { id: 'parent', type: 'relation', relation: 'member-of', roles: bindRoles({ parent: [{ messageId: categories.at(-1)!.id }] }) }]));
  const root = await send(bob, [text('根目录内容')]);
  const independent = await page(alice, { limit: 30 });
  expect(new Set(independent.items.map(item => item.id))).toEqual(new Set([...categories, ...members, root].map(item => item.id)));
  expect(independent.items.every(item => item.updates.length === 0)).toBe(true);
  await send(alice, [rel('follow', categories[0]!.id)]);
  await seed(app, bob, 200);
  expect(new Set((await page(alice, { mode: 'following' })).items.map(item => item.id)))
    .toEqual(new Set([...categories, ...members].map(item => item.id)));
  await send(alice, [rel('follow', categories[1]!.id, 'NO')]);
  expect((await page(alice, { mode: 'following' })).items.map(item => item.id)).toEqual([categories[0]!.id]);
  await send(alice, [rel('follow', categories.at(-1)!.id)]);
  expect(new Set((await page(alice, { mode: 'following' })).items.map(item => item.id)))
    .toEqual(new Set([categories[0]!, categories.at(-1)!, ...members].map(item => item.id)));
  const discussion = await alice.agent.post('/api/ui/snapshot/discussion').send({ focusId: members[0]!.id });
  expect(discussion.status, discussion.text).toBe(200);
  expect(discussion.body.discussion.recommendedPath).toEqual(categories.map((item, index) => ({ id: item.id, title: `第 ${index + 1} 层分类` })));
}, 30_000);

it('uses shared stake-based ownership for discovery while preserving personal choices and reflecting changes', async () => {
  const app = await createTestApp(), alice = await actor(app, 'alice'), bob = await actor(app, 'bob');
  const a = await send(bob, [text('公共推荐分类 A'), { id: 'category', type: 'relation', relation: 'classify', roles: {} }]);
  const b = await send(bob, [text('个人选择分类 B'), { id: 'category', type: 'relation', relation: 'classify', roles: {} }]);
  const member = await send(bob, [text('可以竞争归属的内容'),
    { id: 'parent', type: 'relation', relation: 'member-of', roles: bindRoles({ parent: [{ messageId: a.id }] }) }]);
  const first = await app.store.db.prepare('SELECT "sourceId" FROM memberships WHERE "memberId"=$1').get(member.id);
  const join = await send(alice, [{ id: 'placement', type: 'relation', relation: 'member-of',
    roles: bindRoles({ member: [{ messageId: member.id }], parent: [{ messageId: b.id }] }) }]);
  await send(bob, [rel('agree', String(first!.sourceId))], { wager: 10 });
  const placement = await app.store.message(String(first!.sourceId));
  const placementPart = placement.parts.find(part => part.type === 'relation' && part.relation === 'member-of')!;
  const totals = await app.store.db.prepare('SELECT SUM(amount) AS pro FROM stake_positions WHERE "subjectId"=$1 AND side=\'pro\'').get(placement.id);
  // A scoped opposition can tie the totals, but must not become the latest whole-message stance.
  await send(alice, [{ ...rel('disagree', placement.id), roles: bindRoles({ target: [{ messageId: placement.id, partId: placementPart.id }] }) }], { wager: Number(totals!.pro) });
  await send(alice, [rel('follow', a.id)]);
  expect((await app.store.db.prepare('SELECT "parentId" FROM memberships WHERE "memberId"=$1').get(member.id))?.parentId).toBe(b.id);
  expect((await app.store.db.prepare('SELECT "parentId" FROM recommended_memberships WHERE "memberId"=$1').get(member.id))?.parentId).toBe(a.id);
  const response = await alice.agent.post('/api/ui/snapshot/discussion').send({ focusId: member.id });
  expect(response.status, response.text).toBe(200);
  expect(response.body.discussion.recommendedPath).toEqual([{ id: a.id, title: '公共推荐分类 A' }]);
  const snapshot = response.body, model = convertMessagesToDemoModel(snapshot.messages, snapshot.relations);
  const stakes = Object.fromEntries(Object.entries(snapshot.stakes).map(([id, value]: [string, any]) => [id, {
    truth: value.countsByType.TRUTH, value: value.countsByType.VALUE,
  }]));
  const effect = (username: string | null) => deriveContainerEffect({ ...model, relations: snapshot.relations, username, stakeCounts: stakes });
  expect(effect(null).joinByTarget.get(member.id)).toBe(first!.sourceId);
  expect(effect('alice').joinByTarget.get(member.id)).toBe(join.id);
  expect((await page(alice, { mode: 'following' })).items.map(item => item.id)).toContain(member.id);
  const category = await alice.agent.post('/api/ui/snapshot/discussion').send({ focusId: a.id });
  expect(category.status, category.text).toBe(200);
  expect(category.body.discussion.pageIds).toContain(member.id);
  const previous = await page(alice);
  await send(bob, [rel('disagree', String(first!.sourceId))], { wager: 20 });
  expect((await page(alice, { mode: 'following' })).items.map(item => item.id)).not.toContain(member.id);
  const update = await alice.agent.post('/api/ui/feed/refresh').send({ mode: 'recommended', limit: previous.items.length, retain: previous.items.map(item => item.id) });
  expect(update.status, update.text).toBe(200);
  const refreshed = update.body as FeedPage;
  expect(new Set(refreshed.items.map(item => item.id)).size).toBe(refreshed.items.length);
  expect(refreshed.items.find(item => item.id === member.id)?.reasons).not.toEqual(['你关注的消息或分类']);
  expect((await app.store.db.prepare('SELECT "parentId" FROM recommended_memberships WHERE "memberId"=$1').get(member.id))?.parentId).toBe(b.id);
}, 30_000);

it('backfills statistical ownership without changing classification history, preferences or money', async () => {
  const app = await createTestApp(), alice = await actor(app, 'alice');
  const parent = await send(alice, [text('需要保留的分类'), { id: 'category', type: 'relation', relation: 'classify', roles: {} }]);
  const member = await send(alice, [text('分类成员'), { id: 'parent', type: 'relation', relation: 'member-of', roles: bindRoles({ parent: [{ messageId: parent.id }] }) }]);
  await send(alice, [rel('follow', parent.id)]);
  const tables = ['messages', 'changes', 'membership_actions', 'memberships', 'personal_marks'];
  const before = await Promise.all(tables.map(table => app.store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
  const money = await financialFingerprint(app.store.db);
  await app.store.transaction(async () => {
    await app.store.db.exec('DROP TABLE recommended_memberships');
    await app.store.db.prepare('DELETE FROM schema_migrations WHERE version>47').run();
  });
  const upgraded = await Store.open(testDatabaseUrl(), { schema: app.store.db.schema });
  try {
    expect((await upgraded.db.prepare('SELECT "parentId" FROM recommended_memberships WHERE "memberId"=$1').get(member.id))?.parentId).toBe(parent.id);
    expect(await Promise.all(tables.map(table => upgraded.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()))).toEqual(before);
    expect(await financialFingerprint(upgraded.db)).toBe(money);
  } finally { await upgraded.close(); }
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

it('rechecks ancestor visibility before returning a classification path, even with a stale ownership index', async () => {
  const app = await createTestApp({ moderation: true }), alice = await actor(app, 'alice'), bob = await actor(app, 'bob');
  const parent = await send(bob, [text('不可泄露的分类标题'), { id: 'category', type: 'relation', relation: 'classify', roles: {} }]);
  const member = await send(bob, [text('分类内正文'), { id: 'parent', type: 'relation', relation: 'member-of', roles: bindRoles({ parent: [{ messageId: parent.id }] }) }]);
  await app.store.transaction(async () => {
    await app.store.db.prepare("UPDATE moderation_cases SET status='rejected' WHERE \"messageId\"=$1").run(parent.id);
  });
  expect(await app.store.read(() => recommendedClassificationPath(app.store, member.id, alice.session.user.id)))
    .toEqual([{ id: '', title: '不可查看的分类' }]);
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

it('upgrades old discovery entries to content-only cards and restores organization text in every feed mode', async () => {
  const app = await createTestApp(), alice = await actor(app, 'alice');
  const { category, reply, content } = await app.store.transaction(async () => {
    const tx = new Mutation(app.store);
    const category = await tx.create(alice.session.user.id, [text('建立关系：CLASSIFY'),
      { id: 'category', type: 'relation', relation: 'classify', roles: {} },
      { id: 'data', type: 'data', value: { title: '分类消息卡上的正文' } }]);
    const content = await tx.create(alice.session.user.id, [text('正常的回复正文'),
      { id: 'parent', type: 'relation', relation: 'member-of', roles: bindRoles({ parent: [{ messageId: category.id }] }) }]);
    const reply = await tx.create(alice.session.user.id, [text(`建立关系：REPLY；目标：${category.id.slice(-8)}`),
      rel('reply', category.id), { id: 'data', type: 'data', value: { title: '关系记录的标题' } }]);
    await tx.commit(); return { category, reply, content };
  });
  for (const target of [category, reply, content]) await send(alice, [rel('follow', target.id)]);
  await app.store.transaction(async () => {
    // Recreate the old index contents before applying the newly registered migration.
    const entry = feedEntry(content)!;
    await app.store.db.prepare(`INSERT INTO feed_entries VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`)
      .run(reply.id, entry.authorId, reply.revision, reply.sequence, reply.createdAt, reply.updatedAt, '回复', '建立关系：REPLY；目标：fzhbrkmz', category.id);
    await app.store.db.prepare('UPDATE feed_entries SET excerpt=$1 WHERE id=$2').run('建立关系：CLASSIFY', category.id);
    await app.store.db.prepare('INSERT INTO feed_hidden VALUES($1,$2)').run(alice.session.user.id, reply.id);
    await app.store.db.prepare('DELETE FROM schema_migrations WHERE version>46').run();
  });
  const before = {
    messages: await app.store.db.prepare('SELECT * FROM messages ORDER BY id').all(),
    history: await app.store.db.prepare('SELECT * FROM changes ORDER BY sequence').all(),
    finances: await financialFingerprint(app.store.db),
    hidden: await app.store.db.prepare('SELECT * FROM feed_hidden').all(),
  };
  const upgraded = await Store.open(testDatabaseUrl(), { schema: app.store.db.schema });
  try {
    expect(await upgraded.db.prepare('SELECT 1 FROM feed_entries WHERE id=$1').get(reply.id)).toBeUndefined();
    expect(await upgraded.db.prepare('SELECT excerpt FROM feed_entries WHERE id=$1').get(category.id)).toEqual({ excerpt: '分类消息卡上的正文' });
    expect(await upgraded.db.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(before.messages);
    expect(await upgraded.db.prepare('SELECT * FROM changes ORDER BY sequence').all()).toEqual(before.history);
    expect(await financialFingerprint(upgraded.db)).toBe(before.finances);
    expect(await upgraded.db.prepare('SELECT * FROM feed_hidden').all()).toEqual(before.hidden);
    expect(await upgraded.db.prepare('SELECT name FROM schema_migrations WHERE version=47').all()).toEqual([{ name: 'content-only-discovery-feed' }]);
    for (const mode of ['recommended', 'following', 'latest']) {
      const result = await page(alice, { mode });
      const cards = result.items.flatMap(item => [item, ...item.updates]);
      expect(cards.find(item => item.id === category.id)?.excerpt).toBe('分类消息卡上的正文');
      expect(cards.some(item => item.id === content.id)).toBe(true);
      expect(cards.some(item => item.id === reply.id)).toBe(false);
      expect(JSON.stringify(result)).not.toContain('建立关系');
    }
  } finally { await upgraded.close(); }
});
