import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { resolveMemberships, type MembershipAction } from '@gonglun/core';
import { createTestApp, cleanupTestDatabases } from './test-database.js';
import { convertMessagesToDemoModel } from '../../../frontend/src/utils/modelBridge.js';
import { deriveContainerEffect } from '../../../frontend/src/pages/workbench/model/containerEffect.js';
import { initializeOrganizationMemberships } from '../../migrate/src/migrate-organization-memberships.js';
import { projectWorkbenchSnapshot } from '../../../frontend/src/utils/workbenchProjection.js';

afterEach(cleanupTestDatabases);
async function setup() {
    const app = await createTestApp(), agent = request.agent(app);
    const session = (await agent.post('/api/register').send({ name: 'membership-test', password: 'long-test-password' })).body;
    async function post(path: string, body: Record<string, unknown>, requestId = randomUUID()) {
        const result = await agent.post(`/api/ui${path}`).set('x-csrf-token', session.csrf).set('x-request-id', requestId).send(body);
        expect(result.status, result.text).toBe(201); return result.body;
    }
    const content = (parentMessageId?: string) => post('/messages', { content: randomUUID(), parentMessageId });
    const group = (ids: string[], relationType = 'CLASSIFY') => post('/relations', { relationType, targetRefs: ids.map(messageId => ({ kind: 'message', messageId })) });
    const join = (memberId: string, parentId: string) => post('/relations', { relationType: 'JOIN', sourceMessageId: parentId, targetRefs: [{ kind: 'message', messageId: memberId }] });
    const stance = (id: string, relationType = 'DISAGREE') => post('/relations', { relationType, targetRefs: [{ kind: 'relation', relationId: id, part: 'decoration' }] });
    const membership = (id: string) => app.store.db.prepare('SELECT * FROM memberships WHERE "memberId"=$1').get(id);
    async function parity() {
        const response = await agent.get('/api/ui/snapshot?limit=200'); expect(response.status).toBe(200);
        const snapshot = response.body, model = convertMessagesToDemoModel(snapshot.messages, snapshot.relations);
        const effect = deriveContainerEffect({ ...model, relations: snapshot.relations, username: 'membership-test' });
        const active = snapshot.relations.filter((relation: any) => relation.payload?.membershipHistory && relation.state.membershipActive).map((relation: any) => relation.id);
        expect(effect.effectiveJoinIds).toEqual(new Set(active));
        const counts = new Map<string, number>();
        for (const relation of snapshot.relations) if (effect.effectiveJoinIds.has(relation.id)) for (const ref of relation.targetRefs) {
            const id = ref.messageId ?? ref.relationId; counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        expect([...counts.values()].every(count => count === 1)).toBe(true);
        const placements = await app.store.db.prepare('SELECT * FROM memberships').all();
        for (const relation of snapshot.relations.filter((relation: any) => ['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'].includes(relation.relationType))) {
            const members = effect.ownership.direct(relation.id);
            expect(new Set([...members.textIds, ...members.relationIds])).toEqual(new Set(placements.filter(row => row.parentId === relation.id).map(row => String(row.memberId))));
        }
        for (const relation of snapshot.relations.filter((relation: any) => relation.payload?.membershipHistory)) {
            expect(effect.context.joinStatusByMessage.get(relation.id) === 'valid').toBe(relation.state.membershipActive);
        }
        return { snapshot, effect };
    }
    return { app, agent, session, post, content, group, join, stance, membership, parity };
}

it.each(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'])('%s creates independently removable JOINs atomically and restores them', async type => {
    const t = await setup(), a = await t.content(), b = await t.content();
    const body = { relationType: type, targetRefs: [a, b].map(message => ({ kind: 'message', messageId: message.id })) };
    const requestId = randomUUID(), container = await t.post('/relations', body, requestId);
    const placement = (await t.membership(a.id))!, other = (await t.membership(b.id))!;
    expect(placement.sourceId).not.toBe(container.id); expect(placement.sourceId).not.toBe(other.sourceId);
    const count = (await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get())!.n;
    expect((await t.post('/relations', body, requestId)).id).toBe(container.id);
    expect((await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get())!.n).toBe(count);
    const change = JSON.parse(String((await t.app.store.db.prepare('SELECT body FROM changes WHERE sequence=$1').get(container.sequence))!.body));
    expect(change.messages.map((message: any) => message.id)).toEqual(expect.arrayContaining([container.id, placement.sourceId, other.sourceId]));
    await t.parity();
    const rejection = await t.stance(String(placement.sourceId));
    expect(await t.membership(a.id)).toBeUndefined(); expect((await t.membership(b.id))?.parentId).toBe(container.id);
    await t.parity();
    await t.stance(rejection.id);
    expect((await t.membership(a.id))?.sourceId).toBe(placement.sourceId);
    await t.stance(container.id);
    expect(await t.membership(a.id)).toBeUndefined(); expect(await t.membership(b.id)).toBeUndefined();
    await t.parity();
    await t.stance(container.id, 'AGREE');
    expect((await t.membership(a.id))?.parentId).toBe(container.id);
    await t.parity();
});

