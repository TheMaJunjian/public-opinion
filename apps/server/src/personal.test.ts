import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { bindRoles, type Json, type Message, type Part, type Session } from '@gonglun/core';
import { createTestApp, cleanupTestDatabases } from './test-database.js';

type App = Awaited<ReturnType<typeof createTestApp>>;
type Actor = { agent: ReturnType<typeof request.agent>; session: Session };
const instances: App[] = [];
const setup = async () => { const app = await createTestApp(); instances.push(app); return app; };
async function register(app: App, name: string): Promise<Actor> { const agent = request.agent(app); const response = await agent.post('/api/register').send({ name, password: 'personal-password' }); expect(response.status).toBe(201); return { agent, session: response.body }; }
async function send(actor: Actor, parts: Part[]): Promise<Message> { const response = await actor.agent.post('/api/messages').set('x-csrf-token', actor.session.csrf).send({ requestId: randomUUID(), parts }); expect(response.status, response.text).toBe(201); return response.body.message; }
const text = (value: string): Part => ({ id: 'text', type: 'text', text: value });
const relation = (value: string, target: string, role = 'target'): Part => ({ id: 'relation', type: 'relation', relation: value, roles: bindRoles({ [role]: [{ messageId: target }] }) });
afterEach(async () => { for (const app of instances.splice(0)) await app.close(); await cleanupTestDatabases(); });

