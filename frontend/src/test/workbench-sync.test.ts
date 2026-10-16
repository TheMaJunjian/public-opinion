import { describe, expect, it, vi } from 'vitest';
import { WorkbenchStore, syncWorkbench, type WorkbenchSnapshot } from '../data/workbench';
import type { Message } from '../types';
import { queueCommand, runCommandBatch } from '../api/commandBatch';

const message = (id: string, revision = 1, content = id): Message => ({ id, revision, content, kind: 'TEXT', contentType: 'TEXT', createdAt: '', createdBy: { id: 'u', username: '用户', createdAt: '' } });
const page = (sequence: number, messages: Message[] = []): WorkbenchSnapshot => ({ sequence, messages, relations: [], users: [], stakes: {}, tagCounts: {}, attentionUsers: {}, scope: { messageId: null, title: '公论' } });

describe('authoritative workbench records', () => {
  it('shows generated JOIN records from the send response without waiting for SSE or a reload', async () => {
    const load = vi.fn(async (_query: { after?: number }) => page(10, [message('member')]));
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

  it('replays from the first page boundary so changes during pagination are not lost', async () => {
    const load = vi.fn(async ({ after, cursor }: { after?: number; cursor?: string }) => {
      if (after !== undefined) return page(12, [message('a', 2, '分页期间修改')]);
      if (cursor) return page(12, [message('b')]);
      return { ...page(10, [message('a')]), nextCursor: 'older' };
    });
    const source = { close: vi.fn(), onmessage: null, onopen: null, onerror: null } as unknown as EventSource;
    const updated = vi.fn();
    const sync = syncWorkbench({ parent: 'root', load, events: () => source, onSnapshot: updated, onError: error => { throw error; } });
    await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
    expect(load.mock.calls[2][0].after).toBe(10);
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