it('restores the recorded prior parent after a nested container moves, preserving later independent joins', async () => {
    const t = await setup(), p = await t.group([]), q = await t.group([]);
    const a = await t.content(p.id), b = await t.content(p.id), c = await t.group([a.id, b.id]);
    const original = (await t.membership(a.id))!, d = await t.group([]);
    await t.join(c.id, q.id);
    const moved = await t.join(a.id, d.id);
    const before = (await t.agent.get('/api/ui/snapshot')).body.sequence;
    await t.stance(c.id);
    expect((await t.membership(a.id))?.parentId).toBe(d.id);
    expect((await t.membership(b.id))?.parentId).toBe(p.id);
    await t.stance(moved.id);
    expect((await t.membership(a.id))?.parentId).toBe(p.id);
    const { effect } = await t.parity();
    expect(effect.ownership.direct(q.id).textIds.has(a.id)).toBe(false);
    expect(effect.ownership.direct(p.id).textIds).toEqual(new Set([a.id, b.id]));
    const delta = (await t.agent.get(`/api/ui/snapshot?after=${before}`)).body;
    expect(delta.messages.map((message: any) => message.id)).toEqual(expect.arrayContaining([a.id, b.id, p.id]));
    await t.stance(c.id, 'AGREE');
    expect((await t.membership(a.id))?.sourceId).toBe(original.sourceId);
    await t.parity();
});

it('rolls back generated JOINs when another command in the batch fails', async () => {
    const t = await setup(), a = await t.content(), b = await t.content();
    const before = (await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get())!.n;
    const requestId = randomUUID();
    const response = await t.agent.post('/api/ui/commands').set('x-csrf-token', t.session.csrf).set('x-request-id', requestId).send({ requestId, commands: [
        { id: randomUUID(), method: 'POST', path: '/relations', body: { relationType: 'CLASSIFY', targetRefs: [a, b].map(message => ({ kind: 'message', messageId: message.id })) } },
        { id: randomUUID(), method: 'POST', path: '/relations', body: { relationType: 'JOIN', sourceMessageId: a.id, targetRefs: [{ kind: 'message', messageId: b.id }] } },
    ] });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('父消息必须是组织');
    expect((await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get())!.n).toBe(before);
    expect(await t.membership(a.id)).toBeUndefined();
});

