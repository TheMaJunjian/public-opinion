import { describe, expect, it } from 'vitest';
import { resolveStance, type Message as CoreMessage, type Reference } from '@gonglun/core';
import { getZhihuArchiveIdentity, getZhihuInactiveRelationIds, getZhihuReplyRelations, prepareZhihuForViewing, sendZhihuLocalRelation, serializeZhihuViewingData, type ZhihuViewingData } from '../utils/zhihuArchive';
import { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import { computeEffectiveSuppressedRelIds } from '../utils/modelBridge';

const fixture = () => prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
  owner: { id: 'stance-fixture-owner', name: '结构测试账号' },
  items: [{ id: '10', type: 'answer', text: 'A😀BC', author: { id: 'source-author', name: '原站作者' } }],
  comments: [
    { id: '1', sourceId: '1', threadId: 'answer:10', text: 'D😀EF', parentCommentId: null, rootCommentId: '1' },
    { id: '2', sourceId: '2', threadId: 'answer:10', text: 'G😀HI', parentCommentId: '1', rootCommentId: '1' },
  ],
});
const idFor = (data: ZhihuViewingData, source: string, kind = 'comment') => Object.entries(data.zhihu.byMessageId).find(([, meta]) => meta.sourceId === source && meta.kind === kind)![0];
const reopen = (data: ZhihuViewingData) => prepareZhihuForViewing(JSON.parse(serializeZhihuViewingData(data)));
const newStances = (data: ZhihuViewingData, type: 'AGREE' | 'DISAGREE') => data.messages.filter(message => message.relationType === type);

