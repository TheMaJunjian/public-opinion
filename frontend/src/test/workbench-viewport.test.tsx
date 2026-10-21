import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useWorkbenchViewport } from '../pages/workbench/useWorkbenchViewport';

function Viewport({ showRight }: { showRight: boolean }) {
  const viewport = useWorkbenchViewport({ comparisonReviewed: false, viewMode: 'graph', loading: false });
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
  'prioritizes the hovered region on the $side through boundary handoff and reversal (direction $direction)', ({ side, direction }) => {
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
    expect(positions()).toEqual([edge, edge, 300 + direction * 40, 200]);
    wheel(nested, direction * -20);
    expect(positions()).toEqual([edge - direction * 20, edge, 300 + direction * 40, 200]);

    // Moving to the opposite panel changes priority immediately as well.
    wheel(other, direction * -20);
    expect(positions()).toEqual([edge - direction * 20, edge, 300 + direction * 20, 200]);
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
const wheel = (element: HTMLElement, deltaY: number) => {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  act(() => { element.dispatchEvent(event); });
  return event;
};

afterEach(() => { cleanup(); localStorage.clear(); document.documentElement.scrollTop = 0; });

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
