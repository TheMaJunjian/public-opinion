import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindRoles, resolveStance, type Message, type Part, type Reference } from '@gonglun/core';
import { Mutation, Store } from './db.js';
import { initializeProjections, recordStance, statesFor } from './projections.js';

const stores: Store[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store(':memory:');
  initializeProjections(store);
  stores.push(store);
  function publish(parts: Part[], authorId = 'alice'): Message {
    return store.transaction(() => {
      const tx = new Mutation(store);
      const message = tx.create(authorId, parts);
      tx.commit();
      return store.message(message.id);
    });
  }
  function stance(target: Reference, side: 'pro' | 'con'): Message {
    return store.transaction(() => {
      const tx = new Mutation(store);
      const message = tx.create('alice', [{
        id: 'stance', type: 'relation', relation: side === 'pro' ? 'agree' : 'disagree',
        roles: bindRoles({ target: [target] }),
      }]);
      const resolved = resolveStance(target, side, (id, revision) => store.message(id, revision));
      recordStance(store, message, resolved);
      tx.commit();
      return store.message(message.id);
    });
  }
  const summary = publish([
    { id: 'content', type: 'text', text: '总结内容' },
    { id: 'organization', type: 'relation', relation: 'summary', roles: { members: [] } },
  ]);
  return { store, publish, stance, summary };
}

describe('authoritative organization display states', () => {
  it('keeps an effective opposition after more than 100 later references push it out of the context page', () => {
    const { store, publish, stance, summary } = fixture();
    const opposition = stance({ messageId: summary.id, revision: 1 }, 'con');
    for (let index = 0; index < 120; index++) publish([{
      id: 'reference', type: 'relation', relation: 'reference',
      roles: bindRoles({ target: [{ messageId: summary.id }] }),
    }], `reader-${index}`);
    const boundedReferences = store.db.prepare(`
      SELECT source.id FROM refs JOIN messages source ON source.id = refs.sourceId
      WHERE refs.targetId = ? ORDER BY source.sequence DESC LIMIT 100
    `).all(summary.id);
    expect(boundedReferences).toHaveLength(100);
    expect(boundedReferences.some(row => row.id === opposition.id)).toBe(false);
    expect(statesFor(store, [summary.id])).toEqual([expect.objectContaining({
      messageId: summary.id, suppressed: true, supportCount: 0, oppositionCount: 1,
    })]);
  });

  it('does not reinterpret a recorded historical stance when its referenced source is edited', () => {
    const { store, stance, summary } = fixture();
    const original = stance({ messageId: summary.id, revision: 1 }, 'con');
    stance({ messageId: original.id, revision: 1, partId: 'stance' }, 'con');
    const before = statesFor(store, [summary.id]);
    expect(before[0]).toMatchObject({ suppressed: false, supportCount: 1, oppositionCount: 0 });

    store.transaction(() => {
      const tx = new Mutation(store);
      const updated: Message = {
        ...original, revision: 2,
        parts: [{ id: 'stance', type: 'relation', relation: 'agree', roles: bindRoles({ target: [{ messageId: summary.id, revision: 1 }] }) }],
      };
      tx.put(updated);
      // Even an accidental replay cannot overwrite the original execution-time statement.
      recordStance(store, updated, { target: { messageId: summary.id, revision: 1 }, side: 'pro' });
      tx.commit();
    });

    expect(statesFor(store, [summary.id])).toEqual(before);
    expect(store.message(original.id).revision).toBe(2);
    expect(store.message(original.id, 1).parts[0]).toMatchObject({ relation: 'disagree' });
  });

  it('loads execution bases once per bounded batch rather than once per visible message', () => {
    const { store, publish } = fixture();
    const ids = Array.from({ length: 201 }, (_, index) => publish([{ id: 'text', type: 'text', text: `消息 ${index}` }]).id);
    const prepare = vi.spyOn(store.db, 'prepare');
    expect(statesFor(store, ids)).toHaveLength(201);
    expect(prepare.mock.calls.filter(([sql]) => /FROM execution_stances/.test(String(sql)))).toHaveLength(2);
  });
});
