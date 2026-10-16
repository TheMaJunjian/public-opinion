import { bindRoles, ORGANIZATIONS, relations, resolveMemberships, type Json, type Membership, type MembershipAction, type Message, type Part } from '@gonglun/core';
import { DomainError, Mutation, type Store } from './db.js';
import { statesFor } from './projections.js';

const whole = (ref: { revision?: number; partId?: string; memberId?: string; path?: unknown[]; range?: unknown }) =>
    ref.revision === undefined && !ref.partId && !ref.memberId && !ref.path?.length && !ref.range;
async function parent(tx: Mutation, memberId: string): Promise<string | null> {
    const row = await tx.store.db.prepare('SELECT "parentId" FROM memberships WHERE "memberId"=$1').get(memberId);
    return row ? String(row.parentId) : null;
}
async function validateMove(tx: Mutation, memberId: string, parentId: string) {
    if (memberId === parentId) throw new DomainError('消息不能包含自身');
    const organization = await tx.store.message(parentId);
    await tx.store.message(memberId);
    if (!relations(organization).some(p => ORGANIZATIONS.has(p.relation) || p.relation === 'members'))
        throw new DomainError('父消息必须是组织');
    let current: string | null = parentId;
    const seen = new Set<string>();
    while (current) {
        if (current === memberId || seen.has(current)) throw new DomainError('组织不能形成循环');
        seen.add(current); current = await parent(tx, current);
        if (seen.size > 1000) throw new DomainError('组织层级过深');
    }
}

/** Persist history on the public JOIN message as well as in its query index. */
async function recordJoin(tx: Mutation, message: Message, memberId: string, parentId: string) {
    if (await tx.store.db.prepare('SELECT 1 FROM membership_actions WHERE id=$1').get(message.id)) return;
    const previous = await tx.store.db.prepare('SELECT * FROM memberships WHERE "memberId"=$1').get(memberId);
    let previousId: string | null = previous ? String(previous.sourceId) : null;
    // Materialize the actual previous index entry before replacing an old implicit placement.
    if (previousId && !await tx.store.db.prepare('SELECT 1 FROM membership_actions WHERE id=$1').get(previousId)) {
        const baseline = await createJoin(tx, message, memberId, String(previous!.parentId), true);
        previousId = baseline.id;
    }
    const row = await tx.store.db.prepare('INSERT INTO membership_actions(id,body) VALUES ($1,$2) RETURNING position').get(message.id, '{}');
    const component = relations(message).find(part => part.relation === 'member-of' && part.roles.member?.length)!;
    const history: MembershipAction = { id: message.id, memberId, parentId, previousId, previousParentId: previous ? String(previous.parentId) : null, order: Number(row!.position), sourcePartId: component.id, bindingId: component.roles.member![0]!.id, sourceRevision: message.revision };
    await tx.store.db.prepare('UPDATE membership_actions SET body=$1 WHERE id=$2').run(JSON.stringify(history), message.id);
    message.parts = [...message.parts.filter(part => part.id !== 'membership-history'),
        { id: 'membership-history', type: 'data', value: { membershipHistory: history as unknown as Json } }];
    await tx.put(message);
    await setMembership(tx, { memberId, parentId, sourceId: message.id, sourcePartId: history.sourcePartId, bindingId: history.bindingId, sourceRevision: message.revision });
}

async function createJoin(tx: Mutation, origin: Message, memberId: string, parentId: string, baseline = false) {
    const parts: Part[] = [{ id: 'relation', type: 'relation', relation: 'member-of', roles: bindRoles({ parent: [{ messageId: parentId }], member: [{ messageId: memberId }] }) },
        { id: 'data', type: 'data', value: { uiType: 'JOIN', generatedBy: origin.id } }];
    const message = await tx.create(origin.authorId, parts);
    if (baseline) {
        const row = await tx.store.db.prepare('INSERT INTO membership_actions(id,body) VALUES ($1,$2) RETURNING position').get(message.id, '{}');
        const history: MembershipAction = { id: message.id, memberId, parentId, previousId: null, previousParentId: null, order: Number(row!.position) };
        message.parts.push({ id: 'membership-history', type: 'data', value: { membershipHistory: history as unknown as Json } });
        await tx.put(message);
        await tx.store.db.prepare('UPDATE membership_actions SET body=$1 WHERE id=$2').run(JSON.stringify(history), message.id);
    } else await recordJoin(tx, message, memberId, parentId);
    return message;
}

