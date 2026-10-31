import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useWorkbenchViewport } from '../pages/workbench/useWorkbenchViewport';
import { WorkbenchDrawingContext, createWorkbenchDrawingTasks } from '../context/WorkbenchDrawingContext';

function Viewport({ showRight }: { showRight: boolean }) {
  const viewport = useWorkbenchViewport({ loading: false });
  return <div ref={viewport.panelContainerRef}>
    <div data-workbench-panel-surface="true">
      <div data-testid="toolbar-scroll" style={{ overflowY: 'auto' }}>筛选选项</div>
      <div ref={viewport.leftPanelRef} data-testid="left">
        <div data-testid="left-nested" style={{ overflowY: 'auto' }}>消息列表</div>
      </div>
    </div>
    {showRight && <div ref={viewport.rightPanelRef} data-testid="right" data-workbench-panel-surface="true">
      <div data-testid="nested" style={{ overflowY: 'auto' }}>最近消息</div>
    </div>}
  </div>;
}

const setDimensions = (element: HTMLElement) => Object.defineProperties(element, {
  clientHeight: { value: 200 }, scrollHeight: { value: 1000 },
});

it.each(['left', 'right'].flatMap(side => [1, -1].map(direction => ({ side, direction }))))(
  'scrolls only the hovered $side through nested boundaries and reversal (direction $direction)', ({ side, direction }) => {
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(200);
    vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(1000);
    render(<Viewport showRight />);
    const current = screen.getByTestId(side);
    const other = screen.getByTestId(side === 'left' ? 'right' : 'left');
    const nested = screen.getByTestId(side === 'left' ? 'left-nested' : 'nested');
    [current, other, nested].forEach(setDimensions);
    const edge = direction > 0 ? 800 : 0;
    current.scrollTop = nested.scrollTop = edge - direction * 10;
    other.scrollTop = 300;
    const page = document.documentElement;
    page.scrollTop = 200;
    const positions = () => [nested.scrollTop, current.scrollTop, other.scrollTop, page.scrollTop];

    wheel(nested, direction * 10);
    expect(positions()).toEqual([edge, edge - direction * 10, 300, 200]);
    wheel(nested, direction * 10);
    expect(positions()).toEqual([edge, edge, 300, 200]);
    wheel(nested, direction * 40);
    expect(positions()).toEqual([edge, edge, 300, 200 + direction * 40]);
    wheel(nested, direction * -20);
    expect(positions()).toEqual([edge - direction * 20, edge, 300, 200 + direction * 40]);

    // Moving to the opposite panel changes priority immediately as well.
    wheel(other, direction * -20);
    expect(positions()).toEqual([edge - direction * 20, edge, 300 - direction * 20, 200 + direction * 40]);

    // A pane's boundary goes directly to the page, even if its sibling has room.
    nested.scrollTop = current.scrollTop = edge;
    other.scrollTop = edge - direction * 10;
    wheel(nested, direction * 40);
    expect(positions()).toEqual([edge, edge, edge - direction * 10, 200 + direction * 80]);
    wheel(nested, direction * -20);
    expect(positions()).toEqual([edge - direction * 20, edge, edge - direction * 10, 200 + direction * 80]);
  },
);

it('prioritizes a scrollable toolbar region above the left canvas', () => {
  render(<Viewport showRight />);
  const target = screen.getByTestId('toolbar-scroll'), left = screen.getByTestId('left'), right = screen.getByTestId('right');
  [target, left, right].forEach(setDimensions);
  left.scrollTop = right.scrollTop = 300;
  expect(wheel(target, 120).defaultPrevented).toBe(true);
  expect([target.scrollTop, left.scrollTop, right.scrollTop]).toEqual([120, 300, 300]);
});

it('scrolls an internal list first, then hands only the remaining distance to the page when both panes grow naturally', () => {
  render(<Viewport showRight />);
  const left = screen.getByTestId('left'), right = screen.getByTestId('right'), nested = screen.getByTestId('nested');
  for (const pane of [left, right]) Object.defineProperties(pane, {
    clientHeight: { value: 1600 }, scrollHeight: { value: 1600 },
  });
  setDimensions(nested);
  const page = document.documentElement;
  const height = vi.spyOn(page, 'clientHeight', 'get').mockReturnValue(800);
  const scrollHeight = vi.spyOn(page, 'scrollHeight', 'get').mockReturnValue(3000);
  try {
    nested.scrollTop = 760;
    page.scrollTop = 100;
    expect(wheel(nested, 60).defaultPrevented).toBe(true);
    expect([nested.scrollTop, left.scrollTop, right.scrollTop, page.scrollTop]).toEqual([800, 0, 0, 120]);
    wheel(nested, -20);
    expect([nested.scrollTop, page.scrollTop]).toEqual([780, 120]);
    wheel(right, 80);
    expect([right.scrollTop, page.scrollTop]).toEqual([0, 200]);
  } finally {
    height.mockRestore();
    scrollHeight.mockRestore();
  }
});
const wheel = (element: HTMLElement, deltaY: number) => {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  act(() => { element.dispatchEvent(event); });
  return event;
};

afterEach(() => { cleanup(); localStorage.clear(); document.documentElement.scrollTop = 0; vi.restoreAllMocks(); });

it('prioritizes nested content and the right panel even when that panel mounts late or is replaced, then releases the listener', () => {
  const view = render(<Viewport showRight={false} />);
  const left = screen.getByTestId('left');
  setDimensions(left);
  left.scrollTop = 300;
  const page = document.documentElement;
  page.scrollTop = 200;
  view.rerender(<Viewport showRight />);
  let right = screen.getByTestId('right');
  const nested = screen.getByTestId('nested');
  setDimensions(right); setDimensions(nested);
  right.scrollTop = 100;

  expect(wheel(nested, 60).defaultPrevented).toBe(true);
  expect([nested.scrollTop, right.scrollTop, left.scrollTop, page.scrollTop]).toEqual([60, 100, 300, 200]);
  expect(wheel(right, 120).defaultPrevented).toBe(true);
  expect([right.scrollTop, left.scrollTop, page.scrollTop]).toEqual([220, 300, 200]);

  view.rerender(<Viewport showRight={false} />);
  view.rerender(<Viewport showRight />);
  right = screen.getByTestId('right');
  setDimensions(right);
  expect(wheel(right, 120).defaultPrevented).toBe(true);
  expect([right.scrollTop, left.scrollTop, page.scrollTop]).toEqual([120, 300, 200]);

  view.unmount();
  expect(wheel(right, 120).defaultPrevented).toBe(false);
  expect(right.scrollTop).toBe(120);
});

it('keeps ordinary scrolling, resizing and content changes outside blocking drawing work', async () => {
  const tasks = createWorkbenchDrawingTasks();
  tasks.setBlocking(false);
  const begin = vi.spyOn(tasks, 'begin');
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
  const view = render(<WorkbenchDrawingContext.Provider value={tasks}><Viewport showRight /></WorkbenchDrawingContext.Provider>);
  const left = screen.getByTestId('left');
  setDimensions(left);
  await act(async () => {
    wheel(left, 120);
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    view.rerender(<WorkbenchDrawingContext.Provider value={tasks}><Viewport showRight={false} /></WorkbenchDrawingContext.Provider>);
    await Promise.resolve();
    frames.splice(0).forEach(callback => callback(0));
  });
  expect(left.scrollTop).toBe(120);
  expect(begin).not.toHaveBeenCalled();
  expect(tasks.pending).toBe(0);
});
