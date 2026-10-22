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

describe('independent panel wheel scrolling', () => {
  it.each(['top', 'left'].flatMap(axis => [1, -1].map(direction => ({ axis, direction }))))(
    'keeps the other viewport frozen until the $axis boundary, then hands off continuously and returns on reversal (direction $direction)', ({ axis, direction }) => {
      const current = panel(), other = panel(), page = panel();
      const position = axis === 'top' ? 'scrollTop' : 'scrollLeft';
      const edge = direction > 0 ? 800 : 0;
      current[position] = 400; other[position] = 300; page[position] = 400;
      const wheel = (amount: number) => handlePanelWheel(current, new WheelEvent('wheel', {
        [axis === 'top' ? 'deltaY' : 'deltaX']: direction * amount, cancelable: true,
      }), [other, page]);
      const positions = () => [current[position], other[position], page[position]];
      wheel(100);
      expect(positions()).toEqual([400 + direction * 100, 300, 400]);
      current[position] = edge - direction * 20;
      wheel(60);
      expect(positions()).toEqual([edge, 300 + direction * 40, 400]);
      other[position] = edge - direction * 10;
      wheel(60);
      expect(positions()).toEqual([edge, edge, 400 + direction * 50]);
      wheel(-30);
      expect(positions()).toEqual([edge - direction * 30, edge, 400 + direction * 50]);
    },
  );

  it('forwards the fractional remainder to the next viewport before the page', () => {
    const current = panel(), other = panel(300), page = panel(400);
    let roundedTop = 799.8;
    Object.defineProperty(current, 'scrollTop', { configurable: true, get: () => roundedTop, set: value => { roundedTop = Math.round(value); } });
    handlePanelWheel(current, new WheelEvent('wheel', { deltaY: 0.5, cancelable: true }), [other, page]);
    expect(current.scrollTop).toBe(800);
    expect(other.scrollTop).toBeCloseTo(300.3);
    expect(page.scrollTop).toBe(400);
  });

  it.each(['left', 'right'])('scrolls only the %s viewport while it has room', () => {
    const current = panel(200), other = panel(300), page = panel(400);
    const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
    handlePanelWheel(current, event, [page]);
    expect([current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([320, 300, 400]);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    { top: 760, delta: 120, end: 800, pageEnd: 480 },
    { top: 40, delta: -120, end: 0, pageEnd: 320 },
    { top: 800, delta: 120, end: 800, pageEnd: 520 },
    { top: 0, delta: -120, end: 0, pageEnd: 280 },
  ])('hands only the remainder to the page: top=$top, delta=$delta', ({ top, delta, end, pageEnd }) => {
    const current = panel(top), other = panel(300), page = panel(400);
    handlePanelWheel(current, new WheelEvent('wheel', { deltaY: delta, cancelable: true }), [page]);
    expect([current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([end, 300, pageEnd]);
  });

  it.each([1, -1])('scrolls nested ancestors and the current viewport before the page, keeping its sibling frozen (direction %s)', direction => {
    const page = panel(400), current = panel(), other = panel(300), parent = panel(), nested = panel();
    page.append(current, other); current.append(parent); parent.append(nested);
    parent.style.overflow = nested.style.overflow = 'auto';
    const target = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    nested.append(target);
    const chain = [nested, parent, current];
    const edge = direction > 0 ? 800 : 0;
    for (const element of chain) element.scrollTop = edge - direction * 40;
    current.addEventListener('wheel', event => handlePanelWheel(current, event, [page]), { passive: false });
    const wheel = (amount: number) => target.dispatchEvent(new WheelEvent('wheel', { deltaY: direction * amount, bubbles: true, cancelable: true }));
    for (let index = 0; index < chain.length; index++) {
      wheel(40);
      expect(chain.map(element => element.scrollTop)).toEqual(chain.map((_, i) => i <= index ? edge : edge - direction * 40));
      expect([other.scrollTop, page.scrollTop]).toEqual([300, 400]);
    }
    wheel(40);
    expect([other.scrollTop, page.scrollTop]).toEqual([300, 400 + direction * 40]);
    wheel(-20);
    expect(nested.scrollTop).toBe(edge - direction * 20);
    expect([other.scrollTop, page.scrollTop]).toEqual([300, 400 + direction * 40]);
  });

  it.each([1, -1])('passes one input through nested and viewport boundaries with no sibling handoff (direction %s)', direction => {
    const start = direction > 0 ? 780 : 20, edge = direction > 0 ? 800 : 0;
    const current = panel(start), nested = panel(start), other = panel(300), page = panel(400);
    current.append(nested); nested.style.overflowY = 'auto';
    current.addEventListener('wheel', event => handlePanelWheel(current, event, [page]));
    nested.dispatchEvent(new WheelEvent('wheel', { deltaY: direction * 100, bubbles: true, cancelable: true }));
    expect([nested.scrollTop, current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([edge, edge, 300, 400 + direction * 60]);
  });

  it.each([1, -1])('hands horizontal overflow to the page while freezing the sibling (direction %s)', direction => {
    const page = panel(), current = panel(), other = panel(), nested = panel();
    current.append(nested); nested.style.overflowX = 'auto';
    nested.scrollLeft = direction > 0 ? 790 : 10;
    current.scrollLeft = direction > 0 ? 780 : 20;
    other.scrollLeft = page.scrollLeft = 300;
    current.addEventListener('wheel', event => handlePanelWheel(current, event, [page]));
    nested.dispatchEvent(new WheelEvent('wheel', { deltaX: direction * 100, bubbles: true, cancelable: true }));
    expect([nested.scrollLeft, current.scrollLeft, other.scrollLeft, page.scrollLeft]).toEqual([
      direction > 0 ? 800 : 0, direction > 0 ? 800 : 0, 300, 300 + direction * 70,
    ]);
    expect([nested.scrollTop, current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([0, 0, 0, 0]);
  });

  it('passes horizontal and vertical remainders independently', () => {
    const page = panel(300), current = panel(780), nested = panel(795), other = panel(300);
    current.append(nested); nested.style.overflow = 'auto';
    nested.scrollLeft = 790; current.scrollLeft = 780; page.scrollLeft = other.scrollLeft = 300;
    current.addEventListener('wheel', event => handlePanelWheel(current, event, [page]));
    nested.dispatchEvent(new WheelEvent('wheel', { deltaX: 100, deltaY: 100, bubbles: true, cancelable: true }));
    expect([nested.scrollLeft, current.scrollLeft, other.scrollLeft, page.scrollLeft]).toEqual([800, 800, 300, 370]);
    expect([nested.scrollTop, current.scrollTop, other.scrollTop, page.scrollTop]).toEqual([800, 800, 300, 375]);
  });

  it('routes Shift plus a vertical wheel to horizontal scrolling', () => {
    const current = panel(), other = panel(), page = panel();
    current.scrollLeft = 790; other.scrollLeft = page.scrollLeft = 300;
    const event = new WheelEvent('wheel', { deltaY: 50, shiftKey: true, cancelable: true });
    handlePanelWheel(current, event, [page]);
    expect([current.scrollLeft, other.scrollLeft, page.scrollLeft, current.scrollTop]).toEqual([800, 300, 340, 0]);
  });

  it('accumulates fractional input and respects a subsequent scrollbar drag', () => {
    const current = panel(), page = panel(300);
    let roundedTop = 200;
    Object.defineProperty(current, 'scrollTop', { configurable: true, get: () => roundedTop, set: value => { roundedTop = Math.round(value); } });
    for (let index = 0; index < 10; index++) handlePanelWheel(current, new WheelEvent('wheel', { deltaY: 0.2, cancelable: true }), [page]);
    expect([current.scrollTop, page.scrollTop]).toEqual([202, 300]);
    current.scrollTop = 400;
    handlePanelWheel(current, new WheelEvent('wheel', { deltaY: 10, cancelable: true }), [page]);
    expect([current.scrollTop, page.scrollTop]).toEqual([410, 300]);
  });

  it('hands off only the fractional remainder at a boundary', () => {
    const current = panel(), page = panel(300);
    let roundedTop = 799.8;
    Object.defineProperty(current, 'scrollTop', { configurable: true, get: () => roundedTop, set: value => { roundedTop = Math.round(value); } });
    handlePanelWheel(current, new WheelEvent('wheel', { deltaY: 0.5, cancelable: true }), [page]);
    expect(current.scrollTop).toBe(800);
    expect(page.scrollTop).toBeCloseTo(300.3);
  });

  it('normalizes line and page wheel units', () => {
    const current = panel(800), page = panel();
    handlePanelWheel(current, new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, cancelable: true }), [page]);
    expect(page.scrollTop).toBe(48);
    handlePanelWheel(current, new WheelEvent('wheel', { deltaY: 1, deltaMode: 2, cancelable: true }), [page]);
    expect(page.scrollTop).toBe(248);
  });

  it.each([{ ctrlKey: true, deltaY: 100 }, { deltaX: 0, deltaY: 0 }])('preserves zoom and empty input: %j', options => {
    const current = panel(200), page = panel(300);
    const event = new WheelEvent('wheel', { ...options, cancelable: true });
    handlePanelWheel(current, event, [page]);
    expect([current.scrollTop, page.scrollTop, event.defaultPrevented]).toEqual([200, 300, false]);
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
    Object.defineProperty(move, 'pointerId', { value: 1 });
    Object.defineProperty(move, 'clientX', { value: clientX });
    document.dispatchEvent(move);
  }
  document.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 1 }));
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
  const move = Object.assign(new Event('pointermove'), { pointerId: 1, clientX: 804 }); document.dispatchEvent(move);
  document.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 1 }));
  expect(dependencies.setContainerWidth).toHaveBeenLastCalledWith(1600);
  expect(dependencies.setLeftFlex).toHaveBeenLastCalledWith(4 * 1000 / 1588);
});
