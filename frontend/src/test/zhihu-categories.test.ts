import { expect, it } from 'vitest';
import { getZhihuLocalRelations, prepareZhihuForViewing, sendZhihuLocalRelation, serializeZhihuViewingData, type ZhihuViewingData } from '../utils/zhihuArchive';
import { serializeGonglunZhihuViewingData } from '../utils/zhihuGonglunExport';
import { validateExportForViewing } from '../utils/exportArchive';
import { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';

// Empty structural source fixtures, not invented discussion samples.
const source = () => ({ format: 'gonglun-zhihu-archive', version: 1,
  items: [
    { id: '10', type: 'answer', text: '', question: { id: '11', title: '', text: '', completeness: { title: 'complete', body: 'complete' } } },
    { id: '12', type: 'answer', text: '', question: { id: '11', title: '' } },
    { id: '13', type: 'answer', text: '', question: { id: null, title: '' } },
    { id: '10', type: 'article', text: '' }, { id: '30', type: 'pin', text: '' },
  ],
  comments: [
    { id: '1', sourceId: '1', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: null },
    { id: '2', sourceId: '2', threadId: 'answer:10', text: '', rootCommentId: '1', parentCommentId: '1' },
    { id: '3', sourceId: '3', threadId: 'answer:13', text: '', rootCommentId: '3', parentCommentId: null },
    { id: '4', sourceId: '4', threadId: 'article:10', text: '', rootCommentId: '4', parentCommentId: null },
    // Older archives used a bare work ID when it was unambiguous.
    { id: '5', sourceId: '5', threadId: '30', text: '', rootCommentId: '5', parentCommentId: null },
  ],
});
const categoryIds = ['zhihu:type:answer', 'zhihu:type:article', 'zhihu:type:pin'];
const categoryMessages = (data: ZhihuViewingData) => data.messages.filter(message => data.zhihu.byMessageId[message.id].kind === 'type-category');
const members = (data: ZhihuViewingData, id: string) => (data.relations.find(relation => relation.id === id)!.targetRefs as Array<{ relationId?: string; messageId?: string }>).map(ref => (ref.relationId || ref.messageId)!);
const effect = (data: ZhihuViewingData, username: string | null = null) => deriveContainerEffect({ ...projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(data)), username, stakeCounts: {} });

it('creates only present source-type categories with stable IDs and clearly generated authorship', () => {
  const raw = source(), data = prepareZhihuForViewing(raw);
  expect(categoryMessages(data).map(message => message.id)).toEqual(categoryIds);
  expect(categoryMessages(data).map(message => (message.relationPayload as { title?: string })?.title)).toEqual(['回答', '文章', '想法']);
  for (const message of categoryMessages(data)) {
    expect(message).toMatchObject({ relationType: 'CLASSIFY', author: '阅览分类', authorId: 'zhihu:viewer-category', createdAt: '', content: '' });
    expect(data.zhihu.byMessageId[message.id]).toMatchObject({ kind: 'type-category', sourceUrl: null, createdAt: null, sourceLabels: [] });
  }
  const onlyPin = prepareZhihuForViewing({ ...raw, items: raw.items.filter(item => item.type === 'pin'), comments: raw.comments.filter(comment => comment.threadId === '30') });
  expect(categoryMessages(onlyPin).map(message => message.id)).toEqual(['zhihu:type:pin']);
  expect(categoryMessages(prepareZhihuForViewing({ ...raw, items: [], comments: [] }))).toEqual([]);
  expect(categoryMessages(prepareZhihuForViewing({ ...raw, items: [...raw.items].reverse() })).map(message => message.id)).toEqual(categoryIds);
  expect(data.zhihu.archive).toEqual(raw);
  expect(data.zhihu.localOperations.operations).toEqual([]);
});

