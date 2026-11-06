import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import { projectGraphScene } from '../utils/graphProjection';
import { withCorrectionContent, type DemoEdge, type DemoMessage } from '../utils/modelBridge';
import MessageCard from '../components/MessageCard';
import { GRID_TOP } from '../utils/layout';
import type { Relation } from '../types';
import { planMessageStructures } from '../utils/messageStructurePlan';
import { findMessageElements } from '../pages/workbench/actions/scrollNavigation';
import { REVEAL_VIRTUAL_MESSAGE } from '../hooks/useVirtualMessageMounts';
import {useRef} from 'react';
import {useViewedMessageHighlight} from '../hooks/useViewedMessageHighlight';
import { setTheme, THEME_STORAGE_KEY } from '../theme/theme';
import { buildTraceProjection } from '../utils/traceProjection';
import { PART_SELECTION_EVENT } from '../utils/messageElementSelection';

const message = (id: string): DemoMessage => ({ id, author: 'tester', content: id, kind: 'normal', createdAt: '2026-01-01T00:00:00Z' });
const relation = (id: string, type: DemoEdge['relationType'], source: string, target: string): DemoEdge => ({
  id, relationMessageId: id, relationType: type, relationLabel: type,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } },
});
function renderScene(messages: DemoMessage[], edges: DemoEdge[],extra:Partial<GraphViewProps>={}) {
  const props: GraphViewProps = {
    messages, edges, draftUnits: [], activeTextSelectId: null, lastClickedMessageId: null,
    onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(), onTextMouseUp: vi.fn(),
    onEdgeLabelSingleClick: vi.fn(), onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(),
    isFragmentSelected: () => false,
  };
  return render(<GraphView {...props} {...extra} />);
}

