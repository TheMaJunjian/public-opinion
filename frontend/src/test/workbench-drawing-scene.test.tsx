import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import WorkbenchLoadingBoundary, { useWorkbenchLoadingProgress } from '../components/WorkbenchLoadingBoundary';
import WorkbenchActivityIndicator from '../components/WorkbenchActivityIndicator';
import { beginWorkbenchDrawing, resetWorkbenchActivity } from '../utils/workbenchActivity';

const observers: Array<{ callback: ResizeObserverCallback; elements: Set<Element> }> = [];
const originalResizeObserver = window.ResizeObserver;
const resized = (target: Element, height: number): ResizeObserverEntry => ({
  target, borderBoxSize: [{ blockSize: height, inlineSize: 320 }], contentBoxSize: [], devicePixelContentBoxSize: [],
  contentRect: new DOMRect(0, 0, 320, height),
});
beforeEach(() => {
  vi.useFakeTimers();
  observers.length = 0;
  window.ResizeObserver = class {
    elements = new Set<Element>();
    constructor(callback: ResizeObserverCallback) { observers.push({ callback, elements: this.elements }); }
    observe(element: Element) { this.elements.add(element); }
    unobserve(element: Element) { this.elements.delete(element); }
    disconnect() { this.elements.clear(); }
  };
});
afterEach(() => { window.ResizeObserver = originalResizeObserver; resetWorkbenchActivity(); vi.restoreAllMocks(); vi.useRealTimers(); });

function Scene({ onClick = vi.fn() }: { onClick?: GraphViewProps['onMessageClick'] }) {
  useWorkbenchLoadingProgress(false, null);
  return <GraphView messages={[
    { id: 'claim', kind: 'normal', content: '原始消息', author: '用户', createdAt: '' },
    { id: 'reply', kind: 'normal', content: '回复消息', author: '用户', createdAt: '' },
  ]} edges={[{
    id: 'relation', relationMessageId: 'relation', relationType: 'reply', relationLabel: '回复',
    from: { messageId: 'reply', selection: { kind: 'whole' } }, to: { messageId: 'claim', selection: { kind: 'whole' } },
  }]} draftUnits={[]} activeTextSelectId={null} lastClickedMessageId={null} voteStats={{}} autoCenterMessageId="claim"
    onMessageClick={onClick} onMessageDoubleClick={vi.fn()} onTextMouseUp={vi.fn()}
    onEdgeLabelSingleClick={vi.fn()} onEdgeLabelDoubleClick={vi.fn()} onFragmentAnchorClick={vi.fn()} isFragmentSelected={() => false} />;
}

it('waits for real card resize measurements, relation hitboxes and auto-centering before making the scene clickable', () => {
  const click = vi.fn();
  const center = vi.spyOn(Element.prototype, 'scrollIntoView');
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(140);
  const view = render(<><WorkbenchLoadingBoundary><Scene onClick={click} /></WorkbenchLoadingBoundary><WorkbenchActivityIndicator /></>);
  expect(center).toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
  const card = view.container.querySelector<HTMLElement>('[data-msgid="claim"]')!;
  const canvas = card.closest<HTMLElement>('[data-jump-canvas]')!;
  const initialHeight = parseFloat(canvas.style.height);
  const observer = observers.find(item => item.elements.has(card))!;
  expect(observer).toBeDefined();
  act(() => { vi.advanceTimersByTime(16); });
  act(() => observer.callback([resized(card, 320)], {} as ResizeObserver));
  act(() => { vi.advanceTimersByTime(16); });
  expect(parseFloat(canvas.style.height)).toBeGreaterThan(initialHeight);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('正在绘制');
  act(() => { vi.advanceTimersByTime(34); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText('正在绘制消息图…')).toBeNull();
  expect(view.container.querySelector('[data-rel-overlay]')).not.toBeNull();
  expect(view.container.querySelector('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
  fireEvent.click(card);
  expect(click).toHaveBeenCalledOnce();
});

it('cancels a queued card measurement when leaving the scene', () => {
  const view = render(<WorkbenchLoadingBoundary><Scene /></WorkbenchLoadingBoundary>);
  const card = view.container.querySelector<HTMLElement>('[data-msgid="claim"]')!;
  const observer = observers.find(item => item.elements.has(card))!;
  act(() => observer.callback([resized(card, 320)], {} as ResizeObserver));
  view.unmount();
  act(() => { vi.advanceTimersByTime(1000); });
  expect(vi.getTimerCount()).toBe(0);
});

it('catches errors in the actual ResizeObserver callback and restores interaction', () => {
  const click = vi.fn();
  const view = render(<><WorkbenchLoadingBoundary><Scene onClick={click} /></WorkbenchLoadingBoundary><WorkbenchActivityIndicator /></>);
  const card = view.container.querySelector<HTMLElement>('[data-msgid="claim"]')!;
  const observer = observers.find(item => item.elements.has(card))!;
  act(() => { vi.advanceTimersByTime(34); });
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => beginWorkbenchDrawing());
  expect(screen.getByRole('status')).toHaveTextContent('正在绘制');
  const entry = resized(card, 320);
  Object.defineProperty(entry, 'borderBoxSize', { get() { throw new Error('尺寸读取异常'); } });
  act(() => observer.callback([entry], {} as ResizeObserver));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('alert')).toHaveTextContent('尺寸测量失败');
  expect(screen.queryByRole('status')).toBeNull();
  expect(view.container.querySelector('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
  fireEvent.click(card);
  expect(click).toHaveBeenCalledOnce();
  const canvas = card.closest<HTMLElement>('[data-jump-canvas]')!;
  const oldHeight = parseFloat(canvas.style.height);
  act(() => observer.callback([resized(card, 640)], {} as ResizeObserver));
  act(() => { vi.advanceTimersByTime(16); });
  expect(parseFloat(canvas.style.height)).toBeGreaterThan(oldHeight);
});
