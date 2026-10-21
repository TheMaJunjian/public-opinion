import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import LoginPage from '../pages/LoginPage';

const login = vi.hoisted(() => vi.fn());
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ login }) }));
beforeEach(() => { login.mockReset(); });

function renderLogin(reason?: string) {
  return render(<MemoryRouter initialEntries={[{ pathname: '/login', state: { reason } }]}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<p>工作区</p>} />
      <Route path="/register" element={<p>注册账户</p>} />
    </Routes>
  </MemoryRouter>);
}

it('shows the login reason in the shared prompt and validates empty credentials', () => {
  renderLogin('发送消息需要登录');
  const dialog = screen.getByRole('dialog', { name: '请先登录' });
  expect(dialog.closest('[data-prompt-modal]')).not.toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('发送消息需要登录');
  expect(screen.queryByRole('button', { name: /收起/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(screen.getByRole('alert')).toHaveTextContent('请填写与会者名和密码');
  expect(login).not.toHaveBeenCalled();
});

it('disables submission while signing in and returns to the workspace after success', async () => {
  let complete!: () => void;
  login.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
  renderLogin();
  fireEvent.change(screen.getByLabelText('与会者名'), { target: { value: '  与会者  ' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password' } });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(login).toHaveBeenCalledExactlyOnceWith('与会者', 'password');
  expect(screen.getByRole('button', { name: '登录中…' })).toBeDisabled();
  await act(async () => { complete(); });
  expect(screen.getByText('工作区')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps login errors visible and preserves navigation to registration', async () => {
  login.mockRejectedValue(new Error('与会者名或密码错误'));
  renderLogin();
  fireEvent.change(screen.getByLabelText('与会者名'), { target: { value: '与会者' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '登录' })); });
  expect(screen.getByRole('alert')).toHaveTextContent('与会者名或密码错误');
  expect(screen.getByRole('button', { name: '登录' })).toBeEnabled();
  fireEvent.click(screen.getByRole('link', { name: '立即注册' }));
  expect(screen.getByText('注册账户')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).toBeNull();
});
