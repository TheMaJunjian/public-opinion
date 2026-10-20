import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LeaderboardRefreshButton from '../components/LeaderboardRefreshButton';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('增量刷新完成后即使没有变化也提示成功，并在 1.5 秒后消失，等待期间禁止重复点击', async () => {
  let finish!: (changed: boolean) => void;
  const onRefresh = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  render(<LeaderboardRefreshButton onRefresh={onRefresh} />);
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(screen.getByRole('button', { name: '刷新中…' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '刷新中…' }));
  expect(onRefresh).toHaveBeenCalledOnce();
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => finish(false));
  expect(screen.getByRole('status', { name: '排行榜刷新提示' })).toHaveTextContent('刷新完成，暂无新变化');
  expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled();
  act(() => vi.advanceTimersByTime(1499));
  expect(screen.getByRole('status')).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole('status')).toBeNull();
});

it('有增量时显示数据已更新，失败时如实提示并允许重试', async () => {
  const onRefresh = vi.fn().mockRejectedValueOnce(new Error('网络中断')).mockResolvedValueOnce(true);
  render(<LeaderboardRefreshButton onRefresh={onRefresh} />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '刷新' })));
  expect(screen.getByRole('status')).toHaveTextContent('刷新失败，请稍后重试');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '刷新' })));
  expect(screen.getByRole('status')).toHaveTextContent('刷新完成，已更新最新数据');
  act(() => vi.advanceTimersByTime(1500));
  expect(screen.queryByRole('status')).toBeNull();
});

it('刷新中关闭窗口后，完成请求不会留下提示或定时器', async () => {
  let finish!: (changed: boolean) => void;
  const view = render(<LeaderboardRefreshButton onRefresh={() => new Promise(resolve => { finish = resolve; })} />);
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  view.unmount();
  await act(async () => finish(false));
  expect(screen.queryByRole('status')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
