import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { prepareZhihuForViewing, sendZhihuLocalRelation, type ZhihuArchive } from '../utils/zhihuArchive';
import { mergeZhihuSourceUpdate } from '../utils/zhihuIncremental';
import { appendZhihuJournal, readZhihuDirectory as readDirectory, refreshZhihuDirectory, requireDirectoryPermission, ZHIHU_LOCAL_JOURNAL } from '../utils/zhihuDirectory';
const readZhihuDirectory = async (handle: FileSystemDirectoryHandle) => {
  const result = await readDirectory(handle);
  return { ...result, data: result.data as ReturnType<typeof prepareZhihuForViewing> };
};

const target = 'zhihu:item:article:1';
function source(extra = false): ZhihuArchive {
  return { format: 'gonglun-zhihu-archive', version: 1, owner: { id: 'fixture-owner' },
    items: [{ id: '1', type: 'article', text: '技术字段' }, ...(extra ? [{ id: '2', type: 'article' as const, text: '新增技术字段' }] : [])],
    comments: [{ id: '1', sourceId: '1', threadId: 'article:1', text: '', rootCommentId: '1', parentCommentId: null }] };
}
const reply = (data = prepareZhihuForViewing(source())) => sendZhihuLocalRelation(data, { relationType: 'REPLY', sourceMessageIds: ['zhihu:comment:article%3A1:1'], targetMessageIds: [target], note: '本地技术字段' });

function directoryFixture() {
  const files = new Map<string, { text: string; time: number }>();
  let time = 1, failClose = false;
  const write = (name: string, text: string) => files.set(name, { text, time: time++ });
  write('gonglun.json', JSON.stringify(source()));
  const handle = { name: 'fixture-collection', queryPermission: vi.fn(async () => 'granted'), requestPermission: vi.fn(async () => 'granted'),
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException('missing', 'NotFoundError');
        write(name, '');
      }
      return { getFile: vi.fn(async () => { const file = files.get(name)!; return { size: new TextEncoder().encode(file.text).length, lastModified: file.time, text: async () => file.text }; }),
        createWritable: async () => {
          let next = files.get(name)!.text, at = 0;
          return { seek: async (offset: number) => { at = offset; }, write: async (text: string) => {
            const prefix = new TextDecoder().decode(new TextEncoder().encode(next).slice(0, at)); next = prefix + text;
          }, close: async () => { if (failClose) throw new Error('disk full'); write(name, next); }, abort: vi.fn(async () => {}) };
        } };
    }) };
  let lock = Promise.resolve();
  vi.stubGlobal('navigator', { locks: { request: (_name: string, run: () => Promise<void>) => {
    const pending = lock.then(run); lock = pending.catch(() => undefined); return pending;
  } } });
  return { handle: handle as unknown as FileSystemDirectoryHandle, files, write, fail: (value: boolean) => { failClose = value; } };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

it('adds source records while preserving replies, stances and the entire original source', () => {
  const local = sendZhihuLocalRelation(reply(), { relationType: 'AGREE', targetMessageIds: [target] });
  const incoming = prepareZhihuForViewing(source(true));
  const next = mergeZhihuSourceUpdate(local, incoming);
  expect(next.zhihu.archive).toEqual(incoming.zhihu.archive);
  expect(next.zhihu.localOperations).toEqual(local.zhihu.localOperations);
  expect(next.messages.some(message => message.id === 'zhihu:item:article:2')).toBe(true);
  expect(mergeZhihuSourceUpdate(next, incoming).zhihu.localOperations).toEqual(local.zhihu.localOperations);
});

it('accepts changed original text only when its prior observation is retained and keeps correction evidence', () => {
  const first = source(), local = sendZhihuLocalRelation(prepareZhihuForViewing(first), {
    relationType: 'CORRECT', targetMessageIds: [target], content: '本地补充', correctionField: 'body' });
  const next = source(); next.items[0] = { ...next.items[0], text: '更新后的技术字段', versions: [first.items[0], { ...first.items[0], text: '更新后的技术字段' }] };
  const merged = mergeZhihuSourceUpdate(local, prepareZhihuForViewing(next));
  expect(merged.zhihu.localOperations).toEqual(local.zhihu.localOperations);
  expect(merged.zhihu.archive.items[0].text).toBe('更新后的技术字段');
  expect(Object.values(merged.zhihu.byMessageId).some(value => value.kind === 'local-correction' && value.correctionApplicable === false)).toBe(true);
  delete next.items[0].versions;
  expect(() => mergeZhihuSourceUpdate(local, prepareZhihuForViewing(next))).toThrow('历史版本');
});

