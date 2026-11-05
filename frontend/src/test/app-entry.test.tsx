import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useLocation } from 'react-router-dom';
import App from '../App';

const { auth, login, register, getSetup, mounted } = vi.hoisted(() => ({
  auth: { user: null as null | { id: string; username: string; createdAt: string }, loading: false },
  login: vi.fn(), register: vi.fn(), getSetup: vi.fn(), mounted: vi.fn(),
}));
vi.mock('../context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ ...auth, login, register }), useOptionalAuth: () => null,
}));
vi.mock('../api/client', () => ({ getSetup, storePrivateKeyForUser: vi.fn() }));
vi.mock('../components/Navbar', () => ({ default: () => <nav /> }));
vi.mock('../components/AppUpdateNotice', () => ({ default: () => null }));
vi.mock('../components/OperationFeedback', () => ({ default: () => null }));
vi.mock('../components/GestureShortcutManager', () => ({ default: () => null }));
vi.mock('../pages/MessageWorkbenchPage', () => ({ default: function Workbench() {
  mounted();const location = useLocation();
  return <div data-testid="workbench-route">{location.pathname}{location.search}</div>;
} }));

const user = { id: 'user', username: '与会者', createdAt: '' };

it.each([false, true])('从首页介绍进入消息后，浏览器后退恢复介绍而非登录窗口（生产模式：%s）', async production => {
  vi.stubEnv('PROD', production);
  window.history.replaceState(null, '', production ? '/#/' : '/');
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '关闭并浏览' }));
  fireEvent.click(await screen.findByRole('link', { name: '了解公论' }));
  const frame = screen.getByTitle('公论介绍与文档') as HTMLIFrameElement;
  const doc = frame.contentDocument!;
  doc.open(); doc.write('<a href="/#/messages">参与共建</a>'); doc.close();
  frame.contentWindow!.scrollTo = vi.fn();
  fireEvent.load(frame);
  fireEvent.click(doc.querySelector('a')!);
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull());
  expect(production ? window.location.hash : window.location.pathname).toBe(production ? '#/messages' : '/messages');
  const traverse = async (delta: number) => {
    await act(async () => {
      const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }));
      window.history.go(delta); await popped;
    });
  };
  await traverse(-1);
  expect(screen.getByRole('dialog', { name: '公论介绍' })).toBeVisible();
  expect(screen.queryByRole('dialog', { name: '登录公论' })).toBeNull();
  expect(screen.getByTitle('公论介绍与文档')).toBe(frame);
  await traverse(1);
  expect(screen.queryByRole('dialog', { name: '公论介绍' })).toBeNull();
  await traverse(-1); await traverse(-1);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('heading', { name: '公论' })).toBeVisible();
});
beforeEach(() => {
  vi.clearAllMocks();auth.user = null;auth.loading = false;
  getSetup.mockResolvedValue({ initialized: true, founderKeyRequired: false });
  window.history.replaceState(null, '', '/');
});
afterEach(() => { cleanup();vi.unstubAllEnvs();vi.restoreAllMocks(); });