it('has three native root categories with questions nested only under answers and intact reply edges', () => {
  const data = prepareZhihuForViewing(source()), native = effect(data);
  const allOwned = native.ownership.active('CLASSIFY');
  const rootIds = data.messages.filter(message => !allOwned.textIds.has(message.id) && !allOwned.relationIds.has(message.id)).map(message => message.id);
  expect(rootIds).toEqual(categoryIds);
  expect([...native.ownership.direct('zhihu:type:answer').relationIds]).toEqual(['zhihu:question:11']);
  expect(native.ownership.direct('zhihu:question:11').textIds).toEqual(new Set(members(data, 'zhihu:question:11')));
  expect(members(data, 'zhihu:question:11')).toEqual(expect.arrayContaining(['zhihu:item:answer:10', 'zhihu:item:answer:12', 'zhihu:comment:answer%3A10:1', 'zhihu:comment:answer%3A10:2']));
  expect(members(data, 'zhihu:type:answer')).toContain('zhihu:item:answer:13');
  expect(members(data, 'zhihu:type:answer')).not.toContain('zhihu:item:answer:10');
  expect(members(data, 'zhihu:type:article')).toEqual(['zhihu:article:10']);
  expect(members(data, 'zhihu:article:10')).toEqual(expect.arrayContaining(['zhihu:item:article:10', 'zhihu:comment:article%3A10:4']));
  expect(members(data, 'zhihu:type:pin')).toEqual(expect.arrayContaining(['zhihu:item:pin:30', 'zhihu:comment:30:5']));
  expect(native.edges.filter(edge => edge.relationType === 'reply')).toHaveLength(5);
  expect(native.edges.find(edge => edge.relationType === 'reply' && edge.from.messageId === 'zhihu:comment:answer%3A10:2')?.to.messageId).toBe('zhihu:comment:answer%3A10:1');
  const originalMembers = categoryIds.flatMap(id => members(data, id));
  expect(new Set(originalMembers).size).toBe(originalMembers.length);
});

it('upgrades old native/source/reviewed views without changing original text, reply overrides or local history', () => {
  const raw = source(), prepared = prepareZhihuForViewing(raw);
  const changed = sendZhihuLocalRelation(prepared, { relationType: 'CLASSIFY', title: '结构测试', targetMessageIds: ['zhihu:comment:article%3A10:4'] });
  const reviewed = JSON.parse(serializeZhihuViewingData(changed));
  const oldNative = JSON.parse(serializeGonglunZhihuViewingData(changed));
  oldNative.messages = oldNative.messages.filter((message: { id: string }) => !categoryIds.includes(message.id));
  oldNative.relations = oldNative.relations.filter((relation: { id: string }) => !categoryIds.includes(relation.id));
  for (const id of categoryIds) delete oldNative.zhihu.byMessageId[id];
  for (const input of [reviewed, oldNative]) {
    const data = validateExportForViewing(input).data as ZhihuViewingData;
    expect(categoryMessages(data).map(message => message.id)).toEqual(categoryIds);
    expect(data.zhihu.archive).toEqual(raw);
    expect(data.zhihu.overrides).toEqual(changed.zhihu.overrides);
    expect(data.zhihu.localOperations).toEqual(changed.zhihu.localOperations);
    expect(data.messages.filter(message => ['item', 'comment'].includes(data.zhihu.byMessageId[message.id].kind)).every(message => message.content === '')).toBe(true);
  }
  expect(categoryMessages(validateExportForViewing(raw).data as ZhihuViewingData)).toHaveLength(3);
});

