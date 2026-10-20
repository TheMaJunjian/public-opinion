import { afterEach, expect, it, vi } from 'vitest';
import { encodeWorkbenchSnapshot } from '@gonglun/core';
import { getWorkbenchSnapshot } from '../api/client';
import { syncWorkbench, type WorkbenchSnapshot } from '../data/workbench';

afterEach(() => vi.unstubAllGlobals());

it('sends bounded window queries and loaded IDs without fetching or signing a write session', async () => {
  const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify(page(10, 'target'))));
  vi.stubGlobal('fetch', fetcher);
  const query = { parent: 'root', mode: 'window' as const, limit: 50, after: 9, knownIds: ['target'], regionId: 'region' };
  await getWorkbenchSnapshot(query);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toContain('/snapshot/query?format=compact-v1');
  expect(fetcher.mock.calls[0][1]?.method).toBe('POST');
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(query);
});

const message = (id: string) => ({ id, kind: 'RELATION', relationType: 'JOIN', contentType: 'TEXT' as const, content: id, createdAt: '', createdBy: { id: 'u', username: '旧用户', createdAt: '' }, sourceMessageId: 'group', targetRefs: [{ kind: 'message' as const, messageId: 'member' }] });
const page = (sequence: number, id: string): WorkbenchSnapshot => {
  const record = message(id);
  return { scope: { messageId: null, title: '公论' }, messages: [record], relations: [record], users: [record.createdBy], stakes: {}, tagCounts: {}, attentionUsers: {}, sequence };
};

it('requests bounded batches and restores compact relations for initial, continuation and delta reads', async () => {
  const value = page(10, 'join');
  const fetcher = vi.fn(async () => new Response(JSON.stringify(encodeWorkbenchSnapshot(value))));
  vi.stubGlobal('fetch', fetcher);
  for (const query of [{ parent: 'root' }, { parent: 'root', cursor: 'older' }, { parent: 'root', after: 10, regionId: 'region' }]) {
    const controller = new AbortController();
    expect(await getWorkbenchSnapshot({ ...query, signal: controller.signal })).toEqual(value);
    const [url, options] = fetcher.mock.lastCall! as unknown as [string, RequestInit];
    const params = new URL(url, 'http://localhost').searchParams;
    expect(params.get('format')).toBe('compact-v1');
    expect(params.get('batch')).toBe('after' in query ? null : '4');
    expect(params.get('regionId')).toBe('regionId' in query ? query.regionId : null);
    expect(options.signal).toBe(controller.signal);
  }
});

it('publishes the first page and requests the continuation only when the user asks for more', async () => {
  const first = { ...page(10, 'first-join'), nextCursor: 'older' };
  const last = page(12, 'older-join');
  const delta = { ...page(13, 'new-join'), removedMessageIds: ['first-join'] };
  let finish!: () => void;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    const query = options?.body ? JSON.parse(String(options.body)) : Object.fromEntries(new URL(url, 'http://localhost').searchParams);
    if (query.cursor) {
      await new Promise<void>(resolve => { finish = resolve; });
      return new Response(JSON.stringify(encodeWorkbenchSnapshot(last)));
    }
    return new Response(JSON.stringify(encodeWorkbenchSnapshot(query.after !== undefined ? delta : first)));
  });
  vi.stubGlobal('fetch', fetcher);
  const updated = vi.fn(), events = { close: vi.fn() } as unknown as EventSource;
  const sync = syncWorkbench({ parent: 'root', load: getWorkbenchSnapshot, events: () => events, onSnapshot: updated, onError: error => { throw error; } });
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(updated).toHaveBeenCalledOnce();
    const more = sync.loadMore();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    finish();
    await more;
    expect(JSON.parse(String(fetcher.mock.calls[1][1]!.body)).after).toBe(10);
    const result = updated.mock.lastCall![0] as WorkbenchSnapshot;
    expect(result.messages.map(row => row.id)).toEqual(['new-join', 'older-join']);
    expect(result.relations.map(row => row.id)).toEqual(['new-join', 'older-join']);
  } finally { sync.stop(); }
});

it('still reads full snapshots from a server without compact transport support', async () => {
  const value = page(10, 'old-server');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(value))));
  expect(await getWorkbenchSnapshot({ parent: 'root' })).toEqual(value);
});
