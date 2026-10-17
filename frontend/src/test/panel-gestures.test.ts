import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlePanelWheel, handleSplitterPointerDown } from '../pages/workbench/actions/panelGestures';

function panel(top = 0) {
  const element = document.createElement('div');
  Object.defineProperties(element, {
    clientHeight: { value: 200 }, scrollHeight: { value: 1000 },
    clientWidth: { value: 200 }, scrollWidth: { value: 1000 },
  });
  element.scrollTop = top;
  document.body.append(element);
  return element;
}

afterEach(() => document.body.replaceChildren());

describe('linked panel wheel scrolling', () => {
  it.each(['left', 'right'])('keeps scrolling within the %s panel before its boundary', () => {
    const current = panel(200), other = panel(300);
    const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
    handlePanelWheel(current, other, event);
    expect(current.scrollTop).toBe(320);
    expect(other.scrollTop).toBe(300);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    { top: 760, delta: 120, end: 800, otherEnd: 300 },
    { top: 40, delta: -120, end: 0, otherEnd: 300 },
    { top: 800, delta: 120, end: 800, otherEnd: 420 },
    { top: 0, delta: -120, end: 0, otherEnd: 180 },
  ])('hands off only once the panel is at its boundary: top=$top, delta=$delta', ({ top, delta, end, otherEnd }) => {
    const current = panel(top), other = panel(300);
    handlePanelWheel(current, other, new WheelEvent('wheel', { deltaY: delta, cancelable: true }));
    expect(current.scrollTop).toBe(end);
    expect(other.scrollTop).toBe(otherEnd);
  });

  it('scrolls nested content first even when the panel itself is at its boundary', () => {
    const current = panel(800), other = panel(300);
    const textarea = document.createElement('textarea');
    textarea.style.overflowY = 'auto';
    Object.defineProperties(textarea, { clientHeight: { value: 100 }, scrollHeight: { value: 400 } });
    current.append(textarea);
    current.addEventListener('wheel', event => handlePanelWheel(current, other, event), { passive: false });
    const wheel = (deltaY: number) => textarea.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
    expect(wheel(120)).toBe(false);
    expect(textarea.scrollTop).toBe(120);
    expect(current.scrollTop).toBe(800);
    expect(other.scrollTop).toBe(300);
    textarea.scrollTop = 300;
    current.scrollTop = 200;
    expect(wheel(120)).toBe(false);
    expect(current.scrollTop).toBe(320);
    expect(other.scrollTop).toBe(300);
    current.scrollTop = 800;
    expect(wheel(120)).toBe(false);
    expect(other.scrollTop).toBe(420);
  });

  it('hands off within one continuous sequence without a mouse movement', () => {
    const current = panel(24), other = panel(300);
    current.addEventListener('wheel', event => handlePanelWheel(current, other, event), { passive: false });
    for (let index = 0; index < 4; index++) {
      const event = new WheelEvent('wheel', { deltaY: -12, cancelable: true });
      expect(current.dispatchEvent(event)).toBe(false);
    }
    expect(current.scrollTop).toBe(0);
    expect(other.scrollTop).toBe(276);
  });

  it.each([
    { side: 'left', direction: 1 }, { side: 'right', direction: 1 },
    { side: 'left', direction: -1 }, { side: 'right', direction: -1 },
  ])('scrolls the target, each parent and the page before the opposite $side panel (direction $direction)', ({ direction }) => {
    const page = panel(), current = panel(), other = panel(400), parent = panel(), nested = panel();
    page.append(current);
    current.append(parent);
    parent.append(nested);
    parent.style.overflow = nested.style.overflow = 'auto';
    const target = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    nested.append(target);
    const chain = [nested, parent, current, page];
    for (const element of chain) element.scrollTop = direction > 0 ? 760 : 40;
    current.addEventListener('wheel', event => handlePanelWheel(current, other, event, page), { passive: false });
    const edge = direction > 0 ? 800 : 0;
    for (let index = 0; index < chain.length; index++) {
      const event = new WheelEvent('wheel', { deltaY: direction * 40, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(chain.map(element => element.scrollTop)).toEqual(chain.map((_, i) => i <= index ? edge : direction > 0 ? 760 : 40));
      expect(other.scrollTop).toBe(400);
    }
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: direction * 40, bubbles: true, cancelable: true }));
    expect(other.scrollTop).toBe(400 + direction * 40);
    // Reversing the wheel goes back to the target without moving the mouse.
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: direction * -40, bubbles: true, cancelable: true }));
    expect(nested.scrollTop).toBe(edge - direction * 40);
    expect(other.scrollTop).toBe(400 + direction * 40);
  });

  it.each([1, -1])('waits for the next input at each ancestor boundary before handing off (direction %s)', direction => {
    const start = direction > 0 ? 780 : 20;
    const edge = direction > 0 ? 800 : 0;
    const page = panel(start), current = panel(start), other = panel(300), nested = panel(start);
    page.append(current);
    current.append(nested);
    nested.style.overflowY = 'auto';
    current.addEventListener('wheel', event => handlePanelWheel(current, other, event, page), { passive: false });
    const wheel = () => nested.dispatchEvent(new WheelEvent('wheel', { deltaY: direction * 100, bubbles: true, cancelable: true }));
    wheel();
    expect([nested.scrollTop, current.scrollTop, page.scrollTop, other.scrollTop]).toEqual([edge, start, start, 300]);
    wheel();
    expect([nested.scrollTop, current.scrollTop, page.scrollTop, other.scrollTop]).toEqual([edge, edge, start, 300]);
    wheel();
    expect([nested.scrollTop, current.scrollTop, page.scrollTop, other.scrollTop]).toEqual([edge, edge, edge, 300]);
    wheel();
    expect(other.scrollTop).toBe(300 + direction * 100);
  });

  it('accumulates fractional wheel input without leaking browser rounding into the other panel', () => {
    const current = panel(), other = panel(300);
    let roundedTop = 200;
    Object.defineProperty(current, 'scrollTop', { configurable: true, get: () => roundedTop, set: value => { roundedTop = Math.round(value); } });
    for (let index = 0; index < 10; index++) {
      handlePanelWheel(current, other, new WheelEvent('wheel', { deltaY: 0.2, cancelable: true }));
    }
    expect(current.scrollTop).toBe(202);
    expect(other.scrollTop).toBe(300);
    // A scrollbar drag must replace, rather than resume, the saved fractional position.
    current.scrollTop = 400;
    handlePanelWheel(current, other, new WheelEvent('wheel', { deltaY: 10, cancelable: true }));
    expect(current.scrollTop).toBe(410);
    expect(other.scrollTop).toBe(300);
  });

  it('normalizes line and page wheel units', () => {
    const current = panel(800), other = panel();
    handlePanelWheel(current, other, new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, cancelable: true }));
    expect(other.scrollTop).toBe(48);
    handlePanelWheel(current, other, new WheelEvent('wheel', { deltaY: 1, deltaMode: 2, cancelable: true }));
    expect(other.scrollTop).toBe(248);
  });

  it.each([{ ctrlKey: true, deltaY: 100 }, { shiftKey: true, deltaY: 100 }, { deltaX: 100, deltaY: 0 }])('preserves zoom and horizontal gestures: %j', options => {
    const current = panel(200), other = panel(300);
    const event = new WheelEvent('wheel', { ...options, cancelable: true });
    handlePanelWheel(current, other, event);
    expect(current.scrollTop).toBe(200);
    expect(other.scrollTop).toBe(300);
    expect(event.defaultPrevented).toBe(false);
  });
});

