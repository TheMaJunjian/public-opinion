import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import { discussionBranchKey } from '../pages/workbench/model/discussionBranches';
import { useState } from 'react';
import { REVEAL_VIRTUAL_MESSAGE } from '../hooks/useVirtualMessageMounts';
import { MIN_CARD_H } from '../utils/layout';

// Authored fixture text makes these branches eligible for text-region folding.
const message = (id:string):DemoMessage => ({id,kind:'normal',author:id,content:`fixture:${id}`,createdAt:'2026-01-01T00:00:00Z'});
function connection(id:string, type:DemoEdge['relationType'], source:string, target:string) {
  const record:DemoMessage={...message(id),kind:'relation',relationType:type};
  const edge:DemoEdge={id,relationMessageId:id,relationType:type,relationLabel:type,
    from:{messageId:source,selection:{kind:'whole'}},to:{messageId:target,selection:{kind:'whole'}}};
  return {record,edge};
}
function scene(nodes:string[], links:ReturnType<typeof connection>[], extra:Partial<GraphViewProps>={}) {
  const props:GraphViewProps={messages:[...nodes.map(message),...links.map(link=>link.record)],edges:links.map(link=>link.edge),
    draftUnits:[],activeTextSelectId:null,lastClickedMessageId:null,
    onMessageClick:vi.fn(),onMessageDoubleClick:vi.fn(),onTextMouseUp:vi.fn(),
    onEdgeLabelSingleClick:vi.fn(),onEdgeLabelDoubleClick:vi.fn(),onFragmentAnchorClick:vi.fn(),isFragmentSelected:()=>false,
    onMessageMouseDown:vi.fn(),onMessageMouseUp:vi.fn(),onCanvasBlankClick:vi.fn(),...extra};
  function Controlled(){
    const [view,setView]=useState({mode:'discussion' as 'graph'|'discussion',collapsed:[] as readonly string[]});
    return <GraphView {...props} discussionView={view} onDiscussionViewChange={setView}/>;
  }
  const ui=render(<Controlled/>);
  const card=(id:string)=>ui.container.querySelector<HTMLElement>(`.themed-message[data-msgid="${id}"]`);
  const box=(id:string)=>{const element=card(id)!;return {x:parseFloat(element.style.left),y:parseFloat(element.style.top),width:parseFloat(element.style.width),height:MIN_CARD_H};};
  const region=(target:string,type:'reply'|'agree'|'disagree')=>Array.from(ui.container.querySelectorAll<HTMLElement>('[data-discussion-region]'))
    .find(element=>element.dataset.discussionRegion===discussionBranchKey(target,type));
  const regionBox=(target:string,type:'reply'|'agree'|'disagree')=>{
    const element=region(target,type)!;
    return {x:parseFloat(element.style.left),y:parseFloat(element.style.top),width:parseFloat(element.style.width),height:parseFloat(element.style.height)};
  };
  return {...ui,card,box,region,regionBox,props};
}

function expectRegionControl(button:HTMLElement,target:string,type:'reply'|'agree'|'disagree') {
  expect(button.closest('.themed-message')).toBeNull();
  expect(button.closest('[data-discussion-region]')).toHaveAttribute('data-discussion-region',discussionBranchKey(target,type));
}

function expectContained(outer:{x:number;y:number;width:number;height:number},inner:{x:number;y:number;width:number;height:number},headerHeight=0) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y+headerHeight);
  expect(inner.x+inner.width).toBeLessThanOrEqual(outer.x+outer.width);
  expect(inner.y+inner.height).toBeLessThanOrEqual(outer.y+outer.height);
}