it.each([false, true])('returns generated JOINs with a classification batch before any subsequent snapshot request (nested: %s)', async nested => {
    const t = await setup(), parent = nested ? await t.group([]) : undefined;
    const a = await t.content(parent?.id), b = await t.content(parent?.id);
    const containerId = randomUUID(), body = { requestId: randomUUID(), commands: [
        { id: containerId, method: 'POST', path: '/relations', body: { parentMessageId: parent?.id, relationType: 'CLASSIFY', targetRefs: [a, b].map(message => ({ kind: 'message', messageId: message.id })) } },
    ] };
    const send = () => t.agent.post('/api/ui/commands').set('x-csrf-token', t.session.csrf).set('x-request-id', body.requestId).send(body);
    const response = await send();
    expect(response.status, response.text).toBe(201);
    const committed = response.body.snapshots?.find((page: any) => page.scope.messageId === (parent?.id ?? null));
    expect(committed).toBeDefined();
    const joins = committed.relations.filter((relation: any) => relation.relationType === 'JOIN' && relation.sourceMessageId === containerId);
    expect(joins).toHaveLength(2);
    expect(joins.every((relation: any) => relation.state.membershipActive && relation.payload.membershipHistory)).toBe(true);
    expect(committed.messages.map((message: any) => message.id)).toEqual(expect.arrayContaining(joins.map((join: any) => join.id)));
    const model = convertMessagesToDemoModel(committed.messages, committed.relations);
    expect(model.messages.filter(message => message.kind === 'join').map(message => message.id)).toEqual(expect.arrayContaining(joins.map((join: any) => join.id)));
    expect((await send()).body).toEqual(response.body);
});

it('creates one shared JOIN record when an existing classification is selected to create an outer classification', async () => {
    const t = await setup(), leaf = await t.content(), inner = await t.group([leaf.id]);
    const outerId = randomUUID(), requestId = randomUUID();
    const response = await t.agent.post('/api/ui/commands').set('x-csrf-token', t.session.csrf).set('x-request-id', requestId).send({ requestId, commands: [
        { id: outerId, method: 'POST', path: '/relations', body: { relationType: 'CLASSIFY', payload: { title: '外层分类' }, targetRefs: [{ kind: 'relation', relationId: inner.id, reference: { messageId: inner.id } }] } },
    ] });
    expect(response.status, response.text).toBe(201);
    const snapshot = response.body.snapshots[0];
    const joins = snapshot.relations.filter((relation: any) => relation.relationType === 'JOIN' && relation.sourceMessageId === outerId);
    expect(joins).toHaveLength(1);
    expect(joins[0].targetRefs).toEqual([expect.objectContaining({ kind: 'relation', relationId: inner.id })]);
    expect((await t.membership(inner.id))?.sourceId).toBe(joins[0].id);
    expect((await t.membership(leaf.id))?.parentId).toBe(inner.id);
    await t.parity();
});

it('serializes competing moves and restores precisely the preceding effective placement', async () => {
    const t = await setup(), a = await t.content(), p = await t.group([]), q = await t.group([]);
    const joins = await Promise.all([t.join(a.id, p.id), t.join(a.id, q.id)]);
    const active = (await t.membership(a.id))!, inactive = joins.find(join => join.id !== active.sourceId)!;
    await t.parity();
    await t.stance(String(active.sourceId));
    expect((await t.membership(a.id))?.sourceId).toBe(inactive.id);
    await t.parity();
});

it('does not resurrect an unrelated older JOIN when the recorded preceding position was root', async () => {
    const t = await setup(), a = await t.content(), p = await t.group([]), q = await t.group([]);
    const old = await t.join(a.id, p.id);
    await t.stance(old.id);
    expect(await t.membership(a.id)).toBeUndefined();
    const current = await t.join(a.id, q.id);
    await t.stance(old.id, 'AGREE');
    expect((await t.membership(a.id))?.sourceId).toBe(current.id);
    await t.stance(current.id);
    expect(await t.membership(a.id)).toBeUndefined();
    await t.parity();
});

