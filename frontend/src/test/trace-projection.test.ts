import { describe, expect, it } from 'vitest';
import { applyTraceFrameVisibility, buildTraceProjection } from '../utils/traceProjection';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';
import { convertMessagesToDemoModel, type DemoEdge, type DemoMessage } from '../utils/modelBridge';
import type { Relation } from '../types';

const message = (id: string, relationType?: DemoMessage['relationType']): DemoMessage => ({
  id, kind: relationType ? 'relation' : 'normal', relationType, content: id, author: 'tester', createdAt: '',
});
const edge = (owner: string, type: DemoEdge['relationType'], target: string, source = `anon:${owner}`): DemoEdge => ({
  id: `${owner}:${target}`, relationMessageId: owner, relationType: type, relationLabel: type,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } },
});

describe('trace boundaries', () => {
  it('recomputes both increasing and decreasing distances from the members of a single expanded classification',()=>{
    const messages=[message('group','classify'),...['member','peer','up-1','up-2','down-1','down-2'].map(id=>message(id)),
      ...['ref-up-1','ref-up-2','ref-down-1','ref-down-2'].map(id=>message(id,'reference'))];
    const edges=[edge('group','classify','member'),edge('group','classify','peer'),
      edge('ref-up-1','reference','up-1','member'),edge('ref-up-2','reference','up-2','up-1'),
      edge('ref-down-1','reference','member','down-1'),edge('ref-down-2','reference','down-1','down-2')];
    for(const side of ['up','down'] as const)for(const distance of [0,2,1,0,1]){
      const depths={up:0,down:0,[side]:distance};
      const projection=buildTraceProjection({messages,edges,startIds:['group'],distance,depths,expandedContainerIds:new Set(['group'])});
      const ids=new Set(applyTraceFrameVisibility(projection,new Set(['group'])).messages.map(message=>message.id));
      expect(ids.has('member')).toBe(true);expect(ids.has('peer')).toBe(true);
      for(const direction of ['up','down'])for(const depth of [1,2])expect(ids.has(`${direction}-${depth}`)).toBe(direction===side&&depth<=distance);
      expect(projection.semanticMessageIds).toContain('member');expect(projection.semanticMessageIds).toContain('peer');
    }
  });
  it('seeds inline members of the selected classification without using a nested classification as a shortcut',()=>{
    const messages=[message('group','classify'),message('row','arrange'),message('nested','classify'),message('member'),message('hidden'),message('before'),message('ref','reference')];
    const edges=[edge('group','classify','row'),edge('group','classify','nested'),edge('row','arrange','member'),edge('nested','classify','hidden'),edge('ref','reference','before','member')];
    const projection=buildTraceProjection({messages,edges,startIds:['group'],distance:1,depths:{up:1,down:0},expandedContainerIds:new Set(['group'])});
    expect(projection.semanticMessageIds).toContain('member');expect(projection.semanticMessageIds).toContain('before');
    expect(projection.semanticMessageIds).not.toContain('hidden');
    const bodyTrace=buildTraceProjection({messages,edges,startIds:['member'],distance:0,expandedContainerIds:new Set(['group'])});
    expect(bodyTrace.semanticMessageIds).toEqual(new Set(['member']));
    expect(bodyTrace.messages.map(message=>message.id)).not.toContain('hidden');
  });
  it.each(['classify','summary','merge'] as const)('keeps %s as context without reaching unrelated members through JOIN history',type=>{
    const messages=[message('group',type),message('anchor'),message('related'),message('unrelated'),{...message('join'),kind:'join' as const},message('reference','reference'),message('container-reference','reference')];
    const edges=[edge('group',type,'anchor'),edge('group',type,'unrelated'),edge('join','reference','anchor'),edge('join','reference','unrelated'),
      edge('reference','reference','related','anchor'),edge('container-reference','reference','group','anchor')];
    const trace=buildTraceProjection({messages,edges,startIds:['anchor'],distance:3,expandedContainerIds:new Set(['group'])});
    expect(trace.messages.map(message=>message.id)).toEqual(expect.arrayContaining(['anchor','related','group']));
    expect(trace.messages.map(message=>message.id)).not.toContain('unrelated');
    expect(trace.semanticMessageIds).not.toContain('unrelated');expect(trace.semanticMessageIds).not.toContain('join');
    const expanded=applyTraceFrameVisibility(trace,new Set(['group']));
    expect(expanded.messages.map(message=>message.id)).not.toContain('unrelated');
  });
  it('reaches current arrangement peers in one hop without using JOIN history to reach other messages',()=>{
    const messages=[message('group','arrange'),message('anchor'),message('peer'),message('outsider'),{...message('join'),kind:'join' as const}];
    const edges=[edge('group','arrange','anchor'),edge('group','arrange','peer'),edge('join','reference','anchor'),edge('join','reference','outsider')];
    for(const distance of [0,1]){
      const trace=buildTraceProjection({messages,edges,startIds:['anchor'],distance});
      expect(trace.semanticMessageIds?.has('peer')).toBe(distance===1);
      expect(trace.messages.some(item=>item.id==='peer')).toBe(distance===1);
      expect(trace.semanticMessageIds).not.toContain('outsider');expect(trace.semanticMessageIds).not.toContain('join');
    }
  });
  it('uses effective arrangement membership when no display edges are available',()=>{
    const messages=[message('group','arrange'),message('anchor'),message('peer')];
    const input={messages,edges:[],containerMemberships:[{containerId:'group',relationType:'arrange' as const,targetIds:['anchor','peer']}],startIds:['anchor'],distance:1};
    expect(buildTraceProjection(input).distanceMessageIds).toContain('peer');
    const excluded=buildTraceProjection({...input,excludedRelationIds:new Set(['group'])});
    expect(excluded.messages.map(message=>message.id)).toEqual(['anchor']);
  });
  it('shows a referenced arrangement at the boundary and reaches its members on the next hop',()=>{
    const messages=[message('group','arrange'),message('anchor'),message('peer'),message('reference','reference')];
    const edges=[edge('group','arrange','peer'),edge('reference','reference','group','anchor')];
    const one=buildTraceProjection({messages,edges,startIds:['anchor'],distance:1,depths:{up:1,down:0}});
    expect(one.messages.map(message=>message.id)).toEqual(expect.arrayContaining(['anchor','group','reference']));
    expect(one.messages.map(message=>message.id)).not.toContain('peer');
    const two=buildTraceProjection({messages,edges,startIds:['anchor'],distance:2,depths:{up:2,down:0}});
    expect(two.distanceMessageIds).toContain('peer');
  });
  it('traverses from deliberately opened classification members without spending a hop on membership',()=>{
    const messages=[message('group','classify'),message('member'),message('unrelated-reference-target'),message('reference','reference')];
    const edges=[edge('group','classify','member'),edge('reference','reference','unrelated-reference-target','member')];
    const trace=buildTraceProjection({messages,edges,startIds:['group'],distance:5,expandedContainerIds:new Set(['group'])});
    expect(trace.messages.map(message=>message.id)).toContain('member');expect(trace.semanticMessageIds).toContain('member');
    expect(trace.distanceMessageIds).toContain('unrelated-reference-target');
  });
  it('keeps both enclosing classifications around a cross-classification reference without adding their siblings', () => {
    const messages = [message('outer', 'classify'), message('left', 'classify'), message('right', 'classify'),
      message('source'), message('target'), message('sibling'), message('ref', 'reference')];
    const edges = [edge('outer', 'classify', 'left'), edge('left', 'classify', 'source'),
      edge('left', 'classify', 'sibling'), edge('right', 'classify', 'target'), edge('ref', 'reference', 'target', 'source')];
    const trace = buildTraceProjection({messages, edges, startIds:['ref'], distance:1});
    expect(new Set(trace.messages.map(message => message.id))).toEqual(new Set(['outer','left','right','source','target','ref']));
    expect(trace.edges.some(edge => edge.to.messageId === 'sibling')).toBe(false);
  });

  it('does not discard a valid multi-target relationship because one endpoint is hidden in a collapsed container', () => {
    const messages = [message('container', 'classify'), message('hidden'), message('visible'), message('source'), message('ref', 'reference')];
    const edges = [edge('container', 'classify', 'hidden'), edge('ref', 'reference', 'hidden', 'source'), edge('ref', 'reference', 'visible', 'source')];
    const trace = buildTraceProjection({messages, edges, startIds:['source'], distance:2});
    const visible = applyTraceFrameVisibility(trace, new Set());
    expect(visible.messages.map(message => message.id)).toContain('ref');
    expect(visible.edges.some(edge => edge.relationMessageId === 'ref' && edge.to.messageId === 'visible')).toBe(true);
  });
  it('reaches an arrangement peer one hop after its referenced member without importing classification siblings', () => {
    const messages = [message('A', 'classify'), message('B', 'classify'), message('C', 'arrange'),
      message('D'), message('E'), message('F'), message('unrelated'), message('ref', 'reference')];
    const edges = [edge('A', 'classify', 'B'), edge('B', 'classify', 'E'), edge('B', 'classify', 'C'),
      edge('B','classify','unrelated'),edge('C', 'arrange', 'D'), edge('C', 'arrange', 'F'), edge('ref', 'reference', 'D', 'E')];
    for (const distance of [1, 2]) {
      const trace = buildTraceProjection({ messages, edges, startIds: ['E'], distance });
      expect(trace.messages.some(item => item.id === 'F')).toBe(distance===2);
      const expanded = applyTraceFrameVisibility(trace, new Set(['A', 'B']));
      expect(expanded.messages.some(item => item.id === 'F')).toBe(distance===2);
      expect(expanded.messages.some(item => item.id === 'D')).toBe(true);
      expect(expanded.edges.some(item => item.relationMessageId === 'C' && item.to.messageId === 'F')).toBe(distance===2);
      expect(trace.semanticMessageIds).not.toContain('unrelated');
    }
  });

  it.each(['merge', 'arrange'] as const)('counts %s membership according to its trace semantics', type => {
    const messages = [message('anchor'), message('near'), message('far'), message('ref', 'reference'), message('group', type)];
    const edges = [edge('ref', 'reference', 'near', 'anchor'), edge('group', type, 'near'), edge('group', type, 'far')];
    const one = buildTraceProjection({ messages, edges, startIds: ['anchor'], distance: 1 });
    expect(one.messages.map(item => item.id)).not.toContain('far');
    const two = buildTraceProjection({ messages, edges, startIds: ['anchor'], distance: 2 });
    expect(two.messages.some(item => item.id==='far')).toBe(type==='arrange');
  });

  it.each(['summary', 'merge', 'arrange'] as const)('keeps expanded grandchildren behind a collapsed ancestor through %s regardless of record order', type => {
    const messages = [message('outer', 'classify'), message('middle', type), message('inner', 'classify'), message('leaf')];
    const edges = [edge('outer', 'classify', 'middle'), edge('middle', type, 'inner'), edge('inner', 'classify', 'leaf')];
    for (const ordered of [messages, [...messages].reverse()]) {
      const trace = buildTraceProjection({ messages: ordered, edges, startIds: ['leaf'], distance: 3 });
      const collapsed = applyTraceFrameVisibility(trace, new Set(['inner']));
      expect(collapsed.messages.map(item => item.id)).toEqual(['outer']);
      const expanded = applyTraceFrameVisibility(trace, new Set(['outer', 'middle', 'inner']));
      expect(new Set(expanded.messages.map(item => item.id))).toEqual(new Set(messages.map(item => item.id)));
    }
  });

  it.each(['CLASSIFY','SUMMARY','MERGE','ARRANGE'])('uses only current %s members after a member moves to another classification', type => {
    const user = { id: 'tester', username: 'tester', createdAt: '' };
    const relation = (id: string, type: string, targets: string[], source: string | null = null, createdAt = '2026-01-01'): Relation => ({
      id, relationType: type, sourceMessageId: source, targetRefs: targets.map(messageId => ({ kind: 'message', messageId })),
      createdAt, createdBy: user,
    });
    const relations = [relation('old', type, []), relation('current', 'CLASSIFY', []),
      relation('old-join', 'JOIN', ['moved', 'stayed','peer'], 'old'), relation('new-join', 'JOIN', ['moved'], 'current', '2026-01-02')];
    const model = convertMessagesToDemoModel(['moved', 'stayed','peer'].map(id => ({
      id, kind: 'TEXT', content: id, contentType: 'TEXT', createdAt: '', createdBy: user,
    })), relations);
    const effect = deriveContainerEffect({ ...model, relations, username: 'tester' });
    const trace = buildTraceProjection({ messages: effect.messages, edges: effect.edges, containerMemberships: effect.memberships,
      startIds: ['stayed'], distance: 1 });
    expect(trace.messages.map(item => item.id)).not.toContain('moved');
    expect(trace.messages.map(item => item.id)).toContain('stayed');
    expect(trace.semanticMessageIds?.has('peer')).toBe(type==='ARRANGE');
  });
});
