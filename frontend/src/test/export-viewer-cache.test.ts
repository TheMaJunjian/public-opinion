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

it('restores authoritative Zhihu sources without copying their derived projections and keeps edits intact', async () => {
  const { prepareZhihuForViewing, sendZhihuLocalRelation } = await import('../utils/zhihuArchive');
  const original = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    owner: { id: 'source-only-owner', name: '技术测试账号' }, items: [{ id: '10', type: 'article', text: '技术字段测试' }], comments: [] });
  const target = 'zhihu:item:article:10';
  const edited = sendZhihuLocalRelation(original, { relationType: 'CORRECT', targetMessageIds: [target], correctionKind: 'WIDTH', correctionWidth: 888 });
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExportPersistent(edited);
  const source = await cache.loadCachedExport(edited.zhihu.archiveId, { sourceOnly: true }) as { format: string; archive: typeof edited.zhihu.archive };
  expect(source.format).toBe('gonglun-zhihu-reviewed');
  expect(source).not.toHaveProperty('messages');
  expect(source).not.toHaveProperty('relations');
  const restored = prepareZhihuForViewing(source);
  expect(restored.zhihu.archive).toEqual(edited.zhihu.archive);
  expect(restored.zhihu.localOperations).toEqual(edited.zhihu.localOperations);
  source.archive.items[0].text = '修改返回副本';
  expect(await cache.loadCachedExport(edited.zhihu.archiveId)).toEqual(edited);
  vi.resetModules();
  const diskSource = await (await import('../utils/exportViewerCache')).loadLastExport({ sourceOnly: true });
  expect(diskSource).not.toHaveProperty('messages');
  expect(prepareZhihuForViewing(diskSource).zhihu.localOperations).toEqual(edited.zhihu.localOperations);
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
  await expect((await import('../utils/exportViewerCache')).loadLastExport()).rejects.toThrow();
});

it('reports unreadable and missing caches without deleting the original reference',async()=>{
  for(const raw of ['invalid JSON','null','false',JSON.stringify({archiveId:'missing'})]){
    sessionStorage.setItem('lastExportData',raw);
    const cache=await import('../utils/exportViewerCache');
    await expect(cache.loadLastExport()).rejects.toThrow();
    expect(sessionStorage.getItem('lastExportData')).toBe(raw);
  }
});

it('reopens the last persisted archive after the tab and its session storage are gone', async () => {
  const cache = await import('../utils/exportViewerCache');
  const data = archive('关闭后重新阅览');
  await cache.saveLastExportPersistent(data);
  sessionStorage.clear();
  vi.resetModules();
  expect(await (await import('../utils/exportViewerCache')).loadLastExport()).toEqual(data);
});

it('strict relationship saves report persistence failures without replacing the previous archive', async () => {
  const cache = await import('../utils/exportViewerCache');
  const original = archive('已持久保存');
  await cache.saveLastExportPersistent(original);
  const reference = sessionStorage.getItem('lastExportData');
  const database = indexedDB;
  vi.stubGlobal('indexedDB', undefined);
  await expect(cache.saveLastExportPersistent(archive('未保存的调整'))).rejects.toThrow('调整尚未保存');
  expect(await cache.loadLastExport()).toEqual(original);
  expect(sessionStorage.getItem('lastExportData')).toBe(reference);
  vi.stubGlobal('indexedDB', database);
  sessionStorage.clear();
  vi.resetModules();
  expect(await (await import('../utils/exportViewerCache')).loadLastExport()).toEqual(original);
});

it('does not downgrade a strict save to session-only persistence when IndexedDB is unavailable', async () => {
  vi.stubGlobal('indexedDB', undefined);
  const cache = await import('../utils/exportViewerCache');
  await expect(cache.saveLastExportPersistent(archive('新档案'))).rejects.toThrow('本机持久保存失败');
  expect(sessionStorage.getItem('lastExportData')).toBeNull();
  expect(await cache.loadLastExport()).toBeNull();
});

it('uses a stable Zhihu cache key and reloads its latest local relationships even after another file was opened', async () => {
  const { prepareZhihuForViewing, updateZhihuRelations } = await import('../utils/zhihuArchive');
  const data = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: [{ id: '10', type: 'answer', text: '' }], comments: [
      { id: '1', sourceId: '1', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null },
      { id: '2', sourceId: '2', threadId: 'answer:10', text: '', rootCommentId: '2', parentCommentId: null },
    ] });
  const messageId = (sourceId: string) => Object.entries(data.zhihu.byMessageId).find(([, source]) => source.kind === 'comment' && source.sourceId === sourceId)![0];
  const adjusted = updateZhihuRelations(data, { mode: 'sets', sourceMessageIds: [messageId('2')], targetMessageIds: [messageId('1')] });
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExportPersistent(data);
  const originalReference = sessionStorage.getItem('lastExportData');
  await cache.saveLastExportPersistent(adjusted);
  expect(sessionStorage.getItem('lastExportData')).toBe(originalReference);
  await cache.saveLastExportPersistent(archive('另一份文件'));
  sessionStorage.clear(); vi.resetModules();
  const reloaded = await import('../utils/exportViewerCache');
  expect(await reloaded.loadCachedExport(data.zhihu.archiveId)).toEqual(adjusted);
  expect(await reloaded.loadLastExport()).toEqual(archive('另一份文件'));
});

