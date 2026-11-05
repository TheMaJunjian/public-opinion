import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { prepareZhihuForViewing } from '../utils/zhihuArchive';
import { prepareExportForViewing } from '../utils/exportArchive';
import { isNativeZhihuView, mergeNativeZhihuUpdate } from '../utils/nativeZhihuView';

async function native(extra = false) {
  const { zhihu: _legacy, ...data } = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: [{ id: '1', type: 'article', text: '技术正文' }, ...(extra ? [{ id: '2', type: 'article', text: '新增技术正文' }] : [])], comments: [] });
  const wire = { ...data, source: { provider: 'zhihu', version: 1, scope: 'collections', ownerId: 'fixture-owner', ownerUrl: null },
    messages: data.messages.map(({ content: _content, ...message }) => message) };
  const prepared = (await prepareExportForViewing(wire)).data;
  if (!isNativeZhihuView(prepared)) throw new Error('Invalid fixture');
  return prepared;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

it('merges native snapshots by source identity, preserving view settings and rejecting a rollback', async () => {
  const initial = await native(), next = await native(true);
  initial.view = { username: null, mode: 'graph', classificationId: 'zhihu:type:article', messageFilter: { hideJoin: false, hideSettlement: true }, homeFilter: null, cleanFilters: [] };
  expect(mergeNativeZhihuUpdate(initial, next).view).toEqual(initial.view);
  expect(() => mergeNativeZhihuUpdate(next, initial)).toThrow('缺少已有原文');
  expect(() => mergeNativeZhihuUpdate(initial, { ...next, source: { ...next.source, ownerId: 'another' } })).toThrow('不同用户');
});

it('reads and refreshes a linked compact folder while the native journal is absent', async () => {
  const initial = await native(), next = await native(true);
  let current = initial, modified = 1;
  const directory = { name: 'collections', getFileHandle: vi.fn(async (name: string) => {
    if (name !== 'gonglun.json') throw new DOMException('Missing native journal', 'NotFoundError');
    const text = JSON.stringify(current);
    return { getFile: async () => ({ text: async () => text, size: text.length, lastModified: modified }) };
  }) } as unknown as FileSystemDirectoryHandle;
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, run: () => Promise<void>) => run() } });
  const { readZhihuDirectory, refreshZhihuDirectory, appendZhihuJournal } = await import('../utils/zhihuDirectory');
  const opened = await readZhihuDirectory(directory);
  expect(opened.data).not.toHaveProperty('zhihu');
  expect((await refreshZhihuDirectory(opened.connection, opened.data)).data).toBe(opened.data);
  current = { ...initial, exportedAt: '2026-11-02T00:00:00.000Z' }; modified++;
  expect((await refreshZhihuDirectory(opened.connection, opened.data)).data).toBe(opened.data);
  current = next; modified++;
  const refreshed = await refreshZhihuDirectory(opened.connection, opened.data);
  expect(refreshed.data.messages).toHaveLength(next.messages.length);
  await appendZhihuJournal(opened.connection, refreshed.data);
  expect(vi.mocked(directory.getFileHandle).mock.calls.filter(([name]) => name === 'gonglun.json')).toHaveLength(4);
});

it('keeps a native folder document and its folds under the same cache reference across source updates', async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  const cache = await import('../utils/exportViewerCache'), initial = await native(), next = await native(true);
  await cache.saveLastExport(initial);
  const reference = cache.getExportCacheReference(initial)!;
  const discussion = { mode: 'discussion' as const, collapsed: [JSON.stringify(['fixture-fold', 'reply'])] };
  await cache.saveExportDiscussionView(initial, discussion);
  await cache.saveLastExportPersistent(next, initial, { sourceUpdate: true });
  expect(cache.getExportCacheReference(next)).toEqual(reference);
  expect(await cache.loadExportDiscussionView(next)).toEqual(discussion);
  vi.resetModules();
  const reopened = await import('../utils/exportViewerCache');
  expect(await reopened.loadReferencedExport(reference)).toEqual(next);
});

it('atomically rejects a stale native update from another tab', async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  const cache = await import('../utils/exportViewerCache'), initial = await native(), next = await native(true);
  await cache.saveLastExport(initial);
  const reference = cache.getExportCacheReference(initial)!;
  const outcomes = await Promise.allSettled([
    cache.saveLastExportPersistent(next, initial, { sourceUpdate: true }),
    cache.saveLastExportPersistent(initial, initial, { sourceUpdate: true }),
  ]);
  expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(await cache.loadReferencedExport(reference)).toEqual(outcomes[0].status === 'fulfilled' ? next : initial);
});

it('rereads the same native document before reopening it after another tab saves', async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  const firstTab = await import('../utils/exportViewerCache'), initial = await native();
  await firstTab.saveLastExport(initial);
  const reference = firstTab.getExportCacheReference(initial)!;
  vi.resetModules();
  const secondTab = await import('../utils/exportViewerCache');
  const second = await secondTab.loadReferencedExport(reference) as typeof initial;
  const { nativeZhihuDocument, sendNativeZhihuRelation } = await import('../utils/nativeZhihuEditor');
  const edited = nativeZhihuDocument(sendNativeZhihuRelation(second, {
    relationType: 'AGREE', targetMessageIds: [second.messages.find(message => message.kind === 'TEXT')!.id],
  }));
  await secondTab.saveLastExportPersistent(edited, second);
  await secondTab.saveLastExport(await native(true));
  expect(await firstTab.loadLastExport({ sourceOnly: true, fresh: true })).toEqual(edited);
  expect(firstTab.getExportCacheReference(await firstTab.loadLastExport() as typeof edited)).toEqual(reference);
});

it('finds pending native edits by source identity after reloading and viewing another file', async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  const cache = await import('../utils/exportViewerCache'), initial = await native();
  await cache.saveLastExport(initial);
  const { nativeZhihuDocument, sendNativeZhihuRelation } = await import('../utils/nativeZhihuEditor');
  const edited = nativeZhihuDocument(sendNativeZhihuRelation(initial, {
    relationType: 'AGREE', targetMessageIds: [initial.messages.find(message => message.kind === 'TEXT')!.id],
  }));
  await cache.saveLastExportPersistent(edited, initial);
  const other = await native();
  const otherDocument = { ...other, source: { ...other.source, ownerId: 'another-owner' } };
  await cache.saveLastExport(otherDocument);
  sessionStorage.clear(); vi.resetModules();
  const reloaded = await import('../utils/exportViewerCache');
  expect(await reloaded.loadCachedNativeExport(await native(true))).toEqual(edited);
  expect(await reloaded.loadCachedNativeExport({ ...other, source: { ...other.source, ownerId: 'missing-owner' } })).toBeNull();
});
