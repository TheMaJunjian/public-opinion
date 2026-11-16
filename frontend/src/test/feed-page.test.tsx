import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { FeedItem, FeedPage as Page } from '@gonglun/core';
import FeedPage from '../pages/FeedPage';

const { getFeed, setFeedHidden } = vi.hoisted(() => ({ getFeed: vi.fn(), setFeedHidden: vi.fn() }));
vi.mock('../api', () => ({ api: { getFeed, setFeedHidden } }));
const item = (id: string): FeedItem => ({ id, revision: 1, excerpt: `讨论正文 ${id}`, kind: '讨论', author: { id: 'bob', username: 'bob' },
  createdAt: '2026-11-11T01:00:00Z', updatedAt: '2026-11-11T01:00:00Z', hasCorrections: false, reasons: ['你关注的消息或分类'], updates: [] });
const page = (items: FeedItem[], nextCursor: string | null = null): Page => ({ mode: 'recommended', items, nextCursor });
function mount() { return render(<MemoryRouter><Routes><Route path="/" element={<FeedPage />} /><Route path="/messages" element={<p>消息工作台</p>} /></Routes></MemoryRouter>); }
beforeEach(() => { vi.resetAllMocks(); getFeed.mockResolvedValue(page([item('one')], 'next')); setFeedHidden.mockResolvedValue({ ok: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('loads only a light first page, preserves explicit message links and appends pages without duplicates', async () => {
  mount();
  expect(await screen.findByText('讨论正文 one')).toHaveAttribute('href', '/messages?msg=one&locate=1');
  expect(getFeed).toHaveBeenCalledExactlyOnceWith('recommended', undefined, expect.any(AbortSignal));
  getFeed.mockResolvedValueOnce(page([item('one'), item('two')]));
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  expect(await screen.findByText('讨论正文 two')).toBeVisible();
  expect(screen.getAllByText('讨论正文 one')).toHaveLength(1);
  expect(getFeed).toHaveBeenLastCalledWith('recommended', 'next', expect.any(AbortSignal));
});

it('ignores late responses from an old tab and preserves the selected scope in the URL', async () => {
  let resolve!: (value: Page) => void;
  getFeed.mockImplementationOnce(() => new Promise<Page>(done => { resolve = done; }));
  mount();
  getFeed.mockResolvedValueOnce({ ...page([item('latest')]), mode: 'latest' });
  fireEvent.click(screen.getByRole('link', { name: '最新' }));
  expect(await screen.findByText('讨论正文 latest')).toBeVisible();
  await act(async () => { resolve(page([item('stale')])); });
  expect(screen.queryByText('讨论正文 stale')).toBeNull();
  expect(screen.getByRole('link', { name: '最新' })).toHaveAttribute('aria-current', 'page');
});

it('saves negative feedback and supports undo without confirming reading', async () => {
  mount(); await screen.findByText('讨论正文 one');
  fireEvent.click(screen.getByRole('button', { name: '减少此讨论' }));
  expect(await screen.findByText('已减少此讨论的展示。')).toBeVisible();
  expect(screen.queryByText('讨论正文 one')).toBeNull();
  expect(setFeedHidden).toHaveBeenLastCalledWith('one', true);
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  expect(await screen.findByText('讨论正文 one')).toBeVisible();
  expect(setFeedHidden).toHaveBeenLastCalledWith('one', false);
});

it('keeps readable content on paging failure and recovers an expired recommendation batch', async () => {
  mount(); await screen.findByText('讨论正文 one');
  getFeed.mockRejectedValueOnce(Object.assign(new Error('推荐已更新'), { code: 'FEED_EXPIRED' }));
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('推荐已更新');
  expect(screen.getByText('讨论正文 one')).toBeVisible();
  getFeed.mockResolvedValueOnce(page([item('new')]));
  fireEvent.click(screen.getByRole('button', { name: '刷新列表' }));
  expect(await screen.findByText('讨论正文 new')).toBeVisible();
  expect(screen.queryByText('讨论正文 one')).toBeNull();
});

it('does not remove content when feedback fails and offers a useful following empty state', async () => {
  setFeedHidden.mockRejectedValueOnce(new Error('保存失败'));
  mount(); await screen.findByText('讨论正文 one');
  fireEvent.click(screen.getByRole('button', { name: '减少此讨论' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败');
  expect(screen.getByText('讨论正文 one')).toBeVisible();
  getFeed.mockResolvedValueOnce({ ...page([]), mode: 'following' });
  fireEvent.click(screen.getByRole('link', { name: '关注' }));
  expect(await screen.findByText('这里会汇集你关注的讨论')).toBeVisible();
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

it('falls back to recent content when recommendation fails and continues with the matching cursor', async () => {
  getFeed.mockRejectedValueOnce(Object.assign(new Error('暂时不可用'), { status: 503 }))
    .mockResolvedValueOnce({ ...page([item('fallback')], 'latest-cursor'), mode: 'latest' });
  mount();
  expect(await screen.findByText('讨论正文 fallback')).toBeVisible();
  expect(screen.getByText('推荐暂未准备好，先为你展示最新讨论。')).toBeVisible();
  getFeed.mockResolvedValueOnce({ ...page([item('second')]), mode: 'latest' });
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  expect(await screen.findByText('讨论正文 second')).toBeVisible();
  expect(getFeed).toHaveBeenLastCalledWith('latest', 'latest-cursor', expect.any(AbortSignal));
});

it('retries the selected recommendation mode on refresh after a temporary fallback', async () => {
  getFeed.mockRejectedValueOnce(Object.assign(new Error('暂时不可用'), { status: 503 }))
    .mockResolvedValueOnce({ ...page([item('fallback')], 'latest-cursor'), mode: 'latest' });
  mount(); await screen.findByText('讨论正文 fallback');
  getFeed.mockResolvedValueOnce(page([item('recovered')], 'recommended-cursor'));
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByText('讨论正文 recovered');
  expect(getFeed).toHaveBeenLastCalledWith('recommended', undefined, expect.any(AbortSignal), { limit: 20, retain: ['fallback'] });
  expect(screen.queryByText('推荐暂未准备好，先为你展示最新讨论。')).toBeNull();
  getFeed.mockResolvedValueOnce(page([item('more')]));
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await screen.findByText('讨论正文 more');
  expect(getFeed).toHaveBeenLastCalledWith('recommended', 'recommended-cursor', expect.any(AbortSignal));
});

it('updates the visible order automatically, preserves the reading anchor and uses the new cursor', async () => {
  vi.useFakeTimers();
  getFeed.mockResolvedValueOnce(page([item('one'), item('two')], 'old-cursor'));
  await act(async () => { mount(); });
  let scroll = 0;
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
  vi.spyOn(window, 'scrollTo').mockImplementation(((options: ScrollToOptions) => { scroll = options.top ?? 0; }) as typeof window.scrollTo);
  for (const card of document.querySelectorAll<HTMLElement>('[data-feed-id]')) vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => {
    const index = Array.from(document.querySelectorAll('[data-feed-id]')).indexOf(card);
    return { top: 100 + index * 200 - scroll, bottom: 300 + index * 200 - scroll } as DOMRect;
  });
  getFeed.mockResolvedValueOnce(page([item('two'), item('one')], 'updated-cursor'));
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(Array.from(document.querySelectorAll<HTMLElement>('[data-feed-id]')).map(card => card.dataset.feedId)).toEqual(['two', 'one']);
  expect(screen.getByLabelText('较上次上升 1 位')).toBeVisible();
  expect(screen.getByText(/推荐已更新：2 条位置变化/)).toBeVisible();
  expect(document.querySelector('[data-feed-id="one"]')!.getBoundingClientRect().top).toBe(100);
  expect(scroll).toBe(200);
  expect(getFeed).toHaveBeenLastCalledWith('recommended', undefined, expect.any(AbortSignal), { limit: 20, retain: ['one', 'two'] });
  getFeed.mockResolvedValueOnce(page([item('three')]));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '加载更多' })); });
  expect(getFeed).toHaveBeenLastCalledWith('recommended', 'updated-cursor', expect.any(AbortSignal));
  expect(screen.getByText('讨论正文 three')).toBeVisible();
});

it('keeps the current list operable when an automatic update fails', async () => {
  mount(); await screen.findByText('讨论正文 one');
  getFeed.mockRejectedValueOnce(new Error('网络失败'));
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(screen.getByText('讨论正文 one')).toBeVisible();
  expect(screen.getByText(/暂时无法更新排序/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '减少此讨论' }));
  await waitFor(() => expect(screen.queryByText('讨论正文 one')).toBeNull());
});

it('does not resurrect hidden content from an in-flight live update', async () => {
  mount(); await screen.findByText('讨论正文 one');
  let resolve!: (page: Page) => void;
  getFeed.mockImplementationOnce(() => new Promise<Page>(done => { resolve = done; }));
  await act(async () => { window.dispatchEvent(new Event('gonglun:reload')); });
  fireEvent.click(screen.getByRole('button', { name: '减少此讨论' }));
  await waitFor(() => expect(screen.queryByText('讨论正文 one')).toBeNull());
  await act(async () => { resolve(page([item('one'), item('two')])); });
  expect(screen.queryByText('讨论正文 one')).toBeNull();
  expect(screen.queryByText('讨论正文 two')).toBeNull();
});

it('continues the fresh cursor when the retained list exceeds one refresh window', async () => {
  const loaded = Array.from({ length: 401 }, (_, index) => item(`loaded-${index}`));
  getFeed.mockResolvedValueOnce(page(loaded));
  mount(); await screen.findByText('讨论正文 loaded-400');
  getFeed.mockResolvedValueOnce(page(loaded.slice(0, 400), 'window-tail')).mockResolvedValueOnce(page(loaded.slice(400)));
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(document.querySelectorAll('[data-feed-id]')).toHaveLength(401);
  expect(screen.getByText('讨论正文 loaded-400')).toBeVisible();
  expect(getFeed).toHaveBeenLastCalledWith('recommended', 'window-tail', expect.any(AbortSignal));
});
