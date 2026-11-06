import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeZhihuView } from '../utils/nativeZhihuView';
import { largeStructuralFixture } from './zhihu-structural-fixture';

let cache: typeof import('../utils/exportViewerCache');
let paging: typeof import('../utils/pagedZhihuArchive');
let NodeBlob: typeof Blob;
beforeEach(async () => {
  vi.resetModules(); sessionStorage.clear();
  ({ Blob: NodeBlob } = await vi.importActual<{ Blob: typeof Blob }>('node:buffer'));
  vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('indexedDB', new IDBFactory());
  cache = await import('../utils/exportViewerCache'); paging = await import('../utils/pagedZhihuArchive');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });
const bodyId = 'zhihu:comment:answer%3Ab:cb';
function fixture() {
  const data = largeStructuralFixture(), body = data.messages.find(row => row.id === bodyId)!;
  body.content = '完整原文😀'.repeat(1000); body.parts = [{ id: 'body', type: 'text', text: body.content }];
  return data;
}

it('persists file bytes separately and restores only an index plus a Blob handle', async () => {
  const source = fixture(), data = await paging.pageNativeZhihuData(source);
  const external = await paging.pagedArchiveSource(data)!.blob();
  await cache.saveLastExport(data, { immutable: true });
  vi.spyOn(external, 'slice').mockImplementation(() => { throw new Error('目录原文件已被替换'); });
  const current = await paging.hydratePagedArchive(data, { ...data, messages: data.messages.filter(row => row.id === bodyId), relations: [] });
  expect(current.messages[0].content).toBe(source.messages.find(row => row.id === bodyId)?.content);
  const reference = cache.getExportCacheReference(data)!;
  expect(reference).not.toBeNull();
  const raw = await cache.withArchiveStore<{ data: NativeZhihuView; pages: unknown }>('readonly', store => store.get(reference.archiveId));
  expect(raw.pages).toBeDefined();
  expect(raw.data.messages.find(row => row.id === bodyId)?.content).toBe('x');
  const text = vi.spyOn(NodeBlob.prototype, 'text'), bytes = vi.spyOn(NodeBlob.prototype, 'arrayBuffer');
  const restored = await cache.loadReferencedExport(reference, { paged: true }) as NativeZhihuView;
  expect(bytes).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled();
  expect(paging.pagedArchiveSource(restored)).toBeDefined();
  expect(restored.messages.find(row => row.id === bodyId)?.content).toBe('x');
  const window = await paging.hydratePagedArchive(restored, { ...restored, messages: restored.messages.filter(row => row.id === bodyId), relations: [] });
  expect(window.messages[0].content).toBe(source.messages.find(row => row.id === bodyId)?.content);
});

it('upgrades an old object cache once and keeps its document identity and saved navigation', async () => {
  const source = fixture();
  await cache.saveLastExport(source, { immutable: true });
  const reference = cache.getExportCacheReference(source)!;
  await cache.saveExportNavigation(source, { classificationId: null, classificationPath: [] });
  const paged = await cache.loadReferencedExport(reference, { paged: true }) as NativeZhihuView;
  expect(cache.getExportCacheReference(paged)).toEqual(reference);
  expect(paging.pagedArchiveSource(paged)).toBeDefined();
  expect(await cache.loadExportNavigation(paged)).toEqual({ classificationId: null, classificationPath: [] });
  const writes = vi.spyOn(IDBObjectStore.prototype, 'put');
  const reopened = await cache.loadReferencedExport(reference, { paged: true }) as NativeZhihuView;
  expect(writes).not.toHaveBeenCalled();
  expect(paging.pagedArchiveSource(reopened)?.descriptor.blobKey).toBe(paging.pagedArchiveSource(paged)?.descriptor.blobKey);
  const full = await cache.loadReferencedExport(reference) as NativeZhihuView;
  expect(full.messages).toEqual(source.messages);
  expect(full.relations).toEqual(source.relations);
});

