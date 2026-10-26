import { describe, expect, it } from 'vitest';
import { computeSceneLayout } from '../utils/frameLayout';
import { projectGraphScene } from '../utils/graphProjection';
import { siblingColumns } from '../utils/graphSiblingColumns';
import { cardAuthor, effectiveCardWidths } from '../utils/cardWidth';
import { computeCorrectionVersions, type DemoMessage, type DemoEdge } from '../utils/modelBridge';
import { COL_GAP } from '../utils/layout';

const message = (id: string): DemoMessage => ({ id, author: 'tester', content: id, kind: 'normal', createdAt: '2026-10-23T00:00:00Z' });
const record = (id: string, type: DemoEdge['relationType']): DemoMessage => ({ ...message(id), kind: 'relation', relationType: type });
const edge = (id: string, type: DemoEdge['relationType'], from: string, to: string, owner = id): DemoEdge => ({
  id, relationMessageId: owner, relationType: type, relationLabel: type,
  from: { messageId: from, selection: { kind: 'whole' } }, to: { messageId: to, selection: { kind: 'whole' } },
});
function scene(messages: DemoMessage[], edges: DemoEdge[], widths: Record<string, number> = {}) {
  const projection = projectGraphScene({ messages, edges, isTraceWindow: true,
    traceExpandedFrameIds: new Set(messages.filter(message => ['classify', 'summary'].includes(message.relationType ?? '')).map(message => message.id)) });
  return computeSceneLayout({ normals: projection.normals, colOf: projection.pipelineCol, maxCol: projection.pipelineMaxCol,
    allMessages: messages, edges: projection.layoutEdges, frameBlocks: projection.frameBlocks, measuredWidths: widths, measuredHeights: {} });
}

describe('variable card widths and organization columns', () => {
  it('limits displayed author length including the ellipsis without splitting Unicode', () => {
    expect(cardAuthor('用户名非常长', '1234')).toBe('用户名…');
    expect(cardAuthor('😀😀😀', '12')).toBe('😀…');
    expect(cardAuthor('ab', '1234')).toBe('ab');
  });
  it('selects width corrections independently of body corrections and respects a personal rejection', () => {
    const target = message('target'), width = { ...record('width', 'correct'), relationPayload: { correctionKind: 'WIDTH' as const, correctionWidth: 640 } };
    const text = { ...record('text', 'correct'), content: 'changed', relationPayload: { correctionKind: 'TEXT' as const, correctionBeforeContent: 'target', correctionAfterContent: 'changed' } };
    const edges = [edge('width', 'correct', 'anon:width', target.id), edge('text', 'correct', 'anon:text', target.id)];
    expect(effectiveCardWidths([target, width, text], edges)).toEqual({ target: 640 });
    expect(computeCorrectionVersions([target, width, text], edges).get(target.id)?.versions.map(item => item.correctionId)).toEqual(['text']);
    const rejection = { ...record('reject', 'disagree'), author: 'me' };
    expect(effectiveCardWidths([target, width, text, rejection], [...edges, edge('reject', 'disagree', 'anon:reject', width.id)], 'me')).toEqual({});
    expect(effectiveCardWidths([target, { ...width, state: { messageId: 'width', revision: 1, supportCount: 0, oppositionCount: 2, suppressed: true, recommendationTotal: 0 } }], edges)).toEqual({});
  });
  for (const type of ['merge', 'arrange', 'classify', 'summary'] as const) {
    for (const targetId of ['frame', 'a']) {
      it.each(['reference', 'agree', 'disagree'] as const)(`places external %s beside the entire ${type} when targeting ${targetId}`, relationType => {
        const frame = { ...record('frame', type), relationPayload: type === 'arrange' ? { targetLayout: 'single-row' as const } : undefined };
        const messages = [message('a'), message('b'), frame, message('external'), record('relation', relationType)];
        const edges = [edge('frame-a', type, 'anon:frame', 'a', 'frame'), edge('frame-b', type, 'anon:frame', 'b', 'frame'), edge('relation', relationType, 'external', targetId)];
        const result = scene(messages, edges, { a: 680, b: 470, external: 520 });
        const external = result.layout.external, bounds = result.frameRects.frame;
        if (relationType === 'agree') expect(external.x + external.width + COL_GAP).toBeLessThanOrEqual(bounds.x);
        else expect(external.x).toBeGreaterThanOrEqual(bounds.x + bounds.width + COL_GAP);
        expect(result.layout.a.width).toBe(680);
        if (type !== 'arrange') expect(result.layout.a.x).toBe(result.layout.b.x);
        expect(result.layout.a.x + result.layout.a.width).toBeLessThan(bounds.x + bounds.width);
        expect(edges.at(-1)?.to.messageId).toBe(targetId);
      });
    }
  }
  it('resolves relations between nested siblings in their common ancestor', () => {
    const messages = [record('outer', 'merge'), record('left', 'arrange'), record('right', 'merge'), message('a'), message('b'), record('support', 'agree')];
    const edges = [edge('outer-left', 'merge', 'anon:outer', 'left', 'outer'), edge('outer-right', 'merge', 'anon:outer', 'right', 'outer'),
      edge('left-a', 'arrange', 'anon:left', 'a', 'left'), edge('right-b', 'merge', 'anon:right', 'b', 'right'), edge('support', 'agree', 'a', 'b')];
    const result = scene(messages, edges, { a: 750, b: 400 });
    expect(result.frameRects.left.x + result.frameRects.left.width + COL_GAP).toBeLessThanOrEqual(result.frameRects.right.x);
    expect(result.frameRects.right.x + result.frameRects.right.width).toBeLessThan(result.frameRects.outer.x + result.frameRects.outer.width);
  });
  it('widens a lane without changing the logical columns', () => {
    const items = [{ id: 'a', column: 0, width: 760 }, { id: 'b', column: 1, width: 320 }];
    const wide = siblingColumns(items, [['a', 'b']]);
    const narrow = siblingColumns(items.map(item => ({ ...item, width: 320 })), [['a', 'b']]);
    expect(wide.columns).toEqual(narrow.columns);
    expect(wide.xById.get('b')! - wide.xById.get('a')!).toBe(760 + COL_GAP);
  });
  it.each([false, true])('keeps citations of an arrow to the right of both endpoints (inside a frame: %s)', nested => {
    const messages = [message('claim'), message('reason'), message('citation'), record('arrow', 'reference'), record('cite', 'reference')];
    const edges = [edge('arrow', 'reference', 'reason', 'claim'), edge('cite', 'reference', 'citation', 'arrow')];
    if (nested) {
      messages.push(record('frame', 'merge'));
      for (const id of ['claim', 'reason', 'citation']) edges.push(edge(`frame-${id}`, 'merge', 'anon:frame', id, 'frame'));
    }
    const result = scene(messages, edges, { reason: 700 });
    expect(result.layout.citation.x).toBeGreaterThanOrEqual(result.layout.reason.x + result.layout.reason.width + COL_GAP);
    expect(result.layout.reason.x).toBeGreaterThanOrEqual(result.layout.claim.x + result.layout.claim.width + COL_GAP);
  });
  it('keeps cyclic constraints finite and leaves outgoing dependencies ordered', () => {
    const result = siblingColumns(['a', 'b', 'c'].map(id => ({ id, column: 0, width: 320 })), [['a', 'b'], ['b', 'a'], ['b', 'c']]);
    expect(result.columns.get('a')).toBe(result.columns.get('b'));
    expect(result.columns.get('c')).toBeGreaterThan(result.columns.get('b')!);
    expect(result.xById.get('c')).toBeLessThan(1000);
  });
});
