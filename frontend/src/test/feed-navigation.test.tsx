import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserRouter, HashRouter, Route, useNavigate } from 'react-router-dom';
import type { FeedItem, FeedPage as Page } from '@gonglun/core';
import FeedPage from '../pages/FeedPage';
import RetainedAppRoutes from '../components/RetainedAppRoutes';

const { getFeed, auth } = vi.hoisted(() => ({ getFeed: vi.fn(), auth: { user: { id: 'alice' } as { id: string } | null } }));
vi.mock('../api', () => ({ api: { getFeed, setFeedHidden: vi.fn() } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));
const item = (id: string): FeedItem => ({ id, revision: 1, excerpt: `讨论正文 ${id}`, kind: '讨论', author: { id: 'bob', username: 'bob' },
  createdAt: '', updatedAt: '', hasCorrections: false, reasons: [], updates: [] });
const page = (ids: string[], nextCursor: string | null = null): Page => ({ mode: 'recommended', items: ids.map(item), nextCursor });
function Workbench() {
  const navigate = useNavigate();
  return <><p>消息工作台</p><button onClick={() => navigate(-1)}>返回首页</button></>;
}
function App({ hash = false }: { hash?: boolean }) {
  const Router = hash ? HashRouter : BrowserRouter;
  return <Router><RetainedAppRoutes><Route path="/" element={<FeedPage />} /><Route path="/messages" element={<Workbench />} /></RetainedAppRoutes></Router>;
}
beforeEach(() => {
  vi.clearAllMocks(); auth.user = { id: 'alice' };
  vi.spyOn(window, 'scrollTo').mockImplementation(((options: ScrollToOptions) => {
    Object.defineProperty(window, 'scrollX', { configurable: true, value: options.left ?? 0 });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: options.top ?? 0 });
  }) as typeof window.scrollTo);
  window.scrollTo({ top: 0, left: 0 });
  getFeed.mockResolvedValue(page(['one'], 'next'));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function traverse(delta: number) {
  await act(async () => {
    const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }));
    window.history.go(delta); await popped;
  });
}

it.each([false, true])('restores loaded pages, disclosure, cursor and document position after Back and Forward (hash=%s)', async hash => {
  window.history.replaceState({ key: 'feed', idx: 0 }, '', hash ? '/#/' : '/');
  render(<App hash={hash} />);
  await screen.findByText('讨论正文 one');
  getFeed.mockResolvedValueOnce(page(['two'], 'third'));
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await screen.findByText('讨论正文 two');
  const original = screen.getByRole('region', { name: '讨论首页' });
  const explanation = original.querySelector('details')!; explanation.open = true;
  window.scrollTo({ top: 780, left: 12 });
  fireEvent.click(screen.getByRole('link', { name: '讨论正文 two' }));
  expect(await screen.findByText('消息工作台')).toBeVisible();
  expect(window.scrollY).toBe(0);
  window.scrollTo({ top: 46, left: 0 });
  fireEvent.click(screen.getByRole('button', { name: '返回首页' }));
  await screen.findByText('讨论正文 two');
  expect(screen.getByRole('region', { name: '讨论首页' })).toBe(original);
  expect(explanation.open).toBe(true);
  expect([window.scrollX, window.scrollY]).toEqual([12, 780]);
  expect(getFeed).toHaveBeenCalledTimes(2);
  await traverse(1);
  expect(screen.getByText('消息工作台')).toBeVisible(); expect(window.scrollY).toBe(46);
  await traverse(-1);
  expect(window.scrollY).toBe(780);
  getFeed.mockResolvedValueOnce(page(['three']));
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await screen.findByText('讨论正文 three');
  expect(getFeed).toHaveBeenLastCalledWith('recommended', 'third', expect.any(AbortSignal));
  getFeed.mockResolvedValueOnce(page(['refreshed']));
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByText('讨论正文 refreshed');
  expect(screen.queryByText('讨论正文 two')).toBeNull();
});

it('preserves each home history entry and clears retained feeds when the account changes', async () => {
  window.history.replaceState({ key: 'feed', idx: 0 }, '', '/');
  const view = render(<App />);
  await screen.findByText('讨论正文 one');
  getFeed.mockResolvedValueOnce({ ...page(['followed']), mode: 'following' });
  fireEvent.click(screen.getByRole('link', { name: '关注' }));
  await screen.findByText('讨论正文 followed');
  window.scrollTo({ top: 320 });
  fireEvent.click(screen.getByRole('link', { name: '讨论正文 followed' }));
  fireEvent.click(await screen.findByRole('button', { name: '返回首页' }));
  await screen.findByText('讨论正文 followed');
  expect(screen.getByRole('link', { name: '关注' })).toHaveAttribute('aria-current', 'page');
  expect(window.scrollY).toBe(320); expect(getFeed).toHaveBeenCalledTimes(2);
  await traverse(-1);
  expect(screen.getByText('讨论正文 one')).toBeVisible();
  expect(screen.getByRole('link', { name: '推荐' })).toHaveAttribute('aria-current', 'page');
  expect(getFeed).toHaveBeenCalledTimes(2);
  auth.user = { id: 'other' }; getFeed.mockResolvedValueOnce(page(['other-user']));
  view.rerender(<App />);
  await screen.findByText('讨论正文 other-user');
  await waitFor(() => expect(screen.queryByText('讨论正文 one')).toBeNull());
  expect(window.scrollY).toBe(0);
});
