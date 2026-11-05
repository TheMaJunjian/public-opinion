import { describe, expect, it } from 'vitest';
import {
  getZhihuArchiveIdentity, getZhihuUndoBatch, isZhihuInput, isZhihuViewingData,
  prepareZhihuForViewing, resetZhihuRelations, serializeZhihuViewingData,
  undoZhihuRelations, updateZhihuRelations, sendZhihuLocalRelation, getZhihuReplyRelations, getZhihuLocalRelations, getZhihuInactiveRelationIds,
} from '../utils/zhihuArchive';
import { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import { computeEffectiveSuppressedRelIds } from '../utils/modelBridge';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';

// Structural fixtures only. Empty source bodies do not stand in for real discussion data.
const time = '2026-11-01T01:00:00Z';
const comment = (id: string, extra: Record<string, unknown> = {}) => ({
  id, sourceId: id, threadId: 'answer:10', text: '', parentCommentId: null, rootCommentId: id, issues: [], ...extra,
});
const archive = (comments = [comment('1'), comment('2', { rootCommentId: '1', parentCommentId: '1' }), comment('3', { rootCommentId: '1' })]) => ({
  format: 'gonglun-zhihu-archive', version: 1, platform: 'zhihu', createdAt: time, updatedAt: time,
  owner: { id: 'owner', name: '技术测试账号', url: 'https://www.zhihu.com/people/owner' },
  items: [{ id: '10', type: 'answer', text: '', url: 'https://www.zhihu.com/question/11/answer/10' }], comments,
});
const idFor = (data: ReturnType<typeof prepareZhihuForViewing>, sourceId: string, kind = 'comment') => Object.entries(data.zhihu.byMessageId).find(([, value]) => value.sourceId === sourceId && value.kind === kind)![0];

describe('Zhihu viewer adapter', () => {
  it('keeps source evidence separate from a nonfinancial readonly native projection', () => {
    const input = archive();
    const data = prepareZhihuForViewing(input);
    expect(isZhihuInput(input)).toBe(true);
    expect(isZhihuViewingData(data)).toBe(true);
    expect(data).toMatchObject({ format: 'gonglun-view-3', formatVersion: 5, zhihu: { readOnly: true, archive: input } });
    expect(data).not.toHaveProperty('journal'); expect(data).not.toHaveProperty('stakes');
    expect(data.messages.every(message => !('spending' in message) && !('state' in message))).toBe(true);
    expect(data.zhihu.archive).not.toBe(input);
    expect(data.zhihu.relations.map(row => row.source)).toEqual(['original', 'original', 'unknown']);
    expect(data.relations.filter(relation => relation.relationType === 'REPLY')).toHaveLength(2);
    const projection = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(data));
    expect(projection.messages).toHaveLength(7);
    const replyEdges = projection.edges.filter(edge => edge.relationType === 'reply');
    expect(replyEdges).toHaveLength(2);
    expect(new Set(projection.messages.map(message => message.id)).size).toBe(7);
    expect(replyEdges.map(edge => edge.to.messageId)).toEqual([idFor(data, '10', 'item'), idFor(data, '1')]);
  });
  it('preserves large string IDs, literal text, source labels and incomplete timestamps', () => {
    const large = '2098730350474273589';
    const input = archive([comment(large, { text: '<script>technical fixture</script>', html: '<script>invalid()</script>', createdAtText: '10-28', sourceLabels: ['包含AI生成内容'] }), comment('2', { createdAt: time })]);
    const data = prepareZhihuForViewing(input), id = idFor(data, large);
    expect(data.messages.find(message => message.id === id)).toMatchObject({ contentType: 'TEXT', content: '<script>technical fixture</script>', createdAt: '' });
    expect(data.zhihu.byMessageId[id]).toMatchObject({ sourceId: large, createdAtText: '10-28', sourceLabels: ['包含AI生成内容'] });
    expect(data.messages.find(message => message.id === idFor(data, '2'))!.createdAt).toBe(time);
    expect(data.zhihu.archive.comments[0].html).toBe('<script>invalid()</script>');
    expect(data.messages.flatMap(message => message.parts || []).every(part => part.type !== 'web')).toBe(true);
  });
  it('does not merge anonymous authors based only on their displayed name', () => {
    const data = prepareZhihuForViewing(archive([comment('1', { author: { name: '同名' } }), comment('2', { author: { name: '同名' } })]));
    const messages = data.messages.filter(message => message.author === '同名');
    expect(messages[0].authorId).not.toBe(messages[1].authorId);
  });
  it('keeps the local archive identity and undated source order as more comments arrive', () => {
    const empty = archive([]), filled = archive([comment('20'), comment('3'), comment('10')]);
    expect(getZhihuArchiveIdentity(empty)).toBe(getZhihuArchiveIdentity(filled));
    const data = prepareZhihuForViewing(filled), projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(data));
    expect(projected.messages.map(message => message.id)).toEqual(data.messages.map(message => message.id));
  });
  it('loads legacy v1 relations, ignores claimed derived links, and recalculates projection', () => {
    const source = archive();
    const data = prepareZhihuForViewing({ format: 'gonglun-zhihu-reviewed', version: 1, archive: source,
      overrides: { format: 'gonglun-zhihu-overrides', version: 1, revisions: [{ id: 'old', action: 'set', threadId: 'answer:10', commentId: '3', parentCommentId: '2', createdAt: time }] },
      relations: [{ fake: true }],
    });
    expect(data.zhihu.overrides.version).toBe(2);
    expect(data.zhihu.relations[2]).toMatchObject({ source: 'manual', effectiveParentCommentIds: ['2'] });
    expect(data.zhihu.archive).toEqual(source);
    expect(getZhihuArchiveIdentity(source)).toBe(data.zhihu.archiveId);
  });
  it('uses source comment order for unknown-only sequence and roundtrips a portable undo log', () => {
    const original = prepareZhihuForViewing(archive());
    const changed = updateZhihuRelations(original, { mode: 'sequence' });
    expect(changed.zhihu.relations[2]).toMatchObject({ source: 'manual', method: 'sequence', effectiveParentCommentIds: ['2'] });
    expect(changed.zhihu.overrides.revisions).toHaveLength(1);
    expect(original.zhihu.overrides.revisions).toHaveLength(0);
    const json = serializeZhihuViewingData(changed), exported = JSON.parse(json);
    expect(exported).toMatchObject({ format: 'gonglun-zhihu-reviewed', version: 5, archive: original.zhihu.archive });
    expect(exported).not.toHaveProperty('messages');
    const reopened = prepareZhihuForViewing(exported);
    expect(reopened.zhihu.relations).toEqual(changed.zhihu.relations);
    expect(reopened.zhihu.archiveId).toBe(original.zhihu.archiveId);
    const undone = undoZhihuRelations(reopened);
    expect(undone.zhihu.relations[2].source).toBe('unknown');
    expect(getZhihuUndoBatch(undone)).toBeNull();
    expect(() => undoZhihuRelations(undone)).toThrow('没有可撤销');
    expect(updateZhihuRelations(changed, { mode: 'sequence' }).zhihu.overrides.revisions).toHaveLength(1);
  });
  it('supports multiple targets and keeps every edge through the existing viewer pipeline', () => {
    const data = prepareZhihuForViewing(archive([comment('1'), comment('2'), comment('3'), comment('4')]));
    const changed = updateZhihuRelations(data, { mode: 'sets', sourceMessageIds: [idFor(data, '3'), idFor(data, '4')], targetMessageIds: [idFor(data, '1'), idFor(data, '2')] });
    expect(changed.zhihu.relations.slice(2).map(row => row.effectiveParentCommentIds)).toEqual([['1', '2'], ['1', '2']]);
    const projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(changed));
    expect(projected.edges.filter(edge => edge.from.messageId === idFor(data, '3'))).toHaveLength(2);
    expect(changed.zhihu.overrides.revisions[0].batchId).toBe(changed.zhihu.overrides.revisions[1].batchId);
    expect(undoZhihuRelations(changed).zhihu.relations.slice(2).map(row => row.source)).toEqual(['original', 'original']);
  });
  it('maps a work target to explicit top-level and makes root/reset actions undoable', () => {
    const data = prepareZhihuForViewing(archive()), source = idFor(data, '3');
    const root = updateZhihuRelations(data, { mode: 'sets', sourceMessageIds: [source], targetMessageIds: [idFor(data, '10', 'item')] });
    expect(root.zhihu.relations[2]).toMatchObject({ source: 'manual', effectiveParentCommentIds: [], needsReview: false });
    expect(root.relations.find(relation => relation.sourceMessageId === source)?.targetRefs).toEqual([{ kind: 'message', messageId: idFor(data, '10', 'item') }]);
    const reset = resetZhihuRelations(root, [source]);
    expect(reset.zhihu.relations[2].source).toBe('unknown');
    expect(undoZhihuRelations(reset).zhihu.relations[2].source).toBe('manual');
  });
  it('resets a selected graph atomically rather than rejecting a temporary intermediate cycle', () => {
    const data = prepareZhihuForViewing(archive([comment('1', { parentCommentId: '2', rootCommentId: '2' }), comment('2')]));
    const first = idFor(data, '1'), second = idFor(data, '2'), work = idFor(data, '10', 'item');
    const top = updateZhihuRelations(data, { mode: 'sets', sourceMessageIds: [first], targetMessageIds: [work] });
    const reverse = updateZhihuRelations(top, { mode: 'sets', sourceMessageIds: [second], targetMessageIds: [first] });
    const reset = resetZhihuRelations(reverse, [first, second]);
    expect(reset.zhihu.relations.map(row => row.effectiveParentCommentIds)).toEqual([['2'], []]);
    expect(reset.zhihu.relations.map(row => row.source)).toEqual(['original', 'original']);
    expect(reset.zhihu.overrides.revisions).toHaveLength(reverse.zhihu.overrides.revisions.length + 2);
    expect(undoZhihuRelations(reset).zhihu.relations.map(row => row.effectiveParentCommentIds)).toEqual([[], ['1']]);
  });
  it('rejects cross-work, self, cycle and invalid work-source changes without mutation', () => {
    const source = archive();
    source.items.push({ id: '20', type: 'article', text: '', url: 'https://zhuanlan.zhihu.com/p/20' });
    source.comments.push(comment('9', { threadId: 'article:20' }));
    const data = prepareZhihuForViewing(source), before = JSON.stringify(data);
    const one = idFor(data, '1'), two = idFor(data, '2'), nine = idFor(data, '9');
    expect(() => updateZhihuRelations(data, { mode: 'sets', sourceMessageIds: [one], targetMessageIds: [two] })).toThrow('循环');
    expect(() => updateZhihuRelations(data, { mode: 'sets', sourceMessageIds: [one], targetMessageIds: [one] })).toThrow();
    expect(() => updateZhihuRelations(data, { mode: 'sets', sourceMessageIds: [one], targetMessageIds: [nine] })).toThrow('跨作品');
    expect(() => updateZhihuRelations(data, { mode: 'sequence' })).toThrow('请选择一个作品');
    expect(() => updateZhihuRelations(data, { mode: 'sets', sourceMessageIds: [idFor(data, '10', 'item')], targetMessageIds: [one] })).toThrow('来源');
    expect(JSON.stringify(data)).toBe(before);
  });
  it('leaves unknown and missing original parents visible without invented edges', () => {
    const data = prepareZhihuForViewing(archive([comment('1', { parentCommentId: 'absent' }), comment('2', { rootCommentId: null, replyToAuthor: { name: '技术占位' } })]));
    expect(data.relations.filter(relation => relation.relationType === 'REPLY')).toHaveLength(0);
    expect(data.zhihu.relations.every(row => row.needsReview)).toBe(true);
    expect(data.zhihu.warnings.some(warning => warning.includes('2 条评论'))).toBe(true);
  });
  it('surfaces partial capture evidence and only extracts recorded text without changing the source', () => {
    const input = { ...archive(),
      items: [{ ...archive().items[0], completeness: { body: 'partial', comments: 'partial', reason: '技术测试：后续内容未获取' } }],
      issues: [{ code: 'technical-fixture', message: '<b>技术测试问题</b>' }, { message: { unsafe: true } }],
      captures: [
        { coverage: { scope: 'account', complete: true, hasMore: false } },
        { coverage: { scope: 'selected-items', complete: false, hasMore: false, pendingCount: 2, reason: '技术测试范围未完成' }, issues: ['技术测试历史说明'] },
      ],
    };
    const before = JSON.stringify(input), data = prepareZhihuForViewing(input), warnings = data.zhihu.warnings.join('\n');
    expect(warnings).toContain('1 条作品的正文采集为部分');
    expect(warnings).toContain('1 个作品的评论采集为部分');
    expect(warnings).toContain('仅为选定作品');
    expect(warnings).toContain('尚未完成'); expect(warnings).toContain('待采集数：2');
    expect(warnings).toContain('技术测试：后续内容未获取');
    expect(warnings).toContain('<b>技术测试问题</b>');
    expect(warnings).toContain('采集过程问题记录（含历史记录）：技术测试历史说明');
    expect(warnings).not.toContain('[object Object]'); expect(warnings).not.toContain('unsafe');
    expect(JSON.stringify(input)).toBe(before); expect(JSON.stringify(data.zhihu.archive)).toBe(before);
    expect(prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(data))).zhihu.warnings).toEqual(data.zhihu.warnings);
  });
  it('rejects malformed external files and unsafe manual graphs', () => {
    expect(() => prepareZhihuForViewing({ ...archive(), version: 3 })).toThrow('版本');
    expect(() => prepareZhihuForViewing(archive([comment('1', { sourceId: Number('2098730350474273589') })]))).toThrow('字符串');
    expect(() => prepareZhihuForViewing(archive([comment('1'), comment('1')]))).toThrow('重复');
    expect(() => prepareZhihuForViewing(JSON.parse('{"format":"gonglun-zhihu-archive","__proto__":{}}'))).toThrow('不安全');
    expect(() => prepareZhihuForViewing({ format: 'gonglun-zhihu-reviewed', version: 2, archive: archive(), overrides: {
      format: 'gonglun-zhihu-overrides', version: 2, revisions: [{ id: 'bad', action: 'set', threadId: 'answer:10', commentId: '1', parentCommentIds: ['2'], createdAt: time }],
    } })).toThrow('循环');
  });
  it('retains portable public view settings and validates them on direct serialize too', () => {
    const data = prepareZhihuForViewing(archive());
    data.view = { username: null, mode: 'graph', messageFilter: { hideSettlement: true, hideJoin: true }, homeFilter: null, cleanFilters: [], classificationId: null };
    const exported = JSON.parse(serializeZhihuViewingData(data));
    expect(exported.view).toEqual(data.view);
    expect(prepareZhihuForViewing(exported).view).toEqual(data.view);
    const bad = { ...data, view: { ...data.view, cleanFilters: [{ id: 'bad', kind: 'sender', username: [] }] } };
    expect(() => prepareZhihuForViewing(bad)).toThrow('阅览设置格式无效');
    expect(() => serializeZhihuViewingData(bad as unknown as typeof data)).toThrow('阅览设置格式无效');
  });

  it('deduplicates a question as a category with its own title, description and explicit complete membership', () => {
    const question = { id: '11', title: '技术测试问题标题', text: '技术测试描述', completeness: { body: 'complete' } };
    const input = { ...archive(), questions: [question], items: [
      { ...archive().items[0], title: question.title, question: { id: '11', title: question.title } },
      { id: '20', type: 'answer', text: '', title: question.title, question: { id: '11', title: question.title } },
    ], comments: [...archive().comments, comment('9', { threadId: 'answer:20' })] };
    const data = prepareZhihuForViewing(input), projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(data));
    const category = data.messages.find(message => data.zhihu.byMessageId[message.id]?.kind === 'question')!;
    expect(data.messages.filter(message => data.zhihu.byMessageId[message.id]?.kind === 'question')).toHaveLength(1);
    expect(category).toMatchObject({ kind: 'RELATION', relationType: 'CLASSIFY', content: question.text, createdAt: '', relationPayload: { title: question.title } });
    expect(category.author).toBe('作者未提供');
    expect(data.messages.find(message => message.id === idFor(data, '10', 'item'))!.content).toBe('');
    const relation = data.relations.find(value => value.id === category.id)!;
    const members = (relation.targetRefs as { messageId: string }[]).map(ref => ref.messageId);
    expect(new Set(members)).toEqual(new Set(data.messages.filter(message => message.id !== category.id && data.zhihu.byMessageId[message.id].kind !== 'type-category').map(message => message.id)));
    const child = projected.edges.find(edge => edge.relationType === 'reply' && edge.from.messageId === idFor(data, '2'))!;
    expect(child.to.messageId).toBe(idFor(data, '1'));
    expect(data.zhihu.archive).toEqual(input);
  });
  it('distinguishes a missing question description from a verified empty description', () => {
    const input = { ...archive(), items: [{ ...archive().items[0], question: { id: '11', title: '技术测试标题', text: null as string | null, completeness: { body: 'unknown' } } }] };
    const unknown = prepareZhihuForViewing(input), questionId = idFor(unknown, '11', 'question');
    expect(unknown.zhihu.byMessageId[questionId].descriptionKnown).toBe(false);
    expect(unknown.zhihu.warnings.some(warning => warning.includes('描述未取得'))).toBe(true);
    input.items[0].question.text = ''; input.items[0].question.completeness.body = 'complete';
    const empty = prepareZhihuForViewing(input);
    expect(empty.zhihu.byMessageId[questionId].descriptionKnown).toBe(true);
    expect(empty.zhihu.warnings.some(warning => warning.includes('描述未取得'))).toBe(false);
  });
  it('keeps older nested questions without a source ID and never invents grouping by title', () => {
    const input = { ...archive(), items: [{ ...archive().items[0], question: { id: null, title: '技术测试标题', text: null } }] };
    const data = prepareZhihuForViewing(input);
    expect(Object.values(data.zhihu.byMessageId).some(record => record.kind === 'question')).toBe(false);
    expect(data.zhihu.warnings.some(warning => warning.includes('问题编号未取得'))).toBe(true);
    expect(data.zhihu.archive).toEqual(input);
    expect(() => prepareZhihuForViewing({ ...input, questions: [{ id: null, title: '技术测试标题' }] })).toThrow('字符串编号');
  });
  it('opposes and restores the independent relation while preserving historical v3 AGREE', () => {
    const original = prepareZhihuForViewing(archive()), source = idFor(original, '2');
    const reply = getZhihuReplyRelations(original).find(value => value.sourceMessageId === source)!;
    const opposed = sendZhihuLocalRelation(original, { relationType: 'DISAGREE', targetMessageIds: [reply.id] });
    expect(getZhihuReplyRelations(opposed).find(value => value.id === reply.id)?.active).toBe(false);
    const projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(opposed));
    for (const username of [null, '原站作者', '本地整理者']) {
      const suppressed = computeEffectiveSuppressedRelIds(projected.edges, projected.messages, username);
      expect(suppressed.has(reply.id)).toBe(true); expect(suppressed.has(source)).toBe(false);
      const effect = deriveContainerEffect({ ...projected, username });
      expect(effect.edges.some(edge => edge.relationMessageId === reply.id)).toBe(false);
    }
    expect(projected.messages.find(message => message.id === source)).toMatchObject({ kind: 'normal', content: '' });
    expect(projected.messages.some(message => message.id === reply.id && message.kind === 'relation')).toBe(true);
    const opposedAgain = sendZhihuLocalRelation(opposed, { relationType: 'DISAGREE', targetMessageIds: [reply.id] });
    const restored = sendZhihuLocalRelation(opposedAgain, { relationType: 'AGREE', targetMessageIds: [reply.id] });
    expect(getZhihuReplyRelations(restored).find(value => value.id === reply.id)?.active).toBe(true);
    expect(restored.zhihu.archive).toEqual(original.zhihu.archive);
    // Existing v3 history remains readable, including the older restoration action.
    const saved = JSON.parse(serializeZhihuViewingData(opposedAgain));
    saved.version = 3; saved.localOperations.version = 1; delete saved.localOperations.messages;
    saved.localOperations.operations = saved.localOperations.operations.map((operation: { id: string; type: string; targetRelationIds: string[] }) => ({
      id: operation.id, type: operation.type, createdAt: time, targetRelationIds: operation.targetRelationIds, sourceMessageIds: [], note: '',
    }));
    saved.localOperations.operations.push({ id: 'legacy-agree', type: 'AGREE', createdAt: time, targetRelationIds: [reply.id], sourceMessageIds: [], note: '' });
    const reopened = prepareZhihuForViewing(saved), projection = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(reopened));
    expect(reopened.zhihu.localOperations.operations).toHaveLength(3);
    expect(getZhihuReplyRelations(reopened).find(value => value.id === reply.id)?.active).toBe(true);
    for (const username of [null, '原站作者', '本地整理者']) expect(computeEffectiveSuppressedRelIds(projection.edges, projection.messages, username).has(reply.id)).toBe(false);
    expect(reopened.zhihu.archive).toEqual(original.zhihu.archive);
    expect(reopened.messages.some(message => 'state' in message || 'spending' in message)).toBe(false);
  });
  it('adds parallel reply identities without replacing source relations or earlier local replies', () => {
    const data = prepareZhihuForViewing(archive()), source = idFor(data, '2');
    const old = getZhihuReplyRelations(data).find(reply => reply.sourceMessageId === source)!;
    const opposed = sendZhihuLocalRelation(data, { relationType: 'DISAGREE', targetMessageIds: [old.id] });
    const updated = sendZhihuLocalRelation(opposed, { relationType: 'REPLY', sourceMessageIds: [source], targetMessageIds: [idFor(data, '10', 'item')] });
    const fresh = getZhihuReplyRelations(updated).find(reply => reply.sourceMessageId === source && reply.id !== old.id)!;
    expect(fresh.id).not.toBe(old.id); expect(fresh.active).toBe(true);
    expect(updated.zhihu.localOperations.replyDefinitions.some(reply => reply.id === old.id)).toBe(true);
    expect(updated.zhihu.localOperations.operations.map(operation => operation.type)).toEqual(['DISAGREE', 'REPLY']);
    expect(getZhihuReplyRelations(updated).find(reply => reply.id === old.id)?.active).toBe(false);
    const again = sendZhihuLocalRelation(updated, { relationType: 'REPLY', sourceMessageIds: [source], targetMessageIds: [idFor(data, '10', 'item')] });
    expect(getZhihuReplyRelations(again).filter(reply => reply.sourceMessageId === source)).toHaveLength(3);
    expect(getZhihuReplyRelations(again).filter(reply => reply.sourceMessageId === source && reply.active)).toHaveLength(2);
    expect(again.zhihu.overrides).toEqual(data.zhihu.overrides);
    expect(prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(updated))).zhihu.replyRelations).toEqual(updated.zhihu.replyRelations);
  });
  it('verifies old local actions against preserved source observations after a normal source refresh', () => {
    const input = archive([comment('1'), comment('2', { parentCommentId: '1', rootCommentId: '1', author: { id: 'author', name: '技术测试旧名' }, createdAt: time })]);
    const data = prepareZhihuForViewing(input), old = getZhihuReplyRelations(data).find(reply => reply.sourceMessageId === idFor(data, '2'))!;
    const changed = sendZhihuLocalRelation(data, { relationType: 'DISAGREE', targetMessageIds: [old.id] });
    const saved = JSON.parse(serializeZhihuViewingData(changed));
    const source = saved.archive.comments[1];
    source.versions = [structuredClone(source)];
    source.parentCommentId = null; source.rootCommentId = '2'; source.author.name = '技术测试新名'; source.createdAt = '2026-11-02T01:00:00Z';
    const reopened = prepareZhihuForViewing(saved), fresh = getZhihuReplyRelations(reopened).find(reply => reply.sourceMessageId === old.sourceMessageId)!;
    expect(fresh.id).not.toBe(old.id); expect(fresh.active).toBe(true);
    expect(reopened.zhihu.localOperations.operations).toEqual(changed.zhihu.localOperations.operations);
    expect(reopened.zhihu.localOperations.replyDefinitions).toEqual(changed.zhihu.localOperations.replyDefinitions);
    expect(() => sendZhihuLocalRelation(reopened, { relationType: 'DISAGREE', targetMessageIds: [old.id] })).toThrow('外显消息');
    // Removing the preserved observation leaves no evidence for the old relation.
    delete saved.archive.comments[1].versions;
    expect(() => prepareZhihuForViewing(saved)).toThrow('原始评论或关系目标不一致');
  });
  it('keeps additive replies independent from the older sequence/reset/undo overlay', () => {
    const data = prepareZhihuForViewing(archive()), source = idFor(data, '2');
    const old = getZhihuReplyRelations(data).find(reply => reply.sourceMessageId === source)!;
    const opposed = sendZhihuLocalRelation(data, { relationType: 'DISAGREE', targetMessageIds: [old.id] });
    const changed = sendZhihuLocalRelation(opposed, { relationType: 'REPLY', sourceMessageIds: [source], targetMessageIds: [idFor(data, '10', 'item')] });
    const sequenced = updateZhihuRelations(changed, { mode: 'sequence' });
    const undone = undoZhihuRelations(sequenced);
    const restored = getZhihuReplyRelations(undone).find(reply => reply.sourceMessageId === source)!;
    expect(restored.id).toBe(old.id); expect(restored.active).toBe(false);
    expect(getZhihuReplyRelations(undone).some(reply => reply.id.startsWith('zhihu:added:') && reply.active)).toBe(true);
    expect(undone.zhihu.localOperations.operations).toEqual(changed.zhihu.localOperations.operations);
    expect(prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(undone))).zhihu.replyRelations).toEqual(undone.zhihu.replyRelations);
  });
  it('keeps local stance records inside the owning question category', () => {
    const input = { ...archive(), items: [{ ...archive().items[0], question: { id: '11', title: '技术测试标题' } }] };
    const data = prepareZhihuForViewing(input), reply = getZhihuReplyRelations(data)[0];
    const changed = sendZhihuLocalRelation(data, { relationType: 'DISAGREE', targetMessageIds: [reply.id], currentClassificationId: idFor(data, '11', 'question') });
    const category = changed.relations.find(value => value.relationType === 'CLASSIFY')!;
    const projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(changed));
    const effect = deriveContainerEffect({ ...projected, username: null, stakeCounts: {} });
    const members = [...effect.ownership.direct(category.id).textIds];
    expect(members).toContain(reply.id);
    expect(changed.messages.filter(message => changed.zhihu.byMessageId[message.id].kind === 'local-operation').every(message => members.includes(message.id))).toBe(true);
  });
  it('rejects forged local targets and reply definition snapshots, including extras on older files', () => {
    const data = prepareZhihuForViewing(archive()), reply = getZhihuReplyRelations(data)[0];
    expect(() => sendZhihuLocalRelation(data, { relationType: 'DISAGREE', targetMessageIds: ['missing-source-record'] })).toThrow('外显消息');
    const changed = sendZhihuLocalRelation(data, { relationType: 'DISAGREE', targetMessageIds: [reply.id] });
    const saved = JSON.parse(serializeZhihuViewingData(changed));
    saved.localOperations.replyDefinitions[0].targetMessageIds = [idFor(data, '2')];
    expect(() => prepareZhihuForViewing(saved)).toThrow('原始评论或关系目标不一致');
    const old = JSON.parse(serializeZhihuViewingData(changed)); old.version = 2;
    old.localOperations.operations[0].targetRelationIds = [idFor(data, '1')];
    expect(() => prepareZhihuForViewing(old)).toThrow('地址');
    const missing = JSON.parse(serializeZhihuViewingData(changed)); delete missing.localOperations;
    expect(() => prepareZhihuForViewing(missing)).toThrow('缺少本地操作');
  });

  it('supports many sources and targets across works without source-thread or reply-cycle restrictions', () => {
    const input = { ...archive(), items: [...archive().items, { id: '20', type: 'article', text: '' }],
      comments: [...archive().comments, comment('9', { threadId: 'article:20' })] };
    const data = prepareZhihuForViewing(input), sources = [idFor(data, '10', 'item'), idFor(data, '2')], targets = [idFor(data, '1'), idFor(data, '9')];
    const first = sendZhihuLocalRelation(data, { relationType: 'REPLY', sourceMessageIds: sources, targetMessageIds: targets });
    const second = sendZhihuLocalRelation(first, { relationType: 'REPLY', sourceMessageIds: sources, targetMessageIds: targets });
    const added = getZhihuReplyRelations(second).filter(reply => reply.id.startsWith('zhihu:added:'));
    expect(added).toHaveLength(4); expect(added.every(reply => reply.active)).toBe(true);
    expect(added.map(reply => reply.targetMessageIds)).toEqual([targets, targets, targets, targets]);
    // Comment 2 already replies to comment 1. The reverse local reply is independent evidence.
    expect(() => sendZhihuLocalRelation(second, { relationType: 'REPLY', sourceMessageIds: [idFor(data, '1')], targetMessageIds: [idFor(data, '2')] })).not.toThrow();
    const opposed = sendZhihuLocalRelation(second, { relationType: 'DISAGREE', targetMessageIds: [added[0].id] });
    expect(getZhihuReplyRelations(opposed).filter(reply => reply.id.startsWith('zhihu:added:') && reply.active)).toHaveLength(3);
    expect(getZhihuInactiveRelationIds(opposed)).toEqual(new Set([added[0].id]));
    expect(opposed.zhihu.archive).toEqual(input); expect(opposed.zhihu.overrides).toEqual(data.zhihu.overrides);
  });

  it.each(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'] as const)('uses native %s ownership for moving, ordered append, rejection and roundtrip', relationType => {
    const raw = { ...archive([comment('1'), comment('2'), comment('3')]), items: [{ ...archive().items[0], question: { id: '11', title: '技术测试问题' } }] };
    const data = prepareZhihuForViewing(raw), parent = idFor(data, '11', 'question');
    const one = idFor(data, '1'), two = idFor(data, '2'), three = idFor(data, '3');
    const grouped = sendZhihuLocalRelation(data, { relationType, targetMessageIds: [two, one], currentClassificationId: parent,
      ...(['CLASSIFY', 'SUMMARY'].includes(relationType) ? { title: '技术测试组织' } : {}),
      ...(relationType === 'ARRANGE' ? { targetLayout: 'single-row' as const } : {}) });
    const group = getZhihuLocalRelations(grouped).find(relation => relation.relationType === relationType)!;
    const projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(grouped));
    const effect = deriveContainerEffect({ ...projected, username: null, stakeCounts: {} });
    expect([...effect.ownership.direct(group.id).textIds]).toEqual([two, one]);
    expect(effect.ownership.direct(parent).textIds.has(one)).toBe(false);
    expect(effect.ownership.direct(parent).textIds.has(two)).toBe(false);
    expect(effect.ownership.direct(parent).relationIds.has(group.id)).toBe(true);
    const appended = sendZhihuLocalRelation(grouped, { relationType, sourceMessageIds: [group.id], targetMessageIds: [three, two], currentClassificationId: parent });
    expect(getZhihuLocalRelations(appended).find(relation => relation.id === group.id)?.targetMessageIds).toEqual([two, one, three]);
    const noChange = sendZhihuLocalRelation(appended, { relationType, sourceMessageIds: [group.id], targetMessageIds: [two, three] });
    expect(noChange.zhihu.localOperations).toEqual(appended.zhihu.localOperations);
    const opposed = sendZhihuLocalRelation(appended, { relationType: 'DISAGREE', targetMessageIds: [group.id], currentClassificationId: parent });
    const reopened = prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(opposed)));
    const finalProjection = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(reopened));
    for (const username of [null, '原站作者', '本地整理者']) {
      const final = deriveContainerEffect({ ...finalProjection, username, stakeCounts: {} });
      expect(final.suppressed.has(group.id)).toBe(true);
      expect([one, two, three].every(id => final.ownership.direct(parent).textIds.has(id))).toBe(true);
      expect(final.edges.some(edge => edge.relationMessageId === group.id)).toBe(false);
    }
    expect(getZhihuInactiveRelationIds(reopened).has(group.id)).toBe(true);
    expect(reopened.zhihu.archive).toEqual(raw);
    expect(reopened.messages.some(message => 'state' in message || 'spending' in message)).toBe(false);
    expect(reopened.zhihu.localOperations).toEqual(opposed.zhihu.localOperations);
  });

  it('organizes multiple questions as intact members and rejects self/ancestor nesting atomically', () => {
    const raw = { ...archive(), items: [
      { ...archive().items[0], question: { id: '11', title: '技术测试问题甲' } },
      { id: '20', type: 'answer', text: '', question: { id: '21', title: '技术测试问题乙' } },
    ], comments: [...archive().comments, comment('9', { threadId: 'answer:20' })] };
    const data = prepareZhihuForViewing(raw), q1 = idFor(data, '11', 'question'), q2 = idFor(data, '21', 'question');
    const grouped = sendZhihuLocalRelation(data, { relationType: 'CLASSIFY', title: '技术测试总分类', targetMessageIds: [q2, q1] });
    const parent = getZhihuLocalRelations(grouped).find(relation => relation.relationType === 'CLASSIFY')!.id;
    const projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(grouped));
    const effect = deriveContainerEffect({ ...projected, username: null, stakeCounts: {} });
    expect([...effect.ownership.direct(parent).relationIds]).toEqual([q2, q1]);
    expect(effect.ownership.direct(parent).textIds.size).toBe(0);
    expect(effect.ownership.direct(q1).textIds.has(idFor(data, '1'))).toBe(true);
    const before = serializeZhihuViewingData(grouped);
    expect(() => sendZhihuLocalRelation(grouped, { relationType: 'CLASSIFY', sourceMessageIds: [q1], targetMessageIds: [parent] })).toThrow('循环');
    expect(() => sendZhihuLocalRelation(grouped, { relationType: 'CLASSIFY', sourceMessageIds: [parent], targetMessageIds: [parent] })).toThrow('自身');
    expect(() => sendZhihuLocalRelation(grouped, { relationType: 'CLASSIFY', title: '技术测试循环', targetMessageIds: [parent], currentClassificationId: q1 })).toThrow('循环');
    expect(serializeZhihuViewingData(grouped)).toBe(before);
  });

  it('follows native merge and arrange rules for optional new local text', () => {
    const data = prepareZhihuForViewing(archive()), target = idFor(data, '1');
    const merged = sendZhihuLocalRelation(data, { relationType: 'MERGE', content: '技术测试本地文字', targetMessageIds: [target] });
    const merge = getZhihuLocalRelations(merged).find(relation => relation.relationType === 'MERGE')!;
    const mergeText = merged.messages.find(message => merged.zhihu.byMessageId[message.id].kind === 'local-text')!;
    expect(merge.targetMessageIds).not.toContain(mergeText.id);
    const arranged = sendZhihuLocalRelation(data, { relationType: 'ARRANGE', content: '技术测试本地文字', targetMessageIds: [target], targetLayout: 'single-column' });
    const arrangement = getZhihuLocalRelations(arranged).find(relation => relation.relationType === 'ARRANGE')!;
    const arrangedText = arranged.messages.find(message => arranged.zhihu.byMessageId[message.id].kind === 'local-text')!;
    expect(arrangement.targetMessageIds).toEqual([target, arrangedText.id]);
    const native = arranged.messages.find(message => message.id === arrangement.id)!;
    expect(native.parts?.some(part => part.type === 'relation' && part.relation === 'arrange' && part.roles.members.length === 2)).toBe(true);
    expect(native.parts?.some(part => part.type === 'display' && part.layout === 'flow')).toBe(true);
  });

  it('returns arrangement text to its original scope and keeps rejection effective for every perspective at tied timestamps', () => {
    const raw = { ...archive([comment('1')]), items: [{ ...archive().items[0], question: { id: '11', title: '技术测试问题' } }] };
    const data = prepareZhihuForViewing(raw), parent = idFor(data, '11', 'question'), commentId = idFor(data, '1');
    const arranged = sendZhihuLocalRelation(data, { relationType: 'ARRANGE', content: '技术测试附加文字', targetMessageIds: [commentId], currentClassificationId: parent });
    const group = getZhihuLocalRelations(arranged).find(relation => relation.relationType === 'ARRANGE')!;
    const textId = arranged.messages.find(message => arranged.zhihu.byMessageId[message.id].kind === 'local-text')!.id;
    const opposed = sendZhihuLocalRelation(arranged, { relationType: 'DISAGREE', targetMessageIds: [group.id], currentClassificationId: group.id });
    const saved = JSON.parse(serializeZhihuViewingData(opposed));
    saved.localOperations.operations.forEach((operation: { createdAt: string }) => { operation.createdAt = time; });
    saved.localOperations.messages.forEach((message: { createdAt: string }) => { message.createdAt = time; });
    const reopened = prepareZhihuForViewing(saved), projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(reopened));
    const rejectionIds = reopened.messages.filter(message => message.relationType === 'DISAGREE').map(message => message.id);
    for (const username of [null, '原站作者', '本地整理者']) {
      const effect = deriveContainerEffect({ ...projected, username, stakeCounts: {} });
      expect(effect.suppressed.has(group.id)).toBe(true);
      expect([commentId, textId, ...rejectionIds].every(id => effect.ownership.direct(parent).textIds.has(id))).toBe(true);
    }
    expect(reopened.zhihu.membershipParents[textId]).toBe(parent);
    expect(reopened.zhihu.archive).toEqual(raw);
  });

  it('places a batch rejecting the current group and its parent in the surviving ancestor scope', () => {
    const data = prepareZhihuForViewing({ ...archive(), items: [{ ...archive().items[0], question: { id: '11', title: '技术测试问题' } }] });
    const parent = idFor(data, '11', 'question'), target = idFor(data, '1');
    const first = sendZhihuLocalRelation(data, { relationType: 'CLASSIFY', title: '技术测试外层', targetMessageIds: [target], currentClassificationId: parent });
    const outer = getZhihuLocalRelations(first).find(relation => relation.relationType === 'CLASSIFY')!.id;
    const second = sendZhihuLocalRelation(first, { relationType: 'CLASSIFY', title: '技术测试内层', targetMessageIds: [target], currentClassificationId: outer });
    const inner = getZhihuLocalRelations(second).find(relation => relation.relationType === 'CLASSIFY' && relation.id !== outer)!.id;
    const opposed = sendZhihuLocalRelation(second, { relationType: 'DISAGREE', targetMessageIds: [inner, outer], currentClassificationId: inner });
    const projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(opposed));
    for (const username of [null, '本地整理者']) {
      const effect = deriveContainerEffect({ ...projected, username, stakeCounts: {} });
      expect(effect.suppressed.has(inner) && effect.suppressed.has(outer)).toBe(true);
      expect(effect.ownership.direct(parent).textIds.has(target)).toBe(true);
      expect(opposed.messages.filter(message => message.relationType === 'DISAGREE').every(message => effect.ownership.direct(parent).textIds.has(message.id))).toBe(true);
    }
  });

  it('validates downloaded local definitions and organization history instead of trusting derived projections', () => {
    const data = prepareZhihuForViewing(archive());
    const grouped = sendZhihuLocalRelation(data, { relationType: 'CLASSIFY', title: '技术测试分类', targetMessageIds: [idFor(data, '1')] });
    const malformed = JSON.parse(serializeZhihuViewingData(grouped));
    malformed.localOperations.messages[0].targetMessageIds = ['missing'];
    expect(() => prepareZhihuForViewing(malformed)).toThrow('成员与创建记录不一致');
    const orphaned = JSON.parse(serializeZhihuViewingData(grouped)); orphaned.localOperations.operations = [];
    expect(() => prepareZhihuForViewing(orphaned)).toThrow('无对应创建操作');
    const late = JSON.parse(serializeZhihuViewingData(grouped)); late.localOperations.operations[0].memberMessageIds = [late.localOperations.messages[0].id];
    late.localOperations.messages[0].targetMessageIds = [late.localOperations.messages[0].id];
    expect(() => prepareZhihuForViewing(late)).toThrow('不存在于当前文档');
  });
});