it('does not resize a maximum-width right panel when clicking the splitter or moving less than three pixels', () => {
  const row = document.createElement('div');
  const splitter = document.createElement('div');
  row.append(splitter);
  document.body.append(row);
  row.getBoundingClientRect = () => new DOMRect(0, 0, 1560, 1000);
  splitter.getBoundingClientRect = () => new DOMRect(848, 0, 12, 1000);
  splitter.setPointerCapture = vi.fn();
  const dependencies: Parameters<typeof handleSplitterPointerDown>[0] = {
    setSplitterActive: vi.fn(), panelContainerRef: { current: row }, splitterDragRef: { current: null },
    MIN_LEFT_PX: 560, MIN_RIGHT_PX: 280, MAX_RIGHT_PX: 700, BASE_WIDTH: 1024,
    getMinimumContainerWidth: () => 1280, setContainerWidth: vi.fn(), setLeftFlex: vi.fn(), TOTAL_FLEX: 4,
  };
  handleSplitterPointerDown(dependencies, { preventDefault: vi.fn(), currentTarget: splitter, pointerId: 1, clientX: 854 } as unknown as Parameters<typeof handleSplitterPointerDown>[1]);
  for (const clientX of [854, 855, 856]) {
    const move = new Event('pointermove');
    Object.defineProperty(move, 'clientX', { value: clientX });
    document.dispatchEvent(move);
  }
  document.dispatchEvent(new Event('pointerup'));
  expect(dependencies.setContainerWidth).not.toHaveBeenCalled();
  expect(dependencies.setLeftFlex).not.toHaveBeenCalled();
  expect(dependencies.setSplitterActive).toHaveBeenLastCalledWith(false);
});
