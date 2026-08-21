import { describe, expect, it } from 'vitest';
import { computeCorrectionVersions, type DemoEdge, type DemoMessage } from '../utils/modelBridge';
import { formatCorrectionRange } from '../pages/topicDetailHelpers';
import { computeReplacementDiff } from '../components/CorrectionComparisonPopup';

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

  it('uses the previous valid version as the next correction base', () => {
    const versions = computeCorrectionVersions(messages, edges).get('original');

    expect(versions?.versions.map(version => version.baseContent)).toEqual(['原文', '第一次']);
    expect(versions?.current?.content).toBe('第二次');
  });

  it('does not advance the base when an earlier correction is invalid', () => {
    const versions = computeCorrectionVersions(messages, edges, new Set(['correction-1'])).get('original');

    expect(versions?.versions.map(version => version.baseContent)).toEqual(['原文', '原文']);
    expect(versions?.current?.content).toBe('第二次');
  });

  it('formats an unambiguous character range for the linear correction text', () => {
    expect(formatCorrectionRange(2, 1, '3')).toBe('start=2 len=1 "3"');
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
});
