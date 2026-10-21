import { afterEach, expect, it, vi } from 'vitest';
import { createWorkbenchDrawingTasks, WORKBENCH_DRAWING_TIMEOUT_MS } from '../context/WorkbenchDrawingContext';
import { findMessageElements, scrollMsgToCenter, showMessagePulse } from '../pages/workbench/actions/scrollNavigation';
import { REVEAL_VIRTUAL_MESSAGE } from '../hooks/useVirtualMessageMounts';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('centers a wide merge on its message header after the frame border strips have mounted', () => {
  vi.useFakeTimers();
  const panel = document.createElement('div'), strip = document.createElement('div'), header = document.createElement('div');
  for (const element of [strip, header]) { element.dataset.msgid = 'merge'; element.dataset.relOverlay = 'true'; }
  header.dataset.frameHeader = 'true';
  panel.append(strip, header); document.body.append(panel);
  for (const [name, value] of Object.entries({ clientWidth: 400, clientHeight: 300, scrollWidth: 2000, scrollHeight: 5000 })) {
    Object.defineProperty(panel, name, { value });
  }
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 50, 400, 300));
  vi.spyOn(strip, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 1050 - panel.scrollTop, 1800, 32));
  vi.spyOn(header, 'getBoundingClientRect').mockImplementation(() => new DOMRect(200 - panel.scrollLeft, 1058 - panel.scrollTop, 320, 58));
  const pulse = vi.fn();
  try {
    scrollMsgToCenter({ scrollRequestIdRef: { current: 0 }, pendingScrollMsgIdRef: { current: null }, MAX_SCROLL_ATTEMPTS: 60,
      pendingScrollDependencyIdsRef: { current: [] }, leftPanelRef: { current: panel }, scrollRafRef: { current: null },
      findMessageElements, relationsRef: { current: [] }, edgesRef: { current: [] }, showMessagePulse: pulse, cancelScrollRafs: () => {} }, 'merge');
    vi.advanceTimersByTime(50);
    expect(panel.scrollLeft).toBe(160);
    expect(panel.scrollTop).toBe(887);
    expect(pulse).toHaveBeenCalledWith('merge', header, 1, expect.any(Function));
  } finally { panel.remove(); }
});

it('restores positioning only after pending layout work commits and the browser presents it', () => {
  vi.useFakeTimers();
  const tasks = createWorkbenchDrawingTasks();
  const measurement = tasks.begin('measurement'), positioning = tasks.begin('positioning');
  const restore = vi.fn(() => positioning.release());
  positioning.afterLayout(restore);
  vi.advanceTimersByTime(500);
  expect(restore).not.toHaveBeenCalled();
  measurement.release();
  vi.advanceTimersByTime(16);
  tasks.committed(); // Another layout render must be presented first.
  vi.advanceTimersByTime(16);
  expect(restore).not.toHaveBeenCalled();
  vi.advanceTimersByTime(34);
  expect(restore).toHaveBeenCalledOnce();
  expect(tasks.pending).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['cancel', 'release'] as const)('cleans up a waiting restoration on %s and ignores late measurements', finish => {
  vi.useFakeTimers();
  const tasks = createWorkbenchDrawingTasks();
  const measurement = tasks.begin('measurement'), positioning = tasks.begin('positioning'), restore = vi.fn();
  positioning.afterLayout(restore);
  positioning[finish]();
  measurement.release();
  vi.advanceTimersByTime(WORKBENCH_DRAWING_TIMEOUT_MS + 100);
  expect(restore).not.toHaveBeenCalled();
  expect(tasks.failure).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it('fails a stalled restoration rather than scrolling the page late after the user has resumed work', () => {
  vi.useFakeTimers();
  const tasks = createWorkbenchDrawingTasks();
  const measurement = tasks.begin('measurement'), positioning = tasks.begin('positioning'), restore = vi.fn();
  positioning.afterLayout(restore);
  vi.advanceTimersByTime(WORKBENCH_DRAWING_TIMEOUT_MS);
  expect(tasks.failure).toMatchObject({ kind: 'positioning', reason: 'timeout' });
  measurement.release();
  vi.advanceTimersByTime(100);
  expect(restore).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not announce the new-message mask until card measurement and layout have finished', () => {
  vi.useFakeTimers();
  const tasks = createWorkbenchDrawingTasks();
  const measurement = tasks.begin('measurement'), positioning = tasks.begin('positioning');
  const panel = document.createElement('div'), card = document.createElement('div');
  panel.appendChild(card);
  document.body.appendChild(panel);
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 120, 240, 80));
  const setMessagePulse = vi.fn(), onShown = vi.fn();
  const timer = { current: null as ReturnType<typeof setTimeout> | null };
  try {
    showMessagePulse({
      task: { ...positioning, complete: positioning.release, run: work => work() },
      scrollRequestIdRef: { current: 1 }, messagePulseTimerRef: timer, messagePulseRafRef: { current: null },
      leftPanelRef: { current: panel }, findMessageElements: () => [card], setMessagePulse,
    }, 'sent-message', card, 1, onShown);
    vi.advanceTimersByTime(1000);
    expect(setMessagePulse).not.toHaveBeenCalled();
    expect(onShown).not.toHaveBeenCalled();
    measurement.release();
    vi.advanceTimersByTime(16);
    tasks.committed();
    vi.advanceTimersByTime(16);
    expect(onShown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(34);
    expect(setMessagePulse).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'sent-message', element: card }));
    expect(onShown).toHaveBeenCalledWith(true);
  } finally {
    clearTimeout(timer.current ?? undefined);
    positioning.cancel();
    panel.remove();
  }
});

it('does not let an old mask expiry clear the next navigation or its revealed cards', () => {
  vi.useFakeTimers();
  const panel = document.createElement('div'), first = document.createElement('div'), next = document.createElement('div');
  panel.append(first, next); document.body.append(panel);
  vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 120, 240, 80));
  vi.spyOn(next, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 220, 240, 80));
  const revealed = vi.fn(), setMessagePulse = vi.fn();
  panel.addEventListener(REVEAL_VIRTUAL_MESSAGE, revealed);
  const request = { current: 1 }, timer = { current: null as ReturnType<typeof setTimeout> | null };
  const dependencies = { scrollRequestIdRef: request, messagePulseTimerRef: timer, messagePulseRafRef: { current: null },
    leftPanelRef: { current: panel }, findMessageElements: (_panel: HTMLElement, id: string) => [id === 'first' ? first : next], setMessagePulse };
  try {
    showMessagePulse(dependencies, 'first', first, 1);
    vi.advanceTimersByTime(17);
    expect(setMessagePulse).toHaveBeenCalledOnce();
    request.current = 2;
    // The next placement can be waiting for layout when the old display timer expires.
    vi.advanceTimersByTime(400);
    expect(setMessagePulse).toHaveBeenCalledOnce();
    expect(revealed).not.toHaveBeenCalled();
    showMessagePulse(dependencies, 'next', next, 2);
    vi.advanceTimersByTime(17);
    expect(setMessagePulse).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'next' }));
    vi.advanceTimersByTime(400);
    expect(revealed).toHaveBeenCalledOnce();
    expect((revealed.mock.calls[0][0] as CustomEvent).detail.ids).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { panel.remove(); }
});
