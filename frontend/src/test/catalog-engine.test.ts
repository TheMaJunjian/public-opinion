import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { createCatalogEngine, type CatalogData } from '../data/catalogEngine';
import type { Message, Relation, User } from '../types';
import type { WorkbenchSnapshot } from '@gonglun/core';

afterEach(() => { vi.unstubAllGlobals(); });

it('uses closed-container members, marks, rounds, references and stakes in global calculations, retaining the previous complete result during updates', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const alice: User = { id: 'alice', username: '甲', createdAt: '' }, bob: User = { id: 'bob', username: '乙', createdAt: '' };
  const message = (id: string, author = alice): Message => ({ id, revision: 1, kind: 'TEXT', contentType: 'TEXT', content: id, createdAt: '', createdBy: author });
  const relation = (id: string, relationType: string, sourceMessageId: string | null): Relation => ({ id, relationType, sourceMessageId,
    targetRefs: [{ kind: 'message', messageId: 'closed-member' }], createdBy: alice, createdAt: '2026-10-20T00:00:00Z' });
  const relations = [relation('closed-container', 'CLASSIFY', null), relation('ref', 'REFERENCE', 'first'),
    relation('agree', 'AGREE', 'first'), relation('read', 'READ', null)];
  const records: Message[] = [message('closed-member', bob), ...relations.map(r => ({ ...message(r.id), kind: 'RELATION', relationType: r.relationType,
    relSourceId: r.sourceMessageId, targetRefs: r.targetRefs })),
    { ...message('round'), kind: 'ROUND', targetRefs: [{ kind: 'message', messageId: 'closed-member' }] }];
  const page = (sequence: number, messages: Message[] = []): WorkbenchSnapshot => ({ regionId: 'region', sequence, scope: { messageId: null, title: '公论' },
    messages, relations: [], users: [alice, bob], stakes: {}, tagCounts: {}, attentionUsers: {} });
  let updating = false, finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const query = new URL(url).searchParams;
    const after = query.get('after');
    if (updating && after === '12') return new Response(JSON.stringify({ ...page(13), tagCounts: { 'closed-member': {} }, hasMore: true }));
    if (updating && after === '13') return new Promise<Response>(resolve => { finish = resolve; });
    if (after) return new Response(JSON.stringify(page(12)));
    if (!query.get('cursor')) return new Response(JSON.stringify({ ...page(10, [message('first')]), nextCursor: 'closed' }));
    return new Response(JSON.stringify({ ...page(11, records), relations, tagCounts: { 'closed-member': { RECOMMEND: 3 } },
      stakes: { 'closed-member': { messageId: 'closed-member', pool: { lockedPro: 8, lockedCon: 2 }, stakes: [], counts: { pro: 8, con: 2 } } } }));
  }));
  const ready = vi.fn<(data: CatalogData) => void>();
  const engine = createCatalogEngine({ parent: 'root', key: 'engine-test', baseUrl: 'https://example.invalid/api', deviceId: 'device' },
    { idle: async () => {}, onReady: ready, onProgress: vi.fn() });
  const query = { rules: [
    { id: 'sender', kind: 'sender' as const, username: bob.username },
    { id: 'stake', kind: 'stake' as const, minAmount: 10 },
    { id: 'round', kind: 'rounds' as const, minRounds: 1 },
    { id: 'participants', kind: 'participants' as const, minCount: 1 },
    { id: 'tag', kind: 'tag' as const, tagType: 'RECOMMEND', minCount: 3 },
  ], home: 'read-related' as const, user: alice };
  try {
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(engine.filters(query).clean?.visibleTextIds).toEqual(new Set(['closed-member']));
    expect(engine.filters(query).home?.matchIds.has('closed-member')).toBe(true);
    const rows = ready.mock.lastCall![0].rows;
    expect(rows.userRows.find(row => row.userId === bob.id)).toMatchObject({ messageCount: 1, receivedTruthStake: 10, netSupportRate: 60, referenceHeat: 1 });
    expect(rows.messageRows.find(row => row.messageId === 'closed-member')).toMatchObject({ truthStake: 10, referenceHeat: 1, settlementActivity: 1 });
    updating = true; engine.catchUp();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(ready).toHaveBeenCalledOnce();
    expect(engine.filters(query).clean?.visibleTextIds).toEqual(new Set(['closed-member']));
    finish(new Response(JSON.stringify(page(14))));
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2));
    expect(engine.filters(query).clean?.visibleTextIds.size).toBe(0);
  } finally { engine.stop(); }
});
