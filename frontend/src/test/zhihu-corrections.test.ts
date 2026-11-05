import { describe, expect, it } from 'vitest';
import { prepareZhihuForViewing, sendZhihuLocalRelation, serializeZhihuViewingData, getZhihuCorrectableFields,
  getZhihuDisplayFields, getZhihuMissingContent, getZhihuLocalRelations, getZhihuInactiveRelationIds } from '../utils/zhihuArchive';
import { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import { computeCorrectionVersions, computeEffectiveSuppressedRelIds, withCorrectionContent } from '../utils/modelBridge';
import { materializeBodyVersion, type Message as CoreMessage } from '@gonglun/core';

// Technical structure fixtures only; none are exported discussion corpus.
const fixture = () => prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
  items: [{ id: '10', type: 'answer', text: 'A', completeness: { body: 'complete' }, question: { id: '20', title: 'Q', text: null, completeness: { title: 'complete', body: 'unknown' } } }],
  comments: [{ id: '1', sourceId: '1', threadId: 'answer:10', text: 'C', rootCommentId: '1', parentCommentId: null,
    completeness: { body: 'partial' }, issues: [{ code: 'body-truncated', message: '正文截断' }] }] });
const question = 'zhihu:question:20', answer = 'zhihu:item:answer:10', comment = 'zhihu:comment:answer%3A10:1';
const reopen = (data: ReturnType<typeof fixture>) => prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(data)));
const correctionId = (data: ReturnType<typeof fixture>) => data.zhihu.localOperations.messages.at(-1)!.id;
function native(data: ReturnType<typeof fixture>, username: string | null = null) {
  const projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(data));
  const invalid = computeEffectiveSuppressedRelIds(projected.edges, projected.messages, username);
  return { ...projected, invalid, edits: computeCorrectionVersions(projected.messages, projected.edges, invalid, username) };
}

