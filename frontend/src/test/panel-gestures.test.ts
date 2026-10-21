import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleLeftPanelTouchEnd, handleLeftPanelTouchMove, handleLeftPanelTouchStart, handlePanelWheel, handleSplitterPointerDown } from '../pages/workbench/actions/panelGestures';

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

it('leaves vertical swipes in the left graph to page scrolling while handing off horizontal edge swipes', () => {
  const left = panel();
  left.scrollLeft = 800;
  const page = document.documentElement;
  const originalScrollingElement = Object.getOwnPropertyDescriptor(document, 'scrollingElement');
  Object.defineProperty(document, 'scrollingElement', { configurable: true, value: page });
  const pageWidth = vi.spyOn(page, 'scrollWidth', 'get').mockReturnValue(1200);
  const viewportWidth = vi.spyOn(page, 'clientWidth', 'get').mockReturnValue(400);
  const touchRef: Parameters<typeof handleLeftPanelTouchStart>[0]['leftPanelTouchRef'] = { current: null };
  const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }], preventDefault: vi.fn() });
  try {
    handleLeftPanelTouchStart({ leftPanelTouchRef: touchRef }, touch(100, 100) as unknown as Parameters<typeof handleLeftPanelTouchStart>[1]);
    const vertical = touch(90, 60);
    handleLeftPanelTouchMove({ leftPanelTouchRef: touchRef, leftPanelRef: { current: left } }, vertical as unknown as Parameters<typeof handleLeftPanelTouchMove>[1]);
    expect(vertical.preventDefault).not.toHaveBeenCalled();
    expect(page.scrollLeft).toBe(0);

    handleLeftPanelTouchEnd({ leftPanelTouchRef: touchRef });
    handleLeftPanelTouchStart({ leftPanelTouchRef: touchRef }, touch(100, 100) as unknown as Parameters<typeof handleLeftPanelTouchStart>[1]);
    const horizontal = touch(60, 98);
    handleLeftPanelTouchMove({ leftPanelTouchRef: touchRef, leftPanelRef: { current: left } }, horizontal as unknown as Parameters<typeof handleLeftPanelTouchMove>[1]);
    expect(horizontal.preventDefault).toHaveBeenCalledOnce();
    expect(page.scrollLeft).toBe(40);
  } finally {
    if (originalScrollingElement) Object.defineProperty(document, 'scrollingElement', originalScrollingElement);
    else Reflect.deleteProperty(document, 'scrollingElement');
    pageWidth.mockRestore();
    viewportWidth.mockRestore();
    page.scrollLeft = 0;
  }
});

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
    { top: 760, delta: 120, end: 800, otherEnd: 380 },
    { top: 40, delta: -120, end: 0, otherEnd: 220 },
    { top: 800, delta: 120, end: 800, otherEnd: 420 },
    { top: 0, delta: -120, end: 0, otherEnd: 180 },
  ])('passes the unused vertical distance at the panel boundary: top=$top, delta=$delta', ({ top, delta, end, otherEnd }) => {
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
  ])('scrolls the target and its parents before the opposite $side panel, and immediately returns on reversal (direction $direction)', ({ direction }) => {
    const page = panel(), current = panel(), other = panel(400), parent = panel(), nested = panel();
    page.append(current);
    current.append(parent);
    parent.append(nested);
    parent.style.overflow = nested.style.overflow = 'auto';
    const target = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    nested.append(target);
    const chain = [nested, parent, current];
    page.scrollTop = 400;
    for (const element of chain) element.scrollTop = direction > 0 ? 760 : 40;
    current.addEventListener('wheel', event => handlePanelWheel(current, other, event, page), { passive: false });
    const edge = direction > 0 ? 800 : 0;
    for (let index = 0; index < chain.length; index++) {
      const event = new WheelEvent('wheel', { deltaY: direction * 40, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(chain.map(element => element.scrollTop)).toEqual(chain.map((_, i) => i <= index ? edge : direction > 0 ? 760 : 40));
      expect(other.scrollTop).toBe(400);
      expect(page.scrollTop).toBe(400);
    }
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: direction * 40, bubbles: true, cancelable: true }));
    expect(other.scrollTop).toBe(400 + direction * 40);
    expect(page.scrollTop).toBe(400);
    // Reversing the wheel goes back to the target without moving the mouse.
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: direction * -40, bubbles: true, cancelable: true }));
    expect(nested.scrollTop).toBe(edge - direction * 40);
    expect(other.scrollTop).toBe(400 + direction * 40);
  });

  it.each([1, -1])('passes one wheel input through each vertical boundary (direction %s)', direction => {
    const start = direction > 0 ? 780 : 20;
    const edge = direction > 0 ? 800 : 0;
    const page = panel(start), current = panel(start), other = panel(300), nested = panel(start);
    page.append(current);
    current.append(nested);
    nested.style.overflowY = 'auto';
    current.addEventListener('wheel', event => handlePanelWheel(current, other, event, page), { passive: false });
    const wheel = () => nested.dispatchEvent(new WheelEvent('wheel', { deltaY: direction * 100, bubbles: true, cancelable: true }));
    wheel();
    expect([nested.scrollTop, current.scrollTop, page.scrollTop, other.scrollTop]).toEqual([edge, edge, start, 300 + direction * 60]);
    wheel();
    expect(other.scrollTop).toBe(300 + direction * 160);
  });

  it.each([1, -1])('passes one wheel input through each horizontal boundary (direction %s)', direction => {
    const page = panel(), current = panel(), other = panel(), nested = panel();
    page.append(current);
    current.append(nested);
    nested.style.overflowX = 'auto';
    const start = direction > 0 ? [790, 780, 795] : [10, 20, 5];
    [nested, current, page].forEach((element, index) => { element.scrollLeft = start[index]; });
    other.scrollLeft = 300;
    current.addEventListener('wheel', event => handlePanelWheel(current, other, event, page), { passive: false });
    const event = new WheelEvent('wheel', { deltaX: direction * 100, bubbles: true, cancelable: true });
    nested.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect([nested.scrollLeft, current.scrollLeft, page.scrollLeft, other.scrollLeft]).toEqual([
      direction > 0 ? 800 : 0, direction > 0 ? 800 : 0, start[2], 300 + direction * 70,
    ]);
    expect([nested.scrollTop, current.scrollTop, page.scrollTop, other.scrollTop]).toEqual([0, 0, 0, 0]);
  });

  it('passes horizontal and vertical remainders independently in one wheel input', () => {
    const page = panel(), current = panel(), other = panel(), nested = panel();
    page.append(current);
    current.append(nested);
    nested.style.overflow = 'auto';
    nested.scrollLeft = 790;
    nested.scrollTop = 795;
    current.scrollLeft = 780;
    current.scrollTop = 780;
    page.scrollLeft = 795;
    page.scrollTop = 790;
    other.scrollLeft = other.scrollTop = 300;
    current.addEventListener('wheel', event => handlePanelWheel(current, other, event, page), { passive: false });
    nested.dispatchEvent(new WheelEvent('wheel', { deltaX: 100, deltaY: 100, bubbles: true, cancelable: true }));
    expect([nested.scrollLeft, current.scrollLeft, page.scrollLeft, other.scrollLeft]).toEqual([800, 800, 795, 370]);
    expect([nested.scrollTop, current.scrollTop, page.scrollTop, other.scrollTop]).toEqual([800, 800, 790, 375]);
  });

  it.each([1, -1])('hands off to the page only after both panels reach their boundary (direction %s)', direction => {
    const edge = direction > 0 ? 800 : 0;
    const current = panel(edge), other = panel(edge - direction * 20), page = panel(400);
    handlePanelWheel(current, other, new WheelEvent('wheel', { deltaY: direction * 60, cancelable: true }), page);
    expect([current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge, edge, 400 + direction * 40]);
    handlePanelWheel(current, other, new WheelEvent('wheel', { deltaY: direction * -30, cancelable: true }), page);
    expect([current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge - direction * 30, edge, 400 + direction * 40]);
  });

  it('routes Shift plus a vertical wheel to horizontal scrolling and passes the remainder', () => {
    const current = panel(), other = panel();
    current.scrollLeft = 790;
    other.scrollLeft = 300;
    const event = new WheelEvent('wheel', { deltaY: 50, shiftKey: true, cancelable: true });
    handlePanelWheel(current, other, event);
    expect(event.defaultPrevented).toBe(true);
    expect(current.scrollLeft).toBe(800);
    expect(other.scrollLeft).toBe(340);
    expect(current.scrollTop).toBe(0);
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

  it('passes only the fractional remainder when rounding reaches a boundary', () => {
    const current = panel(), other = panel(300);
    let roundedTop = 799.8;
    Object.defineProperty(current, 'scrollTop', { configurable: true, get: () => roundedTop, set: value => { roundedTop = Math.round(value); } });
    handlePanelWheel(current, other, new WheelEvent('wheel', { deltaY: 0.5, cancelable: true }));
    expect(current.scrollTop).toBe(800);
    expect(other.scrollTop).toBeCloseTo(300.3);
  });

  it('normalizes line and page wheel units', () => {
    const current = panel(800), other = panel();
    handlePanelWheel(current, other, new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, cancelable: true }));
    expect(other.scrollTop).toBe(48);
    handlePanelWheel(current, other, new WheelEvent('wheel', { deltaY: 1, deltaMode: 2, cancelable: true }));
    expect(other.scrollTop).toBe(248);
  });

  it.each([{ ctrlKey: true, deltaY: 100 }, { deltaX: 0, deltaY: 0 }])('preserves zoom and empty gestures: %j', options => {
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

it('keeps splitter dragging in layout pixels when the interface is scaled', () => {
  const row = document.createElement('div'), splitter = document.createElement('div');
  row.append(splitter); document.body.append(row);
  Object.defineProperty(row, 'offsetWidth', { value: 1600 });
  row.getBoundingClientRect = () => new DOMRect(0, 0, 1280, 800);
  splitter.getBoundingClientRect = () => new DOMRect(720, 0, 9.6, 800);
  splitter.setPointerCapture = vi.fn();
  const dependencies: Parameters<typeof handleSplitterPointerDown>[0] = {
    setSplitterActive: vi.fn(), panelContainerRef: { current: row }, splitterDragRef: { current: null },
    MIN_LEFT_PX: 560, MIN_RIGHT_PX: 280, MAX_RIGHT_PX: 700, BASE_WIDTH: 1024,
    getMinimumContainerWidth: () => 1600, setContainerWidth: vi.fn(), setLeftFlex: vi.fn(), TOTAL_FLEX: 4,
  };
  handleSplitterPointerDown(dependencies, { preventDefault: vi.fn(), currentTarget: splitter, pointerId: 1, clientX: 724 } as unknown as Parameters<typeof handleSplitterPointerDown>[1]);
  const move = new Event('pointermove'); Object.defineProperty(move, 'clientX', { value: 804 }); document.dispatchEvent(move);
  document.dispatchEvent(new Event('pointerup'));
  expect(dependencies.setContainerWidth).toHaveBeenLastCalledWith(1600);
  expect(dependencies.setLeftFlex).toHaveBeenLastCalledWith(4 * 1000 / 1588);
});
