import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PARTICIPATION_AGREEMENT_PATH, PARTICIPATION_AGREEMENT_VERSION } from '@gonglun/core';
import { ApiError } from '../api/client';
import RegisterPage from '../pages/RegisterPage';
import LoginPage from '../pages/LoginPage';

const { login, register } = vi.hoisted(() => ({ login: vi.fn(), register: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ login, register }) }));
beforeEach(() => { vi.resetAllMocks(); });

function fill(username: string, password: string) {
  fireEvent.change(screen.getByLabelText('与会者名'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: password } });
}
const required = () => new ApiError('请阅读并确认当前版本的《公论参与协议》', {status:428,code:'AGREEMENT_REQUIRED',path:'/login'});

it.each(['1','密码'.repeat(100)])('requires explicit registration consent with a versioned document', async password => {
  render(<MemoryRouter><RegisterPage /></MemoryRouter>);
  expect(screen.queryByLabelText('邀请码')).toBeNull();
  expect(screen.queryByLabelText('初始发起人密钥')).toBeNull();
  fill('newuser', password);
  const submit=screen.getByRole('button',{name:'注册账户'});
  expect(submit).toBeDisabled();
  expect(screen.getByRole('link',{name:'《公论参与协议》'})).toHaveAttribute('href',PARTICIPATION_AGREEMENT_PATH);
  const consent=screen.getByRole('checkbox',{name:/我已阅读并同意.*公论参与协议/});
  expect(consent).not.toBeChecked();
  fireEvent.submit(submit.closest('form')!);
  expect(register).not.toHaveBeenCalled();
  fireEvent.click(consent);
  fireEvent.click(submit);
  await waitFor(() => expect(register).toHaveBeenCalledWith('newuser',password,PARTICIPATION_AGREEMENT_VERSION));
});

it('asks for consent on login only after valid credentials need a new agreement', async () => {
  const success=vi.fn();
  login.mockRejectedValueOnce(new ApiError('用户名或密码错误',{status:401,path:'/login'})).mockRejectedValueOnce(required()).mockResolvedValueOnce(undefined);
  render(<MemoryRouter><LoginPage onSuccess={success} /></MemoryRouter>);
  const submit=screen.getByRole('button',{name:'登录'});
  fill('olduser','wrong'); fireEvent.click(submit);
  expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码错误');
  expect(screen.queryByRole('checkbox')).toBeNull();
  fill('olduser','correct'); fireEvent.click(submit);
  const consent=await screen.findByRole('checkbox');
  expect(login).toHaveBeenLastCalledWith('olduser','correct',undefined);
  expect(consent).not.toBeChecked();
  expect(submit).toBeDisabled();
  expect(success).not.toHaveBeenCalled();
  fireEvent.click(consent); fireEvent.click(submit);
  await waitFor(() => expect(success).toHaveBeenCalledOnce());
  expect(login).toHaveBeenLastCalledWith('olduser','correct',PARTICIPATION_AGREEMENT_VERSION);
});

it('resets consent if the server has published a newer registration agreement', async () => {
  register.mockRejectedValueOnce(new ApiError('协议已更新',{status:428,code:'AGREEMENT_REQUIRED',path:'/register'}));
  render(<MemoryRouter><RegisterPage /></MemoryRouter>);
  fill('newuser','password');
  const consent=screen.getByRole('checkbox');
  const submit=screen.getByRole('button',{name:'注册账户'});
  fireEvent.click(consent); fireEvent.click(submit);
  expect(await screen.findByRole('alert')).toHaveTextContent('参与协议版本已更新');
  expect(consent).not.toBeChecked();
  expect(submit).toBeDisabled();
});

it('does not carry a previous account’s consent to another user', async () => {
  login.mockRejectedValueOnce(required()).mockResolvedValueOnce(undefined);
  const success=vi.fn();
  render(<MemoryRouter><LoginPage onSuccess={success} /></MemoryRouter>);
  fill('olduser','password'); fireEvent.click(screen.getByRole('button',{name:'登录'}));
  fireEvent.click(await screen.findByRole('checkbox'));
  fill('member','password');
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'登录'}));
  await waitFor(() => expect(success).toHaveBeenCalledOnce());
  expect(login).toHaveBeenLastCalledWith('member','password',undefined);
});
