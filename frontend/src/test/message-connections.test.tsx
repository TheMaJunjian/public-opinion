import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import MessageConnections from '../components/MessageConnections';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
const message=(id:string):DemoMessage=>({id,author:'test',createdAt:'',content:`${id} 的正文摘要`,kind:'normal'});
const edge=(id:string,from:string,to:string):DemoEdge=>({id,relationMessageId:id,relationType:'reference',relationLabel:'引用',from:{messageId:from,selection:{kind:'whole'}},to:{messageId:to,selection:{kind:'whole'}}});
async function expand(){fireEvent.click(screen.getByText('关联方向'));await screen.findByRole('region',{name:'本消息指向'});}

it('separates outgoing bases and incoming responses, and navigates to the message or exact relation record',async()=>{
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
  fireEvent.click(incoming.getByRole('button',{name:'查看关联记录 in'}));expect(onNavigate).toHaveBeenLastCalledWith('in');
});

it('shows a relation record targets only as outgoing and resolves anonymous incoming sources to their real records',async()=>{
  const messages=[{...message('relation'),kind:'relation' as const,relationType:'reference' as const},message('source'),message('target'),message('vote')];
  render(<MessageConnections messageId="relation" messages={messages} edges={[edge('relation','source','target'),edge('vote','anon:vote','relation')]} onNavigate={vi.fn()}/>);
  await expand();expect(within(screen.getByRole('region',{name:'本消息指向'})).getByText('target 的正文摘要')).toBeInTheDocument();
  const incoming=within(screen.getByRole('region',{name:'指向本消息'}));expect(incoming.getByText('vote 的正文摘要')).toBeInTheDocument();expect(incoming.queryByText('target 的正文摘要')).toBeNull();
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
