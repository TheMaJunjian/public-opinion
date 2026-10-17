import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useWorkbenchViewport } from '../pages/workbench/useWorkbenchViewport';

const originalResizeObserver = window.ResizeObserver;
afterEach(() => { window.ResizeObserver = originalResizeObserver; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps the left canvas height stable while the naturally sized right panel uses page scrolling', () => {
  let pageScroll = 0;
  const observers: ResizeObserverCallback[] = [];
  window.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { observers.push(callback); }
    observe() {} unobserve() {} disconnect() {}
  };
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(700);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.dataset.testid === 'left' ? 200 - pageScroll
      : this.dataset.testid === 'right' ? Math.max(50, 120 - pageScroll) : 120 - pageScroll;
    return new DOMRect(0, top, 500, 500);
  });
  function Viewport() {
    const viewport = useWorkbenchViewport({ comparisonReviewed: false, viewMode: 'graph', loading: false });
    return <div ref={viewport.panelContainerRef}>
      <div style={{ paddingBottom: 8 }}><div ref={viewport.leftPanelRef} data-testid="left" style={{ height: viewport.leftPanelMinHeight }} /></div>
      <div ref={viewport.rightPanelRef} data-testid="right" />
    </div>;
  }
  render(<Viewport />);
  const assertHeights = () => {
    expect(screen.getByTestId('left').style.height).toBe('492px');
    expect(screen.getByTestId('right').style.maxHeight).toBe('');
  };
  assertHeights();
  for (const offset of [8, 16, 32, 80, 160, 0]) {
    act(() => {
      pageScroll = offset;
      vi.stubGlobal('scrollY', offset);
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
      for (const callback of [...observers]) callback([], {} as ResizeObserver);
    });
    assertHeights();
  }
});
