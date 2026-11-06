import { lazy, Suspense } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ErrorBoundary from '../components/ErrorBoundary';

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each([
  'Failed to fetch dynamically imported module: http://127.0.0.1:5173/src/components/MessageDisplayHints.tsx?t=1',
  'error loading dynamically imported module',
  'Importing a module script failed.',
])('provides an explicit page reload for a cached lazy import failure: %s', async message => {
  const load = vi.fn().mockRejectedValue(new TypeError(message));
  const Component = lazy(load), reload = vi.fn();
  render(<ErrorBoundary onReload={reload}><Suspense fallback="加载中"><Component /></Suspense></ErrorBoundary>);
  const button = await screen.findByRole('button', { name: '重新加载页面' });
  expect(screen.getByText('页面组件加载失败')).toBeInTheDocument();
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(reload).toHaveBeenCalledOnce();
  expect(load).toHaveBeenCalledOnce();
});

it('still retries ordinary render errors without reloading the page', () => {
  let failing = true;
  function Component() { if (failing) throw new Error('ordinary render failure'); return <div>已恢复</div>; }
  const reload = vi.fn();
  render(<ErrorBoundary onReload={reload}><Component /></ErrorBoundary>);
  expect(screen.getByText('渲染错误')).toBeInTheDocument();
  failing = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(screen.getByText('已恢复')).toBeInTheDocument();
  expect(reload).not.toHaveBeenCalled();
});
