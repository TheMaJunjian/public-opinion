import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULES, type Change, type Membership, type Message, type Page, type SendInput, type SendResult } from '@gonglun/core';
import { emptyStore, reducer, type Store } from './store';
import { Outbox, queryKey } from './api';

const message = (id: string, sequence: number, revision = 1): Message => ({ id, sequence, revision, authorId: 'alice', createdAt: '2026-10-14T01:00:00Z', updatedAt: '2026-10-14T01:00:00Z', regionId: 'main', ledgerId: 'main', programVersion: '2', ruleVersion: 1, spending: { protocol: 1, recommendation: 0, wager: 0 }, parts: [{ id: 'body', type: 'text', text: `${id} revision ${revision}` }] });
const change = (sequence: number, messages: Message[] = []): Change => ({ sequence, messages, memberships: [], removedMemberships: [], states: [], ledger: [], treasury: { operating: 0, issued: 0 } });
const page = (messages: Message[], sequence = 10): Page => ({ messages, users: [], memberships: [], states: [], sequence, nextCursor: null });
const root = queryKey({});
function initial(messages: Message[] = [message('first', 1)]): Store {
  let state = reducer(emptyStore, { type: 'begin', key: root, query: {}, generation: 1 });
  return reducer(state, { type: 'page', key: root, generation: 1, page: page(messages), append: false });
}
const membership: Membership = { memberId: 'first', parentId: 'group', sourceId: 'group', sourcePartId: 'grouping', bindingId: 'slot-a', sourceRevision: 1 };

