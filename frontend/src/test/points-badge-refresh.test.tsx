import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import PointsBadge from '../components/PointsBadge';
import GuideOverlay from '../components/GuideOverlay';

const user = { id: 'timer-user', username: '计时用户' };
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user }) }));
vi.mock('../components/useUsagePoints', () => ({ useUsagePoints: () => ({ progress: {roundId:'ready',waitSeconds:3}, completion:1, remainingMs:0, error:false }) }));
vi.mock('../theme/ThemeIcon', () => ({ default: () => null }));
vi.mock('../api', () => ({ api: { getPointsBalance: vi.fn(), getPointsTransactions: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const fundedBalance = { points: { available: 20, locked: 0 }, balance: { amount: 20, debtFrozen: false }, breakdown: { initialMinted: 0, totalEarned: 0, totalLost: 0, totalProtocolFees: 0 } };

it.each(['native-source','restricted-reference'])('keeps related-message navigation after moderation removes %s metadata',async shape=>{
  vi.mocked(api.getPointsBalance).mockResolvedValue(fundedBalance);
  vi.mocked(api.getPointsTransactions).mockResolvedValue({data:[{id:'private-entry',type:'TRANSFER',amount:21,balanceAfter:20,createdAt:'',
    ...(shape==='native-source'?{messageId:'covered-message',messageRevision:1,reason:'审核押注结算'}:{messages:[{messageId:'covered-message',messageRevision:1}]}),
  }],pagination:{page:1,limit:20,total:1,totalPages:1}});
  const navigate=vi.fn();window.addEventListener('points-navigate',navigate);
  try{
    render(<MemoryRouter initialEntries={['/messages']}><PointsBadge/></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button',{name:/贡献点：可用 20/}));
    expect(await screen.findByText('关联消息 · ID')).toBeVisible();
    if(shape==='native-source')expect(screen.getByText('审核押注结算')).toBeVisible();
    expect(screen.getByText('【消息】')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'定位消息 covered-message'}));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({detail:expect.objectContaining({messageId:'covered-message',scopeMessageId:'root'})}));
  }finally{window.removeEventListener('points-navigate',navigate);}
});
it('supports legacy entries without operation metadata in the second dialog',async()=>{
  vi.mocked(api.getPointsBalance).mockResolvedValue(fundedBalance);
  const entries=[{id:'gain',messageId:'covered-message',type:'TRANSFER',amount:21,lockedDelta:0,balanceAfter:340,createdAt:'2026-11-09T00:00:00Z',reason:'审核押注结算'},
    {id:'unlock',messageId:'covered-message',type:'UNLOCK',amount:0,lockedDelta:-11,balanceAfter:319,createdAt:'2026-11-09T00:00:00Z',reason:'审核押注解除锁定'}];
  vi.mocked(api.getPointsTransactions).mockImplementation(async params=>({data:params?.mode==='summary'?[{...entries[0],id:'message:covered-message',type:'MESSAGE_GROUP',lockedDelta:-11,entryCount:2,entries}]:entries,
    pagination:{page:1,limit:20,total:params?.mode==='summary'?1:2,totalPages:1}}));
  const navigate=vi.fn();window.addEventListener('points-navigate',navigate);
  try{
    render(<MemoryRouter initialEntries={['/messages']}><PointsBadge/></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button',{name:/贡献点：可用 20/}));
    expect(await screen.findByText('余额 319 → 340')).toBeVisible();
    expect(screen.getByText('余额 319 → 319')).toBeVisible();
    expect(screen.queryByText('2 笔合计')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'查看收支详情 gain'}));
    const detail=await screen.findByRole('dialog',{name:'贡献点详情'});
    expect(await within(detail).findByText('同一消息共 2 笔记录 · 时间倒序')).toBeVisible();
    expect(api.getPointsTransactions).toHaveBeenCalledWith({mode:'summary',messageId:'covered-message',limit:1});
    expect(within(detail).getByRole('table',{name:'同一消息收支明细'})).toHaveTextContent('锁定减少 11 点');
    expect(within(detail).getByText('319 → 340')).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(within(detail).getByRole('button',{name:'返回记录'}));
    expect(screen.queryByRole('dialog',{name:'贡献点详情'})).toBeNull();
    expect(screen.getByRole('dialog',{name:'贡献点记录'})).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'查看收支详情 unlock'}));
    fireEvent.click(within(await screen.findByRole('dialog',{name:'贡献点详情'})).getByRole('button',{name:'定位消息 covered-message'}));
    expect(navigate).toHaveBeenCalledOnce();
  }finally{window.removeEventListener('points-navigate',navigate);}
});

