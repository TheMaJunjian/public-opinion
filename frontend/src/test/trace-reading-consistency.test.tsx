import {act,fireEvent,render,screen,within} from '@testing-library/react';
import {useState} from 'react';
import {expect,it,vi} from 'vitest';
import type {ReadingMark} from '@gonglun/core';
import type {Message,Relation} from '../types';
import {MessageDisplayHintsProvider,MessageDisplayMarker} from '../components/MessageDisplayHints';
import TraceReadingController from '../components/TraceReadingController';
import {convertMessagesToDemoModel,computeCorrectionVersions} from '../utils/modelBridge';
import {deriveContainerEffect} from '../pages/workbench/model/containerEffect';
import {deriveDisplayHints} from '../pages/workbench/model/displayHints';
import {influenceReadingMarks,readingMarksFor} from '../pages/workbench/model/readingProgress';
import {useBrowsingHistory} from '../pages/workbench/useBrowsingHistory';
import RecentWorkbenchViews from '../components/RecentWorkbenchViews';
import type {ReadingNavigationMarkers} from '../hooks/useViewedMessageHighlight';

const writer={id:'writer',username:'writer',createdAt:''};
const text=(id:string):Message=>({id,kind:'TEXT',content:id,contentType:'TEXT',createdAt:'2026-01-01',createdBy:writer});
const relation=(id:string,type:string,targets=['m'],source:string|null=null):Relation=>({id,relationType:type,sourceMessageId:source,
  targetRefs:targets.map(messageId=>({kind:'message',messageId})),createdAt:'2026-01-02',createdBy:writer,payload:{}});