describe('authoritative personal views', () => {
  it('keeps the last committed personal action when the same user sends concurrent requests', async () => {
    const app = await setup();
    const alice = await register(app, 'alice');
    const target = await send(alice, [text('并发关注的消息')]);
    const before = await app.store.account(alice.session.user.id);
    const sent = await Promise.all(['follow', 'unfollow', 'follow', 'unfollow'].map(action => send(alice, [relation(action, target.id)])));
    const latest = [...sent].sort((a, b) => b.sequence - a.sequence)[0]!;
    const lastAction = latest.parts.find(part => part.type === 'relation');
    const marks = await alice.agent.get('/api/me/marks').query({ ids: target.id });
    expect(marks.status, marks.text).toBe(200);
    expect(marks.body.personalStates[0].followed).toBe(lastAction?.type === 'relation' && lastAction.relation === 'follow');
    expect(new Set(sent.map(message => message.sequence)).size).toBe(sent.length);
    expect((await app.store.account(alice.session.user.id)).available).toBe(before.available - sent.length * (await app.store.rules()).protocolFee);
    expect((await app.store.db.prepare('SELECT COUNT(*) AS n FROM personal_actions WHERE "authorId"=$1 AND "targetId"=$2').get(alice.session.user.id, target.id))?.n).toBe(sent.length);
  });

  it('searches and filters across organizations unless an explicit parent is selected', async () => {
    const app = await setup(); const alice = await register(app, 'alice'); const bob = await register(app, 'bob');
    const anchor = await send(bob, [text('问题')]);
    const nested = await send(alice, [text('组织内的独特证据'), relation('evidence', anchor.id)]);
    const category = await send(bob, [text('嵌套分类'), { id: 'group', type: 'relation', relation: 'classify', roles: bindRoles({ members: [{ messageId: nested.id }] }) }]);
    const outer = await send(bob, [text('外层分类'), { id: 'group', type: 'relation', relation: 'classify', roles: bindRoles({ members: [{ messageId: category.id }] }) }]);
    for (const endpoint of ['/api/messages', '/api/me/messages']) {
      const roots = await alice.agent.get(endpoint);
      expect(roots.body.messages.map((message: Message) => message.id)).not.toContain(nested.id);
      for (const query of [{ q: '独特证据' }, { author: alice.session.user.id }, { relation: 'evidence' }]) {
        const all = await alice.agent.get(endpoint).query(query);
        expect(all.status, all.text).toBe(200);
        expect(all.body.messages.map((message: Message) => message.id)).toContain(nested.id);
        const local = await alice.agent.get(endpoint).query({ ...query, parent: category.id });
        expect(local.body.messages.map((message: Message) => message.id)).toContain(nested.id);
        const outside = await alice.agent.get(endpoint).query({ ...query, parent: outer.id });
        expect(outside.body.messages.map((message: Message) => message.id)).not.toContain(nested.id);
      }
      const classes = await alice.agent.get(endpoint).query({ relation: 'classify' });
      expect(classes.body.messages.map((message: Message) => message.id)).toEqual(expect.arrayContaining([outer.id, category.id]));
    }
  });

  it('keeps old personal actions across pagination and fresh login, including nested followed messages', async () => {
    const app = await setup(); const alice = await register(app, 'alice'); const bob = await register(app, 'bob');
    const target = await send(bob, [text('一个长期关注的问题')]);
    for (const action of ['follow', 'read', 'block', 'archive']) await send(alice, [relation(action, target.id)]);
    await send(bob, [text('组织'), { id: 'group', type: 'relation', relation: 'classify', roles: bindRoles({ members: [{ messageId: target.id }] }) }]);
    for (let index = 0; index < 35; index++) await send(bob, [text(`新的讨论 ${index}`)]);
    expect((await alice.agent.get('/api/messages?limit=1')).body.messages.some((message: Message) => message.id === target.id)).toBe(false);
    await alice.agent.post('/api/logout').set('x-csrf-token', alice.session.csrf).send({});
    const relogin = request.agent(app); const auth = await relogin.post('/api/login').send({ name: 'alice', password: 'personal-password' });
    expect(auth.status).toBe(200);
    const marks = await relogin.get('/api/me/marks').query({ ids: target.id });
    expect(marks.status, marks.text).toBe(200);
    expect(marks.body.personalStates).toEqual([{ messageId: target.id, followed: true, read: true, blocked: true, archived: true }]);
    const followed = await relogin.get('/api/me/messages?filter=follow&limit=1');
    expect(followed.status, followed.text).toBe(200);
    expect(followed.body.messages.map((message: Message) => message.id)).toEqual([target.id]);
    const freshAlice = { agent: relogin, session: auth.body };
    await send(freshAlice, [relation('unread', target.id)]);
    await send(freshAlice, [relation('unfollow', target.id)]);
    await send(freshAlice, [relation('unblock', target.id)]);
    await send(freshAlice, [relation('unarchive', target.id)]);
    await send(bob, [relation('read', target.id)]);
    expect((await relogin.get('/api/me/marks').query({ ids: target.id })).body.personalStates[0]).toEqual({ messageId: target.id, followed: false, read: false, blocked: false, archived: false });
    expect((await relogin.get('/api/me/messages?filter=follow')).body.messages).toHaveLength(0);
    expect((await request(app).get('/api/me/marks').query({ ids: target.id })).status).toBe(401);
  });

  it('paginates unseen and blocked records on the server rather than filtering one loaded page', async () => {
    const app = await setup(); const alice = await register(app, 'alice'); const bob = await register(app, 'bob');
    const old = await send(bob, [text('更早的未读记录')]);
    const blocked = await send(bob, [text('屏蔽的记录')]); await send(alice, [relation('block', blocked.id)]);
    const read = await send(bob, [text('已经读过的记录')]); await send(alice, [relation('read', read.id)]);
    const unseen = await alice.agent.get('/api/me/messages').query({ filter: 'unread', q: '记录', limit: 1 });
    expect(unseen.status, unseen.text).toBe(200);
    expect(unseen.body.messages[0].id).toBe(blocked.id);
    const next = await alice.agent.get('/api/me/messages').query({ filter: 'unread', q: '记录', limit: 1, cursor: unseen.body.nextCursor });
    expect(next.body.messages[0].id).toBe(old.id);
    const normal = await alice.agent.get('/api/me/messages').query({ filter: 'normal', q: '记录' });
    expect(normal.body.messages.map((message: Message) => message.id)).not.toContain(blocked.id);
    expect((await alice.agent.get('/api/me/messages?filter=block')).body.messages[0].id).toBe(blocked.id);
  });

  it('provides followed descendant activity and explicit notifications with cursor and after filters', async () => {
    const app = await setup(); const alice = await register(app, 'alice'); const bob = await register(app, 'bob');
    const group = await send(bob, [text('关注的分类'), { id: 'group', type: 'relation', relation: 'classify', roles: {} }]);
    const child = await send(bob, [text('分类内的问题'), relation('member-of', group.id, 'parent')]);
    await send(bob, [text('关注之前'), relation('reply', child.id)]);
    await send(alice, [relation('follow', group.id)]);
    const cutoff = await app.store.latestSequence();
    const update = await send(bob, [text('新的进展'), relation('reply', child.id)]);
    const mine = await send(alice, [text('我的问题')]);
    const explicit = await send(bob, [text('请看这条信息'), relation('notify', mine.id)]);
    await send(bob, [text('无关信息')]);
    const first = await alice.agent.get('/api/me/notifications?limit=1');
    expect(first.status, first.text).toBe(200); expect(first.body.messages[0].id).toBe(explicit.id);
    const second = await alice.agent.get('/api/me/notifications').query({ limit: 1, cursor: first.body.nextCursor });
    expect(second.body.messages[0].id).toBe(update.id);
    const since = await alice.agent.get('/api/me/notifications').query({ after: cutoff });
    expect(since.body.messages.map((message: Message) => message.id).sort()).toEqual([explicit.id, update.id].sort());
    await send(alice, [relation('unfollow', group.id)]);
    await send(bob, [text('取消关注后的进展'), relation('reply', child.id)]);
    expect((await alice.agent.get('/api/me/notifications')).body.messages.map((message: Message) => message.id)).toEqual([explicit.id]);
  });

  it('does not execute an old personal action again when its message is publicly amended', async () => {
    const app = await setup(); const alice = await register(app, 'alice');
    const target = await send(alice, [text('持续的议题')]);
    const original = await send(alice, [relation('follow', target.id)]);
    await send(alice, [relation('unfollow', target.id)]);
    const proposal = await send(alice, [relation('amend', original.id), { id: 'data', type: 'data', value: { expectedRevision: 1, parts: [relation('follow', target.id), text('修改旧关注消息的说明')] } as unknown as Json }]);
    await send(alice, [relation('authorize', proposal.id)]);
    expect((await app.store.message(original.id)).revision).toBe(2);
    expect((await alice.agent.get('/api/me/marks').query({ ids: target.id })).body.personalStates[0].followed).toBe(false);
    expect((await app.store.db.prepare('SELECT COUNT(*) AS n FROM personal_actions WHERE "sourceId"=$1').get(original.id))?.n).toBe(1);
  });
});
