import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWorkbenchCache } from '../data/workbenchCache';
import { syncWorkbench, type SnapshotQuery, type WorkbenchSnapshot } from '../data/workbench';

const message = (id: string, revision = 1) => ({ id, revision, kind: 'TEXT', contentType: 'TEXT' as const, content: `${id}-${revision}`, createdAt: '', createdBy: { id: 'u', username: '用户', createdAt: '' } });
const page = (sequence: number, ids: string[] = []): WorkbenchSnapshot => ({ regionId: 'region', scope: { messageId: null, title: '公论' }, sequence,
  messages: ids.map(id => message(id)), relations: [], users: [message('a').createdBy], stakes: {}, tagCounts: {}, attentionUsers: {} });
const running: ReturnType<typeof syncWorkbench>[] = [];
const start = (options: Parameters<typeof syncWorkbench>[0]) => {
  const sync = syncWorkbench(options); running.push(sync); return sync;
};
const events = () => ({ close: vi.fn() }) as unknown as EventSource;

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(() => { running.splice(0).forEach(sync => sync.stop()); vi.unstubAllGlobals(); });

it('restores every record after a browser reload and fetches only paged changes, including edits and removals', async () => {
  const cache = createWorkbenchCache('u', 'root');
  const original = { ...page(10, ['old', 'moved']), tagCounts: { old: { 标签: 2 } }, attentionUsers: { old: ['u'] } };
  const firstLoad = vi.fn(async (_query: SnapshotQuery) => original);
  const initial = start({ parent: 'root', cache, load: firstLoad, events, onSnapshot: vi.fn(), onError: vi.fn() });
  await vi.waitFor(async () => expect((await cache.load())?.sequence).toBe(10));
  initial.stop();

  // A new cache and synchronizer stand in for the fresh JS context after F5.
  const reloadedCache = createWorkbenchCache('u', 'root');
  const updated = vi.fn(), onError = vi.fn();
  const load = vi.fn(async ({ after }: SnapshotQuery) => after === 10
    ? { ...page(11), messages: [message('old', 2)], attentionUsers: { old: [] }, removedMessageIds: ['moved'], hasMore: true }
    : page(12, ['new']));
  start({ parent: 'root', cache: reloadedCache, load, events, onSnapshot: updated, onError });
  await vi.waitFor(async () => expect((await reloadedCache.load())?.sequence).toBe(12));
  expect(load.mock.calls.map(([query]) => [query.after, query.regionId, query.cursor])).toEqual([[10, 'region', undefined], [11, 'region', undefined]]);
  expect(updated).toHaveBeenCalledOnce();
  const snapshot = updated.mock.lastCall![0] as WorkbenchSnapshot;
  expect(snapshot.messages.map(record => record.content)).toEqual(['old-2', 'new-1']);
  expect(snapshot.tagCounts.old).toEqual({ 标签: 2 });
  expect(snapshot.attentionUsers.old).toEqual([]);
  expect(onError).not.toHaveBeenCalled();
});

it('keeps unchanged refreshes incremental and still publishes the restored complete graph once', async () => {
  const cache = createWorkbenchCache('u', 'root');
  await cache.save(page(10, ['old']));
  const updated = vi.fn(), load = vi.fn(async (_query: SnapshotQuery) => page(10));
  const sync = start({ parent: 'root', cache, load, events, onSnapshot: updated, onError: vi.fn() });
  await vi.waitFor(() => expect(updated).toHaveBeenCalledOnce());
  await expect(sync.refresh()).resolves.toBe(false);
  expect(load.mock.calls.every(([query]) => query.after === 10)).toBe(true);
  expect(updated.mock.lastCall![0].messages.map((record: { id: string }) => record.id)).toEqual(['old']);
  expect(updated).toHaveBeenCalledOnce();
});

it('isolates caches by account, scope and API and never regresses a newer snapshot from another tab', async () => {
  const cache = createWorkbenchCache('u', 'root');
  await cache.save(page(12, ['latest']));
  await createWorkbenchCache('u', 'root').save(page(10, ['stale']));
  expect((await cache.load())?.messages[0].id).toBe('latest');
  expect(await createWorkbenchCache('other-user', 'root').load()).toBeNull();
  expect(await createWorkbenchCache('u', 'group').load()).toBeNull();
  expect(await createWorkbenchCache('u', 'root', '/other-api').load()).toBeNull();
  await cache.clear();
  expect(await cache.load()).toBeNull();
});

it('caches a loaded page with its continuation and does not cache an unfinished next page', async () => {
  const cache = createWorkbenchCache('u', 'root');
  let finish!: (snapshot: WorkbenchSnapshot) => void;
  const load = vi.fn(({ cursor, after }: SnapshotQuery) => cursor
    ? new Promise<WorkbenchSnapshot>(resolve => { finish = resolve; })
    : Promise.resolve(after !== undefined ? page(10) : { ...page(10, ['first']), nextCursor: 'older' }));
  const updated = vi.fn();
  const sync = start({ parent: 'root', cache, load, events, onSnapshot: updated, onError: vi.fn() });
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await vi.waitFor(async () => expect((await cache.load())?.nextCursor).toBe('older'));
  const more = sync.loadMore();
  const rejected = expect(more).rejects.toThrow('同步已停止');
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  sync.stop(); finish(page(10, ['last']));
  await rejected;
  expect(updated).toHaveBeenCalledOnce();
  expect((await cache.load())?.messages.map(message => message.id)).toEqual(['first']);
});

