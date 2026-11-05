import { expect, it } from 'vitest';
import { getZhihuArchiveIdentity, getZhihuLocalRelations, getZhihuMissingContent, prepareZhihuForViewing, sendZhihuLocalRelation, serializeZhihuViewingData, type ZhihuActivitySource, type ZhihuSourceEvent } from '../utils/zhihuArchive';
import { serializeGonglunZhihuViewingData } from '../utils/zhihuGonglunExport';
import { validateExportForViewing } from '../utils/exportArchive';
import { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';

// Protocol-only fixtures: target bodies are empty, never used as real discussion samples.
const at = '2026-11-01T01:00:00Z', earlier = '2025-01-01T00:00:00Z';
const actor = { id: 'fixture-owner', name: '行为人', url: 'https://www.zhihu.com/people/fixture-owner' };
const author = { id: 'fixture-target-author', name: '原作者', url: 'https://www.zhihu.com/people/fixture-target-author' };
const event = (extra: Partial<ZhihuSourceEvent> = {}): ZhihuSourceEvent => ({
  id: '2098730350474273589', sourceId: '2098730350474273589', identity: 'source', kind: 'activity', actor,
  verb: 'ANSWER_VOTE_UP', actionText: '赞同了回答', type: 'feed', target: { id: '10', type: 'answer', url: 'https://www.zhihu.com/question/20/answer/10', author },
  folderId: null, createdAt: null, createdAtText: null, sourceUrl: actor.url, capturedAt: at, versions: [], ...extra,
});
const activitySource = (scope: ZhihuActivitySource['scope'] = 'activities'): ZhihuActivitySource => ({ version: 1, scope, events: [event()], folders: [],
  coverage: { scope, status: 'complete', pagesComplete: true, allHistoryComplete: false, reason: '技术分页状态' }, unparsedRecords: [] });
const raw = (source = activitySource()) => ({ format: 'gonglun-zhihu-archive', version: 1, owner: actor,
  items: [{ id: '10', type: 'answer', text: '', author, createdAt: earlier, completeness: { body: 'complete', comments: 'unknown' } }], comments: [], activitySource: source });
const eventId = (scope = 'activities', id = '2098730350474273589') => `zhihu:event:${scope}:${id}`;
const targetId = 'zhihu:item:answer:10';
const native = (data: ReturnType<typeof prepareZhihuForViewing>) => deriveContainerEffect({ ...projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(data)), username: null, stakeCounts: {} });

it('preserves a source vote as literal event evidence and a local reference, never a Gonglun stance', () => {
  const input = raw(), data = prepareZhihuForViewing(input), observation = data.messages.find(message => message.id === eventId())!;
  expect(observation).toMatchObject({ kind: 'TEXT', author: actor.name, authorId: 'zhihu:author:id%3Afixture-owner', createdAt: '' });
  expect(observation.content).toContain('原始行为标识：ANSWER_VOTE_UP');
  expect(observation.content).toContain('原站行为文字：赞同了回答');
  expect(observation.content).toContain('目标原作者：原作者');
  expect(observation.content).toContain('行为时间：未取得（不以作品发布时间代替）');
  expect(observation.content).toContain('本轮是否返回未记录');
  expect(observation.parts).toContainEqual(expect.objectContaining({ type: 'data', id: 'source-event', value: expect.objectContaining({ actor, target: event().target, verb: 'ANSWER_VOTE_UP' }) }));
  expect(data.messages.find(message => message.id === targetId)).toMatchObject({ author: author.name, createdAt: earlier, content: '' });
  expect(data.zhihu.byMessageId[eventId()]).toMatchObject({ kind: 'activity-event', sourceId: '2098730350474273589', targetMessageId: targetId });
  expect(data.relations.some(relation => ['AGREE', 'DISAGREE'].includes(relation.relationType || ''))).toBe(false);
  const reference = data.relations.find(relation => relation.relationType === 'REFERENCE')!;
  expect(reference).toMatchObject({ sourceMessageId: eventId(), targetRefs: [{ kind: 'message', messageId: targetId }] });
  expect(native(data).edges.find(edge => edge.relationType === 'reference')).toMatchObject({ from: { messageId: eventId() }, to: { messageId: targetId } });
  expect(data.zhihu.archive).toEqual(input);
  expect(data.zhihu.warnings.join('\n')).toContain('目标内容可能由他人创作');
});