it.each([
  {name:'输方',principal:6,payout:0,net:-6,result:'对赌结算净损失 6 点',stakes:[1,5]},
  {name:'胜方',principal:10,payout:16,net:6,result:'对赌结算净收益 6 点',stakes:[10]},
  {name:'平局',principal:6,payout:6,net:0,result:'对赌结算持平',stakes:[6]},
])('shows $name settlement result in history and details without treating locked principal as a refund',async({principal,payout,net,result,stakes})=>{
  vi.mocked(api.getPointsBalance).mockResolvedValue(fundedBalance);
  const entries=stakes.map((stake,index)=>({id:`principal-${index}`,messageId:'settlement',messageRevision:1,type:'UNLOCK',reason:'结束对赌锁定',
    amount:0,lockedDelta:-stake,balanceAfter:117,createdAt:'2026-11-10T07:54:19Z'}));
  if(payout)entries.push({id:'payout',messageId:'settlement',messageRevision:1,type:'TRANSFER',reason:payout===principal?'平局退还本金':'胜方按出资比例分配',
    amount:payout,lockedDelta:0,balanceAfter:117+payout,createdAt:'2026-11-10T07:54:19Z'});
  entries.reverse();
  const transaction={id:'operation:settlement',operationId:'settlement-op',type:'OPERATION_GROUP',amount:payout,lockedDelta:-principal,balanceAfter:117+payout,
    createdAt:'2026-11-10T07:54:19Z',entryCount:entries.length,reasonDetails:entries,messages:[{messageId:'settlement',messageType:'结算'}]};
  vi.mocked(api.getPointsTransactions).mockImplementation(async params=>({data:[params?.mode==='summary'?{...transaction,entries}:transaction],pagination:{page:1,limit:20,total:1,totalPages:1}}));
  render(<MemoryRouter><PointsBadge/></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:/贡献点：可用 20/}));
  expect(await screen.findByText(result)).toBeVisible();
  expect(screen.getByText(`资产 ${net>=0?'+':''}${net}`)).toBeVisible();
  expect(screen.getByText(`可用 +${payout}`)).toBeVisible();
  expect(screen.getByText(`锁定减少 ${principal} 点`)).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'查看收支详情 operation:settlement'}));
  const detail=within(await screen.findByRole('dialog',{name:'贡献点详情'}));
  expect(await detail.findByRole('group',{name:'对赌结算结果'})).toHaveTextContent(result);
  expect(detail.getByRole('group',{name:'对赌结算结果'})).toHaveTextContent(`结算本金 ${principal} 点 · 结算到账 ${payout} 点`);
  const totals=detail.getByLabelText('本次操作收支合计');
  expect(within(totals).getByText('资产净变化').parentElement).toHaveTextContent(`${net>=0?'+':''}${net} 点`);
  expect(detail.getByRole('columnheader',{name:'可用增减'})).toBeVisible();
  expect(detail.queryByText('结束对赌锁定')).toBeNull();
  expect(detail.getAllByText('对赌本金结算').length).toBeGreaterThan(0);
  expect(detail.getByRole('table')).not.toHaveTextContent('解锁');
  for(const stake of stakes)expect(within(detail.getByRole('table')).getByText(`锁定减少 ${stake} 点`)).toBeVisible();
});

