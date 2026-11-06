import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NotificationItem, NotificationPage } from '@gonglun/core';
import NotificationPanel from '../components/NotificationPanel';
import { useNotificationNavigation } from '../hooks/useNotificationNavigation';
import { useNotifications } from '../hooks/useNotifications';
import { groupNotifications, notificationPath, NOTIFICATIONS_CHANGED } from '../data/notifications';
import { getNotifications, getNotificationSummary, markNotificationsSeen, muteNotifications, deleteNotifications, subscribeChanges } from '../api/client';

vi.mock('../api/client',()=>({getNotifications:vi.fn(),getNotificationSummary:vi.fn(),markNotificationsSeen:vi.fn(),muteNotifications:vi.fn(),deleteNotifications:vi.fn(),subscribeChanges:vi.fn()}));
const item=(id:number,overrides:Partial<NotificationItem>={}):NotificationItem=>({
  id,sourceId:`reply-${id}`,targetId:'target',actorId:'bob',actorName:'张三',action:'回复了消息',excerpt:`新回复 ${id}`,
  targetExcerpt:'原消息',sourceRevision:1,references:[{messageId:'target'}],reasons:['你是目标消息的作者'],watchedIds:[],
  category:'direct',kind:'reply',groupKey:`event-${id}`,createdAt:'2026-11-05T08:00:00.000Z',seenAt:null,muted:false,...overrides,
});
const page=(items:NotificationItem[]=[item(10)]):NotificationPage=>({items,through:20,unseenCount:items.filter(item=>!item.seenAt).length,sequence:42,nextCursor:null});
beforeEach(()=>{vi.clearAllMocks();vi.mocked(getNotifications).mockResolvedValue(page());vi.mocked(markNotificationsSeen).mockResolvedValue({ok:true});vi.mocked(muteNotifications).mockResolvedValue({ok:true});});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});

it('deletes an individual notification and clears only viewed records through the current snapshot',async()=>{
  vi.mocked(deleteNotifications).mockResolvedValue({ok:true});
  render(<MemoryRouter><NotificationPanel revision={0} onClose={vi.fn()}/></MemoryRouter>);
  await screen.findByText('新回复 10');
  fireEvent.click(screen.getByRole('button',{name:'删除通知'}));
  await waitFor(()=>expect(deleteNotifications).toHaveBeenCalledWith({through:20,ids:[10]}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'清除已查看'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'清除已查看'}));
  await waitFor(()=>expect(deleteNotifications).toHaveBeenCalledWith({through:20,category:'all',seenOnly:true}));
  expect(markNotificationsSeen).not.toHaveBeenCalled();
});

it('opens a newly joined member instead of the generated membership record',()=>{
  const path=notificationPath(item(40,{sourceId:'join-record',navigationId:'new-member',targetId:'category'}),'/messages');
  const params=new URLSearchParams(path.split('?')[1]);
  expect(params.get('notificationSource')).toBe('new-member');expect(params.get('notificationTarget')).toBe('category');
});

it('opening and filtering the inbox does not mark notifications or message reading',async()=>{
  render(<MemoryRouter><NotificationPanel revision={0} onClose={vi.fn()}/></MemoryRouter>);
  await screen.findByText('新回复 10');
  expect(markNotificationsSeen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('仅未查看'));
  await waitFor(()=>expect(getNotifications).toHaveBeenLastCalledWith({category:'all',unread:true},expect.any(AbortSignal)));
  fireEvent.click(screen.getByRole('button',{name:'资金与委托'}));
  await waitFor(()=>expect(getNotifications).toHaveBeenLastCalledWith({category:'financial',unread:true},expect.any(AbortSignal)));
  expect(markNotificationsSeen).not.toHaveBeenCalled();
});

it('marks all only through the displayed snapshot and keeps failures actionable',async()=>{
  render(<MemoryRouter><NotificationPanel revision={0} onClose={vi.fn()}/></MemoryRouter>);
  await screen.findByText('新回复 10');
  vi.mocked(markNotificationsSeen).mockRejectedValueOnce(new Error('网络中断，未保存'));
  fireEvent.click(screen.getByRole('button',{name:'全部标为已查看'}));
  await screen.findByRole('alert');
  expect(markNotificationsSeen).toHaveBeenCalledWith({through:20,category:'all'});
  expect(screen.getByLabelText('未查看')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'重试'})).toBeInTheDocument();
});

it('groups the same type across targets and event groups without acknowledging collapsed notifications',async()=>{
  const votes=[item(12,{groupKey:'votes-a',targetId:'a',kind:'agree',action:'赞同了消息'}),item(11,{groupKey:'votes-b',targetId:'b',kind:'agree',actorName:'李四',action:'赞同了消息'})];
  vi.mocked(getNotifications).mockResolvedValue(page(votes));
  render(<MemoryRouter><NotificationPanel revision={0} onClose={vi.fn()}/></MemoryRouter>);
  const summary=await screen.findByRole('button',{name:/赞同 · 2 条.*2 条未查看/});
  expect(summary).toHaveAttribute('aria-expanded','false');
  expect(screen.queryByText('新回复 12')).toBeNull();fireEvent.click(summary);
  expect(groupNotifications(votes)).toHaveLength(1);
  expect(screen.getByText('新回复 12')).toBeInTheDocument();expect(screen.getByText('新回复 11')).toBeInTheDocument();
  fireEvent.click(summary);expect(screen.queryByText('新回复 12')).toBeNull();
  expect(markNotificationsSeen).not.toHaveBeenCalled();
});