it('首次访问先显示登录注册入口，关闭后才显示访客页', async () => {
  render(<App />);
  expect(await screen.findByRole('dialog', { name: '登录公论' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '公论' })).toBeNull();
  expect(mounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '关闭并浏览' }));
  expect(await screen.findByRole('heading', { name: '公论' })).toBeVisible();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('登录和注册在同一地址切换，按Escape后显示访客页，不循环要求登录', async () => {
  window.history.replaceState(null, '', '/messages/shared-message?view=graph');
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '立即注册' }));
  expect(await screen.findByRole('dialog', { name: '注册公论' })).toBeVisible();
  expect(window.location.pathname).toBe('/messages/shared-message');
  fireEvent.click(screen.getByRole('button', { name: '立即登录' }));
  expect(await screen.findByRole('dialog', { name: '登录公论' })).toBeVisible();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(await screen.findByRole('heading', { name: '公论' })).toBeVisible();
  expect(window.location.search).toBe('?view=graph');
  expect(mounted).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('登录成功继续打开原来的消息链接，不跳回首页', async () => {
  window.history.replaceState(null, '', '/messages/shared-message?view=graph');
  login.mockImplementation(async () => { auth.user = user; });
  render(<App />);
  await screen.findByRole('dialog', { name: '登录公论' });
  fireEvent.change(screen.getByLabelText('与会者名'), { target: { value: '与会者' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password' } });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByTestId('workbench-route')).toHaveTextContent('/messages/shared-message?view=graph');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('先确认会话再决定是否展示登录窗口，已有会话时直接打开页面', async () => {
  auth.loading = true;
  window.history.replaceState(null, '', '/messages');
  const view = render(<App />);
  expect(screen.getByRole('dialog', { name: '正在加载' })).toBeVisible();
  expect(mounted).not.toHaveBeenCalled();
  auth.loading = false;auth.user = user;view.rerender(<App />);
  expect(await screen.findByTestId('workbench-route')).toHaveTextContent('/messages');
  expect(screen.queryByRole('dialog', { name: '登录公论' })).toBeNull();
});

it('关闭直接打开的登录页后不会再次弹出首次访问窗口', async () => {
  window.history.replaceState(null, '', '/login');
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '返回首页' }));
  expect(await screen.findByRole('heading', { name: '公论' })).toBeVisible();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('本地阅览入口无需登录，也不等待在线会话确认', async () => {
  auth.loading = true;
  window.history.replaceState(null, '', '/viewer');
  render(<App />);
  expect(await screen.findByTestId('workbench-route')).toHaveTextContent('/viewer');
  expect(screen.queryByRole('dialog', { name: '登录公论' })).toBeNull();
});

it.each(['cmsrg29ky000h1hcqfec26kva', 'cmv4ln3s000k7md14vijeu209'])('旧话题哈希链接%s显示作废提示，可刷新或回首页', async id => {
  vi.stubEnv('PROD', true);auth.user = user;
  window.history.replaceState(null, '', `/#/topics/${id}`);
  render(<App />);
  expect(await screen.findByRole('dialog', { name: '旧话题链接已作废' })).toHaveTextContent('该页面已停止使用');
  expect(screen.getByRole('button', { name: '刷新页面' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '回首页' }));
  expect(await screen.findByTestId('workbench-route')).toHaveTextContent('/messages');
  expect(window.location.hash).toBe('#/messages');
});

it('未登录打开旧话题时先登录提示，关闭后显示作废提示，回首页后不再弹登录', async () => {
  vi.stubEnv('PROD', true);
  window.history.replaceState(null, '', '/#/topics/cmsrg29ky000h1hcqfec26kva');
  render(<App />);
  expect(await screen.findByRole('dialog', { name: '登录公论' })).toBeVisible();
  expect(screen.queryByRole('dialog', { name: '旧话题链接已作废' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '关闭并浏览' }));
  expect(await screen.findByRole('dialog', { name: '旧话题链接已作废' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '回首页' }));
  expect(await screen.findByRole('heading', { name: '公论' })).toBeVisible();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('未知地址也有刷新和回首页入口，避免空白页面', async () => {
  auth.user = user;
  window.history.replaceState(null, '', '/removed-address');
  render(<App />);
  expect(await screen.findByRole('dialog', { name: '链接无法打开' })).toHaveTextContent('该地址不存在或已经失效');
  expect(screen.getByRole('button', { name: '刷新页面' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '回首页' })).toBeEnabled();
});

it('关闭失效提示会回到首页，点击遮罩不会误触刷新', async () => {
  window.history.replaceState(null, '', '/topics/expired');
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '关闭并浏览' }));
  const dialog = await screen.findByRole('dialog', { name: '旧话题链接已作废' });
  fireEvent.click(dialog.closest('[data-popup-overlay]')!);
  expect(await screen.findByRole('heading', { name: '公论' })).toBeVisible();
  expect(window.location.pathname).toBe('/');
  expect(screen.queryByRole('dialog')).toBeNull();
});
