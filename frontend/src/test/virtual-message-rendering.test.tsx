import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VirtualMessageList from '../components/VirtualMessageList';
import GraphView, { type GraphViewProps } from '../components/GraphView';
import { REVEAL_VIRTUAL_MESSAGE, useVirtualMessageMounts } from '../hooks/useVirtualMessageMounts';
import { useCardMeasurements } from '../hooks/useCardMeasurements';
import { createWorkbenchDrawingTasks, WorkbenchDrawingContext } from '../context/WorkbenchDrawingContext';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';
import { useRef } from 'react';
import { useCanvasViewport } from '../hooks/useCanvasViewport';
import { MessageJumpOverlay } from '../components/PopupOverlay';
import { findMessageElements, scrollMsgToCenter, showMessagePulse, MESSAGE_PULSE_DURATION_MS } from '../pages/workbench/actions/scrollNavigation';
import { getMessageJumpDisplay } from '../utils/messageJumpDisplay';

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

  it('finishes measuring the new scene when membership changes remove an unmounted measurement target', () => {
    const tasks = createWorkbenchDrawingTasks();
    function Scene({ changed }: { changed: boolean }) {
      const canvas = useRef<HTMLDivElement>(null), cards = useRef<Record<string, HTMLDivElement | null>>({});
      const heights = useCardMeasurements(canvas, cards);
      const currentIds = changed ? ['destination'] : ['old-member'];
      const virtual = useVirtualMessageMounts(canvas, currentIds, {
        destination: { x: 0, y: 10000, width: 320, height: 100 },
      }, heights, pins);
      return <div data-workbench-left-panel><div ref={canvas} style={{ height: 11000 }}>
        {/* The departing member was still waiting for its layout result. */}
        {changed && virtual.mounted.has('destination') && <div data-msgid="destination"
          ref={element => { cards.current.destination = element; }}>当前实际消息</div>}
        <output>{heights.destination ? '当前消息尺寸已就绪' : '等待测量'}</output>
      </div></div>;
    }
    const renderScene = (changed: boolean) => <WorkbenchDrawingContext.Provider value={tasks}><Scene changed={changed} /></WorkbenchDrawingContext.Provider>;
    const view = render(renderScene(false));
    frames(2);
    expect(tasks.pending).toBeGreaterThan(0);
    view.rerender(renderScene(true));
    frames(8);
    expect(tasks.pending).toBe(0);
    expect(tasks.failure).toBeNull();
    expect(view.getByText('当前消息尺寸已就绪')).toBeInTheDocument();
    expect(view.container.querySelector('[data-msgid="old-member"]')).toBeNull();
  });

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

  it.each((['merge', 'arrange', 'summary'] as const).flatMap(type =>
    ([null, 'merge', 'arrange', 'summary'] as const).flatMap(outer =>
      (['annotation', 'reference', 'reply'] as const).map(dependency => ({ type, outer, dependency })))))(
    'unmasks $type inside $outer with members and $dependency dependants, then keeps the destination visible', ({ type, outer, dependency }) => {
    const memberIds = ids.slice(0, 80);
    const members = memberIds.map(message);
    const edges: DemoEdge[] = memberIds.map(id => ({ id: `${type}-${id}`, relationMessageId: type, relationType: type, relationLabel: type,
      from: { messageId: `anon:${type}`, selection: { kind: 'whole' } }, to: { messageId: id, selection: { kind: 'whole' } } }));
    const organizations: DemoMessage[] = [{ ...message(type), kind: 'relation', relationType: type, relationPayload: { title: type } }];
    if (outer) {
      organizations.push({ ...message('outer'), kind: 'relation', relationType: outer, relationPayload: { title: '外层容器' } });
      edges.push({ id: 'nested', relationMessageId: 'outer', relationType: outer, relationLabel: outer,
        from: { messageId: 'anon:outer', selection: { kind: 'whole' } }, to: { messageId: type, selection: { kind: 'whole' } } });
    }
    const targetId = outer ? 'outer' : type;
    organizations.push({ ...message('dependent-reference'), kind: 'relation', relationType: dependency, sourceMessageId: 'm-79' });
    edges.push({ id: 'dependent-reference', relationMessageId: 'dependent-reference', relationType: dependency, relationLabel: dependency,
      from: { messageId: 'm-79', selection: { kind: 'whole' } }, to: { messageId: 'm-0', selection: { kind: 'whole' } } });
    for (const target of [targetId, type, 'm-79', 'dependent-reference']) for (const stance of ['agree', 'disagree'] as const) {
      const id = `${stance}-${target}`;
      if (organizations.some(message => message.id === id)) continue;
      organizations.push({ ...message(id), kind: 'relation', relationType: stance });
      edges.push({ id, relationMessageId: id, relationType: stance, relationLabel: stance,
        from: { messageId: `anon:${id}`, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } } });
    }
    const expanded = new Set(organizations.filter(message => message.relationType === 'summary').map(message => message.id));
    const view = render(<div data-workbench-left-panel style={{ overflow: 'auto', height: 500 }}>
      <GraphView messages={[...members, ...organizations]}
        edges={edges} draftUnits={[]} activeTextSelectId={null} lastClickedMessageId={targetId} voteStats={{}}
        traceFrameIds={expanded} traceExpandedFrameIds={expanded} {...callbacks} />
    </div>);
    frames(55);
    const host = view.container.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
    expect(host.querySelectorAll('[data-msgid^="m-"]:not([data-rel-overlay])').length).toBeLessThan(memberIds.length);
    act(() => { host.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [targetId] } })); });
    expect(host.querySelectorAll('[data-msgid^="m-"]:not([data-rel-overlay])')).toHaveLength(memberIds.length);
    // A viewport update between positioning and the mask commit must keep members alive.
    host.scrollTop = 1000; fireEvent.scroll(host); frames(4);
    expect(host.querySelector('[data-msgid="m-79"]')).not.toBeNull();
    const target = host.querySelector<HTMLElement>(`[data-msgid="${targetId}"][data-rel-overlay]`)!;
    const display = getMessageJumpDisplay(target, targetId);
    for (const id of memberIds) expect(display.elements?.has(host.querySelector(`[data-msgid="${id}"]:not([data-rel-overlay])`)!)).toBe(true);
    const canvas = host.querySelector<HTMLElement>('[data-jump-canvas]')!;
    const overlay = render(<MessageJumpOverlay messageId={targetId} targetElement={target}
      targetRect={new DOMRect(0, -1000, parseFloat(canvas.style.width), parseFloat(canvas.style.height))} />);
    const regions = [...document.querySelectorAll('[data-message-jump-region]')];
    const uncoveredIds = regions.flatMap(region => region.getAttribute('data-message-jump-region')!.split(/\s+/));
    // Every mounted display component contributes an opening; clipping may
    // remove offscreen members, which must not uncover other UI below the pane.
    expect(uncoveredIds.some(id => memberIds.includes(id))).toBe(true);
    expect(host.querySelector('[data-jump-visual-msgids="dependent-reference"] path')).not.toBeNull();
    for (const id of [targetId, type, 'm-79', 'dependent-reference']) for (const stance of ['赞同', '反对']) {
      const decoration = host.querySelector(`[data-msgid="${id}"][title^="${stance}"], [data-jump-visual-msgids="${id}"][title^="${stance}"]`);
      expect(decoration, `${id}: ${stance}`).not.toBeNull();
      expect(display.elements?.has(decoration!)).toBe(true);
    }
    overlay.unmount();
    act(() => { host.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } })); });
    expect(host.querySelectorAll('[data-msgid^="m-"]:not([data-rel-overlay])').length).toBeLessThan(memberIds.length);
    // Exercise the actual positioning, pulse timer and reveal-release lifecycle.
    Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 },
      scrollWidth: { value: parseFloat(canvas.style.width) }, scrollHeight: { value: parseFloat(canvas.style.height) } });
    const liveOverlay = render(<></>);
    const request = { current: 0 };
    let pulse: { messageId: string; element: HTMLElement; rect: DOMRect } | null = null;
    const pulseDependencies: Parameters<typeof showMessagePulse>[0] = { scrollRequestIdRef: request, messagePulseTimerRef: { current: null as number | null },
      messagePulseRafRef: { current: null as number | null }, leftPanelRef: { current: host as HTMLDivElement }, findMessageElements,
      setMessagePulse: value => {
        pulse = typeof value === 'function' ? value(pulse) : value;
        liveOverlay.rerender(pulse ? <MessageJumpOverlay messageId={pulse.messageId} targetElement={pulse.element} targetRect={pulse.rect} /> : <></>);
      } };
    const completed = vi.fn();
    scrollMsgToCenter({ scrollRequestIdRef: request, pendingScrollMsgIdRef: { current: null }, MAX_SCROLL_ATTEMPTS: 60,
      pendingScrollDependencyIdsRef: { current: [] }, leftPanelRef: { current: host as HTMLDivElement }, scrollRafRef: { current: null },
      findMessageElements, relationsRef: { current: [] }, edgesRef: { current: edges }, cancelScrollRafs: vi.fn(),
      showMessagePulse: (...args) => showMessagePulse(pulseDependencies, ...args) }, targetId, { onComplete: completed });
    frames(8);
    expect(completed).toHaveBeenCalledExactlyOnceWith(true);
    expect(document.querySelector('[data-message-jump-region]')).not.toBeNull();
    expect([...document.querySelectorAll('[data-message-jump-region]')].some(region => region.getAttribute('data-message-jump-region')?.split(/\s+/).includes(targetId))).toBe(true);
    const position = [host.scrollLeft, host.scrollTop];
    const visible = () => {
      const rect = findMessageElements(host, targetId)[0].getBoundingClientRect(), viewport = host.getBoundingClientRect();
      expect(rect.top).toBeGreaterThanOrEqual(viewport.top);
      expect(rect.bottom).toBeLessThanOrEqual(viewport.bottom);
    };
    visible();
    frames(Math.ceil(MESSAGE_PULSE_DURATION_MS / 17) + 5);
    fireEvent.scroll(host); frames(4);
    expect(document.querySelector('[data-message-jump-region]')).toBeNull();
    expect([host.scrollLeft, host.scrollTop]).toEqual(position);
    visible();
    liveOverlay.unmount();
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
    messages.push({ ...message('tag'), kind: 'relation', relationType: 'tag' },
      { ...message('tag-agree'), kind: 'relation', relationType: 'agree' });
    const edges: DemoEdge[] = [{ id: 'tag-edge', relationMessageId: 'tag', relationType: 'tag', relationLabel: '远处标注',
      from: { messageId: 'anon:tag', selection: { kind: 'whole' } }, to: { messageId: 'm-599', selection: { kind: 'whole' } } },
      { id: 'tag-agree', relationMessageId: 'tag-agree', relationType: 'agree', relationLabel: '赞同',
        from: { messageId: 'anon:tag-agree', selection: { kind: 'whole' } }, to: { messageId: 'tag', selection: { kind: 'whole' } } }];
    const view = render(<div data-workbench-left-panel style={{ overflow: 'auto', height: 500 }}>
      <GraphView messages={messages} edges={edges} draftUnits={[]} activeTextSelectId={null} lastClickedMessageId={null} voteStats={{}} {...callbacks} />
    </div>);
    frames(55);
    const host = view.container.querySelector<HTMLElement>('[data-workbench-left-panel]')!;
    expect(host.querySelector('[data-jump-msgids~="tag"]')).toBeNull();
    act(() => { host.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: ['tag'] } })); });
    expect(host.querySelector('[data-jump-msgids~="tag"]')).not.toBeNull();
    expect(host.querySelector('[data-msgid="m-599"]:not([data-rel-overlay])')).toBeNull();
    const target = host.querySelector<HTMLElement>('[data-jump-msgids~="tag"]')!;
    const overlay = render(<MessageJumpOverlay messageId="tag" targetElement={target} targetRect={target.getBoundingClientRect()} />);
    expect(host).toHaveTextContent('远处标注');
    expect(host.querySelector('[data-jump-visual-msgids~="tag"][title^="赞同"]')).not.toBeNull();
    expect(host.querySelector('[data-msgid="m-599"]:not([data-rel-overlay])')).toBeNull();
    expect(document.querySelector('[data-message-jump-overlay]')?.getAttribute('style')).toContain('mask-image');
    overlay.unmount();
    act(() => { host.dispatchEvent(new CustomEvent(REVEAL_VIRTUAL_MESSAGE, { detail: { ids: [] } })); });
    expect(host.querySelector('[data-jump-msgids~="tag"]')).toBeNull();
  });
});