it('shows one send operation and opens every text/reference fee and stake using its operation ID',async()=>{
  vi.mocked(api.getPointsBalance).mockResolvedValue(fundedBalance);
  const fullText='完整的关联消息内容。'.repeat(30)+'结尾内容也应显示。';
  const messages=[{messageId:'sent-text',messageRevision:1,messageType:'文本',scopeMessageId:'root',summary:fullText},
    {messageId:'sent-reference',messageRevision:1,messageType:'引用',scopeMessageId:'root'}];
  let available=56;
  const entries=messages.flatMap((message,index)=>['协议费','对赌锁定','审核费冻结','审核自押冻结'].map((reason,fee)=>{
    const amount=[1,1,6,10][fee];available-=amount;
    return {id:`entry-${index}-${fee}`,messageId:message.messageId,messageRevision:1,type:fee?'LOCK':'SPEND',reason,
      amount:-amount,lockedDelta:fee?amount:0,balanceAfter:available,createdAt:'2026-11-10T00:00:00Z'};
  })).reverse();
  const row={id:'operation:send-1',operationId:'send-1',type:'OPERATION_GROUP',amount:-36,lockedDelta:34,balanceAfter:20,entryCount:8,
    createdAt:'2026-11-10T00:00:00Z',messages,
    reasonDetails:entries.map(({messageId,messageRevision,reason,amount,lockedDelta})=>({messageId,messageRevision,reason,amount,lockedDelta}))};
  vi.mocked(api.getPointsTransactions).mockImplementation(async params=>({data:[params?.operationId?{...row,entries}:row],pagination:{page:1,limit:20,total:1,totalPages:1}}));
  render(<MemoryRouter><PointsBadge/></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:/贡献点：可用 20/}));
  expect(await screen.findByText('8 笔合计')).toBeVisible();
  expect(screen.getByText('操作收支')).toBeVisible();expect(screen.getByText('余额 56 → 20')).toBeVisible();
  expect(screen.queryByRole('group',{name:'收支原因'})).toBeNull();
  expect(screen.queryByText('预留审核参与报酬，未使用的预算在审核结算时退还。')).toBeNull();
  expect(screen.getAllByRole('button',{name:/查看收支详情/})).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:'查看收支详情 operation:send-1'}));
  const detail=within(await screen.findByRole('dialog',{name:'贡献点详情'}));
  expect(await detail.findByText('本次操作共 8 笔记录 · 时间倒序')).toBeVisible();
  expect(api.getPointsTransactions).toHaveBeenCalledWith({mode:'summary',operationId:'send-1',limit:1});
  const rows=within(detail.getByRole('table',{name:'本次操作收支明细'})).getAllByRole('row');expect(rows).toHaveLength(9);
  for(const reason of ['协议费','对赌锁定','审核费冻结','审核自押冻结'])expect(within(detail.getByRole('table')).getAllByText(reason)).toHaveLength(2);
  for(const [index,entry] of entries.entries()){
    const row=within(rows[index+1]);
    expect(row.getByText(entry.reason)).toBeVisible();
    expect(row.getByText(`-${Math.abs(entry.amount)}`)).toBeVisible();
    expect(row.getByText(`${entry.balanceAfter-entry.amount} → ${entry.balanceAfter}`)).toBeVisible();
    expect(row.getByText(entry.lockedDelta?`锁定 ${entry.lockedDelta} 点`:'无变化')).toBeVisible();
    expect(row.getByRole('button',{name:`定位明细消息 ${entry.messageId}`})).toHaveTextContent(entry.messageId);
  }
  expect(within(detail.getByRole('table')).getAllByText('预留审核参与报酬，未使用的预算在审核结算时退还。')).toHaveLength(2);
  expect(detail.getByText('可用减少')).toBeVisible();
  expect(within(detail.getByRole('group',{name:'收支原因'})).getByText('可用 -12 · 锁定 +12')).toBeVisible();
  expect(detail.getByRole('button',{name:'定位消息 sent-text'})).toBeVisible();
  expect(detail.getByRole('button',{name:'定位消息 sent-reference'})).toBeVisible();
  const reference=detail.getAllByRole('group',{name:'消息 sent-text'}).find(group=>within(group).queryByRole('button',{name:'定位消息 sent-text'}))!;
  fireEvent.click(within(reference).getByRole('button',{name:'切换消息 sent-text 的摘要和 ID'}));
  expect(within(reference).getByRole('button',{name:'定位消息 sent-text'})).toHaveTextContent(fullText);
});

