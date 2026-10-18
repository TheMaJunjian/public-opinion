import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import { projectGraphScene } from '../utils/graphProjection';
import { withCorrectionContent, type DemoEdge, type DemoMessage } from '../utils/modelBridge';
import MessageCard from '../components/MessageCard';
import { GRID_TOP } from '../utils/layout';
import type { Relation } from '../types';

const message = (id: string): DemoMessage => ({ id, author: 'tester', content: id, kind: 'normal', createdAt: '2026-01-01T00:00:00Z' });
const relation = (id: string, type: DemoEdge['relationType'], source: string, target: string): DemoEdge => ({
  id, relationMessageId: id, relationType: type, relationLabel: type,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } },
});
function renderScene(messages: DemoMessage[], edges: DemoEdge[],extra:Partial<GraphViewProps>={}) {
  const props: GraphViewProps = {
    messages, edges, draftUnits: [], activeTextSelectId: null, lastClickedMessageId: null, voteStats: {},
    onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(), onTextMouseUp: vi.fn(),
    onEdgeLabelSingleClick: vi.fn(), onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(),
    isFragmentSelected: () => false,
  };
  return render(<GraphView {...props} {...extra} />);
}

describe('rendered graph scene', () => {
  it('renders corrected part text in both graph and list cards while retaining the original stored text',()=>{
    const original:DemoMessage={...message('corrected-target'),content:'好玩吗？',parts:[{id:'body',type:'text',text:'好玩吗？'}]};
    const corrected=withCorrectionContent(original,'好玩1111');
    const graph=renderScene([corrected],[]);
    expect(graph.container.querySelector('[data-msgid="corrected-target"]')).toHaveTextContent('好玩1111');
    expect(graph.container).not.toHaveTextContent('好玩吗？');graph.unmount();
    const list=render(<MessageCard msg={corrected} ctx={{}}/>);
    expect(list.container).toHaveTextContent('好玩1111');expect(list.container).not.toHaveTextContent('好玩吗？');
    expect(original.parts![0]).toEqual({id:'body',type:'text',text:'好玩吗？'});
  });
  it.each(['classify','summary','merge','arrange'] as const)('opens both JOIN directions on a nested %s without selecting the container',type=>{
    const group:DemoMessage={...message('group'),kind:'relation',relationType:type,relationPayload:{title:'容器'}};
    const join=(id:string,source:string,target:string):Relation=>({id,relationType:'JOIN',sourceMessageId:source,targetRefs:[{kind:'message',messageId:target}],createdAt:'2026-01-01',createdBy:{id:'u',username:'tester',createdAt:''}});
    const incoming=[join('current','outer','group'),join('historical','old','group')],outgoing=[join('member','group','leaf')];
    const open=vi.fn(),select=vi.fn(),navigate=vi.fn();
    const view=renderScene([group,message('leaf')],[relation('group',type,'anon:group','leaf')],{
      joinRelationsByTarget:new Map([['group',incoming]]),joinRelationsBySource:new Map([['group',outgoing]]),
      joinStatusByMessage:new Map([['current','valid'],['historical','superseded'],['member','valid']]),
      onJoinFilterClick:open,onMessageClick:select,onMessageDoubleClick:navigate,
    });
    const memberBadge=view.getByRole('button',{name:'查看加入消息（2条）'}),containerBadge=view.getByRole('button',{name:'查看被加入消息（1条）'});
    expect(memberBadge.title).toContain('2 条，1 条生效');
    fireEvent.mouseDown(memberBadge);fireEvent.click(memberBadge);fireEvent.mouseUp(memberBadge);
    expect(open).toHaveBeenLastCalledWith('group','incoming');
    fireEvent.click(containerBadge);expect(open).toHaveBeenLastCalledWith('group','outgoing');
    fireEvent.doubleClick(containerBadge);expect(select).not.toHaveBeenCalled();expect(navigate).not.toHaveBeenCalled();
  });
  it('does not invent a frame for each filtered settlement edge or steal members from a real arrangement',()=>{
    const arrange:DemoMessage={...message('arrange'),kind:'relation',relationType:'arrange',relationPayload:{targetLayout:'single-row'}};
    const edges=[...Array.from({length:100},(_,i)=>relation(`round-${i}`,'round' as DemoEdge['relationType'],`anon:round-${i}`,'one')),relation('arrange','arrange','anon:arrange','one'),relation('arrange','arrange','anon:arrange','two')];
    const {container}=renderScene([message('one'),message('two'),arrange],edges);
    const first=container.querySelector('[data-msgid="one"]') as HTMLElement,second=container.querySelector('[data-msgid="two"]') as HTMLElement;
    expect(parseFloat(first.style.top)).toBeLessThan(100);
    expect(first.style.top).toBe(second.style.top);
    expect(parseFloat(first.style.left)).toBeLessThan(parseFloat(second.style.left));
  });
  it('keeps an opaque classification as a real card inside its arrangement instead of an omitted child frame',()=>{
    const category:DemoMessage={...message('category'),kind:'relation',relationType:'classify'};
    const arrange:DemoMessage={...message('arrange'),kind:'relation',relationType:'arrange'};
    const edges=[relation('arrange','arrange','anon:arrange','category'),relation('category','classify','anon:category','hidden-member')];
    const scene=projectGraphScene({messages:[category,arrange],edges,isTraceWindow:false,traceExpandedFrameIds:new Set()});
    expect(scene.frameBlocks.map(frame=>frame.relMsgId)).toEqual(['arrange']);
    expect(scene.frameBlocks[0].directCardIds).toEqual(new Set(['category']));
    expect(scene.frameBlocks[0].childRelMsgIds).toEqual([]);
  });
  it('packs visible content without reserving an invisible frame around another hidden frame',()=>{
    const hiddenFrame:DemoMessage={...message('inner'),kind:'relation',relationType:'arrange'};
    const outer:DemoMessage={...message('outer'),kind:'relation',relationType:'arrange'};
    const {container}=renderScene([outer,hiddenFrame,message('visible')],[relation('outer','arrange','anon:outer','inner'),relation('inner','arrange','anon:inner','absent')]);
    expect((container.querySelector('[data-msgid="visible"]') as HTMLElement).style.top).toBe(`${GRID_TOP}px`);
  });
  it('removes explicitly hidden cards before packing, including their old measured space',()=>{
    const {container}=renderScene([message('hidden'),message('visible')],[],{hideMessageIds:new Set(['hidden'])});
    expect(container.querySelector('[data-msgid="hidden"]')).toBeNull();
    expect((container.querySelector('[data-msgid="visible"]') as HTMLElement).style.top).toBe(`${GRID_TOP}px`);
  });
  it('renders a correction on its target instead of making its legacy description a separate card',()=>{
    const correction:DemoMessage={...message('correction'),kind:'relation',relationType:'correct',parts:[{id:'body',type:'text',text:'建立关系：CORRECT'},{id:'data',type:'data',value:{kind:'RELATION',legacyTopicId:'topic'}}]};
    const {container}=renderScene([message('target'),correction],[relation('correction','correct','anon:correction','target')]);
    expect(container.querySelector('[data-msgid="correction"]:not([data-rel-overlay])')).toBeNull();
    expect(container.querySelector('[data-msgid="target"]')).not.toBeNull();
    expect(container.textContent).toContain('更正');
  });
  it('starts a summary at the first visible row and renders no covered-card whitespace', () => {
    const summary: DemoMessage = { ...message('summary'), kind: 'relation', relationType: 'summary', content: '讨论总结' };
    const messages = [message('old-a'), message('old-b'), summary];
    const edges = [relation('summary', 'summary', 'anon:summary', 'old-a'), relation('summary', 'summary', 'anon:summary', 'old-b')];
    const { container } = renderScene(messages, edges);
    expect(container.querySelector('[data-msgid="old-a"]')).toBeNull();
    expect(container.querySelector('[data-msgid="old-b"]')).toBeNull();
    expect((container.querySelector('[data-msgid="summary"]') as HTMLElement).style.top).toBe(`${GRID_TOP}px`);
  });

  it('keeps opposition on the right, agreement on the left, and routes the rendered relation arrows', () => {
    const messages = [message('claim'), message('support'), message('objection')];
    const edges = [relation('agree', 'agree', 'support', 'claim'), relation('disagree', 'disagree', 'objection', 'claim')];
    const { container } = renderScene(messages, edges);
    const left = (id: string) => parseFloat((container.querySelector(`[data-msgid="${id}"]`) as HTMLElement).style.left);
    expect(left('support')).toBeLessThan(left('claim'));
    expect(left('objection')).toBeGreaterThan(left('claim'));
    expect(container.querySelectorAll('svg path').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps trace members addressable while an ordinary summary hides them', () => {
    const messages: DemoMessage[] = [message('claim'), { ...message('summary'), kind: 'relation', relationType: 'summary' }];
    const edges = [relation('summary', 'summary', 'anon:summary', 'claim')];
    const collapsed = projectGraphScene({ messages, edges, isTraceWindow: false, traceExpandedFrameIds: new Set() });
    const expanded = projectGraphScene({ messages, edges, isTraceWindow: true, traceExpandedFrameIds: new Set(['summary']) });
    expect(collapsed.normalIds).toEqual(['summary']);
    expect(expanded.normalIds).toEqual(['claim']);
    expect(expanded.frameBlocks[0].directCardIds.has('claim')).toBe(true);
  });

  it('keeps a reason-bearing objection on the right when newer objections precede older support in the snapshot', () => {
    const objection: DemoMessage = {
      ...message('objection'), kind: 'relation', relationType: 'disagree',
      parts: [{ id: 'body', type: 'text', text: '先核实运营成本。' }],
      executedStance: { partId: 'stance', sourceRevision: 1, target: { messageId: 'claim' }, side: 'con' },
    };
    const messages = [message('claim'), message('support'), objection];
    const edges = [relation('objection', 'disagree', 'anon:objection', 'claim'), relation('agree', 'agree', 'support', 'claim')];
    const projection = projectGraphScene({ messages, edges, isTraceWindow: false, traceExpandedFrameIds: new Set() });
    expect(projection.pipelineCol.objection).toBeGreaterThan(projection.pipelineCol.claim);
    expect(projection.pipelineCol.support).toBeLessThan(projection.pipelineCol.claim);
  });
});

it('does not promote relationship descriptions or frame titles to independent cards',()=>{
  const claim=message('claim');
  const vote:DemoMessage={...message('vote'),kind:'relation',relationType:'agree',parts:[{id:'body',type:'text',text:'建立关系：AGREE；目标：claim'},{id:'data',type:'data',value:{kind:'RELATION',legacyTopicId:'topic'}}],executedStance:{partId:'relation',sourceRevision:1,side:'pro',target:{messageId:'claim'}}};
  const arrange:DemoMessage={...message('arrange'),kind:'relation',relationType:'arrange',parts:[{id:'body',type:'text',text:'排列说明'},{id:'display',type:'display',relationPartId:'relation',layout:'row'}]};
  const messages=[claim,vote,arrange];
  const edges=[relation('vote','agree','anon:vote','claim'),relation('arrange','arrange','anon:arrange','claim')];
  const projected=projectGraphScene({messages,edges,isTraceWindow:false,traceExpandedFrameIds:new Set()});
  expect(projected.normalIds).toEqual(['claim']);
  expect(projected.frameBlocks[0].targetLayout).toBe('single-row');
});

it('keeps current component votes attached rather than creating another card',()=>{
  const claim={...message('claim'),revision:1};
  const vote:DemoMessage={...message('vote'),kind:'relation',relationType:'disagree',parts:[],executedStance:{partId:'stance',sourceRevision:1,side:'con',target:{messageId:'claim',revision:1,partId:'body'}}};
  const input={messages:[claim,vote],edges:[relation('vote','disagree','anon:vote','claim')],isTraceWindow:false,traceExpandedFrameIds:new Set<string>()};
  expect(projectGraphScene(input).normalIds).toEqual(['claim']);
});

it('uses display parts to retain horizontal and vertical frame geometry',()=>{
  for(const [layout,direction] of [['row','single-row'],['flow','single-column']] as const){
    const arrange:DemoMessage={...message('arrange'),kind:'relation',relationType:'arrange',parts:[{id:'display',type:'display',relationPartId:'relation',layout}]};
    const projected=projectGraphScene({messages:[message('a'),message('b'),arrange],edges:[relation('arrange','arrange','anon:arrange','a'),relation('arrange','arrange','anon:arrange','b')],isTraceWindow:false,traceExpandedFrameIds:new Set()});
    expect(projected.frameBlocks[0].targetLayout).toBe(direction);
    const {container,unmount}=renderScene([message('a'),message('b'),arrange],[relation('arrange','arrange','anon:arrange','b'),relation('arrange','arrange','anon:arrange','a')]);
    const a=container.querySelector('[data-msgid="a"]') as HTMLElement,b=container.querySelector('[data-msgid="b"]') as HTMLElement;
    if(layout==='row'){expect(a.style.top).toBe(b.style.top);expect(parseFloat(b.style.left)).toBeLessThan(parseFloat(a.style.left));}else{expect(a.style.left).toBe(b.style.left);expect(parseFloat(b.style.top)).toBeLessThan(parseFloat(a.style.top));}
    unmount();
  }
});

it('shows a rejected container as a related part instead of a separate card, while retaining explicit inspection',()=>{
 const claim=message('claim'),container:DemoMessage={...message('category'),kind:'relation',relationType:'classify',targetRefs:[{kind:'message',messageId:'claim'}],state:{messageId:'category',revision:1,suppressed:true,supportCount:0,oppositionCount:1,recommendationTotal:0}};
 const input={messages:[claim,container],edges:[relation('category','classify','anon:category','claim')],isTraceWindow:false,traceExpandedFrameIds:new Set<string>()};
 expect(projectGraphScene(input).normalIds).toEqual(['claim']);
 expect(projectGraphScene({...input,standaloneMessageIds:new Set(['category'])}).normalIds).toEqual(['claim','category']);
 const {container:dom,getByText}=renderScene(input.messages,input.edges);
 expect(dom.querySelector('[data-msgid="category"]')).toBeNull();
 expect(dom.querySelector('[data-related-message-id="category"]')).toBeNull();
 fireEvent.click(getByText('▸ 被反对的容器：1'));
 expect(dom.querySelector('[data-related-message-id="category"]')).toBeTruthy();
 const inspected=renderScene(input.messages,[],{standaloneMessageIds:new Set(['category'])});
 expect(inspected.container.querySelector('[data-msgid="category"]')?.textContent).toContain('1 条观点');
});

it('allows inspecting a personally rejected merge even when its global state is not suppressed',()=>{
 const claim=message('claim'),group:DemoMessage={...message('merge'),kind:'relation',relationType:'merge',parts:[]};
 const input={messages:[claim,group],edges:[],isTraceWindow:false,traceExpandedFrameIds:new Set<string>(),rejectedContainerIds:new Set(['merge'])};
 expect(projectGraphScene(input).normalIds).toEqual(['claim']);
 expect(projectGraphScene({...input,standaloneMessageIds:new Set(['merge'])}).normalIds).toEqual(['claim','merge']);
});

it('renders each comparison with its own rejection state instead of the original view state',()=>{
  const leaf=message('leaf'),rejected:DemoMessage={...message('C'),kind:'relation',relationType:'classify',targetRefs:[{kind:'message',messageId:'leaf'}],state:{messageId:'C',revision:1,suppressed:true,supportCount:0,oppositionCount:1,recommendationTotal:0}},approved={...rejected,state:{...rejected.state!,suppressed:false}};
  const {container:dom}=renderScene([rejected,leaf],[],{
    comparisonPair:true,rejectedContainerIds:new Set(['C']),hideMessageIds:new Set(['C']),
    comparisonAgreeMessages:[approved],comparisonAgreeEdges:[relation('C','classify','anon:C','leaf')],comparisonAgreeSuppressedRelIds:new Set(),
    comparisonDisagreeMessages:[leaf],comparisonDisagreeEdges:[],comparisonDisagreeSuppressedRelIds:new Set(['C']),
    comparisonAgreeContext:{relatedMessages:[approved,leaf],rejectedContainerIds:new Set()},
    comparisonDisagreeContext:{relatedMessages:[rejected,leaf],rejectedContainerIds:new Set(['C'])},
  });
  const agree=dom.querySelector('[data-comparison-view="agree"]')!,disagree=dom.querySelector('[data-comparison-view="disagree"]')!;
  expect(agree.querySelector('[data-msgid="C"]')).toBeTruthy();expect(agree.querySelector('[data-msgid="leaf"]')).toBeNull();
  expect(disagree.querySelector('[data-msgid="C"]')).toBeNull();expect(disagree.querySelector('[data-msgid="leaf"]')).toBeTruthy();
  expect(agree.querySelector('[data-related-rejected-containers]')).toBeNull();
  expect(disagree.querySelector('[data-related-rejected-containers]')).toBeTruthy();
});

it('uses the same agree frame and header for single-side viewing and pair comparison',()=>{
  const leaveScope=vi.fn();
  const scopeHeader=<section data-testid="scope-header">分类 A<button onClick={leaveScope}>退出分类</button></section>;
  const pair=renderScene([message('leaf')],[],{comparisonPair:true,comparisonScopeHeader:scopeHeader});
  const agree=pair.container.querySelector('[data-comparison-view="agree"]') as HTMLElement;
  const frameStyle=agree.style.cssText,headerStyle=(agree.firstElementChild as HTMLElement).style.cssText;
  expect(agree.querySelector('[data-testid="scope-header"]')).not.toBeNull();
  expect(pair.container.querySelector('[data-comparison-view="disagree"] [data-testid="scope-header"]')).not.toBeNull();
  expect(agree.querySelector('[data-testid="scope-header"]')?.parentElement).toBe(agree);
  expect(pair.container.querySelectorAll('[data-comparison-view="agree"]')).toHaveLength(1);
  pair.unmount();
  const single=renderScene([message('leaf')],[],{comparisonSingle:true,comparisonDisplay:'agree',comparisonScopeHeader:scopeHeader});
  const frame=single.container.querySelector('[data-comparison-view="agree"]') as HTMLElement;
  expect(frame.style.cssText).toBe(frameStyle);
  expect((frame.firstElementChild as HTMLElement).style.cssText).toBe(headerStyle);
  expect(frame.firstElementChild?.textContent?.trim()).toBe('赞同后显示');
  expect(frame.querySelector('[data-testid="scope-header"]')?.parentElement).toBe(frame);
  fireEvent.click(single.getByRole('button',{name:'退出分类'}));expect(leaveScope).toHaveBeenCalledTimes(1);
  expect(frame.querySelector('[data-msgid="leaf"]')).not.toBeNull();
  expect(single.container.querySelectorAll('[data-comparison-view="agree"]')).toHaveLength(1);
  expect(single.container.querySelector('[data-comparison-view="disagree"]')).toBeNull();
});

it("renders each side's own cross-canvas relations and opens its relation trace",()=>{
  const open=vi.fn(),neighbor=message('neighbor');
  const {container:dom}=renderScene([neighbor],[],{
    comparisonPair:true,onRelatedRelationView:open,
    crossCanvasRelations:new Map(),
    comparisonAgreeContext:{crossCanvasRelations:new Map([['neighbor',{outgoing:{},incoming:{'引用':['R']}}]])},
    comparisonDisagreeContext:{crossCanvasRelations:new Map()},
  });
  const agree=dom.querySelector('[data-comparison-view="agree"]')!,disagree=dom.querySelector('[data-comparison-view="disagree"]')!;
  expect(disagree.querySelector('[data-cross-canvas-related-messages]')).toBeNull();
  fireEvent.click(within(agree as HTMLElement).getByRole('button',{name:/相关消息：1/}));
  expect(within(agree as HTMLElement).getByRole('group',{name:'指向本消息的关联'})).toHaveTextContent('【引用】 R');
  fireEvent.click(within(agree as HTMLElement).getByRole('button',{name:'查看'}));expect(open).toHaveBeenCalledWith('R');
});

it.each(['reference','reply','annotation'] as const)('shows both endpoints of a cross-canvas %s and hides rows once its complete edge is rendered',type=>{
  const source=message('source'),target=message('target');
  const rel:DemoMessage={...message('relation'),kind:'relation',relationType:type};
  const link=relation('relation',type,'source','target');
  for(const [endpoint,direction] of [[source,'发出的关联'],[target,'指向本消息的关联']] as const){
    const view=renderScene([endpoint],[],{relatedMessages:[source,target,rel],relatedEdges:[link]});
    const card=within(view.container.querySelector(`[data-msgid="${endpoint.id}"]`) as HTMLElement);
    fireEvent.click(card.getByRole('button',{name:/相关消息：1/}));
    expect(card.getByRole('group',{name:direction})).toHaveTextContent('relation');
    view.unmount();
  }
  const sameCanvas=renderScene([source,target,rel],[link],{relatedMessages:[source,target,rel],relatedEdges:[link]});
  expect(sameCanvas.queryByRole('button',{name:/相关消息/})).toBeNull();
});
