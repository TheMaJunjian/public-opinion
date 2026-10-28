import {fireEvent,render,within} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import TraceReadingPanel from '../components/TraceReadingPanel';
import type {ReadingTask} from '../pages/workbench/model/readingTasks';

it('labels hidden messages and folds only consecutive messages with the same type and location',()=>{
  const visit=(id:string,location:ReadingTask['location']='outside')=>({id,tasks:[{key:id,destinationId:id,targetId:id,kind:'body' as const,reason:'正文未读',location,createdAt:''}]});
  const onVisit=vi.fn(),types=new Map([['a','文本'],['b','文本'],['cold','冷藏'],['c','文本'],['d','文本'],['e','文本']]);
  const view=render(<TraceReadingPanel order="time" onOrder={vi.fn()} focusId={null} pending={[]} added={[]}
    outside={[visit('a'),visit('b'),visit('cold'),visit('c')]} filtered={[visit('d','filtered'),visit('e','filtered')]}
    busy={false} canRead ready focusLocated isWorking={false} error={null} onNext={vi.fn()} onPrevious={vi.fn()} onRead={vi.fn()} onNew={vi.fn()}
    position={0} total={0} confirmations={[]} statistics={{bodies:0,influences:0,outsideInfluences:0}} onVisit={onVisit} onTrace={vi.fn()} onBack={vi.fn()} path={[]} messageTypes={types}/>);
  fireEvent.click(view.getByText('范围外及筛选隐藏的待阅内容'));
  expect(view.getByText('【冷藏】')).toBeVisible();
  const groups=view.container.querySelectorAll<HTMLDetailsElement>('[data-reading-type-group]');expect(groups).toHaveLength(2);
  expect(groups[0]).not.toHaveAttribute('open');expect(groups[0].querySelector('summary')).toHaveTextContent('文本 · 范围外 · 2 条');
  expect(groups[1].querySelector('summary')).toHaveTextContent('文本 · 筛选隐藏 · 2 条');
  fireEvent.click(within(groups[0]).getByText('文本 · 范围外 · 2 条'));
  fireEvent.click(view.getByRole('button',{name:'继续追溯并阅读 b'}));expect(onVisit).toHaveBeenCalledWith(visit('b'));
  expect(view.getByRole('button',{name:'继续追溯并阅读 c'})).toBeVisible();
  fireEvent.click(within(groups[1]).getByText('文本 · 筛选隐藏 · 2 条'));
  fireEvent.click(view.getByRole('button',{name:'临时显示并阅读 d'}));expect(onVisit).toHaveBeenCalledWith(visit('d','filtered'));
});