it('keeps daily usage contributions aggregated in both levels and retries failed detail loading',async()=>{
  vi.mocked(api.getPointsBalance).mockResolvedValue(fundedBalance);
  const row={id:'usage:2026-11-09',type:'USAGE_REWARD',amount:283,balanceAfter:345,createdAt:'2026-11-09T00:00:00Z',data:{day:'2026-11-09',count:283},messages:[{messageId:'usage-message',messageType:'结算'}]};
  const response={data:[row],pagination:{page:1,limit:20,total:1,totalPages:1}};
  vi.mocked(api.getPointsTransactions).mockResolvedValueOnce(response).mockRejectedValueOnce(new Error('离线')).mockResolvedValue(response);
  render(<MemoryRouter initialEntries={['/messages']}><PointsBadge/></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:/贡献点：可用 20/}));
  expect(await screen.findByText('2026-11-09 · 283 次')).toBeVisible();
  expect(screen.queryByText(/余额/)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'查看使用贡献详情 usage:2026-11-09'}));
  const detail=screen.getByRole('dialog',{name:'贡献点详情'});
  expect(await within(detail).findByRole('alert')).toHaveTextContent('详情加载失败');
  fireEvent.click(within(detail).getByRole('button',{name:'重试'}));
  expect(await within(detail).findByText('+283 点')).toBeVisible();
  expect(api.getPointsTransactions).toHaveBeenCalledWith({mode:'summary',day:'2026-11-09',limit:1});
  expect(within(detail).queryByRole('table')).toBeNull();
  fireEvent.click(within(detail).getByRole('button',{name:'关闭贡献点详情'}));
  expect(screen.getByRole('dialog',{name:'贡献点记录'})).toBeVisible();
});

it.each(['history','details'])('shows settlement and target types with full IDs in %s, copies an ID and locates the target', async panel => {
  vi.mocked(api.getPointsBalance).mockResolvedValue(fundedBalance);
  vi.mocked(api.getPointsTransactions).mockResolvedValue({ data: [{ id: 'distribution-entry', type: 'TRANSFER', amount: 3, balanceAfter: 20, createdAt: '',
    messages: [
      { messageId: 'distribution-message-1', messageType: '结算', summary: '对赌分配：3 贡献点；计时用户 +3。', scopeMessageId: 'root' },
      { messageId: 'target-message-1', messageType: '代码', summary: '目标代码', scopeMessageId: 'root' },
    ],
    data: { messageId: 'distribution-message-1', scopeMessageId: 'root' } }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const navigate = vi.fn();
  window.addEventListener('points-navigate', navigate);
  try {
    render(<MemoryRouter initialEntries={['/messages']}><PointsBadge /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /贡献点：可用 20/ }));
    fireEvent.click(await screen.findByText('关联消息 · 2 条'));
    if(panel==='details')fireEvent.click(screen.getByRole('button',{name:'查看收支详情 distribution-entry'}));
    const view=within(await screen.findByRole('dialog',{name:panel==='details'?'贡献点详情':'贡献点记录'}));
    expect(await view.findByText('【结算】')).toBeVisible();
    expect(view.getByText('【代码】')).toBeVisible();
    if(panel==='details')await waitFor(()=>expect(api.getPointsTransactions).toHaveBeenCalledWith({mode:'summary',messageId:'distribution-message-1',limit:1}));
    const reference = view.getByRole('button', { name: '定位消息 distribution-message-1' });
    expect(reference).toHaveTextContent('distribution-message-1');
    const type = view.getByRole('button', { name: '切换消息 distribution-message-1 的摘要和 ID' });
    fireEvent.click(type);
    expect(reference).toHaveTextContent('对赌分配：3 贡献点；计时用户 +3。');
    fireEvent.click(type);
    expect(reference).toHaveTextContent('distribution-message-1');
    fireEvent.doubleClick(reference);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('distribution-message-1'));
    expect(navigate).not.toHaveBeenCalled();
    const target=view.getByRole('button',{name:'定位消息 target-message-1'});
    expect(target).toHaveTextContent('target-message-1');
    fireEvent.click(target);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ messageId: 'target-message-1', scopeMessageId: 'root' }) }));
    expect(screen.queryByRole('dialog', { name: '贡献点记录' })).not.toBeInTheDocument();
  } finally { window.removeEventListener('points-navigate', navigate); }
});