describe('discussion graph with native cards and selection',()=>{
  it('returns a source to its reply region after endorsing its existing reply relationship',async()=>{
    const reply=connection('old-reply','reply','child','root'),refutation=connection('new-refutation','disagree','child','root');
    const approval=connection('approval','agree','anon:approval','old-reply');
    reply.record.sequence=1;refutation.record.sequence=2;approval.record.sequence=3;
    approval.record.executedStance={partId:'relation',sourceRevision:1,side:'pro',target:{messageId:'old-reply'}};
    const ui=scene(['root','child'],[reply,refutation,approval]);
    await screen.findByRole('button',{name:'收起回复分支 root'});
    expect(ui.region('root','disagree')).toBeUndefined();
    expect(ui.card('child')).not.toBeNull();
    expect(ui.props.edges).toHaveLength(3);
    fireEvent.click(screen.getByRole('button',{name:'收起回复分支 root'}));
    await waitFor(()=>expect(ui.card('child')).toBeNull());
  });

  it.each(['header','footer'] as const)('keeps refutation folded after a %s collapse locates its target, while retaining active reply edges',async entry=>{
    const replies=['one','two'].map((source,index)=>connection(`reply-${index}`,'reply',source,'root'));
    const refutations=['one','two'].map((source,index)=>connection(`refute-${index}`,'disagree',source,'root'));
    for(const [index,link] of [...replies,...refutations].entries())link.record.sequence=index+1;
    const ui=scene(['root','one','two'],[...replies,...refutations]);
    await screen.findByRole('button',{name:'收起反驳分支 root'});
    expect(ui.region('root','reply')).toBeUndefined();
    for(const reply of replies)expect(ui.container.querySelector(`[data-directed-edge-label="${reply.record.id}"]`)).not.toBeNull();
    fireEvent.click(screen.getByRole('button',{name:`${entry==='footer'?'从底部':''}收起反驳分支 root`}));
    await waitFor(()=>expect(ui.card('one')).toBeNull());
    const detail={ids:['root'],positioningPending:false};
    await act(async()=>ui.container.querySelector('[data-jump-canvas]')!.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail})));
    expect(detail.positioningPending).toBe(false);
    expect(screen.getByRole('button',{name:'展开反驳分支 root'})).toHaveAttribute('aria-expanded','false');
    expect(ui.card('one')).toBeNull();expect(ui.card('two')).toBeNull();
    expect(ui.props.edges).toHaveLength(4);
    // Explicitly viewing a retained reply edge still reveals its source in the
    // refutation region that now owns it.
    const replyDetail={ids:[replies[0].record.id],positioningPending:false};
    await act(async()=>ui.container.querySelector('[data-jump-canvas]')!.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail:replyDetail})));
    await waitFor(()=>expect(ui.card('one')).not.toBeNull());
    expect(screen.getByRole('button',{name:'收起反驳分支 root'})).toHaveAttribute('aria-expanded','true');
  });

  it.each((['reply','agree','disagree','recommend','archive'] as const).flatMap(type=>
    (['header','footer'] as const).map(entry=>({type,entry}))))('locates the target when its $type summary is collapsed from the $entry',async({type,entry})=>{
    const locate=vi.fn();
    const ui=scene(['root','target','child'],[
      connection('parent','reply','target','root'),connection('branch',type,'child','target'),
    ],{onDiscussionBranchCollapse:locate});
    await waitFor(()=>expect(ui.card('child')).not.toBeNull());
    const key=discussionBranchKey('target',type);
    const control=()=>Array.from(ui.container.querySelectorAll<HTMLElement>('[data-discussion-group]'))
      .find(element=>element.dataset.discussionGroup===key)!;
    const footer=()=>Array.from(ui.container.querySelectorAll<HTMLElement>('[data-discussion-footer]'))
      .find(element=>element.dataset.discussionFooter===key);
    expect(locate).not.toHaveBeenCalled();
    expect(footer()).toBeDefined();
    const collapse=entry==='footer'?footer()!:control();
    fireEvent.mouseDown(collapse);fireEvent.mouseUp(collapse);fireEvent.click(collapse);
    await waitFor(()=>expect(ui.card('child')).toBeNull());
    expect(footer()).toBeUndefined();
    expect(ui.card('target')).not.toBeNull();
    expect(locate).toHaveBeenCalledExactlyOnceWith('target');
    fireEvent.click(control());
    await waitFor(()=>expect(ui.card('child')).not.toBeNull());
    expect(footer()).toBeDefined();
    expect(locate).toHaveBeenCalledTimes(1);
    expect(ui.props.onMessageClick).not.toHaveBeenCalled();
    expect(ui.props.onMessageDoubleClick).not.toHaveBeenCalled();
    expect(ui.props.onCanvasBlankClick).not.toHaveBeenCalled();
    expect(ui.props.onMessageMouseDown).not.toHaveBeenCalled();
    expect(ui.props.onMessageMouseUp).not.toHaveBeenCalled();
  });

  it('puts every response one column right and orders support, reply and refutation from top to bottom',async()=>{
    const ui=scene(['root','reply','nested','support','refute'],[
      connection('r1','reply','reply','root'),connection('r2','reply','nested','reply'),
      connection('s1','agree','support','root'),connection('s2','disagree','refute','root'),
    ]);
    await waitFor(()=>expect(ui.card('nested')).not.toBeNull());
    expect(ui.box('reply').x).toBeGreaterThan(ui.box('root').x);
    expect(ui.box('nested').x).toBeGreaterThan(ui.box('reply').x);
    expect(ui.box('support').x).toBeGreaterThan(ui.box('root').x+ui.box('root').width);
    expect(ui.box('refute').x).toBe(ui.box('support').x);
    expect(ui.box('support').y).toBeLessThan(ui.box('reply').y);
    expect(ui.box('refute').y).toBeGreaterThan(ui.box('reply').y);
    expectRegionControl(screen.getByRole('button',{name:'收起回复分支 root'}),'root','reply');
    expectRegionControl(screen.getByRole('button',{name:'收起支持分支 root'}),'root','agree');
    expectRegionControl(screen.getByRole('button',{name:'收起反驳分支 root'}),'root','disagree');
    const headerHeight=Number(ui.region('root','reply')!.dataset.discussionHeaderHeight);
    expect(headerHeight).toBeGreaterThan(0);
    expectContained(ui.regionBox('root','reply'),ui.box('reply'),headerHeight);
    expectContained(ui.regionBox('root','reply'),ui.box('nested'));
    expectContained(ui.regionBox('reply','reply'),ui.box('nested'));
    expectContained(ui.regionBox('root','reply'),ui.regionBox('reply','reply'));
    expectContained(ui.regionBox('root','agree'),ui.box('support'));
    expectContained(ui.regionBox('root','disagree'),ui.box('refute'));
    fireEvent.click(ui.card('reply')!);
    expect(ui.props.onMessageClick).toHaveBeenCalledWith(expect.anything(),'reply');
    expect(ui.container.querySelector('[data-directed-edge-label="r1"]')).toBeNull();
    expect(screen.getByRole('button',{name:'隐藏回复汇总关系 root'})).toHaveAttribute('aria-pressed','true');
  });

  it('collapses an automatic region to its counted title and reclaims space without selecting any message',async()=>{
    const ui=scene(['root','support-a','support-b','reply','nested','refute'],[
      connection('s1','agree','support-a','root'),connection('s2','agree','support-b','root'),
      connection('r1','reply','reply','root'),connection('r2','reply','nested','reply'),connection('d1','disagree','refute','root'),
    ]);
    const control=await screen.findByRole('button',{name:'收起支持分支 root'});
    await waitFor(()=>expect(ui.card('nested')).not.toBeNull());
    expectRegionControl(control,'root','agree');
    expect(control).toHaveTextContent(/支持\s*2/);
    const original=JSON.stringify([ui.props.messages,ui.props.edges]);
    const expanded=ui.regionBox('root','agree'),rootY=ui.box('root').y,replyY=ui.regionBox('root','reply').y;
    const canvas=ui.container.querySelector<HTMLElement>('[data-jump-canvas]')!;
    const expandedHeight=parseFloat(canvas.style.height);
    expect(ui.region('root','agree')).toHaveAttribute('data-discussion-collapsed','false');
    fireEvent.mouseDown(control);fireEvent.mouseUp(control);fireEvent.click(control);
    await waitFor(()=>expect(ui.card('support-a')).toBeNull());
    const collapsed=ui.region('root','agree')!;
    const collapsedControl=screen.getByRole('button',{name:'展开支持分支 root'});
    expectRegionControl(collapsedControl,'root','agree');
    expect(collapsedControl).toHaveAttribute('aria-expanded','false');
    expect(collapsedControl).toHaveTextContent(/支持\s*2/);
    expect(collapsed).toHaveAttribute('data-discussion-collapsed','true');
    expect(ui.regionBox('root','agree').height).toBe(Number(collapsed.dataset.discussionHeaderHeight));
    expect(ui.regionBox('root','agree').height).toBeLessThan(expanded.height);
    expect(collapsed.querySelectorAll('[data-discussion-group]')).toHaveLength(1);
    expect(collapsed.querySelectorAll('[data-discussion-summary-toggle]')).toHaveLength(1);
    expect(collapsed.querySelector('.themed-message')).toBeNull();
    expect(ui.card('support-b')).toBeNull();
    expect(ui.card('reply')).not.toBeNull();expect(ui.card('nested')).not.toBeNull();expect(ui.card('refute')).not.toBeNull();
    expect(ui.container.querySelector('[data-directed-edge-label="s1"]')).toBeNull();
    expect(ui.container.querySelector('[data-directed-edge-label="s2"]')).toBeNull();
    expect(ui.box('root').y).toBe(rootY);
    expect(ui.regionBox('root','reply').y).toBeLessThan(replyY);
    expect(parseFloat(canvas.style.height)).toBeLessThan(expandedHeight);
    fireEvent.doubleClick(collapsedControl);
    expect(ui.props.onMessageClick).not.toHaveBeenCalled();
    expect(ui.props.onMessageDoubleClick).not.toHaveBeenCalled();
    expect(ui.props.onMessageMouseDown).not.toHaveBeenCalled();
    expect(ui.props.onMessageMouseUp).not.toHaveBeenCalled();
    expect(ui.props.onTextMouseUp).not.toHaveBeenCalled();
    expect(ui.props.onCanvasBlankClick).not.toHaveBeenCalled();
    expect(ui.props.onEdgeLabelSingleClick).not.toHaveBeenCalled();
    expect(JSON.stringify([ui.props.messages,ui.props.edges])).toBe(original);
    fireEvent.click(collapsedControl);
    await waitFor(()=>expect(ui.card('support-a')).not.toBeNull());
    expect(ui.regionBox('root','agree').height).toBe(expanded.height);
    expect(ui.box('root').y).toBe(rootY);
  });

  it('folds one message reply branch independently and retains that fold after its parent reopens',async()=>{
    const ui=scene(['root','child','grandchild','sibling'],[
      connection('r1','reply','child','root'),connection('r2','reply','grandchild','child'),connection('r3','reply','sibling','root'),
    ]);
    await waitFor(()=>expect(ui.card('grandchild')).not.toBeNull());
    const childControl=screen.getByRole('button',{name:'收起回复分支 child'});
    expectRegionControl(childControl,'child','reply');
    fireEvent.click(childControl);
    await waitFor(()=>expect(ui.card('grandchild')).toBeNull());
    expect(ui.card('child')).not.toBeNull();expect(ui.card('sibling')).not.toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'收起回复分支 root'}));
    await waitFor(()=>expect(ui.card('child')).toBeNull());
    expect(ui.card('root')).not.toBeNull();
    expect(ui.region('child','reply')).toBeUndefined();
    expect(ui.container.querySelector('[data-directed-edge-label="r1"]')).toBeNull();
    expect(ui.container.querySelector('[data-directed-edge-label="r2"]')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'展开回复分支 root'}));
    await waitFor(()=>expect(ui.card('child')).not.toBeNull());
    expect(ui.card('grandchild')).toBeNull();
    expect(screen.getByRole('button',{name:'展开回复分支 child'})).toHaveAttribute('aria-expanded','false');
    expect(ui.props.onMessageClick).not.toHaveBeenCalled();
    expect(ui.props.onMessageDoubleClick).not.toHaveBeenCalled();
  });

  it('folds support and refutation separately without selecting or changing relationship records',async()=>{
    const ui=scene(['root','support','refute'],[connection('s1','agree','support','root'),connection('s2','disagree','refute','root')]);
    const before=JSON.stringify([ui.props.messages,ui.props.edges]);
    fireEvent.click(await screen.findByRole('button',{name:'收起支持分支 root'}));
    await waitFor(()=>expect(ui.card('support')).toBeNull());
    expect(ui.card('refute')).not.toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'收起反驳分支 root'}));
    await waitFor(()=>expect(ui.card('refute')).toBeNull());
    fireEvent.click(screen.getByRole('button',{name:'展开支持分支 root'}));
    await waitFor(()=>expect(ui.card('support')).not.toBeNull());
    expect(ui.card('refute')).toBeNull();
    expect(JSON.stringify([ui.props.messages,ui.props.edges])).toBe(before);
    expect(ui.props.onMessageClick).not.toHaveBeenCalled();
    expect(ui.props.onCanvasBlankClick).not.toHaveBeenCalled();
  });

  it('folds a shared reply with its owning region and restores its original edge addresses on reopening',async()=>{
    const a=connection('shared-a','reply','shared','a'),b=connection('shared-b','reply','shared','b');
    const ui=scene(['a','b','shared'],[a,b]);
    fireEvent.click(await screen.findByRole('button',{name:'收起回复分支 a'}));
    await waitFor(()=>expect(ui.container.querySelector('[data-directed-edge-label="shared-a"]')).toBeNull());
    expect(ui.card('shared')).toBeNull();
    expect(ui.container.querySelector('[data-directed-edge-label="shared-b"]')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'展开回复分支 a'}));
    await waitFor(()=>expect(ui.card('shared')).not.toBeNull());
    expect(ui.container.querySelector('[data-directed-edge-label="shared-a"]')).toBeNull();
    expect(screen.getByRole('button',{name:'隐藏回复汇总关系 a'})).toHaveAttribute('aria-pressed','true');
    fireEvent.click(ui.container.querySelector('[data-directed-edge-label="shared-b"]')!);
    expect(ui.props.onEdgeLabelSingleClick).toHaveBeenCalledWith(expect.anything(),'shared-b','shared-b');
  });

  it('gives a relationship with its own replies an original-ID card and fold control',async()=>{
    const ui=scene(['root','child','on-relation'],[connection('r1','reply','child','root'),connection('r2','reply','on-relation','r1')]);
    await waitFor(()=>expect(ui.card('r1')).not.toBeNull());
    expect(ui.box('on-relation').x).toBeGreaterThan(ui.box('r1').x);
    fireEvent.click(screen.getByRole('button',{name:'收起回复分支 r1'}));
    await waitFor(()=>expect(ui.card('on-relation')).toBeNull());
    expect(ui.card('r1')).not.toBeNull();expect(ui.card('child')).not.toBeNull();
    expect(ui.props.edges.map(edge=>edge.id)).toEqual(['r1','r2']);
  });

  it('applies saved folds on first render and leaves ordinary graph mode unchanged',async()=>{
    const link=connection('r1','reply','child','root');
    const props:GraphViewProps={messages:['root','child'].map(message).concat(link.record),edges:[link.edge],
      draftUnits:[],activeTextSelectId:null,lastClickedMessageId:null,onMessageClick:vi.fn(),onMessageDoubleClick:vi.fn(),
      onTextMouseUp:vi.fn(),onEdgeLabelSingleClick:vi.fn(),onEdgeLabelDoubleClick:vi.fn(),onFragmentAnchorClick:vi.fn(),isFragmentSelected:()=>false};
    const view={mode:'discussion' as const,collapsed:[discussionBranchKey('root','reply')]};
    const ui=render(<GraphView {...props} discussionView={view}/>);
    await waitFor(()=>expect(ui.container.querySelector('.themed-message[data-msgid="root"]')).not.toBeNull());
    expect(ui.container.querySelector('.themed-message[data-msgid="child"]')).toBeNull();
    await act(async()=>ui.rerender(<GraphView {...props} discussionView={{...view,mode:'graph'}}/>));
    expect(ui.container.querySelector('.themed-message[data-msgid="child"]')).not.toBeNull();
    expect(ui.container.querySelector('[data-discussion-region]')).toBeNull();
  });

  it('reveals a folded navigation target without expanding an unrelated branch',async()=>{
    const ui=scene(['root','child','grandchild','other','other-child'],[
      connection('r1','reply','child','root'),connection('r2','reply','grandchild','child'),connection('r3','reply','other-child','other'),
    ]);
    fireEvent.click(await screen.findByRole('button',{name:'收起回复分支 root'}));
    fireEvent.click(screen.getByRole('button',{name:'收起回复分支 other'}));
    await waitFor(()=>expect(ui.card('grandchild')).toBeNull());
    const detail={ids:['grandchild'],positioningPending:false};
    await act(async()=>ui.container.querySelector('[data-jump-canvas]')!.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE,{detail})));
    await waitFor(()=>expect(ui.card('grandchild')).not.toBeNull());
    expect(detail.positioningPending).toBe(true);
    expect(ui.card('other-child')).toBeNull();
    expect(screen.getByRole('button',{name:'展开回复分支 other'})).toHaveAttribute('aria-expanded','false');
  });

  it('keeps explicit manual-frame members visible without discarding their saved discussion folds',async()=>{
    const link=connection('r1','reply','child','root');
    const messages=['root','child'].map(message).concat(link.record);
    const ordered:DemoMessage={...message('ordered'),kind:'relation',relationType:'arrange',
      parts:[{id:'display',type:'display',layout:'row',relationPartId:'members'}]};
    const membership=(id:string):DemoEdge=>({id:`ordered:${id}`,relationMessageId:'ordered',relationType:'arrange',relationLabel:'',
      from:{messageId:'anon:ordered',selection:{kind:'whole'}},to:{messageId:id,selection:{kind:'whole'}}});
    const props:GraphViewProps={messages,edges:[link.edge],draftUnits:[],activeTextSelectId:null,lastClickedMessageId:null,
      onMessageClick:vi.fn(),onMessageDoubleClick:vi.fn(),onTextMouseUp:vi.fn(),onEdgeLabelSingleClick:vi.fn(),
      onEdgeLabelDoubleClick:vi.fn(),onFragmentAnchorClick:vi.fn(),isFragmentSelected:()=>false};
    const view={mode:'discussion' as const,collapsed:[discussionBranchKey('root','reply')]};
    const onChange=vi.fn();
    const ui=render(<GraphView {...props} messages={[...messages,ordered]}
      edges={[link.edge,membership('root'),membership('child')]} discussionView={view} onDiscussionViewChange={onChange}/>);
    await waitFor(()=>expect(ui.container.querySelector('.themed-message[data-msgid="child"]')).not.toBeNull());
    expect(ui.container.querySelector('[data-discussion-region]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    await act(async()=>ui.rerender(<GraphView {...props} discussionView={view} onDiscussionViewChange={onChange}/>));
    await waitFor(()=>expect(ui.container.querySelector('.themed-message[data-msgid="child"]')).toBeNull());
    expect(screen.getByRole('button',{name:'展开回复分支 root'})).toHaveAttribute('aria-expanded','false');
    expect(view.collapsed).toEqual([discussionBranchKey('root','reply')]);
  });
});
