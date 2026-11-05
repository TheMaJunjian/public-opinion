import { afterEach, expect, it, vi } from 'vitest';
import { comparisonNavigationTarget, navigateComparisonPane } from '../pages/workbench/actions/comparisonNavigation';
import { createWorkbenchDrawingTasks, type WorkbenchDrawingTask } from '../context/WorkbenchDrawingContext';
import { REVEAL_VIRTUAL_MESSAGE, type VirtualMessageRevealDetail } from '../hooks/useVirtualMessageMounts';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';
import type { MessagePulse } from '../pages/workbench/actions/scrollNavigation';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.replaceChildren(); });

function pane() {
  const viewport = document.createElement('div'); viewport.dataset.comparisonViewport = 'agree'; viewport.style.overflow = 'auto';
  document.body.append(viewport);
  for (const [key, value] of Object.entries({ clientWidth: 400, offsetWidth: 400, clientHeight: 300, offsetHeight: 300, scrollWidth: 4000, scrollHeight: 5000 })) {
    Object.defineProperty(viewport, key, { configurable: true, value });
  }
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 300));
  return viewport;
}
function card(viewport: HTMLElement, id: string, x: number, y: number, width = 200, height = 80) {
  const element = document.createElement('div'); element.dataset.msgid = id; viewport.append(element);
  vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => new DOMRect(x - viewport.scrollLeft, 100 + y - viewport.scrollTop, width, height));
  return element;
}
function tasks() {
  const manager = createWorkbenchDrawingTasks();
  const start = (): WorkbenchDrawingTask => {
    const task = manager.begin('positioning');
    return { ...task, complete: task.release, run: work => { if (task.active) work(); } };
  };
  return { manager, start };
}

it('waits for virtual mounting, frame reveal and layout before independently centering both sides', () => {
  vi.useFakeTimers();
  const left = pane(), right = pane(), { manager, start } = tasks();
  const measurement = manager.begin('measurement');
  card(left, 'target', 800, 1200);
  let mounted = false;
  right.addEventListener(REVEAL_VIRTUAL_MESSAGE, event => {
    if (mounted) return;
    (event as CustomEvent<VirtualMessageRevealDetail>).detail.positioningPending = true;
    mounted = true;
    requestAnimationFrame(() => { card(right, 'target', 1700, 2400); });
  });
  const cancelLeft = navigateComparisonPane(left, 'target', [], start);
  const cancelRight = navigateComparisonPane(right, 'target', [], start);
  vi.advanceTimersByTime(100);
  expect(left.scrollTop).toBe(0); expect(right.scrollTop).toBe(0);
  measurement.release(); vi.advanceTimersByTime(200);
  expect(left.scrollLeft).toBe(700); expect(left.scrollTop).toBe(1090);
  expect(right.scrollLeft).toBe(1600); expect(right.scrollTop).toBe(2290);
  expect(manager.pending).toBe(0);
  cancelLeft(); cancelRight();
});

it('cancels an older difference before delayed layout can pull either pane back', () => {
  vi.useFakeTimers();
  const viewport = pane(), { manager, start } = tasks();
  card(viewport, 'first', 800, 1200); card(viewport, 'second', 1700, 2400);
  const measurement = manager.begin('measurement');
  const cancel = navigateComparisonPane(viewport, 'first', [], start);
  cancel();
  navigateComparisonPane(viewport, 'second', [], start);
  measurement.release(); vi.advanceTimersByTime(200);
  expect(viewport.scrollTop).toBe(2290); expect(viewport.scrollLeft).toBe(1600);
  expect(manager.pending).toBe(0);
  viewport.scrollTop = 350; viewport.scrollLeft = 250; viewport.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(200);
  expect(viewport.scrollTop).toBe(350); expect(viewport.scrollLeft).toBe(250);
});