it.each(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'])('restoring %s and old JOIN approvals preserves subsequent moves and their recorded root fallback', async type => {
    const t = await setup(), a = await t.content(), b = await t.content(), c = await t.group([a.id, b.id], type);
    const original = (await t.membership(a.id))!, p = await t.group([]), q = await t.group([]);
    await t.stance(c.id);
    expect(await t.membership(a.id)).toBeUndefined();
    const first = await t.join(a.id, p.id), second = await t.join(a.id, q.id);
    await t.parity();
    await t.stance(c.id, 'AGREE');
    expect((await t.membership(a.id))?.sourceId).toBe(second.id);
    expect((await t.membership(b.id))?.parentId).toBe(c.id);
    await t.stance(String(original.sourceId), 'AGREE');
    expect((await t.membership(a.id))?.sourceId).toBe(second.id);
    let { effect } = await t.parity();
    expect(effect.context.joinStatusByMessage.get(String(original.sourceId))).toBe('superseded');
    await t.stance(second.id);
    expect((await t.membership(a.id))?.sourceId).toBe(first.id);
    await t.parity();
    await t.stance(first.id);
    expect(await t.membership(a.id)).toBeUndefined();
    await t.parity();
    await t.stance(c.id); await t.stance(c.id, 'AGREE');
    expect(await t.membership(a.id)).toBeUndefined();
    await t.stance(second.id, 'AGREE');
    expect((await t.membership(a.id))?.sourceId).toBe(second.id);
    ({ effect } = await t.parity());
    expect(effect.ownership.direct(c.id).textIds).toEqual(new Set([b.id]));
    expect(effect.ownership.direct(q.id).textIds).toEqual(new Set([a.id]));
});

it('requires container recovery before direct or indirect JOIN approval, without changing fees or memberships on failure', async () => {
    const t = await setup(), a = await t.content(), b = await t.content(), c = await t.group([a.id, b.id]);
    const joining = String((await t.membership(a.id))!.sourceId);
    const rejection = await t.stance(joining);
    await t.stance(c.id);
    const before = await t.app.store.latestSequence(), account = await t.app.store.account(t.session.user.id);
    const count = (await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get())!.n;
    for (const [relationType, target] of [['AGREE', joining], ['DISAGREE', rejection.id]]) {
        const response = await t.agent.post('/api/ui/relations').set('x-csrf-token', t.session.csrf).set('x-request-id', randomUUID()).send({
            relationType, targetRefs: [{ kind: 'relation', relationId: target, part: 'decoration' }],
        });
        expect(response.status, response.text).toBe(409);
        expect(response.body.error).toContain('请先赞同并恢复容器');
    }
    const failedJoin = await t.agent.post('/api/ui/relations').set('x-csrf-token', t.session.csrf).set('x-request-id', randomUUID()).send({
        relationType: 'JOIN', sourceMessageId: c.id, targetRefs: [{ kind: 'message', messageId: a.id }],
    });
    expect(failedJoin.status, failedJoin.text).toBe(409);
    const native = await t.agent.post('/api/messages').set('x-csrf-token', t.session.csrf).send({ requestId: randomUUID(), parts: [
        { id: 'stance', type: 'relation', relation: 'agree', roles: { target: [{ id: 'target', reference: { messageId: joining } }] } },
    ] });
    expect(native.status, native.text).toBe(409);
    const requestId = randomUUID(), draftId = randomUUID();
    const batch = await t.agent.post('/api/ui/commands').set('x-csrf-token', t.session.csrf).set('x-request-id', requestId).send({ requestId, commands: [
        { id: draftId, method: 'POST', path: '/messages', body: { content: '不能留下的半成品理由' } },
        { id: randomUUID(), method: 'POST', path: '/relations', body: { relationType: 'AGREE', sourceMessageId: draftId, targetRefs: [{ kind: 'relation', relationId: joining }] } },
    ] });
    expect(batch.status, batch.text).toBe(409);
    expect(await t.app.store.latestSequence()).toBe(before);
    expect(await t.app.store.account(t.session.user.id)).toEqual(account);
    expect((await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get())!.n).toBe(count);
    expect(await t.membership(a.id)).toBeUndefined();
    expect(await t.membership(b.id)).toBeUndefined();
    await t.parity();
    // Opposition is still allowed while the parent is rejected; container recovery
    // does not clear the member's independent opposition.
    await t.stance(joining);
    await t.stance(c.id, 'AGREE');
    expect(await t.membership(a.id)).toBeUndefined();
    expect((await t.membership(b.id))?.parentId).toBe(c.id);
    await t.stance(joining, 'AGREE');
    expect((await t.membership(a.id))?.sourceId).toBe(joining);
    await t.parity();
});

