import { describe, expect, it } from 'vitest';
import { layoutDiscussion, DISCUSSION_REGION_HEADER, type DiscussionLayoutItem, type DiscussionRegionInput } from '../utils/discussionLayout';
import { COL_GAP, ROW_GAP } from '../utils/layout';
import type { DemoEdge } from '../utils/modelBridge';

type Kind = DiscussionRegionInput['type'];
type Box = { x: number; y: number; width: number; height: number };
const kinds: Kind[] = ['agree', 'reply', 'disagree'];
const node = (id: string, sequence: number, width = 320, height = 100): DiscussionLayoutItem => ({ id, sequence, width, height });
const edge = (id: string, source: string, target: string, relationType: Kind): DemoEdge => ({ id, relationMessageId: id, relationType, relationLabel: relationType,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } } });
const region = (targetId: string, type: Kind, collapsed = false): DiscussionRegionInput => ({ key: `${targetId}:${type}`, targetId, type, collapsed, directCount: 1 });
const separate = (a: Box, b: Box) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
const contains = (outer: Box, inner: Box) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

function assertNoCardOverlap(nodes: DiscussionLayoutItem[], result: ReturnType<typeof layoutDiscussion>) {
  const boxes = nodes.map(item => ({ ...item, ...result.positions.get(item.id)! }));
  expect(result.positions.size).toBe(nodes.length);
  for (let index = 0; index < boxes.length; index++) for (let peer = index + 1; peer < boxes.length; peer++) {
    expect(separate(boxes[index], boxes[peer]), `${boxes[index].id}/${boxes[peer].id}`).toBe(true);
  }
}

function assertRightRegions(target: DiscussionLayoutItem, result: ReturnType<typeof layoutDiscussion>, expected: Kind[] = kinds) {
  const position = result.positions.get(target.id)!, boxes = expected.map(type => result.regions.find(box => box.key === `${target.id}:${type}`)!);
  for (const box of boxes) {
    expect(box, `${target.id} region`).toBeDefined();
    expect(box.x).toBe(position.x + target.width + COL_GAP);
  }
  for (let index = 1; index < boxes.length; index++) expect(boxes[index].y).toBeGreaterThanOrEqual(boxes[index - 1].y + boxes[index - 1].height + ROW_GAP);
}

