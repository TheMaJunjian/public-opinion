import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { discussionBranchKey } from '../pages/workbench/model/discussionBranches';
import { discussionLabels } from '../utils/discussionTypes';
import { PART_SELECTION_EVENT } from '../utils/messageElementSelection';
import { layoutDiscussion } from '../utils/discussionLayout';
import { summarizeDiscussionEdges } from '../utils/discussionSummaries';
import { isDiscussionView } from '../utils/discussionView';
import { rectsIntersect } from '../utils/graphEdgeGeometry';
import { REVEAL_VIRTUAL_MESSAGE } from '../hooks/useVirtualMessageMounts';

const body = (id: string): DemoMessage => ({ id, kind: 'normal', author: 'fixture', content: id, createdAt: '',
  parts: [{ id: 'body', type: 'text', text: id }] });
function relation(id: string, type: DemoEdge['relationType'], source: string, target = 'root') {
  const record: DemoMessage = { ...body(id), kind: 'relation', relationType: type,
    parts: [{ id: 'relation', type: 'relation', relation: type, roles: {
      source: [{ id: 'source', reference: { messageId: source } }], target: [{ id: 'target', reference: { messageId: target } }],
    } }] };
  const edge: DemoEdge = { id: `${id}:edge`, relationMessageId: id, relationType: type, relationLabel: type,
    from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } } };
  return { record, edge };
}
const handlers = (): Omit<GraphViewProps, 'messages' | 'edges'> => ({ draftUnits: [], activeTextSelectId: null, lastClickedMessageId: null,
  onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(), onTextMouseUp: vi.fn(), onEdgeLabelSingleClick: vi.fn(),
  onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(), isFragmentSelected: () => false });

