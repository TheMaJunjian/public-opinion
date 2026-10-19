import { act, cleanup, render, screen } from '@testing-library/react';
import { lazy, StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WorkbenchStartup from '../components/WorkbenchStartup';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const paint = async () => { await act(async () => { vi.advanceTimersByTime(16); }); };

it('paints a loading dialog before importing or rendering the workbench, including cached modules', async () => {
  const renderWorkbench = vi.fn(() => {
    expect(screen.getByRole('dialog', { name: '正在加载' })).toBeVisible();
    return <textarea aria-label="消息输入" />;
  });
  const load = vi.fn(async () => ({ default: renderWorkbench }));
  const Workbench = lazy(load);
  render(<WorkbenchStartup><Workbench /></WorkbenchStartup>);
  expect(screen.getByRole('dialog', { name: '正在加载' })).toBeVisible();
  expect(load).not.toHaveBeenCalled();
  await paint();
  expect(load).not.toHaveBeenCalled();
  await paint();
  expect(load).toHaveBeenCalledOnce();
  expect(renderWorkbench).toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByLabelText('消息输入')).toBeVisible();
});

it('keeps the same visible prompt while a cold module download remains pending', async () => {
  let finish!: (module: { default: () => React.JSX.Element }) => void;
  const pending = new Promise<{ default: () => React.JSX.Element }>(resolve => { finish = resolve; });
  const Workbench = lazy(() => pending);
  render(<WorkbenchStartup><Workbench /></WorkbenchStartup>);
  await paint(); await paint();
  expect(screen.getByRole('dialog', { name: '正在加载' })).toBeVisible();
  await act(async () => { finish({ default: () => <div>工作台已加载</div> }); await pending; });
  expect(screen.getByText('工作台已加载')).toBeVisible();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('cancels both startup frames when leaving the page before it loads', async () => {
  const load = vi.fn(async () => ({ default: () => <div>工作台</div> }));
  const Workbench = lazy(load);
  const view = render(<WorkbenchStartup><Workbench /></WorkbenchStartup>);
  await paint();
  view.unmount();
  await paint();
  expect(load).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('still waits for a paint after StrictMode cancels its first effect', async () => {
  const load = vi.fn(async () => ({ default: () => <div>工作台</div> }));
  const Workbench = lazy(load);
  render(<StrictMode><WorkbenchStartup><Workbench /></WorkbenchStartup></StrictMode>);
  await paint();
  expect(load).not.toHaveBeenCalled();
  await paint();
  expect(load).toHaveBeenCalledOnce();
  expect(screen.getByText('工作台')).toBeVisible();
});
