import { useRef } from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCardMeasurements } from '../hooks/useCardMeasurements';

function Canvas({ x, showSecond = false }: { x: number; showSecond?: boolean }) {
  const canvas = useRef<HTMLDivElement>(null);
  const cards = useRef<Record<string, HTMLDivElement | null>>({});
  useCardMeasurements(canvas, cards);
  return <div ref={canvas}>
    <div data-msgid="first" ref={element => { cards.current.first = element; }} style={{ left: x }}>First</div>
    {showSecond && <div data-msgid="second" ref={element => { cards.current.second = element; }}>Second</div>}
  </div>;
}

describe('canvas size observation', () => {
  const OriginalObserver = window.ResizeObserver;
  afterEach(() => { window.ResizeObserver = OriginalObserver; });
  it('keeps the observer and existing subscriptions during layout changes, and detaches removed cards', () => {
    const observe = vi.fn(); const unobserve = vi.fn(); const disconnect = vi.fn();
    const constructed = vi.fn();
    window.ResizeObserver = class {
      constructor() { constructed(); }
      observe = observe; unobserve = unobserve; disconnect = disconnect;
    } as unknown as typeof ResizeObserver;
    const view = render(<Canvas x={0} />);
    expect(constructed).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
    view.rerender(<Canvas x={400} />);
    view.rerender(<Canvas x={800} />);
    expect(constructed).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
    view.rerender(<Canvas x={800} showSecond />);
    expect(observe).toHaveBeenCalledTimes(2);
    view.rerender(<Canvas x={800} />);
    expect(unobserve).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
