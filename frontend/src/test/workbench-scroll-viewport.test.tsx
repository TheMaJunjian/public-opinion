import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import WorkbenchScrollViewport from '../components/WorkbenchScrollViewport';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  let top = 120;
  const frames: FrameRequestCallback[] = [];
  const visual = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', visual);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, top, 480, 400));
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
  const view = render(<WorkbenchScrollViewport data-testid="viewport"><div data-testid="content">自然展开的长内容</div></WorkbenchScrollViewport>);
  const viewport = screen.getByTestId('viewport');
  const height = () => parseFloat(viewport.style.getPropertyValue('--workbench-viewport-height'));
  const flush = () => act(() => { frames.splice(0).forEach(callback => callback(0)); });
  return { ...view, visual, viewport, height, flush, frames, setTop: (value: number) => { top = value; } };
}

it('sizes only the scroll viewport from the visible space and compensates for interface scaling', () => {
  const { viewport, height } = setup();
  expect(height()).toBeCloseTo((844 - 120) / 0.8 - 9);
  expect(viewport.style.overflow).toBe('auto');
  expect(viewport.style.maxHeight).toBe('');
  const content = screen.getByTestId('content');
  expect([content.style.height, content.style.maxHeight]).toEqual(['', '']);
});

it('follows pinch zoom, viewport panning, keyboard and orientation changes without clipping content to dvh', () => {
  const { visual, height, flush } = setup();
  for (const [visibleHeight, offsetTop, scale] of [[2637.5, 0, 0.32], [422, 80, 2], [300, 0, 1], [390, 0, 1]]) {
    act(() => {
      Object.assign(visual, { height: visibleHeight, offsetTop, scale });
      visual.dispatchEvent(new Event('resize'));
      visual.dispatchEvent(new Event('scroll'));
    });
    flush();
    expect(height()).toBeCloseTo(Math.max(64, (visibleHeight + offsetTop - 120) / 0.8 - 9));
  }
});

it.each([120.857, 206.286])('fills the visible bottom when pinch zoom pans below a panel starting at %spx', top => {
  const { visual, setTop, height, flush } = setup();
  setTop(top);
  act(() => {
    Object.assign(visual, { height: 593.759, offsetTop: 296.571, scale: 1.809 });
    visual.dispatchEvent(new Event('resize'));
    visual.dispatchEvent(new Event('scroll'));
  });
  flush();
  // The hidden upper part remains inside the scroll box. Both differently
  // positioned panels must reach the visual bottom, including interface zoom.
  expect(top + height() * 0.8).toBeCloseTo(visual.offsetTop + visual.height - 9 * 0.8);
  expect(height()).toBeGreaterThan(visual.height / 0.8 - 9);
});

it('remeasures changed toolbar positions after a commit and keeps a scroll target when controls fill the screen', () => {
  const { rerender, setTop, height } = setup();
  setTop(200);
  rerender(<WorkbenchScrollViewport data-testid="viewport"><div>展开的工具栏</div></WorkbenchScrollViewport>);
  expect(height()).toBeCloseTo((844 - 200) / 0.8 - 9);
  setTop(1000);
  rerender(<WorkbenchScrollViewport data-testid="viewport"><div>工具栏暂时超出可视区域</div></WorkbenchScrollViewport>);
  expect(height()).toBe(64);
});

it('coalesces scroll measurements and releases viewport listeners on unmount', () => {
  const { visual, frames, flush, unmount } = setup();
  for (let index = 0; index < 10; index++) window.dispatchEvent(new Event('scroll'));
  expect(frames).toHaveLength(1);
  flush();
  unmount();
  visual.dispatchEvent(new Event('resize'));
  window.dispatchEvent(new Event('scroll'));
  expect(frames).toHaveLength(0);
});

it('ignores subpixel measurement noise without changing content or restarting layout', () => {
  const { viewport, height, setTop, flush } = setup();
  const originalHeight = height();
  const write = vi.spyOn(viewport.style, 'setProperty');
  for (const top of [120.1, 119.9, 120.2, 120]) {
    setTop(top);
    window.dispatchEvent(new Event('scroll'));
    flush();
  }
  expect(height()).toBe(originalHeight);
  expect(write).not.toHaveBeenCalled();
  setTop(140);
  window.dispatchEvent(new Event('scroll'));
  flush();
  expect(height()).toBeCloseTo((844 - 140) / 0.8 - 9);
  expect(write).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('content')).toHaveTextContent('自然展开的长内容');
});

it('keeps fractional flex widths from creating false scaling and global vertical overflow', () => {
  vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { height: 890.666687, offsetTop: 0 }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 260, 1496.6, 400));
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1497);
  render(<WorkbenchScrollViewport data-testid="viewport" style={{ width: 1496.6 }}>长内容</WorkbenchScrollViewport>);
  const viewport = screen.getByTestId('viewport');
  const height = parseFloat(viewport.style.getPropertyValue('--workbench-viewport-height'));
  expect(height).toBeCloseTo(890.666687 - 260 - 9);
  expect(260 + height + 8).toBeLessThan(890.666687);
  expect(viewport.style.maxHeight).toBe('');
});
