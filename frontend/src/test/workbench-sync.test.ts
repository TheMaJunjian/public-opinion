import { describe, expect, it, vi } from 'vitest';
import { WorkbenchStore, syncWorkbench, type WorkbenchSnapshot } from '../data/workbench';
import type { Message } from '../types';

const message = (id: string, revision = 1, content = id): Message => ({ id, revision, content, kind: 'TEXT', contentType: 'TEXT', createdAt: '', createdBy: { id: 'u', username: '用户', createdAt: '' } });
const page = (sequence: number, messages: Message[] = []): WorkbenchSnapshot => ({ sequence, messages, relations: [], users: [], stakes: {}, tagCounts: {}, attentionUsers: {}, scope: { messageId: null, title: '公论' } });

describe('authoritative workbench records', () => {
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
    await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(3));
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