it('rejects deleted source records, another owner/scope and divergent local histories', () => {
  const local = reply(), removed = source(); removed.items = [];
  expect(() => mergeZhihuSourceUpdate(local, prepareZhihuForViewing(removed))).toThrow('缺少已有原文');
  const other = source(); other.owner = { id: 'another-owner' };
  expect(() => mergeZhihuSourceUpdate(local, prepareZhihuForViewing(other))).toThrow('不同用户');
  const scope = source(); scope.activitySource = { version: 1, scope: 'activities', events: [], folders: [], unparsedRecords: [],
    coverage: { scope: 'activities', status: 'complete', pagesComplete: true, allHistoryComplete: false, reason: '' } };
  expect(() => mergeZhihuSourceUpdate(local, prepareZhihuForViewing(scope))).toThrow('资料范围');
  expect(() => mergeZhihuSourceUpdate(local, reply())).toThrow('分叉');
});

it('retains collection-folder and event history while adopting new members and current coverage', () => {
  const previous = source();
  previous.activitySource = { version: 1, scope: 'collections', unparsedRecords: [],
    folders: [{ id: 'folder-1', title: '技术收藏夹', description: '', creator: null, createdAt: null, updatedAt: null,
      isPublic: false, itemCount: 1, url: 'https://www.zhihu.com/collection/folder-1', sourceUrl: '', capturedAt: '' }],
    events: [{ id: 'event-1', sourceId: 'event-1', identity: 'source', kind: 'collection-item', actor: null, verb: 'collect',
      actionText: null, type: 'article', target: { type: 'article', id: '1', url: null, author: null }, folderId: 'folder-1',
      createdAt: null, createdAtText: null, sourceUrl: '', capturedAt: '' }],
    coverage: { scope: 'collections', status: 'complete', pagesComplete: true, allHistoryComplete: false, reason: '', currentEventIds: ['event-1'] } };
  const initial = reply(prepareZhihuForViewing(previous)), incoming = source(true);
  incoming.activitySource = structuredClone(previous.activitySource);
  const folder = incoming.activitySource.folders[0];
  folder.versions = [structuredClone(previous.activitySource.folders[0]), { ...folder, itemCount: 2 }]; folder.itemCount = 2;
  incoming.activitySource.events.push({ ...incoming.activitySource.events[0], id: 'event-2', sourceId: 'event-2', target: { type: 'article', id: '2', url: null, author: null } });
  incoming.activitySource.coverage.currentEventIds = ['event-1', 'event-2'];
  const next = mergeZhihuSourceUpdate(initial, prepareZhihuForViewing(incoming));
  expect(next.zhihu.archiveId).toBe(initial.zhihu.archiveId);
  expect(next.zhihu.archive.activitySource?.events).toHaveLength(2);
  expect(next.zhihu.localOperations).toEqual(initial.zhihu.localOperations);
  incoming.activitySource.events.shift();
  expect(() => mergeZhihuSourceUpdate(initial, prepareZhihuForViewing(incoming))).toThrow('历史版本');
});

it('appends only newly added local records to one file and reopens them on a newer full export', async () => {
  const fixture = directoryFixture(), opened = await readZhihuDirectory(fixture.handle), local = reply(opened.data);
  await appendZhihuJournal(opened.connection, local);
  const first = fixture.files.get(ZHIHU_LOCAL_JOURNAL)!.text;
  expect(first).not.toContain('gonglun-zhihu-archive');
  await appendZhihuJournal(opened.connection, local);
  expect(fixture.files.get(ZHIHU_LOCAL_JOURNAL)!.text).toBe(first);
  const next = sendZhihuLocalRelation(local, { relationType: 'DISAGREE', targetMessageIds: [target] });
  await appendZhihuJournal(opened.connection, next);
  const lines = fixture.files.get(ZHIHU_LOCAL_JOURNAL)!.text.trim().split('\n').map(line => JSON.parse(line));
  expect(lines).toHaveLength(2);
  expect(lines[1].added.operations).toHaveLength(1);
  expect(lines[1].base.operations).toBe(1);
  expect(lines[1].previous).toBe(lines[0].digest);
  fixture.write('gonglun.json', JSON.stringify(source(true)));
  const reopened = await readZhihuDirectory(fixture.handle);
  expect(reopened.data.zhihu.archive.items).toHaveLength(2);
  expect(reopened.data.zhihu.localOperations).toEqual(next.zhihu.localOperations);
  expect(fixture.files.get('gonglun.json')!.text).toBe(JSON.stringify(source(true)));
});

