import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import GestureShortcutManager from '../components/GestureShortcutManager';
import WorkbenchSplitter from '../components/WorkbenchSplitter';
import { useWorkbenchViewport } from '../pages/workbench/useWorkbenchViewport';

function Workbench() {
  const viewport = useWorkbenchViewport({ loading: false });
  return <><GestureShortcutManager onConfirm={vi.fn()} />
    <div ref={viewport.panelContainerRef} data-testid="panels" style={{ width: viewport.effectiveContainerWidth }}>
      <WorkbenchSplitter active={viewport.splitterActive} onPointerDown={viewport.handleSplitterPointerDown} />
    </div></>;
}

function pointer(target: Element, type: string, x: number, y = 20, pointerId = 1) {
  fireEvent(target, Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }), {
    pointerId, pointerType: 'touch', isPrimary: pointerId === 1,
  }));
}

function setup() {
  const view = render(<Workbench />);
  const row = screen.getByTestId('panels');
  const splitter = screen.getByRole('separator', { name: '调整左右窗口宽度' });
  Object.defineProperty(row, 'offsetWidth', { value: 1240 });
  row.getBoundingClientRect = () => new DOMRect(0, 0, 1240, 800);
  splitter.getBoundingClientRect = () => new DOMRect(614, 0, 12, 800);
  let captured = false;
  splitter.setPointerCapture = vi.fn(() => { captured = true; });
  splitter.hasPointerCapture = vi.fn(() => captured);
  splitter.releasePointerCapture = vi.fn(() => { captured = false; });
  return { ...view, row, splitter };
}

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it('keeps a touch drag active through mouse compatibility events while preserving the mobile shortcut entry', () => {
  const { splitter } = setup();
  pointer(splitter.querySelector('i')!, 'pointerdown', 620);
  expect(splitter).toHaveAttribute('data-active', 'true');
  fireEvent.mouseEnter(splitter);
  fireEvent.mouseLeave(splitter);
  expect(splitter).toHaveAttribute('data-active', 'true');
  pointer(splitter, 'pointermove', 620, 20);
  pointer(splitter, 'pointermove', 640, 60);
  pointer(splitter, 'pointermove', 680, 20);
  expect(Number(localStorage.getItem('workbenchLeftFlex'))).toBeCloseTo(4 * 674 / 1228);
  pointer(splitter, 'pointerup', 680);
  expect(splitter).toHaveAttribute('data-active', 'false');
  const input = screen.getByRole('dialog', { name: '快捷符输入蒙版' }).querySelector<HTMLElement>('[data-shortcut-input-mask]')!;
  // Continue the established mobile flow: draw the next shortcut in the mask.
  pointer(input, 'pointerdown', 20, 20);
  pointer(input, 'pointermove', 20, 20);
  pointer(input, 'pointermove', 80, 40);
  pointer(input, 'pointermove', 20, 60);
  pointer(input, 'pointerup', 20, 60);
  expect(screen.getByText('快捷操作：放大界面')).toBeInTheDocument();
});

it('resizes on a straight horizontal touch drag without opening shortcut input', () => {
  const { splitter } = setup();
  pointer(splitter, 'pointerdown', 620);
  pointer(splitter, 'pointermove', 640);
  pointer(splitter, 'pointermove', 680);
  pointer(splitter, 'pointerup', 680);
  expect(Number(localStorage.getItem('workbenchLeftFlex'))).toBeCloseTo(4 * 674 / 1228);
  expect(splitter).toHaveAttribute('data-active', 'false');
  expect(screen.queryByRole('dialog', { name: '快捷符输入蒙版' })).toBeNull();
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('releases the drag on %s and accepts the next touch', type => {
  const { splitter } = setup();
  pointer(splitter, 'pointerdown', 620);
  pointer(splitter, type, 620);
  expect(splitter).toHaveAttribute('data-active', 'false');
  const saved = localStorage.getItem('workbenchLeftFlex');
  pointer(splitter, 'pointermove', 800);
  expect(localStorage.getItem('workbenchLeftFlex')).toBe(saved);
  pointer(splitter, 'pointerdown', 620);
  expect(splitter).toHaveAttribute('data-active', 'true');
  pointer(splitter, 'pointerup', 620);
});

it('ignores other fingers during a drag without ending or moving the first finger’s drag', () => {
  const { splitter } = setup();
  pointer(splitter, 'pointerdown', 620);
  pointer(splitter, 'pointerdown', 650, 20, 2);
  const saved = localStorage.getItem('workbenchLeftFlex');
  pointer(splitter, 'pointermove', 800, 20, 2);
  pointer(splitter, 'pointerup', 800, 20, 2);
  expect(localStorage.getItem('workbenchLeftFlex')).toBe(saved);
  expect(splitter).toHaveAttribute('data-active', 'true');
  pointer(splitter, 'pointermove', 680);
  expect(localStorage.getItem('workbenchLeftFlex')).not.toBe(saved);
  pointer(splitter, 'pointerup', 680);
});

it('releases document listeners when the window loses focus or the workbench unmounts', () => {
  const { splitter, unmount } = setup();
  const remove = vi.spyOn(document, 'removeEventListener');
  pointer(splitter, 'pointerdown', 620);
  act(() => window.dispatchEvent(new Event('blur')));
  expect(splitter).toHaveAttribute('data-active', 'false');
  expect(remove).toHaveBeenCalledWith('pointermove', expect.any(Function));
  remove.mockClear();
  pointer(splitter, 'pointerdown', 620);
  unmount();
  expect(remove).toHaveBeenCalledWith('pointermove', expect.any(Function));
});
