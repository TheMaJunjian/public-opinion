import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import PointsBadge from '../components/PointsBadge';

const user = { id: 'timer-user', username: '计时用户' };
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user }) }));
vi.mock('../components/useUsagePoints', () => ({ useUsagePoints: () => ({ progress: {roundId:'ready',waitSeconds:3}, completion:1, remainingMs:0, error:false }) }));
vi.mock('../theme/ThemeIcon', () => ({ default: () => null }));
vi.mock('../api', () => ({ api: { getPointsBalance: vi.fn(), getPointsTransactions: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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
