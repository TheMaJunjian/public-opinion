import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import OperationFeedback, { OperationProgressDialog } from '../components/OperationFeedback';
import { beginRequestOperation, getOperations, LONG_OPERATION_MS, resetRequestOperations } from '../utils/requestLifecycle';

vi.mock('../context/AuthContext', () => ({ useOptionalAuth: () => ({ user: { id: 'u' } }) }));
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { resetRequestOperations(); vi.useRealTimers(); });

it('shows pending, long waits and results directly without collapse controls or an extra progress modal', () => {
  render(<OperationFeedback />);
  let ticket!: ReturnType<typeof beginRequestOperation>;
  act(() => { ticket = beginRequestOperation('提交投票', false, 'u'); });
  expect(screen.getByRole('status')).toHaveTextContent('正在处理');
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => vi.advanceTimersByTime(LONG_OPERATION_MS));
  expect(screen.getByRole('status')).toHaveTextContent('仍在等待服务器响应');
  expect(screen.queryByRole('button', { name: /收起|查看进度|显示进度/ })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(getOperations()[0].state).toBe('pending');
  act(() => ticket.finish('uncertain', '结果尚未确认，请核对记录'));
  expect(screen.getByRole('alert')).toHaveTextContent('结果尚未确认');
  fireEvent.click(screen.getByRole('button', { name: '关闭提交投票提示' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(getOperations()).toHaveLength(0);
});

it('does not open a modal or retain completion noise for quick requests, and isolates owners', () => {
  render(<OperationFeedback />);
  act(() => { beginRequestOperation('其他账户', false, 'other'); });
  expect(screen.queryByRole('status')).toBeNull();
  act(() => { beginRequestOperation('快速操作', false, 'u').finish('confirmed'); });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByText('快速操作')).toBeNull();
  act(() => { beginRequestOperation('发送消息', true, 'u'); });
  expect(screen.queryByText('发送消息')).toBeNull();
});

it('keeps progress centered in the changing visible viewport without changing page scrolling or losing keyboard focus', () => {
  const viewport = new EventTarget();
  Object.assign(viewport, { offsetLeft: 80, offsetTop: 120, width: 360, height: 440 });
  vi.stubGlobal('visualViewport', viewport);
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'scroll';
  render(<button>打开进度</button>);
  const trigger = screen.getByRole('button', { name: '打开进度' });
  trigger.focus();
  const restoreFocus = vi.spyOn(trigger, 'focus');
  const view = render(<OperationProgressDialog title="正在绘制">正在更新消息与关系。</OperationProgressDialog>);
  try {
    const dialog = screen.getByRole('dialog', { name: '正在绘制' });
    const layer = dialog.closest('[data-popup-content-layer]')!;
    expect(dialog.closest('[data-prompt-modal]')).not.toBeNull();
    expect(layer).toHaveStyle({ left: '80px', top: '120px', width: '360px', height: '440px' });
    expect(document.body.style.overflow).toBe('scroll');
    const message = dialog.querySelector<HTMLElement>('[tabindex="-1"]')!;
    expect(message).toHaveFocus();
    expect(dialog.querySelector('button')).toBeNull();
    fireEvent.click(layer);
    fireEvent.keyDown(message, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();
    Object.assign(viewport, { offsetLeft: 0, offsetTop: 40, width: 320, height: 240 });
    act(() => { viewport.dispatchEvent(new Event('resize')); });
    expect(layer).toHaveStyle({ left: '0px', top: '40px', width: '320px', height: '240px' });
    expect(message).toHaveFocus();
    view.unmount();
    expect(trigger).toHaveFocus();
    expect(restoreFocus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.body.style.overflow).toBe('scroll');
  } finally {
    view.unmount();
    document.body.style.overflow = previousOverflow;
    vi.unstubAllGlobals();
  }
});
