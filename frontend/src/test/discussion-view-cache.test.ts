import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';
import { prepareZhihuForViewing, sendZhihuLocalRelation } from '../utils/zhihuArchive';

const native = (): ExportData => ({ format: 'gonglun-view-3', formatVersion: 5, exportedAt: '',
  scope: { messageId: null, title: '结构测试' }, messages: [], relations: [] });
const zhihu = () => prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
  owner: { id: 'test-owner' }, items: [{ id: '10', type: 'article', text: '' }], comments: [] });
const view = (id: string) => ({ mode: 'discussion' as const, collapsed: [JSON.stringify([id, 'reply'])] });
const sameMetadataDocument = (id: string): ExportData => ({ ...native(), scope: { messageId: null, title: '' },
  messages: [{ id, kind: 'TEXT', contentType: 'TEXT', content: '', authorId: '', author: '', createdAt: '' }] });

beforeEach(() => { vi.resetModules(); sessionStorage.clear(); vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

it.each(['native', 'zhihu'])('restores small discussion state for %s without rewriting the document', async kind => {
  const data = kind === 'native' ? native() : zhihu();
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExport(data);
  const clone = vi.spyOn(globalThis, 'structuredClone');
  await cache.saveExportDiscussionView(data, view('1'));
  // The archive is neither prepared nor cloned on a folding interaction.
  expect(clone.mock.calls.every(([value]) => !value || typeof value !== 'object' || !('messages' in value))).toBe(true);
  expect(await cache.loadLastExport()).toEqual(data);
  vi.resetModules();
  const reopened = await import('../utils/exportViewerCache');
  const restored = await reopened.loadLastExport() as ExportData;
  expect(restored).toEqual(data);
  expect(await reopened.loadExportDiscussionView(restored)).toEqual(view('1'));
});

it('commits rapid changes in order and keeps target and category keys independent', async () => {
  const data = zhihu(), cache = await import('../utils/exportViewerCache');
  await cache.saveLastExport(data);
  const last = { mode: 'discussion' as const, collapsed: [JSON.stringify(['1', 'agree']), JSON.stringify(['2', 'reply'])] };
  await Promise.all([cache.saveExportDiscussionView(data, view('1')), cache.saveExportDiscussionView(data, view('2')),
    cache.saveExportDiscussionView(data, last)]);
  expect(await cache.loadExportDiscussionView(data)).toEqual(last);
});

it('isolates different native documents with identical legacy metadata, including already returned copies', async () => {
  const first = sameMetadataDocument('1'), second = sameMetadataDocument('2');
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExport(first);
  const firstCopy = await cache.loadLastExport() as ExportData;
  await cache.saveLastExport(second);
  const secondCopy = await cache.loadLastExport() as ExportData;
  await cache.saveExportDiscussionView(second, view('2'));
  await cache.saveExportDiscussionView(firstCopy, view('1'));
  expect(await cache.loadExportDiscussionView(first)).toEqual(view('1'));
  expect(await cache.loadExportDiscussionView(firstCopy)).toEqual(view('1'));
  expect(await cache.loadExportDiscussionView(secondCopy)).toEqual(view('2'));
  expect(await cache.loadLastExport()).toEqual(second);
  // A matching metadata tuple never grants an unrelated object access to a cache.
  const unrelated = sameMetadataDocument('3');
  expect(await cache.loadExportDiscussionView(unrelated)).toBeNull();
  await expect(cache.saveExportDiscussionView(unrelated, view('3'))).rejects.toThrow('尚无本机缓存');
});

it('rebinds restored native copies to their own document even after another same-metadata document is read', async () => {
  const first = sameMetadataDocument('1'), second = sameMetadataDocument('2');
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExport(first);
  const firstReference = sessionStorage.getItem('lastExportData')!;
  await cache.saveExportDiscussionView(first, view('1'));
  await cache.saveLastExport(second);
  await cache.saveExportDiscussionView(second, view('2'));
  sessionStorage.clear(); vi.resetModules();
  const reopened = await import('../utils/exportViewerCache');
  const secondCopy = await reopened.loadLastExport() as ExportData;
  expect(await reopened.loadExportDiscussionView(secondCopy)).toEqual(view('2'));
  // A fresh module simulates the older tab restoring its own saved pointer.
  sessionStorage.setItem('lastExportData', firstReference); vi.resetModules();
  const olderTab = await import('../utils/exportViewerCache');
  const firstCopy = await olderTab.loadLastExport() as ExportData;
  expect(firstCopy).toEqual(first);
  expect(await olderTab.loadExportDiscussionView(firstCopy)).toEqual(view('1'));
  await olderTab.saveLastExport(second);
  await olderTab.saveExportDiscussionView(firstCopy, view('1-new'));
  expect(await olderTab.loadExportDiscussionView(second)).toBeNull();
  expect(await olderTab.loadExportDiscussionView(firstCopy)).toEqual(view('1-new'));
});

it('verifies a cloned route reference against its stored entry and retains bindings through conversion', async () => {
  const first = sameMetadataDocument('1'), second = sameMetadataDocument('2');
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExport(first);
  const firstReference = cache.getExportCacheReference(first)!;
  await cache.saveExportDiscussionView(first, view('1'));
  await cache.saveLastExport(second);
  const secondReference = cache.getExportCacheReference(second)!;
  const restored = await cache.loadReferencedExport(structuredClone(firstReference)) as ExportData;
  const converted = cache.inheritExportCacheReference({ ...restored }, restored);
  expect(await cache.loadExportDiscussionView(converted)).toEqual(view('1'));
  await cache.saveExportDiscussionView(converted, view('1-new'));
  expect(await cache.loadExportDiscussionView(second)).toBeNull();
  expect(await cache.loadLastExport()).toEqual(second);
  await expect(cache.loadReferencedExport({ ...firstReference, viewCacheId: secondReference.viewCacheId })).rejects.toThrow('已更换或不存在');
});

it('does not expose a durable route reference after a failed file-cache write', async () => {
  vi.stubGlobal('indexedDB', undefined);
  const data = sameMetadataDocument('1'), cache = await import('../utils/exportViewerCache');
  await cache.saveLastExport(data);
  expect(cache.getExportCacheReference(data)).toBeNull();
  expect(await cache.loadLastExport()).toEqual(data);
});

it('reads a specific document’s layout without changing the last-opened document', async () => {
  const data = zhihu(), other = native(), cache = await import('../utils/exportViewerCache');
  await cache.saveLastExport(data);
  await cache.saveExportDiscussionView(data, view('1'));
  await cache.saveLastExport(other);
  sessionStorage.clear(); vi.resetModules();
  const reopened = await import('../utils/exportViewerCache');
  const specific = await reopened.loadCachedExport(data.zhihu.archiveId) as ExportData;
  expect(await reopened.loadExportDiscussionView(specific)).toEqual(view('1'));
  expect(await reopened.loadLastExport()).toEqual(other);
});

it('does not conflict with or overwrite another tab’s relation edit, and retains the relation CAS guard', async () => {
  const data = zhihu(), first = await import('../utils/exportViewerCache');
  await first.saveLastExport(data);
  vi.resetModules();
  const second = await import('../utils/exportViewerCache');
  await second.loadCachedExport(data.zhihu.archiveId, { fresh: true });
  await first.saveExportDiscussionView(data, view('1'));
  const edited = sendZhihuLocalRelation(data, { relationType: 'CORRECT', targetMessageIds: ['zhihu:item:article:10'], correctionKind: 'WIDTH', correctionWidth: 900 });
  await second.saveLastExportPersistent(edited, data);
  expect(await second.loadExportDiscussionView(edited)).toEqual(view('1'));
  await first.saveExportDiscussionView(data, view('2'));
  expect(await second.loadCachedExport(data.zhihu.archiveId, { fresh: true })).toEqual(edited);
  await expect(first.saveLastExportPersistent(data, data)).rejects.toThrow('其他标签页更新');
});

it('uses a newly selected file’s settings even if an older tab later saves folds for that archive', async () => {
  const data = zhihu(), oldTab = await import('../utils/exportViewerCache');
  await oldTab.saveLastExport(data);
  await oldTab.saveExportDiscussionView(data, view('1'));
  vi.resetModules();
  const newTab = await import('../utils/exportViewerCache');
  await newTab.saveLastExport(data);
  expect(await newTab.loadExportDiscussionView(data)).toBeNull();
  await oldTab.saveExportDiscussionView(data, view('2'));
  expect(await newTab.loadExportDiscussionView(data)).toBeNull();
});

it('reports a failed write and can retry without losing the document or replacing its view', async () => {
  const data = zhihu(), cache = await import('../utils/exportViewerCache');
  await cache.saveLastExport(data);
  const database = indexedDB;
  vi.stubGlobal('indexedDB', undefined);
  await expect(cache.saveExportDiscussionView(data, view('1'))).rejects.toThrow('未能保存');
  vi.stubGlobal('indexedDB', database);
  expect(await cache.loadExportDiscussionView(data)).toBeNull();
  await cache.saveExportDiscussionView(data, view('2'));
  expect(await cache.loadExportDiscussionView(data)).toEqual(view('2'));
  expect(await cache.loadLastExport()).toEqual(data);
});