it('opens the same original directly from multiple folder author/type paths and the complete type index', () => {
  const source = activitySource('collections');
  source.events = [event({ id: '1', sourceId: '1', kind: 'collection-item', folderId: 'a', verb: 'collect' }), event({ id: '2', sourceId: '2', kind: 'collection-item', folderId: 'b', verb: 'collect' })];
  source.folders = ['a', 'b'].map(id => ({ id, title: `技术收藏夹 ${id}`, description: '', creator: actor, createdAt: null, updatedAt: null, isPublic: null, itemCount: 1,
    url: `https://www.zhihu.com/collection/${id}`, sourceUrl: actor.url, capturedAt: at, versions: [] }));
  const data = prepareZhihuForViewing(raw(source)), effect = native(data);
  expect(data.messages.filter(message => message.id === targetId)).toHaveLength(1);
  expect([...effect.ownership.direct('zhihu:source:collections').relationIds]).toEqual(['zhihu:folder:a', 'zhihu:folder:b']);
  for (const [folder, id] of [['a', '1'], ['b', '2']]) {
    expect(effect.ownership.direct(`zhihu:folder:${folder}:evidence`).textIds.has(eventId('collections', id))).toBe(true);
    expect(effect.ownership.owned(`zhihu:folder:${folder}`).textIds.has(targetId)).toBe(true);
    const authorCategory = data.relations.find(relation => (relation.payload as { title?: string })?.title === author.name
      && effect.ownership.direct(`zhihu:folder:${folder}`).relationIds.has(relation.id))!;
    const typeCategory = data.relations.find(relation => (relation.payload as { title?: string })?.title === '回答'
      && effect.ownership.direct(authorCategory.id).relationIds.has(relation.id))!;
    expect(effect.ownership.direct(typeCategory.id).textIds.has(targetId)).toBe(true);
    expect(effect.edges.some(edge => edge.relationMessageId === typeCategory.id && edge.to.messageId === targetId)).toBe(true);
    expect(data.zhihu.byMessageId[eventId('collections', id)].targetMessageId).toBe(targetId);
  }
  expect(effect.ownership.direct('zhihu:type:answer').textIds.has(targetId)).toBe(true);
  expect(data.relations.filter(relation => relation.relationType === 'REFERENCE')).toHaveLength(2);
});

it('shows unknown target types and incomplete bodies without inventing items or inferring verbs', () => {
  const source = activitySource();
  source.events = [event({ id: 'observation-hash', sourceId: null, identity: 'observation', verb: 'future-raw-verb', actionText: null, actor: null,
    target: { type: 'future-target-type', id: null, url: null, author: null } })];
  source.unparsedRecords = [{ type: 'future-target-type', marker: 'technical-structure' }];
  source.coverage.pagesComplete = false;
  const data = prepareZhihuForViewing({ ...raw(source), items: [] });
  expect(data.messages.filter(message => data.zhihu.byMessageId[message.id].kind === 'item')).toHaveLength(0);
  expect(data.relations.some(relation => relation.relationType === 'REFERENCE' || relation.relationType === 'AGREE')).toBe(false);
  expect(data.messages.find(message => message.id === eventId('activities', 'observation-hash'))).toMatchObject({ author: '作者未提供' });
  const text = data.messages.find(message => message.id === eventId('activities', 'observation-hash'))!.content;
  expect(text).toContain('future-raw-verb'); expect(text).toContain('目标类型未适配'); expect(text).not.toContain('赞同');
  expect(data.zhihu.warnings.join('\n')).toContain('来源分页尚未确认全部结束');
  expect(data.zhihu.warnings.join('\n')).toContain('原始证据保留');
  expect(data.zhihu.archive.activitySource).toEqual(source);
  const partial = prepareZhihuForViewing({ ...raw(), items: [{ ...raw().items[0], completeness: { body: 'partial' } }] });
  expect(getZhihuMissingContent(partial).find(entry => entry.messageId === targetId)?.originalStatus).toBe('partial');
  expect(partial.messages.find(message => message.id === eventId())!.content).toContain('目标正文仅取得部分');
});

