import { expect, it, vi, afterEach } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { prepareZhihuForViewing, getZhihuDisplayFields } from '../utils/zhihuArchive';
import { prepareExportForViewing } from '../utils/exportArchive';
import { nativeZhihuDocument, nativeZhihuEditingView, sendNativeZhihuRelation, serializeNativeZhihuView } from '../utils/nativeZhihuEditor';
import { isNativeZhihuView, isNativeLocalMessage } from '../utils/nativeZhihuView';
import { mergeNativeZhihuUpdate, nativeZhihuIdentity } from '../utils/nativeZhihuView';
import { appendNativeJournal, restoreNativeJournal } from '../utils/nativeZhihuJournal';
import type { LinkedDirectory } from '../utils/zhihuDirectory';
import { archiveToWorkbenchSnapshot } from '../utils/workbenchProjection';

async function fixture() {
  const { zhihu: _legacy, ...data } = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: [{ id: '1', type: 'answer', text: '技术正文', question: { id: 'q', title: '技术标题', text: '技术描述' } }],
    comments: [{ id: 'c', sourceId: 'c', threadId: 'answer:1', text: '技术评论', parentCommentId: null, rootCommentId: 'c' }] });
  const native = (await prepareExportForViewing({ ...data,
    source: { provider: 'zhihu', version: 1, scope: 'own', ownerId: 'fixture-owner', ownerUrl: null } })).data;
  if (!isNativeZhihuView(native)) throw new Error('Invalid fixture'); return native;
}
const item = 'zhihu:item:answer:1', comment = 'zhihu:comment:answer%3A1:c';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

it('uses source identity to enable native Zhihu editing with a local actor', async () => {
  const data = await fixture(), view = nativeZhihuEditingView(data);
  expect(data.viewerUsername).toBe('本地整理者');
  expect(view.zhihu.byMessageId[item].kind).toBe('item');
  expect(view.zhihu.byMessageId[comment].kind).toBe('comment');
  expect(data).not.toHaveProperty('zhihu');
});

it('adds replies, opposes and restores them across independent sends without changing the source', async () => {
  const initial = await fixture(), before = structuredClone(initial);
  const first = nativeZhihuDocument(sendNativeZhihuRelation(initial, { relationType: 'REPLY', sourceMessageIds: [comment], targetMessageIds: [item] }));
  const reply = first.messages.find(message => isNativeLocalMessage(message) && message.relationType === 'REPLY')!;
  const opposed = nativeZhihuDocument(sendNativeZhihuRelation(first, { relationType: 'DISAGREE', targetMessageIds: [reply.id] }));
  expect(nativeZhihuEditingView(opposed).zhihu.inactiveRelationIds).toContain(reply.id);
  const restored = nativeZhihuDocument(sendNativeZhihuRelation(opposed, { relationType: 'AGREE', targetMessageIds: [reply.id] }));
  expect(nativeZhihuEditingView(restored).zhihu.inactiveRelationIds).not.toContain(reply.id);
  const reopened = (await prepareExportForViewing(JSON.parse(serializeNativeZhihuView(restored)))).data;
  expect(isNativeZhihuView(reopened)).toBe(true);
  expect(reopened).not.toHaveProperty('zhihu');
  expect(initial).toEqual(before);
});

it('keeps body and title corrections native and can withdraw them later', async () => {
  const initial = await fixture();
  const body = nativeZhihuDocument(sendNativeZhihuRelation(initial, { relationType: 'CORRECT', targetMessageIds: [item], correctionField: 'body', content: '更正技术正文' }));
  expect(getZhihuDisplayFields(nativeZhihuEditingView(body), item).body).toBe('更正技术正文');
  const titled = nativeZhihuDocument(sendNativeZhihuRelation(body, { relationType: 'CORRECT', targetMessageIds: ['zhihu:question:q'], correctionField: 'title', content: '更正技术标题' }));
  expect(getZhihuDisplayFields(nativeZhihuEditingView(titled), 'zhihu:question:q').title).toBe('更正技术标题');
  const bodyCorrection = body.messages.find(message => isNativeLocalMessage(message) && message.relationType === 'CORRECT')!;
  const withdrawn = nativeZhihuDocument(sendNativeZhihuRelation(titled, { relationType: 'DISAGREE', targetMessageIds: [bodyCorrection.id] }));
  expect(getZhihuDisplayFields(nativeZhihuEditingView(withdrawn), item).body).toBe('技术正文');
});