it('allows discussion of JOIN text while its container is rejected without restoring the placement', async () => {
    const t = await setup(), a = await t.content(), c = await t.group([]);
    const joining = await t.post('/relations', { relationType: 'JOIN', sourceMessageId: c.id, targetRefs: [{ kind: 'message', messageId: a.id }], payload: { content: '加入的理由' } });
    await t.stance(c.id);
    await t.post('/relations', { relationType: 'AGREE', targetRefs: [{ kind: 'relation', relationId: joining.id, part: 'label' }] });
    expect(await t.membership(a.id)).toBeUndefined();
    const { effect } = await t.parity();
    expect(effect.context.joinStatusByMessage.get(joining.id)).toBe('container-rejected');
});

it('keeps personal JOIN approval available when another viewer opposes the container', async () => {
    const t = await setup(), member = await t.content(), container = await t.group([member.id]);
    const joining = String((await t.membership(member.id))!.sourceId);
    const other = request.agent(t.app), session = (await other.post('/api/register').send({ name: 'other-viewer', password: 'long-test-password' })).body;
    const response = await other.post('/api/ui/relations').set('x-csrf-token', session.csrf).set('x-request-id', randomUUID()).send({
        relationType: 'DISAGREE', targetRefs: [{ kind: 'relation', relationId: container.id, part: 'decoration' }],
    });
    expect(response.status, response.text).toBe(201);
    await t.stance(joining, 'AGREE');
    const snapshot = (await t.agent.get('/api/ui/snapshot?limit=200')).body, projected = projectWorkbenchSnapshot(snapshot);
    const mine = deriveContainerEffect({ ...projected, relations: projected.relations, username: 'membership-test', stakeCounts: projected.counts });
    const theirs = deriveContainerEffect({ ...projected, relations: projected.relations, username: 'other-viewer', stakeCounts: projected.counts });
    expect(mine.joinByTarget.get(member.id)).toBe(joining);
    expect(mine.context.joinStatusByMessage.get(joining)).toBe('valid');
    expect(theirs.joinByTarget.has(member.id)).toBe(false);
    expect(theirs.context.joinStatusByMessage.get(joining)).toBe('container-rejected');
});

type ThreeContainerCase = {
    type: string; name: string; beforeB: string[]; beforeC: string[];
    rejectJoinB?: boolean; previousC: string | null; fallback: string | null;
};
const threeContainerCases = ['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'].flatMap<ThreeContainerCase>(type => [
    { type, name: 'full chain', beforeB: [], beforeC: ['A'], previousC: 'B', fallback: 'B' },
    { type, name: 'B starts from root', beforeB: ['A'], beforeC: [], previousC: 'B', fallback: 'B' },
    { type, name: 'C skips rejected B', beforeB: [], beforeC: ['B'], previousC: 'A', fallback: 'A' },
    { type, name: 'C starts from root', beforeB: [], beforeC: ['A', 'B'], previousC: null, fallback: null },
    { type, name: 'C skips rejected JOIN B', beforeB: [], beforeC: [], rejectJoinB: true, previousC: 'A', fallback: 'A' },
]);