it('keeps activity scopes separate from owned works and stable as targets/events arrive', () => {
  const owned = raw(); delete (owned as Partial<typeof owned>).activitySource;
  const activities = raw(), collections = raw(activitySource('collections'));
  expect(new Set([getZhihuArchiveIdentity(owned), getZhihuArchiveIdentity(activities), getZhihuArchiveIdentity(collections)]).size).toBe(3);
  const refreshed = raw(); refreshed.items.push({ ...refreshed.items[0], id: '30' });
  refreshed.activitySource.events.push(event({ id: 'new-source-id', sourceId: 'new-source-id', target: { ...event().target, id: '30' } }));
  expect(getZhihuArchiveIdentity(refreshed)).toBe(getZhihuArchiveIdentity(activities));
});

it('distinguishes current and retained historical events without treating absence as cancellation', () => {
  const source = activitySource();
  source.events.push(event({ id: 'historical-id', sourceId: 'historical-id' }));
  source.coverage.currentEventIds = [source.events[0].id]; source.coverage.currentFolderIds = [];
  const data = prepareZhihuForViewing(raw(source));
  expect(data.messages.find(message => message.id === eventId())!.content).toContain('来源状态：本轮返回');
  expect(data.messages.find(message => message.id === eventId('activities', 'historical-id'))!.content).toContain('历史保留（本轮未返回，不代表取消）');
  expect(data.zhihu.inactiveRelationIds).toEqual([]);
  expect(data.relations.filter(relation => relation.relationType === 'REFERENCE')).toHaveLength(2);
  expect(data.zhihu.archive.activitySource!.events).toHaveLength(2);
});

it('roundtrips evidence and local grouping and returns an event to its evidence directory after rejection', () => {
  const input = raw(), original = prepareZhihuForViewing(input);
  const grouped = sendZhihuLocalRelation(original, { relationType: 'ARRANGE', targetMessageIds: [eventId()], currentClassificationId: 'zhihu:source:activities' });
  const group = getZhihuLocalRelations(grouped).find(relation => relation.relationType === 'ARRANGE')!.id;
  const opposed = sendZhihuLocalRelation(grouped, { relationType: 'DISAGREE', targetMessageIds: [group], currentClassificationId: 'zhihu:source:activities' });
  for (const output of [serializeZhihuViewingData(opposed), serializeGonglunZhihuViewingData(opposed)]) {
    const reopened = validateExportForViewing(JSON.parse(output)).data as typeof original;
    expect(reopened.zhihu.archive).toEqual(input);
    expect(reopened.zhihu.localOperations).toEqual(opposed.zhihu.localOperations);
    expect(native(reopened).ownership.direct('zhihu:source:activities:likes:evidence').textIds.has(eventId())).toBe(true);
    expect(native(reopened).ownership.direct('zhihu:type:answer').textIds.has(targetId)).toBe(true);
    expect(reopened.zhihu.byMessageId[eventId()].targetMessageId).toBe(targetId);
  }
});