/** Upgrade older native placements using the committed change log as their history. */
export async function initializeOrganizationMemberships(store: Store) {
    const migration = await store.db.prepare("SELECT value FROM settings WHERE key='migration'").get();
    if (migration && JSON.parse(String(migration.value)).mode === 'read-only-rehearsal') return;
    const rows = await store.db.prepare(`SELECT m.*,s.body FROM memberships m JOIN messages s ON s.id=m."sourceId"
        WHERE NOT EXISTS (SELECT 1 FROM membership_actions a WHERE a.body->>'memberId'=m."memberId") ORDER BY m.position`).all();
    const native = rows.filter(row => !(JSON.parse(String(row.body)) as Message).parts.some(part => part.type === 'data' && part.value && typeof part.value === 'object' && !Array.isArray(part.value) && 'legacyTopicId' in part.value));
    if (!native.length) return;
    const timelines = new Map<string, Array<Membership | null>>(native.map(row => [String(row.memberId), []]));
    for (const row of await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()) {
        const change = JSON.parse(String(row.body));
        for (const memberId of change.removedMemberships) timelines.get(memberId)?.push(null);
        for (const membership of change.memberships) timelines.get(membership.memberId)?.push(membership);
    }
    const tx = new Mutation(store);
    for (const row of native) {
        const memberId = String(row.memberId), timeline = timelines.get(memberId)!;
        const last = timeline.at(-1);
        if (last?.parentId !== row.parentId || last?.sourceId !== row.sourceId) timeline.push(row as unknown as Membership);
        let previousId: string | null = null, previousParentId: string | null = null;
        for (const entry of timeline) {
            if (!entry) { previousId = null; previousParentId = null; continue; }
            const origin = await store.message(entry.sourceId);
            const explicit = relations(origin).find(part => part.relation === 'member-of' && part.roles.member?.[0]?.reference.messageId === memberId);
            const join = explicit ? origin : await createJoin(tx, origin, memberId, entry.parentId, true);
            let actionRow = await store.db.prepare('SELECT body,position FROM membership_actions WHERE id=$1').get(join.id);
            if (explicit && actionRow) { previousId = join.id; previousParentId = entry.parentId; continue; }
            if (!actionRow) actionRow = await store.db.prepare('INSERT INTO membership_actions(id,body) VALUES ($1,$2) RETURNING position').get(join.id, '{}');
            const history: MembershipAction = { id: join.id, memberId, parentId: entry.parentId, previousId, previousParentId, order: Number(actionRow!.position) };
            await store.db.prepare('UPDATE membership_actions SET body=$1 WHERE id=$2').run(JSON.stringify(history), join.id);
            join.parts = [...join.parts.filter(part => part.id !== 'membership-history'), { id: 'membership-history', type: 'data', value: { membershipHistory: history as unknown as Json } }];
            await tx.put(join);
            previousId = join.id; previousParentId = entry.parentId;
        }
        if (previousId) await setMembership(tx, { memberId, parentId: String(row.parentId), sourceId: previousId, sourcePartId: 'relation', bindingId: 'member-0', sourceRevision: 1 });
    }
    await reconcileOrganizationEffects(tx);
    await tx.commit();
}

