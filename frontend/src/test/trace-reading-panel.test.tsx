import {fireEvent,render,within} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import TraceReadingPanel from '../components/TraceReadingPanel';
import type {ReadingTask} from '../pages/workbench/model/readingTasks';
import {readingConfirmations} from '../pages/workbench/model/readingConfirmations';

it('keeps navigation above the individually typed confirmation rows',()=>{
  const visit={id:'text',tasks:[]};
  const onVisit=vi.fn();
  const types=new Map([['text','文本'],['ref','引用'],['other','分类']]);
  const tasks:ReadingTask[]=[{key:'body',destinationId:'text',targetId:'text',kind:'body',reason:'正文未读',location:'inside',createdAt:''},
    {key:'ref',destinationId:'text',targetId:'text',kind:'influence',reason:'消息 text 有未了解的引用：ref',location:'inside',createdAt:'',influence:{messageId:'ref',type:'reference',key:'reference',eventId:'ref'}}];
  tasks.push({...tasks[1],key:'other-target',targetId:'other'});
  const view=render(<TraceReadingPanel order="discussion" onOrder={vi.fn()} focusId="text" pending={[visit]} added={[]} outside={[]} filtered={[]}
    busy={false} canRead ready focusLocated isWorking={false} error={null} onForward={vi.fn()} onBackward={vi.fn()} onRead={vi.fn()} onNew={vi.fn()}
    canGoBack canGoForward onSetReading={vi.fn()} confirmations={readingConfirmations(tasks,types)}
    statistics={{bodies:1,influences:2,outsideInfluences:0}} onVisit={onVisit} onBack={vi.fn()} path={['text','ref'].map(id=>[id])} messageTypes={types} getMessageSummary={id=>`${id} 的摘要`}/>);
  const body=view.getByText('【文本】当前正文');
  expect(view.getByText('正文 · 1 条')).toBeVisible();expect(view.getByText('引用影响 · 1 条消息 / 2 项')).toBeVisible();
  expect(view.container.querySelector('[data-reading-current-group]')).toHaveTextContent('当前阅读与追溯消息：【文本】 text');
  expect(view.container.querySelector('[data-reading-path]')).not.toHaveAttribute('open');
  expect(view.container.querySelector('[data-reading-trace-current]')).toBe(view.container.querySelector('[data-reading-current-group]'));
  for(const element of view.container.querySelectorAll<HTMLElement>('[data-reading-message-id]')){
    const id=element.dataset.readingMessageId!;expect(element.textContent).toBe(`【${types.get(id)}】 ${id}`);
  }
  expect(view.container.querySelector('[data-reading-confirmations]')).not.toHaveTextContent('消息 text');
  expect(view.container.querySelector('[data-reading-confirmations]')).not.toHaveTextContent('当前消息');
  const current=within(view.container.querySelector<HTMLElement>('[data-reading-current-id]')!);
  fireEvent.click(current.getByRole('button',{name:'切换消息 text 的摘要和 ID'}));
  expect(current.getByRole('button',{name:'跳转到消息 text'})).toHaveTextContent('text 的摘要');expect(onVisit).not.toHaveBeenCalled();
  fireEvent.click(current.getByRole('button',{name:'跳转到消息 text'}));expect(onVisit).toHaveBeenCalledWith(visit);
  const group=body.closest('details')!;fireEvent.click(within(group).getByText('正文 · 1 条'));expect(group).not.toHaveAttribute('open');
  expect(view.getByRole('button',{name:'阅读前进'}).compareDocumentPosition(body)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('labels hidden messages and folds only consecutive messages with the same type and location',()=>{
  const visit=(id:string,location:ReadingTask['location']='outside')=>({id,tasks:[{key:id,destinationId:id,targetId:id,kind:'body' as const,reason:'正文未读',location,createdAt:''}]});
  const onVisit=vi.fn(),types=new Map([['a','文本'],['b','文本'],['cold','冷藏'],['c','文本'],['d','文本'],['e','文本']]);
  const view=render(<TraceReadingPanel order="time" onOrder={vi.fn()} focusId={null} pending={[]} added={[]}
    outside={[visit('a'),visit('b'),visit('cold'),visit('c')]} filtered={[visit('d','filtered'),visit('e','filtered')]}
    busy={false} canRead ready focusLocated isWorking={false} error={null} onForward={vi.fn()} onBackward={vi.fn()} onRead={vi.fn()} onNew={vi.fn()}
    canGoBack={false} canGoForward={false} onSetReading={vi.fn()} confirmations={[]} statistics={{bodies:0,influences:0,outsideInfluences:0}} onVisit={onVisit} onBack={vi.fn()} path={[]} messageTypes={types}/>);
  fireEvent.click(view.getByText('范围外及筛选隐藏的待阅内容'));
  expect(view.getAllByText('【冷藏】')[0]).toBeVisible();
  const groups=view.container.querySelectorAll<HTMLDetailsElement>('[data-reading-type-group]');expect(groups).toHaveLength(2);
  expect(groups[0]).not.toHaveAttribute('open');expect(groups[0].querySelector('summary')).toHaveTextContent('文本 · 范围外 · 2 条');
  expect(groups[1].querySelector('summary')).toHaveTextContent('文本 · 筛选隐藏 · 2 条');
  fireEvent.click(within(groups[0]).getByText('文本 · 范围外 · 2 条'));
  fireEvent.click(view.getByRole('button',{name:/继续追溯并阅读.*b$/}));expect(onVisit).toHaveBeenCalledWith(visit('b'));
  expect(view.getByRole('button',{name:/继续追溯并阅读.*c$/})).toBeVisible();
  fireEvent.click(within(groups[1]).getByText('文本 · 筛选隐藏 · 2 条'));
  fireEvent.click(view.getByRole('button',{name:/临时显示并阅读.*d$/}));expect(onVisit).toHaveBeenCalledWith(visit('d','filtered'));
});

it('shows one reading and trace group and assigns the whole recent selection',()=>{
  const onSetReading=vi.fn(),types=new Map([['a','文本'],['b','引用'],['c','文本']]);
  const view=render(<TraceReadingPanel order="discussion" onOrder={vi.fn()} focusId="a" focusIds={['a','b']} recentSelectedIds={['b','c']}
    pending={[]} added={[]} outside={[]} filtered={[]} busy={false} canRead ready focusLocated isWorking={false} error={null}
    canGoBack={false} canGoForward={false} onForward={vi.fn()} onBackward={vi.fn()} onRead={vi.fn()} onNew={vi.fn()} onSetReading={onSetReading}
    confirmations={[]} statistics={{bodies:0,influences:0,outsideInfluences:0}} onVisit={vi.fn()} onBack={vi.fn()} path={ [['a','b']] } messageTypes={types}/>);
  expect(view.container.querySelector('[data-reading-current-group]')).toHaveTextContent('当前阅读与追溯消息（2 条）：【文本】 a、【引用】 b');
  fireEvent.click(view.getByRole('button',{name:'设为阅读消息'}));expect(onSetReading).toHaveBeenCalledWith(['b','c']);
  expect(view.queryByRole('button',{name:'继续追溯本组消息'})).toBeNull();
  expect(view.queryByRole('button',{name:'上一条'})).toBeNull();expect(view.queryByRole('button',{name:'下一条'})).toBeNull();
});

it('explains automatic tracing without a redundant continue action',()=>{
  const view=render(<TraceReadingPanel order="discussion" onOrder={vi.fn()} focusId="b" focusIds={['b','a']}
    pending={[]} added={[]} outside={[]} filtered={[]} busy={false} canRead ready focusLocated isWorking={false} error={null}
    canGoBack={false} canGoForward={false} onForward={vi.fn()} onBackward={vi.fn()} onRead={vi.fn()} onNew={vi.fn()} onSetReading={vi.fn()}
    confirmations={[]} statistics={{bodies:0,influences:0,outsideInfluences:0}} onVisit={vi.fn()} onBack={vi.fn()} path={ [['a','b']] } messageTypes={new Map()}/>);
  expect(view.queryByRole('button',{name:/继续追溯(?:本组|当前)消息/})).toBeNull();
  const help=view.container.querySelector<HTMLDetailsElement>('details[data-reading-help]')!;
  expect(help).not.toHaveAttribute('open');
  expect(view.getByText(/指定阅读消息时自动以它为追溯起点/)).not.toBeVisible();
  expect(view.getByRole('button',{name:'阅读前进'})).toBeVisible();
  fireEvent.click(within(help).getByText('阅读操作说明'));
  expect(help).toHaveAttribute('open');
  expect(view.getByText(/指定阅读消息时自动以它为追溯起点/)).toBeVisible();
  expect(view.getByText(/指定阅读消息时自动以它为追溯起点/)).toHaveTextContent('默认向上 1 层、向下 2 层');
  fireEvent.click(within(help).getByText('阅读操作说明'));
  expect(help).not.toHaveAttribute('open');
});