it('returns a moved collection event to its original folder after opposing a local classification without hiding source facts', () => {
  const source = activitySource('collections');
  source.events = [event({ kind: 'collection-item', folderId: 'a', verb: 'collect' })];
  source.folders = [{ id: 'a', title: '技术收藏夹', description: '', creator: actor, createdAt: null, updatedAt: null, isPublic: null, itemCount: 1,
    url: 'https://www.zhihu.com/collection/a', sourceUrl: actor.url, capturedAt: at }];
  const input = raw(source), original = prepareZhihuForViewing(input), selected = eventId('collections');
  const folder = 'zhihu:folder:a', evidence = `${folder}:evidence`, root = 'zhihu:source:collections';
  const reference = original.relations.find(relation => relation.relationType === 'REFERENCE')!.id;
  const grouped = sendZhihuLocalRelation(original, { relationType: 'CLASSIFY', title: '本地结构测试', targetMessageIds: [selected], currentClassificationId: evidence });
  const group = getZhihuLocalRelations(grouped).find(relation => relation.relationType === 'CLASSIFY')!.id;
  const before = native(grouped);
  expect(before.ownership.direct(`${folder}:evidence`).textIds.has(selected)).toBe(false);
  expect(before.ownership.direct(evidence).relationIds.has(group)).toBe(true);
  expect(before.ownership.direct(group).textIds.has(selected)).toBe(true);
  expect(grouped.relations.find(relation => relation.id === folder)!.payload).toMatchObject({ sourceNavigation: true });
  expect(grouped.relations.find(relation => relation.id === root)!.payload).toMatchObject({ sourceNavigation: true });
  const opposed = sendZhihuLocalRelation(grouped, { relationType: 'DISAGREE', targetMessageIds: [group], currentClassificationId: evidence });
  const reopened = validateExportForViewing(JSON.parse(serializeGonglunZhihuViewingData(opposed))).data as typeof original;
  const after = native(reopened);
  expect(after.ownership.direct(`${folder}:evidence`).textIds.has(selected)).toBe(true);
  expect(after.ownership.direct(root).textIds.has(selected)).toBe(false);
  expect(reopened.zhihu.membershipParents[selected]).toBe(`${folder}:evidence`);
  expect(after.ownership.direct('zhihu:type:answer').textIds.has(targetId)).toBe(true);
  expect(after.edges.some(edge => edge.relationMessageId === reference && edge.to.messageId === targetId)).toBe(true);
  expect(reopened.zhihu.archive).toEqual(input);
  expect(reopened.messages.find(message => message.id === targetId)!.content).toBe('');
  for (const fact of [selected, reference, folder, root]) {
    expect(reopened.zhihu.inactiveRelationIds).not.toContain(fact);
    const stated = sendZhihuLocalRelation(reopened, { relationType: 'DISAGREE', targetMessageIds: [fact] });
    expect(stated.zhihu.archive).toEqual(input);
  }
});

it('rejects unsafe event IDs and malformed structures while retaining unknown string action identifiers', () => {
  const numeric = raw(); (numeric.activitySource.events[0] as unknown as { id: number }).id = Number('2098730350474273589');
  expect(() => prepareZhihuForViewing(numeric)).toThrow('事件编号');
  const repeated = raw(); repeated.activitySource.events.push(structuredClone(repeated.activitySource.events[0]));
  expect(() => prepareZhihuForViewing(repeated)).toThrow('重复事件');
  const invalidTarget = raw(); (invalidTarget.activitySource.events[0] as unknown as { target: null }).target = null;
  expect(() => prepareZhihuForViewing(invalidTarget)).toThrow('事件目标');
  expect(() => prepareZhihuForViewing(raw(activitySource()))).not.toThrow();
});

