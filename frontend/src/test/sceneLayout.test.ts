import { describe, expect, it } from 'vitest';
import { computeSceneLayout, type FrameBlock } from '../utils/frameLayout';
import { projectStanceLayoutEdges } from '../utils/stanceLayout';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';
import { buildFrameBlocks } from '../utils/graphOrganizations';
import { extractTextTargetsForMessage } from '../utils/graphTextSelection';
import { CARD_W, COL_GAP, GRID_LEFT, GRID_TOP, ROW_GAP } from '../utils/layout';
import {applyAgreeDisagreeColumnOverride} from '../utils/graphColumnRules';
import {projectGraphScene} from '../utils/graphProjection';

const message = (id: string): DemoMessage => ({ id, author: 'a', kind: 'normal', content: id, createdAt: '2026-01-01T00:00:00Z' });
const edge = (id: string, source: string, target: string): DemoEdge => ({ id, relationMessageId: id, relationType: 'disagree', relationLabel: '反对', from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } } });
const frame = (id: string, members: string[], children: string[] = []): FrameBlock => ({ relMsgId: id, cardIds: new Set([...members, ...children]), directCardIds: new Set(members), childRelMsgIds: children, isMerge: false, hasGroupHeader: true });

describe('scene layout', () => {
  it.each([false,true].flatMap(nested=>['b1','group-b'].map(target=>({nested,target}))))('places a citing classification as a whole to the right of $target (nested: $nested)',({nested,target})=>{
    const normals=['a1','a2','b1','b2'].map((id,index)=>({...message(id),createdAt:new Date(index*1000).toISOString()}));
    const containers=['group-a','group-b','outer'].map(id=>({...message(id),kind:'relation' as const,relationType:'classify' as const}));
    const frames=[frame('group-a',['a1','a2']),frame('group-b',['b1','b2']),...(nested?[frame('outer',[],['group-a','group-b'])]:[])];
    const run=(links:DemoEdge[])=>computeSceneLayout({normals,allMessages:[...normals,...containers],edges:links,frameBlocks:frames,colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{}});
    const before=run([]),after=run([{...edge('citation','a2',target),relationType:'reference'}]);
    expect(after.frameRects['group-a'].x).toBeGreaterThanOrEqual(after.frameRects['group-b'].x+after.frameRects['group-b'].width+COL_GAP);
    for(const [container,ids] of [['group-a',['a1','a2']],['group-b',['b1','b2']]] as const)for(const id of ids){
      expect(after.layout[id].x-after.frameRects[container].x).toBe(before.layout[id].x-before.frameRects[container].x);
      expect(after.layout[id].y-after.frameRects[container].y).toBe(before.layout[id].y-before.frameRects[container].y);
    }
  });
  it('cascades a new support through existing classifications without changing their internal layouts',()=>{
    const normals=['b1','b2','a1','a2','c1','c2','support'].map((id,index)=>({...message(id),createdAt:new Date(index*1000).toISOString()}));
    const containers=['A','B','C'].map(id=>({...message(id),kind:'relation' as const,relationType:'classify' as const}));
    const frames=[frame('B',['b1','b2']),frame('A',['a1','a2']),frame('C',['c1','c2'])];
    const original=[{...edge('a-b','a1','b1'),relationType:'reference' as const},{...edge('c-a','c1','a1'),relationType:'reference' as const}];
    const run=(added:boolean,reverse=false)=>{
      const nodes=added?normals:normals.slice(0,-1),links=added?[...original,{...edge('new-support','support','b1'),relationType:'agree' as const}]:original;
      return computeSceneLayout({normals:reverse?[...nodes].reverse():nodes,allMessages:[...nodes,...containers],edges:reverse?[...links].reverse():links,frameBlocks:reverse?[...frames].reverse():frames,colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{}});
    };
    const before=run(false),after=run(true);
    expect(after.frameRects.B.x).toBeGreaterThanOrEqual(after.layout.support.x+after.layout.support.width+COL_GAP);
    for(const [left,right] of [['B','A'],['A','C']])expect(after.frameRects[right].x).toBeGreaterThanOrEqual(after.frameRects[left].x+after.frameRects[left].width+COL_GAP);
    for(const [container,ids] of [['B',['b1','b2']],['A',['a1','a2']],['C',['c1','c2']]] as const){
      expect(after.frameRects[container].x).toBeGreaterThan(before.frameRects[container].x);
      for(const id of ids){
        expect(after.layout[id].x-after.frameRects[container].x).toBe(before.layout[id].x-before.frameRects[container].x);
        expect(after.layout[id].y-after.frameRects[container].y).toBe(before.layout[id].y-before.frameRects[container].y);
      }
    }
    expect(after.layout).toEqual(run(true,true).layout);
  });
  it.each(['row','flow'] as const)('orders citing child classifications inside a saved %s parent while preserving each child layout',display=>{
    const normals=['a1','a2','b1','b2'].map(message);
    const containers=['A','B','outer'].map(id=>({...message(id),kind:'relation' as const,relationType:'classify' as const,
      ...(id==='outer'?{parts:[{id:'display',type:'display' as const,relationPartId:'members',layout:display}]}:{})}));
    const frames=[frame('A',['a1','a2']),frame('B',['b1','b2']),{...frame('outer',[],['A','B']),targetLayout:display==='row'?'single-row' as const:'single-column' as const}];
    for(const availableFrameWidth of [undefined,600]){
      const run=(edges:DemoEdge[])=>computeSceneLayout({normals,allMessages:[...normals,...containers],edges,frameBlocks:frames,availableFrameWidth,colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{}});
      const before=run([]),after=run([{...edge('cross','a1','b1'),relationType:'reference'}]);
      expect(after.frameRects.A.x).toBeGreaterThanOrEqual(after.frameRects.B.x+after.frameRects.B.width+COL_GAP);
      for(const [parent,ids] of [['A',['a1','a2']],['B',['b1','b2']]] as const)for(const id of ids){
        expect(after.layout[id].x-after.frameRects[parent].x).toBe(before.layout[id].x-before.frameRects[parent].x);
        expect(after.layout[id].y-after.frameRects[parent].y).toBe(before.layout[id].y-before.frameRects[parent].y);
      }
    }
  });
  it('uses a secondary citation to shift its source and cascade to existing dependents',()=>{
    const normals=['base','A','C','other-base','middle','B','isolated'].map((id,index)=>({...message(id),createdAt:new Date(index*1000).toISOString()}));
    const ref=(source:string,target:string)=>({...edge(source+'-'+target,source,target),relationType:'reference' as const});
    const original=[ref('A','base'),ref('C','A'),ref('middle','other-base'),ref('B','middle')];
    const run=(links:DemoEdge[])=>computeSceneLayout({normals,allMessages:normals,edges:links,colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{}});
    const extra={...ref('A','B'),id:'zz-new-reference',relationMessageId:'zz-new-reference'};
    const before=run(original),after=run([...original,extra]);
    expect(after.layout.A.x).toBeGreaterThanOrEqual(after.layout.B.x+after.layout.B.width+COL_GAP);
    expect(after.layout.C.x).toBeGreaterThanOrEqual(after.layout.A.x+after.layout.A.width+COL_GAP);
    expect(after.layout.A.x).toBeGreaterThan(before.layout.A.x);expect(after.layout.C.x).toBeGreaterThan(before.layout.C.x);
    expect(after.layout.isolated.x).toBe(before.layout.isolated.x);
  });
  it('stacks cyclic classification constraints in one lane without splitting their members',()=>{
    const normals=['a1','a2','b1','b2'].map(message),containers=['A','B'].map(id=>({...message(id),kind:'relation' as const,relationType:'classify' as const}));
    const links=[{...edge('a-b','a1','b1'),relationType:'reference' as const},{...edge('b-a','b2','a2'),relationType:'reference' as const}];
    const run=(reverse:boolean)=>computeSceneLayout({normals:reverse?[...normals].reverse():normals,allMessages:[...normals,...containers],edges:reverse?[...links].reverse():links,
      frameBlocks:[frame('A',['a1','a2']),frame('B',['b1','b2'])],colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{}});
    const result=run(false);
    expect(result.frameRects.A.x).toBe(result.frameRects.B.x);
    expect(result.frameRects.B.y).toBeGreaterThanOrEqual(result.frameRects.A.y+result.frameRects.A.height+ROW_GAP);
    expect(new Set(result.placementOrder).size).toBe(result.placementOrder.length);
    expect(result.layout).toEqual(run(true).layout);
  });
  it.each((['annotation','archive','recommend','attention','block','tag'] as const).flatMap(type=>[false,true].flatMap(sourced=>[false,true].map(nested=>({type,sourced,nested})))))('lays out a text-bearing $type like a citation (source=$sourced, nested=$nested)',({type,sourced,nested})=>{
    const target=message('target'),source:DemoMessage={...message('source'),createdAt:'2026-10-28',
      ...(!sourced?{kind:'relation' as const,relationType:type}:{}),parts:[{id:'body',type:'text',text:'标注的原因'}]};
    const annotation:DemoMessage={...message('annotation'),kind:'relation',relationType:type};
    const nodes=[target,source,...(sourced?[annotation]:[])],link:DemoEdge={...edge(sourced?'annotation':'source',sourced?'source':'anon:source','target'),relationType:type};
    const scene=projectGraphScene({messages:nodes,edges:[link],isTraceWindow:false,traceExpandedFrameIds:new Set()});
    const run=(links:DemoEdge[])=>computeSceneLayout({normals:scene.normals,allMessages:nodes,edges:links,colOf:scene.pipelineCol,maxCol:scene.pipelineMaxCol,
      measuredHeights:{},measuredWidths:{},frameBlocks:nested?[frame('group',['source','target'])]:[]});
    const actual=run(scene.layoutEdges),citation=run([{...link,relationType:'reference',from:{...link.from,messageId:'source'}}]);
    expect(actual.layout).toEqual(citation.layout);
    expect(actual.layout.source.x).toBeGreaterThan(actual.layout.target.x);
    expect(link.relationType).toBe(type);expect(link.from.messageId).toBe(sourced?'source':'anon:source');
  });
  it('does not turn a bodyless cold-storage annotation into a source card',()=>{
    const annotation:DemoMessage={...message('archive'),kind:'relation',relationType:'archive',content:''};
    const link:DemoEdge={...edge('archive','anon:archive','target'),relationType:'archive'};
    const scene=projectGraphScene({messages:[message('target'),annotation],edges:[link],isTraceWindow:false,traceExpandedFrameIds:new Set()});
    expect(scene.normalIds).toEqual(['target']);expect(scene.layoutEdges[0]).toBe(link);
  });
  it('moves the existing leftmost targets right when a new supporter needs space on their left',()=>{
    const nodes=['target','support','new-support','opposition'].map((id,index)=>({...message(id),createdAt:new Date(index*1000).toISOString()}));
    const links=[{...edge('first-support','support','target'),relationType:'agree' as const},
      {...edge('second-support','new-support','support'),relationType:'agree' as const},edge('objection','opposition','target')];
    for(const ordered of [links,[...links].reverse()]){
      const result=applyAgreeDisagreeColumnOverride({normals:nodes,edges:ordered,col:{target:0,support:0,'new-support':0,opposition:1},maxCol:1});
      expect(result.col['new-support']).toBeGreaterThanOrEqual(0);
      expect(result.col.support).toBeGreaterThan(result.col['new-support']);expect(result.col.target).toBeGreaterThan(result.col.support);
      expect(result.col.opposition).toBeGreaterThan(result.col.target);
    }
    const classification='cmtgyl9ph00zz13qjjl7gqoc0';
    const result=computeSceneLayout({normals:nodes,allMessages:nodes,edges:links,colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{},frameBlocks:[frame(classification,nodes.map(node=>node.id))]});
    expect(result.layout['new-support'].x).toBeGreaterThanOrEqual(result.frameRects[classification].x);
    expect(result.layout.support.x).toBeGreaterThan(result.layout['new-support'].x);expect(result.layout.target.x).toBeGreaterThan(result.layout.support.x);
    expect(result.layout.opposition.x).toBeGreaterThan(result.layout.target.x);
  });
  it.each([false,true])('moves a citing container without reparenting or separating its existing members (nested: %s)',nested=>{
    const texts=['a1','a2','b1','b2','citation'].map((id,index)=>({...message(id),createdAt:new Date(index*1000).toISOString()}));
    const containers=['group-a','group-b','outer'].map(id=>({...message(id),kind:'relation' as const,relationType:'arrange' as const}));
    const ref=(target:string)=>({...edge('cite-'+target,'citation',target),relationType:'reference' as const});
    const run=(added:boolean,reverse=false)=>{
      const normals=added?texts:texts.slice(0,-1),links=added?[ref('a2'),ref('b2')]:[];
      const frames=[frame('group-a',['a1','a2',...(added?['citation']:[])]),frame('group-b',['b1','b2']),...(nested?[frame('outer',[],['group-a','group-b'])]:[])];
      return computeSceneLayout({normals:reverse?[...normals].reverse():normals,allMessages:[...normals,...containers],edges:reverse?[...links].reverse():links,
        frameBlocks:reverse?[...frames].reverse():frames,colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{}});
    };
    const before=run(false),after=run(true);
    expect(after.frameRects['group-a'].x).toBeGreaterThanOrEqual(after.frameRects['group-b'].x+after.frameRects['group-b'].width+COL_GAP);
    for(const [container,ids] of [['group-a',['a1','a2']],['group-b',['b1','b2']]] as const)for(const id of ids){
      expect(after.layout[id].x-after.frameRects[container].x).toBe(before.layout[id].x-before.frameRects[container].x);
      expect(after.layout[id].y-after.frameRects[container].y).toBe(before.layout[id].y-before.frameRects[container].y);
      expect(after.placementOrder.filter(member=>member===id)).toHaveLength(1);
    }
    expect(after.layout).toEqual(run(true,true).layout);
  });
  it('places a citation after its primary target inside a container',()=>{
    const normals=['first','target','citation'].map((id,index)=>({...message(id),createdAt:new Date(index*1000).toISOString()}));
    const result=computeSceneLayout({normals,allMessages:normals,edges:[{...edge('cite','citation','target'),relationType:'reference'}],
      frameBlocks:[frame('group',normals.map(message=>message.id))],colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{}});
    expect(result.layout.citation.y).toBeGreaterThanOrEqual(result.layout.target.y);
  });
  it('aligns an outside citation to the cited member rather than the container header',()=>{
    const normals=['first','target','citation'].map((id,index)=>({...message(id),createdAt:new Date(index*1000).toISOString()}));
    const result=computeSceneLayout({normals,allMessages:normals,edges:[{...edge('cite','citation','target'),relationType:'reference'}],
      frameBlocks:[frame('group',['first','target'])],colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{}});
    expect(result.layout.citation.y).toBeGreaterThanOrEqual(result.layout.target.y);
  });
  it.each([false,true])('preserves the existing reply order when cited later (nested: %s)',nested=>{
    const old='cmv0xqmon00xt78kz0774od10',cited='cmv4rsvps0brfmd14xiwtb0jz',source='b676c94e-82b4-4c45-b32c-f91033e330a6';
    const normals=[{...message(old),author:'b',createdAt:'2026-10-09'},
      {...message(cited),createdAt:'2026-10-12'},{...message(source),createdAt:'2026-10-26'}];
    const edges=[{...edge('cite',source,cited),relationType:'reference' as const},{...edge('reply',cited,old),relationType:'reply' as const}];
    const run=(normals:DemoMessage[],edges:DemoEdge[])=>computeSceneLayout({normals,allMessages:normals,edges,colOf:{},maxCol:0,
      measuredHeights:{[cited]:210},measuredWidths:{},frameBlocks:nested?[frame('group',[old,cited,source])]:[]});
    const result=run(normals,edges),reversed=run([...normals].reverse(),[...edges].reverse());
    const before=run(normals.filter(message=>message.id!==source),edges.filter(edge=>edge.relationType==='reply'));
    expect(result.layout[old].y).toBe(before.layout[old].y);
    expect(result.layout[cited].y).toBe(before.layout[cited].y);
    expect(result.layout).toEqual(reversed.layout);
    expect(result.layout[source].y).toBe(result.layout[cited].y);
  });
  it.each(['row','flow'] as const)('preserves explicit %s member order over relationship constraints',display=>{
    const normals=['old','cited','source'].map(message);
    const organization:DemoMessage={...message('row'),parts:[{id:'display',type:'display',layout:display,relationPartId:'members'}]};
    const result=computeSceneLayout({normals,allMessages:[...normals,organization],colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{},
      frameBlocks:[{...frame('row',['old','cited','source']),targetLayout:display==='row'?'single-row':'single-column'}],
      edges:[{...edge('cite','source','cited'),relationType:'reference'},{...edge('reply','cited','old'),relationType:'reply'}]});
    if(display==='row'){
      expect(result.layout.old.x).toBeLessThan(result.layout.cited.x);
      expect(result.layout.cited.x).toBeLessThan(result.layout.source.x);
      expect(result.layout.old.y).toBe(result.layout.cited.y);
    }else{
      expect(result.layout.old.x).toBe(result.layout.cited.x);expect(result.layout.cited.x).toBe(result.layout.source.x);
      expect(result.layout.old.y).toBeLessThan(result.layout.cited.y);expect(result.layout.cited.y).toBeLessThan(result.layout.source.y);
    }
  });
  it('reserves the measured merge header above members and shrinks when that header becomes shorter', () => {
    const normals = ['a', 'b'].map(message);
    const merge = { ...frame('merge', ['a', 'b']), isMerge: true, hasGroupHeader: false };
    const layout = (height: number) => computeSceneLayout({ normals, allMessages: normals, colOf: {}, maxCol: 0,
      measuredHeights: { merge: height }, measuredWidths: {}, frameBlocks: [merge] });
    const tall = layout(360), short = layout(36);
    expect(tall.layout.a.y).toBeGreaterThanOrEqual(tall.frameRects.merge.y + 8 + 360);
    expect(tall.frameRects.merge.height - short.frameRects.merge.height).toBe(324);
    expect(tall.layout.a.y - short.layout.a.y).toBe(324);
  });

  it('removes covered cards before packing instead of reserving one empty row per hidden message', () => {
    const normals = ['a', 'b', 'c', 'summary'].map(message);
    const result = computeSceneLayout({ normals, allMessages: normals, edges: [], colOf: {}, maxCol: 0,
      measuredHeights: {}, measuredWidths: {}, correctedTargetIds: new Set(['a', 'b', 'c']) });
    expect(Object.keys(result.layout)).toEqual(['summary']);
    expect(result.layout.summary.y).toBe(GRID_TOP);
  });

  it('does not reserve absent columns between visible members of one discussion', () => {
    const normals = ['claim', 'reason'].map(message);
    const result = computeSceneLayout({ normals, allMessages: normals, edges: [edge('stance', 'reason', 'claim')],
      colOf: { claim: 4, reason: 9 }, maxCol: 9, measuredHeights: {}, measuredWidths: {} });
    expect(result.layout.claim.x).toBe(GRID_LEFT);
    expect(result.layout.reason.x).toBe(GRID_LEFT + CARD_W + COL_GAP);
  });

  it('packs an unrelated card into available space instead of waiting for a tall card in another column', () => {
    const normals = ['a-claim', 'b-tall-objection', 'c-independent'].map(message);
    const result = computeSceneLayout({ normals, allMessages: normals, edges: [edge('stance', 'b-tall-objection', 'a-claim')],
      colOf: { 'a-claim': 0, 'b-tall-objection': 1, 'c-independent': 0 }, maxCol: 1,
      measuredHeights: { 'a-claim': 90, 'b-tall-objection': 600 }, measuredWidths: {} });
    expect(result.layout['c-independent'].y).toBe(GRID_TOP + 90 + ROW_GAP);
    expect(result.layout['c-independent'].y).toBeLessThan(result.layout['b-tall-objection'].y + 600);
  });
  it('measures a deeply nested organization once per frame and keeps one member identity', () => {
    const frames = Array.from({ length: 160 }, (_, i) => frame(`f${i}`, i === 159 ? ['content'] : [], i < 159 ? [`f${i + 1}`] : []));
    const normals = [message('content')];
    const result = computeSceneLayout({ normals, allMessages: normals, colOf: { content: 2 }, maxCol: 2, measuredHeights: { content: 180 }, measuredWidths: {}, frameBlocks: frames });
    expect(result.measuredFrames).toBe(160);
    expect(Object.keys(result.layout)).toEqual(['content']);
    expect(Object.keys(result.frameRects)).toHaveLength(160);
    const inner = result.frameRects.f159;
    expect(result.layout.content.y).toBeGreaterThan(inner.y);
    expect(result.layout.content.y + 180).toBeLessThanOrEqual(inner.y + inner.height);
    expect(frames[0].directCardIds.size).toBe(0);
  });

  it('measures a wide nested row before positioning external annotations', () => {
    const normals = ['a', 'b', 'note'].map(message);
    const row = { ...frame('row', ['a', 'b']), targetLayout: 'single-row' as const };
    const note = { ...edge('annotation', 'note', 'row'), relationType: 'annotation' as const };
    const result = computeSceneLayout({ normals, allMessages: normals, colOf: { a: 0, b: 0, note: 1 }, maxCol: 1, measuredHeights: {}, measuredWidths: {}, frameBlocks: [row], edges: [note] });
    expect(result.measuredFrames).toBe(1);
    expect(result.layout.note.x).toBeGreaterThan(result.frameRects.row.x + result.frameRects.row.width);
    expect(result.layout.a.y).toBe(result.layout.b.y);
  });

  it('does not recursively duplicate nodes when malformed organizations contain a cycle', () => {
    const normals = [message('a'), message('b')];
    const result = computeSceneLayout({ normals, allMessages: normals, colOf: {}, maxCol: 0, measuredHeights: {}, measuredWidths: {}, frameBlocks: [frame('one', ['a'], ['two']), frame('two', ['b'], ['one'])] });
    expect(result.measuredFrames).toBe(2);
    expect(Object.keys(result.layout).sort()).toEqual(['a', 'b']);
    expect(Number.isFinite(result.canvasHeight)).toBe(true);
  });

  it('keeps unrelated questions in separate discussion bands while aligning each stance to its own target', () => {
    const normals = ['question-a', 'question-b', 'support-a', 'support-b'].map(message);
    const links = [edge('stance-a', 'support-a', 'question-a'), edge('stance-b', 'support-b', 'question-b')];
    const result = computeSceneLayout({ normals, allMessages: normals, edges: links,
      colOf: { 'question-a': 1, 'question-b': 1, 'support-a': 0, 'support-b': 0 }, maxCol: 1,
      measuredHeights: { 'support-a': 300 }, measuredWidths: {},
    });
    expect(result.layout['support-a'].y).toBe(result.layout['question-a'].y);
    expect(result.layout['support-b'].y).toBe(result.layout['question-b'].y);
    expect(result.layout['question-b'].y).toBeGreaterThan(result.layout['support-a'].y + 300);
  });

  it('does not infer organization nesting from overlapping target sets for part-based messages', () => {
    const nodes = ['a', 'b', 'c', 'small', 'large'].map(id => ({ ...message(id), parts: [{ id: 'content', type: 'text' as const, text: id }] }));
    const links = [edge('small', 'anon:small', 'a'), edge('small', 'anon:small', 'b'), edge('large', 'anon:large', 'a'), edge('large', 'anon:large', 'b'), edge('large', 'anon:large', 'c')].map(link => ({ ...link, relationType: 'arrange' as const }));
    const result = buildFrameBlocks({ edges: links, visibleCardIds: new Set(nodes.map(node => node.id)), msgMap: new Map(nodes.map(node => [node.id, node])) });
    expect(result.every(block => block.childRelMsgIds.length === 0)).toBe(true);
  });

  it('does not turn a newly added relation type into an organization', () => {
    const nodes: DemoMessage[] = [message('claim'), { ...message('proof'), parts: [{ id: 'evidence', type: 'relation', relation: 'evidence', roles: { target: [{ id: 'claim', reference: { messageId: 'claim' } }] } }] }];
    const links = [{ ...edge('proof', 'anon:proof', 'claim'), relationType: 'evidence' as DemoEdge['relationType'] }];
    expect(buildFrameBlocks({ edges: links, visibleCardIds: new Set(nodes.map(node => node.id)), msgMap: new Map(nodes.map(node => [node.id, node])) })).toEqual([]);
  });
});