it.each(threeContainerCases)('$type / $name: recovering A and B before opposing the latest JOIN preserves its recorded fallback', async scenario => {
    const t = await setup(), member = await t.content();
    const containers = new Map<string, string>();
    for (const name of ['A', 'B', 'C']) containers.set(name, (await t.group([], scenario.type)).id);
    const joins = new Map<string, string>();
    async function check(owner: string | null) {
        const placement = await t.membership(member.id);
        expect(placement?.parentId ?? null).toBe(owner ? containers.get(owner) : null);
        expect(placement?.sourceId ?? null).toBe(owner ? joins.get(owner) : null);
        const { effect } = await t.parity();
        expect([...containers].filter(([, id]) => effect.ownership.direct(id).textIds.has(member.id)).map(([name]) => name)).toEqual(owner ? [owner] : []);
        for (const [name, id] of joins) expect(effect.context.joinStatusByMessage.get(id) === 'valid').toBe(name === owner);
    }
    joins.set('A', (await t.join(member.id, containers.get('A')!)).id);
    await check('A');
    for (const name of scenario.beforeB) { await t.stance(containers.get(name)!); await check(null); }
    joins.set('B', (await t.join(member.id, containers.get('B')!)).id);
    await check('B');
    for (const name of scenario.beforeC) {
        await t.stance(containers.get(name)!);
        await check(name === 'A' ? 'B' : scenario.beforeB.includes('A') || scenario.beforeC.includes('A') ? null : 'A');
    }
    if (scenario.rejectJoinB) { await t.stance(joins.get('B')!); await check('A'); }
    joins.set('C', (await t.join(member.id, containers.get('C')!)).id);
    const action = await t.app.store.db.prepare('SELECT body FROM membership_actions WHERE id=$1').get(joins.get('C')!);
    expect(action!.body.previousId).toBe(scenario.previousC ? joins.get(scenario.previousC) : null);
    await check('C');
    for (const name of ['A', 'B']) { await t.stance(containers.get(name)!, 'AGREE'); await check('C'); }
    await t.stance(joins.get('C')!);
    await check(scenario.fallback);
    // Approving a skipped old JOIN does not insert it into C's recorded chain.
    for (const name of ['A', 'B']) { await t.stance(joins.get(name)!, 'AGREE'); await check(scenario.fallback); }
    await t.stance(joins.get('C')!, 'AGREE');
    await check('C');
    await t.stance(containers.get('C')!);
    await check(scenario.fallback);
    await t.stance(containers.get('C')!, 'AGREE');
    await check('C');
    await t.stance(joins.get('C')!);
    await check(scenario.fallback);
});

it('records A → B → A as separate moves, while approval adds no new placement history', async () => {
    const t = await setup(), member = await t.content(), a = await t.group([]), b = await t.group([]);
    const first = await t.join(member.id, a.id);
    await t.stance(first.id, 'AGREE');
    expect((await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM membership_actions WHERE body->>\'memberId\'=$1').get(member.id))!.n).toBe(1);
    const middle = await t.join(member.id, b.id), returned = await t.join(member.id, a.id);
    expect(returned.id).not.toBe(first.id);
    const row = await t.app.store.db.prepare('SELECT body FROM membership_actions WHERE id=$1').get(returned.id);
    expect(row!.body.previousId).toBe(middle.id);
    expect((await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM membership_actions WHERE body->>\'memberId\'=$1').get(member.id))!.n).toBe(3);
    await t.stance(returned.id);
    expect((await t.membership(member.id))?.sourceId).toBe(middle.id);
    await t.parity();
    await t.stance(returned.id, 'AGREE');
    expect((await t.membership(member.id))?.sourceId).toBe(returned.id);
    await t.parity();
});