it('retains membership history while adding members and moving them between native containers', async () => {
  const initial = await fixture();
  const classified = nativeZhihuDocument(sendNativeZhihuRelation(initial, { relationType: 'CLASSIFY', targetMessageIds: [comment], title: '技术分类' }));
  const group = classified.messages.find(message => isNativeLocalMessage(message) && message.relationType === 'CLASSIFY')!;
  const appended = nativeZhihuDocument(sendNativeZhihuRelation(classified, { relationType: 'CLASSIFY', sourceMessageIds: [group.id], targetMessageIds: [item] }));
  expect(nativeZhihuEditingView(appended).zhihu.membershipParents[item]).toBe(group.id);
  expect(nativeZhihuEditingView(appended).zhihu.membershipParents[comment]).toBe(group.id);
  const arranged = nativeZhihuDocument(sendNativeZhihuRelation(appended, { relationType: 'ARRANGE', targetMessageIds: [item], targetLayout: 'single-row' }));
  const arrangement = arranged.messages.find(message => isNativeLocalMessage(message) && message.relationType === 'ARRANGE')!;
  expect(nativeZhihuEditingView(arranged).zhihu.membershipParents[item]).toBe(arrangement.id);
  expect(nativeZhihuEditingView(arranged).zhihu.membershipParents[comment]).toBe(group.id);
});

it('saves only native local records to the cache and reloads them without the old envelope', async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  const cache = await import('../utils/exportViewerCache'), initial = await fixture();
  await cache.saveLastExport(initial);
  const reference = cache.getExportCacheReference(initial)!;
  const next = nativeZhihuDocument(sendNativeZhihuRelation(initial, { relationType: 'AGREE', targetMessageIds: [item] }));
  const put = vi.spyOn(IDBObjectStore.prototype, 'put');
  await cache.saveLastExportPersistent(next, initial);
  expect(put.mock.calls.some(call => call[0]?.data)).toBe(false);
  expect(cache.getExportCacheReference(next)).toEqual(reference);
  vi.resetModules();
  const reopened = await (await import('../utils/exportViewerCache')).loadReferencedExport(reference);
  expect(reopened).toEqual(next);
  expect(reopened).not.toHaveProperty('zhihu');
});

it('retains native edits across source updates and stops applying a correction whose base changed', async () => {
  const initial = await fixture();
  const local = nativeZhihuDocument(sendNativeZhihuRelation(initial, { relationType: 'CORRECT', targetMessageIds: [item], content: '本地更正正文', correctionField: 'body' }));
  const incoming = await fixture();
  incoming.messages = incoming.messages.map(message => message.id === item ? { ...message, content: '更新后的原文',
    parts: message.parts?.map(part => part.id === 'body' && part.type === 'text' ? { ...part, text: '更新后的原文' } : part) } : message);
  const merged = mergeNativeZhihuUpdate(local, incoming);
  expect(merged.messages.filter(isNativeLocalMessage)).toHaveLength(local.messages.filter(isNativeLocalMessage).length);
  const correction = merged.messages.find(message => message.relationType === 'CORRECT')!;
  expect(nativeZhihuEditingView(merged).zhihu.inactiveRelationIds).toContain(correction.id);
  expect(archiveToWorkbenchSnapshot(merged).relations.find(relation => relation.id === correction.id)?.payload?.localCorrectionApplicable).toBe(false);
});

it('appends canonical native messages once and reopens them from the same folder after a new export', async () => {
  const initial = await fixture(), files = new Map<string, string>();
  const directory = { getFileHandle: async (name: string, options?: { create?: boolean }) => {
    if (!files.has(name) && !options?.create) throw new DOMException('Missing', 'NotFoundError');
    if (!files.has(name)) files.set(name, '');
    return { getFile: async () => ({ size: new TextEncoder().encode(files.get(name)!).length, lastModified: 1, text: async () => files.get(name)! }),
      createWritable: async () => {
        let next = files.get(name)!;
        return { seek: async () => {}, write: async (text: string) => { next += text; }, close: async () => { files.set(name, next); }, abort: async () => {} };
      } };
  } } as unknown as FileSystemDirectoryHandle;
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, run: () => Promise<void>) => run() } });
  const connection: LinkedDirectory = { directory, sourceName: 'gonglun.json', documentId: nativeZhihuIdentity(initial), signature: '' };
  const first = nativeZhihuDocument(sendNativeZhihuRelation(initial, { relationType: 'REPLY', sourceMessageIds: [comment], targetMessageIds: [item] }));
  await appendNativeJournal(connection, first);
  const originalLog = files.get('gonglun-local.ndjson')!;
  const record = JSON.parse(originalLog);
  expect(record.format).toBe('gonglun-native-messages');
  expect(record).not.toHaveProperty('operations');
  expect(record.messages.every((message: { content?: string }) => message.content === undefined)).toBe(true);
  await appendNativeJournal(connection, first);
  expect(files.get('gonglun-local.ndjson')).toBe(originalLog);
  const second = nativeZhihuDocument(sendNativeZhihuRelation(first, { relationType: 'AGREE', targetMessageIds: [item] }));
  await appendNativeJournal(connection, second);
  expect(files.get('gonglun-local.ndjson')!.trim().split('\n')).toHaveLength(2);
  const reopened = await restoreNativeJournal(connection, await fixture());
  expect(reopened.messages.filter(isNativeLocalMessage).map(message => message.id)).toEqual(second.messages.filter(isNativeLocalMessage).map(message => message.id));
  expect(reopened).not.toHaveProperty('zhihu');
  await expect(appendNativeJournal(connection, initial)).rejects.toThrow('更新或存在分叉');
  expect(files.get('gonglun-local.ndjson')!.trim().split('\n')).toHaveLength(2);
});