describe('execution-based stance placement', () => {
  it('does not paint a fragment annotation onto another part or a changed historical revision', () => {
    const links: DemoEdge[] = ['title', 'reason'].map(partId => ({
      ...edge(partId, 'citation', 'claim'), relationType: 'reference',
      to: { messageId: 'claim', reference: { messageId: 'claim', revision: 2, partId, range: { start: 0, end: 3 } }, selection: { kind: 'text', start: 0, len: 3, text: '相同字' } },
    }));
    expect(extractTextTargetsForMessage('claim', links, 'reason', 2).map(target => target.edgeId)).toEqual(['reason']);
    expect(extractTextTargetsForMessage('claim', links, 'reason', 3)).toEqual([]);
  });

  it('puts opposition to a stance on the original support side while preserving the selected reference chain', () => {
    const original = edge('double', 'reason', 'objection');
    const nodes: DemoMessage[] = [{ ...message('double'), kind: 'relation', executedStance: { partId: 'stance', sourceRevision: 1, target: { messageId: 'claim', revision: 1 }, side: 'pro' } }];
    const result = projectStanceLayoutEdges(nodes, [original]);
    expect(result[0].relationType).toBe('agree');
    expect(result[0].to.reference).toEqual({ messageId: 'claim', revision: 1 });
    expect(original.to.messageId).toBe('objection');
  });

  it('keeps an objection to the reason on its exact content part despite newer message edits', () => {
    const original = edge('reason-objection', 'evidence', 'objection');
    const target = { messageId: 'objection', revision: 1, partId: 'reason', range: { start: 0, end: 5 } };
    const nodes: DemoMessage[] = [{ ...message('reason-objection'), revision: 3, executedStance: { partId: 'stance', sourceRevision: 1, target, side: 'con' } }];
    const result = projectStanceLayoutEdges(nodes, [original]);
    expect(result[0].relationType).toBe('disagree');
    expect(result[0].to.reference).toEqual(target);
  });

  it('gives a relation with its own content a real layout source without inventing a text message', () => {
    const original = edge('stance', 'anon:stance', 'claim');
    const nodes: DemoMessage[] = [{ ...message('stance'), parts: [{ id: 'reason', type: 'text', text: '依据' }], executedStance: { partId: 'stance', sourceRevision: 1, target: { messageId: 'claim' }, side: 'pro' } }];
    expect(projectStanceLayoutEdges(nodes, [original])[0].from.messageId).toBe('stance');
    expect(original.from.messageId).toBe('anon:stance');
  });
});
