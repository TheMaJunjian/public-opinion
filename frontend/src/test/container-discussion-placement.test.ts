import { describe, expect, it } from 'vitest';
import { computeSceneLayout, type FrameBlock } from '../utils/frameLayout';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

const body = (id: string): DemoMessage => ({ id, kind: 'normal', author: 'fixture', content: id, createdAt: '',
  parts: [{ id: 'body', type: 'text', text: id }] });
const link = (id: string, source: string, type: 'agree' | 'disagree', sequence: number): DemoEdge => ({
  id, relationMessageId: id, relationType: type, relationLabel: type,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: 'target', selection: { kind: 'whole' } },
  discussionOrder: { createdAt: '', sequence },
});
function fixture(type: 'arrange' | 'merge' | 'summary', edges: DemoEdge[]) {
  const container: DemoMessage = { ...body('container'), kind: 'relation', relationType: type,
    parts: [{ id: 'display', type: 'display', layout: 'row', relationPartId: 'members' }] };
  const frame: FrameBlock = { relMsgId: container.id, cardIds: new Set(['one', 'two']), directCardIds: new Set(['one', 'two']),
    childRelMsgIds: [], isMerge: type === 'merge', hasGroupHeader: type !== 'merge', hasCardHeader: type === 'summary', targetLayout: 'single-row' };
  const normals = ['target', 'one', 'two'].map(body);
  const input = { normals, allMessages: [...normals, container], frameBlocks: [frame], edges,
    discussionLayout: true, colOf: {}, maxCol: 0, measuredHeights: {}, measuredWidths: {},
    discussionRegions: (['agree', 'disagree'] as const).map(type => ({ key: type, type, targetId: 'target', collapsed: false, directCount: 1 })) };
  return { input, result: computeSceneLayout(input) };
}

describe('whole containers in discussion summaries', () => {
  it.each(['arrange', 'merge', 'summary'] as const)('keeps a mixed %s beside its target without assigning all members to one stance', type => {
    const edges = [link('support', 'one', 'agree', 1), link('opposition', 'two', 'disagree', 2)];
    const { input, result } = fixture(type, edges);
    expect(result.discussionParents).toMatchObject({ container: 'target', one: 'container', two: 'container' });
    expect(result.discussionOwnerRegions?.container).toBeUndefined();
    expect(result.discussionRegions).toEqual([]);
    expect(result.hiddenAtomIds).toEqual([]);
    expect(result.frameRects.container.x).toBeGreaterThan(result.layout.target.x);
    expect(result.layout.one.x).toBeLessThan(result.layout.two.x);
    // Closing either stance must not make both sides of a mixed container disappear.
    const folded = computeSceneLayout({ ...input, discussionRegions: input.discussionRegions.map(region => ({ ...region, collapsed: true })) });
    expect(folded.hiddenAtomIds).toEqual([]);
    expect(folded.frameRects).toEqual(result.frameRects);
    // A member's newer relation, input order, and names cannot choose a side for the entire frame.
    const reversed = fixture(type, [link('opposition', 'two', 'disagree', 1), link('support', 'one', 'agree', 2)]).result;
    expect(reversed.discussionOwnerRegions?.container).toBeUndefined();
    expect(reversed.frameRects).toEqual(result.frameRects);
    expect(input.edges).toEqual(edges);
  });

  it.each(['agree', 'disagree'] as const)('puts a uniform container in the %s region and folds it as a whole', type => {
    const { input, result } = fixture('arrange', [link('one-link', 'one', type, 1), link('two-link', 'two', type, 2)]);
    expect(result.discussionOwnerRegions?.container).toBe(type);
    const folded = computeSceneLayout({ ...input, discussionRegions: input.discussionRegions.map(region => ({ ...region, collapsed: region.type === type })) });
    expect(new Set(folded.hiddenAtomIds)).toEqual(new Set(['container', 'one', 'two']));
  });

  it('uses the latest relation per member before checking agreement across members', () => {
    const { result } = fixture('arrange', [link('old', 'one', 'agree', 1), link('current', 'one', 'disagree', 3), link('other', 'two', 'disagree', 2)]);
    expect(result.discussionOwnerRegions?.container).toBe('disagree');
  });

  it('gives an explicit relation from the whole container precedence over a newer member relation', () => {
    const { result } = fixture('arrange', [link('explicit', 'container', 'agree', 1), link('support', 'one', 'agree', 2), link('opposition', 'two', 'disagree', 3)]);
    expect(result.discussionOwnerRegions?.container).toBe('agree');
  });
});
