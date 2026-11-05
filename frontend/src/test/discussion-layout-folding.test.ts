import { describe, expect, it } from 'vitest';
import { DISCUSSION_REGION_HEADER, layoutDiscussion, type DiscussionLayoutItem, type DiscussionRegionInput } from '../utils/discussionLayout';
import { projectDiscussionLayoutEdges } from '../utils/discussionLayoutEdges';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

const item = (id: string, sequence: number): DiscussionLayoutItem => ({ id, sequence, width: 320, height: 100 });
const edge = (id: string, source: string, target: string, relationType: DemoEdge['relationType'] = 'reply'): DemoEdge => ({
  id, relationMessageId: id, relationType, relationLabel: relationType,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } },
});
const region = (targetId: string, type: DiscussionRegionInput['type'] = 'reply', collapsed = false): DiscussionRegionInput => ({
  key: JSON.stringify([targetId, type]), targetId, type, collapsed, directCount: 1,
});
const key = (targetId: string, type: DiscussionRegionInput['type'] = 'reply') => region(targetId, type).key;

describe('folding the actual discussion region subtree', () => {
  it('hides the entire owned subtree despite secondary replies and reference paths', () => {
    const nodes = ['root', 'other', 'source', 'child', 'leaf', 'sibling'].map(item);
    const edges = [edge('original', 'source', 'root'), edge('secondary', 'source', 'other'),
      edge('reference', 'source', 'other', 'reference'), edge('child-link', 'child', 'source', 'agree'),
      edge('leaf-link', 'leaf', 'child'), edge('sibling-link', 'sibling', 'root', 'disagree')];
    const regions = [region('root'), region('other'), region('source', 'agree'), region('child'), region('root', 'disagree')];
    const original = structuredClone({ nodes, edges, regions });
    const expanded = layoutDiscussion(nodes, edges, { regions });
    const folded = layoutDiscussion(nodes, edges, { regions: regions.map(value => ({ ...value, collapsed: value.key === key('root') })) });
    expect(folded.parent).toEqual(expanded.parent);
    expect(folded.ownerRegionById).toEqual(expanded.ownerRegionById);
    expect(folded.hiddenIds).toEqual(['source', 'child', 'leaf']);
    expect([...folded.positions.keys()]).toEqual(['root', 'sibling', 'other']);
    expect(folded.regions.map(value => value.key)).not.toContain(key('source', 'agree'));
    expect(folded.regions.find(value => value.key === key('root'))).toMatchObject({ height: DISCUSSION_REGION_HEADER, directCount: 1 });
    expect({ nodes, edges, regions }).toEqual(original);
  });

  it('does not hide or move a shared card when only its secondary region is folded', () => {
    const nodes = ['primary', 'secondary', 'source', 'child'].map(item);
    const edges = [edge('first', 'source', 'primary'), edge('second', 'source', 'secondary'), edge('child', 'child', 'source')];
    const expanded = layoutDiscussion(nodes, edges, { regions: [region('primary'), region('secondary'), region('source')] });
    const folded = layoutDiscussion(nodes, edges, { regions: [region('primary'), region('secondary', 'reply', true), region('source')] });
    expect(folded.hiddenIds).toEqual([]);
    expect(folded.positions).toEqual(expanded.positions);
    expect(folded.parent.get('source')).toBe('primary');
    expect(folded.ownerRegionById.get('source')).toBe(key('primary'));
  });

  it('retains nested fold ownership while showing only reachable region headers', () => {
    const nodes = ['root', 'child', 'leaf'].map(item);
    const edges = [edge('child', 'child', 'root'), edge('leaf', 'leaf', 'child')];
    const both = layoutDiscussion(nodes, edges, { regions: [region('root', 'reply', true), region('child', 'reply', true)] });
    expect(both.hiddenIds).toEqual(['child', 'leaf']);
    expect(both.regions.map(value => value.key)).toEqual([key('root')]);
    expect(both.parent.get('leaf')).toBe('child');
    expect(both.ownerRegionById.get('leaf')).toBe(key('child'));
    const outerOpened = layoutDiscussion(nodes, edges, { regions: [region('root'), region('child', 'reply', true)] });
    expect(outerOpened.hiddenIds).toEqual(['leaf']);
    expect(outerOpened.positions.has('child')).toBe(true);
    expect(outerOpened.regions.map(value => value.key)).toEqual([key('root'), key('child')]);
    expect(outerOpened.parent).toEqual(both.parent);
    expect(outerOpened.ownerRegionById).toEqual(both.ownerRegionById);
  });

  it('cuts cycles identically before and after folding and never promotes hidden descendants to roots', () => {
    const nodes = ['a', 'b', 'c'].map(item);
    const edges = [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('ca', 'c', 'a')];
    const regions = nodes.map(node => region(node.id));
    const expanded = layoutDiscussion(nodes, edges, { regions });
    const collapsed = regions.map(value => ({ ...value, collapsed: value.targetId === 'a' }));
    const folded = layoutDiscussion(nodes, edges, { regions: collapsed });
    expect(folded.parent).toEqual(expanded.parent);
    expect(folded.parent.has('a')).toBe(false);
    expect(folded.ownerRegionById.has('a')).toBe(false);
    expect(folded.hiddenIds).toEqual(['b', 'c']);
    expect([...folded.positions.keys()]).toEqual(['a']);
    expect(layoutDiscussion([...nodes].reverse(), [...edges].reverse(), { regions: collapsed })).toEqual(folded);
  });

  it('folds a real anonymous stance record card together with the replies attached to that record', () => {
    const nodes = ['root', 'vote', 'child'].map(item);
    const messages: DemoMessage[] = nodes.map(node => ({ id: node.id, sequence: node.sequence, createdAt: '', author: 'structure-fixture',
      kind: node.id === 'vote' ? 'relation' : 'normal', content: '', ...(node.id === 'vote' ? { relationType: 'agree' as const } : {}) }));
    const original = [edge('vote', 'anon:vote', 'root', 'agree'), edge('reply', 'child', 'vote')];
    const edges = projectDiscussionLayoutEdges(messages, original, new Set(['vote']));
    const result = layoutDiscussion(nodes, edges, { regions: [region('root', 'agree', true), region('vote')] });
    expect(result.parent.get('vote')).toBe('root');
    expect(result.ownerRegionById.get('vote')).toBe(key('root', 'agree'));
    expect(result.hiddenIds).toEqual(['vote', 'child']);
    expect([...result.positions.keys()]).toEqual(['root']);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].height).toBe(DISCUSSION_REGION_HEADER);
    expect(original[0].from.messageId).toBe('anon:vote');
  });

  it('keeps the latest stance owner when its region closes instead of falling back to an old reply or vote', () => {
    const nodes = ['old-target', 'new-target', 'source'].map(item);
    const edges = [edge('reply', 'source', 'old-target'), edge('old-vote', 'source', 'old-target', 'agree'),
      edge('new-vote', 'source', 'new-target', 'disagree')];
    const relationCatalog = new Map([['old-vote', { createdAt: '', sequence: 1 }], ['new-vote', { createdAt: '', sequence: 2 }]]);
    const result = layoutDiscussion(nodes, edges, { relationCatalog,
      regions: [region('old-target'), region('old-target', 'agree'), region('new-target', 'disagree', true)] });
    expect(result.parent.get('source')).toBe('new-target');
    expect(result.ownerRegionById.get('source')).toBe(key('new-target', 'disagree'));
    expect(result.hiddenIds).toEqual(['source']);
    expect(result.positions.has('source')).toBe(false);
  });
});
