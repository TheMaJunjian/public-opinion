import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareZhihuForViewing, sendZhihuLocalRelation, serializeZhihuViewingData,
  getZhihuLocalRelations, getZhihuInactiveRelationIds, getZhihuMissingContent } from '../utils/zhihuArchive';
import { serializeGonglunZhihuViewingData } from '../utils/zhihuGonglunExport';
import { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import { computeCorrectionVersions, computeEffectiveSuppressedRelIds } from '../utils/modelBridge';
import { effectiveCardWidths } from '../utils/cardWidth';

// Technical structure fixtures, never a synthetic discussion corpus.
const fixture = () => prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
  items: [{ id: 'a', type: 'answer', text: 'A', completeness: { body: 'complete' },
    question: { id: 'q', title: 'Q', text: null, completeness: { title: 'complete', body: 'unknown' } } }],
  comments: [{ id: 'c', threadId: 'answer:a', text: 'C', rootCommentId: 'c', parentCommentId: null, completeness: { body: 'complete' } }] });
const answer = 'zhihu:item:answer:a', question = 'zhihu:question:q', comment = 'zhihu:comment:answer%3Aa:c';
const lastId = (data: ReturnType<typeof fixture>) => data.zhihu.localOperations.messages.at(-1)!.id;
const resize = (data: ReturnType<typeof fixture>, target = answer, width = 640) => sendZhihuLocalRelation(data, {
  relationType: 'CORRECT', correctionKind: 'WIDTH', correctionWidth: width, targetMessageIds: [target],
});
const reopen = (data: ReturnType<typeof fixture>) => prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(data)));
function projected(data: ReturnType<typeof fixture>, username: string | null = null) {
  const result = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(data));
  const suppressed = computeEffectiveSuppressedRelIds(result.edges, result.messages, username);
  return { ...result, suppressed, widths: effectiveCardWidths(result.messages, result.edges, username),
    edits: computeCorrectionVersions(result.messages, result.edges, suppressed, username) };
}
afterEach(() => vi.useRealTimers());

