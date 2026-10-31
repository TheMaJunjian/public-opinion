import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import MessageConnections from '../components/MessageConnections';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
const message=(id:string):DemoMessage=>({id,author:'test',createdAt:'',content:`${id} 的正文摘要`,kind:'normal'});
const edge=(id:string,from:string,to:string):DemoEdge=>({id,relationMessageId:id,relationType:'reference',relationLabel:'引用',from:{messageId:from,selection:{kind:'whole'}},to:{messageId:to,selection:{kind:'whole'}}});
async function expand(){fireEvent.click(screen.getByText('关联方向'));await screen.findByRole('region',{name:'本消息指向'});}

it.each(['member','parent'])('keeps JOIN records in membership labels instead of the connections of %s',messageId=>{
  const records=[message('member'),message('parent'),{...message('join'),kind:'join' as const}];
  render(<MessageConnections messageId={messageId} messages={records} edges={[edge('join','parent','member')]} defaultOpen onNavigate={vi.fn()}/>);
  expect(screen.getByRole('region',{name:'本消息指向'})).toHaveTextContent('本消息指向 · 0 条关联');
  expect(screen.getByRole('region',{name:'指向本消息'})).toHaveTextContent('指向本消息 · 0 条关联');
});

it.each(['round','round_result'] as const)('keeps a related %s in the settlement entry instead of the message connections',kind=>{
  const target=message('target-id'),record:DemoMessage={...message('arbitration'),kind,settlementTargetId:target.id,
    content:`发起真假仲裁：目标消息「${target.content}」`};
  const onNavigate=vi.fn();render(<MessageConnections messageId={target.id} messages={[target,record]} edges={[edge(record.id,`anon:${record.id}`,target.id)]} defaultOpen onNavigate={onNavigate}/>);
  const incoming=screen.getByRole('region',{name:'指向本消息'});
  expect(incoming).not.toHaveTextContent(target.content);
  expect(incoming).toHaveTextContent('指向本消息 · 0 条关联');
  expect(within(incoming).queryByRole('button')).toBeNull();expect(onNavigate).not.toHaveBeenCalled();
});

it('can show connections immediately for a clicked message without reading controls',async()=>{
  render(<MessageConnections messageId="current" messages={['current','basis'].map(message)} edges={[edge('out','current','basis')]} defaultOpen onNavigate={vi.fn()}/>);
  expect(screen.getByRole('region',{name:'本消息指向'})).toHaveTextContent('basis 的正文摘要');
  fireEvent.click(screen.getByText('关联方向'));
  await waitFor(()=>expect(document.querySelector('[data-message-connections]')).not.toHaveAttribute('open'));
});

it('separates outgoing bases and incoming responses, and navigates to the connected messages',async()=>{
  const onNavigate=vi.fn();render(<MessageConnections messageId="current" messages={['current','basis','response'].map(message)}
    edges={[edge('out','current','basis'),edge('in','response','current')]} onNavigate={onNavigate}/>);
  expect(screen.queryByRole('region')).toBeNull();await expand();
  const outgoing=within(screen.getByRole('region',{name:'本消息指向'})),incoming=within(screen.getByRole('region',{name:'指向本消息'}));
  expect(outgoing.getByText('basis 的正文摘要')).toBeInTheDocument();expect(outgoing.queryByText('response 的正文摘要')).toBeNull();
  expect(incoming.getByText('response 的正文摘要')).toBeInTheDocument();expect(incoming.queryByText('basis 的正文摘要')).toBeNull();
  const type=outgoing.getByRole('button',{name:'切换消息 basis 的摘要和 ID'}),target=outgoing.getByRole('button',{name:'阅读关联消息 basis'});
  fireEvent.click(type);expect(target).toHaveTextContent('basis');expect(onNavigate).not.toHaveBeenCalled();
  fireEvent.click(type);expect(target).toHaveTextContent('basis 的正文摘要');
  fireEvent.click(outgoing.getByRole('button',{name:'阅读关联消息 basis'}));expect(onNavigate).toHaveBeenLastCalledWith('basis');
  fireEvent.click(incoming.getByRole('button',{name:'阅读关联消息 response'}));expect(onNavigate).toHaveBeenLastCalledWith('response');
  expect(screen.queryByRole('button',{name:/查看关联记录/})).toBeNull();
});