function fixture(relations:Relation[]=[relation('read-vote','AGREE'),relation('new-tag','TAG'),relation('container','CLASSIFY',[]),relation('join','JOIN',['m'],'container')],records:Message[]=[text('m'),text('reason')]){
  const model=convertMessagesToDemoModel(records,relations);
  const personalEffect=deriveContainerEffect({...model,relations,username:'viewer',stakeCounts:{}});
  const input={...model,relations,personalEffect,memberships:personalEffect.memberships,effectiveJoinIds:personalEffect.effectiveJoinIds,
    username:'viewer',readStatus:new Map<string,'READ'|'UNREAD'>(),readingMarks:[] as ReadingMark[],corrections:computeCorrectionVersions(model.messages,model.edges)};
  const hints=deriveDisplayHints(input);
  return {...input,readingMarks:[...readingMarksFor(input,'m',hints.hints.get('m')!.displayed,'message',{automaticInfluences:false}),
    ...influenceReadingMarks('m',hints.reading.influences.get('m')!.filter(item=>item.messageId==='read-vote'))]};
}
const scope=new Set(['m','reason']);
function Harness({input=fixture(),save=async()=>{},initial=['m'],onNavigationChange}:{input?:ReturnType<typeof fixture>;save?:(marks:ReadingMark[])=>Promise<void>;initial?:string[];onNavigationChange?:(markers:ReadingNavigationMarkers)=>void}){
  const [focus,setFocus]=useState(initial),[marks,setMarks]=useState(input.readingMarks),[selected,setSelected]=useState(['reason']);
  const [visible,setVisible]=useState(true);
  const history=useBrowsingHistory('reading',()=>focus,setFocus);
  const navigate=async(ids:string[])=>{history.record();setFocus(ids);};
  return <MessageDisplayHintsProvider input={{...input,readingMarks:marks}} onView={vi.fn()} onMarkRead={async batch=>{await save(batch);setMarks(previous=>[...previous,...batch]);}}>
    <button onClick={()=>setSelected(['m'])}>选择 m</button><button onClick={()=>setSelected(['reason'])}>选择 reason</button>
    <button onClick={()=>setSelected(['m','reason'])}>选择整组</button>
    <MessageDisplayMarker messageId="m"/>
    <button onClick={()=>setVisible(value=>!value)}>{visible?'隐藏阅读区':'显示阅读区'}</button>
    <RecentWorkbenchViews viewKey={visible?'reading':'none'} limit={2}>
    {visible&&<TraceReadingController scopeKey="consistency" scopeIds={scope} allowedIds={scope} direction="both" order="discussion" onOrder={vi.fn()}
      path={[initial]} focusId={focus[0]} focusIds={focus} recentSelectedIds={selected} focusLocated incoming={[]} ready onNavigate={id=>navigate([id])} onNavigateGroup={navigate} onBack={vi.fn()}
      canGoBack={history.canGoBack} canGoForward={history.canGoForward} onBackward={history.back} onForward={history.forward} onNavigationChange={onNavigationChange}/>}
    </RecentWorkbenchViews>
  </MessageDisplayHintsProvider>;
}
it('retains reading windows across leaving and returning without allowing a parked save to navigate',async()=>{
  let finish!:()=>void;const save=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
  render(<Harness save={save}/>);
  const section=document.querySelector<HTMLDetailsElement>('[data-reading-message-section="m"]')!;
  fireEvent.click(section.querySelector('summary')!);expect(section.open).toBe(false);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'已读并继续'})));
  fireEvent.click(screen.getByRole('button',{name:'隐藏阅读区'}));expect(section.isConnected).toBe(false);
  await act(async()=>finish());
  fireEvent.click(screen.getByRole('button',{name:'显示阅读区'}));
  expect(document.querySelector('[data-reading-message-section="m"]')).toBe(section);expect(section.open).toBe(false);
  expect(document.querySelector('[data-reading-current-id]')).toHaveAttribute('data-reading-current-id','m');
  expect(save).toHaveBeenCalledOnce();expect(screen.getByRole('button',{name:'设为阅读消息'})).toBeEnabled();
  expect(screen.getByRole('button',{name:'已读并继续'})).toBeDisabled();
});
it('marks the same continue target that is opened after confirming and shows no target when confirmation is complete',async()=>{
  const onNavigationChange=vi.fn();render(<Harness onNavigationChange={onNavigationChange}/>);
  expect(onNavigationChange.mock.lastCall?.[0]).toMatchObject({current:'m',continue:'reason'});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'已读并继续'})));
  expect(document.querySelector('[data-reading-current-id]')).toHaveAttribute('data-reading-current-id','reason');
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'已读并继续'})));
  expect(onNavigationChange.mock.lastCall?.[0].continue).toBeNull();
});
it('navigates actual reading history after explicitly choosing a message and preserves confirmed roots',async()=>{
  const input=fixture(),marks=readingMarksFor(input,'m',deriveDisplayHints(input).hints.get('m')!.displayed);
  render(<Harness input={{...input,readingMarks:[...input.readingMarks,...marks]}}/>);
  expect(screen.getByRole('button',{name:'已读并继续'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'阅读前进'})).toBeDisabled();
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'设为阅读消息'})));
  expect(screen.getByRole('button',{name:'阅读后退'})).toBeEnabled();
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'阅读后退'})));
  expect(document.querySelector('[data-reading-current-id]')).toHaveAttribute('data-reading-current-id','m');
  expect(screen.getByRole('button',{name:'阅读前进'})).toBeEnabled();
});
it('shows the same message and read/unread influence details in the reading area and status popup',async()=>{
  const save=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
  render(<Harness save={save}/>);
  const reading=screen.getByRole('region',{name:'追溯阅读'});
  const details=within(reading).getByRole('region',{name:'消息与影响'});
  expect(within(details).getByRole('region',{name:'消息阅读确认'})).toHaveTextContent('消息 · 【文本】 m');
  expect(within(details).getByRole('region',{name:'未阅影响'})).toHaveTextContent('未阅影响（2 条）');
  expect(within(details).getByRole('region',{name:'已阅影响'})).toHaveTextContent('已阅影响（1 条）');
  fireEvent.click(screen.getByRole('button',{name:/^显示提示 m：/}));
  const popup=within(screen.getByRole('tooltip')).getByRole('region',{name:'消息与影响'});
  expect(details.textContent).toBe(popup.textContent);
  await act(async()=>fireEvent.click(within(reading).getByRole('button',{name:'已读并继续'})));
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][0].filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['m']);
  expect(within(screen.getByRole('tooltip')).getByRole('button',{name:'当前消息已阅'})).toBeDisabled();
});
it.each([false,true])('starts at the newer trace source and keeps both messages browsable (initially read=%s)',async initiallyRead=>{
  const input=fixture([relation('reference','REFERENCE',['reason'],'m')],[{...text('m'),createdAt:'2026-10-12'},{...text('reason'),createdAt:'2026-08-15'}]);
  if(initiallyRead){const hints=deriveDisplayHints(input);input.readingMarks=[...input.readingMarks,...['m','reason'].flatMap(id=>readingMarksFor(input,id,hints.hints.get(id)!.displayed))];}
  render(<Harness input={input}/>);
  const current=()=>document.querySelector('[data-reading-current-id]')?.getAttribute('data-reading-current-id');
  const readCurrent=async()=>{
    const details=within(screen.getByRole('region',{name:'追溯阅读'})).getByRole('region',{name:'消息阅读确认'});
    const confirm=within(details).getByRole('button');if(!confirm.hasAttribute('disabled'))await act(async()=>fireEvent.click(confirm));
  };
  expect(current()).toBe('m');await readCurrent();
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'设为阅读消息'})));
  expect(current()).toBe('reason');await readCurrent();
  expect(screen.getByRole('button',{name:'阅读后退'})).toBeEnabled();
  expect(screen.getByRole('button',{name:'阅读前进'})).toBeDisabled();
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'阅读后退'})));
  expect(current()).toBe('m');
  expect(screen.getByRole('button',{name:'阅读前进'})).toBeEnabled();
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'阅读前进'})));
  expect(current()).toBe('reason');
});