describe('four independent lightweight stance regions', () => {
  it.each(['reply', 'agree', 'disagree', 'recommend', 'archive'] as const)('temporarily reveals only the navigated %s record without opening a related view', async type => {
    const links = [relation('first', type, 'one'), relation('second', type, 'two')];
    const onRelatedRelationView = vi.fn();
    const ui = render(<div data-workbench-left-panel><GraphView {...handlers()}
      messages={[body('root'), body('one'), body('two'), ...links.map(link => link.record)]}
      edges={links.map(link => link.edge)} discussionView={{ mode: 'discussion', collapsed: [] }}
      onRelatedRelationView={onRelatedRelationView} /></div>);
    const host = ui.container.querySelector('[data-workbench-left-panel]')!;
    const original = (id: string) => ui.container.querySelector(`[data-directed-edge-label="${id}"]`);
    const reveal = (ids: string[]) => fireEvent(host, new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids } }));
    const summary = await screen.findByRole('button', { name: `汇总${discussionLabels[type]}：2` });
    expect(original('first')).toBeNull(); expect(original('second')).toBeNull();
    // Locating a text card also mounts its related labels, but must keep summaries intact.
    reveal(['one']);
    expect(original('first')).toBeNull(); expect(original('second')).toBeNull();
    reveal(['first']);
    await waitFor(() => expect(original('first')).not.toBeNull());
    expect(original('second')).toBeNull();
    expect(screen.getByRole('button', { name: `汇总${discussionLabels[type]}：2` })).toBe(summary);
    reveal([]);
    await waitFor(() => expect(original('first')).toBeNull());
    expect(onRelatedRelationView).not.toHaveBeenCalled();
  });

  it('keeps the summary label and its hit area clear of expanded recommendation and cold badges', async () => {
    const archived=relation('archived','archive','one'),recommended=relation('recommended','recommend','anon:recommended');
    const ui=render(<GraphView {...handlers()} messages={[body('root'),body('one'),archived.record,recommended.record]}
      edges={[archived.edge,recommended.edge]} discussionView={{mode:'discussion',collapsed:[]}}
      standaloneMessageIds={new Set(['archived'])} highlightedMessageIds={new Set(['root'])}/>);
    const box=(element:HTMLElement)=>({x:parseFloat(element.style.left),y:parseFloat(element.style.top),width:parseFloat(element.style.width),height:parseFloat(element.style.height)});
    const summary=()=>ui.container.querySelector<HTMLElement>('[data-discussion-summary-label]')!;
    const assertClear=()=>{
      const badges=[...ui.container.querySelectorAll<HTMLElement>('[data-skin-decoration="annotation"]')];
      expect(badges.map(badge=>badge.textContent)).toEqual(expect.arrayContaining(['冷藏','推荐']));
      for(const badge of badges)expect(rectsIntersect(box(summary()),box(badge)),badge.textContent!).toBe(false);
    };
    await waitFor(assertClear);
    fireEvent.click(screen.getByRole('button',{name:'收起标注 root'}));
    await waitFor(()=>expect(ui.container.querySelector('[data-skin-decoration="annotation"]')).toBeNull());
    fireEvent.click(screen.getByRole('button',{name:'显示标注 root'}));
    await waitFor(assertClear);
  });

  it.each(['summary','related'] as const)('marks the trace relation green in the %s popup and follows changes to the current trace', async entry => {
    const links=[relation('first','reply','one'),relation('second','reply','two')];
    const props={...handlers(),messages:[body('root'),body('one'),body('two'),...links.map(link=>link.record)],
      edges:links.map(link=>link.edge),discussionView:{mode:'discussion' as const,collapsed:[]}};
    const ui=render(<GraphView {...props} highlightedMessageIds={new Set(['first'])}/>);
    await screen.findByRole('button',{name:'汇总回复：2'});
    if(entry==='summary')fireEvent.click(screen.getByRole('button',{name:'汇总回复：2'}));
    else fireEvent.click(within(ui.container.querySelector<HTMLElement>('.themed-message[data-msgid="root"]')!).getByRole('button',{name:/其他相关消息：2/}));
    const row=(id:string)=>screen.getByRole('dialog').querySelector(`[data-related-relation-id="${id}"]`)!;
    expect(row('first')).toHaveAttribute('data-view-target','true');
    expect(row('second')).not.toHaveAttribute('data-view-target');
    ui.rerender(<GraphView {...props} highlightedMessageIds={new Set(['second'])}/>);
    expect(row('first')).not.toHaveAttribute('data-view-target');
    expect(row('second')).toHaveAttribute('data-view-target','true');
    ui.rerender(<GraphView {...props} highlightedMessageIds={new Set()}/>);
    expect(screen.getByRole('dialog').querySelector('[data-view-target]')).toBeNull();
  });

  it.each(['reply','agree','disagree','recommend','archive'] as const)('keeps a viewed %s source in the right-hand column inside an expanded flow classification', async type => {
    const link=relation('original',type,'one');
    const topic:DemoMessage={...body('topic'),kind:'relation',relationType:'classify',parts:[
      {id:'body',type:'text',text:'分类'}, {id:'display',type:'display',relationPartId:'members',layout:'flow'},
    ]};
    const membership:DemoEdge[]=['one','root'].map(id=>({id:`topic:${id}`,relationMessageId:'topic',relationType:'classify',relationLabel:'分类',
      from:{messageId:'anon:topic',selection:{kind:'whole'}},to:{messageId:id,selection:{kind:'whole'}}}));
    const props={...handlers(),messages:[body('root'),body('one'),link.record,topic],edges:[...membership,link.edge],
      traceFrameIds:new Set(['topic']),traceExpandedFrameIds:new Set(['topic']),standaloneMessageIds:new Set(['original'])};
    const ui=render(<GraphView {...props} discussionView={{mode:'discussion',collapsed:[]}} />);
    const region=()=>ui.container.querySelector<HTMLElement>(`[data-discussion-region-type="${type}"]`)!;
    const card=(id:string)=>ui.container.querySelector<HTMLElement>(`.themed-message[data-msgid="${id}"]`)!;
    await waitFor(()=>expect(region()).not.toBeNull());
    expect(parseFloat(card('one').style.left)).toBeGreaterThanOrEqual(parseFloat(card('root').style.left)+parseFloat(card('root').style.width));
    expect(parseFloat(region().style.left)).toBeGreaterThan(parseFloat(card('root').style.left));
    expect(ui.container.querySelector('[data-directed-edge-label="original"]')).not.toBeNull();
    if(type==='archive'||type==='recommend')expect(card('original')).toBeNull();
    ui.rerender(<GraphView {...props} discussionView={{mode:'discussion',collapsed:[discussionBranchKey('root',type)]}} />);
    await waitFor(()=>expect(card('one')).toBeNull());
    expect(region()).toHaveAttribute('data-discussion-collapsed','true');
  });

  it.each(['reply','agree','disagree','recommend','archive'] as const)('toggles an original %s edge from the related list while preserving its region and other summaries', async type => {
    const links=[relation('first',type,'one'),relation('second',type,'two')];
    const ui=render(<GraphView {...handlers()} messages={[body('root'),body('one'),body('two'),...links.map(link=>link.record)]}
      edges={links.map(link=>link.edge)} discussionView={{mode:'discussion',collapsed:[]}} />);
    const label=discussionLabels[type];
    const summary=await screen.findByRole('button',{name:`汇总${label}：2`});
    const selectedParts=()=>[...ui.container.querySelectorAll('[data-discussion-summary-edge],[data-discussion-summary-text],[data-discussion-summary-label]')];
    const region=ui.container.querySelector('[data-discussion-region]');
    const card=ui.container.querySelector('.themed-message[data-msgid="one"]');
    const original=(id:string)=>ui.container.querySelector(`[data-directed-edge-label="${id}"]`);
    expect(original('first')).toBeNull();expect(original('second')).toBeNull();
    fireEvent.click(summary);
    expect(selectedParts()).toHaveLength(3);
    for(const part of selectedParts())expect(part).toHaveAttribute('data-label-selection','whole');
    const path=ui.container.querySelector('.relation-edge-path')!;
    expect(path).toHaveAttribute('stroke','var(--edge-selection-accent, var(--selection-accent))');
    const row=screen.getByRole('dialog').querySelector<HTMLElement>('[data-related-relation-id="first"]')!;
    fireEvent.click(within(row).getByRole('button',{name:`显示原始${label}关系 first`}));
    await waitFor(()=>expect(original('first')).not.toBeNull());
    expect(within(row).getByRole('button',{name:`隐藏原始${label}关系 first`})).toHaveTextContent('汇 · 显示');
    expect(original('second')).toBeNull();
    expect(ui.container.querySelector('[data-discussion-region]')).toBe(region);
    expect(ui.container.querySelector('.themed-message[data-msgid="one"]')).toBe(card);
    expect(screen.getByRole('button',{name:`汇总${label}：2`})).toBe(summary);
    fireEvent.click(within(row).getByRole('button',{name:`隐藏原始${label}关系 first`}));
    await waitFor(()=>expect(original('first')).toBeNull());
    expect(within(row).getByRole('button',{name:`显示原始${label}关系 first`})).toHaveTextContent('汇 · 隐藏');
    fireEvent.click(screen.getByRole('button',{name:'关闭其他相关消息'}));
    for(const part of selectedParts())expect(part).not.toHaveAttribute('data-label-selection');
    expect(path).not.toHaveAttribute('stroke','var(--edge-selection-accent, var(--selection-accent))');
  });

  it('keeps native relation-only cold records as badges without counting generated previews as discussion text', async () => {
    const cold=relation('cold','archive','anon:cold');
    cold.record.parts!.push({id:'preview',type:'text',text:'建立关系：ARCHIVE；目标：root'},
      {id:'presentation',type:'display',relationPartId:'relation',layout:'relation'});
    const recommendation=relation('recommendation','recommend','note','cold');
    const ui=render(<GraphView {...handlers()} messages={[body('root'),body('note'),cold.record,recommendation.record]}
      edges={[cold.edge,recommendation.edge]} standaloneMessageIds={new Set(['cold'])} highlightedMessageIds={new Set(['cold','root'])}
      discussionView={{mode:'discussion',collapsed:[]}} />);
    await waitFor(()=>expect(ui.container.querySelector('[data-skin-decoration="annotation"][data-msgid="cold"]')).not.toBeNull());
    expect(ui.container.querySelector('.themed-message[data-msgid="cold"]')).toBeNull();
    expect(ui.container.querySelector('[data-discussion-region-type="archive"]')).toBeNull();
    expect(screen.queryByRole('button',{name:/汇总冷藏/})).toBeNull();
    expect(ui.container.textContent).not.toContain('建立关系：ARCHIVE');
  });

  it('summarizes direct replies and toggles only the system summary from the region header', async () => {
    const links = [relation('reply-one', 'reply', 'one'), relation('reply-two', 'reply', 'two'),
      relation('nested-reply', 'reply', 'nested', 'one'), relation('note-link', 'annotation', 'note', 'one')];
    const messages = [body('root'), body('one'), body('two'), body('nested'), body('note'), ...links.map(link => link.record)];
    const props = { ...handlers(), messages, edges: links.map(link => link.edge), onRelatedRelationView: vi.fn() };
    function Controlled() {
      const [view, setView] = useState({ mode: 'discussion' as 'graph' | 'discussion', collapsed: [] as readonly string[] });
      return <GraphView {...props} discussionView={view} onDiscussionViewChange={setView} />;
    }
    const ui = render(<Controlled />), original = JSON.stringify([messages, props.edges]);
    const key = discussionBranchKey('root', 'reply');
    const summary = () => [...ui.container.querySelectorAll<HTMLElement>('[data-discussion-summary-label]')].find(node => node.dataset.discussionSummaryLabel === key);
    const originalLabel = (id: string) => ui.container.querySelector(`[data-directed-edge-label="${id}"]`);
    await waitFor(() => expect(summary()).toBeDefined());
    expect(within(summary()!).getByRole('button', { name: '汇总回复：2' })).toBeInTheDocument();
    const summaryPath=[...ui.container.querySelectorAll('[data-discussion-summary-edge]')].find(node=>node.getAttribute('data-discussion-summary-edge')===key)!;
    expect(summaryPath.querySelector('.relation-edge-label-link')).toBeNull();
    expect(summaryPath.querySelector('.relation-edge-label-anchor')).toBeNull();
    const summaryPlate=[...ui.container.querySelectorAll('[data-discussion-summary-text]')].find(node=>node.getAttribute('data-discussion-summary-text')===key)!.querySelector<SVGRectElement>('.graph-edge-label-plate')!;
    expect(summaryPlate.style.display).toBe('block');
    expect(summaryPlate.style.stroke).toBe(summaryPath.querySelector('.relation-edge-path')!.getAttribute('stroke'));
    expect(summary()!.style.background).toBe('');
    expect(within(summary()!).getByRole('button').style.background).toBe('transparent');
    for (const id of ['reply-one', 'reply-two', 'nested-reply']) expect(originalLabel(id)).toBeNull();
    expect(originalLabel('note-link')).not.toBeNull();
    const canvas = ui.container.querySelector<HTMLElement>('[data-jump-canvas]')!;
    const revision = canvas.dataset.layoutRevision, card = ui.container.querySelector('.themed-message[data-msgid="one"]');
    const hide = screen.getByRole('button', { name: '隐藏回复汇总关系 root' });
    expect(hide).toHaveAttribute('aria-pressed', 'true'); expect(Number(hide.style.zIndex)).toBeLessThan(11);
    fireEvent.mouseDown(hide); fireEvent.mouseUp(hide); fireEvent.click(hide);
    expect(summary()).toBeUndefined();
    expect(screen.getByRole('button', { name: '显示回复汇总关系 root' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '收起回复分支 root' })).toHaveAttribute('aria-expanded', 'true');
    expect(ui.container.querySelector('.themed-message[data-msgid="one"]')).toBe(card);
    expect(canvas.dataset.layoutRevision).toBe(revision);
    expect(screen.getByRole('button', { name: /汇总回复：1/ })).toBeInTheDocument();
    for (const id of ['reply-one', 'reply-two']) expect(originalLabel(id)).toBeNull();
    expect(props.onMessageClick).not.toHaveBeenCalled(); expect(props.onEdgeLabelSingleClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '收起回复分支 root' }));
    await waitFor(() => expect(ui.container.querySelector('.themed-message[data-msgid="one"]')).toBeNull());
    expect(screen.getByRole('button', { name: '显示回复汇总关系 root' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: '展开回复分支 root' }));
    await waitFor(() => expect(ui.container.querySelector('.themed-message[data-msgid="one"]')).not.toBeNull());
    expect(summary()).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '显示回复汇总关系 root' }));
    expect(summary()).toHaveAttribute('data-system-summary', 'true');
    fireEvent.click(within(summary()!).getByRole('button'));
    const popup = screen.getByRole('dialog');
    expect(within(popup).getAllByText('汇 · 隐藏')).toHaveLength(2);
    const row = popup.querySelector<HTMLElement>('[data-related-relation-id="reply-one"]')!;
    const selected = vi.fn(); window.addEventListener(PART_SELECTION_EVENT, selected);
    fireEvent.click(within(row).getByRole('button', { name: '选择相关回复消息' }));
    expect(selected.mock.calls[0][0].detail.reference).toEqual({ messageId: 'reply-one', revision: undefined });
    window.removeEventListener(PART_SELECTION_EVENT, selected);
    fireEvent.click(within(row).getByRole('button', { name: '查看' }));
    expect(props.onRelatedRelationView).toHaveBeenCalledWith('reply-one');
    expect(JSON.stringify([messages, props.edges])).toBe(original);
    ui.rerender(<GraphView {...props} discussionView={{ mode: 'graph', collapsed: [] }} />);
    await waitFor(() => expect(originalLabel('reply-one')).not.toBeNull());
    expect(ui.container.querySelector('[data-discussion-summary-toggle]')).toBeNull();
  });

  it('keeps an upper-left arrangement frame and its fold entry below the region title, including after expanding its card', async () => {
    const arrange: DemoMessage = { ...body('arrangement'), kind: 'relation', relationType: 'arrange',
      parts: [{ id: 'members', type: 'relation', relation: 'arrange', roles: { members: [
        { id: 'one', reference: { messageId: 'member-one' } }, { id: 'two', reference: { messageId: 'member-two' } },
      ] } }] };
    const memberEdges: DemoEdge[] = ['member-one', 'member-two'].map(id => ({ id: `arrange:${id}`, relationMessageId: arrange.id,
      relationType: 'arrange', relationLabel: 'arrange', from: { messageId: 'anon:arrangement', selection: { kind: 'whole' } },
      to: { messageId: id, selection: { kind: 'whole' } } }));
    const support = relation('support-frame', 'agree', arrange.id);
    const ui = render(<GraphView {...handlers()} messages={[body('root'), body('member-one'), body('member-two'), arrange, support.record]}
      edges={[...memberEdges, support.edge]} discussionView={{ mode: 'discussion', collapsed: [] }} />);
    const check = () => {
      const region = ui.container.querySelector<HTMLElement>('[data-discussion-region-type="agree"]')!;
      const toggle = ui.container.querySelector<HTMLElement>('[data-arrange-card-toggle="arrangement"]')!;
      expect(region).not.toBeNull(); expect(toggle).not.toBeNull();
      const titleBottom = parseFloat(region.style.top) + Number(region.dataset.discussionHeaderHeight);
      expect(parseFloat(toggle.style.top)).toBeGreaterThan(titleBottom);
      expect(parseFloat(toggle.style.left)).toBeGreaterThan(parseFloat(region.style.left));
      const frame=ui.container.querySelector('rect[data-jump-visual-msgids="arrangement"]')!;
      expect(parseFloat(toggle.style.top)+parseFloat(toggle.style.height)).toBe(Number(frame.getAttribute('y')));
      expect(Number(frame.getAttribute('x'))-parseFloat(region.style.left)).toBe(4);
      expect(parseFloat(toggle.style.left)).toBeLessThan(Number(frame.getAttribute('x'))+Number(frame.getAttribute('width'))/2);
      const card=ui.container.querySelector<HTMLElement>('[data-frame-header][data-msgid="arrangement"]');
      if(card)expect(parseFloat(card.style.top)-parseFloat(toggle.style.top)-parseFloat(toggle.style.height)).toBe(8);
    };
    await waitFor(check);
    fireEvent.click(ui.container.querySelector('[data-arrange-card-toggle="arrangement"]')!);
    await waitFor(() => expect(ui.container.querySelector('[data-frame-header][data-msgid="arrangement"]')).not.toBeNull());
    check();
  });

  it.each(['reply', 'agree', 'disagree', 'recommend', 'archive'] as const)('summarizes %s arrows emitted by messages inside a native arrangement', async type => {
    const arrangement: DemoMessage = { ...body('arrangement'), kind: 'relation', relationType: 'arrange', parts: [
      { id: 'members', type: 'relation', relation: 'arrange', roles: { members: ['one', 'two'].map(id => ({ id, reference: { messageId: id } })) } },
    ] };
    const memberEdges: DemoEdge[] = ['one', 'two'].map(id => ({ id: `arrange:${id}`, relationMessageId: arrangement.id, relationType: 'arrange', relationLabel: 'arrange',
      from: { messageId: 'anon:arrangement', selection: { kind: 'whole' } }, to: { messageId: id, selection: { kind: 'whole' } } }));
    const links = [relation('one-link', type, 'one'), relation('two-link', type, 'two')];
    const ui = render(<GraphView {...handlers()} messages={[body('root'), body('one'), body('two'), arrangement, ...links.map(link => link.record)]}
      edges={[...memberEdges, ...links.map(link => link.edge)]} discussionView={{ mode: 'discussion', collapsed: [] }} />);
    await waitFor(() => expect(screen.getByRole('button', { name: `汇总${discussionLabels[type]}：2` })).toBeInTheDocument());
    for (const id of ['one-link', 'two-link']) expect(ui.container.querySelector(`[data-directed-edge-label="${id}"]`)).toBeNull();
    expect(ui.container.querySelector('[data-arrange-card-toggle="arrangement"]')).not.toBeNull();
  });

  it('counts two archive bodies without counting an annotation attached to one as another archive', async () => {
    const links = [relation('archive-one', 'archive', 'one'), relation('archive-two', 'archive', 'two'), relation('note-link', 'annotation', 'note', 'one')];
    const messages = [body('root'), body('one'), body('two'), body('note'), ...links.map(link => link.record)];
    const props = { ...handlers(), messages, edges: links.map(link => link.edge) };
    function Controlled() {
      const [view, setView] = useState({ mode: 'discussion' as 'graph' | 'discussion', collapsed: [] as readonly string[] });
      return <GraphView {...props} discussionView={view} onDiscussionViewChange={setView} />;
    }
    const ui = render(<Controlled />);
    const region = () => ui.container.querySelector<HTMLElement>('[data-discussion-region-type="archive"]');
    await waitFor(() => expect(region()).toHaveAttribute('data-discussion-text-archive', '2'));
    expect(region()).toHaveAttribute('data-discussion-text-total', '3');
    expect(screen.getByRole('button', { name: '收起冷藏分支 root' })).toHaveTextContent('冷藏 2 条');
    expect(ui.container.querySelector('.themed-message[data-msgid="note"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '收起冷藏分支 root' }));
    await waitFor(() => expect(ui.container.querySelector('.themed-message[data-msgid="note"]')).toBeNull());
    expect(region()).toHaveAttribute('data-discussion-text-archive', '2');
    fireEvent.click(screen.getByRole('button', { name: '展开冷藏分支 root' }));
    await waitFor(() => expect(ui.container.querySelector('.themed-message[data-msgid="note"]')).not.toBeNull());
    expect(region()).toHaveAttribute('data-discussion-text-archive', '2');
  });
  it('renders and folds each relation independently, keeps nested regions, and exposes original hidden relationships', async () => {
    const types = ['agree', 'disagree', 'recommend', 'archive', 'reply'] as const;
    const links = types.map(type => relation(`${type}-record`, type, `${type}-body`));
    links.push(relation('nested-record', 'archive', 'nested-body', 'agree-body'));
    const reference = relation('independent-reference', 'reference', 'reference-body');
    const messages = [body('root'), ...types.map(type => body(`${type}-body`)), body('nested-body'), body('reference-body'), reference.record, ...links.map(link => link.record)];
    const props = { ...handlers(), messages, edges: [...links.map(link => link.edge), reference.edge], onRelatedRelationView: vi.fn() };
    function Controlled() {
      const [view, setView] = useState({ mode: 'discussion' as 'graph' | 'discussion', collapsed: [] as readonly string[] });
      return <GraphView {...props} discussionView={view} onDiscussionViewChange={setView} />;
    }
    const ui = render(<Controlled />);
    await waitFor(() => expect(ui.container.querySelectorAll('[data-discussion-region]')).toHaveLength(6));
    expect(ui.container.querySelectorAll('[data-discussion-summary-edge]')).toHaveLength(6);
    expect(ui.container.querySelector('[data-discussion-region-type="reference"]')).toBeNull();
    expect(ui.container.querySelector('[data-directed-edge-label="independent-reference"]')).not.toBeNull();
    for (const visual of ui.container.querySelectorAll('[data-discussion-summary-edge]')) {
      expect(visual.querySelector('.relation-edge-path')).not.toBeNull();
      expect(visual.querySelector('.relation-edge-arrow')).not.toBeNull();
      expect(visual.querySelector('.skin-edge-art')).toHaveAttribute('pointer-events', 'none');
    }
    expect([...ui.container.querySelectorAll('[data-discussion-summary-text] .graph-edge-label-text')].map(element => element.textContent))
      .toEqual(expect.arrayContaining(types.map(type => `汇总${discussionLabels[type]}`)));
    for (const type of types) {
      const key = discussionBranchKey('root', type);
      const region = [...ui.container.querySelectorAll<HTMLElement>('[data-discussion-region]')].find(node => node.dataset.discussionRegion === key)!;
      expect(region).toHaveAttribute(`data-discussion-text-${type}`, '1');
      expect(region.style.borderLeft).not.toBe(''); expect(region.style.background).toBe('');
      expect(region.style.borderTopWidth).toBe('1px');
      expect(region.querySelector('button')!.style.borderWidth).toBe('1px');
      expect(Number(region.querySelector('button')!.style.zIndex)).toBeLessThan(11);
      expect(ui.container.querySelector(`[data-directed-edge-label="${type}-record"]`)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: `收起${discussionLabels[type]}分支 root` }));
      await waitFor(() => expect(ui.container.querySelector(`.themed-message[data-msgid="${type}-body"]`)).toBeNull());
      for (const other of types.filter(value => value !== type)) expect(ui.container.querySelector(`.themed-message[data-msgid="${other}-body"]`)).not.toBeNull();
      fireEvent.click(screen.getByRole('button', { name: `展开${discussionLabels[type]}分支 root` }));
      await waitFor(() => expect(ui.container.querySelector(`.themed-message[data-msgid="${type}-body"]`)).not.toBeNull());
    }
    fireEvent.click(screen.getByRole('button', { name: /汇总支持：1/ }));
    const row = screen.getByRole('button', { name: '选择相关支持消息' });
    expect(screen.getByText('汇 · 隐藏')).toBeInTheDocument();
    const selected = vi.fn(); window.addEventListener(PART_SELECTION_EVENT, selected);
    fireEvent.click(row);
    expect(selected.mock.calls[0][0].detail.reference).toEqual({ messageId: 'agree-record', revision: undefined });
    window.removeEventListener(PART_SELECTION_EVENT, selected);
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(props.onRelatedRelationView).toHaveBeenCalledWith('agree-record');
    expect(isDiscussionView({ mode: 'discussion', collapsed: types.map(type => discussionBranchKey('root', type)) })).toBe(true);
  });

  it('omits empty fold entries while retaining a pure vote and its native identity even with a saved fold', async () => {
    const vote = relation('pure-vote', 'agree', 'anon:pure-vote');
    const ui = render(<GraphView {...handlers()} messages={[body('root'), vote.record]} edges={[vote.edge]}
      discussionView={{ mode: 'discussion', collapsed: [discussionBranchKey('root', 'agree')] }} />);
    await waitFor(() => expect(ui.container.querySelector('.themed-message[data-msgid="root"]')).not.toBeNull());
    expect(ui.container.querySelector('[data-discussion-region]')).toBeNull();
    expect(ui.container.querySelector('[data-decoration-toggle="root"]')).not.toBeNull();
    expect(ui.container.querySelector('[data-discussion-summary-edge]')).toBeNull();
  });

  it('skips geometry for a closed subtree while preserving complete ownership and text membership', () => {
    const count = 2000;
    const nodes = Array.from({ length: count }, (_, index) => ({ id: String(index), sequence: index, width: 320, height: 100 }));
    const links = nodes.slice(1).map((node, index) => relation(`r${index}`, 'agree', node.id, String(index)).edge);
    const regions = nodes.slice(0, -1).map(node => ({ key: discussionBranchKey(node.id, 'agree'), targetId: node.id, type: 'agree' as const,
      collapsed: node.id === '0', directCount: 1 }));
    const result = layoutDiscussion(nodes, links, { regions, textIds: new Set(nodes.map(node => node.id)) });
    expect(result.measuredItems).toBe(1); expect(result.positions.size).toBe(1);
    expect(result.parent.size).toBe(count - 1); expect(result.ownerRegionById.size).toBe(count - 1);
    expect(result.regions).toHaveLength(1); expect(result.hiddenIds).toHaveLength(count - 1);
  });

  it('retains fragment and revision-specific edges instead of silently merging their addresses', () => {
    const links = ['whole', 'fragment', 'revision'].map(id => relation(id, 'agree', `${id}-body`));
    links[1].edge.to = { messageId: 'root', selection: { kind: 'text', start: 0, len: 2, text: 'ro' } };
    links[2].edge.to.reference = { messageId: 'root', revision: 2 };
    const key = discussionBranchKey('root', 'agree');
    const messages = [body('root'), ...links.map(link => body(link.edge.from.messageId)), ...links.map(link => link.record)];
    const original = JSON.stringify(links);
    const result = summarizeDiscussionEdges({ messages, edges: links.map(link => link.edge),
      ownerRegions: Object.fromEntries(links.map(link => [link.edge.from.messageId, key])),
      regions: [{ key, targetId: 'root', type: 'agree', collapsed: false, directCount: 3, x: 420, y: 0, width: 320, height: 200, headerHeight: 24 }] });
    expect([...result.hiddenEdgeIds]).toEqual(['whole:edge']);
    expect(result.summaries[0].recordIds).toEqual(['whole']); expect(JSON.stringify(links)).toBe(original);
  });

  it.each(['agree', 'disagree', 'recommend', 'archive'] as const)('summarizes %s stance/expression edges pinned to the current whole message while retaining historical and part targets', type => {
    const current = relation('current', type, 'current-source'), historical = relation('historical', type, 'historical-source'), part = relation('part', type, 'part-source');
    const reference = relation('reference', 'reference', 'reference-source');
    const target: NonNullable<DemoEdge['to']['reference']> = { messageId: 'root', revision: 3,
      context: { kind: 'MEANING', version: { format: 2, messageId: 'root', revision: 3, corrections: [] } } };
    current.edge.to.reference = target;
    current.edge.from = { messageId: 'current-source', selection: { kind: 'text', start: 0, len: 1, text: 'c' } };
    if (type === 'agree' || type === 'disagree') current.record.executedStance = { partId: 'relation', sourceRevision: 1, side: type === 'agree' ? 'pro' : 'con', target };
    historical.edge.to.reference = { messageId: 'root', revision: 2 };
    part.edge.to = { messageId: 'root', selection: { kind: 'edge', edgeId: 'body' }, reference: { messageId: 'root', revision: 3, partId: 'body' } };
    const membership = relation('membership', 'classify', 'anon:membership', current.record.id);
    const arbitration = relation('arbitration', 'round' as DemoEdge['relationType'], 'anon:arbitration', current.record.id);
    arbitration.record.kind = 'round';
    const links = [current, historical, part, reference, membership, arbitration], key = discussionBranchKey('root', type);
    const messages = [{ ...body('root'), revision: 3 }, ...links.map(link => body(link.edge.from.messageId)), ...links.map(link => link.record)];
    const before = JSON.stringify([messages, links]);
    const result = summarizeDiscussionEdges({ messages, edges: links.map(link => link.edge),
      ownerRegions: Object.fromEntries(links.map(link => [link.edge.from.messageId, key])),
      regions: [{ key, targetId: 'root', type, collapsed: false, directCount: 3, x: 420, y: 0, width: 320, height: 200, headerHeight: 24 }] });
    expect([...result.hiddenEdgeIds]).toEqual(['current:edge']);
    expect(result.summaries[0].recordIds).toEqual(['current']);
    expect(JSON.stringify([messages, links])).toBe(before);
  });
});
