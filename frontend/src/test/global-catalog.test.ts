import { afterEach, expect, it, vi } from 'vitest';
import { syncGlobalCatalog, type CatalogCache, type CatalogCheckpoint } from '../data/globalCatalog';
import type { SnapshotQuery, WorkbenchSnapshot } from '../data/workbench';

const message = (id: string, revision = 1) => ({ id, revision, kind: 'TEXT', contentType: 'TEXT' as const, content: `${id}-${revision}`,
  createdAt: '', createdBy: { id: 'u', username: '用户', createdAt: '' } });
const page = (sequence: number, ids: string[] = []): WorkbenchSnapshot => ({ regionId: 'region', sequence,
  scope: { messageId: null, title: '公论' }, messages: ids.map(id => message(id)), relations: [], users: [], stakes: {}, tagCounts: {}, attentionUsers: {} });
function memoryCache(initial: CatalogCheckpoint | null = null) {
  let value = initial;
  const cache: CatalogCache = { load: vi.fn(async () => structuredClone(value)),
    save: vi.fn(async next => { value = structuredClone(next); }), clear: vi.fn(async () => { value = null; }) };
  return cache;
}
const running: ReturnType<typeof syncGlobalCatalog>[] = [];
function start(load: (query: SnapshotQuery) => Promise<WorkbenchSnapshot>, cache = memoryCache(), idle = async () => {}) {
  const onReady = vi.fn(), onProgress = vi.fn();
  const sync = syncGlobalCatalog({ parent: 'root', load, cache, idle, onReady, onProgress });
  running.push(sync);
  return { sync, onReady, onProgress, cache };
}
afterEach(() => { running.splice(0).forEach(sync => sync.stop()); });

it('yields before bounded pages and publishes global records only after replaying changes from the first page', async () => {
  let release!: () => void;
  const idle = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; })).mockResolvedValue(undefined);
  const load = vi.fn(async ({ cursor, after }: SnapshotQuery) => after === 10
    ? { ...page(15), messages: [message('changed', 2)], removedMessageIds: ['removed'], hasMore: true }
    : after === 15 ? { ...page(25, ['arrived-during-pagination']), tagCounts: { changed: { recommend: 7 } } }
    : cursor ? { ...page(20, ['closed-container-member', 'older']), nextCursor: null }
    : { ...page(10, ['changed', 'removed']), nextCursor: 'second' });
  const { onReady, cache } = start(load, memoryCache(), idle);
  await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce());
  expect(load).not.toHaveBeenCalled(); expect(onReady).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  expect(load.mock.calls.map(([q]) => [q.mode, q.cursor, q.after, q.batch])).toEqual([
    [undefined, undefined, undefined, 1], [undefined, 'second', undefined, 1],
    [undefined, undefined, 10, undefined], [undefined, undefined, 15, undefined],
  ]);
  expect(load.mock.calls.slice(0, 2).every(([q]) => q.limit === 200)).toBe(true);
  const result = onReady.mock.lastCall![0] as WorkbenchSnapshot;
  expect(result.messages.map(m => m.id)).toEqual(['changed', 'closed-container-member', 'older', 'arrived-during-pagination']);
  expect(result.messages[0].revision).toBe(2);
  expect(result.tagCounts.changed).toEqual({ recommend: 7 });
  expect(await cache.load()).toMatchObject({ complete: true, phase: 'changes', boundary: 10, after: 25, pages: 2 });
});

it('resumes incomplete pagination after reload and keeps its original replay boundary', async () => {
  const cache = memoryCache({ snapshot: page(20, ['already-cached']), boundary: 10, after: 10,
    nextCursor: 'resume-here', phase: 'pages', complete: false, pages: 2 });
  const load = vi.fn(async ({ after }: SnapshotQuery) => after === undefined
    ? { ...page(21, ['remaining']), nextCursor: null } : page(22, ['newer']));
  const { onReady } = start(load, cache);
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  expect(load.mock.calls.map(([q]) => [q.cursor, q.after])).toEqual([['resume-here', undefined], [undefined, 10]]);
  expect(onReady.mock.lastCall![0].messages.map((m: { id: string }) => m.id)).toEqual(['already-cached', 'remaining', 'newer']);
});