async function setMembership(tx: Mutation, membership: Membership) {
    const before = await tx.store.db.prepare('SELECT * FROM memberships WHERE "memberId"=$1').get(membership.memberId);
    if (before?.parentId === membership.parentId && before.sourceId === membership.sourceId) return;
    await tx.store.db.prepare(`INSERT INTO memberships("memberId","parentId","sourceId","sourcePartId","bindingId","sourceRevision") VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT("memberId") DO UPDATE SET "parentId"=excluded."parentId","sourceId"=excluded."sourceId","sourcePartId"=excluded."sourcePartId","bindingId"=excluded."bindingId","sourceRevision"=excluded."sourceRevision"`)
        .run(membership.memberId, membership.parentId, membership.sourceId, membership.sourcePartId ?? 'relation', membership.bindingId ?? 'member-0', membership.sourceRevision ?? 1);
    tx.memberships.set(membership.memberId, membership); tx.removed.delete(membership.memberId);
    tx.affected.add(membership.memberId); tx.affected.add(membership.parentId);
    if (before) tx.affected.add(String(before.parentId));
    await affectSubtree(tx, membership.memberId);
}

async function affectSubtree(tx: Mutation, memberId: string) {
    for (const row of await tx.store.db.prepare(`WITH RECURSIVE subtree(id) AS (SELECT $1 UNION SELECT m."memberId" FROM memberships m JOIN subtree s ON m."parentId"=s.id) SELECT id FROM subtree`).all(memberId)) tx.affected.add(String(row.id));
}

/** The index is a projection of JOIN history, never the source of that history. */
export async function reconcileOrganizationEffects(tx: Mutation) {
    const rows = await tx.store.db.prepare('SELECT id,body,disabled FROM membership_actions ORDER BY position').all();
    if (!rows.length) return;
    const actions = rows.map(row => row.body as MembershipAction);
    if (!actions.some(action => tx.affected.has(action.id) || tx.affected.has(action.parentId) || tx.affected.has(action.memberId))) return;
    const states = await statesFor(tx.store, [...new Set(actions.flatMap(action => [action.id, action.parentId]))]);
    const rejected = new Set(states.filter(state => state.suppressed).map(state => state.messageId));
    for (const row of rows) if (row.disabled) rejected.add(String(row.id));
    const resolved = resolveMemberships(actions, rejected);
    for (const memberId of resolved.trackedMembers) {
        const action = resolved.effective.get(memberId);
        if (action) await setMembership(tx, { memberId, parentId: action.parentId, sourceId: action.id, sourcePartId: action.sourcePartId ?? 'relation', bindingId: action.bindingId ?? 'member-0', sourceRevision: action.sourceRevision ?? 1 });
        else {
            const before = await tx.store.db.prepare('SELECT "parentId" FROM memberships WHERE "memberId"=$1').get(memberId);
            if (before) {
                await affectSubtree(tx, memberId);
                await tx.store.db.prepare('DELETE FROM memberships WHERE "memberId"=$1').run(memberId);
                tx.removed.add(memberId); tx.memberships.delete(memberId); tx.affected.add(memberId); tx.affected.add(String(before.parentId));
            }
        }
    }
    for (const action of actions) tx.affected.add(action.id);
}

