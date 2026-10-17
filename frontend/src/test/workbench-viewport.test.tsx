import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useWorkbenchViewport } from '../pages/workbench/useWorkbenchViewport';

const originalResizeObserver = window.ResizeObserver;
afterEach(() => { window.ResizeObserver = originalResizeObserver; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('does not show the fixed horizontal scrollbar on a narrow mobile viewport', async () => {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
    matches: query.includes('max-width: 768px'), media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 500, 400));
  function Viewport() {
    const viewport = useWorkbenchViewport({ comparisonReviewed: false, viewMode: 'graph', loading: false });
    return <><div ref={viewport.leftPanelRef} /><span data-testid="fixed-scroll">{viewport.fixedHorizontalScroll ? 'shown' : 'hidden'}</span></>;
  }
  render(<Viewport />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(screen.getByTestId('fixed-scroll')).toHaveTextContent('hidden');
});

it('does not redraw the workbench for unchanged scroll and DOM measurements', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 500, 400));
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(800);
  let renders = 0;
  function Viewport() {
    renders++;
    const viewport = useWorkbenchViewport({ comparisonReviewed: false, viewMode: 'graph', loading: false });
    return <div ref={viewport.leftPanelRef} data-testid="left" />;
  }

  render(<Viewport />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(renders).toBeGreaterThan(1);
  const stableRenders = renders;
  act(() => {
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    screen.getByTestId('left').append(document.createElement('span'));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(renders).toBe(stableRenders);
});
