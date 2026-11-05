import { afterEach, expect, it, vi } from 'vitest';
import { prepareZhihuForViewing } from '../utils/zhihuArchive';
import { prepareExportForViewing } from '../utils/exportArchive';
import { prepareArchiveExport } from '../utils/exportTask';
import { isNativeLocalMessage, isNativeZhihuView, mergeNativeZhihuUpdate, type NativeZhihuView } from '../utils/nativeZhihuView';
import { nativeZhihuDocument, sendNativeZhihuRelation, serializeNativeZhihuView } from '../utils/nativeZhihuEditor';

const item = 'zhihu:item:article:1';
async function fixture(extra = false) {
  const { zhihu: _legacy, ...data } = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: [{ id: '1', type: 'article', text: '原文' }, { id: '2', type: 'article', text: '另一原文' }, ...(extra ? [{ id: '3', type: 'article', text: '新增原文' }] : [])], comments: [] });
  const result = (await prepareExportForViewing({ ...data,
    source: { provider: 'zhihu', version: 1, scope: 'collections', ownerId: 'fixture-owner', ownerUrl: null } })).data;
  if (!isNativeZhihuView(result)) throw new Error('Invalid fixture');
  return result;
}
const file = (data: NativeZhihuView) => ({ text: async () => serializeNativeZhihuView(data) }) as Blob;
const read = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob);
});
async function update(original: NativeZhihuView, current: NativeZhihuView, view = current.view) {
  return prepareArchiveExport({ task: { kind: 'update', file: file(original), source: current, view }, apiUrl: '/api/ui' }, () => {});
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('exports a compact independent snapshot locally, with the selected view', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const source = await fixture();
  const view = { username: '本地整理者', mode: 'graph' as const, classificationId: null,
    messageFilter: { hideJoin: false, hideSettlement: true }, homeFilter: null, cleanFilters: [],
    discussion: { mode: 'discussion' as const, collapsed: [JSON.stringify([item, 'reply'])] } };
  const result = await prepareArchiveExport({ task: { kind: 'full', scopeMessageId: 'root', source, view }, apiUrl: '/api/ui' }, () => {});
  const data = JSON.parse(await read(result.blob));
  expect(data.source).toEqual(source.source);
  expect(data.view).toEqual(view);
  expect(data).not.toHaveProperty('zhihu');
  expect(data.messages.every((row: { content?: string }) => row.content === undefined)).toBe(true);
  expect(isNativeZhihuView((await prepareExportForViewing(data)).data)).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it('adds source updates and native local messages once while preserving replies, stances and corrections', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const initial = await fixture();
  const replied = nativeZhihuDocument(sendNativeZhihuRelation(initial, { relationType: 'REPLY', sourceMessageIds: ['zhihu:item:article:2'], targetMessageIds: [item] }));
  const reply = replied.messages.find(message => isNativeLocalMessage(message) && message.relationType === 'REPLY')!;
  const opposed = nativeZhihuDocument(sendNativeZhihuRelation(replied, { relationType: 'DISAGREE', targetMessageIds: [reply.id] }));
  const corrected = nativeZhihuDocument(sendNativeZhihuRelation(opposed, { relationType: 'CORRECT', targetMessageIds: [item], correctionField: 'body', content: '本地更正' }));
  const current = mergeNativeZhihuUpdate(corrected, await fixture(true)), before = structuredClone(replied);
  const first = await update(replied, current), saved = (await prepareExportForViewing(JSON.parse(await read(first.blob)))).data;
  expect(saved.messages.map(message => message.id)).toEqual(current.messages.map(message => message.id));
  expect(saved.relations.map(message => message.id)).toEqual(current.relations.map(message => message.id));
  expect(first.added).toBe(current.messages.length - replied.messages.length);
  expect(replied).toEqual(before);
  expect(saved).not.toHaveProperty('zhihu');
  const repeated = await update(saved as NativeZhihuView, current);
  expect(repeated.added).toBe(0);
  expect((JSON.parse(await read(repeated.blob)) as NativeZhihuView).messages).toEqual(JSON.parse(await read(first.blob)).messages);
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps a compatible longer local history in the chosen file and uses the current view', async () => {
  const initial = await fixture();
  const newerFile = nativeZhihuDocument(sendNativeZhihuRelation(initial, { relationType: 'AGREE', targetMessageIds: [item] }));
  const view = { username: '本地整理者', mode: 'list' as const, classificationId: null,
    messageFilter: { hideJoin: true, hideSettlement: true }, homeFilter: null, cleanFilters: [] };
  const result = await update(newerFile, initial, view), saved = JSON.parse(await read(result.blob));
  expect(saved.messages.filter(isNativeLocalMessage).map((row: { id: string }) => row.id)).toEqual(newerFile.messages.filter(isNativeLocalMessage).map(row => row.id));
  expect(saved.view).toEqual(view);
});

it('rejects a different source, missing source records and diverging local histories', async () => {
  const initial = await fixture();
  await expect(update(initial, { ...initial, source: { ...initial.source, ownerId: 'another' } })).rejects.toThrow('不同用户');
  await expect(update(await fixture(true), initial)).rejects.toThrow('缺少已有原文');
  const one = nativeZhihuDocument(sendNativeZhihuRelation(initial, { relationType: 'AGREE', targetMessageIds: [item] }));
  const two = nativeZhihuDocument(sendNativeZhihuRelation(initial, { relationType: 'DISAGREE', targetMessageIds: [item] }));
  await expect(update(one, two)).rejects.toThrow('分叉');
});
