import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import GestureShortcutManager from '../components/GestureShortcutManager';
import LeaderboardWindow from '../components/LeaderboardWindow';

afterEach(() => vi.restoreAllMocks());

function pointer(target: Element, type: string, x: number, y: number, buttons = 1) {
  fireEvent(target, Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true }), {
    pointerId: 1, pointerType: 'mouse', isPrimary: true,
  }));
}

function checkmark(target: Element, start = true) {
  if (start) pointer(target, 'pointerdown', 20, 20);
  pointer(target, 'pointermove', 20, 20);
  pointer(target, 'pointermove', 40, 60);
  pointer(target, 'pointermove', 80, 20);
  pointer(target, 'pointerup', 80, 20, 0);
}

it('普通区域仍可绘制快捷符并打开输入蒙版', () => {
  render(<><GestureShortcutManager onConfirm={vi.fn()} /><div data-testid="canvas" /></>);
  checkmark(screen.getByTestId('canvas'));
  expect(screen.getByRole('dialog', { name: '快捷符输入蒙版' })).toBeInTheDocument();
});

it.each(['button', 'separator', 'disabled-region'])('从%s开始的拖动不会变成全局快捷符', target => {
  render(<><GestureShortcutManager onConfirm={vi.fn()} />
    {target === 'button' ? <button data-testid="target">按钮</button>
      : <div data-testid="target" role={target === 'separator' ? 'separator' : undefined}
        data-gesture-disabled={target === 'disabled-region' ? 'true' : undefined} />}
  </>);
  checkmark(screen.getByTestId('target'));
  expect(screen.queryByRole('dialog', { name: '快捷符输入蒙版' })).toBeNull();
});

it.each(['lostpointercapture', 'hover'])('鼠标%s后不继续记录旧轨迹，普通点击仍可响应', reason => {
  const clicked = vi.fn();
  render(<><GestureShortcutManager onConfirm={vi.fn()} /><div data-testid="canvas" onClick={clicked} /></>);
  const canvas = screen.getByTestId('canvas');
  pointer(canvas, 'pointerdown', 20, 20);
  if (reason === 'lostpointercapture') pointer(canvas, 'lostpointercapture', 20, 20);
  else pointer(canvas, 'pointermove', 20, 20, 0);
  checkmark(canvas, false);
  expect(screen.queryByRole('dialog', { name: '快捷符输入蒙版' })).toBeNull();
  fireEvent.click(canvas);
  expect(clicked).toHaveBeenCalledOnce();
});

it('排行榜缩放时往返调整手柄不会弹出全局快捷符窗口', () => {
  render(<><GestureShortcutManager onConfirm={vi.fn()} />
    <LeaderboardWindow size={null} contentWidth={640} onSizeChange={vi.fn()} onClose={vi.fn()}
      scrollResetKey="test" header="排行榜" footer="分页"><div>榜单内容</div></LeaderboardWindow>
  </>);
  checkmark(screen.getByRole('separator', { name: '调整排行榜宽高' }));
  expect(screen.queryByRole('dialog', { name: '快捷符输入蒙版' })).toBeNull();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
});
