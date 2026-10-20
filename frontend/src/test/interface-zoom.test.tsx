import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  const viewport = useWorkbenchViewport({ comparisonReviewed: false, viewMode: 'graph', loading: false });
  return <div data-testid="workbench" style={{ width: viewport.effectiveContainerWidth }} />;
} }));

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

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
