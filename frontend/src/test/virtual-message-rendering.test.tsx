import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VirtualMessageList from '../components/VirtualMessageList';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import { REVEAL_VIRTUAL_MESSAGE } from '../hooks/useVirtualMessageMounts';
import { createWorkbenchDrawingTasks, WorkbenchDrawingContext } from '../context/WorkbenchDrawingContext';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';
import { useRef } from 'react';
import { useCanvasViewport } from '../hooks/useCanvasViewport';

const pins = new Set<string>();
const ids = Array.from({ length: 600 }, (_, index) => `m-${index}`);
const message = (id: string): DemoMessage => ({ id, author: 'tester', content: id, kind: 'normal', createdAt: '2026-01-01' });
const callbacks = { onMessageClick: vi.fn(), onMessageDoubleClick: vi.fn(), onTextMouseUp: vi.fn(),
  onEdgeLabelSingleClick: vi.fn(), onEdgeLabelDoubleClick: vi.fn(), onFragmentAnchorClick: vi.fn(), isFragmentSelected: () => false };
const frames = (count = 1) => { for (let frame = 0; frame < count; frame++) act(() => { vi.advanceTimersByTime(17); }); };

describe('viewport message rendering with measured browser geometry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      const id = this.dataset.measureId ?? this.dataset.msgid;
      if (id === 'merge') return 36;
      if (id?.startsWith('m-')) return 100 + Number(id.slice(2)) % 7 * 20;
      return parseFloat(this.style.height) || 500;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return parseFloat(this.style.width) > 100 ? parseFloat(this.style.width) : 800;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const host = this.closest<HTMLElement>('[data-workbench-left-panel]');
      const x = (parseFloat(this.style.left) || 0) - (host?.scrollLeft ?? 0);
      const y = (parseFloat(this.style.top) || 0) - (host?.scrollTop ?? 0);
      return new DOMRect(this === host ? 0 : x, this === host ? 0 : y, this.offsetWidth, this === host ? 500 : this.offsetHeight);
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('bounds list mounts, preserves measured scroll geometry, and reveals remote navigation targets', () => {
    const tasks = createWorkbenchDrawingTasks();
    const view = render(<WorkbenchDrawingContext.Provider value={tasks}>
      <div data-workbench-left-panel style={{ overflow: 'auto', height: 500 }}>
        <VirtualMessageList ids={ids} pinned={pins}>{id => <div data-msgid={id}>{id}</div>}</VirtualMessageList>
      </div>
    </WorkbenchDrawingContext.Provider>);
    let maximum = 0;
    for (let index = 0; index < 50; index++) {
      frames(); maximum = Math.max(maximum, view.container.querySelectorAll('[data-measure-id]').length);
    }
    expect(maximum).toBeLessThan(55);
    expect(tasks.pending).toBe(0);
    const host = view.container.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
    const surface = view.container.querySelector<HTMLElement>('[data-virtual-message-list]')!;
    const height = surface.style.height;
    const first = view.container.querySelector<HTMLElement>('[data-measure-id="m-0"]')!;
    const firstTop = first.style.top;
    expect(view.container.querySelector('[data-msgid="m-400"]')).toBeNull();
    host.scrollTop = 63000; fireEvent.scroll(host); frames(4);
    expect(view.container.querySelector('[data-msgid="m-0"]')).toBeNull();
    expect(surface.querySelectorAll('[data-measure-id]').length).toBeLessThan(20);
    expect(surface.style.height).toBe(height);
    act(() => { host.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: ['m-599'] } })); });
    expect(view.container.querySelector('[data-msgid="m-599"]')).not.toBeNull();
    act(() => { host.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } })); });
    expect(view.container.querySelector('[data-msgid="m-599"]')).toBeNull();
    host.scrollTop = 0; fireEvent.scroll(host); frames(4);
    expect(view.container.querySelector<HTMLElement>('[data-measure-id="m-0"]')!.style.top).toBe(firstTop);
    expect(surface.style.height).toBe(height);
    expect(tasks.pending).toBe(0);
  });

  it.each([false, true])('bounds graph cards and keeps full geometry across scrolling (large merge=%s)', merge => {
    const messages = ids.map(message);
    const edges: DemoEdge[] = merge ? ids.map(id => ({ id: `merge-${id}`, relationMessageId: 'merge', relationType: 'merge', relationLabel: '归并',
      from: { messageId: 'anon:merge', selection: { kind: 'whole' } }, to: { messageId: id, selection: { kind: 'whole' } } })) : [];
    if (merge) messages.push({ ...message('merge'), kind: 'relation', relationType: 'merge', relationPayload: { title: '大归并' } });
    const props: GraphViewProps = { messages, edges, draftUnits: [], activeTextSelectId: null, lastClickedMessageId: null, voteStats: {}, ...callbacks };
    const tasks = createWorkbenchDrawingTasks();
    const view = render(<WorkbenchDrawingContext.Provider value={tasks}><div data-workbench-left-panel style={{ overflow: 'auto', height: 500 }}><GraphView {...props} /></div></WorkbenchDrawingContext.Provider>);
    let maximum = 0;
    for (let index = 0; index < 55; index++) {
      frames(); maximum = Math.max(maximum, view.container.querySelectorAll('[data-msgid^="m-"]:not([data-rel-overlay])').length);
    }
    expect(maximum).toBeLessThan(65);
    expect(tasks.pending).toBe(0);
    const host = view.container.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
    const canvas = view.container.querySelector<HTMLElement>('[data-jump-canvas]')!;
    const geometry = [canvas.style.height, canvas.style.width];
    const first = view.container.querySelector<HTMLElement>('[data-msgid="m-0"]')!;
    const position = [first.style.left, first.style.top];
    const mergeFrame = view.container.querySelector<HTMLElement>('[data-msgid="merge"]');
    const mergeGeometry = mergeFrame ? [mergeFrame.style.height, mergeFrame.style.top] : null;
    host.scrollTop = 9000; fireEvent.scroll(host); frames(4);
    expect(view.container.querySelector('[data-msgid="m-0"]')).toBeNull();
    expect(view.container.querySelectorAll('[data-msgid^="m-"]:not([data-rel-overlay])').length).toBeLessThan(30);
    expect([canvas.style.height, canvas.style.width]).toEqual(geometry);
    if (merge) {
      const frame = view.container.querySelector<HTMLElement>('[data-msgid="merge"]')!;
      expect([frame.style.height, frame.style.top]).toEqual(mergeGeometry);
    }
    host.scrollTop = 0; fireEvent.scroll(host); frames(4);
    const returned = view.container.querySelector<HTMLElement>('[data-msgid="m-0"]')!;
    expect([returned.style.left, returned.style.top]).toEqual(position);
    expect([canvas.style.height, canvas.style.width]).toEqual(geometry);
    expect(tasks.pending).toBe(0);
  });

  it('converts a clipped, scaled canvas to local coordinates and coalesces unchanged events', () => {
    let renders = 0;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      return this.dataset.workbenchLeftPanel !== undefined ? new DOMRect(100, 50, 600, 400) : new DOMRect(-200, -1000, 2000, 4000);
    });
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!.get!).mockReturnValue(1000);
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!.get!).mockReturnValue(2000);
    function Probe() {
      renders++;
      const canvas = useRef<HTMLDivElement>(null), viewport = useCanvasViewport(canvas);
      return <div data-workbench-left-panel style={{ overflow: 'auto' }}><div ref={canvas} /><output>{JSON.stringify(viewport)}</output></div>;
    }
    const view = render(<Probe />);
    expect(JSON.parse(view.getByRole('status').textContent!)).toEqual({ x: -100, y: 275, width: 800, height: 700 });
    const before = renders;
    for (let index = 0; index < 20; index++) { fireEvent.scroll(window); fireEvent.resize(window); }
    frames(2);
    expect(renders).toBeLessThanOrEqual(before + 1);
  });

  it('keeps a focused control mounted until keyboard focus leaves its card', () => {
    const view = render(<><button data-outside>外部控件</button><div data-workbench-left-panel style={{ overflow: 'auto', height: 500 }}>
      <VirtualMessageList ids={ids} pinned={pins}>{id => <div data-msgid={id}><button>{id}</button></div>}</VirtualMessageList>
    </div></>);
    frames(50);
    const host = view.container.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
    const button = view.getByRole('button', { name: /^m-0$/ });
    act(() => { button.focus(); });
    host.scrollTop = 63000; fireEvent.scroll(host); frames(3);
    expect(button).toBeInTheDocument();
    expect(document.activeElement).toBe(button);
    act(() => { view.getByRole('button', { name: '外部控件' }).focus(); });
    expect(view.container.querySelector('[data-msgid="m-0"]')).toBeNull();
  });

  it('reveals an offscreen relation decoration without mounting its target card', () => {
    const messages = ids.map(message);
    const edges: DemoEdge[] = [{ id: 'tag-edge', relationMessageId: 'tag', relationType: 'tag', relationLabel: '远处标注',
      from: { messageId: 'anon:tag', selection: { kind: 'whole' } }, to: { messageId: 'm-599', selection: { kind: 'whole' } } }];
    const view = render(<div data-workbench-left-panel style={{ overflow: 'auto', height: 500 }}>
      <GraphView messages={messages} edges={edges} draftUnits={[]} activeTextSelectId={null} lastClickedMessageId={null} voteStats={{}} {...callbacks} />
    </div>);
    frames(55);
    const host = view.container.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
    expect(host.querySelector('[data-jump-msgids~="tag"]')).toBeNull();
    act(() => { host.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: ['tag'] } })); });
    expect(host.querySelector('[data-jump-msgids~="tag"]')).not.toBeNull();
    expect(host.querySelector('[data-msgid="m-599"]:not([data-rel-overlay])')).toBeNull();
    act(() => { host.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } })); });
    expect(host.querySelector('[data-jump-msgids~="tag"]')).toBeNull();
  });
});
