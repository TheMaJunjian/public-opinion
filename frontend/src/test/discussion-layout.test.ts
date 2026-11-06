import { describe, expect, it } from 'vitest';
import { layoutDiscussion, DISCUSSION_REGION_HEADER, DISCUSSION_REGION_FOOTER, DISCUSSION_REGION_PADDING, type DiscussionLayoutItem, type DiscussionRegionInput } from '../utils/discussionLayout';
import { computeSceneLayout, type FrameBlock } from '../utils/frameLayout';
import { projectStanceLayoutEdges } from '../utils/stanceLayout';
import { projectDiscussionLayoutEdges } from '../utils/discussionLayoutEdges';
import { COL_GAP, ROW_GAP, FRAME_PAD } from '../utils/layout';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

const item = (id: string, sequence = 0, width = 320, height = 100): DiscussionLayoutItem => ({ id, sequence, width, height });
const edge = (id: string, source: string, target: string, relationType: DemoEdge['relationType'] = 'reply'): DemoEdge => ({
  id, relationMessageId: id, relationType, relationLabel: relationType,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } },
});
const message = (id: string, sequence = 0): DemoMessage => ({ id, sequence, createdAt: '', author: 'structure-fixture', kind: 'normal', content: `fixture:${id}` });
const frame = (id: string, members: string[], children: string[] = []): FrameBlock => ({ relMsgId: id, cardIds: new Set([...members, ...children]),
  directCardIds: new Set(members), childRelMsgIds: children, isMerge: false, hasGroupHeader: true });
const region = (key: string, targetId: string, type: DiscussionRegionInput['type'] = 'reply', collapsed = false, directCount = 1): DiscussionRegionInput => ({ key, targetId, type, collapsed, directCount });
function expectNoOverlap(nodes: DiscussionLayoutItem[], result: ReturnType<typeof layoutDiscussion>) {
  for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
    const left = result.positions.get(nodes[a].id)!, right = result.positions.get(nodes[b].id)!;
    expect(left.x + nodes[a].width <= right.x || right.x + nodes[b].width <= left.x
      || left.y + nodes[a].height <= right.y || right.y + nodes[b].height <= left.y, `${nodes[a].id}/${nodes[b].id}`).toBe(true);
  }
}