it('aligns oversized messages to their beginning and clamps destinations to the pane boundary', () => {
  vi.useFakeTimers();
  const viewport = pane(), { start } = tasks();
  card(viewport, 'long', 800, 1200, 900, 1000);
  navigateComparisonPane(viewport, 'long', [], start); vi.advanceTimersByTime(150);
  expect(viewport.scrollLeft).toBe(800); expect(viewport.scrollTop).toBe(1200);
  card(viewport, 'end', 3900, 4900, 100, 100);
  navigateComparisonPane(viewport, 'end', [], start); vi.advanceTimersByTime(150);
  expect(viewport.scrollLeft).toBe(3600); expect(viewport.scrollTop).toBe(4700);
});

it('locates the explicit absence notice when there is no surviving context', () => {
  vi.useFakeTimers();
  const viewport = pane(), { manager, start } = tasks();
  viewport.scrollTop = 2000; viewport.scrollLeft = 1000;
  const notice = card(viewport, 'notice', 0, 0); notice.removeAttribute('data-msgid'); notice.dataset.comparisonMissing = 'removed';
  const pulse = vi.fn();
  navigateComparisonPane(viewport, 'removed', [], start, true, pulse); vi.advanceTimersByTime(150);
  expect(viewport.scrollTop).toBe(0); expect(viewport.scrollLeft).toBe(0);
  expect(manager.pending).toBe(0);
  expect(pulse).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'removed', element: notice }));
  const release = vi.fn(); viewport.addEventListener(REVEAL_VIRTUAL_MESSAGE, release);
  vi.advanceTimersByTime(500);
  expect(release).not.toHaveBeenCalled();
});

it('shows no prompt before layout or for a cancelled target, and clears the current prompt on cleanup', () => {
  vi.useFakeTimers();
  const viewport = pane(), { manager, start } = tasks(), pulse = vi.fn();
  card(viewport, 'first', 800, 1200); const second = card(viewport, 'second', 1700, 2400);
  const measurement = manager.begin('measurement');
  const cancelFirst = navigateComparisonPane(viewport, 'first', [], start, false, pulse);
  vi.advanceTimersByTime(100);
  expect(pulse).not.toHaveBeenCalled();
  cancelFirst();
  const cancelSecond = navigateComparisonPane(viewport, 'second', [], start, false, pulse);
  measurement.release(); vi.advanceTimersByTime(200);
  const prompts = pulse.mock.calls.map(([value]) => value).filter((value): value is MessagePulse => !!value && typeof value !== 'function');
  expect(prompts).toHaveLength(1); expect(prompts[0]).toMatchObject({ messageId: 'second', element: second });
  cancelSecond(); expect(pulse).toHaveBeenLastCalledWith(null);
  const calls = pulse.mock.calls.length; vi.advanceTimersByTime(600);
  expect(pulse).toHaveBeenCalledTimes(calls);
});

it('chooses the nearest surviving frame, handles cycles, and falls back to a removed decoration’s host', () => {
  const messages = ['outer', 'inner', 'host'].map(id => ({ id } as DemoMessage));
  const member = (parent: string, child: string): DemoEdge => ({ relationMessageId: parent, relationType: 'classify', to: { messageId: child }, from: { messageId: `anon:${parent}` } } as DemoEdge);
  const edges = [member('inner', 'removed'), member('outer', 'inner'), member('inner', 'outer')];
  expect(comparisonNavigationTarget('removed', messages, edges)).toEqual({ id: 'inner', missing: true });
  expect(comparisonNavigationTarget('removed', messages, edges, new Set(['inner']))).toEqual({ id: 'outer', missing: true });
  expect(comparisonNavigationTarget('removed', [], edges)).toEqual({ id: null, missing: true });
  expect(comparisonNavigationTarget('inner', messages, edges)).toEqual({ id: 'inner', missing: false });
  expect(comparisonNavigationTarget('tag', messages, [{ ...member('tag', 'host'), relationType: 'tag' }])).toEqual({ id: 'host', missing: true });
});
