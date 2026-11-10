import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
it('opens a review notification at its reviewed version and offers a separate review inbox category',async()=>{
  const notice=item(41,{category:'review',kind:'review-result',sourceId:'system-process',excerpt:'',
    targetMessageType:'分类',targetExcerpt:'实际分类标题',reviewTarget:{messageId:'original',revision:3}});
  const params=new URLSearchParams(notificationPath(notice,'/messages').split('?')[1]);
  expect(params.get('notificationSource')).toBe('original');expect(params.get('notificationReviewRevision')).toBe('3');
  vi.mocked(getNotifications).mockResolvedValue({...page([notice]),unseenByCategory:{review:1}});
  const close=vi.fn();
  render(<MemoryRouter><NotificationPanel revision={0} onClose={close}/></MemoryRouter>);
  await screen.findByText('【分类】');
  const type=screen.getByRole('button',{name:'切换消息 original 的摘要和 ID'});
  expect(screen.getByRole('button',{name:'跳转到消息 original'})).toHaveTextContent('实际分类标题');
  expect(screen.queryByText(/关联：|查看消息详情/)).toBeNull();
  fireEvent.click(type);
  expect(screen.getByRole('button',{name:'跳转到消息 original'})).toHaveTextContent(/^original$/);
  fireEvent.click(type);
  expect(screen.getByRole('button',{name:'跳转到消息 original'})).toHaveTextContent('实际分类标题');
  expect(markNotificationsSeen).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
  expect(document.querySelector('button button')).toBeNull();
  const button=screen.getByRole('button',{name:'审核'});expect(button).toHaveTextContent('1 未查看');
  fireEvent.click(button);
  await waitFor(()=>expect(getNotifications).toHaveBeenLastCalledWith({category:'review',unread:false},expect.any(AbortSignal)));
  fireEvent.click(screen.getByRole('button',{name:'全部标为已查看'}));
  await waitFor(()=>expect(markNotificationsSeen).toHaveBeenCalledWith({through:20,category:'review'}));
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

it('keeps the current list and counts mounted during switches, blocks stale actions and ignores late responses',async()=>{
  let following!: (value:NotificationPage)=>void,financial!: (value:NotificationPage)=>void;
  const slowFollowing=new Promise<NotificationPage>(resolve=>{following=resolve;}),slowFinancial=new Promise<NotificationPage>(resolve=>{financial=resolve;});
  const counts={unseenCount:7,unseenByCategory:{direct:1,review:4,'review-revoked':2}};
  vi.mocked(getNotifications).mockImplementation(async query=>query?.category==='following'?slowFollowing:query?.category==='financial'?slowFinancial:{...page(),...counts});
  render(<MemoryRouter><NotificationPanel revision={0} onClose={vi.fn()}/></MemoryRouter>);
  const previous=(await screen.findByText('新回复 10')).closest('article')!;
  fireEvent.click(screen.getByRole('button',{name:'关注动态'}));
  expect(screen.getByText('新回复 10').closest('article')).toBe(previous);
  expect(screen.getByRole('button',{name:'审核'})).toHaveTextContent('6 未查看');
  expect(document.querySelector('.notification-panel header')).toHaveTextContent('7 条未查看');
  expect(screen.queryByText('正在同步通知')).toBeNull();
  expect(screen.queryByText('正在加载通知…')).toBeNull();
  expect(screen.getByRole('button',{name:'删除通知'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'全部标为已查看'})).toBeDisabled();
  expect(within(previous).getByRole('button',{name:/新回复 10/})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'删除通知'}));
  expect(deleteNotifications).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'资金与委托'}));
  await act(async()=>{following({...page([item(11,{excerpt:'迟到的关注通知'})]),...counts});});
  expect(screen.queryByText('迟到的关注通知')).toBeNull();
  expect(screen.getByText('新回复 10').closest('article')).toBe(previous);
  await act(async()=>{financial({...page([item(12,{category:'financial',excerpt:'资金通知正文'})]),...counts});});
  expect(screen.getByText('资金通知正文')).toBeInTheDocument();
  expect(screen.queryByText('新回复 10')).toBeNull();
  expect(screen.getByRole('button',{name:'删除通知'})).toBeEnabled();
  expect(markNotificationsSeen).not.toHaveBeenCalled();
});