describe('discussion branches on measured rectangles', () => {
  it.each(['reply', 'agree', 'disagree'] as const)('uses the same region inset for a native frame and an ordinary card in a %s region', type => {
    const nodes = [item('target'), {...item('frame', 1, 420, 200), outset: FRAME_PAD}, item('text', 2, 420, 200)];
    const links = [edge('frame-link', 'frame', 'target', type), edge('text-link', 'text', 'target', type)];
    const result = layoutDiscussion(nodes, links, {regions: [region('region', 'target', type, false, 2)]});
    const box = result.regions[0], framed = result.positions.get('frame')!, text = result.positions.get('text')!;
    expect(framed.x - box.x).toBe(DISCUSSION_REGION_PADDING);
    expect(text.x - box.x).toBe(DISCUSSION_REGION_PADDING);
    expect(framed.y - box.y - box.headerHeight).toBe(DISCUSSION_REGION_PADDING);
    expect(box.x + box.width - framed.x - 420).toBe(DISCUSSION_REGION_PADDING);
    expect(text.y - framed.y - 200).toBe(ROW_GAP);
    expect(box.y + box.height - DISCUSSION_REGION_FOOTER - text.y - 200).toBe(DISCUSSION_REGION_PADDING);
    expectNoOverlap(nodes, result);
    const separate = layoutDiscussion([nodes[1]], []);
    expect(separate.positions.get('frame')).toMatchObject({x:FRAME_PAD, y:FRAME_PAD});
  });
  it('puts support, reply and opposition in vertically ordered bands to the target right', () => {
    const nodes = [item('target', 0, 470, 220), item('reply', 1, 350, 170), item('support', 2, 390, 130), item('opposition', 3, 340, 190)];
    const links = [edge('reply-link', 'reply', 'target'), edge('support-link', 'support', 'target', 'agree'), edge('opposition-link', 'opposition', 'target', 'disagree')];
    const result = layoutDiscussion(nodes, links), target = result.positions.get('target')!;
    expect(result.positions.get('reply')!.x).toBe(target.x + 470 + COL_GAP);
    expect(result.positions.get('reply')!.column).toBe(target.column + 1);
    expect(result.positions.get('support')!.x).toBe(target.x + 470 + COL_GAP);
    expect(result.positions.get('support')!.column).toBe(target.column + 1);
    expect(result.positions.get('support')!.y).toBe(target.y);
    expect(result.positions.get('reply')!.y).toBeGreaterThanOrEqual(result.positions.get('support')!.y + 130 + ROW_GAP);
    expect(result.positions.get('opposition')!.x).toBe(target.x + 470 + COL_GAP);
    expect(result.positions.get('opposition')!.column).toBe(target.column + 1);
    expect(result.positions.get('opposition')!.y).toBeGreaterThanOrEqual(result.positions.get('reply')!.y + 170 + ROW_GAP);
    expectNoOverlap(nodes, result);
  });

  it('recursively reserves measured subtrees for mixed support, reply and opposition branches', () => {
    const nodes = ['target', 'support', 'support-reply', 'support-support', 'reply', 'reply-agree', 'reply-disagree', 'opposition', 'opposition-reply']
      .map((id, index) => item(id, index, 320 + index * 31, 86 + index * 47));
    const links = [edge('a', 'support', 'target', 'agree'), edge('b', 'support-reply', 'support'), edge('c', 'support-support', 'support', 'agree'),
      edge('d', 'reply', 'target'), edge('e', 'reply-agree', 'reply', 'agree'), edge('f', 'reply-disagree', 'reply', 'disagree'),
      edge('g', 'opposition', 'target', 'disagree'), edge('h', 'opposition-reply', 'opposition')];
    const result = layoutDiscussion(nodes, links), sizes = new Map(nodes.map(node => [node.id, node]));
    for (const link of links) {
      const source = result.positions.get(link.from.messageId)!, target = result.positions.get(link.to.messageId)!;
      expect(source.x).toBe(target.x + sizes.get(link.to.messageId)!.width + COL_GAP);
      expect(source.column).toBe(target.column + 1);
      expect(source.y).toBeGreaterThanOrEqual(target.y);
    }
    expectNoOverlap(nodes, result);
  });

  it('keeps one card and all original edges for multi-target replies with an order-independent primary parent', () => {
    const nodes = [item('early', 1), item('late', 2), item('reply', 3), item('other', 4)];
    const links = [edge('second', 'reply', 'late'), edge('first', 'reply', 'early'), edge('citation', 'reply', 'other', 'reference')];
    const original = structuredClone(links), result = layoutDiscussion(nodes, links);
    expect(result.parent.get('reply')).toBe('early');
    expect(result.positions.size).toBe(nodes.length);
    expect(new Set(result.order).size).toBe(nodes.length);
    expect(layoutDiscussion([...nodes].reverse(), [...links].reverse())).toEqual(result);
    expect(links).toEqual(original);
    expectNoOverlap(nodes, result);
  });

  it.each(['agree', 'disagree'] as const)('lets a later %s position an existing reply in its stance branch without deleting the reply', type => {
    const nodes = [item('target'), item('comment', 1)];
    const links = [edge('original-reply', 'comment', 'target'), edge('later-stance', 'comment', 'target', type)];
    const regions = [region('support-region', 'target', 'agree'), region('reply-region', 'target'), region('opposition-region', 'target', 'disagree')];
    const result = layoutDiscussion(nodes, links, { regions }), target = result.positions.get('target')!, source = result.positions.get('comment')!;
    const stance = result.regions.find(value=>value.type===type)!, reply = result.regions.find(value=>value.type==='reply')!;
    expect(source.x).toBe(target.x + 320 + COL_GAP + DISCUSSION_REGION_PADDING);
    expect(source.column).toBe(target.column + 1);
    expect(source.y).toBe(stance.y + stance.headerHeight + DISCUSSION_REGION_PADDING);
    expect(source.y + 100).toBeLessThanOrEqual(stance.y + stance.height - DISCUSSION_REGION_PADDING);
    expect(reply.height).toBe(DISCUSSION_REGION_HEADER);
    expect(links).toHaveLength(2);
    expect(links[0].relationType).toBe('reply');
  });

  it('uses the latest supplied stance record for the primary branch, including same-time sequence ordering', () => {
    const nodes = [item('target'), item('comment', 1)];
    const links = [edge('original', 'comment', 'target'), edge('z-old-support', 'comment', 'target', 'agree'), edge('a-new-opposition', 'comment', 'target', 'disagree')];
    const relationCatalog = new Map([['z-old-support', { createdAt: '2026-01-01T00:00:00Z', sequence: 10 }],
      ['a-new-opposition', { createdAt: '2026-01-01T00:00:00Z', sequence: 11 }]]);
    const regions = [region('support', 'target', 'agree'), region('opposition', 'target', 'disagree')];
    const result = layoutDiscussion(nodes, links, { relationCatalog, regions });
    expect(result.positions.get('comment')!.x).toBe(result.positions.get('target')!.x + 320 + COL_GAP + DISCUSSION_REGION_PADDING);
    expect(result.positions.get('comment')!.y).toBeGreaterThan(result.positions.get('target')!.y);
    expect(result.positions.get('comment')!.y).toBeGreaterThan(result.regions.find(box=>box.key==='opposition')!.y);
    expect(layoutDiscussion([...nodes].reverse(), [...links].reverse(), { relationCatalog, regions })).toEqual(result);
    expect(links).toHaveLength(3);
  });

  it.each((['reply','agree','disagree','recommend','archive'] as const).flatMap(type=>
    (['time','sequence'] as const).map(order=>({type,order}))))('uses the latest $type for the same pair by $order without deleting other active relations',({type,order})=>{
    const nodes=[item('target'),item('source',1)];
    const links=[edge('old','source','target',type==='disagree'?'agree':'disagree'),edge('new','source','target',type)];
    const relationCatalog=new Map([
      ['old',{createdAt:'2026-01-01T00:00:00Z',sequence:1}],
      ['new',{createdAt:order==='time'?'2026-01-01T00:01:00Z':'2026-01-01T00:00:00Z',sequence:2}],
    ]);
    const regions=[region('old-region','target',links[0].relationType as DiscussionRegionInput['type']),region('latest-region','target',type)];
    const original=structuredClone(links),result=layoutDiscussion(nodes,links,{relationCatalog,regions});
    expect(result.ownerRegionById.get('source')).toBe('latest-region');
    expect(result.parentTypes.get('source')).toBe(type);
    expect(layoutDiscussion([...nodes].reverse(),[...links].reverse(),{relationCatalog,regions})).toEqual(result);
    expect(links).toEqual(original);
  });

  it.each((['reply','agree','disagree','recommend','archive'] as const).flatMap(type=>
    (['whole','part'] as const).map(address=>({type,address}))))('promotes an existing $type relation when an agreement endorses its $address address',({type,address})=>{
    const base=[message('target'),message('source',1)];
    const older:DemoMessage={...message('old',2),kind:'relation',relationType:type,revision:1,parts:[{
      id:'relation',type:'relation',relation:type,roles:{source:[{id:'source',reference:{messageId:'source'}}],target:[{id:'target',reference:{messageId:'target'}}]},
    }]};
    const newer={...message('new',3),kind:'relation' as const,relationType:type==='disagree'?'agree' as const:'disagree' as const};
    const approval:DemoMessage={...message('approval',4),kind:'relation',relationType:'agree',
      executedStance:{partId:'approval',sourceRevision:1,target:{messageId:type==='agree'||type==='disagree'?'target':'old'},side:type==='disagree'?'con':'pro'}};
    const messages=[...base,older,newer,approval],links=[edge('old','source','target',type),edge('new','source','target',newer.relationType),edge('approval','anon:approval','old','agree')];
    links[2].to.reference={messageId:'old',revision:1,...(address==='part'?{partId:'relation'}:{})};
    if(address==='part')links[2].to.selection={kind:'edge',edgeId:'old'};
    const original=structuredClone({messages,links});
    const projected=projectDiscussionLayoutEdges(messages,links,new Set());
    const result=layoutDiscussion([item('target'),item('source',1)],projected,{relationCatalog:new Map(messages.map(value=>[value.id,value]))});
    expect(result.parentTypes.get('source')).toBe(type);
    expect({messages,links}).toEqual(original);
  });

  it.each(['proposal','opposition','text','historical','suppressed'] as const)('does not promote an old relation through a %s vote',kind=>{
    const messages:DemoMessage[]=[message('target'),message('source',1),{...message('old',2),kind:'relation' as const,relationType:'reply' as const,revision:2},
      {...message('new',3),kind:'relation' as const,relationType:'disagree' as const},
      {...message('vote',4),kind:'relation' as const,relationType:'agree' as const,...(kind==='suppressed'?{state:{messageId:'vote',revision:1,suppressed:true,supportCount:0,oppositionCount:0,recommendationTotal:0}}:{})}];
    const vote=edge('vote','anon:vote','old',kind==='opposition'?'disagree':'agree');
    if(kind==='proposal')vote.proposalOnly=true;
    if(kind==='text')vote.to.selection={kind:'text',start:0,len:1,text:'x'};
    if(kind==='historical')vote.to.reference={messageId:'old',revision:1};
    const links=[edge('old','source','target'),edge('new','source','target','disagree'),vote];
    const projected=projectDiscussionLayoutEdges(messages,links,new Set());
    const result=layoutDiscussion([item('target'),item('source',1)],projected,{relationCatalog:new Map(messages.map(value=>[value.id,value]))});
    expect(result.parentTypes.get('source')).toBe('disagree');
  });

  it('carries a later endorsement through agreement chains without looping on malformed cycles',()=>{
    const messages=[message('target'),message('source',1),
      ...['old','new','first','second'].map((id,index)=>({...message(id,index+2),kind:'relation' as const,relationType:id==='old'?'reply' as const:'agree' as const}))];
    const links=[edge('old','source','target'),edge('new','source','target','agree'),edge('first','anon:first','old','agree'),edge('second','anon:second','first','agree')];
    const result=projectDiscussionLayoutEdges(messages,links,new Set());
    expect(result.find(value=>value.id==='old')?.discussionOrder?.sequence).toBe(5);
    const cycle=[...links,edge('cycle','anon:first','second','agree')];cycle[4].relationMessageId='first';
    expect(()=>projectDiscussionLayoutEdges(messages,cycle,new Set())).not.toThrow();
    expect(links[0].discussionOrder).toBeUndefined();
  });

  it('breaks cyclic placement dependencies deterministically without dropping or duplicating cards', () => {
    const nodes = [item('a', 1), item('b', 2), item('c', 3), item('self', 4)];
    const links = [edge('ab', 'a', 'b'), edge('bc', 'b', 'c', 'agree'), edge('ca', 'c', 'a', 'disagree'), edge('self-loop', 'self', 'self')];
    const result = layoutDiscussion(nodes, links);
    expect(result.parent.has('a')).toBe(false);
    expect(result.parent.has('self')).toBe(false);
    expect(result.positions.size).toBe(4);
    expect(layoutDiscussion([...nodes].reverse(), [...links].reverse())).toEqual(result);
    expectNoOverlap(nodes, result);
  });

  it.each(['reference', 'annotation', 'notify'] as const)('keeps %s connections in a right-hand branch without reinterpreting them as stances', relationType => {
    const result = layoutDiscussion([item('target'), item('source', 1)], [edge('link', 'source', 'target', relationType)]);
    expect(result.positions.get('source')!.x).toBe(result.positions.get('target')!.x + 320 + COL_GAP);
    expect(result.positions.get('source')!.y).toBe(result.positions.get('target')!.y);
  });

  it('does not invent cards or parents for anonymous, missing or unrelated relationship endpoints', () => {
    const result = layoutDiscussion([item('target'), item('other', 1)], [edge('vote', 'anon:vote', 'target', 'agree'),
      edge('missing', 'other', 'not-in-scope'), edge('tag', 'other', 'target', 'tag')]);
    expect([...result.positions.keys()]).toEqual(['target', 'other']);
    expect(result.parent.size).toBe(0);
  });

  it('lays out a deep reply chain iteratively with a bounded number of endpoint reads', () => {
    const count = 20_000, nodes = Array.from({ length: count }, (_, index) => item(`node-${index}`, index));
    let endpointReads = 0;
    const links = nodes.slice(1).map((node, index) => {
      const link = edge(`edge-${index}`, node.id, nodes[index].id), from = link.from, to = link.to;
      Object.defineProperties(link, { from: { get: () => { endpointReads++; return from; } }, to: { get: () => { endpointReads++; return to; } } });
      return link;
    });
    const result = layoutDiscussion(nodes, links);
    expect(result.positions.size).toBe(count);
    expect(result.positions.get(`node-${count - 1}`)).toEqual({ x: (count - 1) * (320 + COL_GAP), y: 0, column: count - 1 });
    expect(endpointReads).toBeLessThanOrEqual(links.length * 4);
  });
});

