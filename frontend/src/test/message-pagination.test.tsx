import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MessagePagination from '../components/MessagePagination';
import { createWorkbenchDrawingTasks, WorkbenchDrawingContext } from '../context/WorkbenchDrawingContext';
import { useMessageWindow } from '../hooks/useMessageWindow';
import type { DemoMessage } from '../utils/modelBridge';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const rect = (top: number) => ({ top, bottom: top + 1, height: 1, left: 0, right: 1, width: 1, x: 0, y: top, toJSON() {} });
const tick = () => act(() => vi.advanceTimersByTimeAsync(40));

it('loads automatically only near the mounted boundary and coalesces repeated events until drawing completes', async () => {
  let finish!: () => void;
  const onMore = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const props = { parent: 'root', loadedCount: 50, hasMore: true, loading: false, panelRef: { current: null }, onMore, onError: vi.fn() };
  const view = render(<MessagePagination {...props} />);
  const footer = screen.getByText(/^当前已显示/);
  const bounds = vi.spyOn(footer, 'getBoundingClientRect').mockReturnValue(rect(5000));
  await tick(); expect(onMore).not.toHaveBeenCalled();
  expect(screen.queryByRole('button')).toBeNull();
  bounds.mockReturnValue(rect(100));
  fireEvent.scroll(document); await tick();
  fireEvent.scroll(document); fireEvent.resize(window); await tick();
  expect(onMore).toHaveBeenCalledExactlyOnceWith('root');
  await act(async () => finish());
  view.rerender(<MessagePagination {...props} loadedCount={100} />);
  await tick(); expect(onMore).toHaveBeenCalledTimes(2);
  await act(async () => finish());
  view.rerender(<MessagePagination {...props} loadedCount={120} hasMore={false} />);
  fireEvent.scroll(document); fireEvent.resize(window); await tick();
  expect(onMore).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/当前范围已全部显示/)).toBeInTheDocument();
});

it('observes the graph boundary rather than the bottom of the reserved full canvas', async () => {
  const panel = document.createElement('div'), marker = document.createElement('div');
  marker.dataset.messageWindowBoundary = 'true'; panel.append(marker); document.body.append(panel);
  vi.spyOn(marker, 'getBoundingClientRect').mockReturnValue(rect(100));
  const onMore = vi.fn().mockResolvedValue(undefined);
  const view = render(<MessagePagination parent="root" loadedCount={50} hasMore loading={false} panelRef={{ current: panel }} onMore={onMore} onError={vi.fn()} />);
  await tick(); expect(onMore).toHaveBeenCalledOnce();
  view.unmount(); fireEvent.scroll(panel); await tick();
  expect(onMore).toHaveBeenCalledOnce(); panel.remove();
});

it('resumes visible batches after classification drawing finishes without scrolling or reentering', async () => {
  const tasks = createWorkbenchDrawingTasks();
  const messages: DemoMessage[] = Array.from({ length: 120 }, (_, index) => ({
    id: `message-${index}`, author: '用户', kind: 'normal', content: '', createdAt: new Date(index * 1000).toISOString(),
  }));
  const edges: [] = [];
  function Classification() {
    const window = useMessageWindow(messages, edges, true, 'last-classification', []);
    return <>
      <output data-testid="loading">{window.loading ? 'loading' : ''}</output>
      <MessagePagination parent="last-classification" loadedCount={window.messages.length} hasMore={window.hasMore}
        loading={window.loading} showLoadingNotice={false} panelRef={{ current: null }} onMore={window.more} onError={vi.fn()} />
    </>;
  }
  render(<WorkbenchDrawingContext.Provider value={tasks}><Classification /></WorkbenchDrawingContext.Provider>);
  vi.spyOn(screen.getByText(/^当前已显示 50 条消息/), 'getBoundingClientRect').mockReturnValue(rect(100));
  await tick();
  expect(screen.getByText(/当前已显示 50 条消息/)).toBeInTheDocument();
  expect(screen.getByTestId('loading')).toBeEmptyDOMElement();
  act(() => tasks.setBlocking(false));
  let sawLoading = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    await tick();
    sawLoading ||= screen.getByTestId('loading').textContent === 'loading';
  }
  expect(sawLoading).toBe(true);
  expect(screen.getByText(/当前已显示 120 条消息/)).toHaveTextContent('当前范围已全部显示');
  expect(screen.getByTestId('loading')).toBeEmptyDOMElement();
});

it('stops repeated automatic attempts after a failure and cancels scheduled work on unmount', async () => {
  const onMore = vi.fn().mockRejectedValue(new Error('绘制失败')), onError = vi.fn();
  const props = { parent: 'root', loadedCount: 50, hasMore: true, loading: false, panelRef: { current: null }, onMore, onError };
  const view = render(<MessagePagination {...props} />);
  vi.spyOn(screen.getByText(/^当前已显示/), 'getBoundingClientRect').mockReturnValue(rect(100));
  await tick(); expect(onError).toHaveBeenCalledExactlyOnceWith('绘制失败');
  fireEvent.scroll(document); await tick(); expect(onMore).toHaveBeenCalledOnce();
  view.unmount();
  const second = render(<MessagePagination {...props} parent="other" />);
  second.unmount(); await tick(); expect(onMore).toHaveBeenCalledOnce();
});

it('shows loading as a zero-height notice without manufacturing message cards or reserving geometry', () => {
  const view = render(<MessagePagination parent="root" loadedCount={50} hasMore loading panelRef={{ current: null }} onMore={vi.fn()} onError={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent('正在加载消息');
  const notice = view.container.querySelector<HTMLElement>('[data-message-loading-notice]')!;
  expect(notice.style.height).toBe('0px'); expect(notice.style.position).toBe('sticky');
  expect(view.container.querySelector('[data-msgid]')).toBeNull();
  view.rerender(<MessagePagination parent="root" loadedCount={100} hasMore={false} loading={false} panelRef={{ current: null }} onMore={vi.fn()} onError={vi.fn()} />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText(/当前已显示 100 条消息/)).toBeInTheDocument();
});

it('offers an explicit retry after a failed automatic load', async () => {
  const onMore = vi.fn().mockRejectedValueOnce(new Error('connection')).mockResolvedValue(undefined);
  render(<MessagePagination parent="root" loadedCount={50} hasMore loading={false} panelRef={{ current: null }} onMore={onMore} onError={vi.fn()} />);
  vi.spyOn(screen.getByText(/^当前已显示/), 'getBoundingClientRect').mockReturnValue(rect(100));
  await tick(); expect(screen.getByRole('alert')).toHaveTextContent('消息加载失败');
  fireEvent.click(screen.getByRole('button', { name: '重试加载消息' }));
  await tick(); expect(onMore).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
});
