import type { ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../App';

const { mounted } = vi.hoisted(() => ({ mounted: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ AuthProvider: ({ children }: { children: ReactNode }) => children, useOptionalAuth: () => null }));
vi.mock('../components/Navbar', () => ({ default: () => <nav /> }));
vi.mock('../components/GestureShortcutManager', () => ({ default: () => null }));
vi.mock('../pages/MessageWorkbenchPage', () => ({ default: function Workbench() {
  mounted();
  return <textarea aria-label="消息输入" />;
} }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it.each(['/messages', '/messages/classification', '/viewer'])('shows a modal when refreshing %s before the heavy route starts mounting', async path => {
  vi.useFakeTimers();
  window.history.replaceState(null, '', path);
  render(<App />);
  expect(screen.getByRole('dialog', { name: '正在加载' })).toBeVisible();
  await act(async () => { vi.advanceTimersByTime(16); });
  expect(mounted).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(16); });
  expect(screen.getByLabelText('消息输入')).toBeVisible();
});
