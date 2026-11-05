import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { useUsagePoints } from '../components/useUsagePoints';
import type { UsagePointProgress } from '../types';

vi.mock('../api', () => ({ api: { updateUsagePoints: vi.fn() } }));
const first: UsagePointProgress = { earned: 0, totalEarned: 0, roundId: 'first', waitSeconds: 1, remainingMs: 1000, refreshInMs: 86400_000, awarded: false };
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] }); vi.mocked(api.updateUsagePoints).mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const ready = async () => act(async () => { await Promise.resolve(); });

it('无需操作，后台到点自动领取并进入递增的下一轮', async () => {
  vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
  vi.mocked(api.updateUsagePoints).mockResolvedValueOnce(first)
    .mockResolvedValueOnce({...first,roundId:'second',earned:1,totalEarned:1,waitSeconds:2,remainingMs:2000,awarded:true})
    .mockResolvedValue({...first,roundId:'third',earned:2,totalEarned:2,waitSeconds:3,remainingMs:3000,awarded:true});
  const { result } = renderHook(() => useUsagePoints('user'));
  await ready();
  expect(result.current.completion).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(1020); });
  expect(api.updateUsagePoints).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.updateUsagePoints).mock.calls[1][0]).toEqual({action:'tick',roundId:'first'});
  expect(result.current.progress?.earned).toBe(1);
  expect(result.current.remainingMs).toBe(2000);
  const calls = vi.mocked(api.updateUsagePoints).mock.calls.length;
  act(() => { window.dispatchEvent(new Event('pointerdown')); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); });
  expect(api.updateUsagePoints).toHaveBeenCalledTimes(calls);
  await act(async () => { await vi.advanceTimersByTimeAsync(2020); });
  expect(result.current.progress?.earned).toBe(2);
  expect(result.current.remainingMs).toBe(3000);
});

it('自动领取请求与窗口恢复同时发生不会重复发送，成功后刷新余额', async () => {
  let complete!: (progress: UsagePointProgress) => void;
  vi.mocked(api.updateUsagePoints).mockResolvedValueOnce(first)
    .mockImplementationOnce(() => new Promise(resolve => {complete=resolve;}));
  const { result } = renderHook(() => useUsagePoints('user'));
  await ready();
  const refresh = vi.fn();window.addEventListener('points-refresh', refresh);
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(1020); });
    act(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
    expect(api.updateUsagePoints).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.updateUsagePoints).mock.calls[1][0]).toEqual({ action: 'tick', roundId: 'first' });
    await act(async () => { complete({ ...first, earned: 1, totalEarned: 1, roundId: 'second', waitSeconds: 2, remainingMs: 2000, awarded: true }); });
    expect(refresh).toHaveBeenCalledOnce();
    expect(result.current.completion).toBe(0);
    expect(result.current.remainingMs).toBe(2000);
  } finally { window.removeEventListener('points-refresh', refresh); }
});

it('断网后自动重试，程序关闭后不再发送领取请求', async () => {
  vi.mocked(api.updateUsagePoints).mockRejectedValueOnce(new Error('断网')).mockResolvedValue(first);
  const {result,unmount}=renderHook(()=>useUsagePoints('user'));
  await ready();
  expect(result.current.error).toBe(true);
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(api.updateUsagePoints).toHaveBeenCalledTimes(2);
  expect(result.current.error).toBe(false);
  const signal=vi.mocked(api.updateUsagePoints).mock.calls[1][1]!;
  unmount();
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
  expect(signal.aborted).toBe(true);
  expect(api.updateUsagePoints).toHaveBeenCalledTimes(2);
});

it('零点主动同步补发结果；切换账号后丢弃旧请求并停止旧计时器', async () => {
  vi.mocked(api.updateUsagePoints).mockResolvedValueOnce({ ...first, refreshInMs: 1000 })
    .mockResolvedValueOnce({ ...first, totalEarned: 1, roundId: 'new-day', awarded: true });
  const { result, rerender } = renderHook(({ userId }) => useUsagePoints(userId), { initialProps: { userId: 'old' } });
  await ready();
  await act(async () => { await vi.advanceTimersByTimeAsync(1050); });
  expect(api.updateUsagePoints).toHaveBeenCalledTimes(2);
  expect(result.current.progress?.totalEarned).toBe(1);
  let complete!: (progress: UsagePointProgress) => void;
  vi.mocked(api.updateUsagePoints).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  rerender({ userId: 'new' });
  const signal = vi.mocked(api.updateUsagePoints).mock.calls[2][1]!;
  rerender({ userId: '' });
  await act(async () => { complete({ ...first, earned: 99 }); });
  expect(signal.aborted).toBe(true);
  expect(result.current.progress).toBeNull();
});
