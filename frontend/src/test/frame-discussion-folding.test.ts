import { describe, expect, it } from 'vitest';
import { computeSceneLayout, type FrameBlock, type SceneLayoutInput } from '../utils/frameLayout';
import { DISCUSSION_REGION_HEADER, type DiscussionRegionInput } from '../utils/discussionLayout';
import { COL_GAP, ROW_GAP } from '../utils/layout';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

const message = (id: string, sequence = 0): DemoMessage => ({ id, sequence, createdAt: '', author: 'structure-fixture', kind: 'normal', content: `fixture:${id}` });
const organization = (id: string): DemoMessage => ({ ...message(id), kind: 'relation', relationType: 'arrange' });
const edge = (id: string, source: string, target: string, relationType: DemoEdge['relationType'] = 'reply'): DemoEdge => ({
  id, relationMessageId: id, relationType, relationLabel: relationType,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } },
});
const frame = (id: string, members: string[], children: string[] = []): FrameBlock => ({ relMsgId: id,
  cardIds: new Set([...members, ...children]), directCardIds: new Set(members), childRelMsgIds: children, isMerge: false, hasGroupHeader: true });
const region = (targetId: string, type: DiscussionRegionInput['type'] = 'reply', collapsed = false): DiscussionRegionInput => ({
  key: JSON.stringify([targetId, type]), targetId, type, collapsed, directCount: 1,
});
const key = (targetId: string, type: DiscussionRegionInput['type'] = 'reply') => region(targetId, type).key;
const run = (input: Pick<SceneLayoutInput, 'normals' | 'allMessages' | 'frameBlocks' | 'edges' | 'discussionRegions'> & Partial<SceneLayoutInput>) =>
  computeSceneLayout({ colOf: {}, maxCol: 0, measuredHeights: {}, measuredWidths: {}, ...input, discussionLayout: true });

