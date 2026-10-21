import { StrictMode, useLayoutEffect, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkbenchLoadingBoundary, { useWorkbenchDrawingPreparation, useWorkbenchLoadingProgress, useWorkbenchSendingProgress, WORKBENCH_REQUEST_WAIT_MS } from '../components/WorkbenchLoadingBoundary';
import WorkbenchActivityIndicator from '../components/WorkbenchActivityIndicator';
import { useWorkbenchDrawingTask, WORKBENCH_DRAWING_TIMEOUT_MS } from '../context/WorkbenchDrawingContext';
import { resetWorkbenchActivity } from '../utils/workbenchActivity';

type Task = ReturnType<ReturnType<typeof useWorkbenchDrawingTask>>;
type Tasks = { measurement: Task; overlays: Task; positioning: Task };

function Content({ loading = false, sending = false, error = null, count = 3, onRender = () => undefined, revision, onTasks }: {
  loading?: boolean; sending?: boolean; error?: string | null; count?: number; onRender?: () => void; revision?: unknown;
  onTasks?: (tasks: Tasks) => void;
}) {
  useWorkbenchLoadingProgress(loading, error, revision);
  useWorkbenchSendingProgress(sending);
  const measure = useWorkbenchDrawingTask('measurement');
  const overlay = useWorkbenchDrawingTask('overlays');
  const position = useWorkbenchDrawingTask('positioning');
  const [placed, setPlaced] = useState(false);
  useLayoutEffect(() => {
    if (!onTasks) return;
    const tasks = { measurement: measure(), overlays: overlay(), positioning: position() };
    onTasks({ ...tasks, positioning: {
      ...tasks.positioning,
      complete() { setPlaced(true); tasks.positioning.complete(); },
      cancel: tasks.positioning.cancel,
    } });
    return () => { Object.values(tasks).forEach(task => task.cancel()); };
  }, [onTasks, revision, measure, overlay, position]);
  onRender();
  return <div data-testid="workbench" data-placed={placed}>{error ?? <>
    <input aria-label="消息输入" />
    {Array.from({ length: count }, (_, i) => <div key={i}>旧消息 {i}</div>)}
  </>}</div>;
}

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const finish = (tasks: Tasks) => act(() => { Object.values(tasks).forEach(task => task.complete()); });

function Preparation({ onReady }: { onReady(prepare: ReturnType<typeof useWorkbenchDrawingPreparation>): void }) {
  const prepare = useWorkbenchDrawingPreparation();
  useLayoutEffect(() => { onReady(prepare); }, [prepare, onReady]);
  return null;
}

describe('workbench loading through registered drawing tasks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { resetWorkbenchActivity(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('keeps progress visible without collapse controls until drawing completes, preserving focus and background guards', () => {
    let tasks!: Tasks;
    const onTasks = (value: Tasks) => { tasks = value; };
    render(<WorkbenchLoadingBoundary><Content onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    const root = screen.getByTestId('workbench').parentElement!;
    const dialog = screen.getByRole('dialog');
    const message = dialog.querySelector<HTMLElement>('[tabindex="-1"]')!;
    expect(message).toHaveFocus();
    expect(screen.queryByRole('button', { name: /收起|显示进度/ })).toBeNull();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    message.dispatchEvent(tab); expect(tab.defaultPrevented).toBe(true);
    fireEvent.keyDown(message, { key: 'Escape' });
    fireEvent.click(dialog.closest('[data-popup-content-layer]')!);
    expect(dialog).toBeInTheDocument(); expect(root.inert).toBe(true);
    expect(message).toHaveFocus();
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true });
    message.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    finish(tasks); advance(34); expect(root.inert).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('releases an abandoned sending wait without claiming that the write completed', () => {
    render(<WorkbenchLoadingBoundary><Content sending /></WorkbenchLoadingBoundary>);
    advance(WORKBENCH_REQUEST_WAIT_MS);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('发送结果尚未确认');
    expect(screen.getByTestId('workbench').parentElement!.inert).toBe(false);
  });

  it('waits for every task even through long idle gaps, then unlocks clicking, keys and scrolling with both prompts', () => {
    let tasks!: Tasks;
    const onTasks = (value: Tasks) => { tasks = value; };
    const click = vi.fn(), key = vi.fn();
    render(<><WorkbenchLoadingBoundary><Content onTasks={onTasks} /><button onClick={click}>选择消息卡</button></WorkbenchLoadingBoundary><WorkbenchActivityIndicator /></>);
    const root = screen.getByTestId('workbench').parentElement!;
    const overflow = document.body.style.overflow;
    advance(5000);
    expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('正在绘制');
    act(() => tasks.measurement.complete());
    advance(5000);
    act(() => tasks.overlays.complete());
    advance(5000);
    expect(root.inert).toBe(true);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const wheel = new WheelEvent('wheel', { cancelable: true });
    window.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    act(() => tasks.positioning.complete());
    expect(screen.getByTestId('workbench')).toHaveAttribute('data-placed', 'true');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    advance(34);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status')).not.toHaveTextContent('正在绘制');
    expect(root.inert).toBe(false);
    expect(document.body.style.overflow).toBe(overflow);
    document.addEventListener('keydown', key);
    try {
      fireEvent.click(screen.getByRole('button', { name: '选择消息卡' }));
      fireEvent.keyDown(document, { key: 'Enter' });
      expect(click).toHaveBeenCalledOnce();
      expect(key).toHaveBeenCalledOnce();
      const availableWheel = new WheelEvent('wheel', { cancelable: true });
      window.dispatchEvent(availableWheel);
      expect(availableWheel.defaultPrevented).toBe(false);
    } finally { document.removeEventListener('keydown', key); }
  });

  it('does not let stale completions from a replaced archive close the new drawing dialog', () => {
    let tasks!: Tasks;
    const onTasks = (value: Tasks) => { tasks = value; };
    const view = render(<WorkbenchLoadingBoundary><Content revision="first" onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    const first = tasks;
    act(() => first.measurement.complete());
    view.rerender(<WorkbenchLoadingBoundary><Content revision="second" onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    finish(first);
    advance(10000);
    expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
    act(() => tasks.measurement.cancel());
    act(() => tasks.overlays.complete());
    advance(10000);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => tasks.positioning.complete());
    advance(34);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reopens for new archives and keeps state changes committed before finishing', () => {
    const onRender = vi.fn();
    const view = render(<WorkbenchLoadingBoundary><Content onRender={onRender} /></WorkbenchLoadingBoundary>);
    advance(34);
    expect(screen.queryByRole('dialog')).toBeNull();
    let tasks!: Tasks;
    const onTasks = (value: Tasks) => { tasks = value; };
    view.rerender(<WorkbenchLoadingBoundary><Content revision="file" count={420} onRender={onRender} onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
    finish(tasks);
    const renderCount = onRender.mock.calls.length;
    advance(34);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getAllByText(/^旧消息 /)).toHaveLength(420);
    expect(onRender).toHaveBeenCalledTimes(renderCount);
    fireEvent.change(screen.getByLabelText('消息输入'), { target: { value: '关窗后立即输入' } });
    expect(screen.getByLabelText('消息输入')).toHaveValue('关窗后立即输入');
  });

  it('waits for sending and then for the committed drawing tasks', () => {
    const view = render(<WorkbenchLoadingBoundary><Content sending /></WorkbenchLoadingBoundary>);
    advance(6000);
    expect(screen.getByRole('dialog', { name: '正在发送' })).toBeInTheDocument();
    let tasks!: Tasks;
    const onTasks = (value: Tasks) => { tasks = value; };
    view.rerender(<WorkbenchLoadingBoundary><Content onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    advance(6000);
    expect(screen.getByRole('dialog', { name: '正在发送' })).toBeInTheDocument();
    finish(tasks);
    advance(34);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('workbench').parentElement!.inert).toBe(false);
  });

  it('keeps progress visible through a slow send and queued preparation until the mask is ready', () => {
    let tasks!: Tasks, prepare!: ReturnType<typeof useWorkbenchDrawingPreparation>;
    const onTasks = (value: Tasks) => { tasks = value; };
    const onReady = (value: typeof prepare) => { prepare = value; };
    const work = vi.fn();
    const view = render(<WorkbenchLoadingBoundary><Content sending onTasks={onTasks} /><Preparation onReady={onReady} /></WorkbenchLoadingBoundary>);
    act(() => { prepare(work); });
    advance(45_000);
    const root = screen.getByTestId('workbench').parentElement!;
    expect(root.inert).toBe(true);
    expect(screen.getByRole('dialog')).toHaveTextContent('正在等待服务器确认发送');
    expect(work).not.toHaveBeenCalled();
    view.rerender(<WorkbenchLoadingBoundary><Content onTasks={onTasks} /><Preparation onReady={onReady} /></WorkbenchLoadingBoundary>);
    advance(34);
    expect(work).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog')).toHaveTextContent('正在完成消息绘制和新消息定位');
    const key = vi.fn();
    document.addEventListener('keydown', key);
    try {
      fireEvent.keyDown(screen.getByLabelText('消息输入'), { key: 'Enter' });
      expect(key).not.toHaveBeenCalled();
      const wheel = new WheelEvent('wheel', { cancelable: true });
      window.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(true);
      act(() => tasks.measurement.complete());
      act(() => tasks.overlays.complete());
      advance(1000);
      expect(root.inert).toBe(true);
      act(() => tasks.positioning.complete());
      expect(screen.getByTestId('workbench')).toHaveAttribute('data-placed', 'true');
      expect(root.inert).toBe(true);
      advance(34);
      expect(root.inert).toBe(false);
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally { document.removeEventListener('keydown', key); }
  });

  it('keeps a fixed drawing deadline with continuous progress, then gives the next send fresh ownership', () => {
    let tasks!: Tasks;
    const onTasks = (value: Tasks) => { tasks = value; };
    const view = render(<WorkbenchLoadingBoundary><Content sending onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    advance(45_000);
    view.rerender(<WorkbenchLoadingBoundary><Content onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    const old = tasks, root = screen.getByTestId('workbench').parentElement!;
    advance(20_000);
    expect(screen.getByRole('dialog', { name: '正在发送' })).toBeInTheDocument();
    advance(WORKBENCH_DRAWING_TIMEOUT_MS - 20_001);
    expect(root.inert).toBe(true);
    advance(1);
    expect(root.inert).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('超过 30 秒');
    expect(screen.queryByRole('status')).toBeNull();
    view.rerender(<WorkbenchLoadingBoundary><Content sending onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(root.inert).toBe(true);
    advance(45_000);
    expect(screen.getByRole('dialog', { name: '正在发送' })).toBeInTheDocument();
    view.rerender(<WorkbenchLoadingBoundary><Content revision="next" onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    finish(old); advance(34);
    expect(root.inert).toBe(true);
    finish(tasks); advance(34);
    expect(root.inert).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cancels queued work on failure so it cannot run late or reopen progress indefinitely', () => {
    let tasks!: Tasks, prepare!: ReturnType<typeof useWorkbenchDrawingPreparation>;
    const onTasks = (value: Tasks) => { tasks = value; };
    const onReady = (value: typeof prepare) => { prepare = value; };
    const work = vi.fn();
    const view = render(<WorkbenchLoadingBoundary><Content sending onTasks={onTasks} /><Preparation onReady={onReady} /></WorkbenchLoadingBoundary>);
    act(() => { prepare(work); });
    act(() => tasks.overlays.fail(new Error('连线失败')));
    view.rerender(<WorkbenchLoadingBoundary><Content onTasks={onTasks} /><Preparation onReady={onReady} /></WorkbenchLoadingBoundary>);
    act(() => { prepare(work); });
    advance(60_000);
    expect(work).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('workbench').parentElement!.inert).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('连线绘制失败');
  });

  it('closes progress and restores interaction when preparation throws', () => {
    let prepare!: ReturnType<typeof useWorkbenchDrawingPreparation>;
    const onReady = (value: typeof prepare) => { prepare = value; };
    render(<WorkbenchLoadingBoundary><Content /><Preparation onReady={onReady} /></WorkbenchLoadingBoundary>);
    advance(34);
    act(() => { prepare(() => { throw new Error('准备失败'); }); });
    advance(34);
    expect(screen.getByRole('alert')).toHaveTextContent('消息整理失败');
    expect(screen.getByTestId('workbench').parentElement!.inert).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('waits for the actual font promise without using a timeout', async () => {
    let ready!: () => void;
    const original = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loading', ready: new Promise<void>(resolve => { ready = resolve; }) } });
    try {
      render(<WorkbenchLoadingBoundary><Content /></WorkbenchLoadingBoundary>);
      advance(10000);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      await act(async () => { ready(); await Promise.resolve(); });
      advance(34);
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      if (original) Object.defineProperty(document, 'fonts', original);
      else Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('survives StrictMode setup cancellation without dropping the replacement tasks', () => {
    let tasks!: Tasks;
    const onTasks = (value: Tasks) => { tasks = value; };
    render(<StrictMode><WorkbenchLoadingBoundary><Content onTasks={onTasks} /></WorkbenchLoadingBoundary></StrictMode>);
    advance(1000);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    finish(tasks);
    advance(34);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('releases errors immediately and cancels unfinished tasks on unmount', () => {
    let tasks!: Tasks;
    const onTasks = (value: Tasks) => { tasks = value; };
    const view = render(<WorkbenchLoadingBoundary><Content loading onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    view.rerender(<WorkbenchLoadingBoundary><Content error="网络错误，请重试" onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('网络错误，请重试')).toBeVisible();
    view.rerender(<WorkbenchLoadingBoundary><Content onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    view.unmount();
    finish(tasks);
    advance(1000);
    expect(vi.getTimerCount()).toBe(0);
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it.each(['measurement', 'overlays', 'positioning'] as const)('releases the modal and indicator immediately when %s throws', kind => {
    let tasks!: Tasks;
    const onTasks = (value: Tasks) => { tasks = value; };
    const click = vi.fn();
    render(<><WorkbenchLoadingBoundary><Content onTasks={onTasks} /><button onClick={click}>选择消息卡</button></WorkbenchLoadingBoundary><WorkbenchActivityIndicator /></>);
    const cancelled = vi.fn();
    tasks.positioning.onCancel(cancelled);
    advance(500);
    act(() => tasks[kind].run(() => { throw new Error('模拟任务异常'); }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('失败，已恢复操作');
    expect(screen.queryByRole('status')).toBeNull(); // Failure is not a successful drawing duration.
    expect(screen.getByTestId('workbench').parentElement!.inert).toBe(false);
    expect(cancelled).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '选择消息卡' }));
    expect(click).toHaveBeenCalledOnce();
    const late = vi.fn();
    act(() => tasks.overlays.run(late));
    finish(tasks);
    advance(34);
    expect(late).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('times out abandoned tasks and starts a clean retry without accepting old callbacks', () => {
    let tasks!: Tasks;
    const onTasks = (value: Tasks) => { tasks = value; };
    render(<><WorkbenchLoadingBoundary><Content onTasks={onTasks} /></WorkbenchLoadingBoundary><WorkbenchActivityIndicator /></>);
    const old = tasks, cancelled = vi.fn(), late = vi.fn();
    old.positioning.onCancel(cancelled);
    advance(WORKBENCH_DRAWING_TIMEOUT_MS - 1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('超过 30 秒');
    expect(screen.queryByRole('status')).toBeNull();
    expect(cancelled).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
    act(() => old.positioning.run(late));
    finish(old);
    advance(34);
    expect(late).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    finish(tasks);
    advance(34);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('excludes time in a hidden tab from the drawing deadline', () => {
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const onTasks = () => undefined;
    render(<WorkbenchLoadingBoundary><Content onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    advance(20_000);
    act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    advance(60_000);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    advance(9999);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('超过 30 秒');
  });

  it('gives a new archive its own deadline and clears the prior failure', () => {
    let tasks!: Tasks;
    const onTasks = (value: Tasks) => { tasks = value; };
    const view = render(<WorkbenchLoadingBoundary><Content revision="first" onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    advance(29_000);
    view.rerender(<WorkbenchLoadingBoundary><Content revision="second" onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    advance(29_000);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    advance(1000);
    expect(screen.getByRole('alert')).toHaveTextContent('超过 30 秒');
    view.rerender(<WorkbenchLoadingBoundary><Content revision="third" onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    finish(tasks);
    advance(34);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('recovers even when the browser never delivers the requested animation frames', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    render(<WorkbenchLoadingBoundary><Content /></WorkbenchLoadingBoundary>);
    advance(WORKBENCH_DRAWING_TIMEOUT_MS);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('超过 30 秒');
  });

  it('recovers rendering failures that happen before the drawing subscription mounts', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const suppressExpectedError = (event: ErrorEvent) => { if (event.error?.message === '场景生成异常') event.preventDefault(); };
    window.addEventListener('error', suppressExpectedError);
    let broken = true;
    function BrokenScene() { if (broken) throw new Error('场景生成异常'); return <Content />; }
    try {
      render(<WorkbenchLoadingBoundary><BrokenScene /></WorkbenchLoadingBoundary>);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('alert')).toHaveTextContent('页面绘制失败');
      broken = false;
      fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
      advance(34);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByLabelText('消息输入')).toBeInTheDocument();
    } finally { window.removeEventListener('error', suppressExpectedError); }
  });

  it('releases a rejected font task and leaves a recoverable failure prompt', async () => {
    let reject!: (error: Error) => void;
    const original = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: {
      status: 'loading', ready: new Promise<void>((_, failed) => { reject = failed; }),
    } });
    try {
      render(<WorkbenchLoadingBoundary><Content /></WorkbenchLoadingBoundary>);
      await act(async () => { reject(new Error('字体加载异常')); await Promise.resolve(); });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('alert')).toHaveTextContent('字体加载失败');
    } finally {
      if (original) Object.defineProperty(document, 'fonts', original);
      else Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('still releases the remaining tasks if a cancellation callback throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let tasks!: Tasks;
    const onTasks = (value: Tasks) => { tasks = value; };
    render(<WorkbenchLoadingBoundary><Content onTasks={onTasks} /></WorkbenchLoadingBoundary>);
    const cancelled = vi.fn();
    tasks.measurement.onCancel(() => { throw new Error('清理异常'); });
    tasks.positioning.onCancel(cancelled);
    act(() => tasks.overlays.fail(new Error('绘制异常')));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('连线绘制失败');
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
