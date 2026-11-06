import { StrictMode, startTransition, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCardMeasurements } from '../hooks/useCardMeasurements';

const originalResizeObserver = window.ResizeObserver;
afterEach(() => { cleanup(); window.ResizeObserver = originalResizeObserver; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])('settles card folds with an earlier pending resize (StrictMode=%s)', async strict => {
  let resize!: ResizeObserverCallback;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0, renders = 0, memberHeight = 140;
  window.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback); return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.msgid === 'arrange' ? 82 : memberHeight;
  });
  function Scene() {
    if (++renders > 100) throw new Error('Card measurements did not settle');
    const canvas = useRef<HTMLDivElement>(null);
    const cards = useRef<Record<string, HTMLDivElement | null>>({});
    const [expanded, setExpanded] = useState(false);
    const heights = useCardMeasurements(canvas, cards);
    // The graph commits its derived overlay geometry after height changes.
    const [painted, setPainted] = useState(heights);
    useLayoutEffect(() => { setPainted(heights); }, [heights]);
    return <>
      <button onClick={() => {
        memberHeight += 10;
        startTransition(() => {
          resize([{ target: cards.current.member!, borderBoxSize: [{ blockSize: memberHeight, inlineSize: 320 }],
            contentBoxSize: [], devicePixelContentBoxSize: [], contentRect: new DOMRect(0, 0, 320, memberHeight) }], {} as ResizeObserver);
          for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); }
        });
        flushSync(() => setExpanded(value => !value));
      }}>切换排列</button>
      <div ref={canvas}>
        <div data-msgid="member" ref={element => { cards.current.member = element; }} />
        {expanded && <div data-msgid="arrange" data-measure-min-height="36" ref={element => { cards.current.arrange = element; }} />}
      </div>
      <output>{JSON.stringify(painted)}</output>
    </>;
  }
  render(strict ? <StrictMode><Scene /></StrictMode> : <Scene />);
  for (let attempt = 0; attempt < 6; attempt++) {
    renders = 0;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '切换排列' })); });
    expect(screen.getByRole('status')).toHaveTextContent(`"member":${150 + attempt * 10}`);
    expect(screen.getByRole('status')).toHaveTextContent('"arrange":82');
    expect(renders).toBeLessThan(30);
  }
});
