import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBrowsingHistory } from '../pages/workbench/useBrowsingHistory';

function Workbench({ owner = 'online', browser = true }: { owner?: string; browser?: boolean }) {
  const [view, setView] = useState('主页');
  const [mode, setMode] = useState('图');
  const [filter, setFilter] = useState('全部');
  // Snapshots intentionally include a function: browser state must contain IDs, not snapshots.
  const history = useBrowsingHistory(owner, () => ({ view, mode, filter, restoreScope() {} }), snapshot => {
    setView(snapshot.view); setMode(snapshot.mode); setFilter(snapshot.filter);
  }, { browser });
  const go = (next: string) => { history.record(); setView(next); };
  return <>
    <output aria-label="浏览位置">{view}</output>
    <output aria-label="视图">{mode}</output>
    <output aria-label="筛选">{filter}</output>
    <textarea aria-label="未发送内容" />
    <button onClick={() => go('分类 A')}>进入 A</button>
    <button onClick={() => go('分类 B')}>进入 B</button>
    <button onClick={() => go('分类 C')}>进入 C</button>
    <button onClick={() => go('分类 A')}>退出 B</button>
    <button onClick={() => setMode(mode === '图' ? '表' : '图')}>切换视图</button>
    <button onClick={() => setFilter('未阅')}>筛选未阅</button>
    <button disabled={!history.canGoBack} onClick={history.back}>返回</button>
    <button disabled={!history.canGoForward} onClick={history.forward}>前进</button>
    <button onClick={() => { history.record(); history.record(); setView('分类 B'); }}>一次跳转</button>
  </>;
}

beforeEach(() => window.history.replaceState({ usr: { viewerCacheRef: 'local-file' }, key: 'same-workbench', idx: 4 }, '', '/messages?view=graph'));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function traverse(delta: number) {
  await act(async () => {
    const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }));
    window.history.go(delta);
    await popped;
  });
}

it('浏览器和站内按钮共用分类浏览记录，保留草稿及原路由状态', async () => {
  const routeState = window.history.state;
  const address = window.location.href;
  render(<Workbench />);
  const draft = screen.getByRole('textbox', { name: '未发送内容' });
  fireEvent.change(draft, { target: { value: '继续编辑的草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '进入 A' }));
  fireEvent.click(screen.getByRole('button', { name: '切换视图' }));
  fireEvent.click(screen.getByRole('button', { name: '筛选未阅' }));
  fireEvent.click(screen.getByRole('button', { name: '进入 B' }));
  expect(window.history.state).not.toEqual(routeState);
  await traverse(-1);
  expect(screen.getByLabelText('浏览位置')).toHaveTextContent('分类 A');
  expect(screen.getByLabelText('视图')).toHaveTextContent('表');
  expect(screen.getByLabelText('筛选')).toHaveTextContent('未阅');
  fireEvent.click(screen.getByRole('button', { name: '返回' }));
  await waitFor(() => expect(screen.getByLabelText('浏览位置')).toHaveTextContent('主页'));
  expect(screen.getByLabelText('视图')).toHaveTextContent('图');
  await traverse(1);
  expect(screen.getByLabelText('浏览位置')).toHaveTextContent('分类 A');
  fireEvent.click(screen.getByRole('button', { name: '前进' }));
  await waitFor(() => expect(screen.getByLabelText('浏览位置')).toHaveTextContent('分类 B'));
  expect(screen.getByRole('textbox', { name: '未发送内容' })).toBe(draft);
  expect(draft).toHaveValue('继续编辑的草稿');
  expect(window.history.state).toMatchObject(routeState);
  expect(window.location.href).toBe(address);
});

it('待浏览器回退完成前选择另一分类时，保留最新选择并建立新分支', async () => {
  render(<Workbench />);
  fireEvent.click(screen.getByRole('button', { name: '进入 A' }));
  fireEvent.click(screen.getByRole('button', { name: '进入 B' }));
  fireEvent.click(screen.getByRole('button', { name: '返回' }));
  fireEvent.click(screen.getByRole('button', { name: '进入 C' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '返回' })).toBeEnabled());
  expect(screen.getByLabelText('浏览位置')).toHaveTextContent('分类 C');
  expect(screen.getByRole('button', { name: '前进' })).toBeDisabled();
  await traverse(-1);
  expect(screen.getByLabelText('浏览位置')).toHaveTextContent('分类 A');
  await traverse(1);
  expect(screen.getByLabelText('浏览位置')).toHaveTextContent('分类 C');
});

it('浏览记录之外的正常网页回退与前进仍由浏览器处理', async () => {
  window.history.replaceState(null, '', '/login');
  window.history.pushState({ key: 'workbench', idx: 1 }, '', '/messages');
  render(<Workbench />);
  fireEvent.click(screen.getByRole('button', { name: '进入 A' }));
  fireEvent.click(screen.getByRole('button', { name: '进入 B' }));
  await traverse(-2);
  expect(screen.getByLabelText('浏览位置')).toHaveTextContent('主页');
  await traverse(-1);
  expect(window.location.pathname).toBe('/login');
  await traverse(1);
  expect(window.location.pathname).toBe('/messages');
  await traverse(2);
  expect(screen.getByLabelText('浏览位置')).toHaveTextContent('分类 B');
});

it('阅读面板自身的记录保持独立，不额外写入浏览器历史', () => {
  const push = vi.spyOn(window.history, 'pushState');
  const replace = vi.spyOn(window.history, 'replaceState');
  render(<Workbench browser={false} />);
  fireEvent.click(screen.getByRole('button', { name: '进入 A' }));
  fireEvent.click(screen.getByRole('button', { name: '返回' }));
  expect(screen.getByLabelText('浏览位置')).toHaveTextContent('主页');
  expect(push).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

it('路由清理链接参数后，仍可回退到被替换过的浏览位置', async () => {
  render(<Workbench />);
  fireEvent.click(screen.getByRole('button', { name: '进入 A' }));
  window.history.replaceState({ usr: { viewerCacheRef: 'same-file' }, key: 'same-workbench', idx: 4 }, '', '/messages');
  fireEvent.click(screen.getByRole('button', { name: '进入 B' }));
  await traverse(-1);
  expect(screen.getByLabelText('浏览位置')).toHaveTextContent('分类 A');
  expect(window.history.state.usr).toEqual({ viewerCacheRef: 'same-file' });
  await traverse(1);
  expect(screen.getByLabelText('浏览位置')).toHaveTextContent('分类 B');
});

it('退出分类也是一次浏览，回退后选择新分支会清除旧的前进记录', async () => {
  render(<Workbench />);
  fireEvent.click(screen.getByRole('button', { name: '进入 A' }));
  fireEvent.click(screen.getByRole('button', { name: '进入 B' }));
  fireEvent.click(screen.getByRole('button', { name: '退出 B' }));
  await traverse(-1);
  expect(screen.getByLabelText('浏览位置')).toHaveTextContent('分类 B');
  await traverse(-1);
  fireEvent.click(screen.getByRole('button', { name: '一次跳转' }));
  expect(screen.getByRole('button', { name: '前进' })).toBeDisabled();
  await traverse(-1);
  expect(screen.getByLabelText('浏览位置')).toHaveTextContent('分类 A');
  await traverse(1);
  expect(screen.getByLabelText('浏览位置')).toHaveTextContent('分类 B');
});
