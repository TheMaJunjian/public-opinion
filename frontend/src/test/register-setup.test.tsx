import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import RegisterPage from '../pages/RegisterPage';

const { getSetup, register } = vi.hoisted(() => ({ getSetup: vi.fn(), register: vi.fn() }));
vi.mock('../api/client', () => ({ getSetup, storePrivateKeyForUser: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ register }) }));
vi.mock('../utils/signature', () => ({ generateSigningKeyPair: vi.fn(async () => ({ privateKey: {}, publicKey: {} })) }));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('initial founder registration', () => {
  it.each([{ length: 1, password: '1' }, { length: 200, password: '密码'.repeat(100) }])('submits a $length character password without a length limit', async ({ password }) => {
    getSetup.mockResolvedValue({ initialized: true, founderKeyRequired: false });
    vi.stubGlobal('crypto', { subtle: { exportKey: vi.fn().mockResolvedValue({ kty: 'OKP', crv: 'Ed25519' }) } });
    render(<MemoryRouter><RegisterPage /></MemoryRouter>);
    await waitFor(() => expect(getSetup).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByPlaceholderText('2-30位字母、数字、下划线或汉字'), { target: { value: 'newuser' } });
    fireEvent.change(screen.getByPlaceholderText('请输入密码'), { target: { value: password } });
    fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: ' one-time-invite ' } });
    fireEvent.click(screen.getByRole('button', { name: '注册账户' }));
    await waitFor(() => expect(register).toHaveBeenCalledWith('newuser', password, expect.any(String), undefined, 'one-time-invite'));
  });

  it('asks for the founder key only when an uninitialized site requires it', async () => {
    getSetup.mockResolvedValue({ initialized: false, founderKeyRequired: true });
    render(<MemoryRouter><RegisterPage /></MemoryRouter>);
    expect(await screen.findByLabelText('初始发起人密钥')).toHaveAttribute('type', 'password');
    expect(screen.queryByLabelText('邀请码')).not.toBeInTheDocument();
  });
  it.each([
    { initialized: true, founderKeyRequired: true },
    { initialized: false, founderKeyRequired: false },
  ])('keeps normal registration unchanged for %j', async setup => {
    getSetup.mockResolvedValue(setup);
    render(<MemoryRouter><RegisterPage /></MemoryRouter>);
    await waitFor(() => expect(getSetup).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText('初始发起人密钥')).not.toBeInTheDocument();
  });

  it('requires an invitation for ordinary registration and displays server rejection', async () => {
    getSetup.mockResolvedValue({initialized:true,founderKeyRequired:false,inviteRequired:true});
    register.mockRejectedValueOnce(new Error('邀请码无效、已使用、已过期或已撤销'));
    vi.stubGlobal('crypto', {subtle:{exportKey:vi.fn().mockResolvedValue({kty:'OKP',crv:'Ed25519'})}});
    render(<MemoryRouter><RegisterPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button',{name:'注册账户'})).toBeEnabled());
    fireEvent.change(screen.getByLabelText('与会者名'),{target:{value:'invited'}});
    fireEvent.change(screen.getByLabelText('密码'),{target:{value:'password'}});
    fireEvent.click(screen.getByRole('button',{name:'注册账户'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写管理员提供的邀请码');
    expect(register).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('邀请码'),{target:{value:'expired'}});
    fireEvent.click(screen.getByRole('button',{name:'注册账户'}));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('已过期或已撤销'));
    expect(screen.getByLabelText('邀请码')).toHaveValue('expired');
  });

  it('does not submit when registration requirements cannot be loaded', async () => {
    getSetup.mockRejectedValue(new Error('无法确认站点初始化状态'));
    render(<MemoryRouter><RegisterPage /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('无法确认');
    expect(screen.getByRole('button',{name:'注册账户'})).toBeDisabled();
    expect(register).not.toHaveBeenCalled();
  });
});