it('keeps type sections in newest-first order and retains their expansion when another page arrives',async()=>{
  vi.mocked(getNotifications).mockResolvedValueOnce({...page([item(20),item(19,{kind:'reference'}),item(18)]),nextCursor:18})
    .mockResolvedValueOnce(page([item(17),item(16,{kind:'reference'})]));
  render(<MemoryRouter><NotificationPanel revision={0} onClose={vi.fn()}/></MemoryRouter>);
  const replies=await screen.findByRole('button',{name:/回复 · 2 条/});
  expect([...document.querySelectorAll('[data-notification-kind]')].map(element=>element.getAttribute('data-notification-kind'))).toEqual(['reply','reference']);
  fireEvent.click(replies);
  fireEvent.click(screen.getByRole('button',{name:'加载更多'}));
  await screen.findByRole('button',{name:/回复 · 3 条/});
  expect(screen.getByText('新回复 17')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:/回复 · 3 条/})).toHaveAttribute('aria-expanded','true');
  expect(screen.getByRole('button',{name:/引用 · 2 条/})).toHaveAttribute('aria-expanded','false');
  expect(markNotificationsSeen).not.toHaveBeenCalled();
});

it('preserves the composer and marks a clicked notification only after successful location',async()=>{
  let complete:((located:boolean,cancelled?:boolean)=>void)|undefined;
  const highlight=vi.fn();
  const locate=vi.fn((_id:string,options:{onComplete:(located:boolean,cancelled?:boolean)=>void})=>{complete=options.onComplete;});
  function Harness(){
    const [open,setOpen]=useState(true),[draft,setDraft]=useState('保留我的草稿');
    const location=useLocation();
    useNotificationNavigation({ready:true,navigate:locate,openSettlement:vi.fn(),onError:vi.fn(),onLocated:highlight});
    return <><output aria-label="当前地址">{location.pathname}{location.search}</output><textarea aria-label="草稿" value={draft} onChange={event=>setDraft(event.target.value)}/>{open&&<NotificationPanel revision={0} onClose={()=>setOpen(false)}/>}</>;
  }
  render(<MemoryRouter initialEntries={['/messages/category?sender=alice&notificationRound=stale']}><Harness/></MemoryRouter>);
  fireEvent.click(await screen.findByText('新回复 10'));
  await waitFor(()=>expect(locate).toHaveBeenCalledWith('reply-10',expect.objectContaining({select:false})));
  expect(markNotificationsSeen).not.toHaveBeenCalled();
  expect(highlight).not.toHaveBeenCalled();
  expect(screen.getByLabelText('草稿')).toHaveValue('保留我的草稿');
  expect(screen.getByLabelText('当前地址')).toHaveTextContent('sender=alice');
  expect(screen.getByLabelText('当前地址')).not.toHaveTextContent('notificationRound');
  await act(async()=>{complete!(true);});
  expect(highlight).toHaveBeenCalledWith('reply-10','target');
  expect(markNotificationsSeen).toHaveBeenCalledWith({through:10,ids:[10]});
  expect(screen.getByLabelText('当前地址')).toHaveTextContent('/messages/category?sender=alice');
  expect(screen.getByLabelText('当前地址')).not.toHaveTextContent('notification');
});

it('does not acknowledge failed or cancelled navigation and retains the settlement round',async()=>{
  const locate=vi.fn((_id:string,options:{onComplete:(located:boolean,cancelled?:boolean)=>void})=>options.onComplete(false,true));
  const target=item(22,{roundId:'round-2',settlementType:'VALUE',category:'financial'});
  const path=notificationPath(target,'/messages/category');
  expect(path).toContain('notificationRound=round-2');expect(path).toContain('notificationSettlement=VALUE');
  function Harness(){useNotificationNavigation({ready:true,navigate:locate,openSettlement:vi.fn(),onError:vi.fn()});return <span>{useLocation().pathname}</span>;}
  render(<MemoryRouter initialEntries={[path]}><Harness/></MemoryRouter>);
  await waitFor(()=>expect(locate).toHaveBeenCalledWith('target',expect.objectContaining({select:false})));
  expect(markNotificationsSeen).not.toHaveBeenCalled();
});

it('catches up on event reconnects, periodic checks and private state changes',async()=>{
  vi.useFakeTimers();
  const stream={readyState:1,onmessage:null as null|((event:{data:string})=>void),onopen:null as null|(()=>void),onerror:null as null|(()=>void),close:vi.fn()};
  vi.mocked(subscribeChanges).mockReturnValue(stream as unknown as EventSource);
  vi.mocked(getNotificationSummary).mockResolvedValue({unseenCount:1,through:10,sequence:50});
  function Badge(){const state=useNotifications('alice');return <output>{state.summary.unseenCount}</output>;}
  const view=render(<Badge/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(screen.getByRole('status')).toHaveTextContent('1');
  expect(subscribeChanges).toHaveBeenCalledWith(50);
  vi.mocked(getNotificationSummary).mockResolvedValue({unseenCount:2,through:11,sequence:51});
  await act(async()=>{stream.onopen!();await vi.advanceTimersByTimeAsync(2000);});
  expect(screen.getByRole('status')).toHaveTextContent('2');
  vi.mocked(getNotificationSummary).mockResolvedValue({unseenCount:0,through:11,sequence:51});
  await act(async()=>{window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));await vi.advanceTimersByTimeAsync(0);});
  expect(screen.getByRole('status')).toHaveTextContent('0');
  vi.mocked(getNotificationSummary).mockResolvedValue({unseenCount:1,through:12,sequence:52});
  await act(async()=>{await vi.advanceTimersByTimeAsync(30_000);});
  expect(screen.getByRole('status')).toHaveTextContent('1');
  view.unmount();expect(stream.close).toHaveBeenCalled();
});