describe('automatic discussion region geometry', () => {
  it('reserves headers, collapse footers and padding around complete primary subtrees, including their nested regions', () => {
    const nodes = ['target', 'support', 'reply', 'opposition', 'nested-reply'].map((id, index) => item(id, index, 320 + index * 30, 100 + index * 20));
    const links = [edge('a', 'support', 'target', 'agree'), edge('r', 'reply', 'target'), edge('d', 'opposition', 'target', 'disagree'), edge('n', 'nested-reply', 'reply')];
    const regions = [region('support-region', 'target', 'agree'), region('reply-region', 'target'), region('opposition-region', 'target', 'disagree'), region('nested-region', 'reply')];
    const result = layoutDiscussion(nodes, links, { regions }), target = result.positions.get('target')!;
    const boxes = new Map(result.regions.map(box => [box.key, box]));
    for (const [key, childId] of [['support-region', 'support'], ['reply-region', 'reply'], ['opposition-region', 'opposition'], ['nested-region', 'nested-reply']]) {
      const box = boxes.get(key)!, child = result.positions.get(childId)!, size = nodes.find(node => node.id === childId)!;
      expect(box.headerHeight).toBe(DISCUSSION_REGION_HEADER);
      expect(child.x).toBeGreaterThanOrEqual(box.x + DISCUSSION_REGION_PADDING);
      expect(child.y).toBeGreaterThanOrEqual(box.y + box.headerHeight + DISCUSSION_REGION_PADDING);
      expect(child.x + size.width).toBeLessThanOrEqual(box.x + box.width - DISCUSSION_REGION_PADDING);
      expect(child.y + size.height).toBeLessThanOrEqual(box.y + box.height - DISCUSSION_REGION_FOOTER - DISCUSSION_REGION_PADDING);
    }
    expect(boxes.get('support-region')!.x).toBe(target.x + nodes[0].width + COL_GAP);
    expect(boxes.get('support-region')!.y).toBe(target.y);
    expect(boxes.get('reply-region')!.y).toBeGreaterThanOrEqual(boxes.get('support-region')!.y + boxes.get('support-region')!.height + ROW_GAP);
    expect(boxes.get('reply-region')!.x).toBe(target.x + nodes[0].width + COL_GAP);
    expect(boxes.get('opposition-region')!.x).toBe(target.x + nodes[0].width + COL_GAP);
    expect(boxes.get('opposition-region')!.y).toBeGreaterThanOrEqual(boxes.get('reply-region')!.y + boxes.get('reply-region')!.height + ROW_GAP);
    const outer = boxes.get('reply-region')!, nested = boxes.get('nested-region')!;
    expect(nested.x).toBeGreaterThanOrEqual(outer.x + DISCUSSION_REGION_PADDING);
    expect(nested.x + nested.width).toBeLessThanOrEqual(outer.x + outer.width - DISCUSSION_REGION_PADDING);
    expect(nested.y + nested.height).toBeLessThanOrEqual(outer.y + outer.height - DISCUSSION_REGION_FOOTER - DISCUSSION_REGION_PADDING);
    expectNoOverlap(nodes, result);
  });

  it('retains compact headers for empty, shared and collapsed regions without manufacturing cards', () => {
    const nodes = [item('target')];
    const result = layoutDiscussion(nodes, [], { regions: [region('shared', 'target', 'reply', false, 3), region('closed', 'target', 'agree', true, 2), region('absent', 'not-visible')] });
    expect(result.positions.size).toBe(1);
    expect(result.regions).toHaveLength(2);
    for (const box of result.regions) {
      expect(box.height).toBe(DISCUSSION_REGION_HEADER);
      expect(box.width).toBeGreaterThanOrEqual(200);
    }
    expect(result.regions.find(box => box.key === 'shared')!.directCount).toBe(3);
  });

  it('hides a shared source with its actual owner instead of moving it to another expanded parent', () => {
    const nodes = [item('closed-target'), item('open-target', 1), item('shared-source', 2)];
    const links = [edge('closed-edge', 'shared-source', 'closed-target'), edge('open-edge', 'shared-source', 'open-target')];
    const original = structuredClone(links);
    const result = layoutDiscussion(nodes, links, { regions: [region('closed', 'closed-target', 'reply', true), region('open', 'open-target')] });
    expect(result.positions.size).toBe(2);
    expect(result.parent.get('shared-source')).toBe('closed-target');
    expect(result.hiddenIds).toEqual(['shared-source']);
    expect(result.ownerRegionById.get('shared-source')).toBe('closed');
    expect(result.regions.find(box => box.key === 'closed')!.height).toBe(DISCUSSION_REGION_HEADER);
    expect(result.regions.find(box => box.key === 'open')!.height).toBe(DISCUSSION_REGION_HEADER);
    expect(links).toEqual(original);
    expectNoOverlap(nodes.filter(node => result.positions.has(node.id)), result);
  });

  it('does not place reference-only sources inside a reply region', () => {
    const nodes = [item('target'), item('citation', 1)];
    const result = layoutDiscussion(nodes, [edge('citation-link', 'citation', 'target', 'reference')], { regions: [region('reply', 'target', 'reply', false, 0)] });
    const box = result.regions[0], citation = result.positions.get('citation')!;
    expect(box.height).toBe(DISCUSSION_REGION_HEADER);
    expect(citation.y).toBeGreaterThanOrEqual(box.y + box.height + ROW_GAP);
  });

  it('keeps the original numerical layout when no regions are requested', () => {
    const nodes = [item('target'), item('source', 1)], links = [edge('reply', 'source', 'target')];
    expect(layoutDiscussion(nodes, links, { regions: [] })).toEqual(layoutDiscussion(nodes, links));
  });

  it('measures a deep chain of automatic frames iteratively without copying descendant lists', () => {
    const count = 5_000, nodes = Array.from({ length: count }, (_, index) => item(`node-${index}`, index));
    let reads = 0;
    const regions = nodes.slice(0, -1).map(node => {
      const value = region(`region-${node.id}`, node.id);
      Object.defineProperty(value, 'targetId', { enumerable: true, get: () => { reads++; return node.id; } });
      return value;
    });
    const links = nodes.slice(1).map((node, index) => edge(`edge-${index}`, node.id, nodes[index].id));
    const result = layoutDiscussion(nodes, links, { regions });
    expect(result.positions.size).toBe(count);
    expect(result.regions).toHaveLength(count - 1);
    expect(reads).toBeLessThanOrEqual(regions.length * 6);
    expect(result.regions[0].width).toBeGreaterThan(result.regions.at(-1)!.width);
  });
});

