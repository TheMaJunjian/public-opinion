import {useCallback,useState} from 'react';
import {render,waitFor} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import type {ReadingMark} from '@gonglun/core';
import AuthoredReadingBackfill from '../components/AuthoredReadingBackfill';
import {authoredReadingMark,deriveReadingProgress} from '../pages/workbench/model/readingProgress';
import type {DemoMessage} from '../utils/modelBridge';

const context=vi.hoisted(()=>({current:null as any}));
vi.mock('../components/MessageDisplayHints',()=>({useReadingDisplayContext:()=>context.current}));

it('waits for readiness and backfills more than one batch while preserving explicit unread records',async()=>{
  const messages:DemoMessage[]=Array.from({length:502},(_,index)=>({id:`own-${index}`,sequence:index+1,kind:'normal',author:'me',authorId:'user',content:'旧消息',createdAt:'2025-01-01'}));
  messages.push({...messages[0],id:'foreign',author:'other',authorId:'other'},{...messages[0],id:'provisional',sequence:undefined});
  const unread={...authoredReadingMark(messages[0],'original'),state:'UNREAD' as const},saved=vi.fn();
  function Harness({enabled}:{enabled:boolean}){
    const [marks,setMarks]=useState<ReadingMark[]>([unread]);
    const onMarkRead=useCallback(async(batch:ReadingMark[])=>{saved(batch);await Promise.resolve();setMarks(previous=>[...previous,...batch]);},[]);
    const input={messages,relations:[],edges:[],marks,readStatus:new Map(),username:'me'};
    context.current={readingInput:input,onMarkRead,data:{reading:deriveReadingProgress(input),hints:new Map(messages.map(message=>[message.id,{displayed:{content:message.content,parentIds:[],memberIds:[],suppressed:false,correctionIds:[]}}]))}};
    return <><AuthoredReadingBackfill enabled={enabled} userId="user"/><output>{marks.length}</output></>;
  }
  const view=render(<Harness enabled={false}/>);expect(saved).not.toHaveBeenCalled();
  view.rerender(<Harness enabled/>);
  await waitFor(()=>expect(view.getByRole('status')).toHaveTextContent('502'));
  expect(saved.mock.calls.map(([batch])=>batch.length)).toEqual([500,1]);
  expect(saved.mock.calls.flatMap(([batch])=>batch).map(mark=>mark.messageId)).not.toContain('own-0');
  expect(saved.mock.calls.flatMap(([batch])=>batch).map(mark=>mark.messageId)).not.toContain('foreign');
  expect(saved.mock.calls.flatMap(([batch])=>batch).map(mark=>mark.messageId)).not.toContain('provisional');
  view.unmount();
});
