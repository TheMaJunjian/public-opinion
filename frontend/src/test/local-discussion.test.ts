import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { ExportData } from '../api/client';
import { LocalDiscussion } from '../utils/localDiscussion';
import { createLocalMessageFile } from '../utils/localMessageFile';
import { validateExportForViewing } from '../utils/exportArchive';
import { getExportCacheReference, loadReferencedExport, saveLastExport, saveLastExportPersistent } from '../utils/exportViewerCache';
import { computeCorrectionVersions, computeEffectiveSuppressedRelIds, convertMessagesToDemoModel } from '../utils/modelBridge';
import { archiveToWorkbenchSnapshot } from '../utils/workbenchProjection';

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); sessionStorage.clear(); localStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());
const target = (id: string) => ({ kind: 'message' as const, messageId: id });
async function saved(draft: LocalDiscussion) {
  let result!: ExportData;
  await draft.commit(async data => { result = data; });
  return result;
}

it('records multiple local participants and full relations, preserving identity after export and reopening', async () => {
  const original = createLocalMessageFile(), alice = new LocalDiscussion(original, '甲');
  const first = await alice.createMessage('root', { content: '讨论议题' });
  const initial = await saved(alice), bob = new LocalDiscussion(initial, '乙');
  const reply = await bob.createMessage('root', { content: '我的回复' });
  await bob.createRelation('root', { relationType: 'REPLY', sourceMessageId: reply.id, targetRefs: [target(first.id)] });
  await bob.createRelation('root', { relationType: 'REFERENCE', sourceMessageId: reply.id, targetRefs: [target(first.id)], payload: { label: '依据' } });
  await bob.createRelation('root', { relationType: 'DISAGREE', targetRefs: [target(first.id)] });
  const document = validateExportForViewing(JSON.parse(JSON.stringify(await saved(bob)))).data;
  const returned = new LocalDiscussion(document, '甲');
  const next = await returned.createMessage('root', { content: '补充说明' });
  expect(next.createdBy.id).toBe(first.createdBy.id);
  expect(document.messages.map(message => message.author)).toEqual(['甲', '乙', '乙', '乙', '乙']);
  expect(document.relations.map(relation => relation.relationType)).toEqual(['REPLY', 'REFERENCE', 'DISAGREE']);
  expect(document.users?.map(user => user.username)).toEqual(['甲', '乙']);
  expect(document.messages.every(message => message.spending?.protocol === 0 && message.spending?.wager === 0)).toBe(true);
  expect(document).not.toHaveProperty('zhihu');
  expect(original.messages).toEqual([]);
});

it('creates nested classification membership and text corrections without changing the imported message', async () => {
  const draft = new LocalDiscussion(createLocalMessageFile(), '主持人');
  const first = await draft.createMessage('root', { content: '原文' });
  const category = await draft.createRelation('root', { relationType: 'CLASSIFY', targetRefs: [target(first.id)], payload: { title: '议题' } });
  const second = await draft.createMessage(category.id, { content: '分类内消息' });
  await draft.createRelation('root', { relationType: 'CORRECT', targetRefs: [{ ...target(first.id), reference: { messageId: first.id, revision: 1, partId: 'body', path: ['text'] } }], payload: { correctionContent: '更正后', correctionKind: 'TEXT' } });
  const data = await saved(draft);
  expect(data.messages.find(row => row.id === first.id)?.content).toBe('原文');
  const snapshot = archiveToWorkbenchSnapshot(data);
  const projected = convertMessagesToDemoModel(snapshot.messages, snapshot.relations);
  expect(projected.messages.find(row => row.relationType === 'correct')?.content).toBe('更正后');
  expect(computeCorrectionVersions(projected.messages, projected.edges).get(first.id)?.current?.content).toBe('更正后');
  const joins = data.relations.filter(relation => relation.relationType === 'JOIN');
  expect(joins.map(relation => (relation.payload as { membershipHistory: { memberId: string; parentId: string } }).membershipHistory))
    .toEqual(expect.arrayContaining([expect.objectContaining({ memberId: first.id, parentId: category.id }), expect.objectContaining({ memberId: second.id, parentId: category.id })]));
  expect(data.messages.find(message => message.id === joins[0].id)?.parts?.find(part => part.id === 'membership-history')).toMatchObject({ value: { membershipHistory: { memberId: first.id } } });
});

