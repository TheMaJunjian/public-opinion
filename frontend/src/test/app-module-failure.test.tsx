import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../App';

vi.mock('../context/AuthContext', () => ({ AuthProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('../components/AppUpdateNotice', () => ({ default: () => <aside>版本检测仍在运行</aside> }));
vi.mock('../components/Navbar', () => ({ default: () => <nav /> }));
vi.mock('../components/GestureShortcutManager', () => ({ default: () => null }));
vi.mock('../pages/MessageWorkbenchPage', () => ({ default: function UnavailableWorkbench(): never {
  throw new Error('Failed to fetch dynamically imported module');
} }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('keeps the version notice mounted when a stale deployment module fails to load', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const expectedError = (event: ErrorEvent) => { if (event.message.includes('Failed to fetch dynamically imported module')) event.preventDefault(); };
  window.addEventListener('error', expectedError);
  window.history.replaceState(null, '', '/messages');
  try {
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('页面加载失败');
    expect(screen.getByText('版本检测仍在运行')).toBeVisible();
    expect(screen.getByRole('button', { name: '刷新页面' })).toBeEnabled();
  } finally { window.removeEventListener('error', expectedError); }
});
