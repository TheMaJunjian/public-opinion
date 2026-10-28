import {fireEvent,render,screen,within} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import MessageCard from '../components/MessageCard';
import MessageTime from '../components/MessageTime';
import {MessageDisplayHintsProvider} from '../components/MessageDisplayHints';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import type {DemoMessage} from '../utils/modelBridge';

it('keeps authors and time in the status window, including for an authored message already read automatically',()=>{
  const value='2026-10-27T10:31:42Z';
  const message:DemoMessage={id:'message',author:'writer',kind:'normal',content:'独立消息',createdAt:value};
  const model={messages:[message],edges:[],relations:[],username:'writer'},onMarkRead=vi.fn();
  const input={...model,readStatus:new Map<string,'READ'|'UNREAD'>(),corrections:new Map(),personalEffect:deriveContainerEffect({...model,stakeCounts:{}})};
  const view=render(<MessageDisplayHintsProvider input={input} onView={vi.fn()} onMarkRead={onMarkRead}><MessageCard msg={message} ctx={{}}/></MessageDisplayHintsProvider>);
  expect(view.container.querySelector('time,[data-message-authors]')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:/^显示提示 message：消息已阅/}));
  const popup=screen.getByRole('tooltip'),time=popup.querySelector('time')!;
  expect(time).toHaveAttribute('datetime','2026-10-27T10:31:42.000Z');
  expect(time.textContent).toMatch(/2026.*10.*27.*\d{2}:31/);
  expect(time.title).toMatch(/发送时间：.*:42/);
  const author=within(popup).getByRole('button',{name:'查看消息 message 的当前正文作者：writer'});
  fireEvent.click(author);
  const dialog=screen.getByRole('dialog',{name:'消息 message 的当前正文作者'});
  fireEvent.pointerDown(dialog);expect(screen.getByRole('tooltip')).toBe(popup);
  fireEvent.click(within(dialog).getByRole('button',{name:'关闭作者详情'}));
  expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByRole('tooltip')).toBe(popup);
  expect(onMarkRead).not.toHaveBeenCalled();
  expect(screen.getByText('独立消息')).toBeInTheDocument();
});

it('omits missing timestamps instead of displaying an invalid date',()=>{
  const {container}=render(<MessageTime value=""/>);expect(container).toBeEmptyDOMElement();
});
