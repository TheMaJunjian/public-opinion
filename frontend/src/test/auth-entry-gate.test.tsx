import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import AuthEntryGate from '../components/AuthEntryGate';
import TutorialModal from '../components/TutorialModal';
import WelfareModal from '../components/WelfareModal';
import LoginPage from '../pages/LoginPage';

const { auth, login } = vi.hoisted(() => ({
  auth: { user: null, loading: false }, login: vi.fn(),
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ ...auth, login, register: vi.fn() }) }));
vi.mock('../api/client', () => ({
  getSetup: vi.fn(async () => ({ initialized: true, founderKeyRequired: false })),
  storePrivateKeyForUser: vi.fn(),
}));

function Entry({ tutorial = false, welfare = false }: { tutorial?: boolean; welfare?: boolean }) {
  return <MemoryRouter>
    <AuthEntryGate><p>访客内容</p></AuthEntryGate>
    <TutorialModal open={tutorial} onClose={() => undefined} />
    <WelfareModal open={welfare} onClose={() => undefined} />
  </MemoryRouter>;
}

beforeEach(() => { auth.loading = false; vi.clearAllMocks(); });
afterEach(cleanup);

it.each(['tutorial', 'welfare'] as const)('会话加载结束后，自动登录等待已打开的%s窗口关闭', async kind => {
  auth.loading = true;
  const view = render(<Entry {...{ [kind]: true }} />);
  const label = kind === 'tutorial' ? '教程' : '福利';
  expect(screen.getByRole('dialog', { name: label })).toBeVisible();
  auth.loading = false;
  view.rerender(<Entry {...{ [kind]: true }} />);
  await waitFor(() => expect(document.querySelector('[data-auth-entry-modal="true"] [aria-label="登录公论"]')).not.toBeNull());
  expect(screen.queryByRole('dialog', { name: '登录公论' })).toBeNull();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  view.rerender(<Entry />);
  expect(await screen.findByRole('dialog', { name: '登录公论' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '关闭并浏览' }));
  expect(screen.getByText('访客内容')).toBeVisible();
});

it.each(['login', 'register'] as const)('自动%s暂隐并恢复时保留表单内容，Escape不会误关闭待显示的入口', async mode => {
  const view = render(<Entry />);
  await screen.findByRole('dialog', { name: '登录公论' });
  if (mode === 'register') fireEvent.click(screen.getByRole('button', { name: '立即注册' }));
  const label = mode === 'login' ? '登录公论' : '注册公论';
  await screen.findByRole('dialog', { name: label });
  fireEvent.change(screen.getByLabelText('与会者名'), { target: { value: '还未提交的账户' } });
  view.rerender(<Entry welfare />);
  await waitFor(() => expect(screen.queryByRole('dialog', { name: label })).toBeNull());
  expect(screen.getByRole('dialog', { name: '福利' })).toBeVisible();
  fireEvent.keyDown(window, { key: 'Escape' });
  view.rerender(<Entry />);
  expect(await screen.findByRole('dialog', { name: label })).toBeVisible();
  expect(screen.getByLabelText('与会者名')).toHaveValue('还未提交的账户');
});

it('显式登录路由和正常详情嵌套不受自动入口等待规则约束', async () => {
  render(<MemoryRouter initialEntries={['/login']}>
    <AuthEntryGate><LoginPage /></AuthEntryGate>
    <WelfareModal open onClose={() => undefined} />
  </MemoryRouter>);
  expect(await screen.findByRole('dialog', { name: '登录公论' })).toBeVisible();
  expect(screen.getByRole('dialog', { name: '福利' })).toBeVisible();
  expect(screen.getAllByRole('dialog')).toHaveLength(2);
});

it('已隐藏的保留窗口不会阻止自动登录', async () => {
  render(<MemoryRouter>
    <div style={{ display: 'none' }}><div role="dialog" aria-modal="true">已隐藏详情</div></div>
    <AuthEntryGate><p>访客内容</p></AuthEntryGate>
  </MemoryRouter>);
  expect(await screen.findByRole('dialog', { name: '登录公论' })).toBeVisible();
});
