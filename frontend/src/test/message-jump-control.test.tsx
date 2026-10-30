import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import MessageJumpControl from '../components/MessageJumpControl';

const originalClipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');
const readText=vi.fn<()=>Promise<string>>();
beforeEach(()=>{readText.mockReset();Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText}});});
afterEach(()=>{cleanup();if(originalClipboard)Object.defineProperty(navigator,'clipboard',originalClipboard);else Reflect.deleteProperty(navigator,'clipboard');});
const open=()=>fireEvent.click(screen.getByRole('button',{name:'跳转'}));

it.each(['5ee3510d-0cb1-412e-9ce1-2091100a9544','cmv4ko39s003zmd14ysr10z2e','migration:lock:9299b01ef688c110dbbad15d8ab1d1ee','known-fixture'])('reads the clipboard on click and jumps once for the complete ID %s',async id=>{
  const onJump=vi.fn();readText.mockResolvedValue(` ${id}\n`);
  render(<MessageJumpControl knownIds={new Set(['known-fixture'])} onJump={onJump}/>);
  expect(readText).not.toHaveBeenCalled();open();
  await waitFor(()=>expect(onJump).toHaveBeenCalledExactlyOnceWith(id));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button',{name:'跳转'})).toHaveFocus();
});

it('selects ordinary clipboard text, permits editing and submits the edited ID with Enter',async()=>{
  const onJump=vi.fn();readText.mockResolvedValue('一段普通文本，不是消息 ID');
  render(<MessageJumpControl knownIds={new Set()} onJump={onJump}/>);open();
  const input=screen.getByRole<HTMLInputElement>('textbox',{name:'消息 ID'});
  await waitFor(()=>expect(input).toHaveValue('一段普通文本，不是消息 ID'));
  expect(onJump).not.toHaveBeenCalled();expect(input).toHaveFocus();
  expect([input.selectionStart,input.selectionEnd]).toEqual([0,input.value.length]);
  fireEvent.change(input,{target:{value:'remote-51'}});fireEvent.click(input);
  expect([input.selectionStart,input.selectionEnd]).toEqual([0,input.value.length]);
  fireEvent.keyDown(input,{key:'Enter'});expect(onJump).toHaveBeenCalledExactlyOnceWith('remote-51');
});

it('allows manual entry when clipboard permission is denied and cancels with Escape',async()=>{
  const onJump=vi.fn();readText.mockRejectedValue(new DOMException('denied','NotAllowedError'));
  render(<MessageJumpControl knownIds={new Set()} onJump={onJump}/>);open();
  await screen.findByText('未能读取剪贴板，请粘贴或输入消息 ID。');
  const dialog=screen.getByRole('dialog',{name:'跳转消息'}),input=within(dialog).getByRole('textbox');
  fireEvent.click(within(dialog).getByRole('button',{name:'跳转'}));
  expect(screen.getByRole('status')).toHaveTextContent('请输入消息 ID');expect(onJump).not.toHaveBeenCalled();
  fireEvent.keyDown(input,{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();
});

it('does not let a delayed clipboard read replace an edit or trigger navigation after cancellation',async()=>{
  let release!:(text:string)=>void;const onJump=vi.fn();
  readText.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  render(<MessageJumpControl knownIds={new Set(['auto-id'])} onJump={onJump}/>);open();
  const input=screen.getByRole('textbox',{name:'消息 ID'});
  fireEvent.change(input,{target:{value:'edited-id'}});
  await act(async()=>release('auto-id'));expect(input).toHaveValue('edited-id');expect(onJump).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'取消'}));open();
  fireEvent.click(screen.getByRole('button',{name:'取消'}));
  await act(async()=>release('auto-id'));expect(onJump).not.toHaveBeenCalled();expect(screen.queryByRole('dialog')).toBeNull();
});