it('does not inherit a relation record endpoints and resolves anonymous incoming sources to their real records',async()=>{
  const messages=[{...message('relation'),kind:'relation' as const,relationType:'reference' as const},message('source'),message('target'),message('vote')];
  render(<MessageConnections messageId="relation" messages={messages} edges={[edge('relation','source','target'),edge('vote','anon:vote','relation')]} onNavigate={vi.fn()}/>);
  await expand();expect(screen.getByRole('region',{name:'本消息指向'})).toHaveTextContent('本消息指向 · 0 条关联');
  expect(screen.queryByText('source 的正文摘要')).toBeNull();expect(screen.queryByText('target 的正文摘要')).toBeNull();
  const incoming=within(screen.getByRole('region',{name:'指向本消息'}));expect(incoming.getByText('vote 的正文摘要')).toBeInTheDocument();expect(incoming.queryByText('target 的正文摘要')).toBeNull();
});

it('shows the directly referenced record without its next-layer endpoints or self entries',()=>{
  const messages=[...['A','C','D'].map(message),...['B','E'].map(id=>({...message(id),kind:'relation' as const,relationType:'reference' as const,content:id==='B'?'引用 C → A':'引用 D → B'}))];
  const edges=[edge('B','C','A'),edge('E','D','B'),edge('self','D','D'),edge('D','anon:D','D')];
  const view=render(<MessageConnections messageId="D" messages={messages} edges={edges} defaultOpen onNavigate={vi.fn()}/>);
  expect(screen.getByRole('region',{name:'本消息指向'})).toHaveTextContent('本消息指向 · 1 条关联');
  expect(screen.getByRole('button',{name:'阅读关联消息 B'})).toHaveTextContent('B');
  expect(screen.queryByRole('button',{name:'查看关联记录 E'})).toBeNull();
  expect(screen.queryByText('引用 C → A')).toBeNull();
  for(const id of ['A','C','D'])expect(view.container.querySelector(`[data-message-reference="${id}"]`)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'切换消息 B 的摘要和 ID'}));
  expect(screen.queryByText('引用 C → A')).toBeNull();
  view.rerender(<MessageConnections messageId="B" messages={messages} edges={edges} defaultOpen onNavigate={vi.fn()}/>);
  expect(screen.getByRole('region',{name:'本消息指向'})).toHaveTextContent('本消息指向 · 0 条关联');
  expect(screen.getByRole('region',{name:'指向本消息'})).toHaveTextContent('D 的正文摘要');
  expect(view.container.querySelector('[data-message-reference="B"]')).toBeNull();
});

it('deduplicates multi-edge records and retains live updates without opening a separate structure panel',async()=>{
  const props={messageId:'current',messages:['current','target'].map(message),onNavigate:vi.fn()},link=edge('link','current','target');
  const view=render(<MessageConnections {...props} edges={[link,{...link,id:'second-edge'}]}/>);await expand();
  expect(screen.getByText('本消息指向 · 1 条关联')).toBeInTheDocument();
  view.rerender(<MessageConnections {...props} edges={[]}/>);
  await waitFor(()=>expect(screen.getByText('本消息指向 · 0 条关联')).toBeInTheDocument());expect(screen.getAllByText('暂无这类关联')).toHaveLength(2);
});

it('labels the referenced message by its own type even when the connecting record is a classification',async()=>{
  const classify={...message('classify'),kind:'relation' as const,relationType:'classify' as const};
  const merge={...message('merge'),kind:'relation' as const,relationType:'merge' as const};
  render(<MessageConnections messageId="classify" messages={[classify,merge,message('text')]}
    edges={['merge','text'].map(id=>({...edge(`edge-${id}`,'anon:classify',id),relationMessageId:'classify',relationType:'classify' as const}))} onNavigate={vi.fn()}/>);
  await expand();
  expect(screen.getByRole('button',{name:'切换消息 merge 的摘要和 ID'})).toHaveTextContent('归并');
  expect(screen.getByRole('button',{name:'切换消息 text 的摘要和 ID'})).toHaveTextContent('文本');
});
