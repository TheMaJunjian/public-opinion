import { useContext, useLayoutEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WorkbenchLoadingBoundary, { useWorkbenchLoadingProgress } from '../components/WorkbenchLoadingBoundary';
import { WorkbenchDrawingContext } from '../context/WorkbenchDrawingContext';
import { useMessageWindow } from '../hooks/useMessageWindow';
import { resetWorkbenchActivity } from '../utils/workbenchActivity';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

const messages: DemoMessage[] = Array.from({ length: 120 }, (_, index) => ({ id: `m-${index}`, kind: 'normal', content: '',
  author: 'test', createdAt: new Date(index * 1000).toISOString() }));
const edges: DemoEdge[] = [], pinned: string[] = [];
let releaseMeasurement: (() => void) | undefined;
let failMeasurement: ((error: unknown) => void) | undefined;
const newBatchMounted = vi.fn();
function Window() {
  useWorkbenchLoadingProgress(false, null);
  const tasks = useContext(WorkbenchDrawingContext)!;
  const window = useMessageWindow(messages, edges, true, 'root', pinned);
  useLayoutEffect(() => {
    if (window.messages.length <= 50) return;
    newBatchMounted(!!document.querySelector('[role="dialog"]'));
    const measurement = tasks.begin('measurement');
    releaseMeasurement = measurement.release;
    failMeasurement = measurement.fail;
    return () => measurement.cancel();
  }, [window.messages.length, tasks]);
  return <><output>{window.messages.length}</output><button onClick={() => { void window.more(); }}>追加结构</button></>;
}
const frames = (count: number) => { for (let index = 0; index < count; index++) act(() => vi.advanceTimersByTime(16)); };
beforeEach(() => { vi.useFakeTimers(); releaseMeasurement = undefined; failMeasurement = undefined; newBatchMounted.mockClear(); });
afterEach(() => { resetWorkbenchActivity(); vi.useRealTimers(); });

it('opens progress and crosses a paint before mounting a batch, then waits for drawing before restoring interaction', () => {
  const view = render(<WorkbenchLoadingBoundary><Window /></WorkbenchLoadingBoundary>);
  frames(4);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('50');
  fireEvent.click(screen.getByRole('button', { name: '追加结构' }));
  expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
  expect(view.container.querySelector('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('status')).toHaveTextContent('50');
  frames(1); expect(screen.getByRole('status')).toHaveTextContent('50');
  frames(1); expect(screen.getByRole('status')).toHaveTextContent('100');
  expect(newBatchMounted).toHaveBeenCalledExactlyOnceWith(true);
  frames(8); expect(screen.getByRole('dialog')).toBeInTheDocument();
  act(() => releaseMeasurement!()); frames(8);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(view.container.querySelector('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
});

it('shows progress for each batch and does not open it when the range is exhausted', () => {
  render(<WorkbenchLoadingBoundary><Window /></WorkbenchLoadingBoundary>); frames(4);
  fireEvent.click(screen.getByRole('button', { name: '追加结构' }));
  expect(screen.queryByRole('button', { name: /收起|显示进度/ })).toBeNull();
  frames(2); act(() => releaseMeasurement!()); frames(8);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '追加结构' }));
  expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
  frames(2); expect(screen.getByRole('status')).toHaveTextContent('120');
  act(() => releaseMeasurement!()); frames(8);
  fireEvent.click(screen.getByRole('button', { name: '追加结构' })); frames(4);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(newBatchMounted).toHaveBeenCalledTimes(2);
});

it('cancels a batch queued before paint when leaving the workbench', () => {
  const view = render(<WorkbenchLoadingBoundary><Window /></WorkbenchLoadingBoundary>); frames(4);
  fireEvent.click(screen.getByRole('button', { name: '追加结构' }));
  view.unmount(); frames(8);
  expect(newBatchMounted).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['error', 'timeout'])('releases the blocking window after a batch %s', reason => {
  const view = render(<WorkbenchLoadingBoundary><Window /></WorkbenchLoadingBoundary>); frames(4);
  fireEvent.click(screen.getByRole('button', { name: '追加结构' })); frames(2);
  expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
  if (reason === 'error') act(() => failMeasurement!(new Error('测量异常')));
  else act(() => vi.advanceTimersByTime(30_001));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('alert')).toHaveTextContent(reason === 'error' ? '尺寸测量失败' : '已停止等待并恢复操作');
  expect(view.container.querySelector('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
  fireEvent.click(screen.getByRole('button', { name: '追加结构' })); frames(4);
  expect(newBatchMounted).toHaveBeenCalledOnce();
});