it('explicitly opening an original Zhihu file replaces older cached adjustments instead of merging them back', async () => {
  const { prepareZhihuForViewing, updateZhihuRelations } = await import('../utils/zhihuArchive');
  const raw = { format: 'gonglun-zhihu-archive', version: 1, items: [{ id: '10', type: 'answer', text: '' }], comments: [
    { id: '1', sourceId: '1', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null },
    { id: '2', sourceId: '2', threadId: 'answer:10', text: '', rootCommentId: '2', parentCommentId: null },
  ] };
  const original = prepareZhihuForViewing(raw);
  const ids = Object.entries(original.zhihu.byMessageId).filter(([, source]) => source.kind === 'comment').map(([id]) => id);
  const adjusted = updateZhihuRelations(original, { mode: 'sets', sourceMessageIds: [ids[1]], targetMessageIds: [ids[0]] });
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExportPersistent(adjusted);
  const selected = prepareZhihuForViewing(raw);
  await cache.saveLastExport(selected);
  expect(await cache.loadCachedExport(selected.zhihu.archiveId)).toEqual(selected);
  sessionStorage.clear(); vi.resetModules();
  const restored = await (await import('../utils/exportViewerCache')).loadLastExport();
  expect(prepareZhihuForViewing(restored).zhihu.overrides.revisions).toEqual([]);
});

it('rejects concurrent stale edits from another tab atomically and fresh reopening reads the winning revisions', async () => {
  const { prepareZhihuForViewing, updateZhihuRelations } = await import('../utils/zhihuArchive');
  const initial = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1, items: [{ id: '10', type: 'answer', text: '' }],
    comments: ['1', '2', '3'].map(id => ({ id, sourceId: id, threadId: 'answer:10', text: '', rootCommentId: id, parentCommentId: null })) });
  const ids = Object.entries(initial.zhihu.byMessageId).filter(([, source]) => source.kind === 'comment').map(([id]) => id);
  const firstEdit = updateZhihuRelations(initial, { mode: 'sets', sourceMessageIds: [ids[1]], targetMessageIds: [ids[0]] });
  const secondEdit = updateZhihuRelations(initial, { mode: 'sets', sourceMessageIds: [ids[2]], targetMessageIds: [ids[0]] });
  const firstTab = await import('../utils/exportViewerCache');
  await firstTab.saveLastExportPersistent(initial);
  vi.resetModules();
  const secondTab = await import('../utils/exportViewerCache');
  await secondTab.saveLastExport(initial);
  const results = await Promise.allSettled([
    firstTab.saveLastExportPersistent(firstEdit, initial), secondTab.saveLastExportPersistent(secondEdit, initial),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  expect(rejected.reason.message).toContain('已在其他标签页更新');
  const winner = results[0].status === 'fulfilled' ? firstEdit : secondEdit;
  const staleTab = results[0].status === 'fulfilled' ? secondTab : firstTab;
  expect(await staleTab.loadCachedExport(initial.zhihu.archiveId)).toEqual(initial);
  expect(await staleTab.loadCachedExport(initial.zhihu.archiveId, { fresh: true })).toEqual(winner);
  expect(await staleTab.loadCachedExport(initial.zhihu.archiveId)).toEqual(winner);
  sessionStorage.clear(); vi.resetModules();
  expect(await (await import('../utils/exportViewerCache')).loadLastExport()).toEqual(winner);
});

it('protects changed viewing settings as well as relationship history against stale saves', async () => {
  const { prepareZhihuForViewing } = await import('../utils/zhihuArchive');
  const initial = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1, items: [{ id: '10', type: 'answer', text: '' }], comments: [] });
  const changed = { ...initial, view: { username: null, mode: 'graph' as const, classificationId: null,
    messageFilter: { hideJoin: false, hideSettlement: true }, homeFilter: null, cleanFilters: [] } };
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExportPersistent(initial);
  await cache.saveLastExportPersistent(changed, initial);
  await expect(cache.saveLastExportPersistent(initial, initial)).rejects.toThrow('已在其他标签页更新');
  expect(await cache.loadLastExport()).toEqual(changed);
});