it('restores a complete catalog, reads only changes on refresh, and leaves unchanged projections stable', async () => {
  const cache = memoryCache({ snapshot: page(10, ['all-cached']), boundary: 5, after: 10,
    nextCursor: null, phase: 'changes', complete: true, pages: 3 });
  const load = vi.fn<(query: SnapshotQuery) => Promise<WorkbenchSnapshot>>(async () => page(10));
  const { sync, onReady } = start(load, cache);
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  await expect(sync.refresh()).resolves.toBe(false);
  expect(onReady).toHaveBeenCalledOnce();
  expect(load.mock.calls.every(([q]) => q.after === 10 && !q.mode && !q.cursor)).toBe(true);
});

it('does not complete a failed page, and manual refresh waits through all remaining pages', async () => {
  const cache = memoryCache({ snapshot: page(10, ['old']), boundary: 10, after: 10,
    nextCursor: 'remaining', phase: 'pages', complete: false, pages: 1 });
  const load = vi.fn<(query: SnapshotQuery) => Promise<WorkbenchSnapshot>>(async () => page(12)).mockRejectedValueOnce(new Error('离线'));
  const { sync, onReady, onProgress } = start(load, cache);
  await vi.waitFor(() => expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ error: '离线', ready: false })));
  expect(onReady).not.toHaveBeenCalled();
  expect(await cache.load()).toMatchObject({ nextCursor: 'remaining', complete: false, after: 10 });
  // Explicit refresh should bypass the retry delay.
  await expect(sync.refresh()).resolves.toBe(true);
  expect(onReady).toHaveBeenCalledOnce();
  expect(load.mock.calls[1][0].cursor).toBe('remaining');
});

it('rebuilds after region reset without completing a partial catalog or stranding refresh waiters', async () => {
  const cache = memoryCache({ snapshot: page(10, ['obsolete']), boundary: 10, after: 10,
    nextCursor: 'old-region', phase: 'pages', complete: false, pages: 1 });
  const load = vi.fn<(query: SnapshotQuery) => Promise<WorkbenchSnapshot>>(async () => ({ ...page(2, ['rebuilt']), regionId: 'new-region' }))
    .mockRejectedValueOnce(Object.assign(new Error('讨论区已重建'), { status: 409 }));
  const { sync, onReady } = start(load, cache);
  await expect(sync.refresh()).resolves.toBe(true);
  expect(cache.clear).toHaveBeenCalledOnce();
  expect(onReady).toHaveBeenCalledOnce();
  expect(onReady.mock.lastCall![0].messages.map((m: { id: string }) => m.id)).toEqual(['rebuilt']);
});

it('cancels idle work and rejects refreshes on scope or account change', async () => {
  let release!: () => void;
  const load = vi.fn<(query: SnapshotQuery) => Promise<WorkbenchSnapshot>>(async () => page(1));
  const { sync, onReady } = start(load, memoryCache(), () => new Promise<void>(resolve => { release = resolve; }));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const pending = sync.refresh(); sync.stop(); release();
  await expect(pending).rejects.toThrow('同步已停止');
  expect(load).not.toHaveBeenCalled(); expect(onReady).not.toHaveBeenCalled();
});

it('shows committed command records immediately while still replaying unrelated changes from the confirmed cursor', async () => {
  const load = vi.fn(async ({ after }: SnapshotQuery) => after === undefined ? page(10, ['old']) : page(10));
  const { sync, onReady } = start(load);
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  sync.applyCommitted({ ...page(12, ['sent']), windowed: true });
  expect(onReady.mock.lastCall![0].messages.map((m: { id: string }) => m.id)).toEqual(['old', 'sent']);
  expect(onReady.mock.lastCall![0].windowed).toBeUndefined();
  load.mockImplementation(async () => page(13, ['unrelated-change']));
  await sync.refresh();
  expect(load.mock.calls[2][0].after).toBe(10);
  expect(onReady.mock.lastCall![0].messages.map((m: { id: string }) => m.id)).toEqual(['old', 'sent', 'unrelated-change']);
});
