import { useState } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import { CardWidthContext } from '../components/graph/CardWidthContext';
import CardWidthEditor from '../components/graph/CardWidthEditor';
import type { DemoMessage } from '../utils/modelBridge';

const message: DemoMessage = { id: 'message-id', author: '非常非常长的用户名不应该把消息编号挤出卡片', kind: 'normal', content: '正文保持不变', createdAt: '2026-10-23T00:00:00Z' };
const props: GraphViewProps = { messages: [message], edges: [], draftUnits: [], activeTextSelectId: null, lastClickedMessageId: null,
  onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(), onTextMouseUp: vi.fn(), onEdgeLabelSingleClick: vi.fn(),
  onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(), isFragmentSelected: () => false };

describe('card width controls', () => {
  it('allows typing a new width through intermediate values and clamps on blur', () => {
    function Editor() { const [width, setWidth] = useState(320); return <CardWidthEditor width={width} onChange={setWidth} />; }
    const view = render(<Editor />), input = view.getByRole('spinbutton', { name: '消息卡宽度' });
    for (const value of ['', '6', '64', '640']) fireEvent.change(input, { target: { value } });
    expect(input).toHaveValue(640);
    expect(view.getByRole('slider')).toHaveValue('640');
    fireEvent.change(input, { target: { value: '9000' } }); fireEvent.blur(input);
    expect(input).toHaveValue(2400);
  });
  it('keeps author details off the card and resizes a draft in canvas pixels even when the canvas is zoomed', async () => {
    function Scene() { const [width, setWidth] = useState(400); return <CardWidthContext.Provider value={{ widths: {}, editing: { messageId: message.id, width, onChange: setWidth } }}><GraphView {...props} /></CardWidthContext.Provider>; }
    const view = render(<Scene />);
    const card = view.container.querySelector<HTMLElement>('[data-msgid="message-id"]')!;
    expect(card.querySelector('[data-message-authors],time')).toBeNull();
    const handle = view.getByRole('separator', { name: '调整消息 message-id 的宽度' });
    Object.defineProperty(card, 'offsetWidth', { configurable: true, get: () => 400 });
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 100));
    handle.setPointerCapture = vi.fn(); handle.hasPointerCapture = vi.fn(() => true); handle.releasePointerCapture = vi.fn();
    const pointer = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { button: { value: 0 }, clientX: { value: x }, pointerId: { value: 1 } });
      fireEvent(handle, event);
    };
    pointer('pointerdown', 200); pointer('pointermove', 250); pointer('pointerup', 250);
    await waitFor(() => expect(card.style.width).toBe('500px'));
    pointer('pointermove', 400);
    expect(card.style.width).toBe('500px');
    fireEvent.doubleClick(handle);
    await waitFor(() => expect(card.style.width).toBe('320px'));
    expect(card).toHaveTextContent('正文保持不变');
  });
  it('grows for the intrinsic header width and releases the measured minimum when the header becomes shorter', async () => {
    let authorWidth = 210, idWidth = 260;
    const geometry = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.parentElement?.hasAttribute('data-card-header-content')) return this === this.parentElement.firstElementChild ? authorWidth : idWidth;
      return 0;
    });
    let observed: ResizeObserverCallback | null = null;
    const OriginalObserver = window.ResizeObserver;
    window.ResizeObserver = class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) { this.callback = callback; }
      observe(element: Element) { if (element.hasAttribute('data-card-header')) observed = this.callback; }
      unobserve() {} disconnect() {}
    };
    const view = render(<GraphView {...props} />);
    try {
      const card = view.container.querySelector<HTMLElement>('[data-msgid="message-id"]')!;
      await waitFor(() => expect(parseFloat(card.style.width)).toBeGreaterThanOrEqual(514));
      authorWidth = 40; idWidth = 50;
      act(() => { observed?.([], {} as ResizeObserver); });
      await waitFor(() => expect(card.style.width).toBe('320px'));
    } finally { view.unmount(); geometry.mockRestore(); window.ResizeObserver = OriginalObserver; }
  });
  it.each(['merge', 'arrange', 'classify', 'summary'] as const)('offers a resize handle on the %s frame header while editing', type => {
    const frame = { ...message, id: 'frame', kind: 'relation' as const, relationType: type };
    const view = render(<CardWidthContext.Provider value={{ widths: {}, editing: { messageId: 'frame', width: 640, onChange: vi.fn() } }}>
      <GraphView {...props} messages={[message, frame]}
        traceFrameIds={new Set(['frame'])} traceExpandedFrameIds={new Set(['frame'])}
        edges={[{ id: 'frame-member', relationMessageId: 'frame', relationType: type, relationLabel: type,
          from: { messageId: 'anon:frame', selection: { kind: 'whole' } }, to: { messageId: message.id, selection: { kind: 'whole' } } }]} />
    </CardWidthContext.Provider>);
    const handle = view.getByRole('separator', { name: '调整消息 frame 的宽度' });
    expect(handle.parentElement).toHaveAttribute('data-frame-header');
    if(type==='classify'||type==='summary'){
      const outline=view.container.querySelector('rect[data-jump-visual-msgids="frame"]')!;
      expect(Number.parseFloat(handle.parentElement!.style.width)).toBe(Number(outline.getAttribute('width')));
    }else expect(handle.parentElement?.style.width).toBe('640px');
  });
  it('keeps the merge message card at its own width when a member widens the frame', () => {
    const frame = { ...message, id: 'frame', kind: 'relation' as const, relationType: 'merge' as const };
    const view = render(<CardWidthContext.Provider value={{ widths: { [message.id]: 900 }, editing: null }}>
      <GraphView {...props} messages={[message, frame]} edges={[{ id: 'member', relationMessageId: 'frame', relationType: 'merge', relationLabel: '归并',
        from: { messageId: 'anon:frame', selection: { kind: 'whole' } }, to: { messageId: message.id, selection: { kind: 'whole' } } }]} />
    </CardWidthContext.Provider>);
    const card = view.getByRole('group', { name: '组织消息 frame' });
    expect(card.style.width).toBe('320px');
    expect(view.container.querySelector<HTMLElement>('[data-msgid="message-id"]')!.style.width).toBe('900px');
  });
});
