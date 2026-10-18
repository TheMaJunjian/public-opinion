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
    fireEvent.click(screen.getByRole('button', { name: '注册账户' }));
    await waitFor(() => expect(register).toHaveBeenCalledWith('newuser', password, expect.any(String), undefined));
  });

  it('asks for the founder key only when an uninitialized site requires it', async () => {
    getSetup.mockResolvedValue({ initialized: false, founderKeyRequired: true });
    render(<MemoryRouter><RegisterPage /></MemoryRouter>);
    expect(await screen.findByLabelText('初始发起人密钥')).toHaveAttribute('type', 'password');
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
});
