import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSceneComputation, type SceneComputationRequest } from '../hooks/useSceneComputation';
import { planMessageStructures } from '../utils/messageStructurePlan';
import { createWorkbenchDrawingTasks, WorkbenchDrawingContext } from '../context/WorkbenchDrawingContext';
import type { DemoMessage } from '../utils/modelBridge';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage!: (event: MessageEvent) => void;
  onerror!: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  finish(request: SceneComputationRequest) {
    if (request.job.kind !== 'structures') throw new Error('unexpected test job');
    this.onmessage({ data: { id: request.id, result: planMessageStructures(request.job.input) } } as MessageEvent);
  }
}
const job = (id: string) => ({ kind: 'structures' as const, input: {
  messages: [{ id, kind: 'normal', author: 'test', content: id, createdAt: '' } satisfies DemoMessage], edges: [],
} });
afterEach(() => { vi.unstubAllGlobals(); FakeWorker.instances = []; });

it('runs one job at a time, skips superseded requests and never publishes stale scope results', () => {
  vi.stubGlobal('Worker', FakeWorker);
  const tasks = createWorkbenchDrawingTasks(); tasks.setBlocking(false);
  const first = job('old'), second = job('intermediate'), third = job('latest');
  const { result, rerender, unmount } = renderHook(({ input }) => useSceneComputation(input), {
    initialProps: { input: first }, wrapper: ({ children }) => <WorkbenchDrawingContext.Provider value={tasks}>{children}</WorkbenchDrawingContext.Provider>,
  });
  const worker = FakeWorker.instances[0];
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  rerender({ input: second }); rerender({ input: third });
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  act(() => worker.finish(worker.postMessage.mock.calls[0][0]));
  expect(result.current).toBeNull();
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  expect(worker.postMessage.mock.calls[1][0].job).toBe(third);
  act(() => worker.finish(worker.postMessage.mock.calls[1][0]));
  expect(result.current?.order).toEqual(['latest']);
  expect(tasks.pending).toBe(0);
  unmount(); expect(worker.terminate).toHaveBeenCalledOnce();
});

it('falls back locally when the worker cannot run and releases its drawing ticket', () => {
  vi.stubGlobal('Worker', FakeWorker);
  const tasks = createWorkbenchDrawingTasks(); tasks.setBlocking(false);
  const input = job('fallback');
  const { result, unmount } = renderHook(() => useSceneComputation(input), {
    wrapper: ({ children }) => <WorkbenchDrawingContext.Provider value={tasks}>{children}</WorkbenchDrawingContext.Provider>,
  });
  const worker = FakeWorker.instances[0];
  act(() => worker.onerror());
  expect(result.current?.order).toEqual(['fallback']);
  expect(tasks.pending).toBe(0);
  expect(worker.terminate).toHaveBeenCalledOnce();
  unmount();
});

it('reports worker computation errors through drawing failure instead of waiting indefinitely', () => {
  vi.stubGlobal('Worker', FakeWorker);
  const tasks = createWorkbenchDrawingTasks(); tasks.setBlocking(false);
  const input = job('broken');
  const { unmount } = renderHook(() => useSceneComputation(input), {
    wrapper: ({ children }) => <WorkbenchDrawingContext.Provider value={tasks}>{children}</WorkbenchDrawingContext.Provider>,
  });
  const worker = FakeWorker.instances[0], request = worker.postMessage.mock.calls[0][0];
  act(() => worker.onmessage({ data: { id: request.id, error: '计算失败' } } as MessageEvent));
  expect(tasks.failure?.reason).toBe('error');
  expect(tasks.pending).toBe(0);
  unmount();
});
