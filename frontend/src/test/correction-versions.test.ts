import { describe, expect, it } from 'vitest';
import { computeCorrectionVersions, correctionSelectionIsStale, hasActiveCorrectionForSelection, type DemoEdge, type DemoMessage } from '../utils/modelBridge';
import { formatCorrectionRange, generateCorrectionContent } from '../pages/topicDetailHelpers';
import { computeReplacementDiff, getCorrectionBaseContent, rebuildCorrectionContent } from '../components/CorrectionComparisonPopup';

function message(id: string, createdAt: string, content: string, kind: DemoMessage['kind']): DemoMessage {
  return { id, author: 'tester', createdAt, content, kind };
}

function correctionEdge(id: string, correctionId: string): DemoEdge {
  return {
    id,
    relationMessageId: correctionId,
    relationType: 'correct',
    from: { messageId: `anon:${correctionId}`, selection: { kind: 'whole' } },
    to: { messageId: 'original', selection: { kind: 'whole' } },
    relationLabel: 'correct',
  };
}

describe('correction versions', () => {
  const messages = [
    message('original', '2026-01-01T00:00:00.000Z', '原文', 'normal'),
    { ...message('correction-1', '2026-01-01T00:01:00.000Z', '第一次', 'relation'), relationPayload: { correctionContent: '第一次' } },
    { ...message('correction-2', '2026-01-01T00:02:00.000Z', '第二次', 'relation'), relationPayload: { correctionContent: '第二次' } },
  ];
  const edges = [correctionEdge('edge-1', 'correction-1'), correctionEdge('edge-2', 'correction-2')];

  it('keeps every correction based on the original content', () => {
    const versions = computeCorrectionVersions(messages, edges).get('original');

    expect(versions?.versions.map(version => version.baseContent)).toEqual(['原文', '原文']);
    expect(versions?.versions.every(version => !version.conflicted)).toBe(true);
    expect(versions?.current?.content).toBe('第二次');
  });

  it('uses the original content as the base for every correction comparison', () => {
    expect(getCorrectionBaseContent(messages[0], 'correction-2', messages, edges)).toBe('原文');
  });

  it('rebuilds the second right side from the first corrected content', () => {
    const original = '仲裁有真假仲裁（消息是不是真的、非虚构的），真假仲裁投票对应赞同、反对；价值仲裁投票对应推进、冷藏；';
    const first = '仲裁有真假仲裁（消息是不是真的、非虚构的），真假仲裁投票对应赞同、反对；价值仲裁投票对应推荐、冷藏；';
    const rawSecond = '仲裁有真假仲裁（消息是不是真的、对的、非虚构的），真假仲裁投票对应赞同、反对；价值仲裁投票对应推进、冷藏；';

    expect(rebuildCorrectionContent(original, first, rawSecond, {
      kind: 'text', start: 13, len: 2, text: '真的',
    })).toBe('仲裁有真假仲裁（消息是不是真的、对的、非虚构的），真假仲裁投票对应赞同、反对；价值仲裁投票对应推荐、冷藏；');
  });

  it('keeps a changed trailing character outside the replacement range', () => {
    expect(rebuildCorrectionContent('111', '111', '122', {
      kind: 'text', start: 0, len: 2, text: '11',
    })).toBe('121');
  });

  it('generates the second correction from the first correction content', () => {
    const target = message('target', '2026-01-01T00:00:00.000Z', '原文真的', 'normal');
    const first = { ...message('first', '2026-01-01T00:01:00.000Z', '第一次', 'relation'), relationPayload: { correctionContent: '原文真的' } };
    const result = generateCorrectionContent([
      { messageId: target.id, selection: { kind: 'text', start: 2, len: 2, text: '真的' } },
    ], '真的、也对', new Map([[target.id, target]]), first.relationPayload.correctionContent);

    expect(result).toBe('原文真的、也对');
  });

  it('does not advance the base when an earlier correction is invalid', () => {
    const versions = computeCorrectionVersions(messages, edges, new Set(['correction-1'])).get('original');

    expect(versions?.versions.map(version => version.baseContent)).toEqual(['原文', '原文']);
    expect(versions?.current?.content).toBe('第二次');
  });

  it('does not auto-invalidate a later correction on the same original field', () => {
    const target = message('conflict-target', '2026-01-01T00:00:00.000Z', '111', 'normal');
    const first = { ...message('conflict-1', '2026-01-01T00:01:00.000Z', '121', 'relation'), relationPayload: { correctionContent: '121' } };
    const second = { ...message('conflict-2', '2026-01-01T00:02:00.000Z', '131', 'relation'), relationPayload: { correctionContent: '131' } };
    const textEdge = (id: string, correctionId: string): DemoEdge => ({
      id,
      relationMessageId: correctionId,
      relationType: 'correct',
      from: { messageId: `anon:${correctionId}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start: 0, len: 2, text: '11' } },
      relationLabel: 'correct',
    });

    const state = computeCorrectionVersions(
      [target, first, second],
      [textEdge('e1', first.id), textEdge('e2', second.id)],
    ).get(target.id);

    expect(state?.versions[1].conflicted).toBe(false);
    expect(state?.current?.content).toBe('131');
  });

  it('prevents agreeing with another correction on an already active field', () => {
    const target = message('exclusive-target', '2026-01-01T00:00:00.000Z', 'abc', 'normal');
    const first = { ...message('exclusive-1', '2026-01-01T00:01:00.000Z', 'Abc', 'relation'), relationPayload: { correctionContent: 'Abc' } };
    const second = { ...message('exclusive-2', '2026-01-01T00:02:00.000Z', 'Xbc', 'relation'), relationPayload: { correctionContent: 'Xbc' } };
    const edge = (id: string, correctionId: string): DemoEdge => ({
      id, relationMessageId: correctionId, relationType: 'correct',
      from: { messageId: `anon:${correctionId}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start: 0, len: 1, text: 'a' } },
      relationLabel: 'correct',
    });
    const edges = [edge('e1', first.id), edge('e2', second.id)];
    const corrections = computeCorrectionVersions([target, first, second], edges);
    const selection = { kind: 'text', start: 0, len: 1, text: 'a' } as const;

    expect(hasActiveCorrectionForSelection(target.id, selection, corrections, first.id)).toBe(true);
    expect(hasActiveCorrectionForSelection(target.id, selection, corrections, second.id)).toBe(true);
    const secondRejected = computeCorrectionVersions([target, first, second], edges, new Set([second.id]));
    expect(hasActiveCorrectionForSelection(target.id, selection, secondRejected, first.id)).toBe(false);
  });

  it('does not conflict when overlapping corrections produce the same original field value', () => {
    const target = message('same-target', '2026-01-01T00:00:00.000Z', '111', 'normal');
    const first = { ...message('same-1', '2026-01-01T00:01:00.000Z', '121', 'relation'), relationPayload: { correctionContent: '121' } };
    const second = { ...message('same-2', '2026-01-01T00:02:00.000Z', '121', 'relation'), relationPayload: { correctionContent: '121' } };
    const edge = (id: string, correctionId: string): DemoEdge => ({
      id, relationMessageId: correctionId, relationType: 'correct',
      from: { messageId: `anon:${correctionId}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start: 0, len: 2, text: '11' } },
      relationLabel: 'correct',
    });

    const state = computeCorrectionVersions([target, first, second], [edge('e1', first.id), edge('e2', second.id)]).get(target.id);

    expect(state?.versions.every(version => !version.conflicted)).toBe(true);
  });

  it('does not conflict when corrections change different original fields', () => {
    const target = message('fields-target', '2026-01-01T00:00:00.000Z', 'abcd', 'normal');
    const first = { ...message('fields-1', '2026-01-01T00:01:00.000Z', 'Abcd', 'relation'), relationPayload: { correctionContent: 'Abcd' } };
    const second = { ...message('fields-2', '2026-01-01T00:02:00.000Z', 'abCd', 'relation'), relationPayload: { correctionContent: 'abCd' } };
    const edge = (id: string, correctionId: string, start: number, text: string): DemoEdge => ({
      id, relationMessageId: correctionId, relationType: 'correct',
      from: { messageId: `anon:${correctionId}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start, len: 1, text } },
      relationLabel: 'correct',
    });

    const state = computeCorrectionVersions(
      [target, first, second],
      [edge('e1', first.id, 0, 'a'), edge('e2', second.id, 2, 'c')],
    ).get(target.id);
    expect(state?.versions.every(version => !version.conflicted)).toBe(true);
  });

  it('does not inherit a correction from another field version', () => {
    const target = message('chain-target', '2026-01-01T00:00:00.000Z', 'ABC', 'normal');
    const first = { ...message('chain-1', '2026-01-01T00:01:00.000Z', 'ADEC', 'relation'), relationPayload: { correctionContent: 'ADEC' } };
    const second = { ...message('chain-2', '2026-01-01T00:02:00.000Z', 'ADNC', 'relation'), relationPayload: { correctionContent: 'ADNC' } };
    const firstEdge: DemoEdge = {
      id: 'chain-edge-1', relationMessageId: first.id, relationType: 'correct',
      from: { messageId: `anon:${first.id}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start: 1, len: 1, text: 'B' } }, relationLabel: 'correct',
    };
    const secondEdge: DemoEdge = {
      id: 'chain-edge-2', relationMessageId: second.id, relationType: 'correct',
      from: { messageId: `anon:${second.id}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start: 1, len: 2, text: 'DE' } }, relationLabel: 'correct',
    };

    const active = computeCorrectionVersions([target, first, second], [firstEdge, secondEdge]).get(target.id);
    expect(active?.versions.every(version => !version.conflicted)).toBe(true);
    expect(active?.current?.content).toBe('ADEC');

    const rejected = computeCorrectionVersions([target, first, second], [firstEdge, secondEdge], new Set([first.id])).get(target.id);
    expect(rejected?.versions[1].conflicted).toBe(false);
    expect(rejected?.current).toBeUndefined();
  });

  it('keeps non-overlapping corrections valid when each uses the current left fragment', () => {
    const target = message('split-target', '2026-01-01T00:00:00.000Z', 'abcde', 'normal');
    const first = { ...message('split-1', '2026-01-01T00:01:00.000Z', 'Abcde', 'relation'), relationPayload: { correctionContent: 'Abcde' } };
    const second = { ...message('split-2', '2026-01-01T00:02:00.000Z', 'AbCde', 'relation'), relationPayload: { correctionContent: 'AbCde' } };
    const edge = (id: string, correctionId: string, start: number, text: string): DemoEdge => ({
      id,
      relationMessageId: correctionId,
      relationType: 'correct',
      from: { messageId: `anon:${correctionId}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start, len: 1, text } },
      relationLabel: 'correct',
    });

    const state = computeCorrectionVersions(
      [target, first, second],
      [edge('e1', first.id, 0, 'a'), edge('e2', second.id, 2, 'c')],
    ).get(target.id);
    expect(state?.versions.every(version => !version.conflicted)).toBe(true);
    expect(state?.versions.filter(version => version.valid)).toHaveLength(2);
  });

  it('rebuilds the current content after suppressing any correction', () => {
    const target = message('any-target', '2026-01-01T00:00:00.000Z', 'abcde', 'normal');
    const first = { ...message('any-1', '2026-01-01T00:01:00.000Z', 'Abcde', 'relation'), relationPayload: { correctionContent: 'Abcde' } };
    const second = { ...message('any-2', '2026-01-01T00:02:00.000Z', 'abCde', 'relation'), relationPayload: { correctionContent: 'abCde' } };
    const edge = (id: string, correctionId: string, start: number, text: string): DemoEdge => ({
      id, relationMessageId: correctionId, relationType: 'correct',
      from: { messageId: `anon:${correctionId}`, selection: { kind: 'whole' } },
      to: { messageId: target.id, selection: { kind: 'text', start, len: 1, text } },
      relationLabel: 'correct',
    });
    const edges = [edge('e1', first.id, 0, 'a'), edge('e2', second.id, 2, 'c')];

    expect(computeCorrectionVersions([target, first, second], edges).get(target.id)?.current?.content).toBe('AbCde');
    expect(computeCorrectionVersions([target, first, second], edges, new Set([first.id])).get(target.id)?.current?.content).toBe('abCde');
    expect(computeCorrectionVersions([target, first, second], edges, new Set([second.id])).get(target.id)?.current?.content).toBe('Abcde');
  });

  it('detects a stale selection so the user can create a new correction', () => {
    expect(correctionSelectionIsStale('Abcde', { kind: 'text', start: 0, len: 1, text: 'a' })).toBe(true);
    expect(correctionSelectionIsStale('Abcde', { kind: 'text', start: 2, len: 1, text: 'c' })).toBe(false);
  });


  it('formats an unambiguous character range for the linear correction text', () => {
    expect(formatCorrectionRange(2, 1, '3')).toBe('start=2 len=1 "3"');
    expect(formatCorrectionRange(0, 3, '全文')).toBe('start=0 len=3 "全文"');
  });

  it('keeps both complete texts while highlighting only the replacement range', () => {
    const result = computeReplacementDiff('111', '112', {
      kind: 'text', start: 1, len: 2, text: '11',
    });

    expect(result.origParts).toEqual([
      { type: 'keep', text: '1' },
      { type: 'del', text: '11' },
    ]);
    expect(result.nextParts).toEqual([
      { type: 'keep', text: '1' },
      { type: 'ins', text: '12' },
    ]);
  });

  it('reanchors a later correction selection after the base text shifts', () => {
    const result = computeReplacementDiff('abcd真的', 'abcd真的、对的', {
      kind: 'text', start: 3, len: 2, text: '真的',
    });

    expect(result.origParts).toEqual([
      { type: 'keep', text: 'abcd' },
      { type: 'del', text: '真的' },
    ]);
    expect(result.nextParts).toEqual([
      { type: 'keep', text: 'abcd' },
      { type: 'ins', text: '真的、对的' },
    ]);
  });

  it('uses actual content changes when a selection is unavailable', () => {
    const result = computeReplacementDiff('abc', 'abXYc', { kind: 'whole' });

    expect(result.origParts).toEqual([
      { type: 'keep', text: 'abc' },
    ]);
    expect(result.nextParts).toEqual([
      { type: 'keep', text: 'ab' },
      { type: 'ins', text: 'XY' },
      { type: 'keep', text: 'c' },
    ]);
  });

});
