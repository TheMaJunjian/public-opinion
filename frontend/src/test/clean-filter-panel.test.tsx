import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import CleanFilterPanel from '../components/CleanFilterPanel';
import type { CleanFilterRule } from '../types';
import { deriveCleanVisibleIds } from '../utils/cleanProjection';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';

it('filters by local publication time, includes the end minute, and accepts either open bound',()=>{
  const messages=[['before','2026-10-27T09:59:59'],['first','2026-10-27T10:00:00'],['last','2026-10-27T10:30:59.999'],['after','2026-10-27T10:31:00']]
    .map(([id,createdAt])=>({...text(id),createdAt}));
  const run=(from:string,to:string)=>deriveCleanVisibleIds(input(messages),[{id:'time',kind:'time',from,to}])!.visibleTextIds;
  expect(run('2026-10-27T10:00','2026-10-27T10:30')).toEqual(new Set(['first','last']));
  expect(run('','2026-10-27T10:30')).toEqual(new Set(['before','first','last']));
  expect(run('2026-10-27T10:00','')).toEqual(new Set(['first','last','after']));
});

it('adds and edits a time range while rejecting an inverted range',()=>{
  function Harness(){
    const [filters,setFilters]=useState<CleanFilterRule[]>([]);
    return <CleanFilterPanel active={!!filters.length} filters={filters} matchCount={1} totalCount={2}
      onAdd={rule=>setFilters(previous=>[...previous,rule])} onUpdate={(id,update)=>setFilters(previous=>previous.map(rule=>rule.id===id?update(rule):rule))}
      onRemove={id=>setFilters(previous=>previous.filter(rule=>rule.id!==id))} onClear={()=>setFilters([])}/>;
  }
  render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'过滤'}));
  fireEvent.click(screen.getByRole('button',{name:'按发送时间'}));
  fireEvent.change(screen.getByLabelText('开始时间'),{target:{value:'2026-10-27T10:00'}});
  fireEvent.change(screen.getByLabelText('结束时间'),{target:{value:'2026-10-27T09:00'}});
  expect(screen.getByRole('alert')).toHaveTextContent('结束时间不能早于开始时间');
  fireEvent.click(screen.getByRole('button',{name:'确认'}));expect(screen.getByLabelText('开始时间')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('结束时间'),{target:{value:'2026-10-27T11:00'}});
  fireEvent.click(screen.getByRole('button',{name:'确认'}));
  fireEvent.click(screen.getByRole('button',{name:'发送时间: 2026-10-27 10:00 至 2026-10-27 11:00'}));
  expect(screen.getByLabelText('开始时间')).toHaveValue('2026-10-27T10:00');
});

it('reopens active filters, combines types and rules, and edits without clearing existing rules', () => {
  function Harness() {
    const [filters, setFilters] = useState<CleanFilterRule[]>([]);
    return <CleanFilterPanel active={!!filters.length} filters={filters} matchCount={1} totalCount={4}
      onAdd={rule => setFilters(previous => [...previous, rule])}
      onUpdate={(id, update) => setFilters(previous => previous.map(rule => rule.id === id ? update(rule) : rule))}
      onRemove={id => setFilters(previous => previous.filter(rule => rule.id !== id))} onClear={() => setFilters([])}/>;
  }
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', {name:'过滤'}));
  expect(screen.queryByRole('button',{name:'按关系类型'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'按消息类型'}));
  expect(within(screen.getByRole('group',{name:'内容型'})).getByRole('checkbox',{name:'文本'})).toBeInTheDocument();
  expect(within(screen.getByRole('group',{name:'关系型'})).getByRole('checkbox',{name:'引用'})).toBeInTheDocument();
  expect(within(screen.getByRole('group',{name:'内容型'})).queryByRole('checkbox',{name:'引用'})).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', {name:'提案'}));
  fireEvent.click(screen.getByRole('button', {name:'确认'}));
  fireEvent.click(screen.getByRole('button', {name:/过滤中/}));
  fireEvent.click(screen.getByRole('button', {name:/过滤中/}));
  expect(screen.getByRole('button', {name:'消息类型: 文本、提案'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'按发送者'}));
  fireEvent.change(screen.getByPlaceholderText('例如: 张三'), {target:{value:'甲'}});
  fireEvent.click(screen.getByRole('button', {name:'确认'}));
  expect(screen.getByRole('button', {name:/过滤中 \(2\)/})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'关系型'}));
  expect(screen.getByRole('button', {name:'消息类型: 关系型'})).toBeInTheDocument();
  expect(screen.getByRole('button', {name:'发送者: 甲'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'发送者: 甲'}));
  expect(screen.getByRole('button',{name:'发送者: 甲'})).toHaveAttribute('aria-expanded','true');
  fireEvent.click(screen.getByRole('button', {name:'发送者: 甲'}));
  expect(screen.getByRole('button',{name:'发送者: 甲'})).toHaveAttribute('aria-expanded','false');
  expect(screen.queryByPlaceholderText('例如: 张三')).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'发送者: 甲'}));
  fireEvent.change(screen.getByPlaceholderText('例如: 张三'), {target:{value:'乙'}});
  fireEvent.click(screen.getByRole('button', {name:'确认'}));
  expect(screen.getByRole('button', {name:'发送者: 乙'})).toBeInTheDocument();
});

const text=(id:string,author='甲'):DemoMessage=>({id,author,kind:'normal',content:id,createdAt:''});
const input=(messages:DemoMessage[],edges:DemoEdge[]=[])=>({messages,edges,stakeCounts:{},tagCounts:{}});

it('uses OR between selected message types and AND with sender, without including unrelated relation labels',()=>{
  const messages=[text('text'),text('other','乙'),{...text('proposal'),kind:'governance' as const},
    {...text('reference'),kind:'relation' as const,relationType:'reference' as const}];
  const edges:DemoEdge[]=[{id:'edge',relationMessageId:'reference',relationType:'reference',relationLabel:'引用',
    from:{messageId:'text',selection:{kind:'whole'}},to:{messageId:'other',selection:{kind:'whole'}}}];
  const result=deriveCleanVisibleIds(input(messages,edges),[
    {id:'types',kind:'messageType',messageTypes:['TEXT','PROPOSAL']},{id:'sender',kind:'sender',username:'甲'},
  ])!;
  expect(result.visibleTextIds).toEqual(new Set(['text','proposal']));
  expect(result.visibleRelIds).toEqual(new Set());
  const relationships=deriveCleanVisibleIds(input(messages,edges),[{id:'types',kind:'messageType',messageTypes:['RELATION']}])!;
  expect(relationships.visibleRelIds).toEqual(new Set(['reference']));
  expect(relationships.visibleTextIds).toEqual(new Set(['text','other']));
  const content=deriveCleanVisibleIds(input(messages,edges),[{id:'types',kind:'messageType',messageTypes:['CONTENT']}])!;
  expect(content.visibleTextIds).toEqual(new Set(['text','other','proposal']));
  expect(content.visibleRelIds.size).toBe(0);
});
