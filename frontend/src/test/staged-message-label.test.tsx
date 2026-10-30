import { fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import StagedMessageLabel from '../components/StagedMessageLabel';
import type { DemoMessage } from '../utils/modelBridge';
const message:DemoMessage={id:'message-id',content:'第一行内容\n第二行内容',kind:'normal',author:'tester',createdAt:''};

it('uses independent type and jump controls for staged fragments without changing legacy collections',()=>{
  const navigate=vi.fn();
  const view=render(<StagedMessageLabel messageId={message.id} message={message} content="选中的片段" ariaLabel="暂存片段 fragment" onNavigate={navigate}/>);
  const entry=view.getByRole('group',{name:'暂存片段 fragment'});
  fireEvent.click(view.getByRole('button',{name:'暂存片段 fragment'}));expect(entry).toHaveTextContent('【文本】 选中的片段');
  expect(entry).not.toHaveTextContent('第一行内容');expect(navigate).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button',{name:'跳转到暂存片段 fragment'}));expect(navigate).toHaveBeenCalledExactlyOnceWith(message.id);
});

it.each(['classify', 'summary', 'merge'] as const)('shows the %s card text rather than its target-ID summary', type => {
  const category: DemoMessage = {...message, kind:'relation', relationType:type, relationPayload:{title:'卡片标题\n保留换行'}, content:'分类：卡片标题\n目标：target-id', targetRefs:[{kind:'message',messageId:'target-id'}]};
  const view=render(<StagedMessageLabel messageId={category.id} message={category}/>);
  const entry=view.getByRole('button');
  const typeLabel = ({classify:'分类',summary:'总结',merge:'归并'})[type];
  expect(entry.textContent).toBe(`【${typeLabel}】 ${category.id}`);
  fireEvent.click(entry);
  expect(entry.textContent).toBe(`【${typeLabel}】 卡片标题\n保留换行`);
  expect(entry).not.toHaveTextContent('target-id');
  fireEvent.click(entry);expect(entry.textContent).toBe(`【${typeLabel}】 ${category.id}`);
});

it('uses legacy payload content and an untitled classification fallback without listing targets',()=>{
  const category:DemoMessage={...message,kind:'relation',relationType:'classify',relationPayload:{content:'旧分类正文'},targetRefs:[{kind:'message',messageId:'target-id'}],content:'分类：旧分类正文\n目标：target-id'};
  const view=render(<StagedMessageLabel messageId={category.id} message={category}/>);
  fireEvent.click(view.getByRole('button'));expect(view.getByRole('button').textContent).toBe('【分类】 旧分类正文');
  view.rerender(<StagedMessageLabel messageId={category.id} message={{...category,relationPayload:{}}}/>);
  expect(view.getByRole('button').textContent).toBe('【分类】 分类（1）');
});

it('toggles each entry independently between its ID and full content',()=>{
  const {getByRole}=render(<><StagedMessageLabel messageId={message.id} message={message} status="已选择整条"/><StagedMessageLabel messageId="other" message={{...message,id:'other',content:'其他消息'}} status="已选择 1 处"/></>);
  const first=getByRole('button',{name:'暂存消息 message-id'}),other=getByRole('button',{name:'暂存消息 other'});
  expect(first).toHaveTextContent('【文本】 message-id');expect(first).not.toHaveTextContent('第一行内容');
  fireEvent.click(first);expect(first).toHaveAttribute('aria-pressed','true');expect(first.textContent).toContain(`【文本】 ${message.content}`);
  expect(other).toHaveAttribute('aria-pressed','false');expect(other).toHaveTextContent('other');
  fireEvent.click(other);expect(other).toHaveTextContent('其他消息');
  fireEvent.click(first);expect(first).toHaveAttribute('aria-pressed','false');expect(first).toHaveTextContent('message-id');
});

it('resets inspection when an entry is removed and re-added, and safely renders markup as text',()=>{
  const view=render(<StagedMessageLabel messageId="message-id" message={{...message,content:'<script>内容</script>'}} status="已选择整条"/>);
  fireEvent.click(view.getByRole('button'));
  expect(view.container.querySelector('script')).toBeNull();expect(view.getByRole('button')).toHaveTextContent('<script>内容</script>');
  view.rerender(<></>);view.rerender(<StagedMessageLabel messageId="message-id" message={message} status="已选择整条"/>);
  expect(view.getByRole('button')).toHaveAttribute('aria-pressed','false');expect(view.getByRole('button')).not.toHaveTextContent('第一行内容');
});

it('keeps fragments as IDs until selected, then shows the selected fragment rather than the whole body',()=>{
  const {getByRole}=render(<StagedMessageLabel messageId="message-id" message={message} content="选中的片段" ariaLabel="暂存片段 part-1" status="已选择片段"/>);
  const entry=getByRole('button',{name:'暂存片段 part-1'});
  expect(entry).toHaveTextContent('message-id');expect(entry).not.toHaveTextContent('选中的片段');
  fireEvent.click(entry);expect(entry).toHaveTextContent('【文本】 选中的片段');expect(entry).not.toHaveTextContent('第一行内容');
  fireEvent.click(entry);expect(entry).toHaveTextContent('message-id');expect(entry).not.toHaveTextContent('选中的片段');
});

it.each(['暂存消息', '暂存片段', '来源消息', '目标消息'])('copies only the message ID on double click in %s while preserving inspection', async label => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const view = render(<StagedMessageLabel messageId={message.id} message={message} content="选中的片段" ariaLabel={`${label} entry`} />);
  const entry = view.getByRole('button');
  expect(entry).toHaveAttribute('title', expect.stringContaining('双击复制消息 ID'));
  await user.dblClick(entry);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(message.id);
  expect(entry).toHaveAttribute('aria-pressed', 'false');
  expect(view.getByRole('status')).toHaveTextContent('已复制消息 ID');
  await user.click(entry);
  expect(entry).toHaveTextContent('【文本】 选中的片段');
  await user.dblClick(entry);
  expect(writeText).toHaveBeenLastCalledWith(message.id);
  expect(writeText).toHaveBeenCalledTimes(2);
  expect(entry).toHaveAttribute('aria-pressed', 'true');
  expect(entry).toHaveTextContent('【文本】 选中的片段');
  writeText.mockRestore();
});

it('reports clipboard failure without claiming success or losing the selection', async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  const view = render(<StagedMessageLabel messageId={message.id} message={message} />);
  const entry = view.getByRole('button');
  fireEvent.click(entry);
  await user.dblClick(entry);
  await waitFor(() => expect(view.getByRole('status')).toHaveTextContent('复制失败，请重试'));
  expect(entry).not.toHaveTextContent('已复制消息 ID');
  expect(entry).toHaveAttribute('aria-pressed', 'true');
  writeText.mockRestore();
});