it.each([
  { currentPath: '/messages', selectedId: 'usage-message-2', expectedPath: '/messages/source-scope?msg=usage-message-2' },
  { currentPath: '/messages/source-scope', selectedId: 'usage-message-1', expectedPath: '/messages?msg=usage-message-1' },
])('navigates from $currentPath to the selected daily summary source $selectedId', async ({ currentPath, selectedId, expectedPath }) => {
  vi.mocked(api.getPointsBalance).mockResolvedValue(fundedBalance);
  vi.mocked(api.getPointsTransactions).mockResolvedValue({ data: [{ id: 'usage:2026-11-07', type: 'USAGE_REWARD', amount: 2, balanceAfter: 20, createdAt: '',
    messages: [
      { messageId: 'usage-message-1', messageType: '文本', scopeMessageId: 'root' },
      { messageId: 'usage-message-2', messageType: '文本', scopeMessageId: 'source-scope' },
    ], data: { day: '2026-11-07', count: 2 } }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
  function Location() { const location = useLocation(); return <output>{location.pathname}{location.search}</output>; }
  render(<MemoryRouter initialEntries={[currentPath]}><PointsBadge /><Location /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /贡献点：可用 20/ }));
  fireEvent.click(await screen.findByText('关联消息 · 2 条'));
  expect(screen.getByRole('button', { name: '定位消息 usage-message-1' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: `定位消息 ${selectedId}` }));
  expect(screen.getByRole('status')).toHaveTextContent(expectedPath);
});

it('locates a settlement distribution across scopes without opening a settlement on the distribution itself', async () => {
  vi.mocked(api.getPointsBalance).mockResolvedValue(fundedBalance);
  vi.mocked(api.getPointsTransactions).mockResolvedValue({ data: [{ id: 'distribution-entry', type: 'UNLOCK', amount: 3, balanceAfter: 20, createdAt: '',
    messages: [{ messageId: 'distribution-message', messageType: '结算', scopeMessageId: 'source-scope', roundId: 'round-1' }],
    data: { messageId: 'distribution-message', scopeMessageId: 'source-scope', roundId: 'round-1' } }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
  function Location() { const location = useLocation(); return <output>{location.pathname}{location.search}</output>; }
  render(<MemoryRouter initialEntries={['/messages']}><PointsBadge /><Location /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /贡献点：可用 20/ }));
  expect(await screen.findByText('关联消息 · ID')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '定位消息 distribution-message' }));
  expect(screen.getByRole('status').textContent).toBe('/messages/source-scope?msg=distribution-message');
});