it('does no document conversion on an unchanged polling check and safely retries a failed append', async () => {
  const fixture = directoryFixture(), opened = await readZhihuDirectory(fixture.handle);
  const refreshed = await refreshZhihuDirectory(opened.connection, opened.data);
  expect(refreshed.data).toBe(opened.data);
  const local = reply(opened.data);
  fixture.fail(true);
  await expect(appendZhihuJournal(opened.connection, local)).rejects.toThrow('disk full');
  fixture.fail(false);
  await appendZhihuJournal(opened.connection, local);
  expect((await readZhihuDirectory(fixture.handle)).data.zhihu.localOperations).toEqual(local.zhihu.localOperations);
});

it('refuses damaged/truncated logs and stale writers without overwriting the file', async () => {
  const fixture = directoryFixture(), opened = await readZhihuDirectory(fixture.handle), local = reply(opened.data);
  await appendZhihuJournal(opened.connection, local);
  const intact = fixture.files.get(ZHIHU_LOCAL_JOURNAL)!.text;
  await expect(appendZhihuJournal(opened.connection, opened.data)).rejects.toThrow('更新或存在分叉');
  expect(fixture.files.get(ZHIHU_LOCAL_JOURNAL)!.text).toBe(intact);
  fixture.write(ZHIHU_LOCAL_JOURNAL, intact.replace('本地技术字段', '损坏技术字段'));
  await expect(readZhihuDirectory(fixture.handle)).rejects.toThrow('校验失败');
  fixture.write(ZHIHU_LOCAL_JOURNAL, intact.trimEnd());
  await expect(readZhihuDirectory(fixture.handle)).rejects.toThrow('末尾不完整');
});

it('rechecks the journal under the browser lock so simultaneous writers cannot erase a winning append', async () => {
  const fixture = directoryFixture(), opened = await readZhihuDirectory(fixture.handle);
  const results = await Promise.allSettled([appendZhihuJournal(opened.connection, reply(opened.data)), appendZhihuJournal(opened.connection, reply(opened.data))]);
  expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(fixture.files.get(ZHIHU_LOCAL_JOURNAL)!.text.trim().split('\n')).toHaveLength(1);
  expect((await readZhihuDirectory(fixture.handle)).data.zhihu.localOperations.operations).toHaveLength(1);
});

it('only asks the browser to renew directory permission after an explicit click', async () => {
  const fixture = directoryFixture(), opened = await readZhihuDirectory(fixture.handle);
  const handle = fixture.handle as unknown as { queryPermission: ReturnType<typeof vi.fn>; requestPermission: ReturnType<typeof vi.fn> };
  handle.queryPermission.mockResolvedValue('prompt');
  await expect(requireDirectoryPermission(opened.connection)).rejects.toThrow('权限需要恢复');
  expect(handle.requestPermission).not.toHaveBeenCalled();
  await expect(requireDirectoryPermission(opened.connection, true)).resolves.toBeUndefined();
  expect(handle.requestPermission).toHaveBeenCalledOnce();
});

it('persists local sends without rewriting the source and restores their head after a reload', async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  const cache = await import('../utils/exportViewerCache'), initial = prepareZhihuForViewing(source());
  await cache.saveLastExport(initial);
  const put = vi.spyOn(IDBObjectStore.prototype, 'put');
  const local = reply(initial);
  await cache.saveLastExportPersistent(local, initial);
  const values = put.mock.calls.map(call => call[0]);
  expect(values.some(value => value?.data?.zhihu?.archive)).toBe(false);
  expect(values.some(value => value?.state?.localOperations.operations.length === 1)).toBe(true);
  vi.resetModules();
  const reopened = await (await import('../utils/exportViewerCache')).loadLastExport();
  expect(prepareZhihuForViewing(reopened).zhihu.localOperations).toEqual(local.zhihu.localOperations);
});

it('restores compact edited sources without first rebuilding a graph that the viewer would immediately discard', async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  const cache = await import('../utils/exportViewerCache'), initial = prepareZhihuForViewing(source());
  await cache.saveLastExport(initial);
  const reference = cache.getExportCacheReference(initial)!;
  await cache.saveLastExportPersistent(reply(initial), initial);
  vi.resetModules();
  const model = await import('../utils/zhihuArchive'), project = vi.spyOn(model, 'prepareZhihuForViewing');
  const reloaded = await import('../utils/exportViewerCache');
  const compact = await reloaded.loadReferencedExport(reference, { sourceOnly: true });
  expect(compact).toMatchObject({ format: 'gonglun-zhihu-reviewed', localOperations: { operations: [expect.anything()] } });
  expect(compact).not.toHaveProperty('messages');
  expect(project).not.toHaveBeenCalled();
});