describe('paged discussion store', () => {
  it('keeps nested messages in global search, author and relation feeds while preserving explicit organization scope', () => {
    const nested = { ...message('nested', 11), parts: [{ id: 'body', type: 'text' as const, text: '独特证据' }, { id: 'evidence', type: 'relation' as const, relation: 'evidence', roles: {} }] };
    const placement = { ...membership, memberId: nested.id };
    const queries = [{ q: '独特证据' }, { author: 'alice' }, { relation: 'evidence' }];
    for (const query of queries) {
      let state = initial();
      for (const scope of [{ ...query }, { ...query, personal: 'normal' }, { ...query, parent: 'group', personal: 'normal' }, { ...query, parent: 'other' }]) {
        const key = queryKey(scope);
        state = reducer(state, { type: 'begin', key, query: scope, generation: 2 });
      }
      state = reducer(state, { type: 'change', change: { ...change(11, [nested]), memberships: [placement] } });
      expect(state.feeds[queryKey(query)].ids).toContain(nested.id);
      expect(state.feeds[queryKey({ ...query, personal: 'normal' })].ids).toContain(nested.id);
      expect(state.feeds[queryKey({ ...query, parent: 'group', personal: 'normal' })].ids).toContain(nested.id);
      expect(state.feeds[queryKey({ ...query, parent: 'other' })].ids).not.toContain(nested.id);
      expect(state.feeds[root].ids).not.toContain(nested.id);
    }
  });

  it('ignores superseded requests and preserves the newest message revision', () => {
    let state = initial();
    state = reducer(state, { type: 'begin', key: root, query: {}, generation: 2 });
    state = reducer(state, { type: 'begin', key: root, query: {}, generation: 3 });
    const stale = reducer(state, { type: 'page', key: root, generation: 2, page: page([message('stale', 9)]), append: false });
    expect(stale).toBe(state);
    state = reducer(state, { type: 'change', change: change(11, [message('first', 11, 2)]) });
    state = reducer(state, { type: 'page', key: root, generation: 3, page: page([message('first', 1)]), append: false });
    expect(state.messages.first.revision).toBe(2);
  });
  it('keeps acknowledged messages visible without skipping changes from other users', () => {
    let state = initial();
    state = reducer(state, { type: 'ack', change: change(13, [message('mine', 13)]) });
    expect(state.sequence).toBe(10);
    state = reducer(state, { type: 'change', change: change(11, [message('other-one', 11)]) });
    state = reducer(state, { type: 'change', change: change(12, [message('other-two', 12)]) });
    state = reducer(state, { type: 'change', change: change(13, [message('mine', 13)]) });
    expect(state.sequence).toBe(13);
    expect(state.feeds[root].ids).toEqual(expect.arrayContaining(['mine', 'other-one', 'other-two']));
    expect(state.feeds[root].ids.filter(id => id === 'mine')).toHaveLength(1);
  });
  it('does not restore membership removed by a newer event when old HTTP arrives', () => {
    let state = initial();
    state = reducer(state, { type: 'change', change: { ...change(11), memberships: [membership] } });
    state = reducer(state, { type: 'begin', key: root, query: {}, generation: 2 });
    state = reducer(state, { type: 'ack', change: { ...change(13), removedMemberships: ['first'] } });
    state = reducer(state, { type: 'page', key: root, generation: 2, page: { ...page([message('first', 1)], 11), memberships: [membership] }, append: false });
    expect(state.memberships.first).toBeUndefined();
    state = reducer(state, { type: 'change', change: { ...change(12), memberships: [membership] } });
    expect(state.memberships.first).toBeUndefined();
  });
  it('deduplicates overlapping pages and does not discard an unlisted recent acknowledgement', () => {
    let state = initial();
    state = reducer(state, { type: 'ack', change: change(13, [message('mine', 13)]) });
    state = reducer(state, { type: 'begin', key: root, query: {}, generation: 2 });
    state = reducer(state, { type: 'page', key: root, generation: 2, page: page([message('first', 1)]), append: false });
    expect(state.feeds[root].ids).toContain('mine');
    state = reducer(state, { type: 'begin', key: root, query: {}, generation: 3 });
    state = reducer(state, { type: 'page', key: root, generation: 3, page: page([message('first', 1), message('second', 2)]), append: true });
    expect(state.feeds[root].ids.filter(id => id === 'first')).toHaveLength(1);
  });
  it('applies authoritative display changes even without a new message and ignores stale states', () => {
    let state = initial();
    const authoritative = { messageId: 'first', revision: 1, suppressed: true, supportCount: 8, oppositionCount: 1, recommendationTotal: 90 };
    state = reducer(state, { type: 'ack', change: { ...change(13), states: [authoritative] } });
    state = reducer(state, { type: 'change', change: { ...change(11), states: [{ ...authoritative, suppressed: false }] } });
    state = reducer(state, { type: 'context', page: { ...page([message('first', 1)], 12), states: [{ ...authoritative, suppressed: false }] } });
    expect(state.states.first).toEqual(authoritative);
    expect(state.sequence).toBe(11);
  });
  it('bounds feed caching while keeping the visible discussion', () => {
    let state = reducer(initial(), { type: 'focus', key: root });
    for (let index = 0; index < 20; index++) state = reducer(state, { type: 'begin', key: `child-${index}`, query: { parent: `child-${index}` }, generation: index + 2 });
    expect(Object.keys(state.feeds)).toHaveLength(8);
    expect(state.feeds[root]).toBeDefined();
  });
  it('updates personal filters from authoritative state without loading old action messages and rejects stale or other-account responses', () => {
    let state = reducer(initial(), { type: 'viewer', id: 'alice' });
    const query = { personal: 'follow', viewer: 'alice' }; const key = queryKey(query);
    state = reducer(state, { type: 'begin', key, query, generation: 2 });
    state = reducer(state, { type: 'page', key, generation: 2, page: page([], 10), append: false });
    const marked = (sequence: number, followed: boolean) => ({ ...page([message('old-target', 1)], sequence), personalStates: [{ messageId: 'old-target', followed, read: false, blocked: false, archived: false }] });
    state = reducer(state, { type: 'personal', viewer: 'alice', page: marked(12, true) });
    expect(state.feeds[key].ids).toEqual(['old-target']);
    state = reducer(state, { type: 'personal', viewer: 'alice', page: marked(13, false) });
    state = reducer(state, { type: 'personal', viewer: 'alice', page: marked(12, true) });
    expect(state.feeds[key].ids).toEqual([]);
    expect(state.personalStates['old-target'].followed).toBe(false);
    state = reducer(state, { type: 'viewer', id: 'bob' });
    const switched = reducer(state, { type: 'personal', viewer: 'alice', page: marked(14, true) });
    expect(switched).toBe(state);
    expect(switched.personalStates).toEqual({});
  });
});

describe('idempotent outbox', () => {
  it('coalesces concurrent clicks and keeps the same request on retry', async () => {
    const input: SendInput = { requestId: 'same-request', parts: [{ id: 'text', type: 'text', text: 'hello' }] };
    let reject!: (error: Error) => void;
    const first = new Promise<SendResult>((_, rejecter) => { reject = rejecter; });
    const result = { message: message('created', 11), change: change(11), account: { available: 10, locked: 0, earned: 10, spent: 0 } };
    const transport = vi.fn().mockReturnValueOnce(first).mockResolvedValue(result);
    const outbox = new Outbox(input, transport);
    const pending = outbox.send();
    expect(outbox.send()).toBe(pending);
    expect(transport).toHaveBeenCalledTimes(1);
    reject(new Error('response lost'));
    await expect(pending).rejects.toThrow('response lost');
    await expect(outbox.send()).resolves.toEqual(result);
    expect(transport.mock.calls[1][0]).toBe(input);
  });
});