describe('persistent local Zhihu width corrections', () => {
  it('uses native whole-message CORRECT parts and survives both document download formats', () => {
    const original = fixture(), resized = resize(original), id = lastId(resized);
    expect(resized.zhihu.archive).toEqual(original.zhihu.archive);
    expect(resized.zhihu.overrides).toEqual(original.zhihu.overrides);
    expect(resized.zhihu.localOperations.messages.at(-1)).toMatchObject({ correctionKind: 'WIDTH', correctionWidth: 640,
      authorId: 'zhihu:local-editor', author: '本地整理者', content: '' });
    const record = resized.messages.find(message => message.id === id)!;
    expect(record.parts).toEqual([
      { id: 'relation', type: 'relation', relation: 'correct', roles: { target: [{ id: 'member-0', reference: { messageId: answer } }] } },
      { id: 'data', type: 'data', value: { correctionKind: 'WIDTH', correctionWidth: 640 } },
    ]);
    expect(record.targetRefs).toEqual([{ kind: 'message', messageId: answer }]);
    expect(record.relationPayload).toMatchObject({ source: 'zhihu-local-view', correctionKind: 'WIDTH', correctionWidth: 640 });
    expect(record.relationPayload).not.toHaveProperty('correctionAfterContent');
    expect(getZhihuLocalRelations(resized)).toContainEqual(expect.objectContaining({ id, relationType: 'CORRECT', active: true, title: '宽度调整 · 640 px' }));
    for (const text of [serializeZhihuViewingData(resized), serializeGonglunZhihuViewingData(resized)]) {
      const loaded = prepareZhihuForViewing(JSON.parse(text));
      expect(loaded.zhihu.localOperations).toEqual(resized.zhihu.localOperations);
      expect(loaded.zhihu.archive).toEqual(original.zhihu.archive);
      for (const username of [null, '原站作者', '本地整理者']) {
        const view = projected(loaded, username);
        expect(view.widths).toEqual({ [answer]: 640 });
        expect(view.edits.size).toBe(0);
        expect(view.messages.find(message => message.id === answer)?.content).toBe('A');
      }
      expect(archiveToWorkbenchSnapshot(loaded).stakes).toEqual({});
    }
  });

  it('opposes one saved width, restores the previous width, and accepts a new width independently of viewer identity', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const first = resize(fixture(), answer, 480), firstId = lastId(first);
    vi.advanceTimersByTime(1);
    const second = resize(first, answer, 960), secondId = lastId(second);
    for (const username of [null, '原站作者', '本地整理者']) expect(projected(second, username).widths[answer]).toBe(960);
    const opposed = reopen(sendZhihuLocalRelation(second, { relationType: 'DISAGREE', targetMessageIds: [secondId] }));
    expect(getZhihuInactiveRelationIds(opposed).has(secondId)).toBe(true);
    for (const username of [null, '原站作者', '本地整理者']) expect(projected(opposed, username).widths[answer]).toBe(480);
    const both = reopen(sendZhihuLocalRelation(opposed, { relationType: 'DISAGREE', targetMessageIds: [firstId] }));
    for (const username of [null, '原站作者', '本地整理者']) expect(projected(both, username).widths).toEqual({});
    vi.advanceTimersByTime(1);
    const third = reopen(resize(both, answer, 720));
    for (const username of [null, '原站作者', '本地整理者']) expect(projected(third, username).widths[answer]).toBe(720);
    expect(third.zhihu.localOperations.messages).toHaveLength(3);
    expect(third.zhihu.localOperations.operations).toHaveLength(5);
  });

  it('keeps width independent of body corrections, missing-source status, and later source captures', () => {
    const original = fixture();
    const body = sendZhihuLocalRelation(original, { relationType: 'CORRECT', targetMessageIds: [question], content: 'D' });
    const resized = resize(body, question, 800), widthId = lastId(resized);
    expect(getZhihuMissingContent(resized)).toEqual(getZhihuMissingContent(body));
    const view = projected(reopen(resized));
    expect(view.widths[question]).toBe(800); expect(view.edits.get(question)?.current?.content).toBe('D');
    const opposed = sendZhihuLocalRelation(resized, { relationType: 'DISAGREE', targetMessageIds: [widthId] });
    expect(projected(opposed).widths).toEqual({}); expect(projected(opposed).edits.get(question)?.current?.content).toBe('D');
    const envelope = JSON.parse(serializeZhihuViewingData(resized));
    envelope.archive.items[0].question.text = 'D-new'; envelope.archive.items[0].question.completeness.body = 'complete';
    const refreshed = prepareZhihuForViewing(envelope);
    expect(projected(refreshed).widths[question]).toBe(800);
    expect(projected(refreshed).edits.get(question)?.current).toBeUndefined();
    expect(refreshed.zhihu.localOperations).toEqual(resized.zhihu.localOperations);
  });

  it.each(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'] as const)('resizes a whole local %s organization without changing members', type => {
    const group = sendZhihuLocalRelation(fixture(), { relationType: type, targetMessageIds: [comment],
      ...(['CLASSIFY', 'SUMMARY'].includes(type) ? { title: 'G' } : {}) });
    const groupId = lastId(group), resized = reopen(resize(group, groupId, 900));
    expect(projected(resized).widths[groupId]).toBe(900);
    expect(getZhihuLocalRelations(resized).find(record => record.id === groupId)?.targetMessageIds).toEqual([comment]);
    const widthId = lastId(resized), restored = sendZhihuLocalRelation(resized, { relationType: 'DISAGREE', targetMessageIds: [widthId] });
    expect(projected(restored).widths).toEqual({});
    expect(getZhihuLocalRelations(restored).find(record => record.id === groupId)?.active).toBe(true);
  });

  it('validates width, mode and whole-message targets before appending history', () => {
    const data = fixture(), input = { relationType: 'CORRECT' as const, correctionKind: 'WIDTH' as const, targetMessageIds: [answer], correctionWidth: 640 };
    for (const width of [319, 2401, 500.5, NaN, Infinity, '640', null]) expect(() => sendZhihuLocalRelation(data, { ...input, correctionWidth: width as number })).toThrow(/整数/);
    for (const width of [320, 2400]) expect(projected(resize(data, answer, width)).widths[answer]).toBe(width);
    expect(() => sendZhihuLocalRelation(data, { ...input, targetMessageIds: [answer, comment] })).toThrow(/一个目标/);
    expect(() => sendZhihuLocalRelation(data, { ...input, sourceMessageIds: [comment] })).toThrow(/来源集合/);
    expect(() => sendZhihuLocalRelation(data, { ...input, targetMessageIds: ['missing'] })).toThrow(/当前文档/);
    expect(() => sendZhihuLocalRelation(data, { ...input, content: 'X' })).toThrow(/夹带正文/);
    expect(() => sendZhihuLocalRelation(data, { ...input, correctionField: 'title' })).toThrow(/夹带正文/);
    expect(() => sendZhihuLocalRelation(data, { ...input, correctionKind: 'TEXT', content: 'X' })).toThrow(/夹带宽度/);
    expect(data.zhihu.localOperations.operations).toEqual([]);
  });

  it('rejects damaged downloaded width definitions instead of silently treating them as text or discarding their values', () => {
    const resized = resize(fixture()), envelope = () => JSON.parse(serializeZhihuViewingData(resized));
    const changes: Array<(value: ReturnType<typeof envelope>) => void> = [
      value => { value.localOperations.messages.at(-1).correctionWidth = '640'; },
      value => { value.localOperations.messages.at(-1).correctionKind = 'OTHER'; },
      value => { value.localOperations.messages.at(-1).correction = { field: 'body' }; },
      value => { value.localOperations.messages.at(-1).content = 'X'; },
      value => { value.localOperations.messages.at(-1).targetMessageIds = [comment]; },
      value => { value.localOperations.messages.at(-1).author = '原站作者'; },
      value => { value.localOperations.operations.at(-1).sourceMessageIds = [comment]; },
      value => { value.localOperations.version = 2; },
    ];
    for (const change of changes) { const input = envelope(); change(input); expect(() => prepareZhihuForViewing(input)).toThrow(); }
  });
});
