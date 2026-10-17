import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkbenchLoadingBoundary, { useWorkbenchLoadingProgress } from '../components/WorkbenchLoadingBoundary';

function Content({ loading = false, error = null, count = 3, onRender = () => undefined }: {
  loading?: boolean; error?: string | null; count?: number; onRender?: () => void;
}) {
  useWorkbenchLoadingProgress(loading, error);
  onRender();
  return <div data-testid="workbench">{error ?? <>
    <input aria-label="消息输入" />
    {Array.from({ length: count }, (_, i) => <div key={i}>旧消息 {i}</div>)}
  </>}</div>;
}

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('workbench loading through drawing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('keeps input inactive through measurement updates, then exposes all historical messages without rerendering them', async () => {
    const onRender = vi.fn();
    const view = render(<WorkbenchLoadingBoundary><Content loading onRender={onRender} /></WorkbenchLoadingBoundary>);
    expect(screen.getByRole('dialog', { name: '正在加载' })).toBeInTheDocument();
    const root = screen.getByTestId('workbench').parentElement!;
    expect(root.inert).toBe(true);
    view.rerender(<WorkbenchLoadingBoundary><Content count={420} onRender={onRender} /></WorkbenchLoadingBoundary>);
    expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
    advance(96);
    // Simulate later card/edge measurement commits while the data is visible.
    act(() => { screen.getByTestId('workbench').style.height = '800px'; });
    // MutationObserver callbacks are microtasks, even with fake timers.
    await act(async () => { await Promise.resolve(); });
    advance(96);
    expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
    const renderCount = onRender.mock.calls.length;
    advance(96);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(root.inert).toBe(false);
    expect(root).toHaveAttribute('aria-busy', 'false');
    expect(screen.getAllByText(/^旧消息 /)).toHaveLength(420);
    expect(onRender).toHaveBeenCalledTimes(renderCount);
    fireEvent.change(screen.getByLabelText('消息输入'), { target: { value: '可以输入' } });
    expect(screen.getByLabelText('消息输入')).toHaveValue('可以输入');
  });

  it('does not mistake time spent blocking the browser for finished drawing', () => {
    let now = 0;
    let nextFrame: FrameRequestCallback | undefined;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { nextFrame = callback; return 1; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { nextFrame = undefined; });
    const step = (time: number) => {
      now = time;
      const callback = nextFrame!;
      nextFrame = undefined;
      act(() => callback(time));
    };
    render(<WorkbenchLoadingBoundary><Content /></WorkbenchLoadingBoundary>);
    step(16);
    step(2000); // A long render held the main thread for almost two seconds.
    advance(1);
    expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
    for (let time = 2016; nextFrame && time <= 2144; time += 16) step(time);
    advance(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('blocks workbench shortcuts while drawing and restores them when ready', () => {
    const shortcut = vi.fn();
    render(<WorkbenchLoadingBoundary><Content /></WorkbenchLoadingBoundary>);
    document.addEventListener('keydown', shortcut);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(shortcut).not.toHaveBeenCalled();
    advance(200);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(shortcut).toHaveBeenCalledOnce();
    document.removeEventListener('keydown', shortcut);
  });

  it('finishes drawing when a mobile browser delivers animation frames only every 100ms', () => {
    let now = 0;
    let nextFrame: FrameRequestCallback | undefined;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { nextFrame = callback; return 1; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { nextFrame = undefined; });
    render(<WorkbenchLoadingBoundary><Content /></WorkbenchLoadingBoundary>);
    for (const time of [100, 200, 300, 400]) {
      now = time;
      const callback = nextFrame;
      nextFrame = undefined;
      if (callback) act(() => callback(time));
      advance(1);
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('workbench').parentElement!.inert).toBe(false);
  });

  it('releases loading on failure and cleans up pending drawing on unmount', () => {
    const view = render(<WorkbenchLoadingBoundary><Content loading /></WorkbenchLoadingBoundary>);
    view.rerender(<WorkbenchLoadingBoundary><Content error="网络错误，请重试" /></WorkbenchLoadingBoundary>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('网络错误，请重试')).toBeVisible();
    view.rerender(<WorkbenchLoadingBoundary><Content /></WorkbenchLoadingBoundary>);
    expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
    view.unmount();
    advance(500);
    expect(document.body.style.overflow).not.toBe('hidden');
    expect(vi.getTimerCount()).toBe(0);
  });
});
