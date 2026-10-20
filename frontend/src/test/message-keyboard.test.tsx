import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MessageCard from '../components/MessageCard';
import type { DemoMessage } from '../utils/modelBridge';

const message: DemoMessage = { id: 'keyboard-card', author: '测试作者', kind: 'normal', content: '证据与理由可以继续关联。', createdAt: '' };

describe('message card keyboard navigation', () => {
  it('selects by Enter/Space, opens by Shift+Enter and ignores held keys', () => {
    const select = vi.fn(), open = vi.fn();
    render(<MessageCard msg={message} ctx={{}} onClick={select} onDoubleClick={open} />);
    const card = screen.getByRole('group', { name: /消息 keyboard-card/ });
    card.focus();
    expect(card).toHaveFocus();
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.calls[0][1]).toBe(message.id);
    fireEvent.keyDown(card, { key: 'Enter', shiftKey: true });
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(card, { key: 'Enter', repeat: true });
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('leaves nested controls and their keys independent from card selection', () => {
    const select = vi.fn();
    render(<MessageCard msg={message} ctx={{ isWholeSelected: true }} onClick={select}
      headerExtra={<input aria-label="独立输入" />} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: ' ' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: /已选中/ })).toHaveAttribute('aria-label', '消息 keyboard-card，已选中');
  });
});
