import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import WorkbenchActivityIndicator from '../components/WorkbenchActivityIndicator';
import { beginWorkbenchDrawing, beginWorkbenchSync, finishWorkbenchSync, noteWorkbenchDrawingProgress, reportWorkbenchDrawingDuration, resetWorkbenchActivity } from '../utils/workbenchActivity';

afterEach(() => {
  resetWorkbenchActivity();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('reports an unplanned long graph render after the browser becomes responsive', () => {
  vi.useFakeTimers();
  render(<WorkbenchActivityIndicator />);
  act(() => { reportWorkbenchDrawingDuration(1250); });
  expect(screen.getByRole('status')).toHaveTextContent('消息图绘制用时 1.3 秒');
  act(() => { vi.advanceTimersByTime(5000); });
  expect(screen.queryByRole('status')).toBeNull();
});

it('shows synchronization and drawing separately, then keeps their elapsed times briefly visible', () => {
  vi.useFakeTimers();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  render(<WorkbenchActivityIndicator />);

  act(() => { beginWorkbenchSync(); });
  expect(screen.getByRole('status')).toHaveTextContent('正在同步消息');
  act(() => { now = 420; beginWorkbenchDrawing(); });
  expect(screen.getByRole('status')).toHaveTextContent('正在绘制消息图');
  act(() => { now = 720; finishWorkbenchSync(); noteWorkbenchDrawingProgress(); });
  expect(screen.getByRole('status')).toHaveTextContent('消息同步用时 720 毫秒');
  act(() => { now = 860; vi.advanceTimersByTime(180); });
  expect(screen.getByRole('status')).toHaveTextContent('消息图绘制用时 440 毫秒');
  act(() => { vi.advanceTimersByTime(5000); });
  expect(screen.queryByRole('status')).toBeNull();
});