it('builds author/type/question subsets from collected works without mixing same-name authors or inventing their collections', () => {
  const source = activitySource('collections'), secondAuthor = { id: 'other-author', name: author.name };
  source.folders = ['a', 'b'].map(id => ({ id, title: id, description: '', creator: actor, createdAt: null, updatedAt: null, isPublic: null,
    itemCount: null, url: `https://www.zhihu.com/collection/${id}`, sourceUrl: actor.url, capturedAt: at }));
  source.events = [
    event({ id: 'a1', sourceId: 'a1', kind: 'collection-item', folderId: 'a' }),
    event({ id: 'b1', sourceId: 'b1', kind: 'collection-item', folderId: 'b' }),
    event({ id: 'b2', sourceId: 'b2', kind: 'collection-item', folderId: 'b', target: { ...event().target, id: '11', author: secondAuthor } }),
    event({ id: 'a2', sourceId: 'a2', kind: 'collection-item', folderId: 'a', target: { ...event().target, id: '12', type: 'article' } }),
    event({ id: 'a3', sourceId: 'a3', kind: 'collection-item', folderId: 'a', target: { ...event().target, id: '13', type: 'pin' } }),
    ...['14', '15'].map(id => event({ id, sourceId: id, kind: 'collection-item', folderId: 'a', target: { ...event().target, id, author: { name: '同名未识别' } } })),
  ];
  const question = { id: 'q', title: 'Q', text: '', completeness: { title: 'complete', body: 'complete' } };
  const input = { ...raw(source), items: [
    { ...raw().items[0], question }, { ...raw().items[0], id: '11', author: secondAuthor, question },
    { ...raw().items[0], id: '12', type: 'article', title: 'T', text: 'P1\n\nP2' },
    { ...raw().items[0], id: '13', type: 'pin' },
    ...['14', '15'].map(id => ({ ...raw().items[0], id, author: { name: '同名未识别' } })),
  ], comments: [{ id: 'c', threadId: 'article:12', text: '', rootCommentId: 'c', parentCommentId: null }] };
  const data = prepareZhihuForViewing(input), effect = native(data);
  const child = (parent: string, title: string, sourceId?: string) => data.messages.find(message => effect.ownership.direct(parent).relationIds.has(message.id)
    && (message.relationPayload as { title?: string })?.title === title && (sourceId === undefined || data.zhihu.byMessageId[message.id].sourceId === sourceId))!.id;
  const a = child('zhihu:folder:a', author.name, `id:${author.id}`), b = child('zhihu:folder:b', author.name, `id:${author.id}`);
  const aAnswers = child(a, '回答'), aQuestion = child(aAnswers, 'Q'), bQuestion = child(child(b, '回答'), 'Q');
  expect(effect.ownership.direct(aQuestion).textIds.has(targetId)).toBe(true);
  expect(effect.ownership.direct(bQuestion).textIds.has(targetId)).toBe(true);
  expect(effect.ownership.owned(a).textIds.has('zhihu:item:answer:11')).toBe(false);
  const second = child('zhihu:folder:b', author.name, 'id:other-author');
  expect(effect.ownership.owned(second).textIds.has('zhihu:item:answer:11')).toBe(true);
  expect(effect.ownership.owned(second).textIds.has(targetId)).toBe(false);
  expect(data.messages.filter(message => effect.ownership.direct('zhihu:folder:a').relationIds.has(message.id)
    && (message.relationPayload as { title?: string })?.title === '同名未识别')).toHaveLength(2);
  expect([...effect.ownership.direct(a).relationIds].map(id => (data.messages.find(message => message.id === id)!.relationPayload as { title: string }).title)).toEqual(['回答', '文章', '想法']);
  expect(effect.ownership.direct(child(a, '文章')).relationIds.has('zhihu:article:12')).toBe(true);
  expect(effect.ownership.direct('zhihu:article:12').textIds.has('zhihu:comment:article%3A12:c')).toBe(true);
  expect(data.messages.find(message => message.id === 'zhihu:article:12')?.content).toBe('P1');
  expect(data.messages.filter(message => message.id === targetId)).toHaveLength(1);
  expect(data.messages.filter(message => message.id === 'zhihu:item:article:12')).toHaveLength(1);
  expect(data.zhihu.archive).toEqual(input);
  expect(data.relations.some(relation => relation.relationType === 'AGREE')).toBe(false);
});