it('confirms the whole reading group, shows each status separately and restores groups in history',async()=>{
  const save=vi.fn<(marks:ReadingMark[])=>Promise<void>>(async()=>{});
  render(<Harness initial={['m','reason']} save={save}/>);
  const current=()=>[...document.querySelectorAll('[data-reading-current-id]')].map(element=>element.getAttribute('data-reading-current-id'));
  expect(current()).toEqual(['m','reason']);
  expect(document.querySelectorAll('[data-reading-message-details]')).toHaveLength(2);
  const section=document.querySelector<HTMLDetailsElement>('[data-reading-message-section="m"]')!;
  fireEvent.click(section.querySelector('summary')!);
  expect(section).not.toHaveAttribute('open');
  expect(within(section).getByRole('region',{name:'消息与影响',hidden:true})).not.toBeVisible();
  expect(document.querySelector('[data-reading-message-section="reason"]')).toHaveAttribute('open');
  fireEvent.click(section.querySelector('summary')!);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'本组已读并继续'})));
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][0].filter(mark=>mark.scope==='message').map(mark=>mark.messageId)).toEqual(['m','reason']);
  fireEvent.click(section.querySelector('summary')!);expect(section).not.toHaveAttribute('open');
  fireEvent.click(screen.getByRole('button',{name:'选择 reason'}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'设为阅读消息'})));
  expect(current()).toEqual(['reason']);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'阅读后退'})));
  expect(current()).toEqual(['m','reason']);
  expect(document.querySelector('[data-reading-message-section="m"]')).toBe(section);
  expect(section).not.toHaveAttribute('open');
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'阅读前进'})));
  expect(current()).toEqual(['reason']);expect(save).toHaveBeenCalledOnce();
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'阅读后退'})));
  fireEvent.click(screen.getByRole('button',{name:'选择 m'}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'设为阅读消息'})));
  expect(current()).toEqual(['m']);expect(screen.getByRole('button',{name:'阅读前进'})).toBeDisabled();
});
