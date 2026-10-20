import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MessagePagination from '../components/MessagePagination';

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
