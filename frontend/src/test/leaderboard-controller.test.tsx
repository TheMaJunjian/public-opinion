import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LeaderboardController, { type LeaderboardHandle } from '../components/LeaderboardController';
import type { CatalogClient } from '../data/catalogClient';
import type { LeaderboardModalProps } from '../components/LeaderboardModal';

const modal = vi.hoisted(() => ({ attempted: vi.fn(), received: vi.fn(), suspended: false, wait: Promise.resolve(), fail: false }));
vi.mock('../components/LeaderboardModal', () => ({
  default: ({ open, onClose, globalRows }: LeaderboardModalProps) => {
    if (!open) return null;
    modal.attempted();
    if (modal.fail) throw new Error('测试加载失败');
    if (modal.suspended) throw modal.wait;
    modal.received(globalRows);
    return <div role="dialog" aria-label="排行榜"><button onClick={onClose}>关闭</button></div>;
  },
}));

let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  frames = new Map();
  let next = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++next, callback); return next; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
  modal.attempted.mockClear(); modal.received.mockClear(); modal.suspended = false; modal.fail = false;
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const paint = () => act(() => {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(performance.now()));
});
function setup() {
  const ref = createRef<LeaderboardHandle>();
  const view = render(<LeaderboardController ref={ref} messages={[]} edges={[]} relations={[]} users={[]}
    stakeCounts={{}} messageBettorCounts={{}} onRefresh={vi.fn()} />);
  return { ...view, ref, open: () => act(() => ref.current!.open()) };
}

it('点击后立即显示进度，先给提示一次绘制机会，再开始准备排行榜', async () => {
  const view = setup();
  view.open();
  expect(screen.getByRole('dialog', { name: '正在打开排行榜' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('正在打开排行榜…');
  expect(modal.attempted).not.toHaveBeenCalled();
  paint();
  expect(modal.attempted).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: '正在打开排行榜' })).toBeInTheDocument();
  paint();
  await screen.findByRole('dialog', { name: '排行榜' });
  expect(screen.queryByRole('dialog', { name: '正在打开排行榜' })).toBeNull();
});

it('重开也先响应点击，重复点击只安排一次打开', async () => {
  const view = setup();
  view.open(); paint(); paint();
  await screen.findByRole('dialog', { name: '排行榜' });
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  modal.attempted.mockClear();
  view.open(); view.open();
  expect(frames.size).toBe(1);
  expect(modal.attempted).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: '正在打开排行榜' })).toBeInTheDocument();
  paint(); paint();
  await screen.findByRole('dialog', { name: '排行榜' });
  expect(screen.queryByRole('status')).toBeNull();
});

it('模块仍在加载时持续显示提示，直到榜单实际准备好', async () => {
  let finish!: () => void;
  modal.suspended = true;
  modal.wait = new Promise<void>(resolve => { finish = resolve; });
  const view = setup();
  view.open(); paint(); paint();
  await waitFor(() => expect(modal.attempted).toHaveBeenCalled());
  expect(screen.getByRole('dialog', { name: '正在打开排行榜' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: '排行榜' })).toBeNull();
  await act(async () => { modal.suspended = false; finish(); });
  await screen.findByRole('dialog', { name: '排行榜' });
  expect(screen.queryByRole('status')).toBeNull();
});

it('开始前取消或离开页面会撤销待执行的计算，不会延迟弹出排行榜', () => {
  const view = setup();
  view.open(); paint();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(frames.size).toBe(0);
  paint();
  expect(modal.attempted).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
  view.open(); paint();
  view.unmount();
  expect(frames.size).toBe(0);
  paint();
  expect(modal.attempted).not.toHaveBeenCalled();
});

