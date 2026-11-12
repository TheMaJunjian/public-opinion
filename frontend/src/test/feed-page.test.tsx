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
beforeEach(() => { vi.clearAllMocks(); getFeed.mockResolvedValue(page([item('one')], 'next')); setFeedHidden.mockResolvedValue({ ok: true }); });
afterEach(cleanup);

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
