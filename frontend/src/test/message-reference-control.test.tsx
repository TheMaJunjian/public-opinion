import {act,fireEvent,render} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import MessageReferenceControl from '../components/MessageReferenceControl';

afterEach(()=>vi.restoreAllMocks());
const advance=()=>act(()=>new Promise<void>(resolve=>setTimeout(resolve,550)));
it('can start with a summary and toggles only the display when clicking the type',()=>{
  const navigate=vi.fn();
  const view=render(<MessageReferenceControl messageId="record-id" type="引用" summary="中文正文摘要" initialView="summary" onNavigate={navigate} wholeMessage={false}/>);
  const type=view.getByRole('button',{name:'切换消息 record-id 的摘要和 ID'}),value=view.getByRole('button',{name:'跳转到消息 record-id'});
  expect(value).toHaveTextContent('中文正文摘要');fireEvent.click(type);expect(value).toHaveTextContent('record-id');expect(navigate).not.toHaveBeenCalled();
  view.rerender(<MessageReferenceControl messageId="record-id" type="引用" summary="更新后的中文摘要" initialView="summary" onNavigate={navigate} wholeMessage={false}/>);
  expect(value).toHaveTextContent('record-id');fireEvent.click(type);expect(value).toHaveTextContent('更新后的中文摘要');
  fireEvent.click(value);expect(navigate).toHaveBeenCalledExactlyOnceWith('record-id');
});
it('toggles a compact summary from the type and navigates from the value, including keyboard activation',async()=>{
  const user=userEvent.setup(),navigate=vi.fn();
  const view=render(<MessageReferenceControl messageId="record-id" type="文本" summary={'第一行\n第二行'} onNavigate={navigate}/>);
  const type=view.getByRole('button',{name:'切换消息 record-id 的摘要和 ID'}),value=view.getByRole('button',{name:'跳转到消息 record-id'});
  await user.click(type);expect(value).toHaveTextContent('record-id');await advance();
  expect(value).toHaveTextContent('第一行 第二行');expect(navigate).not.toHaveBeenCalled();
  await user.click(value);expect(navigate).not.toHaveBeenCalled();await advance();expect(navigate).toHaveBeenCalledExactlyOnceWith('record-id');
  type.focus();await user.keyboard('[Enter]');expect(value).toHaveTextContent('record-id');
  value.focus();await user.keyboard('[Enter]');expect(navigate).toHaveBeenCalledTimes(2);
});
it.each(['type','value'])('double clicking the %s copies only the exact ID and cancels the competing single click',async part=>{
  const user=userEvent.setup(),navigate=vi.fn();
  const copy=vi.spyOn(navigator.clipboard,'writeText').mockResolvedValue();
  const view=render(<MessageReferenceControl messageId="record-id" type="分类" summary="分类摘要" onNavigate={navigate}/>);
  const type=view.getByRole('button',{name:'切换消息 record-id 的摘要和 ID'}),value=view.getByRole('button',{name:'跳转到消息 record-id'});
  await user.dblClick(part==='type'?type:value);await advance();
  expect(copy).toHaveBeenCalledExactlyOnceWith('record-id');expect(navigate).not.toHaveBeenCalled();
  expect(type).toHaveAttribute('aria-pressed','false');expect(value).toHaveTextContent('record-id');
  expect(view.getByRole('status')).toHaveTextContent('已复制消息 ID');
});
it('copies the ID while showing a summary and reports failure without changing the display',async()=>{
  const user=userEvent.setup(),navigate=vi.fn();
  vi.spyOn(navigator.clipboard,'writeText').mockRejectedValue(new Error('denied'));
  const view=render(<MessageReferenceControl messageId="record-id" type="引用" summary="引用摘要" onNavigate={navigate}/>);
  fireEvent.click(view.getByRole('button',{name:'切换消息 record-id 的摘要和 ID'}));
  await user.dblClick(view.getByRole('button',{name:'跳转到消息 record-id'}));await advance();
  expect(view.getByRole('status')).toHaveTextContent('复制失败，请重试');
  expect(view.getByRole('button',{name:'跳转到消息 record-id'})).toHaveTextContent('引用摘要');expect(navigate).not.toHaveBeenCalled();
});
it('cancels a queued jump when the entry is removed',async()=>{
  const navigate=vi.fn();
  const view=render(<MessageReferenceControl messageId="record-id" type="文本" onNavigate={navigate}/>);
  fireEvent.click(view.getByRole('button',{name:'跳转到消息 record-id'}),{detail:1});view.unmount();await advance();
  expect(navigate).not.toHaveBeenCalled();
});
