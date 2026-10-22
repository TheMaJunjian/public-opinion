import { describe, expect, it, vi } from 'vitest';
import { WorkbenchStore, syncWorkbench, type WorkbenchSnapshot } from '../data/workbench';
import type { Message } from '../types';
import { queueCommand, runCommandBatch } from '../api/commandBatch';
import { computeCorrectionVersions, computeEffectiveSuppressedRelIds, convertMessagesToDemoModel } from '../utils/modelBridge';
import type { Relation } from '../types';

const message = (id: string, revision = 1, content = id): Message => ({ id, revision, content, kind: 'TEXT', contentType: 'TEXT', createdAt: '', createdBy: { id: 'u', username: '用户', createdAt: '' } });
const page = (sequence: number, messages: Message[] = []): WorkbenchSnapshot => ({ sequence, messages, relations: [], users: [], stakes: {}, tagCounts: {}, attentionUsers: {}, scope: { messageId: null, title: '公论' } });

describe('authoritative workbench records', () => {
  it('updates two connected viewers on incoming corrections and applies personal choices over public statistics', async () => {
    const original: Message = { ...message('original', 1, '原文'), parts: [{ id: 'body', type: 'text', text: '原文' }] };
    const correction: Relation = { id: 'correction', revision: 1, relationType: 'CORRECT', sourceMessageId: null,
      targetRefs: [{ kind: 'message', messageId: original.id }], createdAt: '2026-01-02', createdBy: { id: 'editor', username: 'editor', createdAt: '' },
      payload: { correctionBeforeContent: '原文', correctionAfterContent: '更正正文', correctionContent: '更正正文' },
      parts: [{ id: 'corrected-body', type: 'text', text: '更正正文' }, { id: 'relation', type: 'relation', relation: 'correct', roles: {} }] };
    const opposition: Relation = { id: 'against', relationType: 'DISAGREE', sourceMessageId: null,
      targetRefs: [{ kind: 'relation', relationId: correction.id }], createdAt: '2026-01-03', createdBy: { id: 'alice', username: 'alice', createdAt: '' } };
    const approval: Relation = { ...opposition, id: 'for', relationType: 'AGREE', createdAt: '2026-01-04', createdBy: { id: 'bob', username: 'bob', createdAt: '' } };
    let stage = 0;
    const state = () => ({ messageId: correction.id, revision: 1, supportCount: stage === 3 ? 1 : 0,
      oppositionCount: stage >= 2 ? 1 : 0, recommendationTotal: 0, suppressed: stage === 2 });
    const load = vi.fn(async ({ after }: { after?: number }) => {
      if (after === undefined) return page(1, [original]);
      if (!stage || after === stage + 1) return page(stage + 1);
      const relations = [{ ...correction, state: state() }, ...(stage >= 2 ? [opposition] : []), ...(stage === 3 ? [approval] : [])];
      const messages = relations.map(record => ({ ...message(record.id), kind: 'RELATION', revision: 1,
        relationType: record.relationType, createdAt: record.createdAt, createdBy: record.createdBy,
        parts: record.parts, relationPayload: record.payload, state: record.state }));
      return { ...page(stage + 1, messages), relations };
    });
    const connections: EventSource[] = [], visible = new Map<string, string>(), snapshots = new Map<string, WorkbenchSnapshot>();
    const viewers = ['alice', 'bob'].map(username => syncWorkbench({ parent: 'root', load,
      events: () => { const event = { close() {} } as EventSource; connections.push(event); return event; },
      onError: error => { throw error; }, onSnapshot(snapshot) {
        snapshots.set(username, snapshot);
        const model = convertMessagesToDemoModel(snapshot.messages, snapshot.relations);
        const rejected = computeEffectiveSuppressedRelIds(model.edges, model.messages, username);
        const current = computeCorrectionVersions(model.messages, model.edges, rejected, username).get(original.id)?.current;
        visible.set(username, current?.content ?? '原文');
      } }));
    const incoming = () => connections.forEach(connection => connection.onmessage?.({ data: JSON.stringify({ sequence: stage + 1 }) } as MessageEvent));
    try {
      await vi.waitFor(() => expect(connections).toHaveLength(2));
      stage = 1; incoming();
      await vi.waitFor(() => expect([...visible.values()]).toEqual(['更正正文', '更正正文']));
      stage = 2; incoming();
      await vi.waitFor(() => expect([...visible.values()]).toEqual(['原文', '原文']));
      stage = 3; incoming();
      await vi.waitFor(() => expect([...visible.values()]).toEqual(['原文', '更正正文']));
      expect(snapshots.get('alice')!.relations.some(record => record.id === correction.id)).toBe(true);
      expect(load.mock.calls.filter(([query]) => query.after === undefined)).toHaveLength(2);
    } finally { viewers.forEach(viewer => viewer.stop()); }
  });

  it('manual refresh reuses the incremental cursor and connection, skips unchanged projections, and waits for every delta page', async () => {
    let changes = false;
    const load = vi.fn(async ({ after }: { after?: number }) => after === undefined ? page(10, [message('old')])
      : !changes ? page(10) : after === 10 ? { ...page(11, [message('new')]), hasMore: true } : page(12, [message('last')]));
    const updated = vi.fn();
    const events = vi.fn(() => ({ close() {} }) as EventSource);
    const sync = syncWorkbench({ parent: 'root', load, events, onSnapshot: updated, onError: vi.fn() });
    try {
      await vi.waitFor(() => expect(updated).toHaveBeenCalledOnce());
      await expect(sync.refresh()).resolves.toBe(false);
      expect(load.mock.calls.at(-1)?.[0]).toMatchObject({ after: 10 });
      expect(updated).toHaveBeenCalledOnce();
      changes = true;
      await expect(sync.refresh()).resolves.toBe(true);
      expect(load.mock.calls.slice(-2).map(([query]) => query.after)).toEqual([10, 11]);
      expect(updated).toHaveBeenCalledTimes(2);
      expect(updated.mock.lastCall?.[0].messages.map((record: Message) => record.id)).toEqual(['old', 'new', 'last']);
      expect(load.mock.calls.filter(([query]) => query.after === undefined)).toHaveLength(1);
      expect(events).toHaveBeenCalledOnce();
    } finally { sync.stop(); }
  });

  it('manual refresh requested during synchronization waits for its own incremental check', async () => {
    const load = vi.fn<(query: { after?: number }) => Promise<WorkbenchSnapshot>>(async () => page(10));
    const events = vi.fn(() => ({ close() {} }) as EventSource);
    const sync = syncWorkbench({ parent: 'root', load, events, onSnapshot: vi.fn(), onError: vi.fn() });
    try {
      await vi.waitFor(() => expect(events).toHaveBeenCalledOnce());
      let finish!: (snapshot: WorkbenchSnapshot) => void;
      load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      sync.catchUp();
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
      const refreshed = sync.refresh();
      load.mockResolvedValue(page(11));
      finish(page(11, [message('incoming')]));
      await expect(refreshed).resolves.toBe(false);
      expect(load).toHaveBeenCalledTimes(4);
      expect(load.mock.calls.at(-1)?.[0]).toMatchObject({ after: 11 });
    } finally { sync.stop(); }
  });

  it('manual refresh reports request failures and releases pending refreshes when stopped', async () => {
    const load = vi.fn<(query: { after?: number }) => Promise<WorkbenchSnapshot>>(async () => page(10));
    const events = vi.fn(() => ({ close() {} }) as EventSource);
    const onError = vi.fn();
    const sync = syncWorkbench({ parent: 'root', load, events, onSnapshot: vi.fn(), onError });
    await vi.waitFor(() => expect(events).toHaveBeenCalledOnce());
    load.mockRejectedValueOnce(new Error('离线'));
    await expect(sync.refresh()).rejects.toThrow('离线');
    expect(onError).toHaveBeenCalledOnce();
    const pending = sync.refresh();
    sync.stop();
    await expect(pending).rejects.toThrow('同步已停止');
  });

  it('versions metadata with its message and removes every cached projection when it leaves scope', () => {
    const store=new WorkbenchStore();
    const current={...page(10,[message('a',2)]),tagCounts:{a:{new:2}},attentionUsers:{a:['u']}};
    store.apply(current);
    store.apply({...page(5,[message('a')]),tagCounts:{a:{old:1}},attentionUsers:{a:[]}});
    expect(store.snapshot().tagCounts.a).toEqual({new:2});
    expect(store.snapshot().attentionUsers.a).toEqual(['u']);
    store.apply({...page(11),removedMessageIds:['a']});
    expect(store.snapshot().tagCounts.a).toBeUndefined();
    expect(store.snapshot().attentionUsers.a).toBeUndefined();
    store.apply({...page(5,[message('a')]),tagCounts:{a:{old:1}}});
    expect(store.snapshot().tagCounts.a).toBeUndefined();
  });
  it('reports the network synchronization window separately from graph drawing', async () => {
    let resolveFirst!: (snapshot: WorkbenchSnapshot) => void;
    const load = vi.fn(({ after }: { after?: number }) => after === undefined
      ? new Promise<WorkbenchSnapshot>(resolve => { resolveFirst = resolve; })
      : Promise.resolve(page(1)));
    const onSyncState = vi.fn();
    const sync = syncWorkbench({ parent: 'root', load, events: () => ({ close() {} }) as EventSource,
      onSnapshot: vi.fn(), onError: error => { throw error; }, onSyncState });
    expect(onSyncState).toHaveBeenCalledWith(true);
    expect(onSyncState).not.toHaveBeenCalledWith(false);
    resolveFirst(page(1, [message('a')]));
    await vi.waitFor(() => expect(onSyncState).toHaveBeenLastCalledWith(false));
    sync.stop();
  });

  it('shows generated JOIN records from the send response without waiting for SSE or a reload', async () => {
    const load = vi.fn<(query: { after?: number }) => Promise<WorkbenchSnapshot>>(async () => page(10, [message('member')]));
    const source = { close: vi.fn() } as unknown as EventSource;
    const updated = vi.fn();
    const sync = syncWorkbench({ parent: 'root', load, events: () => source, onSnapshot: updated, onError: error => { throw error; } });
    await vi.waitFor(() => expect(updated).toHaveBeenCalledOnce());
    const classification = { ...message('container'), kind: 'RELATION' as const, relationType: 'CLASSIFY' };
    const join = { ...message('join'), kind: 'RELATION' as const, relationType: 'JOIN', sourceMessageId: classification.id, targetRefs: [{ kind: 'message' as const, messageId: 'member' }] };
    const committed = { ...page(12, [classification, join]), relations: [classification, join] } as WorkbenchSnapshot;
    const listener = (event: Event) => (event as CustomEvent<WorkbenchSnapshot[]>).detail.forEach(snapshot => sync.applyCommitted(snapshot));
    window.addEventListener('gonglun:committed', listener);
    const reload = vi.fn();
    window.addEventListener('gonglun:reload', reload);
    try {
      await runCommandBatch(async () => {
        queueCommand('/relations', { method: 'POST', body: JSON.stringify({ relationType: 'CLASSIFY' }) });
      }, async () => ({ snapshots: [committed] }));
      expect(load).toHaveBeenCalledTimes(2); // Only the initial snapshot and catch-up request.
      expect(reload).not.toHaveBeenCalled();
      const latest = updated.mock.lastCall?.[0] as WorkbenchSnapshot;
      expect(latest.messages.map(message => message.id)).toEqual(['member', 'container', 'join']);
      expect(latest.relations.filter(relation => relation.relationType === 'JOIN' && relation.sourceMessageId === 'container')).toHaveLength(1);
      // The normal reader must still catch up from 10, not skip other commits to 12.
      load.mockImplementation(async () => page(12, [message('other')]));
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
      expect(load.mock.calls[2][0]).toMatchObject({ after: 10 });
      expect(updated.mock.lastCall?.[0].messages.map((message: Message) => message.id)).toContain('other');
    } finally {
      window.removeEventListener('gonglun:committed', listener);
      window.removeEventListener('gonglun:reload', reload);
      sync.stop();
    }
  });

  it('keeps acknowledged joins when an older reload finishes after the send, and ignores another scope', async () => {
    let finish!: (snapshot: WorkbenchSnapshot) => void;
    const load = vi.fn(({ after }: { after?: number }) => after === undefined
      ? new Promise<WorkbenchSnapshot>(resolve => { finish = resolve; })
      : Promise.resolve(page(11)));
    const updated = vi.fn();
    const sync = syncWorkbench({ parent: 'root', load, events: () => ({ close() {} }) as EventSource, onSnapshot: updated, onError: error => { throw error; } });
    expect(sync.applyCommitted({ ...page(11, [message('outside')]), scope: { messageId: 'other', title: '其他分类' } })).toBe(false);
    sync.applyCommitted(page(11, [message('join')]));
    expect(updated.mock.lastCall?.[0].messages.map((message: Message) => message.id)).toEqual(['join']);
    finish(page(10, [message('old')]));
    await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(2));
    expect(updated.mock.lastCall?.[0].messages.map((message: Message) => message.id)).toEqual(['old', 'join']);
    sync.stop();
  });

  it('keeps the newer revision when a late page arrives and removes moved records', () => {
    const store = new WorkbenchStore();
    store.apply(page(5, [message('a', 2, '已修改')]));
    store.apply(page(2, [message('a', 1, '旧内容'), message('b')]));
    expect(store.snapshot().messages.find(m => m.id === 'a')?.content).toBe('已修改');
    store.apply({ ...page(6), removedMessageIds: ['b'] });
    store.apply(page(3, [message('b')]));
    expect(store.snapshot().messages.map(m => m.id)).toEqual(['a']);
  });

  it('loads one page initially and catches up across changes while an explicit next page is loaded', async () => {
    const load = vi.fn(async ({ after, cursor }: { after?: number; cursor?: string }) => {
      if (after !== undefined) return page(12, [message('a', 2, '分页期间修改')]);
      if (cursor) return page(12, [message('b')]);
      return { ...page(10, [message('a')]), nextCursor: 'older' };
    });
    const source = { close: vi.fn(), onmessage: null, onopen: null, onerror: null } as unknown as EventSource;
    const updated = vi.fn();
    const sync = syncWorkbench({ parent: 'root', load, events: () => source, onSnapshot: updated, onError: error => { throw error; } });
    await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
    expect(load.mock.calls).toHaveLength(2);
    expect(load.mock.calls[1][0].after).toBe(10);
    expect(updated.mock.lastCall?.[0].messages.map((m: Message) => m.id)).toEqual(['a']);
    await sync.loadMore();
    expect(load.mock.calls[2][0]).toMatchObject({ cursor: 'older' });
    expect(updated.mock.lastCall?.[0].messages.map((m: Message) => m.content)).toEqual(['分页期间修改', 'b']);
    sync.stop();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('coalesces a burst of events into a single delta request', async () => {
    const load = vi.fn(async () => page(10, [message('a')]));
    const source = { close: vi.fn(), onmessage: null, onopen: null, onerror: null } as unknown as EventSource;
    const events = vi.fn(() => source);
    const sync = syncWorkbench({ parent: 'root', load, events, onSnapshot: () => {}, onError: error => { throw error; } });
    await vi.waitFor(() => expect(events).toHaveBeenCalledOnce());
    load.mockResolvedValue(page(30, [message('b')]));
    for (let sequence = 11; sequence <= 30; sequence++) source.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ sequence }) }));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    sync.stop();
  });

  it('checks for missed messages after a tab resumes without replacing its current view', async () => {
    const load = vi.fn(async ({ after }: { after?: number }) => after === 10
      ? page(11, [message('new')])
      : after === 11 ? page(11) : page(10, [message('old')]));
    const updated = vi.fn();
    const sync = syncWorkbench({ parent: 'root', load, events: () => ({ close() {} }) as EventSource,
      onSnapshot: updated, onError: error => { throw error; } });
    await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
    sync.catchUp();
    await vi.waitFor(() => expect(updated.mock.lastCall?.[0].messages.map((item: Message) => item.id)).toEqual(['old', 'new']));
    expect(load.mock.calls.at(-1)?.[0]).toMatchObject({ after: 10 });
    sync.stop();
  });
});

it('does not redraw an unchanged graph when the event stream reconnects',async()=>{
  const load=vi.fn(async()=>page(10,[message('a')]));
  const source={close:vi.fn(),onmessage:null,onopen:null,onerror:null} as unknown as EventSource,updated=vi.fn();
  const sync=syncWorkbench({parent:'root',load,events:()=>source,onSnapshot:updated,onError:error=>{throw error;}});
  await vi.waitFor(()=>expect(updated).toHaveBeenCalledTimes(1));
  load.mockResolvedValue(page(10));source.onopen?.(new Event('open'));
  await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(3));
  expect(updated).toHaveBeenCalledTimes(1);sync.stop();
});
