import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

it('opens related message types and full IDs, copies an ID without navigating, and locates the chosen message', async () => {
  vi.mocked(api.getPointsBalance).mockResolvedValue(fundedBalance);
  vi.mocked(api.getPointsTransactions).mockResolvedValue({ data: [{ id: 'distribution-entry', type: 'TRANSFER', amount: 3, balanceAfter: 20, createdAt: '',
    messages: [{ messageId: 'distribution-message-1', messageType: '分配', summary: '对赌分配：3 贡献点；计时用户 +3。', scopeMessageId: 'root' }],
    data: { messageId: 'distribution-message-1', scopeMessageId: 'root' } }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const navigate = vi.fn();
  window.addEventListener('points-navigate', navigate);
  try {
    render(<MemoryRouter initialEntries={['/messages']}><PointsBadge /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /贡献点：可用 20/ }));
    fireEvent.click(await screen.findByText('关联消息'));
    expect(screen.getByText('【分配】')).toBeVisible();
    const reference = screen.getByRole('button', { name: '定位消息 distribution-message-1' });
    expect(reference).toHaveTextContent('distribution-message-1');
    const type = screen.getByRole('button', { name: '切换消息 distribution-message-1 的摘要和 ID' });
    fireEvent.click(type);
    expect(reference).toHaveTextContent('对赌分配：3 贡献点；计时用户 +3。');
    fireEvent.click(type);
    expect(reference).toHaveTextContent('distribution-message-1');
    fireEvent.doubleClick(reference);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('distribution-message-1'));
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(reference);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ messageId: 'distribution-message-1', scopeMessageId: 'root' }) }));
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
    messages: [{ messageId: 'distribution-message', messageType: '分配', scopeMessageId: 'source-scope', roundId: 'round-1' }],
    data: { messageId: 'distribution-message', scopeMessageId: 'source-scope', roundId: 'round-1' } }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
  function Location() { const location = useLocation(); return <output>{location.pathname}{location.search}</output>; }
  render(<MemoryRouter initialEntries={['/messages']}><PointsBadge /><Location /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /贡献点：可用 20/ }));
  fireEvent.click(await screen.findByText('关联消息'));
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
