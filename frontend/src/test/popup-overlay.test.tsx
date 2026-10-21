import { act, render } from '@testing-library/react';
import { Profiler, useRef } from 'react';
import { expect, it, vi } from 'vitest';
import PopupOverlay from '../components/PopupOverlay';

it('相同布局的测量不重复绘制遮罩，真实尺寸变化仍会更新，关闭后释放观察器', () => {
  const callbacks: (() => void)[] = [];
  const disconnect = vi.fn();
  const originalObserver = window.ResizeObserver;
  window.ResizeObserver = class {
    constructor(callback: () => void) { callbacks.push(callback); }
    observe() {}
    unobserve() {}
    disconnect = disconnect;
  } as unknown as typeof ResizeObserver;
  let contentWidth = 400;
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.popupTestContent ? new DOMRect(100, 100, contentWidth, 240) : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  });
  function Preview() {
    const ref = useRef<HTMLDivElement>(null);
    return <PopupOverlay contentRef={ref} zIndex={1500} background="black" onClick={() => {}}><div ref={ref} data-popup-test-content="true" /></PopupOverlay>;
  }
  const commits = vi.fn();
  const view = render(<Profiler id="popup" onRender={commits}><Preview /></Profiler>);
  try {
    const initialCommits = commits.mock.calls.length;
    const flow = document.querySelector('.popup-backdrop-flow')!;
    expect(document.querySelectorAll('.popup-backdrop-flow')).toHaveLength(1);
    expect(document.querySelector('.popup-guides')).toBeNull();
    const originalPath = flow.getAttribute('d');
    expect(originalPath?.match(/M/g)).toHaveLength(100);
    expect(originalPath?.match(/L300,220/g)).toHaveLength(100);
    for (let index = 0; index < 10; index++) act(() => { callbacks[0](); });
    expect(commits).toHaveBeenCalledTimes(initialCommits);
    contentWidth = 600;
    act(() => { callbacks[0](); });
    expect(commits).toHaveBeenCalledTimes(initialCommits + 1);
    expect(flow.getAttribute('d')?.match(/L400,220/g)).toHaveLength(100);
    act(() => { callbacks[0](); });
    expect(commits).toHaveBeenCalledTimes(initialCommits + 1);
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(document.querySelector('.popup-backdrop-flow')).toBeNull();
  } finally {
    view.unmount();
    geometry.mockRestore();
    window.ResizeObserver = originalObserver;
  }
});

it('长页面和超大内容不扩大遮罩或引导线的绘制区域', () => {
  const width = vi.spyOn(document.documentElement, 'scrollWidth', 'get').mockReturnValue(20000);
  const height = vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(100000);
  function Preview() {
    const ref = useRef<HTMLDivElement>(null);
    return <PopupOverlay contentRef={ref} zIndex={1500} background="black" onClick={() => {}}>
      <div ref={ref} style={{ width: 20000, height: 20000 }} />
    </PopupOverlay>;
  }
  const view = render(<Preview />);
  try {
    const overlay = document.querySelector<HTMLElement>('[data-popup-overlay]')!;
    expect(overlay).toHaveStyle({ width: `${window.innerWidth}px`, height: `${window.innerHeight}px`, overflow: 'hidden' });
    expect(width).not.toHaveBeenCalled();
    expect(height).not.toHaveBeenCalled();
    width.mockReturnValue(40000);
    height.mockReturnValue(200000);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(overlay).toHaveStyle({ width: `${window.innerWidth}px`, height: `${window.innerHeight}px` });
  } finally { view.unmount(); width.mockRestore(); height.mockRestore(); }
});
