import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import RegisterPage from '../pages/RegisterPage';

const { getSetup } = vi.hoisted(() => ({ getSetup: vi.fn() }));
vi.mock('../api/client', () => ({ getSetup, storePrivateKeyForUser: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ register: vi.fn() }) }));
beforeEach(() => { vi.clearAllMocks(); });

describe('initial founder registration', () => {
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