it('retains opposition records for C and B, and a subsequent JOIN D returns to A when opposed', async () => {
    const t = await setup(), member = await t.content(), joins: string[] = [], oppositions: string[] = [];
    for (const name of ['A', 'B', 'C']) {
        const container = await t.post('/relations', { relationType: 'CLASSIFY', payload: { title: name }, targetRefs: [] });
        joins.push((await t.join(member.id, container.id)).id);
    }
    for (const [targetIndex, expectedIndex] of [[2, 1], [1, 0]] as const) {
        const opposition = await t.stance(joins[targetIndex]);
        oppositions.push(opposition.id);
        expect(opposition).toMatchObject({ relationType: 'DISAGREE', targetRefs: [{ kind: 'relation', relationId: joins[targetIndex] }] });
        expect(opposition.payload?.membershipHistory).toBeUndefined();
        expect((await t.membership(member.id))?.sourceId).toBe(joins[expectedIndex]);
        expect((await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM membership_actions WHERE body->>\'memberId\'=$1').get(member.id))!.n).toBe(3);
        await t.parity();
    }
    const d = await t.group([]), joinD = await t.join(member.id, d.id);
    const actionD = await t.app.store.db.prepare('SELECT body FROM membership_actions WHERE id=$1').get(joinD.id);
    expect(actionD!.body.previousId).toBe(joins[0]);
    expect((await t.membership(member.id))?.sourceId).toBe(joinD.id);
    await t.parity();
    const opposeD = await t.stance(joinD.id);
    expect((await t.membership(member.id))?.sourceId).toBe(joins[0]);
    expect((await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM membership_actions WHERE body->>\'memberId\'=$1').get(member.id))!.n).toBe(4);
    const { snapshot, effect } = await t.parity();
    for (const id of [...joins, ...oppositions, joinD.id, opposeD.id]) {
        expect(snapshot.messages.filter((message: any) => message.id === id)).toHaveLength(1);
        expect(snapshot.relations.filter((relation: any) => relation.id === id)).toHaveLength(1);
    }
    expect(effect.context.joinStatusByMessage.get(joins[0])).toBe('valid');
    for (const id of [joins[1], joins[2], joinD.id]) expect(effect.context.joinStatusByMessage.get(id)).toBe('rejected');
});

it('removes the entire descendant subtree from a former scope when an organization returns to root', async () => {
    const t = await setup(), a = await t.content(), c = await t.group([a.id]), p = await t.group([]);
    const joining = await t.join(c.id, p.id);
    const before = (await t.agent.get(`/api/ui/snapshot?parent=${p.id}`)).body.sequence;
    await t.stance(joining.id);
    expect(await t.membership(c.id)).toBeUndefined();
    expect((await t.membership(a.id))?.parentId).toBe(c.id);
    const delta = (await t.agent.get(`/api/ui/snapshot?parent=${p.id}&after=${before}`)).body;
    expect(delta.removedMessageIds).toEqual(expect.arrayContaining([c.id, a.id]));
    await t.parity();
});

it('upgrades an older implicit placement from the change log once and retains its prior parent', async () => {
    const t = await setup(), p = await t.group([]), a = await t.content(p.id), c = await t.group([a.id]);
    // Emulate the old native index: the grouping message itself owned the member.
    await t.app.store.db.prepare('DELETE FROM membership_actions WHERE body->>\'memberId\'=$1').run(a.id);
    await t.app.store.db.prepare('UPDATE memberships SET "sourceId"=$1 WHERE "memberId"=$2').run(c.id, a.id);
    await t.app.store.transaction(() => initializeOrganizationMemberships(t.app.store));
    const upgraded = (await t.membership(a.id))!;
    expect(upgraded.sourceId).not.toBe(c.id);
    const sequence = await t.app.store.latestSequence();
    await t.app.store.transaction(() => initializeOrganizationMemberships(t.app.store));
    expect(await t.app.store.latestSequence()).toBe(sequence);
    await t.stance(c.id);
    expect((await t.membership(a.id))?.parentId).toBe(p.id);
    await t.parity();
});

it('restoring old placements cannot introduce a cycle', () => {
    const actions: MembershipAction[] = [
        { id: 'a-b', memberId: 'a', parentId: 'b', previousId: null, previousParentId: null, order: 1 },
        { id: 'a-c', memberId: 'a', parentId: 'c', previousId: 'a-b', previousParentId: 'b', order: 2 },
        { id: 'b-a', memberId: 'b', parentId: 'a', previousId: null, previousParentId: null, order: 3 },
    ];
    const result = resolveMemberships(actions, new Set(['a-c']));
    expect(result.effective.get('a')?.id).toBe('a-b'); expect(result.effective.has('b')).toBe(false);
});