it('keeps shared source paths and native edges after local grouping, append and rejection without double displaying the local scope', () => {
  const source = activitySource('collections');
  source.folders = ['a', 'b'].map(id => ({ id, title: id, description: '', creator: actor, createdAt: null, updatedAt: null, isPublic: null,
    itemCount: 1, url: `https://www.zhihu.com/collection/${id}`, sourceUrl: actor.url, capturedAt: at }));
  source.events = ['a', 'b'].map(id => event({ id, sourceId: id, kind: 'collection-item', folderId: id }));
  const original = prepareZhihuForViewing({ ...raw(source), items: [{ ...raw().items[0], question: { id: 'q', title: 'Q', text: '' } }],
    comments: [{ id: 'c', threadId: 'answer:10', text: '', rootCommentId: 'c', parentCommentId: null }] });
  const initial = native(original), comment = 'zhihu:comment:answer%3A10:c';
  const parentFor = (folder: string) => original.relations.find(relation => relation.id !== 'zhihu:question:q'
    && initial.ownership.owned(folder).relationIds.has(relation.id) && initial.ownership.direct(relation.id).textIds.has(targetId))!.id;
  const a = parentFor('zhihu:folder:a'), b = parentFor('zhihu:folder:b');
  const grouped = sendZhihuLocalRelation(original, { relationType: 'CLASSIFY', title: 'G', targetMessageIds: [comment], currentClassificationId: a });
  const group = getZhihuLocalRelations(grouped).find(relation => relation.relationType === 'CLASSIFY')!.id;
  const appended = sendZhihuLocalRelation(grouped, { relationType: 'CLASSIFY', sourceMessageIds: [group], targetMessageIds: [targetId], currentClassificationId: a });
  const assertMoved = (data: typeof original) => {
    const effect = native(data);
    expect(effect.ownership.direct(a).textIds.has(targetId)).toBe(false);
    expect(effect.ownership.direct(group).textIds.has(targetId)).toBe(true);
    for (const parent of [b, 'zhihu:question:q']) {
      expect(effect.ownership.direct(parent).textIds.has(targetId)).toBe(true);
      expect(effect.edges.some(edge => edge.relationMessageId === parent && edge.to.messageId === targetId)).toBe(true);
    }
    expect(effect.edges.some(edge => edge.relationMessageId === a && edge.to.messageId === targetId)).toBe(false);
    expect(effect.edges.some(edge => edge.relationMessageId === group && edge.to.messageId === targetId)).toBe(true);
  };
  assertMoved(appended);
  const agreed = sendZhihuLocalRelation(appended, { relationType: 'AGREE', targetMessageIds: [group], currentClassificationId: a });
  assertMoved(agreed);
  for (const output of [serializeZhihuViewingData(agreed), serializeGonglunZhihuViewingData(agreed)])
    assertMoved(validateExportForViewing(JSON.parse(output)).data as typeof original);
  const opposed = sendZhihuLocalRelation(agreed, { relationType: 'DISAGREE', targetMessageIds: [group], currentClassificationId: a });
  const restored = validateExportForViewing(JSON.parse(serializeGonglunZhihuViewingData(opposed))).data as typeof original;
  for (const parent of [a, b, 'zhihu:question:q']) {
    expect(native(restored).ownership.direct(parent).textIds.has(targetId)).toBe(true);
    expect(native(restored).edges.some(edge => edge.relationMessageId === parent && edge.to.messageId === targetId)).toBe(true);
  }
  expect(restored.zhihu.archive).toEqual(original.zhihu.archive);
  expect(restored.messages.filter(message => message.id === targetId)).toHaveLength(1);
});

it('opens known likes by author and content type while retaining unknown actions and missing targets as evidence', () => {
  const source = activitySource();
  source.events.push(event({ id: 'unknown', sourceId: 'unknown', verb: 'future-raw-verb', target: { type: 'future', id: null, author: null, url: null } }));
  const data = prepareZhihuForViewing(raw(source)), effect = native(data);
  expect(effect.ownership.owned('zhihu:source:activities:likes').textIds.has(targetId)).toBe(true);
  expect(effect.ownership.direct('zhihu:source:activities:likes:evidence').textIds.has(eventId())).toBe(true);
  expect(effect.ownership.owned('zhihu:source:activities:other').textIds.has(eventId('activities', 'unknown'))).toBe(true);
  expect(effect.ownership.owned('zhihu:source:activities:likes').textIds.has(eventId('activities', 'unknown'))).toBe(false);
  expect(data.messages.filter(message => data.zhihu.byMessageId[message.id].kind === 'item')).toHaveLength(1);
  expect(data.relations.some(relation => relation.relationType === 'AGREE')).toBe(false);
  expect(data.zhihu.archive.activitySource).toEqual(source);
});