/** Authorized list edits create the same placement records as ordinary moves. */
export async function reconcileOrganizationRevision(tx: Mutation, before: Message, after: Message) {
    const oldGroup = relations(before).find(part => ORGANIZATIONS.has(part.relation));
    const newGroup = relations(after).find(part => ORGANIZATIONS.has(part.relation));
    if (await tx.store.db.prepare('SELECT 1 FROM membership_actions WHERE id=$1').get(before.id)) {
        await tx.store.db.prepare('UPDATE membership_actions SET disabled=TRUE WHERE id=$1').run(before.id);
        tx.affected.add(before.id);
        const placement = relations(after).find(part => part.relation === 'member-of' && part.roles.member?.length);
        if (placement) {
            const members = placement.roles.member!, parents = placement.roles.parent ?? [];
            if (members.length !== 1 || parents.length !== 1 || !whole(members[0]!.reference) || !whole(parents[0]!.reference)) throw new DomainError('加入组织须指定唯一完整父消息和成员');
            await validateMove(tx, members[0]!.reference.messageId, parents[0]!.reference.messageId);
            await createJoin(tx, after, members[0]!.reference.messageId, parents[0]!.reference.messageId);
        }
        return true;
    }
    if (oldGroup && !newGroup) {
        await tx.store.db.prepare('UPDATE membership_actions SET disabled=TRUE WHERE body->>\'parentId\'=$1').run(before.id);
        tx.affected.add(before.id);
        return true;
    }
    if (!oldGroup || !newGroup) return false;
    const refs = (newGroup.roles.members ?? []).map(binding => binding.reference);
    if (refs.some(ref => !whole(ref)) || new Set(refs.map(ref => ref.messageId)).size !== refs.length)
        throw new DomainError('组织成员须为不重复的当前完整消息');
    const desired = new Set(refs.map(ref => ref.messageId));
    const current = await tx.store.db.prepare('SELECT * FROM memberships WHERE "parentId"=$1').all(before.id);
    const outer = await parent(tx, before.id);
    for (const member of current) {
        if (desired.has(String(member.memberId))) continue;
        if (outer) await createJoin(tx, after, String(member.memberId), outer);
        else {
            await tx.store.db.prepare('UPDATE membership_actions SET disabled=TRUE WHERE id=$1').run(String(member.sourceId));
            await tx.store.db.prepare('DELETE FROM memberships WHERE "memberId"=$1').run(String(member.memberId));
            tx.removed.add(String(member.memberId)); tx.affected.add(String(member.memberId));
        }
    }
    for (const ref of refs) if (!current.some(member => member.memberId === ref.messageId)) {
        await validateMove(tx, ref.messageId, after.id);
        await createJoin(tx, after, ref.messageId, after.id);
    }
    if (!after.parts.some(part => part.id === 'organization-memberships')) {
        after.parts.push({ id: 'organization-memberships', type: 'data', value: { independentMemberships: true } });
        await tx.put(after);
    }
    return true;
}

export async function applyOrganization(tx: Mutation, message: Message) {
    for (const part of relations(message)) {
        if (ORGANIZATIONS.has(part.relation) || part.relation === 'members') {
            if (!message.parts.some(part => part.id === 'organization-memberships')) {
                message.parts.push({ id: 'organization-memberships', type: 'data', value: { independentMemberships: true } });
                await tx.put(message);
            }
            const members = (part.roles.members ?? []).map(binding => binding.reference);
            if (members.some(ref => !whole(ref))) throw new DomainError('组织成员须指向当前完整消息');
            if (new Set(members.map(ref => ref.messageId)).size !== members.length) throw new DomainError('组织成员不能重复');
            if (members.length) {
                const parents = new Set<string | null>();
                for (const ref of members) parents.add(await parent(tx, ref.messageId));
                if (parents.size !== 1) throw new DomainError('重新组织的消息须为同父兄弟');
                const existingParent = [...parents][0];
                if (existingParent) { await validateMove(tx, message.id, existingParent); await createJoin(tx, message, message.id, existingParent); }
                for (const member of members) {
                    await validateMove(tx, member.messageId, message.id);
                    await createJoin(tx, message, member.messageId, message.id);
                }
            }
        }
        if (part.relation === 'member-of') {
            if (part.roles.parent?.length !== 1 || !whole(part.roles.parent[0]!.reference)) throw new DomainError('加入组织须指定唯一完整父消息');
            const members = part.roles.member ?? [{ id: 'self', reference: { messageId: message.id } }];
            if (members.length !== 1 || !whole(members[0]!.reference)) throw new DomainError('加入组织须指定唯一完整成员');
            const memberId = members[0]!.reference.messageId, parentId = part.roles.parent[0]!.reference.messageId;
            await validateMove(tx, memberId, parentId);
            if (part.roles.member?.length) await recordJoin(tx, message, memberId, parentId);
            else await createJoin(tx, message, memberId, parentId);
        }
    }
}
