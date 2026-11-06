import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import WorkbenchActivityIndicator from '../components/WorkbenchActivityIndicator';
import { beginWorkbenchDrawing, beginWorkbenchSync, finishWorkbenchSync, noteWorkbenchDrawingProgress, reportWorkbenchDrawingDuration, resetWorkbenchActivity } from '../utils/workbenchActivity';

afterEach(() => {
  resetWorkbenchActivity();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('keeps completed drawing durations out of the background sync indicator', () => {
  vi.useFakeTimers();
  render(<WorkbenchActivityIndicator />);
  act(() => { reportWorkbenchDrawingDuration(1250); });
  expect(screen.queryByRole('status')).toBeNull();
  act(() => { vi.advanceTimersByTime(5000); });
  expect(screen.queryByRole('status')).toBeNull();
});

it('shows only background synchronization while foreground drawing uses its own dialog', () => {
  vi.useFakeTimers();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  render(<WorkbenchActivityIndicator />);

  act(() => { beginWorkbenchSync(); });
  expect(screen.getByRole('status')).toHaveTextContent('正在同步消息');
  act(() => { now = 420; beginWorkbenchDrawing(); });
  expect(screen.getByRole('status')).toHaveTextContent('正在同步消息');
  expect(screen.getByRole('status')).not.toHaveTextContent('绘制');
  act(() => { now = 720; finishWorkbenchSync(); noteWorkbenchDrawingProgress(); });
  expect(screen.getByRole('status')).toHaveTextContent('消息同步用时 720 毫秒');
  act(() => { now = 860; vi.advanceTimersByTime(180); });
  expect(screen.getByRole('status')).toHaveTextContent('消息同步用时 720 毫秒');
  expect(screen.getByRole('status')).not.toHaveTextContent('绘制');
  act(() => { vi.advanceTimersByTime(5000); });
  expect(screen.queryByRole('status')).toBeNull();
});