it('retains summary counts after a failed switch and retries without exposing actions for the previous section',async()=>{
  vi.mocked(getNotifications).mockResolvedValueOnce({...page(),unseenCount:7})
    .mockRejectedValueOnce(new Error('通知加载失败'))
    .mockResolvedValueOnce({...page([item(13,{category:'following',excerpt:'重新加载成功'})]),unseenCount:7});
  render(<MemoryRouter><NotificationPanel revision={0} onClose={vi.fn()}/></MemoryRouter>);
  await screen.findByText('新回复 10');
  fireEvent.click(screen.getByRole('button',{name:'关注动态'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('通知加载失败');
  expect(document.querySelector('.notification-panel header')).toHaveTextContent('7 条未查看');
  expect(screen.queryByText('新回复 10')).toBeNull();
  expect(screen.getByRole('button',{name:'全部标为已查看'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'重试'}));
  expect(await screen.findByText('重新加载成功')).toBeInTheDocument();
  expect(markNotificationsSeen).not.toHaveBeenCalled();
});

it('nests withdrawals within review while preserving the unhandled filter and scoped actions',async()=>{
  const task=item(45,{category:'review',kind:'review-assigned',excerpt:'',reviewTarget:{messageId:'target',revision:1},
    seenAt:'2026-11-05T09:00:00.000Z',reviewTaskStatus:'pending',reviewTaskExpiresAt:'2026-11-05T09:30:00.000Z'});
  const withdrawn=item(46,{category:'review',kind:'review-revoked',action:'审核任务已撤回',excerpt:''});
  const counts={pendingReviewCount:1,unseenByCategory:{review:0,'review-revoked':1}};
  vi.mocked(getNotifications).mockImplementation(async query=>({...page(query?.category==='review-revoked'?[withdrawn]:query?.unread?[]:[task]),...counts}));
  render(<MemoryRouter><NotificationPanel revision={0} onClose={vi.fn()}/></MemoryRouter>);
  await screen.findByText('已查看');
  expect(screen.getByText('未处理',{exact:true})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'去审核'})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'审核'})).toHaveTextContent('1 未处理');
  expect(screen.queryByRole('button',{name:'任务撤回'})).toBeNull();
  expect(screen.queryByRole('navigation',{name:'审核子分区'})).toBeNull();
  fireEvent.click(screen.getByLabelText('仅未处理'));
  await waitFor(()=>expect(getNotifications).toHaveBeenLastCalledWith({category:'all',unread:false,pending:true},expect.any(AbortSignal)));
  expect(await screen.findByText('已查看')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'清除已查看'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'全部标为已查看'}));
  await waitFor(()=>expect(markNotificationsSeen).toHaveBeenCalledWith({through:20,category:'all',pending:true}));
  fireEvent.click(screen.getByLabelText('仅未查看'));
  await waitFor(()=>expect(getNotifications).toHaveBeenLastCalledWith({category:'all',unread:true,pending:true},expect.any(AbortSignal)));
  expect(await screen.findByText('暂无未查看且未处理的审核任务')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'审核'}));
  await waitFor(()=>expect(getNotifications).toHaveBeenLastCalledWith({category:'review',unread:true,pending:true},expect.any(AbortSignal)));
  const main=screen.getByRole('navigation',{name:'通知分类'}),sub=screen.getByRole('navigation',{name:'审核子分区'});
  expect(within(main).queryByRole('button',{name:'任务撤回'})).toBeNull();
  expect(within(sub).getByRole('button',{name:'审核通知'})).toHaveAttribute('aria-pressed','true');
  const withdrawnButton=within(sub).getByRole('button',{name:'任务撤回'});
  expect(withdrawnButton).toHaveTextContent('1 未查看');
  fireEvent.click(withdrawnButton);
  await waitFor(()=>expect(getNotifications).toHaveBeenLastCalledWith({category:'review-revoked',unread:true},expect.any(AbortSignal)));
  expect(await screen.findByText('张三 · 审核任务已撤回')).toBeInTheDocument();
  expect(within(main).getByRole('button',{name:'审核'})).toHaveAttribute('aria-pressed','true');
  expect(withdrawnButton).toHaveAttribute('aria-pressed','true');
  expect(screen.queryByLabelText('仅未处理')).toBeNull();
  expect(screen.queryByRole('button',{name:'去审核'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'全部标为已查看'}));
  await waitFor(()=>expect(markNotificationsSeen).toHaveBeenCalledWith({through:20,category:'review-revoked'}));
  fireEvent.click(screen.getByRole('button',{name:'资金与委托'}));
  await waitFor(()=>expect(getNotifications).toHaveBeenLastCalledWith({category:'financial',unread:true},expect.any(AbortSignal)));
  expect(screen.queryByRole('navigation',{name:'审核子分区'})).toBeNull();
});

it('keeps ended assignments apart from active review tasks even in the all-notifications view',async()=>{
  const task=item(50,{category:'review',kind:'review-assigned',reviewTaskStatus:'pending',excerpt:'待审核正文'});
  const ended=item(49,{category:'review',kind:'review-assigned',reviewTaskStatus:'revoked',excerpt:'原任务正文'});
  vi.mocked(getNotifications).mockResolvedValue({...page([task,ended]),pendingReviewCount:1});
  render(<MemoryRouter><NotificationPanel revision={0} onClose={vi.fn()}/></MemoryRouter>);
  await screen.findByRole('button',{name:/已结束审核任务 · 1 条/});
  expect(screen.getByRole('button',{name:/^审核任务 · 1 条/})).toBeInTheDocument();
  expect(groupNotifications([task,ended])).toHaveLength(2);
  expect(document.querySelector('[data-notification-section="review"] [data-task-status="pending"]')).toBeInTheDocument();
  expect(document.querySelector('[data-notification-section="review-revoked"] [data-task-status="revoked"]')).toBeInTheDocument();
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

it('refreshes handled status when task counts change without new or unseen notices',async()=>{
  vi.useFakeTimers();
  const stream={readyState:1,onmessage:null as null|((event:{data:string})=>void),onopen:null,onerror:null,close:vi.fn()};
  vi.mocked(subscribeChanges).mockReturnValue(stream as unknown as EventSource);
  vi.mocked(getNotificationSummary).mockResolvedValue({unseenCount:0,through:10,sequence:50,pendingReviewCount:1});
  function Harness(){const state=useNotifications('alice');return <output>{state.revision}:{state.summary.pendingReviewCount}</output>;}
  render(<Harness/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(screen.getByRole('status')).toHaveTextContent('1:1');
  vi.mocked(getNotificationSummary).mockResolvedValue({unseenCount:0,through:10,sequence:51,pendingReviewCount:0});
  await act(async()=>{stream.onmessage!({data:JSON.stringify({sequence:51})});await vi.advanceTimersByTimeAsync(2000);});
  expect(screen.getByRole('status')).toHaveTextContent('2:0');
});
