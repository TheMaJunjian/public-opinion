import { afterEach, expect, it, vi } from 'vitest';
import { createWorkbenchDrawingTasks, WORKBENCH_DRAWING_TIMEOUT_MS } from '../context/WorkbenchDrawingContext';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('restores positioning only after pending layout work commits and the browser presents it', () => {
  vi.useFakeTimers();
  const tasks = createWorkbenchDrawingTasks();
  const measurement = tasks.begin('measurement'), positioning = tasks.begin('positioning');
  const restore = vi.fn(() => positioning.release());
  positioning.afterLayout(restore);
  vi.advanceTimersByTime(500);
  expect(restore).not.toHaveBeenCalled();
  measurement.release();
  vi.advanceTimersByTime(16);
  tasks.committed(); // Another layout render must be presented first.
  vi.advanceTimersByTime(16);
  expect(restore).not.toHaveBeenCalled();
  vi.advanceTimersByTime(34);
  expect(restore).toHaveBeenCalledOnce();
  expect(tasks.pending).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['cancel', 'release'] as const)('cleans up a waiting restoration on %s and ignores late measurements', finish => {
  vi.useFakeTimers();
  const tasks = createWorkbenchDrawingTasks();
  const measurement = tasks.begin('measurement'), positioning = tasks.begin('positioning'), restore = vi.fn();
  positioning.afterLayout(restore);
  positioning[finish]();
  measurement.release();
  vi.advanceTimersByTime(WORKBENCH_DRAWING_TIMEOUT_MS + 100);
  expect(restore).not.toHaveBeenCalled();
  expect(tasks.failure).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it('fails a stalled restoration rather than scrolling the page late after the user has resumed work', () => {
  vi.useFakeTimers();
  const tasks = createWorkbenchDrawingTasks();
  const measurement = tasks.begin('measurement'), positioning = tasks.begin('positioning'), restore = vi.fn();
  positioning.afterLayout(restore);
  vi.advanceTimersByTime(WORKBENCH_DRAWING_TIMEOUT_MS);
  expect(tasks.failure).toMatchObject({ kind: 'positioning', reason: 'timeout' });
  measurement.release();
  vi.advanceTimersByTime(100);
  expect(restore).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