describe('rendered graph scene', () => {
  it.each(['classify','summary'] as const)('shows entry hints next to %s counts only when double-click enters',async type=>{
    const category:DemoMessage={...message('category'),kind:'relation',relationType:type};
    const messages=[category,message('member')],edges=[relation('category',type,'anon:category','member')];
    const plain=renderScene(messages,edges);
    const card=plain.container.querySelector('[data-msgid="category"]:not([data-rel-overlay])')!;
    expect(card.querySelector('[data-message-member-count]')!.nextElementSibling).toHaveTextContent('双击进入');
    plain.unmount();
    for(const options of [{containerEntryEnabled:false},{traceFrameIds:new Set(['category'])}]){
      const view=renderScene(messages,edges,options);
      expect(view.container.querySelector('[data-message-entry-hint]')).toBeNull();view.unmount();
    }
    const enter=vi.fn();
    for(const enabled of [false,true]){
      const view=renderScene(messages,edges,{expandedFrameIds:new Set(['category']),onFrameHeaderDoubleClick:enabled?enter:undefined});
      const header=view.getByRole('group',{name:'组织消息 category'});
      expect(!!header.querySelector('[data-message-entry-hint]')).toBe(enabled);
      expect(header.title.includes('双击进入')).toBe(enabled);
      if(enabled){fireEvent.doubleClick(header);expect(enter).toHaveBeenCalledWith(expect.anything(),'category');}
      view.unmount();
    }
  });

  it.each([false,true])('independently folds category contents and hides header cards (comparison=%s)',async comparisonPair=>{
    const categories:DemoMessage[]=['outer','inner'].map(id=>({...message(id),kind:'relation',relationType:'classify',relationPayload:{title:`标题 ${id}`}}));
    const messages=[...categories,message('member')];
    const edges=[relation('outer','classify','anon:outer','inner'),relation('inner','classify','anon:inner','member')];
    const context={expandedFrameIds:new Set(['outer','inner'])};
    const view=renderScene(messages,edges,{...context,comparisonPair,comparisonAgreeContext:context,comparisonDisagreeContext:context,
      comparisonAgreeMessages:messages,comparisonAgreeEdges:edges,comparisonDisagreeMessages:messages,comparisonDisagreeEdges:edges});
    await act(async()=>{});
    const panel=view.container.querySelector<HTMLElement>('[data-comparison-viewport="agree"]')??view.container;
    const other=view.container.querySelector<HTMLElement>('[data-comparison-viewport="disagree"]');
    const card=()=>panel.querySelector('[data-msgid="member"]:not([data-rel-overlay])');
    expect(card()).not.toBeNull();
    const controls=()=>panel.querySelector<HTMLElement>('[data-frame-size-controls="inner"]')!;
    expect(within(controls()).getAllByRole('button').map(button=>button.textContent)).toEqual(['隐藏上方消息卡','收起下方框架',comparisonPair?'还原尺寸':'完全展开','自适应尺寸']);
    fireEvent.click(within(panel).getByRole('button',{name:'隐藏上方消息卡 inner'}));await act(async()=>{});
    expect(within(panel).queryByRole('group',{name:'组织消息 inner'})).toBeNull();
    expect(within(panel).queryByText('标题 inner')).toBeNull();
    expect(card()).not.toBeNull();
    expect(within(panel).getByRole('button',{name:'显示上方消息卡 inner'})).toHaveAttribute('aria-pressed','true');
    expect(panel.querySelector('[data-frame-compact-title]')).toHaveTextContent('分类 · 标题 inner');
    expect(panel.querySelector('[data-frame-card-hidden]')).toHaveStyle({minHeight:'36px',padding:'0px'});
    expect(within(controls()).getAllByRole('button').map(button=>button.textContent)).toEqual(['显示上方消息卡','收起下方框架',comparisonPair?'还原尺寸':'完全展开','自适应尺寸']);
    fireEvent.click(within(panel).getByRole('button',{name:'收起下方框架 inner'}));await act(async()=>{});
    expect(card()).toBeNull();
    expect(within(panel).getByRole('button',{name:'展开下方框架 inner'})).toHaveAttribute('aria-expanded','false');
    expect(panel.querySelector('[data-frame-visual="inner"]')).toBeNull();
    expect(panel.querySelector('[data-frame-scrollbar="inner"]')).toBeNull();
    fireEvent.click(within(panel).getByRole('button',{name:'收起下方框架 outer'}));await act(async()=>{});
    expect(panel.querySelector('[data-frame-visual="inner"]')).toBeNull();
    expect(card()).toBeNull();
    if(other){expect(within(other).getByRole('group',{name:'组织消息 inner'})).toBeInTheDocument();expect(other.querySelector('[data-msgid="member"]')).not.toBeNull();}
    fireEvent.click(within(panel).getByRole('button',{name:'展开下方框架 outer'}));await act(async()=>{});
    expect(within(panel).getByRole('button',{name:'展开下方框架 inner'})).toBeInTheDocument();
    expect(within(panel).getByRole('button',{name:'显示上方消息卡 inner'})).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button',{name:'展开下方框架 inner'}));await act(async()=>{});
    expect(card()).not.toBeNull();expect(within(panel).queryByText('标题 inner')).toBeNull();
    fireEvent.click(within(panel).getByRole('button',{name:'显示上方消息卡 inner'}));await act(async()=>{});
    expect(within(panel).getByRole('group',{name:'组织消息 inner'})).toHaveTextContent('标题 inner');
    expect(panel.querySelectorAll('[data-frame-visual="inner"]')).toHaveLength(1);
    view.unmount();
  });

  it('locates opposed text in both panes with jump hints and leaves manual scrolling independent', async () => {
    vi.useFakeTimers();
    const messages = [message('first'), message('second')];
    const view = renderScene(messages, [], { comparisonPair: true,
      comparisonAgreeMessages: messages, comparisonAgreeEdges: [],
      comparisonAgreeSuppressedRelIds: new Set(['first', 'second']),
      comparisonDisagreeSuppressedRelIds: new Set(['first', 'second']),
      comparisonDisagreeMessages: messages.map(item => ({ ...item, content: `changed ${item.id}` })), comparisonDisagreeEdges: [] });
    fireEvent.click(screen.getByRole('button',{name:'只看当前差异'}));
    try {
      const panes = [...view.container.querySelectorAll<HTMLElement>('[data-comparison-viewport]')];
      panes.forEach((pane, side) => {
        for (const [key, value] of Object.entries({ clientWidth: 400, offsetWidth: 400, clientHeight: 300, offsetHeight: 300, scrollWidth: 4000, scrollHeight: 5000 })) {
          Object.defineProperty(pane, key, { configurable: true, value });
        }
        vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(side * 450, 100, 400, 300));
        vi.spyOn(pane.closest('[data-comparison-view]')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(side * 450, 0, 400, 500));
        for (const [index, id] of ['first', 'second'].entries()) {
          const card = pane.querySelector<HTMLElement>(`[data-msgid="${id}"]:not([data-rel-overlay])`)!;
          vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => new DOMRect(
            side * 450 + 800 + index * 400 + side * 500 - pane.scrollLeft,
            100 + 1200 + index * 500 + side * 700 - pane.scrollTop, 200, 80));
        }
      });
      await act(async () => { vi.advanceTimersByTime(200); });
      expect(panes.map(pane => [pane.scrollLeft, pane.scrollTop])).toEqual([[700, 1090], [1200, 1790]]);
      const prompts = () => [...document.querySelectorAll('[data-message-jump-overlay]')];
      expect(prompts().map(node => node.getAttribute('data-message-jump-scope'))).toEqual(['agree', 'disagree']);
      expect(prompts().every(node => node.getAttribute('data-message-jump-target') === 'first')).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: '下一个差异' }));
      await act(async () => { vi.advanceTimersByTime(200); });
      expect(panes.map(pane => [pane.scrollLeft, pane.scrollTop])).toEqual([[1100, 1590], [1600, 2290]]);
      expect(prompts()).toHaveLength(2);
      expect(prompts().every(node => node.getAttribute('data-message-jump-target') === 'second')).toBe(true);
      panes[0].scrollLeft = 20; panes[0].scrollTop = 30; fireEvent.scroll(panes[0]);
      await act(async () => { vi.advanceTimersByTime(200); });
      expect(panes.map(pane => [pane.scrollLeft, pane.scrollTop])).toEqual([[20, 30], [1600, 2290]]);
      expect(view.container.querySelector('[data-comparison-scroll-vertical], [data-comparison-scroll-horizontal]')).toBeNull();
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(prompts()).toHaveLength(0);
    } finally { view.unmount(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it('keeps native scrolling independent even when the comparison has no differences', async () => {
    const messages = [message('same')];
    const view = renderScene(messages, [], { comparisonPair: true });
    const [left, right] = [...view.container.querySelectorAll<HTMLElement>('[data-comparison-viewport]')];
    expect(screen.getByText('当前条件下无显示差异')).toBeInTheDocument();
    left.scrollLeft = 110; left.scrollTop = 220; fireEvent.scroll(left);
    await act(async () => {});
    expect(right.scrollLeft).toBe(0); expect(right.scrollTop).toBe(0);
    for (const pane of [left, right]) {
      expect(pane.style.overflowX).toBe('auto'); expect(pane.style.overflowY).toBe('auto');
      expect(pane.style.height).not.toContain('vh');
    }
  });

  it('keeps two differences in one nested frame tree while navigating between them', async () => {
    const categories:DemoMessage[]=['outer','inner'].map(id=>({...message(id),kind:'relation',relationType:'classify'}));
    const messages=[...categories,message('first'),message('second')];
    const edges=[relation('outer','classify','anon:outer','inner'),
      {...relation('inner','classify','anon:inner','first'),id:'first-membership'},
      {...relation('inner','classify','anon:inner','second'),id:'second-membership'}];
    const context={expandedFrameIds:new Set(['outer','inner'])};
    const view=renderScene(messages,edges,{comparisonPair:true,comparisonScopeHeader:<div>重复分类栏</div>,
      frameViewStateRef:{current:Object.fromEntries(['agree','disagree'].map(side=>[side,{
        sizes:{outer:{width:240,height:120},inner:{width:240,height:120}},scrolls:{outer:{left:80,top:180}},full:{outer:false,inner:false},
      }]))},
      comparisonAgreeMessages:messages,comparisonAgreeEdges:edges,comparisonAgreeContext:context,
      comparisonDisagreeMessages:messages.map(item=>item.kind==='normal'?{...item,content:`另一正文 ${item.id}`}:item),
      comparisonDisagreeEdges:edges,comparisonDisagreeContext:context});
    await act(async()=>{});
    expect(view.queryByText('重复分类栏')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'只看当前差异'}));
    const frames=[...view.container.querySelectorAll('[data-frame-visual="outer"]')];
    for(const side of ['agree','disagree']){
      const panel=view.container.querySelector(`[data-comparison-view="${side}"]`)!;
      for(const [id,depth] of [['outer','0'],['inner','1']]){
        const visuals=panel.querySelectorAll(`[data-frame-visual="${id}"]`);
        expect(visuals).toHaveLength(1);expect(visuals[0]).toHaveAttribute('data-frame-depth',depth);
        expect(panel.querySelectorAll(`[data-msgid="${id}"][data-frame-header]`)).toHaveLength(1);
        expect(panel.querySelector(`[data-msgid="${id}"]:not([data-rel-overlay])`)).toBeNull();
      }
      for(const id of ['first','second'])expect(panel.querySelectorAll(`[data-msgid="${id}"]:not([data-rel-overlay])`)).toHaveLength(1);
      const rect=(id:string)=>{
        const node=panel.querySelector(`[data-frame-visual="${id}"] > rect`)!;
        return Object.fromEntries(['x','y','width','height'].map(key=>[key,Number(node.getAttribute(key))]));
      };
      const outer=rect('outer'),inner=rect('inner');
      expect(inner.x).toBeGreaterThan(outer.x);
      expect(inner.y).toBeGreaterThan(outer.y);
      expect(inner.x+inner.width).toBeLessThanOrEqual(outer.x+outer.width);
      expect(inner.y+inner.height).toBeLessThanOrEqual(outer.y+outer.height);
      expect(panel.querySelector('[data-frame-clip], [data-frame-scrollbar]')).toBeNull();
      for(const id of ['outer','inner'])expect(within(panel as HTMLElement).getByRole('button',{name:`还原尺寸 ${id}`})).toHaveAttribute('aria-pressed','true');
    }
    expect(screen.getByRole('combobox',{name:'选择受影响消息'})).toHaveValue('first');
    fireEvent.click(screen.getByRole('button',{name:'下一个差异'}));
    expect(screen.getByRole('combobox',{name:'选择受影响消息'})).toHaveValue('second');
    const after=[...view.container.querySelectorAll('[data-frame-visual="outer"]')];
    expect(after).toHaveLength(2);after.forEach((frame,index)=>expect(frame).toBe(frames[index]));
  });

  it('allows independent frame collapse and reopens enclosing frames on the next review destination', async () => {
    vi.useFakeTimers();
    const categories:DemoMessage[]=['outer','inner'].map(id=>({...message(id),kind:'relation',relationType:'classify'}));
    const members=Array.from({length:8},(_,index)=>message(`member-${index}`)),messages=[...categories,...members];
    const edges=[relation('outer','classify','anon:outer','inner'),...members.map(member=>({...relation('inner','classify','anon:inner',member.id),id:`membership-${member.id}`}))];
    const context={expandedFrameIds:new Set(['outer','inner'])};
    const view=renderScene(messages,edges,{comparisonPair:true,
      frameViewStateRef:{current:{agree:{sizes:{outer:{width:240,height:120},inner:{width:240,height:120}},scrolls:{},full:{}}}},
      comparisonAgreeContext:context,comparisonDisagreeContext:context,
      comparisonAgreeMessages:messages,comparisonAgreeEdges:edges,
      comparisonDisagreeMessages:messages.map(item=>item.kind==='normal'?{...item,content:`changed ${item.id}`}:item),comparisonDisagreeEdges:edges});
    try{
      await act(async()=>{vi.advanceTimersByTime(2000);});
      const [left,right]=[...view.container.querySelectorAll<HTMLElement>('[data-comparison-viewport]')];
      fireEvent.click(within(left).getByRole('button',{name:'还原尺寸 outer'}));
      fireEvent.click(within(left).getByRole('button',{name:'还原尺寸 inner'}));
      expect(within(left).getByRole('button',{name:'完全展开 outer'})).toHaveAttribute('aria-pressed','false');
      expect(within(left).getByRole('button',{name:'完全展开 inner'})).toHaveAttribute('aria-pressed','false');
      expect(left.querySelector('[data-frame-clip]')).not.toBeNull();
      expect(within(right).getByRole('button',{name:'还原尺寸 outer'})).toHaveAttribute('aria-pressed','true');
      expect(right.querySelector('[data-frame-clip]')).toBeNull();
      fireEvent.click(within(left).getByRole('button',{name:'收起下方框架 outer'}));
      await act(async()=>{vi.advanceTimersByTime(200);});
      expect(left.querySelector('[data-msgid="member-1"]:not([data-rel-overlay])')).toBeNull();
      fireEvent.click(screen.getByRole('button',{name:'下一个差异'}));
      await act(async()=>{vi.advanceTimersByTime(200);});
      expect(within(left).getByRole('button',{name:'收起下方框架 outer'})).toHaveAttribute('aria-expanded','true');
      for(const id of ['outer','inner'])expect(within(left).getByRole('button',{name:`还原尺寸 ${id}`})).toHaveAttribute('aria-pressed','true');
      expect(left.querySelector('[data-frame-clip]')).toBeNull();
      fireEvent.click(within(left).getByRole('button',{name:'还原尺寸 outer'}));
      fireEvent.click(within(left).getByRole('button',{name:'完全展开 outer'}));
      expect(left.querySelector('[data-frame-clip]')).toBeNull();
    }finally{view.unmount();vi.useRealTimers();}
  });

  it('lists changed messages and moves between differences in both panes', async () => {
    const messages=[message('first'),message('second'),message('unchanged')];
    const view=renderScene(messages,[],{comparisonPair:true,
      comparisonAgreeMessages:messages,comparisonAgreeEdges:[],
      comparisonDisagreeMessages:messages.map(item=>item.id==='unchanged'?item:{...item,content:`changed ${item.id}`}),comparisonDisagreeEdges:[]});
    await act(async()=>{});
    const chooser=screen.getByRole('combobox',{name:'选择受影响消息'});
    expect(within(chooser).getAllByRole('option')).toHaveLength(2);
    expect(within(chooser).getByRole('option',{name:/^【文本】first · 正文/})).toBeInTheDocument();
    expect(chooser).toHaveValue('first');
    fireEvent.click(screen.getByRole('button',{name:'下一个差异'}));
    expect(chooser).toHaveValue('second');
    expect(screen.getByRole('button',{name:'下一个差异'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'上一个差异'}));
    expect(chooser).toHaveValue('first');
    for(const pane of view.container.querySelectorAll<HTMLElement>('[data-comparison-viewport]')) expect(pane.style.overflowY).toBe('auto');
  });
  it('locates a released member when the reviewed category is inactive on one side', async () => {
    const category:DemoMessage={...message('category'),kind:'relation',relationType:'classify'};
    const messages=[category,message('member')];
    const view=renderScene(messages,[],{comparisonPair:true,comparisonTargetId:'category',
      comparisonAgreeMessages:messages,comparisonAgreeEdges:[relation('category','classify','anon:category','member')],
      comparisonAgreeContext:{expandedFrameIds:new Set(['category'])},
      comparisonDisagreeMessages:messages,comparisonDisagreeEdges:[],comparisonDisagreeSuppressedRelIds:new Set(['category']),
      comparisonDisagreeContext:{rejectedContainerIds:new Set(['category'])}});
    await act(async()=>{});
    expect(screen.getByRole('combobox',{name:'选择受影响消息'})).toHaveValue('category');
    expect(screen.getByRole('option',{name:/^【分类】category/})).toBeInTheDocument();
    const right=view.container.querySelector<HTMLElement>('[data-comparison-view="disagree"]')!;
    expect(within(right).getByText(/此侧不显示，已定位关联框架或消息/)).toBeInTheDocument();
    expect(right.querySelector('[data-msgid="category"]')).toBeNull();
    expect(right.querySelector('[data-msgid="member"]')).not.toBeNull();
    expect(right.querySelector('[data-comparison-missing]')).toBeNull();
  });
  it('focuses one difference within its shared frame tree, keeps the full chooser and restores other messages', async () => {
    const categories:DemoMessage[]=['outer','inner'].map(id=>({...message(id),kind:'relation',relationType:'classify'}));
    const messages=[...categories,message('first'),message('second'),message('unrelated')];
    const edges=[relation('outer','classify','anon:outer','inner'),
      {...relation('inner','classify','anon:inner','first'),id:'first-membership'},
      {...relation('inner','classify','anon:inner','second'),id:'second-membership'}];
    const context={expandedFrameIds:new Set(['outer','inner'])};
    const view=renderScene(messages,edges,{comparisonPair:true,
      comparisonAgreeMessages:messages,comparisonAgreeEdges:edges,comparisonAgreeContext:context,
      comparisonDisagreeMessages:messages.map(item=>['first','second'].includes(item.id)?{...item,content:`changed ${item.id}`}:item),
      comparisonDisagreeEdges:edges,comparisonDisagreeContext:context});
    await act(async()=>{});
    const toggle=screen.getByRole('button',{name:'只看当前差异'}),chooser=screen.getByRole('combobox',{name:'选择受影响消息'});
    expect(toggle).toHaveAttribute('aria-pressed','true');
    expect(toggle).toHaveTextContent('只看当前差异：已开启');
    expect(within(chooser).getAllByRole('option')).toHaveLength(2);
    const assertFocus=(selected:string,hidden:string)=>{
      for(const side of ['agree','disagree']){
        const pane=view.container.querySelector(`[data-comparison-view="${side}"]`)!;
        expect(pane.querySelectorAll(`[data-msgid="${selected}"]:not([data-rel-overlay])`)).toHaveLength(1);
        for(const id of [hidden,'unrelated'])expect(pane.querySelector(`[data-msgid="${id}"]`)).toBeNull();
        for(const [id,depth] of [['outer','0'],['inner','1']]){
          expect(pane.querySelectorAll(`[data-frame-visual="${id}"]`)).toHaveLength(1);
          expect(pane.querySelector(`[data-frame-visual="${id}"]`)).toHaveAttribute('data-frame-depth',depth);
        }
      }
    };
    assertFocus('first','second');
    fireEvent.click(screen.getByRole('button',{name:'下一个差异'}));
    expect(chooser).toHaveValue('second');assertFocus('second','first');
    fireEvent.change(chooser,{target:{value:'first'}});assertFocus('first','second');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed','false');
    expect(toggle).toHaveTextContent('只看当前差异：已关闭');
    for(const side of ['agree','disagree'])for(const id of ['first','second','unrelated'])expect(view.container.querySelector(`[data-comparison-view="${side}"] [data-msgid="${id}"]`)).not.toBeNull();
  });
  it('renders comparison category frames and empty counterpart frames without entering trace mode', async () => {
    const categories: DemoMessage[] = ['old', 'new'].map(id => ({ ...message(id), kind: 'relation', relationType: 'classify' }));
    const messages = [...categories, message('member')], expandedFrameIds = new Set(['old', 'new']);
    const view = renderScene(messages, [], {
      comparisonPair: true,
      comparisonAgreeSuppressedRelIds: new Set(['member']), comparisonDisagreeSuppressedRelIds: new Set(['member']),
      comparisonAgreeMessages: messages, comparisonAgreeEdges: [relation('new', 'classify', 'anon:new', 'member')],
      comparisonAgreeContext: { expandedFrameIds },
      comparisonDisagreeMessages: messages, comparisonDisagreeEdges: [relation('old', 'classify', 'anon:old', 'member')],
      comparisonDisagreeContext: { expandedFrameIds },
    });
    await act(async () => {});
    for (const side of ['agree', 'disagree']) {
      const panel = view.container.querySelector<HTMLElement>(`[data-comparison-view="${side}"]`)!;
      for (const id of ['old', 'new']) {
        expect(panel.querySelector(`[data-frame-visual="${id}"]`)).not.toBeNull();
        expect(panel.querySelector(`[data-msgid="${id}"][data-frame-header]`)).not.toBeNull();
        expect(panel.querySelector(`[data-msgid="${id}"]:not([data-rel-overlay])`)).toBeNull();
      }
      expect(panel.querySelectorAll('[data-msgid="member"]:not([data-rel-overlay])')).toHaveLength(1);
    }
  });

  it('shows changed child frames when focusing a stationary category with changed membership', async () => {
    const messages:DemoMessage[]=['reviewed','old','moved'].map(id=>({...message(id),kind:'relation',relationType:'classify'}));
    messages.push(message('unchanged'));
    const common=[relation('old','classify','anon:old','unchanged')];
    const context={expandedFrameIds:new Set(['reviewed','old','moved'])};
    const view=renderScene(messages,[],{comparisonPair:true,
      comparisonAgreeMessages:messages,comparisonAgreeEdges:[...common,relation('reviewed','classify','anon:reviewed','moved')],comparisonAgreeContext:context,
      comparisonDisagreeMessages:messages,comparisonDisagreeEdges:[...common,{...relation('old','classify','anon:old','moved'),id:'changed-membership'}],comparisonDisagreeContext:context});
    await act(async()=>{});
    fireEvent.change(screen.getByRole('combobox',{name:'选择受影响消息'}),{target:{value:'old'}});
    for(const side of ['agree','disagree']){
      const pane=view.container.querySelector(`[data-comparison-view="${side}"]`)!;
      expect(pane.querySelector('[data-msgid="unchanged"]')).toBeNull();
      const rect=(id:string)=>{
        const node=pane.querySelector(`[data-frame-visual="${id}"] > rect`)!;
        expect(node).not.toBeNull();
        return Object.fromEntries(['x','y','width','height'].map(key=>[key,Number(node.getAttribute(key))]));
      };
      const child=rect('moved'),parent=rect(side==='agree'?'reviewed':'old');
      expect(child.x).toBeGreaterThan(parent.x);expect(child.y).toBeGreaterThan(parent.y);
      expect(child.x+child.width).toBeLessThanOrEqual(parent.x+parent.width);
      expect(child.y+child.height).toBeLessThanOrEqual(parent.y+parent.height);
      expect(pane.querySelectorAll('[data-frame-visual="moved"]')).toHaveLength(1);
    }
  });

  it('keeps width correction counts and independent widths on both comparison sides', async () => {
    const target = message('target');
    const correction: DemoMessage = { ...message('width-correction'), kind: 'relation', relationType: 'correct',
      relationPayload: { correctionKind: 'WIDTH', correctionWidth: 640 }, targetRefs: [{ kind: 'message', messageId: target.id }] };
    const edge = relation(correction.id, 'correct', 'anon:width-correction', target.id), select = vi.fn();
    const view = renderScene([target, correction], [edge], {
      comparisonPair: true, cardWidths: { target: 900 },
      comparisonAgreeMessages: [target, correction], comparisonAgreeEdges: [edge], comparisonAgreeCardWidths: { target: 640 },
      comparisonAgreeSuppressedRelIds: new Set(), comparisonAgreeContext: { relatedMessages: [target, correction] },
      comparisonDisagreeMessages: [target], comparisonDisagreeEdges: [], comparisonDisagreeCardWidths: {},
      comparisonDisagreeSuppressedRelIds: new Set([correction.id]), comparisonDisagreeContext: { relatedMessages: [target, correction] },
      onInlineBadgeClick: select,
    });
    await act(async () => {});
    const agree = view.container.querySelector<HTMLElement>('[data-comparison-view="agree"]')!;
    const disagree = view.container.querySelector<HTMLElement>('[data-comparison-view="disagree"]')!;
    expect(agree.querySelector<HTMLElement>('[data-msgid="target"]')!.style.width).toBe('640px');
    expect(disagree.querySelector<HTMLElement>('[data-msgid="target"]')!.style.width).toBe('320px');
    expect(within(agree).getByText('✏更正 1/1')).toBeInTheDocument();
    const badge = within(disagree).getByText('✏更正 0/1');
    fireEvent.click(badge);
    expect(select).toHaveBeenCalledWith(expect.anything(), correction.id);
  });

  it.each([
    { name: 'governance', kind: 'governance', backendKind: 'GOVERNANCE', label: '提案' },
    { name: 'proposal', kind: 'relation', relationType: 'proposal', label: '提案' },
    { name: 'governance-operation', kind: 'governance', backendKind: 'GOVERNANCE', relationPayload: { operationType: 'DISTRIBUTE_REVENUE' }, label: '分配收入' },
    { name: 'proposal-operation', kind: 'relation', relationType: 'proposal', relationPayload: { operationType: 'TERMINATE_SETTLEMENT' }, label: '终止结算' },
    { name: 'code', kind: 'code', backendKind: 'CODE', label: '代码' },
    { name: 'operations', kind: 'operations', backendKind: 'OPERATIONS', label: '运营' },
  ] satisfies Array<Partial<DemoMessage> & { name: string; label: string }>)('uses the same $name type name and full ID in the graph and table', ({ name, label, ...fields }) => {
    const target: DemoMessage = { ...message(`完整-${name}-message-id-1234567890`), ...fields, parts: [{ id: 'body', type: 'text', text: '实际正文' }] };
    const graph = renderScene([target], []);
    const graphCard = graph.container.querySelector(`[data-msgid="${target.id}"]`)!;
    expect(graphCard.querySelector('[data-skin-type-label]')).toHaveTextContent(new RegExp(`^${label}$`));
    expect(graphCard.querySelector('.message-card-id')).toHaveTextContent(target.id);
    graph.unmount();
    const table = render(<MessageCard msg={target} ctx={{}} />);
    expect(table.container.querySelector('[data-skin-type-label]')).toHaveTextContent(new RegExp(`^${label}$`));
    expect(table.container.querySelector('.message-card-id')).toHaveTextContent(target.id);
  });
  it.each(['normal','governance','code','operations','annotation','reference','reply','notify','agree','disagree','tag','delegation','summary','classify'] as const)(
    'selects the whole %s message when its descriptive type label is clicked', type => {
      const contentKind = type === 'normal' || type === 'governance' || type === 'code' || type === 'operations';
      const target: DemoMessage = { ...message('typed-message'), kind: contentKind ? type : 'relation',
        relationType: contentKind ? undefined : type, parts: [{ id: 'body', type: 'text', text: '实际正文' }] };
      const select = vi.fn(), selectPart = vi.fn();
      window.addEventListener(PART_SELECTION_EVENT, selectPart);
      try {
        const view = renderScene([target], [], { onMessageClick: select });
        const label = view.container.querySelector('[data-msgid="typed-message"] [data-skin-type-label]')!;
        expect(label).not.toBeNull(); expect(label).not.toHaveAttribute('role');
        expect(label).not.toHaveAttribute('data-message-reference'); expect(label).not.toHaveAttribute('tabindex');
        fireEvent.click(label);
        expect(select).toHaveBeenCalledExactlyOnceWith(expect.anything(), target.id);
        expect(selectPart).not.toHaveBeenCalled();
      } finally { window.removeEventListener(PART_SELECTION_EVENT, selectPart); }
    });
  it.each([false, true])('shows arrangement metadata only after opening its card, with home match %s', homeMatch => {
    const target: DemoMessage = { ...message('arrangement'), kind: 'relation', relationType: 'arrange',
      parts: [{ id: 'members', type: 'relation', relation: 'arrange', roles: { members: [{ id: 'one', reference: { messageId: 'member' } }] } }] };
    const select = vi.fn(), inspect = vi.fn(), selectPart = vi.fn();
    window.addEventListener(PART_SELECTION_EVENT, selectPart);
    try {
      const view = renderScene([target, message('member')], [relation(target.id, 'arrange', 'anon:arrangement', 'member')],
        { homeMatchIds: homeMatch ? new Set([target.id]) : undefined, onMessageClick: select, onMessageDoubleClick: inspect });
      expect(view.queryByText('排列')).toBeNull();
      expect(view.container.querySelector('[data-home-filter-label]')).toBeNull();
      fireEvent.click(view.getByRole('button', {name:'显示排列消息卡 arrangement'}));
      expect(select).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
      const label = view.getByText('排列');
      expect(label).not.toHaveAttribute('role'); expect(label).not.toHaveAttribute('data-message-reference');
      if (homeMatch) expect(label.nextElementSibling).toHaveAttribute('data-home-filter-label', '命中');
      else expect(view.container.querySelector('[data-home-filter-label]')).toBeNull();
      fireEvent.click(label); fireEvent.doubleClick(label);
      expect(select).toHaveBeenCalledExactlyOnceWith(expect.anything(), target.id);
      expect(inspect).toHaveBeenCalledExactlyOnceWith(expect.anything(), target.id);
      expect(selectPart).not.toHaveBeenCalled();
    } finally { window.removeEventListener(PART_SELECTION_EVENT, selectPart); }
  });
  it('keeps a traced summary header, source members and one real arbitration row accessible together', () => {
    const summary: DemoMessage = { ...message('expanded-summary'), kind: 'relation', relationType: 'summary', content: '总结当前讨论',
      spending: { protocol: 1, wager: 2, recommendation: 3 },
      parts: [{ id: 'body', type: 'text', text: '总结当前讨论' }, { id: 'members', type: 'relation', relation: 'summary', roles: {
        members: [{ id: 'first', reference: { messageId: 'source-a' } }, { id: 'second', reference: { messageId: 'source-b' } }],
      } }] };
    const select = vi.fn(), truth = vi.fn(), selectPart = vi.fn();
    window.addEventListener(PART_SELECTION_EVENT, selectPart);
    try {
      const view = renderScene([summary, message('source-a'), message('source-b')],
        [relation(summary.id, 'summary', 'anon:summary', 'source-a'), relation(summary.id, 'summary', 'anon:summary', 'source-b')],
        { traceFrameIds: new Set([summary.id]), traceExpandedFrameIds: new Set([summary.id]), onMessageClick: select,
          onSettlementToggleTruth: truth, onSettlementToggleValue: vi.fn(),
          stakeCounts: { [summary.id]: { truth: { pro: 99, con: 0 }, value: { pro: 88, con: 0 } } } });
      const header = view.getByRole('group', { name: `组织消息 ${summary.id}` });
      expect(header.querySelector('[data-message-part-id="body"]')).toHaveTextContent(summary.content);
      expect(header.querySelector('.message-card-self-stake')).toHaveTextContent('自押 2/3');
      expect(view.container.querySelector(`.themed-message[data-msgid="${summary.id}"]`)).toBeNull();
      expect(view.container.querySelectorAll(`[data-message-settlement-actions="${summary.id}"]`)).toHaveLength(1);
      expect(view.container.querySelector('.themed-message[data-msgid="source-a"]')).not.toBeNull();
      expect(view.container.querySelector('.themed-message[data-msgid="source-b"]')).not.toBeNull();
      fireEvent.click(header.querySelector('[data-skin-type-label]')!);
      expect(select).toHaveBeenCalledExactlyOnceWith(expect.anything(), summary.id);
      expect(selectPart).not.toHaveBeenCalled();
      fireEvent.click(within(header).getByTitle('真假仲裁'));
      expect(truth).toHaveBeenCalledExactlyOnceWith(summary.id);
    } finally { window.removeEventListener(PART_SELECTION_EVENT, selectPart); }
  });
  it('does not display a stance toggle before its host message is included in the visible batch', () => {
    const messages = [message('visible'), message('later')];
    const edges = [relation('vote', 'agree', 'anon:vote', 'later')];
    const view = renderScene(messages, edges, { visibleMessageIds: new Set(['visible']), visibleEdgeIds: new Set() });
    expect(view.container.querySelector('.themed-message[data-msgid="visible"]')).not.toBeNull();
    expect(view.container.querySelector('.themed-message[data-msgid="later"]')).toBeNull();
    expect(view.container.querySelector('[data-decoration-toggle="later"]')).toBeNull();
    view.unmount();
    const complete = renderScene(messages, edges, { visibleMessageIds: new Set(['visible', 'later']), visibleEdgeIds: new Set(['vote']) });
    expect(complete.container.querySelector('.themed-message[data-msgid="later"]')).not.toBeNull();
    expect(complete.container.querySelector('[data-decoration-toggle="later"]')).not.toBeNull();
  });
  it.each((['graph','card'] as const).flatMap(surface=>(['round','round_result'] as const).map(kind=>({surface,kind}))))('handles stored $kind records in $surface while keeping the graph free of settlement cards', ({surface,kind}) => {
    const target={...message('settlement-target-id'),content:'目标正文\n包含「内部引号」和详细内容'};
    const content=`${kind==='round'?'发起真假仲裁':'真假仲裁完成'}：目标消息「${target.content}」${kind==='round_result'?'；结果：赞成胜出':''}`;
    const record:DemoMessage={...message('settlement-record'),kind,content,settlementTargetId:target.id,parts:[{id:'body',type:'text',text:content}]};
    const onNavigate=vi.fn(),onSelect=vi.fn();
    const view=surface==='graph'?renderScene([target,record],[relation(record.id,'round' as DemoEdge['relationType'],`anon:${record.id}`,target.id)],{onNavigateToMessage:onNavigate,onMessageClick:onSelect})
      :render(<MessageCard msg={record} ctx={{isRelationRecord:true}} onClick={onSelect} onSettlementTargetClick={(_event,id)=>onNavigate(id)}/>);
    const card=view.container.querySelector<HTMLElement>('[data-msgid="settlement-record"]')!;
    if(surface==='graph'){
      expect(card).toBeNull();expect(view.container.querySelector('[data-msgid="settlement-target-id"]')).not.toBeNull();
      expect(view.container.querySelector('[data-directed-edge-label="settlement-record"]')).toBeNull();return;
    }
    expect(card).not.toHaveTextContent('目标正文');expect(card).not.toHaveTextContent('内部引号');
    if(kind==='round_result')expect(card).toHaveTextContent('结果：赞成胜出');
    const tag=within(card).getByRole('button',{name:target.id});
    expect(tag).toHaveAttribute('title',`跳转到目标消息 ${target.id}`);
    fireEvent.click(tag);expect(onNavigate).toHaveBeenCalledExactlyOnceWith(target.id);expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders both reference labels and all content endpoints when tracing a reference to a reference', () => {
    const records = ['B', 'E'].map(id => ({ ...message(id), kind: 'relation' as const, relationType: 'reference' as const, content: '' }));
    const projection = buildTraceProjection({ messages: [...['A', 'C', 'D'].map(message), ...records],
      edges: [relation('B', 'reference', 'C', 'A'), relation('E', 'reference', 'D', 'B')],
      startIds: ['E'], distance: 1, depths: { up: 1, down: 0 } });
    const view = renderScene(projection.messages, projection.edges);
    for (const id of ['A', 'C', 'D']) expect(view.container.querySelector(`.themed-message[data-msgid="${id}"]`)).not.toBeNull();
    for (const id of ['B', 'E']) expect(view.container.querySelector(`[data-directed-edge-label="${id}"]`)).not.toBeNull();
    expect(view.container.querySelectorAll('.relation-edge-path')).toHaveLength(2);
  });

  it.each(['normal','classify'] as const)('keeps paths above ordinary %s cards while raising selected cards above labels', kind => {
    const a:DemoMessage={...message('layer-a'),...(kind==='classify'?{kind:'relation' as const,relationType:'classify'}:{})};
    const values=[a,message('layer-b')],links=[relation('layer-ref','reference','layer-a','layer-b')];
    const click=vi.fn();
    function Scene({selected}:{selected:boolean}) { return <GraphView messages={values} edges={links}
      draftUnits={selected?[{messageId:a.id,selection:{kind:'whole'}}]:[]} activeTextSelectId={null} lastClickedMessageId={null}
      onMessageClick={click} onMessageDoubleClick={vi.fn()} onTextMouseUp={vi.fn()} onEdgeLabelSingleClick={vi.fn()}
      onEdgeLabelDoubleClick={vi.fn()} onFragmentAnchorClick={vi.fn()} isFragmentSelected={()=>false}/>; }
    const view=render(<Scene selected={false}/>);
    const card=()=>view.container.querySelector<HTMLElement>('.themed-message[data-msgid="layer-a"]')!;
    const peer=()=>view.container.querySelector<HTMLElement>('.themed-message[data-msgid="layer-b"]')!;
    const edge=()=>view.container.querySelector('.relation-edge-path')!.closest('svg')!;
    const labels=()=>view.container.querySelector<SVGElement>('[data-graph-edge-layer="labels"]')!;
    expect(Number(card().style.zIndex)).toBeLessThan(Number(edge().style.zIndex));
    expect(Number(card().style.zIndex)).toBeLessThan(Number(labels().style.zIndex));
    view.rerender(<Scene selected/>);
    expect(Number(card().style.zIndex)).toBeGreaterThan(Number(edge().style.zIndex));
    expect(Number(card().style.zIndex)).toBeGreaterThan(Number(labels().style.zIndex));
    expect(Number(peer().style.zIndex)).toBeLessThan(Number(edge().style.zIndex));
    expect(Number(peer().style.zIndex)).toBeLessThan(Number(labels().style.zIndex));
    expect(view.container.querySelector<HTMLElement>('[data-graph-cards]')!.style.zIndex).toBe('');
    fireEvent.click(card());expect(click).toHaveBeenCalledWith(expect.anything(),'layer-a');
    view.rerender(<Scene selected={false}/>);
    expect(Number(card().style.zIndex)).toBeLessThan(Number(edge().style.zIndex));
    expect(Number(card().style.zIndex)).toBeLessThan(Number(labels().style.zIndex));
  });

  it('remeasures label plates and hit areas on a theme change without losing relation interactions', () => {
    const previousTheme = document.documentElement.dataset.theme;
    const previousPreference = localStorage.getItem(THEME_STORAGE_KEY);
    const geometry = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: SVGElement) {
      const width = document.documentElement.dataset.theme === 'gpt' ? 20 : 26;
      return new DOMRect(Number(this.getAttribute('x')) - width / 2, Number(this.getAttribute('y')) - 7, width, 14);
    });
    setTheme('gpt');
    const click = vi.fn();
    const view = renderScene([message('plate-a'), message('plate-b')], [relation('plate-ref', 'reference', 'plate-a', 'plate-b')], { onEdgeLabelSingleClick: click });
    try {
      const plate = () => view.container.querySelector('.graph-edge-label-plate')!;
      const hit = () => view.container.querySelector<HTMLElement>('[data-directed-edge-label="plate-ref"]')!;
      expect(plate()).toHaveAttribute('width', '32');
      const beforeWidth = Number.parseFloat(hit().style.width);
      act(() => setTheme('opus'));
      expect(plate()).toHaveAttribute('width', '38');
      expect(Number.parseFloat(hit().style.width)).toBe(beforeWidth + 6);
      fireEvent.click(hit());
      expect(click).toHaveBeenCalledWith(expect.anything(), 'plate-ref', 'plate-ref');
      expect(view.container.querySelector('.graph-edge-label')?.querySelectorAll(':scope > .relation-edge-path, :scope > .relation-edge-arrow')).toHaveLength(2);
      expect(view.container.querySelector('.skin-edge-art')).toHaveAttribute('aria-hidden', 'true');
      expect(view.container.querySelector('.skin-edge-art')).toHaveAttribute('pointer-events', 'none');
    } finally {
      view.unmount();
      geometry.mockRestore();
      if (previousTheme) document.documentElement.dataset.theme = previousTheme;
      else delete document.documentElement.dataset.theme;
      if (previousPreference) localStorage.setItem(THEME_STORAGE_KEY, previousPreference);
      else localStorage.removeItem(THEME_STORAGE_KEY);
    }
  });

  it('keeps automatically opened votes and annotations expanded when reading the next message',()=>{
    const values:DemoMessage[]=[message('m'),message('next'),...(['agree','disagree','tag'] as const).map(type=>({...message(type),kind:'relation' as const,relationType:type,content:'',relationPayload:type==='tag'?{label:'标签'}:undefined}))];
    const links=(['agree','disagree','tag'] as const).map(type=>relation(type,type,`anon:${type}`,'m'));
    function Scene({current,requestId=0}:{current:string;requestId?:number}){return <GraphView messages={values} edges={links} highlightedMessageIds={new Set([current])}
      decorationExpansion={{requestId,messageIds:[current]}}
      draftUnits={[]} activeTextSelectId={null} lastClickedMessageId={null} onMessageClick={vi.fn()} onMessageDoubleClick={vi.fn()} onTextMouseUp={vi.fn()}
      onEdgeLabelSingleClick={vi.fn()} onEdgeLabelDoubleClick={vi.fn()} onFragmentAnchorClick={vi.fn()} isFragmentSelected={()=>false}/>;}
    const view=render(<Scene current="m"/>);
    expect(view.getByRole('button',{name:'收起装饰 m'})).toHaveAttribute('aria-expanded','true');
    expect(view.getByRole('button',{name:'收起标注 m'})).toHaveAttribute('aria-expanded','true');
    expect(view.container.querySelector('[data-jump-msgids~="agree"]')).not.toBeNull();
    expect(view.container.querySelector('[data-jump-msgids~="tag"]')).not.toBeNull();
    fireEvent.click(view.getByRole('button',{name:'收起装饰 m'}));
    expect(view.getByRole('button',{name:'显示装饰 m'})).toHaveAttribute('aria-expanded','false');
    fireEvent.click(view.getByRole('button',{name:'收起标注 m'}));
    view.rerender(<Scene current="m" requestId={1}/>);
    expect(view.getByRole('button',{name:'收起装饰 m'})).toHaveAttribute('aria-expanded','true');
    expect(view.getByRole('button',{name:'收起标注 m'})).toHaveAttribute('aria-expanded','true');
    view.rerender(<Scene current="next"/>);
    expect(view.getByRole('button',{name:'收起装饰 m'})).toHaveAttribute('aria-expanded','true');
    expect(view.getByRole('button',{name:'收起标注 m'})).toHaveAttribute('aria-expanded','true');
    expect(view.container.querySelector('[data-jump-msgids~="agree"]')).not.toBeNull();
    expect(view.container.querySelector('[data-jump-msgids~="tag"]')).not.toBeNull();
    view.rerender(<Scene current="m"/>);
    expect(view.getByRole('button',{name:'收起装饰 m'})).toHaveAttribute('aria-expanded','true');
  });

  it('fully expands a frame and restores its size, scroll and surrounding layout',()=>{
    const members=Array.from({length:8},(_,index)=>message(`expand-${index}`));
    const group:DemoMessage={...message('group'),kind:'relation',relationType:'classify'};
    const selected=vi.fn(),view=renderScene([group,...members,message('outside')],members.map(member=>relation('group','classify','anon:group',member.id)),
      {traceFrameIds:new Set(['group']),traceExpandedFrameIds:new Set(['group']),onMessageClick:selected});
    fireEvent.change(view.getByRole('spinbutton',{name:'框架宽度 group'}),{target:{value:'480'}});
    fireEvent.change(view.getByRole('spinbutton',{name:'框架高度 group'}),{target:{value:'180'}});
    fireEvent.scroll(view.getByLabelText('框架垂直滚动条 group'),{target:{scrollTop:100}});
    const before=view.container.querySelector<HTMLElement>('[data-msgid="expand-0"]')!.style.top;
    const header=view.getByRole('group',{name:'组织消息 group'}),width=header.style.width;
    fireEvent.click(view.getByRole('button',{name:'完全展开 group'}));
    expect(view.getByRole('button',{name:'还原尺寸 group'})).toHaveAttribute('aria-pressed','true');
    expect(view.queryByLabelText('框架垂直滚动条 group')).toBeNull();
    expect(view.container.querySelector('[data-msgid="expand-0"]')!.closest('[data-frame-clip]')).toBeNull();
    fireEvent.click(view.getByRole('button',{name:'还原尺寸 group'}));
    expect(view.getByRole('group',{name:'组织消息 group'}).style.width).toBe(width);
    expect(view.getByRole('spinbutton',{name:'框架宽度 group'})).toHaveValue(480);
    expect(view.getByRole('spinbutton',{name:'框架高度 group'})).toHaveValue(180);
    expect(view.getByLabelText('框架垂直滚动条 group').scrollTop).toBe(100);
    expect(view.container.querySelector<HTMLElement>('[data-msgid="expand-0"]')!.style.top).toBe(before);
    fireEvent.click(view.getByRole('button',{name:'完全展开 group'}));
    fireEvent.click(view.getByRole('button',{name:'自适应尺寸 group'}));
    expect(view.getByRole('button',{name:'完全展开 group'})).toHaveAttribute('aria-pressed','false');
    expect(view.getByRole('button',{name:'自适应尺寸 group'})).toBeDisabled();
    expect(view.queryByLabelText('框架垂直滚动条 group')).toBeNull();
    expect(view.container.querySelector('[data-frame-clip]')).toBeNull();
    expect(selected).not.toHaveBeenCalled();
  });

  it('keeps directed edge lines and arrowheads while rendering labels without arrow symbols',()=>{
    const view=renderScene([message('a'),message('b')],[relation('ref','reference','a','b')]);
    expect(view.container.querySelector('[data-edge-label-arrow]')).toBeNull();
    expect(view.container.querySelector('[data-edge-label-arrow-slot]')).toBeNull();
    const labels=[...view.container.querySelectorAll('svg text')];
    expect(labels.some(label=>label.textContent==='引用')).toBe(true);
    for(const label of labels)expect(label.textContent).not.toMatch(/[→↘↓↙←↖↑↗]/u);
    expect(view.container.querySelectorAll('svg path').length).toBeGreaterThanOrEqual(2);
  });
  it('opens the temporary category from its header and preserves frame size and scroll across remounts',()=>{
    const members=Array.from({length:8},(_,index)=>message(`member-${index}`));
    const group:DemoMessage={...message('group'),kind:'relation',relationType:'classify'};
    const edges=members.map(member=>relation('group','classify','anon:group',member.id));
    const enter=vi.fn(),border=vi.fn(),state={current:{}} as NonNullable<GraphViewProps['frameViewStateRef']>;
    const extra:Partial<GraphViewProps>={traceFrameIds:new Set(['group']),traceExpandedFrameIds:new Set(['group']),frameViewStateRef:state,
      onFrameHeaderDoubleClick:enter,onGroupFrameDoubleClick:border};
    let view=renderScene([group,...members,message('outside')],edges,extra);
    fireEvent.change(view.getByRole('spinbutton',{name:'框架宽度 group'}),{target:{value:'480'}});
    fireEvent.change(view.getByRole('spinbutton',{name:'框架高度 group'}),{target:{value:'180'}});
    fireEvent.scroll(view.getByLabelText('框架垂直滚动条 group'),{target:{scrollTop:100}});
    const saved=structuredClone(state.current);
    fireEvent.doubleClick(view.getByRole('group',{name:'组织消息 group'}));
    expect(enter).toHaveBeenCalledWith(expect.anything(),'group');expect(border).not.toHaveBeenCalled();
    view.unmount();
    view=renderScene([group,...members,message('outside')],edges,extra);
    expect(state.current).toEqual(saved);
    expect(view.getByLabelText('框架垂直滚动条 group').scrollTop).toBe(saved.main.scrolls.group.top);
    expect(view.getByRole('spinbutton',{name:'框架宽度 group'})).toHaveValue(480);
    expect(view.getByRole('spinbutton',{name:'框架高度 group'})).toHaveValue(180);
    view.unmount();
  });

  it('paints an enclosing classification before its nested merge on the first render, without selecting either frame',()=>{
    const outer:DemoMessage={...message('outer'),kind:'relation',relationType:'classify'};
    const merge:DemoMessage={...message('merge'),kind:'relation',relationType:'merge'};
    const edges=[relation('outer','classify','anon:outer','merge'),relation('merge','merge','anon:merge','member')];
    // Relation insertion order is independent of nesting order.
    const view=renderScene([merge,outer,message('member')],edges,{traceFrameIds:new Set(['outer','merge']),traceExpandedFrameIds:new Set(['outer'])});
    const frames=[...view.container.querySelectorAll('[data-frame-visual]')];
    expect(frames.map(frame=>frame.getAttribute('data-frame-visual'))).toEqual(['outer','merge']);
    expect(frames.every(frame=>!frame.hasAttribute('data-whole-selected'))).toBe(true);
    expect(view.getByRole('group',{name:'组织消息 merge'})).toBeInTheDocument();
  });

  it('reveals the header of a tall nested merge inside a bounded parent on the first jump',async()=>{
    const outer:DemoMessage={...message('outer'),kind:'relation',relationType:'classify'};
    const merge:DemoMessage={...message('merge'),kind:'relation',relationType:'merge'};
    const members=Array.from({length:8},(_,index)=>message(`member-${index}`));
    const edges=[relation('outer','classify','anon:outer','merge'),...members.map(member=>relation('merge','merge','anon:merge',member.id))];
    const view=renderScene([merge,outer,...members],edges,{traceFrameIds:new Set(['outer','merge']),traceExpandedFrameIds:new Set(['outer']),
      frameViewStateRef:{current:{main:{sizes:{outer:{width:480,height:240}},scrolls:{outer:{left:0,top:300}},full:{outer:false}}}}});
    const canvas=view.container.querySelector('[data-jump-canvas]')!;
    act(()=>canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:['merge']}})));
    await act(async()=>{});
    const header=view.getByRole('group',{name:'组织消息 merge'}),clip=header.closest<HTMLElement>('[data-frame-clip]')!;
    expect(clip).not.toBeNull();
    const top=parseFloat((header as HTMLElement).style.top),clipTop=parseFloat(clip.style.top);
    expect(top).toBeGreaterThanOrEqual(clipTop);
    expect(top+parseFloat((header as HTMLElement).style.minHeight)).toBeLessThanOrEqual(clipTop+parseFloat(clip.style.height));
  });

  it('keeps a cross-frame citation visible and reveals its routed start inside the source viewport',async()=>{
    const group=(id:string):DemoMessage=>({...message(id),kind:'relation',relationType:'classify'});
    const members=Array.from({length:8},(_,index)=>message(`member-${index}`));
    const links=[...members.map(member=>relation('source-frame','classify','anon:source-frame',member.id)),
      relation('target-frame','classify','anon:target-frame','target'),relation('citation','reference','member-7','target')];
    const view=renderScene([group('source-frame'),group('target-frame'),...members,message('target')],links,
      {traceFrameIds:new Set(['source-frame','target-frame']),traceExpandedFrameIds:new Set(['source-frame','target-frame'])});
    fireEvent.change(view.getByRole('spinbutton',{name:'框架宽度 source-frame'}),{target:{value:'480'}});
    fireEvent.change(view.getByRole('spinbutton',{name:'框架高度 source-frame'}),{target:{value:'220'}});
    await act(async()=>{});
    expect(view.container.querySelector('[data-directed-edge-label="citation"]')).toBeNull();
    expect(view.container.querySelector('svg [data-frame-edge-id="citation"]')).toBeNull();
    const canvas=view.container.querySelector('[data-jump-canvas]')!;
    const detail={ids:['citation'],positioningPending:false};
    act(()=>{canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail}));});
    await act(async()=>{});
    expect(detail.positioningPending).toBe(true);
    // Scrolling changes routing geometry; navigation retries after that layout commits.
    for(let attempt=0;attempt<8;attempt++){
      act(()=>{canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:['citation']}}));});
      await act(async()=>{});
    }
    const start=view.container.querySelector<HTMLElement>('[data-directed-edge-start="citation"]')!;
    expect(findMessageElements(view.container,'citation')).toContain(start);
    expect(start.closest('[data-frame-clip]')).not.toBeNull();
    const clip=view.container.querySelector('[data-msgid="member-7"]')!.closest<HTMLElement>('[data-frame-clip]')!;
    expect(parseFloat(start.style.top)).toBeGreaterThanOrEqual(parseFloat(clip.style.top));
    expect(parseFloat(start.style.top)+16).toBeLessThanOrEqual(parseFloat(clip.style.top)+parseFloat(clip.style.height));
    expect(view.container.querySelector('[data-directed-edge-label="citation"]')!.closest('[data-frame-clip]')).toBeNull();
    expect(view.container.querySelector('g[data-jump-visual-msgids="citation"]')!.parentElement).not.toHaveAttribute('viewBox');
  });
  it('clips references to other edge labels inside the expanded frame and marks the full organization once',async()=>{
    const group:DemoMessage={...message('group'),kind:'relation',relationType:'classify'};
    const citation:DemoMessage={...message('citation'),kind:'relation',relationType:'reference',content:''};
    const members=['a','b','c'].map(message);
    const links=[...members.map(member=>relation('group','classify','anon:group',member.id)),relation('citation','reference','a','b'),relation('nested-citation','reference','c','citation')];
    function Harness(){
      const root=useRef<HTMLDivElement>(null);useViewedMessageHighlight(root,['group']);
      return <div ref={root}><GraphView messages={[group,citation,...members,message('outside')]} edges={links} draftUnits={[]} activeTextSelectId={null} lastClickedMessageId={null}
        traceFrameIds={new Set(['group'])} traceExpandedFrameIds={new Set(['group'])} onMessageClick={vi.fn()} onMessageDoubleClick={vi.fn()}
        onTextMouseUp={vi.fn()} onEdgeLabelSingleClick={vi.fn()} onEdgeLabelDoubleClick={vi.fn()} onFragmentAnchorClick={vi.fn()} isFragmentSelected={()=>false}/></div>;
    }
    const view=render(<Harness/>);
    fireEvent.change(view.getByRole('spinbutton',{name:'框架宽度 group'}),{target:{value:'480'}});
    fireEvent.change(view.getByRole('spinbutton',{name:'框架高度 group'}),{target:{value:'180'}});
    await act(async()=>{});
    for(const id of ['citation','nested-citation']){
      expect(view.container.querySelector(`g[data-jump-visual-msgids="${id}"]`)?.parentElement).toHaveAttribute('viewBox');
      expect(view.container.querySelector(`[data-directed-edge-label="${id}"]`)?.closest('[data-frame-clip]')).not.toBeNull();
    }
    const visual=view.container.querySelector('[data-frame-visual="group"]')!;
    expect(visual).toHaveAttribute('data-view-target','true');
    expect(view.container.querySelectorAll('[data-view-target]')).toHaveLength(1);
    const header=view.getByRole('group',{name:'组织消息 group'}),corner=visual.querySelector('.view-target-corners')!;
    expect(corner.getAttribute('d')).toContain(` ${Number.parseFloat(header.style.top)-4} H `);
    const before=corner.getAttribute('d');fireEvent.keyDown(view.getByRole('button',{name:'拖动调整框架大小 group'}),{key:'ArrowDown'});
    expect(visual.querySelector('.view-target-corners')?.getAttribute('d')).not.toBe(before);
  });
  it.each(['classify','summary'] as const)('automatically opens a %s in columns and anchors all four resize edges',type=>{
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){return new DOMRect(0,0,Number.parseFloat(this.style.width)||1000,Number.parseFloat(this.style.height)||86);});
    try{
    const members=Array.from({length:6},(_,index)=>({...message(`flow-${index}`),sequence:index+1}));
    const group:DemoMessage={...message('group'),kind:'relation',relationType:type,parts:[{id:'display',type:'display',layout:'flow',relationPartId:'members'}]};
    const selected=vi.fn(),view=renderScene([group,...members,message('outside')],[...members.map(member=>relation('group',type,'anon:group',member.id)),relation('citation','reference','flow-0','flow-1')],
      {traceFrameIds:new Set(['group']),traceExpandedFrameIds:new Set(['group']),onMessageClick:selected});
    const visibleMembers=()=>Array.from(view.container.querySelectorAll<HTMLElement>('[data-msgid^="flow-"]'));
    const columns=()=>new Set(visibleMembers().map(card=>card.style.left)).size;
    expect(columns()).toBe(2);
    expect(visibleMembers()).toHaveLength(4);
    expect(Number.parseFloat(view.container.querySelector<HTMLElement>('[data-msgid="flow-0"]')!.style.left)).toBeGreaterThan(Number.parseFloat(view.container.querySelector<HTMLElement>('[data-msgid="flow-1"]')!.style.left));
    expect(view.queryByRole('button',{name:'横向调整框架宽度 group'})).toBeNull();
    const width=view.getByRole('spinbutton',{name:'框架宽度 group'}) as HTMLInputElement,height=view.getByRole('spinbutton',{name:'框架高度 group'}) as HTMLInputElement;
    const beforeWidth=Number(width.value),beforeHeight=Number(height.value);
    const header=view.getByRole('group',{name:'组织消息 group'}),anchor={left:header.style.left,top:header.style.top};
    fireEvent.keyDown(view.getByRole('button',{name:'从上边缘调整框架高度 group'}),{key:'ArrowUp'});
    expect(height).toHaveValue(beforeHeight+20);expect(width).toHaveValue(beforeWidth);
    fireEvent.keyDown(view.getByRole('button',{name:'从上边缘调整框架高度 group'}),{key:'ArrowDown'});
    expect(height).toHaveValue(beforeHeight);
    fireEvent.keyDown(view.getByRole('button',{name:'从左边缘调整框架宽度 group'}),{key:'ArrowLeft'});
    expect(width).toHaveValue(beforeWidth+20);expect(height).toHaveValue(beforeHeight);
    fireEvent.keyDown(view.getByRole('button',{name:'从左边缘调整框架宽度 group'}),{key:'ArrowRight'});
    expect(width).toHaveValue(beforeWidth);
    fireEvent.keyDown(view.getByRole('button',{name:'从右边缘调整框架宽度 group'}),{key:'ArrowRight'});
    expect(width).toHaveValue(beforeWidth+20);expect(height).toHaveValue(beforeHeight);
    fireEvent.keyDown(view.getByRole('button',{name:'从下边缘调整框架高度 group'}),{key:'ArrowDown'});
    expect(width).toHaveValue(beforeWidth+20);expect(height).toHaveValue(beforeHeight+20);
    expect({left:header.style.left,top:header.style.top}).toEqual(anchor);
    const frame=view.container.querySelector<SVGRectElement>('rect[data-jump-visual-msgids="group"]')!;
    expect(Number.parseFloat(header.style.width)).toBe(Number(frame.getAttribute('width')));
    fireEvent.scroll(view.getByLabelText('框架垂直滚动条 group'),{target:{scrollTop:200}});
    expect(view.container.querySelector('[data-msgid="flow-5"]')).not.toBeNull();
    expect(view.container.querySelector('[data-msgid="flow-0"]')).toBeNull();
    expect(selected).not.toHaveBeenCalled();
    }finally{geometry.mockRestore();}
  });
  it('keeps nested frame scrollbars inside the outer viewport and supports keyboard resizing',()=>{
    const outer:DemoMessage={...message('outer'),kind:'relation',relationType:'classify'},inner:DemoMessage={...message('inner'),kind:'relation',relationType:'summary'};
    const members=Array.from({length:5},(_,index)=>message(`nested-${index}`));
    const view=renderScene([outer,inner,...members,message('outside')],[relation('outer','classify','anon:outer','inner'),...members.map(member=>relation('inner','summary','anon:inner',member.id))],
      {traceFrameIds:new Set(['outer','inner']),traceExpandedFrameIds:new Set(['outer','inner'])});
    for(const [id,width,height] of [['outer','500','360'],['inner','400','180']]){
      fireEvent.change(view.getByRole('spinbutton',{name:`框架宽度 ${id}`}),{target:{value:width}});
      fireEvent.change(view.getByRole('spinbutton',{name:`框架高度 ${id}`}),{target:{value:height}});
    }
    expect(view.getByLabelText('框架水平滚动条 inner').closest('[data-frame-clip]')).not.toBeNull();
    fireEvent.keyDown(view.getByRole('button',{name:'拖动调整框架大小 inner'}),{key:'ArrowRight'});
    expect(view.getByRole('spinbutton',{name:'框架宽度 inner'})).toHaveValue(420);
    fireEvent.keyDown(view.getByRole('button',{name:'拖动调整框架大小 inner'}),{key:'ArrowDown'});
    expect(view.getByRole('spinbutton',{name:'框架高度 inner'})).toHaveValue(200);
  });
  it.each(['classify','summary'] as const)('resizes and scrolls an expanded %s temporarily without squeezing member cards',type=>{
    const members=Array.from({length:8},(_,index)=>message(`member-${index}`));
    const group:DemoMessage={...message('group'),kind:'relation',relationType:type,relationPayload:{title:'展开框架'}};
    const edges=[...members.map(member=>relation('group',type,'anon:group',member.id)),relation('reference','reference','member-7','member-0')];
    const selected=vi.fn(),view=renderScene([group,...members,message('outside')],edges,{traceFrameIds:new Set(['group']),traceExpandedFrameIds:new Set(['group']),onMessageClick:selected});
    fireEvent.change(view.getByRole('spinbutton',{name:'框架宽度 group'}),{target:{value:'8'}});
    expect(view.getByRole('spinbutton',{name:'框架宽度 group'})).toHaveValue(8);
    fireEvent.change(view.getByRole('spinbutton',{name:'框架宽度 group'}),{target:{value:'480'}});
    fireEvent.change(view.getByRole('spinbutton',{name:'框架高度 group'}),{target:{value:'180'}});
    const vertical=view.getByLabelText('框架垂直滚动条 group');expect(vertical).toHaveStyle({overflowY:'scroll'});
    expect(view.getByLabelText('框架水平滚动条 group')).toHaveStyle({overflowX:'scroll'});
    const first=view.container.querySelector<HTMLElement>('[data-msgid="member-0"]')!;
    expect(first.style.width).toBe('320px');expect(first.closest('[data-frame-clip]')).not.toBeNull();
    const top=Number.parseFloat(first.style.top);fireEvent.scroll(vertical,{target:{scrollTop:200}});
    expect(Number.parseFloat(view.container.querySelector<HTMLElement>('[data-msgid="member-0"]')!.style.top)).toBe(top-200);
    const canvas=view.container.querySelector('[data-jump-canvas]')!;
    const beforeJump={width:frameSize('width'),height:frameSize('height')};
    function frameSize(axis:'width'|'height'){return view.getByRole('spinbutton',{name:`框架${axis==='width'?'宽度':'高度'} group`}).getAttribute('value');}
    // The ancestor and other dependencies are mounted for highlighting, but
    // must not override the explicit member destination's scroll position.
    act(()=>{canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:['member-6','group','member-0']}}));});
    expect(view.getByLabelText('框架垂直滚动条 group').scrollTop).toBeGreaterThan(200);
    expect({width:frameSize('width'),height:frameSize('height')}).toEqual(beforeJump);
    expect(view.container.querySelector('[data-msgid="member-6"]')?.closest('[data-frame-clip]')).toHaveStyle({overflow:'clip'});
    expect(view.container.querySelector('[data-jump-visual-msgids="reference"]')?.parentElement).toHaveAttribute('viewBox');
    fireEvent.click(view.getByRole('button',{name:'自适应尺寸 group'}));
    expect(view.queryByLabelText('框架垂直滚动条 group')).toBeNull();expect(view.container.querySelector('[data-frame-clip]')).toBeNull();
    expect(selected).not.toHaveBeenCalled();
  });
  it('uses the full natural size for a sole traced classification and directly restores adjustable dimensions',()=>{
    const members=Array.from({length:8},(_,index)=>message(`full-${index}`));
    const group:DemoMessage={...message('group'),kind:'relation',relationType:'classify'};
    const view=renderScene([group,...members],members.map(member=>relation('group','classify','anon:group',member.id)),
      {traceFrameIds:new Set(['group']),traceExpandedFrameIds:new Set(['group'])});
    expect(view.container.querySelectorAll('[data-msgid^="full-"]')).toHaveLength(8);
    expect(view.queryByRole('button',{name:'调整框架尺寸 group'})).toBeNull();
    expect(view.queryByRole('group',{name:'框架尺寸 group'})).toBeNull();
    expect(view.container.querySelector('[data-frame-resize]')).toBeNull();
    expect(view.queryByLabelText('框架垂直滚动条 group')).toBeNull();
    expect(view.queryByLabelText('框架水平滚动条 group')).toBeNull();
    expect(view.container.querySelector('[data-frame-clip]')).toBeNull();
    expect(view.getByRole('button',{name:'还原尺寸 group'})).toHaveAttribute('aria-pressed','true');
    expect(view.queryByRole('spinbutton',{name:'框架宽度 group'})).toBeNull();
    fireEvent.click(view.getByRole('button',{name:'还原尺寸 group'}));
    expect(view.getByRole('button',{name:'完全展开 group'})).toHaveAttribute('aria-pressed','false');
    expect(view.getByRole('spinbutton',{name:'框架宽度 group'})).toBeInTheDocument();
  });
  it('renders an explicitly inspected vote on a JOIN as a reachable record card',()=>{
    const join:DemoMessage={...message('join'),kind:'join',joinInfo:{containerId:'parent',containerType:'CLASSIFY',targetIds:['member']}};
    const vote:DemoMessage={...message('vote'),kind:'relation',relationType:'disagree',targetRefs:[{kind:'message',messageId:'join'}]};
    const view=renderScene([join,vote],[relation('vote','disagree','anon:vote','join')],{standaloneMessageIds:new Set(['vote'])});
    expect(view.container.querySelector('[data-msgid="vote"]:not([data-rel-overlay])')).not.toBeNull();
    expect(findMessageElements(view.container,'vote').length).toBeGreaterThan(0);
  });
  it('ignores stale trace expansion after returning to the ordinary graph',()=>{
    const category={...message('category'),kind:'relation' as const,relationType:'classify' as const};
    const props={traceFrameIds:new Set<string>(),traceExpandedFrameIds:new Set(['category'])};
    const scene=projectGraphScene({messages:[category],edges:[],isTraceWindow:false,traceExpandedFrameIds:props.traceExpandedFrameIds});
    expect(scene.normals.map(message=>message.id)).toContain('category');
    const view=renderScene([category],[],props);
    expect(view.container.querySelector('[data-msgid="category"]')).not.toBeNull();
  });
  it.each(['normal','classify','summary','arrange','merge'] as const)('puts the home match badge after the %s type and exposes its reason',type=>{
    const target=type==='normal'?message('target'):{...message('target'),kind:'relation' as const,relationType:type};
    const edges=type==='arrange'||type==='merge'?[relation('target',type,'anon:target','member')]:[];
    const view=renderScene([target,message('member')],edges,{homeMatchIds:new Set(['target']),homeReasonByMessageId:new Map([['target','由本人发送\n待确认：正文未阅']])});
    if(type==='arrange')fireEvent.click(view.getByRole('button',{name:'显示排列消息卡 target'}));
    const badge=view.container.querySelector('[data-home-filter-label="命中"]')!;
    expect(badge.getAttribute('title')).toContain('由本人发送');
    expect(badge.getAttribute('title')).toContain('正文未阅');
    expect(badge.previousElementSibling?.textContent).toBe({normal:'文本',classify:'分类',summary:'总结',arrange:'排列',merge:'归并'}[type]);
    view.unmount();
  });
  it('labels retained table context with a different explanation from matches',()=>{
    const view=render(<MessageCard msg={message('context')} ctx={{homeMatch:false,homeReason:'未直接命中筛选条件；作为外层容器保留'}}/>);
    const badge=view.container.querySelector('[data-home-filter-label="上下文"]')!;
    expect(badge.getAttribute('title')).toContain('主页显示原因');
    expect(badge.getAttribute('title')).toContain('未直接命中');
    expect(badge.previousElementSibling?.textContent).toBe('文本');
  });
  it.each([['classify','分类'],['summary','总结'],['arrange','排列'],['merge','归并']] as const)('shows concrete JOIN endpoint types for %s from the full catalog without redundant body text', (type,label) => {
    const parent:DemoMessage={...message('parent'),kind:'relation',relationType:type,relationPayload:{label:'容器的自定义标签'}};
    const target=message('target'),nested:DemoMessage={...message('nested'),kind:'relation',relationType:'summary'};
    const join:DemoMessage={...message('join'),kind:'join',content:'加入容器',parts:[{id:'body',type:'text',text:'建立关系：JOIN；目标：iy6ruf2a'}],joinInfo:{containerId:'parent',containerType:'JOIN',targetIds:['target','nested']}};
    const view=renderScene([join],[],{showJoinRecords:true,relatedMessages:[parent,target,nested,join]});
    const card=view.container.querySelector<HTMLElement>('[data-msgid="join"]:not([data-rel-overlay])')!;
    expect(card.querySelector('[data-join-endpoint-type="parent"]')).toHaveTextContent(`【${label}】ID：`);
    expect(card).not.toHaveTextContent('容器 ID：');
    expect(card.querySelector('[data-join-endpoint-type="target"]')).toHaveTextContent('【文本】');
    expect(card.querySelector('[data-join-endpoint-type="nested"]')).toHaveTextContent('【总结】');
    expect(card).not.toHaveTextContent('加入容器');
    expect(card).not.toHaveTextContent('建立关系：JOIN');
  });
  it('uses the same statistic and arbitration order as the message list', () => {
    const onTruth = vi.fn(), onValue = vi.fn();
    const view = renderScene([message('target')], [], {
      stakeCounts: { target: { truth: { pro: 7, con: 2 }, value: { pro: 11, con: 3 } } },
      onSettlementToggleTruth: onTruth, onSettlementToggleValue: onValue,
    });
    const actions = view.container.querySelector('[data-message-settlement-actions="target"]')!;
    expect([...actions.querySelectorAll('[title]')].map(element => element.getAttribute('title')))
      .toEqual(['真假统计', '真假仲裁', '价值统计', '价值仲裁']);
    expect(within(actions as HTMLElement).getByTitle('真假统计')).toHaveTextContent('✓7✕2');
    expect(within(actions as HTMLElement).getByTitle('价值统计')).toHaveTextContent('▲11▼3');
    for (const title of ['真假统计', '价值统计']) expect(within(actions as HTMLElement).getByTitle(title)).not.toHaveTextContent(/⚖️|💎/);
    fireEvent.click(within(actions as HTMLElement).getByTitle('真假仲裁'));
    expect(onTruth).toHaveBeenCalledExactlyOnceWith('target');
    fireEvent.click(within(actions as HTMLElement).getByTitle('价值仲裁'));
    expect(onValue).toHaveBeenCalledExactlyOnceWith('target');
  });

  it.each(['normal','classify','summary','arrange','merge'] as const)('keeps %s votes on the right and annotations at the upper right independently collapsible', type => {
    const target:DemoMessage=type==='normal'?message('target'):{...message('target'),kind:'relation',relationType:type};
    const relations=(['agree','disagree','recommend','tag'] as const).map(type=>({...message(type),kind:'relation' as const,relationType:type}));
    const edges=relations.map(record=>relation(record.id,record.relationType,`anon:${record.id}`,'target'));
    if(type==='arrange'||type==='merge')edges.push(relation('target',type,'anon:target','member'));
    const view=renderScene([target,message('member'),...relations],edges);
    const canvas=view.container.querySelector('[data-jump-canvas]')!;
    const voteToggle=view.getByRole('button',{name:'显示装饰 target'}),annotationToggle=view.getByRole('button',{name:'显示标注 target'});
    expect(parseFloat(annotationToggle.style.top)+parseFloat(annotationToggle.style.height)).toBeLessThanOrEqual(parseFloat(voteToggle.style.top));
    fireEvent.click(voteToggle);
    expect(findMessageElements(view.container,'agree')).toHaveLength(1);
    expect(findMessageElements(view.container,'recommend')).toHaveLength(0);
    expect(findMessageElements(view.container,'tag')).toHaveLength(0);
    fireEvent.click(annotationToggle);
    const vote=findMessageElements(view.container,'agree')[0];
    for(const id of ['recommend','tag']){
      const badge=findMessageElements(view.container,id)[0];
      expect(badge).toBeDefined();
      expect(parseFloat(badge.style.left)).toBeGreaterThan(parseFloat(vote.style.left)+parseFloat(vote.style.width));
      expect(parseFloat(badge.style.top)).toBeGreaterThanOrEqual(0);
    }
    fireEvent.click(view.getByRole('button',{name:'收起标注 target'}));
    expect(findMessageElements(view.container,'recommend')).toHaveLength(0);
    expect(findMessageElements(view.container,'agree')).toHaveLength(1);
    fireEvent.click(view.getByRole('button',{name:'显示标注 target'}));
    fireEvent.click(view.getByRole('button',{name:'收起装饰 target'}));
    expect(findMessageElements(view.container,'agree')).toHaveLength(0);
    expect(findMessageElements(view.container,'recommend')).toHaveLength(1);
    fireEvent.click(view.getByRole('button',{name:'收起标注 target'}));
    for(const id of ['recommend','agree','tag']){
      act(()=>{canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:[id]}}));});
      expect(findMessageElements(view.container,id)).toHaveLength(1);
      act(()=>{canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:[]}}));});
      expect(findMessageElements(view.container,id)).toHaveLength(1);
    }
    fireEvent.click(view.getByRole('button',{name:'收起装饰 target'}));
    fireEvent.click(view.getByRole('button',{name:'收起标注 target'}));
    expect(findMessageElements(view.container,'agree')).toHaveLength(0);
    expect(findMessageElements(view.container,'tag')).toHaveLength(0);
  });
  it.each(['classify','summary'] as const)('renders one set of votes and two unobstructed fold controls on an expanded nested %s',type=>{
    const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
      return this.hasAttribute('data-frame-header')?new DOMRect(parseFloat(this.style.left)||0,parseFloat(this.style.top)||0,
        parseFloat(this.style.width)||320,parseFloat(this.style.minHeight)||56):new DOMRect();
    });
    try{
    const outer:DemoMessage={...message('outer'),kind:'relation',relationType:'classify'};
    const target:DemoMessage={...message('target'),kind:'relation',relationType:type};
    const annotations=(['agree','disagree','recommend','archive'] as const).map(relationType=>({...message(relationType),kind:'relation' as const,relationType}));
    const edges=[relation('outer','classify','anon:outer','target'),relation('target',type,'anon:target','member'),
      ...annotations.map(record=>relation(record.id,record.relationType,`anon:${record.id}`,'target'))];
    const send=vi.fn(),view=renderScene([outer,target,message('member'),...annotations],edges,{
      expandedFrameIds:new Set(['outer','target']),expandAllFrames:true,discussionView:{mode:'discussion',collapsed:[]},highlightedMessageIds:new Set(['target']),onDecorationIconClick:send});
    const votes=(kind:string)=>view.container.querySelectorAll(`[data-skin-decoration="${kind}"][data-msgid="target"]`);
    for(const hideHeader of [false,true]){
      if(hideHeader)fireEvent.click(view.getByRole('button',{name:'隐藏上方消息卡 target'}));
      for(const kind of ['agree','disagree'])expect(votes(kind)).toHaveLength(1);
      expect(findMessageElements(view.container,'recommend')).toHaveLength(1);
      expect(findMessageElements(view.container,'archive')).toHaveLength(1);
      const voteToggle=view.getByRole('button',{name:'收起装饰 target'}),annotationToggle=view.getByRole('button',{name:'收起标注 target'});
      const header=view.container.querySelector<HTMLElement>('[data-frame-header][data-msgid="target"]')!;
      const right=parseFloat(header.style.left)+parseFloat(header.style.width),top=parseFloat(header.style.top);
      expect(parseFloat(annotationToggle.style.left)).toBeLessThan(right);
      expect(parseFloat(annotationToggle.style.left)+parseFloat(annotationToggle.style.width)).toBeGreaterThanOrEqual(right-8);
      expect(parseFloat(annotationToggle.style.top)+parseFloat(annotationToggle.style.height)).toBeLessThanOrEqual(top);
      expect(parseFloat(voteToggle.style.left)).toBeGreaterThanOrEqual(right);
      expect(parseFloat(voteToggle.style.top)).toBeGreaterThanOrEqual(top);
      expect(parseFloat(voteToggle.style.top)).toBeLessThan(top+parseFloat(header.style.minHeight));
      expect(parseFloat(annotationToggle.style.top)+parseFloat(annotationToggle.style.height)).toBeLessThanOrEqual(parseFloat(voteToggle.style.top));
      fireEvent.click(voteToggle);
      for(const kind of ['agree','disagree'])expect(votes(kind)).toHaveLength(0);
      expect(view.getByRole('button',{name:'收起标注 target'})).toHaveAttribute('aria-expanded','true');
      expect(findMessageElements(view.container,'recommend')).toHaveLength(1);
      fireEvent.click(view.getByRole('button',{name:'显示装饰 target'}));
      fireEvent.click(annotationToggle);
      expect(findMessageElements(view.container,'recommend')).toHaveLength(0);
      expect(findMessageElements(view.container,'archive')).toHaveLength(0);
      for(const kind of ['agree','disagree'])expect(votes(kind)).toHaveLength(1);
      fireEvent.click(view.getByRole('button',{name:'显示标注 target'}));
    }
    expect(send).not.toHaveBeenCalled();
    }finally{geometry.mockRestore();}
  });
  it('folds multiple annotations on the first classification and reveals each jump target within the canvas', () => {
    const target:DemoMessage={...message('category'),kind:'relation',relationType:'classify'};
    const types=['recommend','archive','attention','block','read','unread'] as const;
    const annotations=types.map(type=>({...message(type),kind:'relation' as const,relationType:type,relationPayload:{subType:'YES' as const}}));
    const view=renderScene([target,...annotations],annotations.map(annotation=>relation(annotation.id,annotation.relationType,`anon:${annotation.id}`,target.id)));
    for(const type of types)expect(findMessageElements(view.container,type)).toHaveLength(0);
    const canvas=view.container.querySelector('[data-jump-canvas]')!;
    for(const type of types){
      act(()=>{canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:[type]}}));});
      const badge=findMessageElements(view.container,type)[0];
      expect(badge).toBeDefined();
      expect(parseFloat(badge.style.top)).toBeGreaterThanOrEqual(0);
      act(()=>{canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:[]}}));});
      expect(findMessageElements(view.container,type)).toHaveLength(1);
    }
    const badges=types.map(type=>findMessageElements(view.container,type)[0]);
    for(let i=1;i<badges.length;i++)expect(parseFloat(badges[i].style.top)).toBeGreaterThanOrEqual(parseFloat(badges[i-1].style.top)+parseFloat(badges[i-1].style.height));
    act(()=>{canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:[]}}));});
    expect(findMessageElements(view.container,'recommend')).toHaveLength(1);
    fireEvent.click(view.getByRole('button',{name:'收起标注 category'}));
    for(const type of types)expect(findMessageElements(view.container,type)).toHaveLength(0);
  });
  it.each(['attention','block'] as const)('separates positive and negative %s badges',type=>{
    const annotations=(['YES','NO'] as const).map(reason=>({...message(reason),kind:'relation' as const,relationType:type,relationPayload:{subType:reason}}));
    const view=renderScene([message('target'),...annotations],annotations.map(annotation=>relation(annotation.id,type,`anon:${annotation.id}`,'target')));
    fireEvent.click(view.getByRole('button',{name:'显示标注 target'}));
    expect(view.getByText(type==='attention'?'关注－是':'拉黑－是')).toBeInTheDocument();
    expect(view.getByText(type==='attention'?'关注－否':'拉黑－否')).toBeInTheDocument();
  });
  it.each(['recommend','tag'] as const)('keeps a converted %s annotation reachable when its exact target has no badge host',type=>{
    const annotation:DemoMessage={...message('converted'),kind:'relation',relationType:type,relationPayload:{label:'可靠',
      annotationStance:{target:{messageId:'original-annotation'},side:'pro'}}};
    const edge:DemoEdge={...relation('converted',type,'anon:converted','target'),
      to:{messageId:'target',selection:{kind:'text',start:3,len:2,text:'目标'},reference:{messageId:'target',revision:2,partId:'body',range:{start:3,end:5}}}};
    const view=renderScene([message('target'),annotation],[edge]);
    expect(view.container.querySelector('[data-msgid="converted"]:not([data-rel-overlay])')).not.toBeNull();
    expect(edge.to.reference).toEqual({messageId:'target',revision:2,partId:'body',range:{start:3,end:5}});
    view.unmount();
  });

  it.each(['recommend','archive','read','unread'] as const)('keeps votes on grouped %s badges independently reachable and collapsible',type=>{
    const annotations=['annotation-1','annotation-2'].map(id=>({...message(id),kind:'relation' as const,relationType:type}));
    const stances=(['agree-1','disagree-1','agree-2'] as const).map(id=>({...message(id),kind:'relation' as const,
      relationType:id==='disagree-1'?'disagree' as const:'agree' as const}));
    const edges=[...annotations.map(annotation=>relation(annotation.id,type,`anon:${annotation.id}`,'target')),
      ...stances.map(stance=>relation(stance.id,stance.relationType,`anon:${stance.id}`,stance.id==='agree-2'?'annotation-2':'annotation-1'))];
    const icon=vi.fn(),body=vi.fn(),details=vi.fn(),select=vi.fn();
    const view=renderScene([message('target'),...annotations,...stances],edges,{onDecorationIconClick:icon,onDecorationBodyClick:body,
      onDecorationDoubleClick:details,onMessageClick:select,onInlineBadgeClick:select});
    expect(findMessageElements(view.container,'agree-2')).toHaveLength(0);
    fireEvent.click(view.getByRole('button',{name:'显示标注 target'}));
    fireEvent.click(view.getByRole('button',{name:'显示装饰 annotation-1'}));
    const agreement=findMessageElements(view.container,'agree-1')[0],opposition=findMessageElements(view.container,'disagree-1')[0];
    expect(agreement.style.left).toBe(opposition.style.left);
    expect(parseFloat(opposition.style.top)).toBeGreaterThan(parseFloat(agreement.style.top));
    expect(agreement).toHaveStyle({width:'56px',height:'22px'});
    const second=findMessageElements(view.container,'agree-2')[0];
    fireEvent.click(within(second).getByTitle('点击：快速发送赞同'));
    expect(icon).toHaveBeenCalledExactlyOnceWith('annotation-2','agree');
    fireEvent.click(within(second).getByText('1'));
    expect(body).toHaveBeenCalledExactlyOnceWith(expect.anything(),'annotation-2','agree');
    fireEvent.doubleClick(second);
    expect(details).toHaveBeenCalledExactlyOnceWith(expect.anything(),'annotation-2','agree');
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button',{name:'收起装饰 annotation-1'}));
    expect(findMessageElements(view.container,'agree-2')).toHaveLength(0);
    const canvas=view.container.querySelector('[data-jump-canvas]')!;
    act(()=>{canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:['agree-2']}}));});
    expect(findMessageElements(view.container,'agree-2')).toHaveLength(1);
    expect(findMessageElements(view.container,'agree-1')).toHaveLength(0);
    act(()=>{canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:[]}}));});
    expect(findMessageElements(view.container,'agree-2')).toHaveLength(1);
    fireEvent.click(view.getByRole('button',{name:'收起装饰 annotation-1'}));
    expect(findMessageElements(view.container,'agree-2')).toHaveLength(0);
  });

  it.each(['read','unread'] as const)('renders an existing %s label body as an annotation beside its target instead of a separate card',type=>{
    const annotation:DemoMessage={...message('read-annotation'),kind:'relation',relationType:type,
      parts:[{id:'body',type:'text',text:type},{id:'relation',type:'relation',relation:type,roles:{target:[{id:'target',reference:{messageId:'target'}}]}}]};
    const view=renderScene([message('target'),annotation],[relation(annotation.id,type,`anon:${annotation.id}`,'target')]);
    expect(view.container.querySelector('[data-msgid="read-annotation"]:not([data-rel-overlay])')).toBeNull();
    fireEvent.click(view.getByRole('button',{name:'显示标注 target'}));
    const badge=findMessageElements(view.container,annotation.id)[0];
    expect(badge).toHaveAttribute('data-rel-overlay','true');
    expect(badge).toHaveTextContent(type==='read'?'已读':'未读');
  });

  it.each([false, true])('keeps arrangement controls visible independently of selection and restores their state after a pulse (empty=%s)', empty => {
    const frame: DemoMessage = { ...message('arrange'), kind: 'relation', relationType: 'arrange' };
    const join: Relation = { id: 'join', relationType: 'JOIN', sourceMessageId: 'parent',
      targetRefs: [{ kind: 'message', messageId: frame.id }], createdAt: '', createdBy: { id: 'u', username: 'tester', createdAt: '' } };
    const props: GraphViewProps = {
      messages: [frame, ...(!empty ? [message('member')] : []), ...(['agree', 'disagree'] as const).map(kind =>
        ({ ...message(kind), kind: 'relation' as const, relationType: kind }))],
      edges: [...(!empty ? [relation(frame.id, 'arrange', `anon:${frame.id}`, 'member')] : []),
        relation('agree', 'agree', 'anon:agree', frame.id), relation('disagree', 'disagree', 'anon:disagree', frame.id)],
      draftUnits: [], activeTextSelectId: null, lastClickedMessageId: null,
      joinRelationsByTarget: new Map([[frame.id, [join]]]), onJoinFilterClick: vi.fn(),
      onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(), onTextMouseUp: vi.fn(),
      onSettlementToggleTruth: vi.fn(), onSettlementToggleValue: vi.fn(),
      onEdgeLabelSingleClick: vi.fn(), onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(), isFragmentSelected: () => false,
    };
    const view = render(<GraphView {...props} />);
    const assertCollapsed = () => {
      expect(view.queryByRole('group', { name: '组织消息 arrange' })).toBeNull();
      expect(view.queryByRole('button', { name: '查看加入消息（1条）' })).toBeNull();
      expect(view.container.querySelector('[data-guide-settlement-entry][data-guide-target-message="arrange"]')).toBeNull();
      expect(view.queryByTitle(/^赞同：/)).toBeNull();
      expect(view.queryByTitle(/^反对：/)).toBeNull();
      for (const stance of ['agree', 'disagree']) {
        expect(findMessageElements(view.container, stance)).toHaveLength(0);
      }
    };
    assertCollapsed();
    view.rerender(<GraphView {...props} draftUnits={[{ messageId: frame.id, selection: { kind: 'whole' } }]} />);
    assertCollapsed();
    fireEvent.click(view.getByRole('button', { name: '显示排列消息卡 arrange' }));
    const header = view.getByRole('group', { name: '组织消息 arrange' });
    expect(within(header).getByRole('button', { name: '查看加入消息（1条）' })).toBeInTheDocument();
    expect(within(header).getByTitle('真假仲裁')).toBeInTheDocument();
    expect(within(header).getByTitle('价值仲裁')).toBeInTheDocument();
    expect(view.queryByTitle(/^赞同：/)).toBeNull();
    fireEvent.click(view.getByRole('button',{name:'显示装饰 arrange'}));
    expect(findMessageElements(view.container, 'agree')).toEqual([view.getByTitle(/^赞同：/)]);
    expect(findMessageElements(view.container, 'disagree')).toEqual([view.getByTitle(/^反对：/)]);
    const agreement=view.getByTitle(/^赞同：/),opposition=view.getByTitle(/^反对：/);
    expect(agreement.style.left).toBe(opposition.style.left);
    expect(parseFloat(opposition.style.top)).toBeGreaterThan(parseFloat(agreement.style.top));
    expect(agreement).toHaveStyle({width:'56px',height:'22px'});
    view.rerender(<GraphView {...props} draftUnits={[{ messageId: 'agree', selection: { kind: 'whole' } }]} />);
    expect(view.getByRole('group', { name: '组织消息 arrange' })).toBeInTheDocument();
    expect(findMessageElements(view.container, 'agree')).toHaveLength(1);
    view.rerender(<GraphView {...props} />);
    expect(view.getByRole('group', { name: '组织消息 arrange' })).toBeInTheDocument();
    fireEvent.click(view.getByRole('button',{name:'收起装饰 arrange'}));
    fireEvent.click(view.getByRole('button', { name: '收起排列消息卡 arrange' }));
    assertCollapsed();
    const canvas = view.container.querySelector('[data-jump-canvas]')!;
    act(() => { canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: ['agree'] } })); });
    expect(view.getByRole('group', { name: '组织消息 arrange' })).toBeInTheDocument();
    expect(findMessageElements(view.container, 'agree')).toEqual([view.getByTitle(/^赞同：/)]);
    expect(props.onMessageClick).not.toHaveBeenCalled();
    act(() => { canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } })); });
    expect(findMessageElements(view.container,'agree')).toHaveLength(1);
    fireEvent.click(view.getByRole('button',{name:'收起装饰 arrange'}));
    assertCollapsed();
    fireEvent.click(view.getByRole('button', { name: '显示排列消息卡 arrange' }));
    act(() => { canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: ['agree'] } })); });
    act(() => { canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } })); });
    expect(view.getByRole('group', { name: '组织消息 arrange' })).toBeInTheDocument();
    view.unmount();
  });

  it.each((['single-row', 'single-column'] as const).flatMap(targetLayout => [false, true].map(empty => ({ targetLayout, empty }))))(
    'toggles the arrangement card without changing frame selection ($targetLayout, empty=$empty)', ({ targetLayout, empty }) => {
    const frame: DemoMessage = { ...message('arrange'), kind: 'relation', relationType: 'arrange',
      relationPayload: { title: '排列消息卡', targetLayout }, parts: [{ id: 'relation', type: 'relation', relation: 'arrange', roles: {} }] };
    const props: GraphViewProps = { messages: empty ? [frame] : [frame, message('a'), message('b')],
      getMemberCounts: () => ({ direct: empty ? 0 : 2, total: empty ? 0 : 2 }),
      edges: empty ? [] : ['a', 'b'].map(id => ({ ...relation(frame.id, 'arrange', `anon:${frame.id}`, id), id })),
      draftUnits: [], activeTextSelectId: null, lastClickedMessageId: frame.id,
      onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(), onTextMouseUp: vi.fn(), onSettlementToggleTruth: vi.fn(),
      onEdgeLabelSingleClick: vi.fn(), onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(), isFragmentSelected: () => false };
    const view = render(<GraphView {...props} />);
    const card = () => view.queryByRole('group', { name: `组织消息 ${frame.id}` });
    const memberTop = () => view.container.querySelector<HTMLElement>('[data-msgid="a"]')?.style.top;
    const before = memberTop();
    expect(card()).toBeNull();
    const border = view.container.querySelector(`div[data-msgid="${frame.id}"]`)!;
    expect(border).not.toBeNull();
    fireEvent.click(border);
    expect(props.onMessageClick).toHaveBeenCalledWith(expect.anything(), frame.id);
    view.rerender(<GraphView {...props} draftUnits={[{ messageId: frame.id, selection: { kind: 'whole' } }]} />);
    expect(card()).toBeNull();
    fireEvent.click(view.getByRole('button', { name: '显示排列消息卡 arrange' }));
    expect(props.onMessageClick).toHaveBeenCalledTimes(1);
    expect(card()).not.toHaveTextContent('排列消息卡');
    expect(card()?.querySelector('[data-message-member-count]')).toHaveTextContent(`${empty ? 0 : 2} 条消息`);
    if (!empty) {
      expect(parseFloat(memberTop()!)).toBeGreaterThan(parseFloat(before!));
      const a = view.container.querySelector<HTMLElement>('[data-msgid="a"]')!, b = view.container.querySelector<HTMLElement>('[data-msgid="b"]')!;
      if (targetLayout === 'single-row') expect(a.style.top).toBe(b.style.top);
      else expect(a.style.left).toBe(b.style.left);
    }
    view.rerender(<GraphView {...props} draftUnits={[{ messageId: frame.id, selection: { kind: 'whole' },
      reference: { messageId: frame.id, partId: 'relation', path: ['roles', 'members'] } }]} />);
    expect(card()).not.toBeNull();
    fireEvent.click(view.getByRole('button', { name: '收起排列消息卡 arrange' }));
    expect(card()).toBeNull();
    expect(memberTop()).toBe(before);
    expect(view.container.querySelector(`rect[data-jump-visual-msgids="${frame.id}"]`)).not.toBeNull();
    view.unmount();
  });

  it.each((['merge', 'arrange'] as const).flatMap(type => [false, true].map(nested => ({ type, nested }))))(
    'renders an empty $type with its controls and keeps it inside its parent frame (nested=$nested)', ({ type, nested }) => {
    const merge: DemoMessage = { ...message('empty-frame'), kind: 'relation', relationType: type,
      relationPayload: { title: '原组织' }, parts: [{ id: 'relation', type: 'relation', relation: type, roles: {} }] };
    const outer: DemoMessage = { ...message('outer'), kind: 'relation', relationType: 'arrange' };
    const messages = nested ? [outer, merge] : [merge];
    const edges = nested ? [relation('outer', 'arrange', 'anon:outer', merge.id)] : [];
    const scene = projectGraphScene({ messages, edges, isTraceWindow: false, traceExpandedFrameIds: new Set() });
    expect(scene.frameBlocks.find(frame => frame.relMsgId === merge.id)?.directCardIds).toEqual(new Set());
    if (nested) expect(scene.frameBlocks.find(frame => frame.relMsgId === outer.id)?.childRelMsgIds).toEqual([merge.id]);
    const select = vi.fn(), inspect = vi.fn(), vote = vi.fn();
    const view = renderScene(messages, edges, { onMessageClick: select, onMessageDoubleClick: inspect, onSettlementToggleTruth: vote,
      getMemberCounts: id => ({ direct: id === outer.id ? 1 : 0, total: id === outer.id ? 1 : 0 }) });
    if (type === 'arrange') fireEvent.click(view.getByRole('button', { name: `显示排列消息卡 ${merge.id}` }));
    const header = view.getByRole('group', { name: `组织消息 ${merge.id}` });
    expect(header).not.toHaveTextContent('原组织');
    expect(header.querySelector('[data-message-member-count]')).toHaveTextContent('0 条消息');
    expect(view.container.querySelector(`rect[data-jump-visual-msgids="${merge.id}"]`)).not.toBeNull();
    fireEvent.click(header);
    expect(select).toHaveBeenCalledWith(expect.anything(), merge.id);
    fireEvent.doubleClick(header);
    expect(inspect).toHaveBeenCalledWith(expect.anything(), merge.id);
    fireEvent.click(within(header).getByTitle('真假仲裁'));
    expect(vote).toHaveBeenCalledWith(merge.id);
    view.unmount();
  });

  it.each((['merge', 'arrange'] as const).flatMap(type => ['rejected', 'hidden'].map(status => ({ type, status }))))(
    'does not display an empty $type when it is $status', ({ type, status }) => {
    const merge: DemoMessage = { ...message('empty-frame'), kind: 'relation', relationType: type };
    const extra = status === 'rejected' ? { rejectedContainerIds: new Set([merge.id]) } : { hideMessageIds: new Set([merge.id]) };
    const view = renderScene([merge], [], extra);
    expect(view.queryByRole('group', { name: `组织消息 ${merge.id}` })).toBeNull();
    view.unmount();
  });

  it('keeps the empty summary card with its text and controls', () => {
    const summary: DemoMessage = { ...message('summary'), kind: 'relation', relationType: 'summary',
      relationPayload: { title: '原总结' }, content: '总结正文' };
    const select = vi.fn(), inspect = vi.fn(), vote = vi.fn();
    const view = renderScene([summary], [], { onMessageClick: select, onMessageDoubleClick: inspect, onSettlementToggleTruth: vote });
    const card = view.container.querySelector<HTMLElement>('[data-msgid="summary"]:not([data-rel-overlay])')!;
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent('总结正文');
    fireEvent.click(card);
    expect(select).toHaveBeenCalledWith(expect.anything(), summary.id);
    fireEvent.doubleClick(card);
    expect(inspect).toHaveBeenCalledWith(expect.anything(), summary.id);
    fireEvent.click(within(card).getByTitle('真假仲裁'));
    expect(vote).toHaveBeenCalledWith(summary.id);
    view.unmount();
  });

  it.each([['personal','当前用户生效'],['recommended','统计生效']] as const)('distinguishes %s JOIN ownership on the graph',(source,label)=>{
    const joining:DemoMessage={...message('joining'),kind:'join',joinInfo:{containerId:'parent',containerType:'classify',targetIds:['leaf']}};
    const view=renderScene([joining],[],{showJoinRecords:true,joinStatusByMessage:new Map([['joining','valid']]),
      joinEffectSourcesByMessage:new Map([['joining',new Set([source])]])});
    expect(view.container.querySelector('[data-msgid="joining"]')).toHaveTextContent(label);
  });

  it.each([false, true])('preserves mounted card positions when later structures with different heights are revealed (edge-only frame=%s)', edgeOnlyFrame => {
    const records = Array.from({ length: 120 }, (_, index) => ({ ...message(`m-${index}`), createdAt: new Date(index * 1000).toISOString() }));
    const edges: DemoEdge[] = edgeOnlyFrame ? [
      { ...relation('virtual-frame', 'arrange', 'anon:virtual-frame', 'm-0'), id: 'virtual-0' },
      { ...relation('virtual-frame', 'arrange', 'anon:virtual-frame', 'm-119'), id: 'virtual-119' },
    ] : [];
    const plan = planMessageStructures({ messages: records, edges });
    const visible = (limit: number) => {
      const units = new Set(plan.units.slice(0, limit));
      return new Set(plan.order.filter(id => units.has(plan.byId.get(id)!)));
    };
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      const index = Number(this.dataset.msgid?.slice(2));
      return Number.isFinite(index) ? 100 + (index % 7) * 50 : 36;
    });
    try {
      const props: GraphViewProps = { messages: records, edges, structureOrder: plan.order, visibleMessageIds: visible(50), draftUnits: [],
        activeTextSelectId: null, lastClickedMessageId: null, onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(),
        onTextMouseUp: vi.fn(), onEdgeLabelSingleClick: vi.fn(), onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(), isFragmentSelected: () => false };
      const view = render(<GraphView {...props} />);
      const positions = () => [...view.container.querySelectorAll<HTMLElement>('[data-msgid]')].filter(element => visible(50).has(element.dataset.msgid!))
        .map(element => [element.dataset.msgid, element.style.left, element.style.top]);
      const before = positions();
      const canvasHeightBefore = parseFloat(view.container.querySelector<HTMLElement>('[data-jump-canvas]')!.style.height);
      expect(before).toHaveLength(edgeOnlyFrame ? 51 : 50);
      view.rerender(<GraphView {...props} visibleMessageIds={visible(100)} />);
      expect(new Set([...view.container.querySelectorAll<HTMLElement>('[data-msgid]')]
        .map(element => element.dataset.msgid).filter(id => plan.byId.has(id!) && id !== 'virtual-frame')).size).toBe(edgeOnlyFrame ? 101 : 100);
      expect(positions()).toEqual(before);
      expect(parseFloat(view.container.querySelector<HTMLElement>('[data-jump-canvas]')!.style.height)).toBeGreaterThan(canvasHeightBefore);
      view.rerender(<GraphView {...props} visibleMessageIds={visible(120)} />);
      expect(positions()).toEqual(before);
    } finally { height.mockRestore(); }
  });
  it('shows the effective correction and its decoration while preserving the stored original',()=>{
    const original:DemoMessage={...message('corrected-target'),content:'好玩吗？',parts:[{id:'body',type:'text',text:'好玩吗？'}]};
    const correction:DemoMessage={...message('correction'),kind:'relation',relationType:'correct',content:'好玩1111',
      relationPayload:{correctionBeforeContent:'好玩吗？',correctionAfterContent:'好玩1111',correctionContent:'好玩1111'},
      parts:[{id:'corrected-body',type:'text',text:'好玩1111'},{id:'relation',type:'relation',relation:'correct',roles:{target:[{id:'t',reference:{messageId:original.id}}]}}]};
    const relation:DemoEdge={id:'correction-edge',relationMessageId:correction.id,relationType:'correct',
      from:{messageId:'anon:correction',selection:{kind:'whole'}},to:{messageId:original.id,selection:{kind:'whole'}},relationLabel:'更正'};
    const shown=withCorrectionContent(original,'好玩1111');
    const stances=(['agree','disagree'] as const).map(kind=>({...message(kind),kind:'relation' as const,relationType:kind}));
    const stanceEdges:DemoEdge[]=stances.map(stance=>({id:stance.id,relationMessageId:stance.id,relationType:stance.relationType!,
      relationLabel:stance.id,from:{messageId:`anon:${stance.id}`,selection:{kind:'whole'}},to:{messageId:correction.id,selection:{kind:'whole'}}}));
    const tag:DemoMessage={...message('tag'),kind:'relation',relationType:'tag'};
    const tagEdge:DemoEdge={id:'tag-edge',relationMessageId:tag.id,relationType:'tag',relationLabel:'重要',
      from:{messageId:'anon:tag',selection:{kind:'whole'}},to:{messageId:original.id,selection:{kind:'whole'}}};
    const select=vi.fn(),graph=renderScene([shown,correction,...stances,tag],[relation,...stanceEdges,tagEdge],{onMessageClick:select});
    const card=graph.container.querySelector('[data-msgid="corrected-target"]')!;
    expect(card).toHaveTextContent('好玩1111');expect(card).not.toHaveTextContent('好玩吗？');
    expect(card.querySelector('[data-jump-msgids~="correction"]')).not.toBeNull();
    expect(graph.queryByTitle(/^标注：/)).toBeNull();
    fireEvent.click(graph.getByRole('button',{name:'显示标注 corrected-target'}));
    expect(graph.getByTitle(/^标注：/)).toHaveTextContent('重要');
    fireEvent.click(graph.getByRole('button',{name:'收起标注 corrected-target'}));
    expect(graph.queryByTitle(/^标注：/)).toBeNull();
    const canvas=graph.container.querySelector('[data-jump-canvas]')!;
    act(()=>{canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:[tag.id]}}));});
    expect(graph.getByTitle(/^标注：/)).toBeInTheDocument();
    act(()=>{canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:[]}}));});
    expect(graph.getByTitle(/^标注：/)).toBeInTheDocument();
    fireEvent.click(graph.getByRole('button',{name:'收起标注 corrected-target'}));
    expect(graph.queryByTitle(/^标注：/)).toBeNull();
    expect(graph.queryByTitle(/^赞同更正：/)).toBeNull();
    expect(graph.queryByRole('button',{name:'显示装饰 correction'})).toBeNull();
    expect(graph.queryByTitle(/^反对更正：/)).toBeNull();
    expect(select).not.toHaveBeenCalled();graph.unmount();
    const list=render(<MessageCard msg={shown} ctx={{}}/>);
    expect(list.container).toHaveTextContent('好玩1111');expect(list.container).not.toHaveTextContent('好玩吗？');
    expect(original.parts![0]).toEqual({id:'body',type:'text',text:'好玩吗？'});
  });
  it.each(['classify','summary','merge','arrange'] as const)('opens both JOIN directions from a nested %s message card',type=>{
    const group:DemoMessage={...message('group'),kind:'relation',relationType:type,relationPayload:{title:'容器'}};
    const join=(id:string,source:string,target:string):Relation=>({id,relationType:'JOIN',sourceMessageId:source,targetRefs:[{kind:'message',messageId:target}],createdAt:'2026-01-01',createdBy:{id:'u',username:'tester',createdAt:''}});
    const incoming=[join('current','outer','group'),join('historical','old','group')],outgoing=[join('member','group','leaf')];
    const open=vi.fn(),select=vi.fn(),navigate=vi.fn();
    const view=renderScene([group,message('leaf')],[relation('group',type,'anon:group','leaf')],{
      joinRelationsByTarget:new Map([['group',incoming]]),joinRelationsBySource:new Map([['group',outgoing]]),
      joinStatusByMessage:new Map([['current','valid'],['historical','superseded'],['member','valid']]),
      onJoinFilterClick:open,onMessageClick:select,onMessageDoubleClick:navigate,
    });
    if(type==='arrange')fireEvent.click(view.getByRole('button',{name:'显示排列消息卡 group'}));
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
  const vote:DemoMessage={...message('vote'),kind:'relation',relationType:'agree',parts:[{id:'body',type:'text',text:'建立关系：AGREE；目标：claim'},{id:'relation',type:'relation',relation:'agree',roles:{target:[{id:'target-0',reference:{messageId:'claim'}}]}},{id:'display',type:'display',relationPartId:'relation',layout:'relation'}],executedStance:{partId:'relation',sourceRevision:1,side:'pro',target:{messageId:'claim'}}};
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

it.each(['agree','disagree'] as const)('does not invent a %s card when the targeted annotation is hidden',type=>{
  const id=type==='disagree'?'cmt4anc26001dggsrzhe4f668':'support',annotationId='cmt00hjs200r1kysjrigj448h';
  const annotation:DemoMessage={...message(annotationId),kind:'relation',relationType:'annotation',revision:1,
    parts:[{id:'presentation',type:'display',relationPartId:'relation',layout:'relation'}],
    state:{messageId:annotationId,revision:1,suppressed:true,supportCount:1,oppositionCount:1,recommendationTotal:0}};
  const vote:DemoMessage={...message(id),kind:'relation',relationType:type,revision:1,
    parts:[{id:'body',type:'text',text:`建立关系：${type.toUpperCase()}；目标：rigj448h`},
      {id:'presentation',type:'display',relationPartId:'relation',layout:'relation'}],
    executedStance:{partId:'relation',sourceRevision:1,side:type==='agree'?'pro':'con',target:{messageId:annotationId,revision:1}}};
  // The rejected annotation's edge is absent from the ordinary graph, while
  // its declaration and the vote remain available for status and inspection.
  const input={messages:[message('claim'),annotation,vote],edges:[relation(id,type,`anon:${id}`,annotationId)],isTraceWindow:false,traceExpandedFrameIds:new Set<string>()};
  const scene=projectGraphScene(input);
  expect(scene.normalIds).toEqual(['claim',annotationId]);expect(scene.msgMap.has(id)).toBe(true);expect(scene.edgesByRelMsg.has(id)).toBe(true);
  const preview=vi.fn(),view=renderScene(input.messages,input.edges,{onRelatedMessageNavigate:preview});
  expect(view.container.querySelector(`[data-msgid="${id}"]:not([data-rel-overlay])`)).toBeNull();
  expect(view.container.querySelector(`[data-msgid="${annotationId}"]:not([data-rel-overlay])`)).not.toBeNull();
  fireEvent.click(view.getByRole('button',{name:'查看有效时的效果'}));expect(preview).toHaveBeenCalledWith(annotationId);
  fireEvent.click(view.getByRole('button',{name:`显示装饰 ${annotationId}`}));
  expect(findMessageElements(view.container,id).length).toBeGreaterThan(0);
  expect(projectGraphScene({...input,standaloneMessageIds:new Set([id])}).normalIds).toContain(id);
  const withBody={...vote,parts:[{id:'reason',type:'text' as const,text:'我补充了一段表态理由'}]};
  expect(projectGraphScene({...input,messages:[input.messages[0],annotation,withBody]}).normalIds).toContain(id);
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

it('keeps a rejected container visible as a separate card as well as its related entry',()=>{
 const claim=message('claim'),container:DemoMessage={...message('category'),kind:'relation',relationType:'classify',targetRefs:[{kind:'message',messageId:'claim'}],state:{messageId:'category',revision:1,suppressed:true,supportCount:0,oppositionCount:1,recommendationTotal:0}};
 const input={messages:[claim,container],edges:[relation('category','classify','anon:category','claim')],isTraceWindow:false,traceExpandedFrameIds:new Set<string>()};
 expect(projectGraphScene(input).normalIds).toEqual(['claim','category']);
 expect(projectGraphScene({...input,standaloneMessageIds:new Set(['category'])}).normalIds).toEqual(['claim','category']);
 const {container:dom,getByText}=renderScene(input.messages,input.edges);
 expect(dom.querySelector('[data-msgid="category"]')).toBeTruthy();
 expect(dom.querySelector('[data-related-message-id="category"]')).toBeNull();
 fireEvent.click(getByText('▸ 被反对的容器：1'));
 expect(dom.querySelector('[data-related-message-id="category"]')).toBeTruthy();
 const inspected=renderScene(input.messages,[],{standaloneMessageIds:new Set(['category']),getMemberCounts:()=>({direct:1,total:1})});
 expect(inspected.container.querySelector('[data-msgid="category"]')?.textContent).toContain('1 条消息');
});

it('allows inspecting a personally rejected merge even when its global state is not suppressed',()=>{
 const claim=message('claim'),group:DemoMessage={...message('merge'),kind:'relation',relationType:'merge',parts:[]};
 const input={messages:[claim,group],edges:[],isTraceWindow:false,traceExpandedFrameIds:new Set<string>(),rejectedContainerIds:new Set(['merge'])};
 expect(projectGraphScene(input).normalIds).toEqual(['claim','merge']);
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

it('replaces the scope bar with contextual frames in paired review while retaining single-side navigation',()=>{
  const leaveScope=vi.fn();
  const scopeHeader=<section data-testid="scope-header">分类 A<button onClick={leaveScope}>退出分类</button></section>;
  const pair=renderScene([message('leaf')],[],{comparisonPair:true,comparisonScopeHeader:scopeHeader});
  const agree=pair.container.querySelector('[data-comparison-view="agree"]') as HTMLElement;
  const frameStyle=agree.style.cssText,headerStyle=(agree.firstElementChild as HTMLElement).style.cssText;
  expect(pair.queryByTestId('scope-header')).toBeNull();
  expect(pair.queryByRole('button',{name:'退出分类'})).toBeNull();
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
  fireEvent.click(within(agree as HTMLElement).getByRole('button',{name:/其他相关消息：1/}));
  const popup=within(screen.getByRole('dialog',{name:'其他相关消息：1'}));
  expect(popup.getByRole('group',{name:'指向本消息的关联'})).toHaveTextContent('【引用】 R');
  fireEvent.click(popup.getByRole('button',{name:'查看'}));expect(open).toHaveBeenCalledWith('R');
});

it.each(['reference','reply','annotation'] as const)('shows both endpoints of a cross-canvas %s and hides rows once its complete edge is rendered',type=>{
  const source=message('source'),target=message('target');
  const rel:DemoMessage={...message('relation'),kind:'relation',relationType:type};
  const link=relation('relation',type,'source','target');
  for(const [endpoint,direction] of [[source,'发出的关联'],[target,'指向本消息的关联']] as const){
    const view=renderScene([endpoint],[],{relatedMessages:[source,target,rel],relatedEdges:[link]});
    const card=within(view.container.querySelector(`[data-msgid="${endpoint.id}"]`) as HTMLElement);
    fireEvent.click(card.getByRole('button',{name:/其他相关消息：1/}));
    expect(within(view.getByRole('dialog',{name:'其他相关消息：1'})).getByRole('group',{name:direction})).toHaveTextContent('relation');
    view.unmount();
  }
  const sameCanvas=renderScene([source,target,rel],[link],{relatedMessages:[source,target,rel],relatedEdges:[link]});
  expect(sameCanvas.queryByRole('button',{name:/相关消息/})).toBeNull();
});