describe('discussion folds across native frame boundaries', () => {
  it('omits a folded internal subtree and shrinks its native frame while retaining navigation ownership', () => {
    const normals = ['target', 'source', 'child', 'leaf', 'sibling'].map(message);
    const edges = [edge('source', 'source', 'target', 'agree'), edge('child', 'child', 'source'),
      edge('leaf', 'leaf', 'child', 'disagree'), edge('sibling', 'sibling', 'target', 'disagree')];
    const regions = [region('target', 'agree'), region('source'), region('child', 'disagree'), region('target', 'disagree')];
    const input = { normals, allMessages: [...normals, organization('group')], frameBlocks: [frame('group', normals.map(node => node.id))], edges,
      measuredHeights: { target: 120, source: 480, child: 360, leaf: 240, sibling: 100 } };
    const original = structuredClone(input);
    const expanded = run({ ...input, discussionRegions: regions });
    const folded = run({ ...input, discussionRegions: regions.map(value => ({ ...value, collapsed: value.key === key('target', 'agree') })) });
    expect(new Set(folded.hiddenAtomIds)).toEqual(new Set(['source', 'child', 'leaf']));
    expect(Object.keys(folded.layout)).toEqual(['target', 'sibling']);
    expect(Object.keys(folded.frameRects)).toEqual(['group']);
    expect(folded.placementOrder).toEqual(['group', 'target', 'sibling']);
    expect(folded.frameContentRects.group.width).toBeLessThan(expanded.frameContentRects.group.width);
    expect(folded.frameContentRects.group.height).toBeLessThan(expanded.frameContentRects.group.height);
    expect(folded.frameRects.group.height).toBeLessThan(expanded.frameRects.group.height);
    expect(folded.discussionRegions?.map(value => value.key)).toEqual([key('target', 'agree'), key('target', 'disagree')]);
    expect(folded.discussionRegions?.find(value => value.key === key('target', 'agree'))).toMatchObject({ height: DISCUSSION_REGION_HEADER, directCount: 1 });
    expect(folded.discussionParents).toEqual(expanded.discussionParents);
    expect(folded.discussionOwnerRegions).toEqual(expanded.discussionOwnerRegions);
    expect(folded.discussionParents).toMatchObject({ target: 'group', source: 'target', child: 'source', leaf: 'child' });
    expect(input).toEqual(original);
  });

  it('hides an externally owned frame and every nested atom, including descendants already folded internally', () => {
    const normals = ['outside', 'pivot', 'inner-root', 'hidden-child', 'hidden-leaf', 'deep'].map(message);
    const frames = [frame('outer', ['pivot'], ['inner']), frame('inner', ['inner-root', 'hidden-child', 'hidden-leaf'], ['nested']), frame('nested', ['deep'])];
    const edges = [edge('outer-link', 'pivot', 'outside'), edge('inner-link', 'hidden-child', 'inner-root', 'agree'),
      edge('hidden-descendant', 'hidden-leaf', 'hidden-child'), edge('nested-link', 'deep', 'inner-root')];
    const input = { normals, allMessages: [...normals, ...frames.map(value => organization(value.relMsgId))], frameBlocks: frames, edges };
    const insideRegions = [region('inner-root', 'agree', true), region('hidden-child'), region('inner-root')];
    const outerOpen = run({ ...input, discussionRegions: [region('outside'), ...insideRegions] });
    const folded = run({ ...input, discussionRegions: [region('outside', 'reply', true), ...insideRegions] });
    expect(new Set(outerOpen.hiddenAtomIds)).toEqual(new Set(['hidden-child', 'hidden-leaf']));
    expect(new Set(folded.hiddenAtomIds)).toEqual(new Set(['outer', 'inner', 'nested', 'pivot', 'inner-root', 'hidden-child', 'hidden-leaf', 'deep']));
    expect(Object.keys(folded.layout)).toEqual(['outside']);
    expect(folded.frameRects).toEqual({});
    expect(folded.frameContentRects).toEqual({});
    expect(folded.placementOrder).toEqual(['outside']);
    expect(folded.discussionRegions).toHaveLength(1);
    expect(folded.discussionRegions?.[0]).toMatchObject({ key: key('outside'), height: DISCUSSION_REGION_HEADER, directCount: 1 });
    expect(folded.discussionParents).toEqual(outerOpen.discussionParents);
    expect(folded.discussionOwnerRegions).toEqual(outerOpen.discussionOwnerRegions);
    expect(folded.discussionParents).toMatchObject({ 'hidden-leaf': 'hidden-child', 'hidden-child': 'inner-root',
      'inner-root': 'inner', inner: 'outer', outer: 'outside', nested: 'inner-root', deep: 'nested', pivot: 'outer' });
    expect(folded.discussionOwnerRegions).toMatchObject({ outer: key('outside'), 'hidden-child': key('inner-root', 'agree') });
    expect(folded.canvasHeight).toBeLessThan(outerOpen.canvasHeight);
  });

  it.each(['row', 'flow'] as const)('protects explicit %s members from internal automatic folds but folds their frame as an external atom', display => {
    const normals = [message('outside'), message('first', 20), message('second', 1)];
    const manual: DemoMessage = { ...organization('manual'), parts: [{ id: 'display', type: 'display', layout: display, relationPartId: 'members' }] };
    const input = { normals, allMessages: [...normals, manual],
      frameBlocks: [{ ...frame('manual', ['first', 'second']), targetLayout: display === 'row' ? 'single-row' as const : 'single-column' as const }],
      edges: [edge('inside', 'second', 'first', 'agree'), edge('outside', 'first', 'outside')],
      measuredHeights: { first: 170, second: 240 } };
    const internal = region('first', 'agree', true);
    const shown = run({ ...input, discussionRegions: [region('outside'), internal] });
    expect(shown.hiddenAtomIds).toEqual([]);
    expect(shown.discussionRegions?.map(value => value.key)).toEqual([key('outside')]);
    expect(shown.placementOrder).toEqual(['outside', 'manual', 'first', 'second']);
    if (display === 'row') {
      expect(shown.layout.second.x).toBe(shown.layout.first.x + shown.layout.first.width + COL_GAP);
      expect(shown.layout.second.y).toBe(shown.layout.first.y);
    } else {
      expect(shown.layout.second.x).toBe(shown.layout.first.x);
      expect(shown.layout.second.y).toBe(shown.layout.first.y + shown.layout.first.height + ROW_GAP);
    }
    expect(shown.discussionParents).toMatchObject({ first: 'manual', second: 'manual', manual: 'outside' });
    expect(shown.discussionOwnerRegions?.first).toBeUndefined();
    expect(shown.discussionOwnerRegions?.second).toBeUndefined();
    const folded = run({ ...input, discussionRegions: [region('outside', 'reply', true), internal] });
    expect(new Set(folded.hiddenAtomIds)).toEqual(new Set(['manual', 'first', 'second']));
    expect(Object.keys(folded.layout)).toEqual(['outside']);
    expect(folded.frameRects).toEqual({});
    expect(folded.discussionParents).toEqual(shown.discussionParents);
    expect(folded.discussionOwnerRegions).toEqual(shown.discussionOwnerRegions);
    expect(folded.discussionRegions?.map(value => value.key)).toEqual([key('outside')]);
    expect(folded.discussionRegions?.[0].height).toBe(DISCUSSION_REGION_HEADER);
  });
});