it('retries a transient network failure from the cache cursor without restarting a full download', async () => {
  const cache = createWorkbenchCache('u', 'root');
  await cache.save(page(10, ['old']));
  const load = vi.fn(async (_query: SnapshotQuery) => page(11, ['new']));
  load.mockRejectedValueOnce(new Error('离线'));
  const updated = vi.fn(), onError = vi.fn();
  const sync = start({ parent: 'root', cache, load, events, onSnapshot: updated, onError });
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  await expect(sync.refresh()).resolves.toBe(true);
  expect(load.mock.calls.map(([query]) => query.after)).toEqual([10, 10]);
  expect(updated.mock.lastCall![0].messages.map((record: { id: string }) => record.id)).toEqual(['old', 'new']);
});

it('rebuilds an invalid cache when the server rejects its source or cursor', async () => {
  const cache = createWorkbenchCache('u', 'root');
  await cache.save(page(50, ['obsolete']));
  const load = vi.fn(async ({ after }: SnapshotQuery) => after === undefined ? { ...page(2, ['fresh']), regionId: 'new-region' } : { ...page(2), regionId: 'new-region' });
  load.mockRejectedValueOnce(Object.assign(new Error('缓存已失效'), { status: 409 }));
  const updated = vi.fn(), onError = vi.fn();
  start({ parent: 'root', cache, load, events, onSnapshot: updated, onError });
  await vi.waitFor(async () => expect((await cache.load())?.sequence).toBe(2));
  expect(load.mock.calls.map(([query]) => query.after)).toEqual([50, undefined, 2]);
  expect(updated.mock.lastCall![0].messages.map((record: { id: string }) => record.id)).toEqual(['fresh']);
  expect(onError).not.toHaveBeenCalled();
});

it('never stores the higher command-response cursor before replaying unrelated changes', async () => {
  const cache = createWorkbenchCache('u', 'root');
  await cache.save(page(10, ['old']));
  let finish!: (snapshot: WorkbenchSnapshot) => void;
  const load = vi.fn((_query: SnapshotQuery) => new Promise<WorkbenchSnapshot>(resolve => { finish = resolve; }));
  const sync = start({ parent: 'root', cache, load, events, onSnapshot: vi.fn(), onError: vi.fn() });
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  sync.applyCommitted(page(12, ['acknowledged']));
  expect((await cache.load())?.sequence).toBe(10);
  finish(page(11, ['unrelated']));
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(load.mock.calls[1][0].after).toBe(11);
  expect((await cache.load())?.sequence).toBe(10);
  finish(page(12, ['acknowledged']));
  await vi.waitFor(async () => expect((await cache.load())?.sequence).toBe(12));
  expect((await cache.load())?.messages.map(record => record.id)).toEqual(['old', 'acknowledged', 'unrelated']);
});

it('does not resurrect records removed before the cached cursor when an old send response is replayed', async () => {
  const cache = createWorkbenchCache('u', 'root');
  await cache.save(page(15, ['current']));
  const updated = vi.fn();
  const sync = start({ parent: 'root', cache, load: async () => page(15), events, onSnapshot: updated, onError: vi.fn() });
  await vi.waitFor(() => expect(updated).toHaveBeenCalledOnce());
  sync.applyCommitted(page(10, ['previously-moved']));
  expect(updated.mock.lastCall![0].messages.map((record: { id: string }) => record.id)).toEqual(['current']);
});

it('loads one network page when browser storage is unavailable, without following its continuation', async () => {
  const cache = createWorkbenchCache('u', 'root');
  await cache.save({ ...page(10, ['partial']), hasMore: true });
  expect(await cache.load()).toBeNull();
  vi.stubGlobal('indexedDB', undefined);
  const updated = vi.fn(), onError = vi.fn(), load = vi.fn(async ({ after }: SnapshotQuery) => after === undefined ? { ...page(10, ['first']), nextCursor: 'more' } : page(10));
  start({ parent: 'root', cache, load, events, onSnapshot: updated, onError });
  await vi.waitFor(() => expect(updated).toHaveBeenCalledOnce());
  expect(load.mock.calls.map(([query]) => query.after)).toEqual([undefined, 10]);
  expect(onError).not.toHaveBeenCalled();
});

it('restores a partially browsed window after F5 and continues only when more is requested', async () => {
  const cache = createWorkbenchCache('u', 'root');
  await cache.save({ ...page(10, ['first']), windowed: true, nextCursor: 'older', pageCursors: { root: 'older' } });
  const load = vi.fn(async ({ cursor }: SnapshotQuery) => cursor ? { ...page(10, ['second']), nextCursor: 'last' } : page(10));
  const updated = vi.fn(), onPages = vi.fn();
  const sync = start({ parent: 'root', cache, load, events, onSnapshot: updated, onError: vi.fn(), onPages });
  await vi.waitFor(() => expect(updated).toHaveBeenCalledOnce());
  expect(load).toHaveBeenCalledOnce();
  expect(load.mock.calls[0][0]).toMatchObject({ mode: 'window', limit: 50, after: 10, knownIds: ['first'] });
  await sync.loadMore();
  expect(load.mock.calls[1][0]).toMatchObject({ mode: 'window', cursor: 'older', limit: 50 });
  expect((await cache.load())?.pageCursors).toEqual({ root: 'last' });
  expect(updated.mock.lastCall![0].messages.map((message: { id: string }) => message.id)).toEqual(['first', 'second']);
  expect(onPages.mock.lastCall![0]).toEqual({ root: { hasMore: true, loading: false } });
});
