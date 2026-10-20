import { useRef } from 'react';
import { act, render, waitFor } from '@testing-library/react';
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
  it('measures a compact merge header at its own minimum and allows a long header to shrink', async () => {
    let notify!: ResizeObserverCallback;
    let naturalHeight = 400;
    window.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) { notify = callback; }
      observe() {} unobserve() {} disconnect() {}
    } as unknown as typeof ResizeObserver;
    const offset = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.msgid === 'merge' ? naturalHeight : 0;
    });
    function Header() {
      const canvas = useRef<HTMLDivElement>(null), cards = useRef<Record<string, HTMLDivElement | null>>({});
      const heights = useCardMeasurements(canvas, cards);
      return <div ref={canvas}><div data-msgid="merge" data-measure-min-height="36" ref={element => { cards.current.merge = element; }} />
        <output>{heights.merge}</output></div>;
    }
    try {
      const view = render(<Header />);
      expect(view.getByRole('status')).toHaveTextContent('400');
      naturalHeight = 36;
      act(() => notify([{ target: view.container.querySelector('[data-msgid]')! } as ResizeObserverEntry], {} as ResizeObserver));
      await waitFor(() => expect(view.getByRole('status')).toHaveTextContent('36'));
    } finally { offset.mockRestore(); }
  });
  it('retains cached heights when an unmounted card delivers a late observer notification', async () => {
    let notify!: ResizeObserverCallback;
    window.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) { notify = callback; }
      observe() {} unobserve() {} disconnect() {}
    } as unknown as typeof ResizeObserver;
    const offset = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240);
    function Card({ shown }: { shown: boolean }) {
      const canvas = useRef<HTMLDivElement>(null), cards = useRef<Record<string, HTMLDivElement | null>>({});
      const heights = useCardMeasurements(canvas, cards);
      return <div ref={canvas}>{shown && <div data-msgid="card" ref={element => { cards.current.card = element; }} />}<output>{heights.card}</output></div>;
    }
    try {
      const view = render(<Card shown />), card = view.container.querySelector('[data-msgid]')!;
      expect(view.getByRole('status')).toHaveTextContent('240');
      view.rerender(<Card shown={false} />);
      act(() => notify([{ target: card, borderBoxSize: [{ blockSize: 0 }] } as unknown as ResizeObserverEntry], {} as ResizeObserver));
      await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
      expect(view.getByRole('status')).toHaveTextContent('240');
    } finally { offset.mockRestore(); }
  });
  it('records the first one-pixel measurement so an empty list row can finish preparation', () => {
    function EmptyRow() {
      const canvas = useRef<HTMLDivElement>(null), cards = useRef<Record<string, HTMLDivElement | null>>({});
      const heights = useCardMeasurements(canvas, cards);
      return <div ref={canvas}><div data-measure-id="empty" data-measure-min-height="1" ref={element => { cards.current.empty = element; }} />
        <output>{heights.empty ?? 'pending'}</output></div>;
    }
    const view = render(<EmptyRow />);
    expect(view.getByRole('status')).toHaveTextContent('1');
  });
});