describe('all discussion branches use the next column', () => {
  it.each([{ width: 320, height: 180 }, { width: 760, height: 1600 }])('places support, reply and opposition in ordered right-hand regions for a $width × $height target', ({ width, height }) => {
    const target = node('target', 0, width, height), nodes = [target, node('support', 1, 510, 230), node('reply', 2, 370, 650), node('opposition', 3, 590, 170)];
    const links = [edge('support-edge', 'support', 'target', 'agree'), edge('reply-edge', 'reply', 'target', 'reply'), edge('opposition-edge', 'opposition', 'target', 'disagree')];
    const original = structuredClone({ nodes, links }), result = layoutDiscussion(nodes, links, { regions: kinds.map(type => region('target', type)) });
    assertRightRegions(target, result);
    for (const id of ['support', 'reply', 'opposition']) {
      expect(result.positions.get(id)!.x).toBeGreaterThanOrEqual(result.positions.get(target.id)!.x + width + COL_GAP);
      expect(result.positions.get(id)!.column).toBe(result.positions.get(target.id)!.column + 1);
    }
    assertNoCardOverlap(nodes, result);
    expect({ nodes, links }).toEqual(original);
  });

  it('keeps support above opposition on the right when no reply region exists', () => {
    const target = node('target', 0, 450, 300), nodes = [target, node('support', 1, 380, 500), node('opposition', 2, 360, 180)];
    const links = [edge('support-edge', 'support', 'target', 'agree'), edge('opposition-edge', 'opposition', 'target', 'disagree')];
    const result = layoutDiscussion(nodes, links, { regions: [region('target', 'agree'), region('target', 'disagree')] });
    assertRightRegions(target, result, ['agree', 'disagree']);
    expect(result.regions.some(box => box.type === 'reply')).toBe(false);
    assertNoCardOverlap(nodes, result);
  });

  it('advances every relation type through a second column and keeps complete nested subtrees disjoint', () => {
    const nodes = [node('target', 0, 570, 1100), node('support', 1, 410, 150), node('reply', 2, 330, 510), node('opposition', 3, 680, 290),
      node('support-support', 4, 380, 400), node('support-reply', 5, 490, 175), node('reply-opposition', 6, 360, 600), node('opposition-reply', 7, 430, 220)];
    const links = [edge('s', 'support', 'target', 'agree'), edge('r', 'reply', 'target', 'reply'), edge('d', 'opposition', 'target', 'disagree'),
      edge('ss', 'support-support', 'support', 'agree'), edge('sr', 'support-reply', 'support', 'reply'), edge('rd', 'reply-opposition', 'reply', 'disagree'), edge('dr', 'opposition-reply', 'opposition', 'reply')];
    const regions = [...kinds.map(type => region('target', type)), region('support', 'agree'), region('support', 'reply'), region('reply', 'disagree'), region('opposition', 'reply')];
    const result = layoutDiscussion(nodes, links, { regions }), byId = new Map(nodes.map(item => [item.id, item]));
    for (const link of links) {
      const source = result.positions.get(link.from.messageId)!, target = result.positions.get(link.to.messageId)!;
      expect(source.column, link.id).toBe(target.column + 1);
      expect(source.x, link.id).toBeGreaterThanOrEqual(target.x + byId.get(link.to.messageId)!.width + COL_GAP);
    }
    const boxes = new Map(result.regions.map(box => [box.key, box]));
    for (const [outerKey, innerKeys] of [['target:agree', ['support:agree', 'support:reply']], ['target:reply', ['reply:disagree']], ['target:disagree', ['opposition:reply']]] as const) {
      for (const key of innerKeys) expect(contains(boxes.get(outerKey)!, boxes.get(key)!), `${outerKey}/${key}`).toBe(true);
    }
    assertRightRegions(nodes[0], result);
    assertRightRegions(byId.get('support')!, result, ['agree', 'reply']);
    assertRightRegions(byId.get('reply')!, result, ['disagree']);
    assertRightRegions(byId.get('opposition')!, result, ['reply']);
    for (let index = 0; index < result.regions.length; index++) for (let peer = index + 1; peer < result.regions.length; peer++) {
      const a = result.regions[index], b = result.regions[peer];
      expect(separate(a, b) || contains(a, b) || contains(b, a), `${a.key}/${b.key}`).toBe(true);
    }
    assertNoCardOverlap(nodes, result);
    expect(layoutDiscussion([...nodes].reverse(), [...links].reverse(), { regions: [...regions].reverse() })).toEqual(result);
  });

  it.each(kinds)('retains an independent %s collapsed header between the other right-hand regions', collapsed => {
    const target = node('target', 0, 420, 500), visibleKinds = kinds.filter(type => type !== collapsed);
    // Ownership is computed from the complete graph, before any fold is applied.
    const nodes = [target, ...kinds.map((type, index) => node(`source:${type}`, index + 1, 360 + index * 70, 190 + index * 150))];
    const links = kinds.map(type => edge(`edge:${type}`, `source:${type}`, 'target', type));
    const result = layoutDiscussion(nodes, links, { regions: kinds.map(type => region('target', type, type === collapsed)) });
    assertRightRegions(target, result);
    const closed = result.regions.find(box => box.type === collapsed)!;
    expect(closed.collapsed).toBe(true);
    expect(closed.height).toBe(DISCUSSION_REGION_HEADER);
    expect(closed.width).toBeGreaterThanOrEqual(200);
    expect(result.positions.has(`source:${collapsed}`)).toBe(false);
    for (const type of visibleKinds) {
      expect(result.regions.find(box => box.type === type)!.height).toBeGreaterThan(DISCUSSION_REGION_HEADER);
      expect(result.positions.get(`source:${type}`)!.column).toBe(result.positions.get('target')!.column + 1);
    }
    assertNoCardOverlap(nodes.filter(item => item.id !== `source:${collapsed}`), result);
  });

  it('places a shared source once, keeps its real IDs and all edges, and leaves the secondary region reachable', () => {
    const nodes = [node('target-a', 0, 460, 300), node('target-b', 1, 390, 460), node('shared-source', 2, 550, 210), node('nested-source', 3, 350, 280)];
    const links = [edge('original-reply-id', 'shared-source', 'target-b', 'reply'), edge('new-support-id', 'shared-source', 'target-a', 'agree'),
      edge('nested-opposition-id', 'nested-source', 'shared-source', 'disagree')];
    const original = structuredClone(links), regions = [region('target-a', 'agree'), region('target-b', 'reply'), region('shared-source', 'disagree')];
    const result = layoutDiscussion(nodes, links, { regions });
    expect([...result.positions.keys()].sort()).toEqual(nodes.map(item => item.id).sort());
    expect(result.order.filter(id => id === 'shared-source')).toHaveLength(1);
    expect(result.parent.get('shared-source')).toBe('target-a');
    expect(result.positions.get('shared-source')!.column).toBe(result.positions.get('target-a')!.column + 1);
    expect(result.positions.get('nested-source')!.column).toBe(result.positions.get('shared-source')!.column + 1);
    expect(result.regions.find(box => box.key === 'target-b:reply')).toMatchObject({ height: DISCUSSION_REGION_HEADER, directCount: 1, collapsed: false });
    expect(links).toEqual(original);
    assertNoCardOverlap(nodes, result);
    const closedOwner = layoutDiscussion(nodes, links, { regions: regions.map(value => ({ ...value, collapsed: value.key === 'target-a:agree' })) });
    expect([...closedOwner.positions.keys()].sort()).toEqual(['target-a', 'target-b']);
    expect(closedOwner.regions.some(value => value.targetId === 'shared-source')).toBe(false);
    expect(closedOwner.regions.find(value => value.key === 'target-a:agree')).toMatchObject({ collapsed: true, height: DISCUSSION_REGION_HEADER, directCount: 1 });
    const closedSecondary = layoutDiscussion(nodes, links, { regions: regions.map(value => ({ ...value, collapsed: value.key === 'target-b:reply' })) });
    expect(closedSecondary.positions.get('shared-source')).toEqual(result.positions.get('shared-source'));
    expect(closedSecondary.positions.get('nested-source')).toEqual(result.positions.get('nested-source'));
    expect(closedSecondary.positions.size).toBe(nodes.length);
    expect(links).toEqual(original);
  });
});
