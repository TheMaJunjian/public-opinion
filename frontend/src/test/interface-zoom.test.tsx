import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../App';
import { useWorkbenchViewport } from '../pages/workbench/useWorkbenchViewport';

vi.mock('../context/AuthContext', () => ({ AuthProvider: ({ children }: { children: ReactNode }) => children, useOptionalAuth: () => null }));
vi.mock('../components/Navbar', () => ({ default: () => <nav /> }));
vi.mock('../components/GestureShortcutManager', () => ({
  default: ({ onConfirm }: { onConfirm: (direction: string, target: null, symbol: string) => void }) => <>
    <button onClick={() => onConfirm('left', null, 'zoom-out')}>缩小界面</button>
    <button onClick={() => onConfirm('right', null, 'zoom-in')}>放大界面</button>
  </>,
}));
vi.mock('../pages/MessageWorkbenchPage', () => ({ default: function Workbench() {
  const viewport = useWorkbenchViewport({ loading: false });
  return <div data-testid="workbench" style={{ width: viewport.effectiveContainerWidth }} />;
} }));

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('updates the mounted workbench after shortcut zoom and restores its width without a reload', async () => {
  localStorage.clear();
  window.history.replaceState(null, '', '/messages');
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280);
  render(<App />);
  const workbench = await screen.findByTestId('workbench');
  const app = document.querySelector('nav')!.parentElement!;
  expect(workbench.style.width).toBe('1280px');
  for (const zoom of [0.9, 0.8, 0.7]) {
    fireEvent.click(screen.getByRole('button', { name: '缩小界面' }));
    expect(app.style.transform).toBe(`scale(${zoom})`);
    expect(parseFloat(workbench.style.width) * zoom).toBeCloseTo(1280);
    expect(localStorage.getItem('workbenchWidth')).toBe('1280');
  }
  for (let step = 0; step < 3; step++) fireEvent.click(screen.getByRole('button', { name: '放大界面' }));
  expect(app.style.transform).toBe('none');
  expect(workbench.style.width).toBe('1280px');
  expect(screen.getByTestId('workbench')).toBe(workbench);
});

it('fits a fractional browser viewport without a redundant page scrollbar, including a previously rounded saved width', async () => {
  localStorage.setItem('workbenchWidth', '1280');
  window.history.replaceState(null, '', '/messages');
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280);
  vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1279.6, 800));
  render(<App />);
  const workbench = await screen.findByTestId('workbench');
  expect(parseFloat(workbench.style.width)).toBeCloseTo(1279.6);
  fireEvent.click(screen.getByRole('button', { name: '缩小界面' }));
  expect(parseFloat(workbench.style.width) * 0.9).toBeCloseTo(1279.6);
  fireEvent.click(screen.getByRole('button', { name: '放大界面' }));
  expect(parseFloat(workbench.style.width)).toBeCloseTo(1279.6);
});

it('does not round the available height up when a horizontal scrollbar reduces the viewport', async () => {
  window.history.replaceState(null, '', '/messages');
  const visual = Object.assign(new EventTarget(), { height: 890.666687, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', visual);
  const layoutHeight = vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(891);
  render(<App />);
  await screen.findByTestId('workbench');
  const app = document.querySelector<HTMLElement>('.app-shell')!;
  expect(parseFloat(app.style.minHeight)).toBeCloseTo(visual.height);
  fireEvent.click(screen.getByRole('button', { name: '缩小界面' }));
  expect(parseFloat(app.style.minHeight) * 0.9).toBeCloseTo(visual.height);
  fireEvent.click(screen.getByRole('button', { name: '放大界面' }));
  // Keep the layout fallback when a keyboard or pinch zoom reduces only the
  // visual viewport. This must not impose any height limit on page content.
  visual.height = 420;
  act(() => { visual.dispatchEvent(new Event('resize')); });
  expect(app.style.minHeight).toBe('891px');
  expect(app.style.height).toBe('');
  expect(app.style.maxHeight).toBe('');
  layoutHeight.mockReturnValue(881);
  visual.height = 880.8;
  act(() => { visual.dispatchEvent(new Event('resize')); });
  expect(parseFloat(app.style.minHeight)).toBeCloseTo(880.8);
  visual.height = 1500.3;
  act(() => { visual.dispatchEvent(new Event('resize')); });
  expect(parseFloat(app.style.minHeight)).toBeCloseTo(1500.3);
});