it('keeps the opened document identity, local edits and settings when a growing own-work export changes archive IDs', async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  const cache = await import('../utils/exportViewerCache'), initial = reply();
  await cache.saveLastExport(initial);
  const reference = cache.getExportCacheReference(initial)!;
  const next = mergeZhihuSourceUpdate(initial, prepareZhihuForViewing(source(true)));
  expect(next.zhihu.archiveId).not.toBe(initial.zhihu.archiveId);
  await cache.saveLastExportPersistent(next, initial, { sourceUpdate: true });
  expect(cache.getExportCacheReference(next)).toEqual(reference);
  vi.resetModules(); sessionStorage.clear();
  const restoredCache = await import('../utils/exportViewerCache');
  const restored = prepareZhihuForViewing(await restoredCache.loadLastExport());
  expect(restored.zhihu.archive).toEqual(next.zhihu.archive);
  expect(restored.zhihu.localOperations).toEqual(initial.zhihu.localOperations);
  expect(await restoredCache.loadCachedExport(next.zhihu.archiveId, { fresh: true })).toEqual(restored);
});

it('deletes abandoned Zhihu editing data on upgrade while preserving ordinary Gonglun files', async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  const initial = reply(), archiveId = `zhihu:${initial.zhihu.archiveId}`;
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('gonglun-export-viewer', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('archives');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, transaction = db.transaction('archives', 'readwrite'), store = transaction.objectStore('archives');
      store.put({ archiveId, viewCacheId: 'legacy-view', data: initial }, archiveId);
      const { zhihu: _source, ...native } = initial;
      store.put({ archiveId: 'native-cache', viewCacheId: 'native-view', data: native }, 'native-cache');
      store.put({ directory: 'obsolete' }, '__zhihu_directory__:legacy-view');
      store.put({ mode: 'discussion', collapsed: ['old-fold'] }, '__discussion_view__:legacy-view');
      store.put({ archiveId }, '__last_viewed_archive__');
      transaction.oncomplete = () => { db.close(); resolve(); };
    };
  });
  sessionStorage.setItem('lastExportData', JSON.stringify({ archiveId }));
  const cache = await import('../utils/exportViewerCache');
  expect(await cache.loadLastExport()).toBeNull();
  expect(await cache.loadCachedExport(initial.zhihu.archiveId)).toBeNull();
  const restored = await cache.loadReferencedExport({ archiveId: 'native-cache', viewCacheId: 'native-view' });
  expect(restored).not.toHaveProperty('zhihu');
  expect(restored).toHaveProperty('messages');
  expect(await cache.withArchiveStore('readonly', store => store.get('__zhihu_directory__:legacy-view'))).toBeUndefined();
  expect(await cache.withArchiveStore('readonly', store => store.get('__discussion_view__:legacy-view'))).toBeUndefined();
  await expect(new Promise<void>((resolve, reject) => {
    const old = indexedDB.open('gonglun-export-viewer', 1); old.onerror = () => reject(old.error);
    old.onsuccess = () => { old.result.close(); resolve(); };
  })).rejects.toMatchObject({ name: 'VersionError' });
});

it('resolves a source-refresh/send race in one cache transaction without losing the winner', async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  const firstTab = await import('../utils/exportViewerCache'), initial = prepareZhihuForViewing(source());
  await firstTab.saveLastExport(initial);
  vi.resetModules();
  const secondTab = await import('../utils/exportViewerCache');
  const second = await secondTab.loadCachedExport(initial.zhihu.archiveId, { fresh: true }) as typeof initial;
  const local = reply(initial), incoming = mergeZhihuSourceUpdate(second, prepareZhihuForViewing(source(true)));
  const results = await Promise.allSettled([
    firstTab.saveLastExportPersistent(local, initial), secondTab.saveLastExportPersistent(incoming, second, { sourceUpdate: true }),
  ]);
  expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  const restored = prepareZhihuForViewing(await secondTab.loadCachedExport(initial.zhihu.archiveId, { fresh: true }));
  expect(restored).toEqual(results[0].status === 'fulfilled' ? local : incoming);
});
