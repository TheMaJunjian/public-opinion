import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';

const archive = (title: string): ExportData => ({
  formatVersion: 1, exportedAt: '', scope: { messageId: null, title },
  messages: [{ id: title, kind: 'TEXT', contentType: 'TEXT', content: title, createdAt: '', author: '甲', authorId: 'a' }],
  relations: [], view: { username: '甲', mode: 'list', classificationId: null,
    messageFilter: { hideJoin: false, hideSettlement: true }, homeFilter: null, cleanFilters: [] },
});

beforeEach(() => { vi.resetModules(); sessionStorage.clear(); vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

it('persists a file beyond the Web Storage quota and reloads every field after a page reload', async () => {
  const data = archive('大文件');
  data.messages[0].content = '大'.repeat(6_000_000);
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExport(data);
  expect(sessionStorage.getItem('lastExportData')!.length).toBeLessThan(100);
  vi.resetModules();
  const reloaded = await import('../utils/exportViewerCache');
  expect(await reloaded.loadLastExport()).toEqual(data);
});

it('replaces the last file instead of retaining the earlier one, while preserving another tab', async () => {
  const firstTab = await import('../utils/exportViewerCache');
  await firstTab.saveLastExport(archive('第一标签页'));
  const firstReference = sessionStorage.getItem('lastExportData')!;
  vi.resetModules();
  const secondTab = await import('../utils/exportViewerCache');
  sessionStorage.clear();
  await secondTab.saveLastExport(archive('旧文件'));
  await secondTab.saveLastExport(archive('新文件'));
  vi.resetModules();
  expect(await (await import('../utils/exportViewerCache')).loadLastExport()).toEqual(archive('新文件'));
  sessionStorage.setItem('lastExportData', firstReference);
  vi.resetModules();
  expect(await (await import('../utils/exportViewerCache')).loadLastExport()).toEqual(archive('第一标签页'));
});

it('keeps historical session caches readable', async () => {
  sessionStorage.setItem('lastExportData', JSON.stringify(archive('旧版缓存')));
  expect(await (await import('../utils/exportViewerCache')).loadLastExport()).toEqual(archive('旧版缓存'));
});

it('reopens only the latest data when IndexedDB and Web Storage writes both fail', async () => {
  sessionStorage.setItem('lastExportData', JSON.stringify(archive('旧文件')));
  vi.stubGlobal('indexedDB', undefined);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('满', 'QuotaExceededError'); });
  const cache = await import('../utils/exportViewerCache');
  const data = archive('当前大文件');
  await cache.saveLastExport(data);
  const restored = await cache.loadLastExport();
  expect(restored).toEqual(data);
  expect(restored).not.toBe(data);
  vi.resetModules();
  expect(await (await import('../utils/exportViewerCache')).loadLastExport()).toBeNull();
});

it('does not substitute stale stored data after an interrupted cache write', async () => {
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExport(archive('旧文件'));
  vi.stubGlobal('indexedDB', undefined);
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (value.length > 100) throw new DOMException('满', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
  await cache.saveLastExport(archive('新文件'));
  vi.resetModules();
  expect(await (await import('../utils/exportViewerCache')).loadLastExport()).toBeNull();
});
