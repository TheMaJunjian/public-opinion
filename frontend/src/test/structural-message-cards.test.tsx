import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import MessageCard from '../components/MessageCard';
import { THEMES, setTheme } from '../theme/theme';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); delete document.documentElement.dataset.appearance; delete document.documentElement.dataset.theme; });
const member: DemoMessage = {id:'member', kind:'normal', author:'tester', createdAt:'', content:'成员正文保留'};
const structure = (type:'merge'|'arrange'): DemoMessage => ({...member, id:'structure', kind:'relation', relationType:type,
  content:'不应出现在组织卡上的正文', relationPayload:{title:'不应出现的重复标题'},
  parts:[{id:'body', type:'text', text:'不应出现在组织卡上的正文'}, {id:'relation', type:'relation', relation:type, roles:{}}]});

it.each(THEMES.flatMap(({id:theme}) => (['merge','arrange'] as const).map(type => ({theme,type}))))(
  '$theme: preserves $type metadata and its intended default disclosure', ({theme,type}) => {
    setTheme(theme);
    vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this:HTMLElement) {
      return this.hasAttribute('data-structural-card') ? 76 : 100;
    });
    const record = structure(type), select = vi.fn(), inspect = vi.fn(), vote = vi.fn();
    const edge:DemoEdge = {id:'member-edge',relationMessageId:record.id,relationType:type,relationLabel:type,
      from:{messageId:'anon:structure',selection:{kind:'whole'}},to:{messageId:member.id,selection:{kind:'whole'}}};
    const props:GraphViewProps = {messages:[record,member],edges:[edge],draftUnits:[{messageId:record.id,selection:{kind:'whole'}}],activeTextSelectId:null,lastClickedMessageId:record.id,
      onMessageClick:select,onMessageDoubleClick:inspect,onTextMouseUp:vi.fn(),onSettlementToggleTruth:vote,
      onEdgeLabelSingleClick:vi.fn(),onEdgeLabelDoubleClick:vi.fn(),onFragmentAnchorClick:vi.fn(),isFragmentSelected:()=>false,
      getMemberCounts:()=>({total:1,direct:1})};
    const view=render(<GraphView {...props}/>);
    const label=type==='merge'?'归并':'排列';
    const card=()=>view.getByRole('group',{name:'组织消息 structure'});
    const memberTop=()=>parseFloat(view.container.querySelector<HTMLElement>('[data-msgid="member"]')!.style.top);
    const initialTop=memberTop();
    if(type==='arrange') {
      expect(view.queryByRole('group',{name:'组织消息 structure'})).toBeNull();
      expect(view.queryByText('排列')).toBeNull();
      const toggle=view.getByRole('button',{name:`显示${label}消息卡 structure`});
      expect(toggle).toHaveTextContent('▸');
      const frame=view.container.querySelector('rect[data-jump-visual-msgids="structure"]')!;
      expect(parseFloat(toggle.style.top)+parseFloat(toggle.style.height)).toBe(Number(frame.getAttribute('y')));
      expect(initialTop-parseFloat(toggle.style.top)-parseFloat(toggle.style.height)).toBeGreaterThanOrEqual(8);
      fireEvent.click(toggle);
    }
    const expandedTop=memberTop();
    expect(parseFloat(card().style.width)).toBeGreaterThanOrEqual(440);
    expect(expandedTop-parseFloat(card().style.top)-76).toBeGreaterThanOrEqual(8);
    expect(card()).not.toHaveTextContent(record.content);
    expect(card()).not.toHaveTextContent('不应出现的重复标题');
    expect(card().querySelector('[data-message-member-count]')).toHaveTextContent('1 条消息');
    fireEvent.click(within(card()).getByTitle('真假仲裁'));expect(vote).toHaveBeenCalledWith(record.id);
    expect(select).not.toHaveBeenCalled();expect(inspect).not.toHaveBeenCalled();
    expect(card()).toHaveAttribute('data-skin-selected','true');
    fireEvent.click(card());fireEvent.doubleClick(card());
    expect(select).toHaveBeenCalledExactlyOnceWith(expect.anything(),record.id);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(expect.anything(),record.id);
    act(()=>setTheme(theme==='opus-paper'?'gpt':'opus-paper'));
    expect(card().querySelector('[data-message-member-count]')).toHaveTextContent('1 条消息');
    if(type==='merge') {
      expect(view.queryByRole('button',{name:/归并消息卡/})).not.toBeInTheDocument();
      expect(view.getByText(member.content)).toBeInTheDocument();
      return;
    }
    fireEvent.click(view.getByRole('button',{name:'收起排列消息卡 structure'}));
    expect(view.queryByRole('group',{name:'组织消息 structure'})).toBeNull();
    expect(memberTop()).toBe(initialTop);
    expect(view.getByText(member.content)).toBeInTheDocument();
    expect(select).toHaveBeenCalledTimes(1);expect(inspect).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole('button',{name:'显示排列消息卡 structure'}));
    expect(card()).not.toHaveTextContent(record.content);
    expect(memberTop()).toBe(expandedTop);
    expect(view.getByText(member.content)).toBeInTheDocument();
  });

it.each(['merge','arrange'] as const)('omits the %s body in list cards while retaining identity and membership', type => {
  const message=structure(type);
  const view=render(<MessageCard msg={message} ctx={{relType:type,isOrganizationMessage:type==='merge',memberCount:1,organizationTitle:'不应出现的重复标题',isActiveText:true}}>重复的关系说明</MessageCard>);
  expect(view.container.querySelector('[data-structural-card]')).not.toBeNull();
  expect(view.container).not.toHaveTextContent(message.content);
  expect(view.container).not.toHaveTextContent('不应出现的重复标题');
  expect(view.container).not.toHaveTextContent('重复的关系说明');
  expect(view.container).not.toHaveTextContent('拖选文字');
  expect(view.container.querySelector('.message-card-id')).toHaveTextContent(message.id);
  expect(view.container.querySelector('[data-message-member-count]')).toHaveTextContent('1 条消息');
});