it('anchors the guide to the panel while loading, then to the exact settlement message without requiring a round ID', async () => {
  vi.mocked(api.getPointsBalance).mockResolvedValue(fundedBalance);
  let finish!: (value: Awaited<ReturnType<typeof api.getPointsTransactions>>) => void;
  vi.mocked(api.getPointsTransactions).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  let recordTop = 600;
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.dataset.guideBubble ? 250 : 0; });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.guidePointsPanel) return new DOMRect(660, 80, 320, 384);
    if (this.dataset.guidePointsMessage === 'result-message') return new DOMRect(660, recordTop, 320, 60);
    return new DOMRect(660, 20, 200, 40);
  });
  const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.guidePointsMessage === 'result-message') recordTop = 260;
  });
  render(<MemoryRouter><PointsBadge /><GuideOverlay open onClose={vi.fn()} /></MemoryRouter>);
  await screen.findByRole('button', { name: /贡献点：可用 20/ });
  act(() => window.dispatchEvent(new Event('guide-stance-selected')));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  act(() => window.dispatchEvent(new Event('guide-send-selected')));
  act(() => window.dispatchEvent(new Event('guide-settlement-opened')));
  act(() => window.dispatchEvent(new Event('guide-settle-selected')));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  act(() => window.dispatchEvent(new CustomEvent('guide-settlement-confirmed', { detail: { roundId: 'round-1', resultMessageId: 'result-message' } })));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: /贡献点：可用 20/ }));
  expect(document.querySelector('[data-guide-mask]')).toHaveStyle({ left: '660px', top: '80px', width: '320px', height: '384px' });
  await act(async () => finish({ data: [
    { id: 'unrelated', type: 'TRANSFER', amount: 1, balanceAfter: 20, createdAt: '', data: { messageId: 'other-message' } },
    { id: 'settlement', type: 'TRANSFER', amount: 3, balanceAfter: 19, createdAt: '', data: { messageId: 'result-message' } },
  ], pagination: { page: 1, limit: 20, total: 2, totalPages: 1 } }));
  await waitFor(() => expect(document.querySelector('[data-guide-mask]')).toHaveStyle({ left: '660px', top: '260px', width: '320px', height: '60px' }));
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  const bubble = document.querySelector<HTMLElement>('[data-guide-bubble]')!;
  expect(parseFloat(bubble.style.left) + 460).toBeLessThan(660);
  expect(document.querySelector('[data-guide-background]')).toHaveAttribute('height', '250');
  recordTop = 280;
  fireEvent.scroll(screen.getByRole('dialog', { name: '贡献点记录' }));
  expect(document.querySelector('[data-guide-mask]')).toHaveStyle({ top: '280px' });
  fireEvent.mouseDown(screen.getByRole('button', { name: '完成' }));
  expect(screen.getByRole('dialog', { name: '贡献点记录' })).toBeInTheDocument();
});

it('入口底部的进度条可点击打开记录，面板也保留进度条、本轮时间和使用贡献记录', async () => {
  const balance = (available: number) => ({ points: { available, locked: 0 }, balance: { amount: available, debtFrozen: false }, breakdown: { initialMinted: 0, totalEarned: 0, totalLost: 0, totalProtocolFees: 0 } });
  vi.mocked(api.getPointsBalance).mockResolvedValueOnce(balance(0)).mockResolvedValue(balance(1));
  let oldResponse!: (value: Awaited<ReturnType<typeof api.getPointsTransactions>>) => void;
  vi.mocked(api.getPointsTransactions).mockImplementationOnce(() => new Promise(resolve => { oldResponse = resolve; }))
    .mockResolvedValue({ data: [{ id: 'reward', type: 'TRANSFER', amount: 1, balanceAfter: 1, createdAt: '', data: { reason: '使用公论计时奖励' } }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
  render(<MemoryRouter><PointsBadge /></MemoryRouter>);
  const trigger=await screen.findByRole('button', { name: /贡献点：可用 0/ });
  const progress=screen.getByRole('progressbar');
  expect(trigger.contains(progress)).toBe(true);
  expect(progress.parentElement).toBe(trigger);
  expect(trigger.firstElementChild!.compareDocumentPosition(progress)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(trigger).toHaveClass('flex-col');
  fireEvent.click(progress);
  expect(screen.getByText('本轮时间')).toBeInTheDocument();
  expect(screen.getByText('3 秒')).toBeInTheDocument();
  await waitFor(() => expect(api.getPointsTransactions).toHaveBeenCalledOnce());
  act(() => { window.dispatchEvent(new Event('points-refresh')); });
  await waitFor(() => expect(api.getPointsTransactions).toHaveBeenCalledTimes(2));
  await act(async () => { oldResponse({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }); });
  expect(await screen.findByText('使用公论计时贡献')).toBeInTheDocument();
  expect(screen.queryByText('暂无记录')).not.toBeInTheDocument();
  expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  for(const bar of screen.getAllByRole('progressbar')) expect(bar).toHaveAttribute('aria-valuenow','100');
  expect(screen.queryByText(/奖励/)).not.toBeInTheDocument();
  expect(screen.queryByText(/操作后|点击、按键|领取/)).not.toBeInTheDocument();
});