it('saves local edits and settings without rewriting the original file bytes', async () => {
  const source = fixture(), data = await paging.pageNativeZhihuData(source);
  await cache.saveLastExport(data, { immutable: true });
  const reference = cache.getExportCacheReference(data)!;
  const { sendPagedZhihuRelation } = await import('../utils/pagedZhihuEditor');
  const { nativeZhihuDocument } = await import('../utils/nativeZhihuEditor');
  const edited = nativeZhihuDocument(await sendPagedZhihuRelation(data, { relationType: 'REPLY',
    sourceMessageIds: ['zhihu:item:answer:a'], targetMessageIds: [bodyId], note: '保存的本地回复' }));
  const writes = vi.spyOn(IDBObjectStore.prototype, 'put');
  await cache.saveLastExportPersistent(edited, data);
  expect(writes.mock.calls.some(([, key]) => String(key).startsWith('__native_blob__') || key === reference.archiveId)).toBe(false);
  const restored = await cache.loadReferencedExport(reference, { paged: true }) as NativeZhihuView;
  expect(restored.messages.some(row => row.content === '保存的本地回复')).toBe(true);
  const exported = JSON.parse(await (await paging.exportPagedArchive(restored)).text());
  expect(exported.messages.find((row: { id: string }) => row.id === bodyId).content).toBe(source.messages.find(row => row.id === bodyId)?.content);
  expect(exported.messages.length).toBe(edited.messages.length);
  await expect(cache.saveLastExportPersistent({ ...data }, data)).rejects.toThrow('其他标签页');
});

it('publishes a new source atomically while an already-open old revision can still read its own bodies', async () => {
  const source = fixture(), data = await paging.pageNativeZhihuData(source);
  await cache.saveLastExport(data, { immutable: true });
  const reference = cache.getExportCacheReference(data)!;
  const old = await cache.loadReferencedExport(reference, { paged: true }) as NativeZhihuView;
  const updated = fixture(), changed = updated.messages.find(row => row.id === bodyId)!;
  changed.content = '同步后的正文'; changed.parts = [{ id: 'body', type: 'text', text: changed.content }];
  const next = await paging.pageNativeZhihuData(updated);
  await cache.saveLastExportPersistent(next, old, { sourceUpdate: true });
  const latest = await cache.loadReferencedExport(reference, { paged: true }) as NativeZhihuView;
  const read = (value: NativeZhihuView) => paging.hydratePagedArchive(value, { ...value, messages: value.messages.filter(row => row.id === bodyId), relations: [] });
  expect((await read(latest)).messages[0].content).toBe('同步后的正文');
  expect((await read(old)).messages[0].content).toBe(source.messages.find(row => row.id === bodyId)?.content);
  const oldBlob = await cache.withArchiveStore('readonly', store => store.get(paging.pagedArchiveSource(old)!.descriptor.blobKey));
  expect(oldBlob).toBeUndefined();
});

it('detects changed directory bodies even when the compact relationship index is unchanged', async () => {
  const source = fixture();
  source.messages[0].parts!.push({ id: 'source-fields', type: 'data', value: '大文件字段'.repeat(700_000) });
  let version = 1, file = Object.assign(new Blob([JSON.stringify(source)]), { lastModified: version });
  const directory = { name: 'paged-source', getFileHandle: async (name: string) => {
    if (name !== 'gonglun.json') throw new DOMException('missing journal', 'NotFoundError');
    return { getFile: async () => file };
  } } as unknown as FileSystemDirectoryHandle;
  const { readZhihuDirectory, refreshZhihuDirectory } = await import('../utils/zhihuDirectory');
  const opened = await readZhihuDirectory(directory);
  expect(paging.pagedArchiveSource(opened.data)).toBeDefined();
  const row = source.messages.find(row => row.id === bodyId)!;
  row.content = '同步后的正文'; row.parts = [{ id: 'body', type: 'text', text: row.content }];
  file = Object.assign(new Blob([JSON.stringify(source)]), { lastModified: ++version });
  const refreshed = await refreshZhihuDirectory(opened.connection, opened.data);
  expect(refreshed.data).not.toBe(opened.data);
  const body = await paging.hydratePagedArchive(refreshed.data, { ...refreshed.data,
    messages: refreshed.data.messages.filter(row => row.id === bodyId), relations: [] });
  expect(body.messages[0].content).toBe('同步后的正文');
});
