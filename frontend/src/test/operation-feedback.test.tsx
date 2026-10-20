import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import OperationFeedback from '../components/OperationFeedback';
import { beginRequestOperation, getOperations, LONG_OPERATION_MS, resetRequestOperations } from '../utils/requestLifecycle';

vi.mock('../context/AuthContext', () => ({ useOptionalAuth: () => ({ user: { id: 'u' } }) }));
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { resetRequestOperations(); vi.useRealTimers(); });

it('shows pending immediately, offers long-wait details, and hides without completing a request', () => {
  render(<OperationFeedback />);
  let ticket!: ReturnType<typeof beginRequestOperation>;
  act(() => { ticket = beginRequestOperation('提交投票', false, 'u'); });
  expect(screen.getByRole('status')).toHaveTextContent('正在处理');
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => vi.advanceTimersByTime(LONG_OPERATION_MS));
  fireEvent.click(screen.getByRole('button', { name: '查看进度' }));
  const hide = screen.getByRole('button', { name: '收起进度' });
  expect(hide).toHaveFocus(); fireEvent.keyDown(hide, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '收起提示' }));
  expect(screen.getByRole('button', { name: '1 项请求进行中' })).toBeInTheDocument();
  expect(getOperations()[0].state).toBe('pending');
  act(() => ticket.finish('uncertain', '结果尚未确认，请核对记录'));
  fireEvent.click(screen.getByRole('button', { name: '查看操作结果' }));
  expect(screen.getByRole('alert')).toHaveTextContent('结果尚未确认');
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