it('restores moved article/comment members to their article discussion after rejecting a local organization', () => {
  const raw = source(), original = prepareZhihuForViewing(raw), commentId = 'zhihu:comment:article%3A10:4';
  const arranged = sendZhihuLocalRelation(original, { relationType: 'ARRANGE', targetMessageIds: [commentId], currentClassificationId: 'zhihu:article:10' });
  const group = getZhihuLocalRelations(arranged).find(relation => relation.relationType === 'ARRANGE')!.id;
  expect(effect(arranged).ownership.direct('zhihu:article:10').textIds.has(commentId)).toBe(false);
  expect(effect(arranged).ownership.direct('zhihu:article:10').relationIds.has(group)).toBe(true);
  const opposed = sendZhihuLocalRelation(arranged, { relationType: 'DISAGREE', targetMessageIds: [group], currentClassificationId: 'zhihu:article:10' });
  const reopened = validateExportForViewing(JSON.parse(serializeGonglunZhihuViewingData(opposed))).data as ZhihuViewingData;
  for (const username of [null, '阅览者', '本地整理者']) {
    const native = effect(reopened, username);
    expect(native.suppressed.has(group)).toBe(true);
    expect(native.ownership.direct('zhihu:article:10').textIds.has(commentId)).toBe(true);
    expect(native.ownership.direct('zhihu:type:answer').textIds.has(commentId)).toBe(false);
  }
  expect(reopened.zhihu.membershipParents[commentId]).toBe('zhihu:article:10');
  expect(reopened.zhihu.archive).toEqual(raw);
  expect(reopened.zhihu.localOperations).toEqual(opposed.zhihu.localOperations);
});

it('puts each article in its own source navigation with the first paragraph and unchanged full original', () => {
  const raw = { format: 'gonglun-zhihu-archive', version: 1,
    items: [{ id: 'a', type: 'article', title: 'T', text: '\nP1\n\nP2', sourceLabels: ['原站标签'] }, { id: 'b', type: 'article', title: 'U', text: '' }],
    comments: [{ id: 'c', threadId: 'article:a', text: '', rootCommentId: 'c', parentCommentId: null }] };
  const data = prepareZhihuForViewing(raw), before = effect(data);
  expect(data.messages.find(message => message.id === 'zhihu:article:a')).toMatchObject({ content: 'P1', relationPayload: { title: 'T', sourceNavigation: true } });
  expect(data.messages.find(message => message.id === 'zhihu:item:article:a')?.content).toBe('T\n\n\nP1\n\nP2');
  expect(data.messages.find(message => message.id === 'zhihu:article:b')?.content).toBe('');
  expect(members(data, 'zhihu:type:article')).toEqual(['zhihu:article:a', 'zhihu:article:b']);
  expect(before.ownership.direct('zhihu:article:a').textIds).toEqual(new Set(members(data, 'zhihu:article:a')));
  expect(before.edges.some(edge => edge.relationMessageId === 'zhihu:article:a' && edge.to.messageId === 'zhihu:item:article:a')).toBe(true);
  const reopened = validateExportForViewing(JSON.parse(serializeGonglunZhihuViewingData(data))).data as ZhihuViewingData;
  expect(reopened.zhihu.archive).toEqual(raw);
  expect(reopened.messages.filter(message => message.id === 'zhihu:item:article:a')).toHaveLength(1);
  expect(effect(reopened).ownership.direct('zhihu:type:article').relationIds).toEqual(new Set(['zhihu:article:a', 'zhihu:article:b']));
});

it('keeps generated labels outside body correction while allowing native local stances and rejecting ancestor cycles', () => {
  const data = prepareZhihuForViewing(source());
  expect(getZhihuLocalRelations(data).some(relation => categoryIds.includes(relation.id))).toBe(false);
  const opposed = sendZhihuLocalRelation(data, { relationType: 'DISAGREE', targetMessageIds: ['zhihu:type:answer'] });
  expect(opposed.zhihu.archive).toEqual(data.zhihu.archive);
  expect(opposed.zhihu.localOperations.operations.at(-1)).toMatchObject({ type: 'DISAGREE', targetRelationIds: ['zhihu:type:answer'] });
  expect(() => sendZhihuLocalRelation(data, { relationType: 'CORRECT', targetMessageIds: ['zhihu:type:answer'], correctionField: 'title', content: '结构测试' })).toThrow('没有可更正');
  expect(() => sendZhihuLocalRelation(data, { relationType: 'CLASSIFY', sourceMessageIds: ['zhihu:question:11'], targetMessageIds: ['zhihu:type:answer'] })).toThrow('循环');
});
