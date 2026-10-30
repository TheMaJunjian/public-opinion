import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InterfaceZoomContext } from '../context/InterfaceZoomContext';
import { useRelationToolbar } from '../pages/workbench/useRelationToolbar';

let viewportWidth: number, scale: number, scrollX: number, rightWidth: number;
const originalResizeObserver = window.ResizeObserver;
const observers = new Set<ToolbarResizeObserver>();
class ToolbarResizeObserver {
  elements = new Set<Element>();
  constructor(public notify: () => void) { observers.add(this); }
  observe(element: Element) { this.elements.add(element); }
  disconnect() { observers.delete(this); }
}

function Toolbar({ visible = true }: { visible?: boolean }) {
  const layout = useRelationToolbar(false);
  return <>
    {visible && <div data-testid="bar" ref={layout.relationBarRef}>
      <div data-testid="left" ref={layout.relationLeftControlsRef}>跳转消息</div>
      <div data-testid="right" ref={layout.relationRightControlsRef} style={{ right: layout.relationControlsRightOffset }}>关系类型</div>
    </div>}
    <output data-testid="size">{layout.relationBarHeight},{layout.relationBarMinWidth}</output>
  </>;
}

beforeEach(() => {
  viewportWidth = 1600; scale = 1; scrollX = 0; rightWidth = 900;
  window.ResizeObserver = ToolbarResizeObserver as unknown as typeof ResizeObserver;
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockImplementation(() => viewportWidth);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const name = this.dataset.testid;
    const width = (name === 'left' ? 290 : name === 'right' ? rightWidth : 2048) * scale;
    const left = 16 * scale - scrollX;
    return { left, right: left + width, width, height: 50 * scale, top: 0, bottom: 50 * scale, x: left, y: 0, toJSON() {} };
  });
});
afterEach(() => { cleanup(); observers.clear(); vi.restoreAllMocks(); window.ResizeObserver = originalResizeObserver; });

const offset = () => parseFloat(screen.getByTestId('right').style.right);
const resize = () => act(() => { window.dispatchEvent(new Event('resize')); });

it('starts measuring when the deferred toolbar mounts and observes its replacement', () => {
  viewportWidth = 900;
  const view = render(<Toolbar visible={false} />);
  expect(observers.size).toBe(0);
  view.rerender(<Toolbar />);
  expect(screen.getByTestId('size')).toHaveTextContent('50,1222');
  expect(offset()).toBe(-322);
  expect([...observers][0].elements.has(screen.getByTestId('bar'))).toBe(true);

  view.rerender(<Toolbar visible={false} />);
  expect(observers.size).toBe(0);
  viewportWidth = 1600;
  view.rerender(<Toolbar />);
  expect(offset()).toBe(16);
  expect([...observers][0].elements.has(screen.getByTestId('right'))).toBe(true);
  view.unmount();
  expect(observers.size).toBe(0);
});

it('lets the right controls move beyond the viewport before covering the jump controls, and follows horizontal scrolling', () => {
  render(<Toolbar />);
  expect(offset()).toBe(16);
  viewportWidth = 900;
  resize();
  expect(offset()).toBe(-322);
  const rightLeft = viewportWidth - offset() - rightWidth;
  expect(rightLeft - screen.getByTestId('left').getBoundingClientRect().right).toBe(16);

  scrollX = 200;
  act(() => { window.dispatchEvent(new Event('scroll')); });
  expect(offset()).toBe(-122);
  viewportWidth = 1600;
  resize();
  expect(offset()).toBe(16);
});

it('preserves the gap under interface scaling and remeasures changed button widths', () => {
  viewportWidth = 1000;
  const view = render(<InterfaceZoomContext.Provider value={scale}><Toolbar /></InterfaceZoomContext.Provider>);
  scale = 1.25;
  view.rerender(<InterfaceZoomContext.Provider value={scale}><Toolbar /></InterfaceZoomContext.Provider>);
  expect(screen.getByTestId('size')).toHaveTextContent('50,1222');
  const gap = () => viewportWidth - offset() * scale - rightWidth * scale - screen.getByTestId('left').getBoundingClientRect().right;
  expect(gap()).toBe(16 * scale);
  rightWidth = 960;
  act(() => { observers.forEach(observer => observer.notify()); });
  expect(screen.getByTestId('size')).toHaveTextContent('50,1282');
  expect(gap()).toBe(16 * scale);
});