describe('local Zhihu field corrections', () => {
  it('keeps question title and missing description independent through native display, opposition and reopen', () => {
    const original = fixture();
    const body = sendZhihuLocalRelation(original, { relationType: 'CORRECT', targetMessageIds: [question], content: 'D', correctionField: 'body' });
    const bodyId = correctionId(body);
    const both = reopen(sendZhihuLocalRelation(body, { relationType: 'CORRECT', targetMessageIds: [question], content: 'Q2', correctionField: 'title' }));
    const titleId = correctionId(both);
    expect(both.zhihu.archive).toEqual(original.zhihu.archive);
    expect(both.zhihu.byMessageId[question]).toMatchObject({ questionTitle: 'Q', descriptionKnown: false, descriptionCompleteness: 'unknown' });
    expect(getZhihuDisplayFields(both, question)).toEqual({ body: 'D', title: 'Q2', bodyCorrectionId: bodyId, titleCorrectionId: titleId });
    expect(both.messages.find(message => message.id === question)?.parts).toContainEqual({ id: 'source-fields', type: 'data', value: { title: 'Q' } });
    expect(both.messages.find(message => message.id === question)?.content).toBe('');
    expect(both.messages.find(message => message.id === titleId)?.targetRefs).toEqual([{ kind: 'message', messageId: question,
      reference: { messageId: question, revision: 1, partId: 'source-fields', path: ['value', 'title'] } }]);
    for (const username of [null, '原站作者', '本地整理者']) {
      const projected = native(both, username), current = projected.edits.get(question)!.current!;
      expect(current.content).toBe('D'); expect(current.appliedCorrectionIds).toEqual([bodyId]);
      const displayed = withCorrectionContent(projected.messages.find(message => message.id === question)!, current.content, current.changes);
      expect(displayed.relationPayload?.title).toBe('Q2'); expect(displayed.parts?.find(part => part.id === 'body')).toMatchObject({ text: 'D' });
      const snapshot = materializeBodyVersion(current.bodyVersion!, id => both.messages.find(message => message.id === id) as unknown as CoreMessage);
      const fromSnapshot = withCorrectionContent(projected.messages.find(message => message.id === question)!, current.content, current.changes, snapshot);
      expect(fromSnapshot.relationPayload?.title).toBe('Q2');
      expect(fromSnapshot.parts?.find(part => part.id === 'body')).toMatchObject({ text: 'D' });
      expect(fromSnapshot.parts?.find(part => part.id === 'source-fields')).toEqual({ id: 'source-fields', type: 'data', value: { title: 'Q' } });
    }
    const withoutBody = reopen(sendZhihuLocalRelation(both, { relationType: 'DISAGREE', targetMessageIds: [bodyId] }));
    expect(getZhihuDisplayFields(withoutBody, question)).toEqual({ body: '', title: 'Q2', titleCorrectionId: titleId });
    for (const username of [null, '原站作者', '本地整理者']) expect(native(withoutBody, username).edits.get(question)?.current).toBeUndefined();
    const restored = reopen(sendZhihuLocalRelation(withoutBody, { relationType: 'DISAGREE', targetMessageIds: [titleId] }));
    expect(getZhihuDisplayFields(restored, question)).toEqual({ body: '', title: 'Q' });
    expect(restored.zhihu.archive).toEqual(original.zhihu.archive);
    expect(restored.zhihu.localOperations.messages.filter(message => message.relationType === 'CORRECT')).toHaveLength(2);
  });

  it('preserves local author, field identity and source bodies while independent whole-text revisions compete', () => {
    const original = fixture();
    const first = sendZhihuLocalRelation(original, { relationType: 'CORRECT', targetMessageIds: [comment], content: 'C1' });
    const firstId = correctionId(first);
    const second = sendZhihuLocalRelation(first, { relationType: 'CORRECT', targetMessageIds: [comment], content: 'C2' });
    const secondId = correctionId(second);
    const snapshot = JSON.parse(serializeZhihuViewingData(second));
    expect(snapshot).toMatchObject({ version: 5, localOperations: { version: 3 } });
    expect(snapshot.localOperations.messages.at(-1)).toMatchObject({ authorId: 'zhihu:local-editor', author: '本地整理者',
      correction: { field: 'body', targetMessageId: comment, baseContent: 'C', baseStatus: 'partial' } });
    expect(native(second).edits.get(comment)?.current?.content).toBe('C2');
    const reverted = reopen(sendZhihuLocalRelation(second, { relationType: 'DISAGREE', targetMessageIds: [secondId] }));
    for (const username of [null, '原站作者', '本地整理者']) expect(native(reverted, username).edits.get(comment)?.current?.content).toBe('C1');
    expect(getZhihuDisplayFields(reverted, comment)).toMatchObject({ body: 'C1', bodyCorrectionId: firstId });
    expect(reverted.zhihu.archive).toEqual(original.zhihu.archive);
    expect(getZhihuLocalRelations(reverted).find(record => record.id === secondId)?.active).toBe(false);
  });

  it('keeps missing-source status after local completion and does not invent missing characters from empty text', () => {
    const original = fixture();
    expect(getZhihuMissingContent(original).map(field => [field.messageId, field.field, field.originalStatus])).toEqual([
      [comment, 'body', 'partial'], [question, 'body', 'unknown'],
    ]);
    const edited = sendZhihuLocalRelation(original, { relationType: 'CORRECT', targetMessageIds: [question], content: 'D' });
    expect(getZhihuMissingContent(edited).find(field => field.messageId === question)).toMatchObject({ originalStatus: 'unknown', localCorrectionId: correctionId(edited), value: 'D', originalValue: '' });
    const empty = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1, items: [{ id: 'a', type: 'answer', text: '', completeness: { body: 'complete' },
      question: { id: 'q', title: 'Q', text: '', completeness: { title: 'complete', body: 'complete' } } }], comments: [] });
    expect(getZhihuMissingContent(empty)).toEqual([]);
    const legacy = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1, items: [{ id: 'a', type: 'answer', text: 'A' }],
      comments: [{ id: '1', threadId: 'answer:a', text: 'C', completeness: { body: 'complete' }, issues: [{ code: 'missing-body', message: '缺少一段内容' }] }] });
    expect(getZhihuMissingContent(legacy).map(field => field.originalStatus)).toEqual(['unknown', 'partial']);
  });

  it.each([
    { title: 'Q-part', completeness: { title: 'partial', body: 'complete' }, expected: 'partial' },
    { title: 'Q-unknown', completeness: { title: 'unknown', body: 'complete' }, expected: 'unknown' },
    { title: 'Q-legacy', completeness: { body: 'complete' }, expected: 'unknown' },
    { title: '', completeness: { title: 'complete', body: 'complete' }, expected: 'complete' },
  ] as const)('preserves explicit or missing title completeness: $expected / $title', ({ title, completeness, expected }) => {
    const data = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
      items: [{ id: 'a', type: 'answer', text: '', completeness: { body: 'complete' }, question: { id: 'q', title, text: '', completeness } }], comments: [] });
    expect(getZhihuCorrectableFields(data, 'zhihu:question:q').find(field => field.field === 'title')).toMatchObject({ originalValue: title, originalStatus: expected });
    expect(data.zhihu.byMessageId['zhihu:question:q']).toMatchObject({ questionTitle: title, titleCompleteness: expected });
    expect(getZhihuMissingContent(data).some(field => field.messageId === 'zhihu:question:q' && field.field === 'title')).toBe(expected !== 'complete');
    expect(getZhihuDisplayFields(reopen(data), 'zhihu:question:q').title).toBe(title);
  });

  it('retains old corrections as inactive evidence when a fresh capture changes the addressed base', () => {
    const edited = sendZhihuLocalRelation(fixture(), { relationType: 'CORRECT', targetMessageIds: [comment], content: 'C1' });
    const envelope = JSON.parse(serializeZhihuViewingData(edited));
    envelope.archive.comments[0].versions = [{ text: 'C' }]; envelope.archive.comments[0].text = 'C-new';
    const refreshed = prepareZhihuForViewing(envelope), id = correctionId(edited);
    expect(refreshed.zhihu.localOperations).toEqual(edited.zhihu.localOperations);
    expect(getZhihuInactiveRelationIds(refreshed).has(id)).toBe(true);
    expect(getZhihuDisplayFields(refreshed, comment).body).toBe('C-new');
    expect(refreshed.zhihu.warnings.join('\n')).toContain('未套用到新的原站内容');
    for (const username of [null, '原站作者', '本地整理者']) expect(native(refreshed, username).edits.get(comment)?.current).toBeUndefined();
    expect(reopen(refreshed).zhihu.localOperations).toEqual(edited.zhihu.localOperations);
  });

  it('treats an unknown-to-known-empty source update as a new base instead of filling an actually empty source', () => {
    const edited = sendZhihuLocalRelation(fixture(), { relationType: 'CORRECT', targetMessageIds: [question], content: 'D' });
    const envelope = JSON.parse(serializeZhihuViewingData(edited));
    envelope.archive.items[0].question.text = ''; envelope.archive.items[0].question.completeness.body = 'complete';
    const refreshed = prepareZhihuForViewing(envelope);
    expect(getZhihuDisplayFields(refreshed, question).body).toBe('');
    expect(getZhihuInactiveRelationIds(refreshed).has(correctionId(edited))).toBe(true);
    const oldBodyVersion = native(edited).edits.get(question)!.current!.bodyVersion!;
    expect(() => materializeBodyVersion(oldBodyVersion, id => refreshed.messages.find(message => message.id === id) as unknown as CoreMessage)).toThrow(/基础|适用|变化/);
  });

  it.each(['CLASSIFY', 'SUMMARY'] as const)('corrects the text of local %s without editing membership', type => {
    const group = sendZhihuLocalRelation(fixture(), { relationType: type, targetMessageIds: [answer], title: 'G', content: type === 'SUMMARY' ? 'S' : undefined });
    const id = correctionId(group), field = type === 'CLASSIFY' ? 'title' : 'body';
    const edited = reopen(sendZhihuLocalRelation(group, { relationType: 'CORRECT', targetMessageIds: [id], correctionField: field, content: 'X' }));
    expect(getZhihuCorrectableFields(edited, id).find(candidate => candidate.field === field)?.value).toBe('X');
    expect(getZhihuLocalRelations(edited).find(record => record.id === id)?.targetMessageIds).toEqual([answer]);
    if (type === 'SUMMARY') expect(native(edited).edits.get(id)?.current?.content).toBe('X');
    const restored = sendZhihuLocalRelation(edited, { relationType: 'DISAGREE', targetMessageIds: [correctionId(edited)] });
    expect(getZhihuCorrectableFields(restored, id).find(candidate => candidate.field === field)?.value).toBe(type === 'CLASSIFY' ? 'G' : 'S');
  });

  it('corrects standalone local text and rejects bodies without a supported text field', () => {
    const group = sendZhihuLocalRelation(fixture(), { relationType: 'ARRANGE', targetMessageIds: [answer], content: 'T' });
    const localText = group.zhihu.localOperations.messages.find(message => message.kind === 'text')!.id;
    const edited = sendZhihuLocalRelation(group, { relationType: 'CORRECT', targetMessageIds: [localText], content: 'T2' });
    expect(native(reopen(edited)).edits.get(localText)?.current?.content).toBe('T2');
    expect(() => sendZhihuLocalRelation(group, { relationType: 'CORRECT', targetMessageIds: [correctionId(group)], content: 'X' })).toThrow(/所选文字字段/);
    expect(() => sendZhihuLocalRelation(group, { relationType: 'CORRECT', targetMessageIds: [comment, answer], content: 'X' })).toThrow(/一个目标/);
    expect(() => sendZhihuLocalRelation(group, { relationType: 'CORRECT', targetMessageIds: [comment], sourceMessageIds: [answer], content: 'X' })).toThrow(/来源集合/);
  });

  it('validates correction bases, versions and target declarations on file input', () => {
    const original = sendZhihuLocalRelation(fixture(), { relationType: 'CORRECT', targetMessageIds: [answer], content: 'A2' });
    const envelope = () => JSON.parse(serializeZhihuViewingData(original));
    const fingerprint = envelope(); fingerprint.localOperations.messages.at(-1).correction.baseFingerprint = 'bad';
    expect(() => prepareZhihuForViewing(fingerprint)).toThrow(/指纹/);
    const target = envelope(); target.localOperations.messages.at(-1).targetMessageIds = [comment];
    expect(() => prepareZhihuForViewing(target)).toThrow(/目标/);
    const version = envelope(); version.localOperations.version = 2;
    expect(() => prepareZhihuForViewing(version)).toThrow(/版本/);
    const author = envelope(); author.localOperations.messages.at(-1).author = '原站作者';
    expect(() => prepareZhihuForViewing(author)).toThrow(/作者/);
    for (const legacyVersion of [1, 2, 3, 4]) {
      const old = { format: 'gonglun-zhihu-reviewed', version: legacyVersion, archive: fixture().zhihu.archive, overrides: fixture().zhihu.overrides,
        ...(legacyVersion >= 3 ? { localOperations: { format: 'gonglun-zhihu-local-operations', version: legacyVersion === 3 ? 1 : 2, operations: [], replyDefinitions: [], messages: [] } } : {}) };
      expect(prepareZhihuForViewing(old).zhihu.localOperations.version).toBe(3);
    }
  });
});
