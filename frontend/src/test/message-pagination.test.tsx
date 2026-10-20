import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MessagePagination from '../components/MessagePagination';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('requestIdleCallback', undefined); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows the first page before prefetching one next page and never automatically drains the remaining history', async () => {
  const onMore = vi.fn().mockResolvedValue(undefined), onError = vi.fn();
  const props = { parent: 'root', loadedCount: 50, hasMore: true, loading: false, panelRef: { current: null }, onMore, onError };
  const view = render(<MessagePagination {...props} />);
  expect(screen.getByText(/当前已加载 50/)).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(599));
  expect(onMore).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(onMore).toHaveBeenCalledExactlyOnceWith('root');
  view.rerender(<MessagePagination {...props} loadedCount={100} />);
  await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(onMore).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});

it('loads further pages on downward scrolling near the bottom and coalesces scroll bursts', async () => {
  const panel = document.createElement('div'); document.body.append(panel);
  Object.defineProperties(panel, { clientHeight: { value: 500 }, scrollHeight: { value: 2000 } });
  let finish!: () => void;
  const onMore = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<MessagePagination parent="root" loadedCount={50} hasMore loading={false} panelRef={{ current: panel }} onMore={onMore} onError={vi.fn()} />);
  panel.scrollTop = 100; fireEvent.scroll(panel);
  expect(onMore).not.toHaveBeenCalled();
  panel.scrollTop = 1300; fireEvent.scroll(panel);
  panel.scrollTop = 1400; fireEvent.scroll(panel);
  expect(onMore).toHaveBeenCalledOnce();
  await act(async () => finish());
  panel.scrollTop = 1450; fireEvent.scroll(panel);
  expect(onMore).toHaveBeenCalledTimes(2);
  await act(async () => finish());
  panel.remove();
});

it('cancels pending prefetch when leaving the page and reports a failed background request', async () => {
  const onMore = vi.fn().mockRejectedValue(new Error('网络暂时不可用')), onError = vi.fn();
  const props = { parent: 'root', loadedCount: 50, hasMore: true, loading: false, panelRef: { current: null }, onMore, onError };
  const first = render(<MessagePagination {...props} />);
  first.unmount();
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(onMore).not.toHaveBeenCalled();
  render(<MessagePagination {...props} />);
  await act(() => vi.advanceTimersByTimeAsync(600));
  expect(onError).toHaveBeenCalledWith('网络暂时不可用');
});
