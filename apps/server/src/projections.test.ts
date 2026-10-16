import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindRoles, resolveStance, type Message, type Part, type Reference } from '@gonglun/core';
import { Mutation, Store } from './db.js';
import { recordStance, statesFor } from './projections.js';
import { cleanupTestDatabases, createTestStore } from './test-database.js';

const stores: Store[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); await cleanupTestDatabases(); });

async function fixture() {
  const store = await createTestStore();
  stores.push(store);
  async function publish(parts: Part[], authorId = 'alice'): Promise<Message> {
    return store.transaction(async () => {
      const tx = new Mutation(store);
      const message = await tx.create(authorId, parts);
      await tx.commit();
      return store.message(message.id);
    });
  }
  async function stance(target: Reference, side: 'pro' | 'con'): Promise<Message> {
    return store.transaction(async () => {
      const tx = new Mutation(store);
      const message = await tx.create('alice', [{
        id: 'stance', type: 'relation', relation: side === 'pro' ? 'agree' : 'disagree',
        roles: bindRoles({ target: [target] }),
      }]);
      const revisions = (await store.db.prepare('SELECT body FROM revisions ORDER BY revision').all()).map(row => JSON.parse(row.body) as Message);
      const byRevision = new Map(revisions.map(item => [`${item.id}:${item.revision}`, item]));
      const current = new Map(revisions.map(item => [item.id, item]));
      const resolved = resolveStance(target, side, (id, revision) => revision === undefined ? current.get(id) : byRevision.get(`${id}:${revision}`));
      await recordStance(store, message, resolved);
      await tx.commit();
      return store.message(message.id);
    });
  }
  const summary = await publish([
    { id: 'content', type: 'text', text: '总结内容' },
    { id: 'organization', type: 'relation', relation: 'summary', roles: { members: [] } },
  ]);
  return { store, publish, stance, summary };
}

describe('authoritative organization display states', () => {
  it('keeps an effective opposition after more than 100 later references push it out of the context page', async () => {
    const { store, publish, stance, summary } = await fixture();
    const opposition = await stance({ messageId: summary.id, revision: 1 }, 'con');
    for (let index = 0; index < 120; index++) await publish([{
      id: 'reference', type: 'relation', relation: 'reference',
      roles: bindRoles({ target: [{ messageId: summary.id }] }),
    }], `reader-${index}`);
    const boundedReferences = await store.db.prepare(`
      SELECT source.id FROM refs JOIN messages source ON source.id = refs."sourceId"
      WHERE refs."targetId" = $1 ORDER BY source.sequence DESC LIMIT 100
    `).all(summary.id);
    expect(boundedReferences).toHaveLength(100);
    expect(boundedReferences.some(row => row.id === opposition.id)).toBe(false);
    expect(await statesFor(store, [summary.id])).toEqual([expect.objectContaining({
      messageId: summary.id, suppressed: true, supportCount: 0, oppositionCount: 1,
    })]);
  });

  it('does not reinterpret a recorded historical stance when its referenced source is edited', async () => {
    const { store, stance, summary } = await fixture();
    const original = await stance({ messageId: summary.id, revision: 1 }, 'con');
    await stance({ messageId: original.id, revision: 1, partId: 'stance' }, 'con');
    const before = await statesFor(store, [summary.id]);
    expect(before[0]).toMatchObject({ suppressed: false, supportCount: 1, oppositionCount: 0 });

    await store.transaction(async () => {
      const tx = new Mutation(store);
      const updated: Message = {
        ...original, revision: 2,
        parts: [{ id: 'stance', type: 'relation', relation: 'agree', roles: bindRoles({ target: [{ messageId: summary.id, revision: 1 }] }) }],
      };
      await tx.put(updated);
      // Even an accidental replay cannot overwrite the original execution-time statement.
      await recordStance(store, updated, { target: { messageId: summary.id, revision: 1 }, side: 'pro' });
      await tx.commit();
    });

    expect(await statesFor(store, [summary.id])).toEqual(before);
    expect((await store.message(original.id)).revision).toBe(2);
    expect((await store.message(original.id, 1)).parts[0]).toMatchObject({ relation: 'disagree' });
  });

  it('loads execution bases once per bounded batch rather than once per visible message', async () => {
    const { store, publish } = await fixture();
    const ids: string[] = [];
    for (let index = 0; index < 201; index++) ids.push((await publish([{ id: 'text', type: 'text', text: `消息 ${index}` }])).id);
    const prepare = vi.spyOn(store.db, 'prepare');
    expect(await statesFor(store, ids)).toHaveLength(201);
    expect(prepare.mock.calls.filter(([sql]) => /FROM execution_stances/.test(String(sql)))).toHaveLength(2);
  });
});
