import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getZhihuDisplayFields, prepareZhihuForViewing, sendZhihuLocalRelation } from '../utils/zhihuArchive';
import { serializeGonglunZhihuViewingData } from '../utils/zhihuGonglunExport';

// Empty source bodies and technical field values only, never a captured sample.
const itemId = 'zhihu:item:article:1';
const fixture = () => prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
  items: [{ id: '1', type: 'article', text: '', completeness: { body: 'unknown' } }],
  comments: [{ id: '2', sourceId: '2', threadId: 'article:1', text: '', rootCommentId: '2', parentCommentId: null }] });
const legacyFixture = () => {
  const data = fixture();
  data.zhihu.overrides = { format: 'gonglun-zhihu-overrides', version: 1, revisions: [
    { id: 'legacy-edit', action: 'set', threadId: 'article:1', commentId: '2', parentCommentId: null, createdAt: '2026-11-01T00:00:00Z' },
  ] };
  return data;
};
const corrected = (data = fixture(), content = '技术字段补充') => sendZhihuLocalRelation(data, {
  relationType: 'CORRECT', targetMessageIds: [itemId], correctionField: 'body', content,
});

beforeEach(() => { vi.resetModules(); sessionStorage.clear(); vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

it('saves a correction after an old scalar-parent cache is upgraded instead of reporting a false tab conflict', async () => {
  const cache = await import('../utils/exportViewerCache');
  const legacy = legacyFixture(), originalArchive = structuredClone(legacy.zhihu.archive);
  await cache.saveLastExportPersistent(legacy);
  const opened = prepareZhihuForViewing(legacy), next = corrected(opened);
  expect(opened.zhihu.overrides).toMatchObject({ version: 2, revisions: [{ parentCommentIds: [], method: 'manual' }] });
  await expect(cache.saveLastExportPersistent(next, opened)).resolves.toBeUndefined();
  sessionStorage.clear(); vi.resetModules();
  const restored = prepareZhihuForViewing(await (await import('../utils/exportViewerCache')).loadLastExport());
  expect(restored.zhihu.archive).toEqual(originalArchive);
  expect(restored.zhihu.overrides.revisions[0].id).toBe('legacy-edit');
  expect(getZhihuDisplayFields(restored, itemId).body).toBe('技术字段补充');
  const reopenedDownload = prepareZhihuForViewing(JSON.parse(serializeGonglunZhihuViewingData(restored)));
  expect(reopenedDownload.zhihu.archive).toEqual(originalArchive);
  expect(reopenedDownload.zhihu.localOperations).toEqual(restored.zhihu.localOperations);
  expect(getZhihuDisplayFields(reopenedDownload, itemId).body).toBe('技术字段补充');
});

it('still rejects a genuinely stale edit after the first upgraded-cache save', async () => {
  const cache = await import('../utils/exportViewerCache'), legacy = legacyFixture();
  await cache.saveLastExportPersistent(legacy);
  const opened = prepareZhihuForViewing(legacy), winner = corrected(opened, '技术A');
  await cache.saveLastExportPersistent(winner, opened);
  await expect(cache.saveLastExportPersistent(corrected(opened, '技术B'), opened)).rejects.toThrow('已在其他标签页更新');
  expect(await cache.loadCachedExport(opened.zhihu.archiveId, { fresh: true })).toEqual(winner);
});

it('reports failed durable storage, retains the prior file and permits the same edit to be retried', async () => {
  const cache = await import('../utils/exportViewerCache'), initial = fixture(), next = corrected(initial);
  await cache.saveLastExportPersistent(initial);
  const reference = sessionStorage.getItem('lastExportData'), database = indexedDB;
  vi.stubGlobal('indexedDB', undefined);
  await expect(cache.saveLastExportPersistent(next, initial)).rejects.toThrow('调整尚未保存');
  expect(await cache.loadLastExport()).toEqual(initial);
  expect(sessionStorage.getItem('lastExportData')).toBe(reference);
  vi.stubGlobal('indexedDB', database);
  await expect(cache.saveLastExportPersistent(next, initial)).resolves.toBeUndefined();
  sessionStorage.clear(); vi.resetModules();
  const restored = prepareZhihuForViewing(await (await import('../utils/exportViewerCache')).loadLastExport());
  expect(restored.zhihu.localOperations).toEqual(next.zhihu.localOperations);
  expect(restored.zhihu.archive).toEqual(initial.zhihu.archive);
});

it('retains both text corrections and width operations after durable reload and a downloaded-file round trip', async () => {
  const initial = fixture(), textEdit = corrected(initial);
  const next = sendZhihuLocalRelation(textEdit, { relationType: 'CORRECT', targetMessageIds: [itemId], correctionKind: 'WIDTH', correctionWidth: 888 });
  const widthId = next.zhihu.localOperations.messages.at(-1)!.id;
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExportPersistent(initial);
  await cache.saveLastExportPersistent(next, initial);
  await expect(cache.saveLastExportPersistent(textEdit, initial)).rejects.toThrow('已在其他标签页更新');
  sessionStorage.clear(); vi.resetModules();
  const stored = prepareZhihuForViewing(await (await import('../utils/exportViewerCache')).loadLastExport());
  const reopened = prepareZhihuForViewing(JSON.parse(serializeGonglunZhihuViewingData(stored)));
  expect(reopened.zhihu.archive).toEqual(initial.zhihu.archive);
  expect(reopened.zhihu.localOperations).toEqual(next.zhihu.localOperations);
  expect(getZhihuDisplayFields(reopened, itemId).body).toBe('技术字段补充');
  expect(reopened.zhihu.localOperations.messages.find(message => message.id === widthId)).toMatchObject({ correctionKind: 'WIDTH', correctionWidth: 888 });
  expect(reopened.relations.find(relation => relation.id === widthId)?.payload).toMatchObject({ correctionKind: 'WIDTH', correctionWidth: 888 });
});