it('updates local tags, follows and each participant’s stance without changing imported statistics', async () => {
  const initial = new LocalDiscussion(createLocalMessageFile(), '甲');
  const text = await initial.createMessage('root', { content: '可讨论的消息' });
  const message = await initial.createRelation('root', { relationType: 'CLASSIFY', targetRefs: [target(text.id)], payload: { title: '议题' } });
  const source = await saved(initial), bob = new LocalDiscussion(source, '乙');
  await bob.createRelation('root', { relationType: 'DISAGREE', targetRefs: [target(message.id)] });
  await bob.createRelation('root', { relationType: 'TAG', targetRefs: [target(message.id)], payload: { subType: 'IMPORTANT' } });
  await bob.createRelation('root', { relationType: 'ATTENTION', targetRefs: [target(message.id)], payload: { subType: 'YES' } });
  const followed = await saved(bob), alice = new LocalDiscussion(followed, '甲');
  await alice.createRelation('root', { relationType: 'AGREE', targetRefs: [target(message.id)] });
  const data = await saved(alice), snapshot = archiveToWorkbenchSnapshot(data);
  const projected = convertMessagesToDemoModel(snapshot.messages, snapshot.relations);
  expect(computeEffectiveSuppressedRelIds(projected.edges, projected.messages, '乙').has(message.id)).toBe(true);
  expect(computeEffectiveSuppressedRelIds(projected.edges, projected.messages, '甲').has(message.id)).toBe(false);
  expect(data.tagCounts?.[message.id]).toEqual({ TAG: 1, IMPORTANT: 1 });
  expect(data.attentionUsers?.[message.id]).toEqual([bob.user.id]);
  expect(source.tagCounts).toEqual({}); expect(source.attentionUsers).toEqual({});
  const unfollow = new LocalDiscussion(data, '乙');
  await unfollow.createRelation('root', { relationType: 'ATTENTION', targetRefs: [target(message.id)], payload: { subType: 'NO' } });
  expect((await saved(unfollow)).attentionUsers?.[message.id]).toEqual([]);
});

it('aborts the entire draft on a missing reference or cyclic membership', async () => {
  const draft = new LocalDiscussion(createLocalMessageFile(), '甲');
  await draft.createMessage('root', { content: '尚未保存' });
  await expect(draft.createRelation('root', { relationType: 'REPLY', targetRefs: [target('missing')] })).rejects.toThrow('引用');
  const persist = vi.fn();
  await expect(draft.commit(persist)).rejects.toThrow();
  expect(persist).not.toHaveBeenCalled();
  const cycle = new LocalDiscussion(createLocalMessageFile(), '甲');
  const category = await cycle.createRelation('root', { relationType: 'CLASSIFY', targetRefs: [], payload: { title: '循环' } });
  await expect(cycle.createRelation('root', { relationType: 'JOIN', sourceMessageId: category.id, targetRefs: [target(category.id)] })).rejects.toThrow('循环');
  await expect(cycle.commit(persist)).rejects.toThrow();
});

it('keeps the same durable file reference and rejects stale saves from another tab', async () => {
  const initial = createLocalMessageFile();
  await saveLastExport(initial);
  const reference = getExportCacheReference(initial)!;
  const secondTab = await loadReferencedExport(reference) as ExportData;
  const first = new LocalDiscussion(initial, '甲');
  await first.createMessage('root', { content: '已保存' });
  await first.commit(data => saveLastExportPersistent(data, initial));
  const reopened = await loadReferencedExport(reference) as ExportData;
  expect(reopened.messages.map(message => message.content)).toEqual(['已保存']);
  const stale = new LocalDiscussion(secondTab, '乙');
  await stale.createMessage('root', { content: '过期保存' });
  await expect(stale.commit(data => saveLastExportPersistent(data, secondTab))).rejects.toThrow('其他标签页');
  expect((await loadReferencedExport(reference) as ExportData).messages.map(message => message.content)).toEqual(['已保存']);
});

it('rejects new writes while a local transaction is being saved', async () => {
  const draft = new LocalDiscussion(createLocalMessageFile(), '甲');
  await draft.createMessage('root', { content: '正在保存' });
  let finish!: () => void;
  let persisted!: ExportData;
  const pending = draft.commit(data => {
    persisted = data;
    return new Promise<void>(resolve => { finish = resolve; });
  });
  try {
    await expect(draft.createMessage('root', { content: '保存期间的另一条发言' })).rejects.toThrow('正在保存');
    expect(persisted.messages.map(message => message.content)).toEqual(['正在保存']);
  } finally { finish(); }
  await expect(pending).resolves.toBe(1);
});