it('protects local reply stances from stale tab writes even when original relationships are unchanged', async () => {
  const { prepareZhihuForViewing, sendZhihuLocalRelation } = await import('../utils/zhihuArchive');
  const initial = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: [{ id: '10', type: 'answer', text: '' }], comments: [
      { id: '1', sourceId: '1', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null },
    ] });
  const replyId = initial.relations.find(relation => relation.relationType === 'REPLY')!.id;
  const opposed = sendZhihuLocalRelation(initial, { relationType: 'DISAGREE', targetMessageIds: [replyId] });
  expect(opposed.zhihu.overrides).toEqual(initial.zhihu.overrides);
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExportPersistent(initial);
  await cache.saveLastExportPersistent(opposed, initial);
  await expect(cache.saveLastExportPersistent(initial, initial)).rejects.toThrow('已在其他标签页更新');
  sessionStorage.clear(); vi.resetModules();
  expect(await (await import('../utils/exportViewerCache')).loadLastExport()).toEqual(opposed);
});

it('allows the first local edit after upgrading a cache that has no local operation history', async () => {
  const { prepareZhihuForViewing, sendZhihuLocalRelation } = await import('../utils/zhihuArchive');
  const initial = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: [{ id: '10', type: 'answer', text: '' }], comments: [
      { id: '1', sourceId: '1', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null },
    ] });
  const legacy = structuredClone(initial);
  delete (legacy.zhihu as Partial<typeof legacy.zhihu>).localOperations;
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExportPersistent(legacy);
  const opened = prepareZhihuForViewing(legacy);
  const replyId = opened.relations.find(relation => relation.relationType === 'REPLY')!.id;
  const opposed = sendZhihuLocalRelation(opened, { relationType: 'DISAGREE', targetMessageIds: [replyId] });
  await cache.saveLastExportPersistent(opposed, opened);
  expect(await cache.loadLastExport()).toEqual(opposed);
});

it('upgrades a version-one local history in an existing cache before saving new organization records', async () => {
  const { prepareZhihuForViewing, sendZhihuLocalRelation } = await import('../utils/zhihuArchive');
  const initial = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: [{ id: '10', type: 'answer', text: '' }], comments: [] });
  const legacy = structuredClone(initial);
  const oldHistory = legacy.zhihu.localOperations as unknown as { version: number; messages?: unknown[] };
  oldHistory.version = 1;
  delete oldHistory.messages;
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExportPersistent(legacy);
  const opened = prepareZhihuForViewing(legacy);
  const organized = sendZhihuLocalRelation(opened, { relationType: 'CLASSIFY', title: '技术分类',
    targetMessageIds: opened.messages.filter(message => message.kind === 'TEXT').map(message => message.id) });
  await cache.saveLastExportPersistent(organized, opened);
  sessionStorage.clear(); vi.resetModules();
  expect(await (await import('../utils/exportViewerCache')).loadLastExport()).toEqual(organized);
});

it('does not overwrite independently appended replies from a newer tab', async () => {
  const { prepareZhihuForViewing, sendZhihuLocalRelation } = await import('../utils/zhihuArchive');
  const initial = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: [{ id: '10', type: 'answer', text: '' }], comments: ['1', '2', '3'].map(id => (
      { id, sourceId: id, threadId: 'answer:10', text: '', rootCommentId: id, parentCommentId: null })) });
  const ids = Object.entries(initial.zhihu.byMessageId).filter(([, source]) => source.kind === 'comment').map(([id]) => id);
  const first = sendZhihuLocalRelation(initial, { relationType: 'REPLY', sourceMessageIds: [ids[0]], targetMessageIds: [ids[1]] });
  const stale = sendZhihuLocalRelation(initial, { relationType: 'REPLY', sourceMessageIds: [ids[0]], targetMessageIds: [ids[2]] });
  expect(first.zhihu.overrides).toEqual(initial.zhihu.overrides);
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExportPersistent(initial);
  await cache.saveLastExportPersistent(first, initial);
  await expect(cache.saveLastExportPersistent(stale, initial)).rejects.toThrow('已在其他标签页更新');
  expect(await cache.loadCachedExport(first.zhihu.archiveId, { fresh: true })).toEqual(first);
});

it('upgrades version-two history and protects local text corrections from a stale tab', async () => {
  const { prepareZhihuForViewing, sendZhihuLocalRelation } = await import('../utils/zhihuArchive');
  const initial = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: [{ id: '10', type: 'answer', text: '', completeness: { body: 'unknown' } }], comments: [] });
  const legacy = structuredClone(initial);
  (legacy.zhihu.localOperations as unknown as { version: number }).version = 2;
  const cache = await import('../utils/exportViewerCache');
  await cache.saveLastExportPersistent(legacy);
  const opened = prepareZhihuForViewing(legacy);
  const corrected = sendZhihuLocalRelation(opened, { relationType: 'CORRECT', targetMessageIds: ['zhihu:item:answer:10'], correctionField: 'body', content: '本地字段验证' });
  await cache.saveLastExportPersistent(corrected, opened);
  expect(corrected.zhihu.overrides).toEqual(opened.zhihu.overrides);
  await expect(cache.saveLastExportPersistent(opened, opened)).rejects.toThrow('已在其他标签页更新');
  expect(await cache.loadCachedExport(corrected.zhihu.archiveId, { fresh: true })).toEqual(corrected);
});