describe('native local document agreement and opposition', () => {
  it('rebuilds from bounded evidence and logs without cloning or trusting redundant derived graph rows', () => {
    const data = fixture(), target = idFor(data, '1');
    const saved = sendZhihuLocalRelation(data, { relationType: 'AGREE', targetMessageIds: [target] });
    const derived: unknown[] = []; derived.push(derived);
    const input = { ...saved, messages: derived, relations: derived, zhihu: { ...saved.zhihu, byMessageId: { ignored: derived } } };
    const rebuilt = prepareZhihuForViewing(input);
    expect(rebuilt.zhihu.archive).toEqual(saved.zhihu.archive);
    expect(rebuilt.zhihu.localOperations).toEqual(saved.zhihu.localOperations);
    expect(getZhihuArchiveIdentity(input)).toBe(saved.zhihu.archiveId);
    expect(rebuilt.messages.some(message => message.relationType === 'AGREE')).toBe(true);
    const badSource = { ...saved, zhihu: { ...saved.zhihu, archive: { ...saved.zhihu.archive, unsafe: derived } } };
    expect(() => prepareZhihuForViewing(badSource)).toThrow('循环引用');
  });

  it.each(['AGREE', 'DISAGREE'] as const)('preserves %s provenance between source text and a target message without modifying or hiding source bodies', type => {
    const data = fixture(), source = idFor(data, '10', 'item'), target = idFor(data, '1');
    const next = sendZhihuLocalRelation(data, { relationType: type, sourceMessageIds: [source], targetMessageIds: [target] });
    const stance = archiveToWorkbenchSnapshot(next).relations.find(relation => relation.relationType === type)!;
    expect(stance.sourceMessageId).toBe(source);
    expect(stance.sourceRefs).toEqual([{ messageId: source }]);
    expect(stance.targetRefs).toEqual([{ kind: 'message', messageId: target, reference: { messageId: target } }]);
    expect(stance.createdBy).toMatchObject({ id: 'zhihu:local-editor', username: '本地整理者' });
    expect(next.zhihu.inactiveRelationIds).not.toContain(target);
    expect(next.messages.find(message => message.id === target)?.content).toBe('D😀EF');
    expect(next.zhihu.archive).toEqual(data.zhihu.archive);
    expect(reopen(next).zhihu.localOperations).toEqual(next.zhihu.localOperations);
    expect(next.messages.every(message => !('spending' in message))).toBe(true);
  });

  it('keeps distinct source and target fragments of the same messages through native parts and file reopening', () => {
    const data = fixture(), source = idFor(data, '10', 'item'), otherSource = idFor(data, '2'), target = idFor(data, '1');
    const sourceReferences: Reference[] = [
      { messageId: source, revision: 1, partId: 'body', range: { start: 1, end: 3 } },
      { messageId: source, revision: 1, partId: 'body', range: { start: 3, end: 4 } },
      { messageId: otherSource },
    ];
    const targetReferences: Reference[] = [
      { messageId: target, revision: 1, partId: 'body', range: { start: 1, end: 3 } },
      { messageId: target, revision: 1, partId: 'body', range: { start: 3, end: 4 } },
    ];
    const next = sendZhihuLocalRelation(data, { relationType: 'AGREE', sourceMessageIds: sourceReferences.map(reference => reference.messageId),
      targetMessageIds: [target, target], sourceReferences, targetReferences });
    const stances = archiveToWorkbenchSnapshot(next).relations.filter(relation => relation.relationType === 'AGREE');
    expect(stances).toHaveLength(4);
    expect(stances.filter(relation => relation.sourceMessageId === source).every(relation => JSON.stringify(relation.sourceRefs) === JSON.stringify(sourceReferences.slice(0, 2)))).toBe(true);
    expect(stances.flatMap(relation => relation.targetRefs).map(target => target.kind === 'text-fragment' ? target.text : '')).toEqual(['😀', '😀', 'E', 'E']);
    for (const relation of stances) {
      const part = relation.parts?.find(part => part.type === 'relation');
      expect(part?.type === 'relation' ? part.roles.source.map(binding => binding.reference) : []).toEqual(relation.sourceRefs);
      expect(part?.type === 'relation' ? part.roles.target[0].reference : null).toEqual(relation.targetRefs[0].reference);
    }
    expect(next.zhihu.inactiveRelationIds).toEqual([]);
    expect(reopen(next).zhihu.localOperations).toEqual(next.zhihu.localOperations);
  });

  it('does not let opposing a body fragment disable the reply or whole body, and keeps its range when agreeing to the opposition', () => {
    const data = fixture(), target = idFor(data, '1');
    const reference: Reference = { messageId: target, revision: 1, partId: 'body', range: { start: 1, end: 3 } };
    const opposed = sendZhihuLocalRelation(data, { relationType: 'DISAGREE', targetMessageIds: [target], targetReferences: [reference] });
    expect(getZhihuInactiveRelationIds(opposed).size).toBe(0);
    expect(getZhihuReplyRelations(opposed).every(reply => reply.active)).toBe(true);
    const opposition = newStances(opposed, 'DISAGREE')[0];
    const agreed = reopen(sendZhihuLocalRelation(opposed, { relationType: 'AGREE', targetMessageIds: [opposition.id] }));
    const resolved = resolveStance({ messageId: opposition.id }, 'pro', id => agreed.messages.find(message => message.id === id) as unknown as CoreMessage);
    expect(resolved).toMatchObject({ target: reference, side: 'pro' });
    const projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(agreed));
    expect(projected.messages.some(message => message.id === opposition.id)).toBe(true);
    expect(computeEffectiveSuppressedRelIds(projected.edges, projected.messages, null).has(target)).toBe(false);
  });

  it('uses the newest native stance direction when agreeing or disagreeing with another stance on a reply', () => {
    const data = fixture(), reply = getZhihuReplyRelations(data)[0];
    const opposed = sendZhihuLocalRelation(data, { relationType: 'DISAGREE', targetMessageIds: [reply.id] });
    const opposition = newStances(opposed, 'DISAGREE')[0];
    const agreed = reopen(sendZhihuLocalRelation(opposed, { relationType: 'AGREE', targetMessageIds: [opposition.id] }));
    const agreement = newStances(agreed, 'AGREE')[0];
    expect(getZhihuReplyRelations(agreed).find(candidate => candidate.id === reply.id)?.active).toBe(true);
    const opposedAgain = reopen(sendZhihuLocalRelation(agreed, { relationType: 'DISAGREE', targetMessageIds: [agreement.id] }));
    expect(getZhihuReplyRelations(opposedAgain).find(candidate => candidate.id === reply.id)?.active).toBe(false);
    for (const [value, expected] of [[agreed, false], [opposedAgain, true]] as const) {
      const projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(value));
      for (const username of [null, '本地整理者', '原站作者'])
        expect(computeEffectiveSuppressedRelIds(projected.edges, projected.messages, username).has(reply.id)).toBe(expected);
    }
    expect(opposedAgain.zhihu.archive).toEqual(data.zhihu.archive);
    expect(opposedAgain.zhihu.overrides).toEqual(data.zhihu.overrides);
  });

  it.each([
    { messageId: 'wrong-message', partId: 'body', range: { start: 0, end: 1 } },
    { revision: 2, partId: 'body', range: { start: 0, end: 1 } },
    { partId: 'body', range: { start: 0, end: 500 } },
    { partId: 'body', range: { start: 1, end: 1 } },
    { partId: 'missing-part' },
    { path: ['__proto__'] },
    { context: { kind: 'BODY', version: { format: 2, messageId: 'wrong-message', revision: 1, corrections: [] } } },
  ])('rejects an invalid explicit target address rather than silently widening it: %j', partial => {
    const data = fixture(), target = idFor(data, '1');
    expect(() => sendZhihuLocalRelation(data, { relationType: 'AGREE', targetMessageIds: [target], targetReferences: [{ messageId: target, ...partial } as Reference] })).toThrow();
    expect(data.zhihu.localOperations.operations).toHaveLength(0);
  });

  it('rejects a forged stored range or source identity while keeping a valid native reference context', () => {
    const data = fixture(), target = idFor(data, '1'), source = idFor(data, '10', 'item');
    const reference: Reference = { messageId: target, revision: 1, partId: 'body', range: { start: 1, end: 3 },
      context: { kind: 'BODY', version: { format: 2, messageId: target, revision: 1, corrections: [] } } };
    const next = sendZhihuLocalRelation(data, { relationType: 'AGREE', sourceMessageIds: [source], targetMessageIds: [target], targetReferences: [reference] });
    expect(reopen(next).zhihu.localOperations.operations[0].targetReferences).toEqual([reference]);
    const saved = JSON.parse(serializeZhihuViewingData(next));
    saved.localOperations.operations[0].targetReferences[0].range.end = 100;
    expect(() => prepareZhihuForViewing(saved)).toThrow('文字范围');
    const forged = JSON.parse(serializeZhihuViewingData(next));
    forged.localOperations.operations[0].sourceReferences[0].messageId = target;
    expect(() => prepareZhihuForViewing(forged)).toThrow('地址');
  });
});