describe('discussion mode through the existing scene layout', () => {
  it.each(['row', 'flow'] as const)('preserves explicit %s member order over discussion constraints while placing the whole frame by its outside reply', display => {
    const normals = [message('first', 5), message('second', 1), message('outside', 0)];
    const organization: DemoMessage = { ...message('manual'), kind: 'relation', relationType: 'arrange',
      parts: [{ id: 'display', type: 'display', layout: display, relationPartId: 'members' }] };
    const links = [edge('inside-support', 'second', 'first', 'agree'), edge('outside-reply', 'first', 'outside')];
    const result = computeSceneLayout({ discussionLayout: true, normals, allMessages: [...normals, organization], edges: links,
      discussionRegions: [region('inside-manual', 'first', 'agree'), region('outside-manual', 'outside')],
      frameBlocks: [{ ...frame('manual', ['first', 'second']), targetLayout: display === 'row' ? 'single-row' : 'single-column' }],
      frameViewSizes: { manual: { width: 480, height: 240 } }, measuredHeights: { first: 173, second: 257 },
      measuredWidths: { first: 440, second: 360 }, colOf: {}, maxCol: 0 });
    const first = result.layout.first, second = result.layout.second, outside = result.layout.outside;
    if (display === 'row') {
      expect(second.x).toBe(first.x + first.width + COL_GAP);
      expect(second.y).toBe(first.y);
      expect(result.frameContentRects.manual.width).toBeGreaterThan(result.frameRects.manual.width);
    } else {
      expect(second.x).toBe(first.x);
      expect(second.y).toBe(first.y + first.height + ROW_GAP);
    }
    expect(result.frameRects.manual.x).toBeGreaterThanOrEqual(outside.x + outside.width + COL_GAP);
    expect(result.placementOrder.filter(id => id === 'first')).toHaveLength(1);
    expect(result.placementOrder.filter(id => id === 'second')).toHaveLength(1);
    expect(result.discussionRegions?.map(box => box.key)).toEqual(['outside-manual']);
    expect(links).toHaveLength(2);
  });

  it('emits each descriptor only in its own atom scope and translates nested regions to scene coordinates', () => {
    const normals = [message('a1'), message('a2', 1), message('b1', 2), message('b2', 3)];
    const result = computeSceneLayout({ discussionLayout: true, normals, allMessages: normals,
      frameBlocks: [frame('A', ['a1', 'a2']), frame('B', ['b1', 'b2'])], edges: [edge('inside-a', 'a2', 'a1'), edge('inside-b', 'b2', 'b1'), edge('outside', 'B', 'A')],
      discussionRegions: [region('a-region', 'a1'), region('b-region', 'b1'), region('frame-region', 'A')], colOf: {}, maxCol: 0, measuredHeights: {}, measuredWidths: {} });
    const boxes = new Map(result.discussionRegions?.map(box => [box.key, box]));
    expect(boxes.size).toBe(3);
    expect(boxes.get('a-region')!.x).toBe(result.layout.a1.x + result.layout.a1.width + COL_GAP);
    expect(boxes.get('b-region')!.x).toBe(result.layout.b1.x + result.layout.b1.width + COL_GAP);
    expect(boxes.get('frame-region')!.x).toBe(result.frameRects.A.x + result.frameRects.A.width + COL_GAP);
    expect(boxes.get('frame-region')!.x + DISCUSSION_REGION_PADDING).toBe(result.frameRects.B.x);
    expect(boxes.get('b-region')!.x + boxes.get('b-region')!.width).toBeLessThanOrEqual(boxes.get('frame-region')!.x + boxes.get('frame-region')!.width - DISCUSSION_REGION_PADDING);
  });

  it.each([false, true])('moves a reply frame as one block and preserves its interior (nested: %s)', nested => {
    const normals = ['a1', 'a2', 'b1', 'b2'].map((id, index) => message(id, index));
    const frames = [frame('A', ['a1', 'a2']), frame('B', ['b1', 'b2']), ...(nested ? [frame('outer', [], ['A', 'B'])] : [])];
    const run = (links: DemoEdge[]) => computeSceneLayout({ discussionLayout: true, normals, allMessages: normals, frameBlocks: frames, edges: links,
      measuredHeights: { a1: 183, b2: 280 }, measuredWidths: { a2: 470 }, colOf: {}, maxCol: 0 });
    const before = run([]), after = run([edge('cross-frame', 'a1', 'b1')]);
    expect(after.frameRects.A.x).toBeGreaterThanOrEqual(after.frameRects.B.x + after.frameRects.B.width + COL_GAP);
    for (const [parent, ids] of [['A', ['a1', 'a2']], ['B', ['b1', 'b2']]] as const) for (const id of ids) {
      expect(after.layout[id].x - after.frameRects[parent].x).toBe(before.layout[id].x - before.frameRects[parent].x);
      expect(after.layout[id].y - after.frameRects[parent].y).toBe(before.layout[id].y - before.frameRects[parent].y);
      expect(after.placementOrder.filter(value => value === id)).toHaveLength(1);
    }
    expect(after.measuredFrames).toBe(nested ? 3 : 2);
  });

  it('applies support/opposition inside an existing frame using actual measured card heights', () => {
    const normals = ['target', 'support', 'opposition', 'reply'].map((id, index) => message(id, index));
    const result = computeSceneLayout({ discussionLayout: true, normals, allMessages: normals, frameBlocks: [frame('group', normals.map(node => node.id))],
      edges: [edge('supporting', 'support', 'target', 'agree'), edge('opposing', 'opposition', 'target', 'disagree'), edge('replying', 'reply', 'target')],
      measuredHeights: { target: 300, support: 420, opposition: 160, reply: 540 }, measuredWidths: {}, colOf: {}, maxCol: 0 });
    expect(result.layout.support.x).toBe(result.layout.target.x + result.layout.target.width + COL_GAP);
    expect(result.layout.support.y).toBe(result.layout.target.y);
    expect(result.layout.reply.y).toBeGreaterThanOrEqual(result.layout.support.y + result.layout.support.height + ROW_GAP);
    expect(result.layout.opposition.y).toBeGreaterThanOrEqual(result.layout.reply.y + result.layout.reply.height + ROW_GAP);
    expect(result.frameContentRects.group.y + result.frameContentRects.group.height).toBeGreaterThan(result.layout.opposition.y + result.layout.opposition.height);
  });

  it('honors the native executed stance target and side while preserving the original selected edge', () => {
    const normals = [message('claim'), { ...message('reason', 1), parts: [{ id: 'body', type: 'text' as const, text: '' }],
      executedStance: { partId: 'stance', sourceRevision: 1, target: { messageId: 'claim' }, side: 'con' as const } }];
    const original = edge('reason', 'reason', 'older-stance', 'agree');
    const result = computeSceneLayout({ discussionLayout: true, normals, allMessages: normals, edges: projectStanceLayoutEdges(normals, [original]),
      colOf: {}, maxCol: 0, measuredHeights: {}, measuredWidths: {} });
    expect(result.layout.reason.x).toBe(result.layout.claim.x + result.layout.claim.width + COL_GAP);
    expect(result.layout.reason.y).toBe(result.layout.claim.y);
    expect(original.relationType).toBe('agree');
    expect(original.to.messageId).toBe('older-stance');
  });

  it('keeps the original layout unchanged unless the new option is explicitly enabled', () => {
    const normals = [message('target'), message('support', 1)];
    const input = { normals, allMessages: normals, edges: [edge('stance', 'support', 'target', 'agree')], colOf: {}, maxCol: 0, measuredHeights: {}, measuredWidths: {} };
    expect(computeSceneLayout({ ...input, discussionLayout: false })).toEqual(computeSceneLayout(input));
    const enabled = computeSceneLayout({ ...input, discussionLayout: true });
    expect(enabled.layout.support.x).toBe(enabled.layout.target.x + enabled.layout.target.width + COL_GAP);
    expect(enabled.layout.support.y).toBe(enabled.layout.target.y);
  });
});
