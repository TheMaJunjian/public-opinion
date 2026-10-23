import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import WorkbenchLoadingBoundary, { useWorkbenchLoadingProgress } from '../components/WorkbenchLoadingBoundary';
import WorkbenchActivityIndicator from '../components/WorkbenchActivityIndicator';
import { beginWorkbenchDrawing, resetWorkbenchActivity } from '../utils/workbenchActivity';
import { useContext, useState } from 'react';
import { WorkbenchDrawingContext } from '../context/WorkbenchDrawingContext';
import { computeSceneLayout } from '../utils/frameLayout';
import type { SceneComputationRequest } from '../hooks/useSceneComputation';
import { REVEAL_VIRTUAL_MESSAGE } from '../hooks/useVirtualMessageMounts';

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
afterEach(() => { window.ResizeObserver = originalResizeObserver; resetWorkbenchActivity(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('finishes selecting and deselecting an arrangement while its worker layout and card measurements update asynchronously', async () => {
  class SceneWorker {
    onmessage!: (event: MessageEvent) => void;
    terminated = false;
    postMessage(request: SceneComputationRequest) {
      setTimeout(() => {
        if (this.terminated || request.job.kind !== 'layout') return;
        this.onmessage({ data: { id: request.id, result: structuredClone(computeSceneLayout(request.job.input)) } } as MessageEvent);
      }, 5);
    }
    terminate() { this.terminated = true; }
  }
  vi.stubGlobal('Worker', SceneWorker);
  let tasks: ReturnType<typeof import('../context/WorkbenchDrawingContext')['createWorkbenchDrawingTasks']> | null = null;
  const messages: GraphViewProps['messages'] = [
    { id: 'arrange', kind: 'relation', relationType: 'arrange', content: '', author: '用户', createdAt: '' },
    { id: 'member', kind: 'normal', content: '排列成员', author: '用户', createdAt: '' },
    { id: 'agree', kind: 'relation', relationType: 'agree', content: '', author: '用户', createdAt: '' },
  ];
  const edges: GraphViewProps['edges'] = [{ id: 'arrange-member', relationMessageId: 'arrange', relationType: 'arrange',
    relationLabel: '排列', from: { messageId: 'anon:arrange', selection: { kind: 'whole' } }, to: { messageId: 'member', selection: { kind: 'whole' } } },
    { id: 'agree-arrange', relationMessageId: 'agree', relationType: 'agree', relationLabel: '赞同',
      from: { messageId: 'anon:agree', selection: { kind: 'whole' } }, to: { messageId: 'arrange', selection: { kind: 'whole' } } }];
  function Arrangement() {
    useWorkbenchLoadingProgress(false, null);
    tasks = useContext(WorkbenchDrawingContext);
    const [draftUnits, setDraftUnits] = useState<GraphViewProps['draftUnits']>([]);
    return <GraphView messages={messages} edges={edges} draftUnits={draftUnits} activeTextSelectId={null} lastClickedMessageId="arrange"
      onMessageClick={() => setDraftUnits(previous => previous.length ? [] : [{ messageId: 'arrange', selection: { kind: 'whole' } }])}
      onMessageDoubleClick={vi.fn()} onTextMouseUp={vi.fn()} onEdgeLabelSingleClick={vi.fn()}
      onEdgeLabelDoubleClick={vi.fn()} onFragmentAnchorClick={vi.fn()} isFragmentSelected={() => false} />;
  }
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.frameHeader ? 64 : 140;
  });
  const view = render(<WorkbenchLoadingBoundary><Arrangement /></WorkbenchLoadingBoundary>);
  const finishDrawing = async () => {
    for (let frame = 0; frame < 120; frame++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(16); });
      expect(tasks!.failure).toBeNull();
      if (!tasks!.pending && !screen.queryByRole('dialog')) return;
    }
    expect(tasks!.pending).toBe(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  };
  try {
    await finishDrawing();
    for (let attempt = 0; attempt < 3; attempt++) {
      const border = view.container.querySelector<HTMLElement>('div[data-msgid="arrange"][data-rel-overlay]')!;
      fireEvent.click(border);
      await finishDrawing();
      expect(screen.queryByRole('group', { name: '组织消息 arrange' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '显示排列消息卡 arrange' }));
      await finishDrawing();
      const card = screen.getByRole('group', { name: '组织消息 arrange' });
      expect(card).toHaveTextContent('排列（1）');
      const observer = observers.find(item => item.elements.has(card))!;
      act(() => observer.callback([resized(card, 96)], {} as ResizeObserver));
      await finishDrawing();
      const member = view.container.querySelector<HTMLElement>('[data-msgid="member"]')!;
      expect(parseFloat(member.style.top)).toBeGreaterThanOrEqual(parseFloat((card as HTMLElement).style.top) + 96);
      fireEvent.click(card);
      await finishDrawing();
      expect(screen.getByRole('group', { name: '组织消息 arrange' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '收起排列消息卡 arrange' }));
      await finishDrawing();
      expect(screen.queryByRole('group', { name: '组织消息 arrange' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      const canvas = view.container.querySelector('[data-jump-canvas]')!;
      act(() => { canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: ['agree'] } })); });
      await finishDrawing();
      expect(screen.getByRole('group', { name: '组织消息 arrange' })).toBeInTheDocument();
      expect(view.container.querySelector('[data-jump-msgids="agree"]')).not.toBeNull();
      act(() => { canvas.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } })); });
      await finishDrawing();
      expect(screen.queryByRole('group', { name: '组织消息 arrange' })).toBeNull();
    }
  } finally { view.unmount(); }
});

function Scene({ onClick = vi.fn() }: { onClick?: GraphViewProps['onMessageClick'] }) {
  useWorkbenchLoadingProgress(false, null);
  return <GraphView messages={[
    { id: 'claim', kind: 'normal', content: '原始消息', author: '用户', createdAt: '' },
    { id: 'reply', kind: 'normal', content: '回复消息', author: '用户', createdAt: '' },
  ]} edges={[{
    id: 'relation', relationMessageId: 'relation', relationType: 'reply', relationLabel: '回复',
    from: { messageId: 'reply', selection: { kind: 'whole' } }, to: { messageId: 'claim', selection: { kind: 'whole' } },
  }]} draftUnits={[]} activeTextSelectId={null} lastClickedMessageId={null} autoCenterMessageId="claim"
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