it('加载期间取消后，模块完成也不会重新打开窗口', async () => {
  let finish!: () => void;
  modal.suspended = true;
  modal.wait = new Promise<void>(resolve => { finish = resolve; });
  const view = setup();
  view.open(); paint(); paint();
  await waitFor(() => expect(modal.attempted).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await act(async () => { modal.suspended = false; finish(); });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('准备失败会结束等待并显示失败提示，可以关闭后再次打开', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const expectedError = (event: ErrorEvent) => { if (event.message.includes('测试加载失败')) event.preventDefault(); };
  window.addEventListener('error', expectedError);
  try {
    modal.fail = true;
    const view = setup();
    view.open(); paint(); paint();
    await screen.findByRole('dialog', { name: '排行榜打开失败' });
    expect(screen.queryByText('正在打开排行榜…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    modal.fail = false;
    view.open(); paint(); paint();
    await screen.findByRole('dialog', { name: '排行榜' });
  } finally { window.removeEventListener('error', expectedError); }
});

it('only requests global rows on opening, keeps them during synchronization and ignores superseded replies', async () => {
  type Rows = NonNullable<LeaderboardModalProps['globalRows']>;
  const requests: ((rows: Rows) => void)[] = [];
  const leaderboard = vi.fn(() => new Promise<Rows>(resolve => { requests.push(resolve); }));
  const catalog = { leaderboard, prioritize: vi.fn() } as unknown as CatalogClient;
  const ref = createRef<LeaderboardHandle>();
  const renderBoard = (version: number) => <LeaderboardController ref={ref} catalog={catalog} catalogVersion={version}
    messages={[]} edges={[]} relations={[]} users={[]} stakeCounts={{}} messageBettorCounts={{}} onRefresh={vi.fn()} />;
  const view = render(renderBoard(1));
  expect(leaderboard).not.toHaveBeenCalled();
  act(() => ref.current!.open()); paint(); paint();
  expect(leaderboard).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog', { name: '排行榜' })).toBeNull();
  const first: Rows = { userRows: [], messageRows: [] };
  await act(async () => requests[0](first));
  await screen.findByRole('dialog', { name: '排行榜' });
  expect(modal.received).toHaveBeenLastCalledWith(first);
  view.rerender(renderBoard(2));
  expect(leaderboard).toHaveBeenCalledTimes(2);
  expect(modal.received).toHaveBeenLastCalledWith(first);
  view.rerender(renderBoard(3));
  const latest: Rows = { userRows: [], messageRows: [] };
  await act(async () => requests[2](latest));
  await act(async () => requests[1]({ userRows: [], messageRows: [] }));
  expect(modal.received.mock.lastCall![0]).toBe(latest);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  view.rerender(renderBoard(4));
  expect(leaderboard).toHaveBeenCalledTimes(3);
});

it('ignores an unfinished statistics reply after cancellation and retries a failed request on reopen', async () => {
  let finish!: (rows: NonNullable<LeaderboardModalProps['globalRows']>) => void;
  const leaderboard = vi.fn(() => new Promise<NonNullable<LeaderboardModalProps['globalRows']>>(resolve => { finish = resolve; }));
  const catalog = { leaderboard, prioritize: vi.fn() } as unknown as CatalogClient;
  const ref = createRef<LeaderboardHandle>();
  render(<LeaderboardController ref={ref} catalog={catalog} messages={[]} edges={[]} relations={[]} users={[]}
    stakeCounts={{}} messageBettorCounts={{}} onRefresh={vi.fn()} />);
  act(() => ref.current!.open()); paint(); paint();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await act(async () => finish({ userRows: [], messageRows: [] }));
  expect(screen.queryByRole('dialog')).toBeNull();
  leaderboard.mockRejectedValueOnce(new Error('worker unavailable'));
  act(() => ref.current!.open()); paint(); paint();
  await screen.findByRole('dialog', { name: '排行榜打开失败' });
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  act(() => ref.current!.open()); paint(); paint();
  await act(async () => finish({ userRows: [], messageRows: [] }));
  await screen.findByRole('dialog', { name: '排行榜' });
});
