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
      expect(view.getByRole('button',{name:id==='agree'?'显示标注 target':'显示装饰 target'})).toHaveAttribute('aria-expanded','false');
      act(()=>{canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:{ids:[]}}));});
    }
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
      expect(findMessageElements(view.container,type)).toHaveLength(0);
    }
    fireEvent.click(view.getByRole('button',{name:'显示标注 category'}));
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
    expect(card()).toHaveTextContent('排列消息卡');
    expect(card()).toHaveTextContent(`💬${empty ? 0 : 2}`);
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
    const view = renderScene(messages, edges, { onMessageClick: select, onMessageDoubleClick: inspect, onSettlementToggleTruth: vote });
    if (type === 'arrange') fireEvent.click(view.getByRole('button', { name: `显示排列消息卡 ${merge.id}` }));
    const header = view.getByRole('group', { name: `组织消息 ${merge.id}` });
    expect(header).toHaveTextContent('原组织');
    expect(header).toHaveTextContent('💬0');
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
    const view=renderScene([joining],[],{joinStatusByMessage:new Map([['joining','valid']]),
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
