import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ThemeTierPreview from '../theme/ThemeTierPreview';

describe('paper type and tier preview', () => {
  it('shows the same selected type across all four tiers without editing workbench data', () => {
    const { container } = render(<ThemeTierPreview theme="opus-paper" />);
    fireEvent.change(screen.getByLabelText('预览消息类型'), { target: { value: 'summary' } });
    const cards = container.querySelectorAll('.stake-tier-example');
    expect([...cards].map(card => card.getAttribute('data-stake-level'))).toEqual(['0', '1', '2', '3']);
    expect([...container.querySelectorAll('.theme-carrier-heading small')].map(label => label.textContent)).toEqual([
      '小于 1,000 点', '1,000–99,999 点', '100,000–999,999 点', '1,000,000 点及以上',
    ]);
    expect([...cards].every(card => card.getAttribute('data-skin-type') === 'summary')).toBe(true);
    fireEvent.click(screen.getByLabelText('选中'));
    fireEvent.click(screen.getByLabelText('叠加定位、片段与已阅'));
    expect(container.querySelectorAll('.stake-tier-example[data-whole-selected="true"][data-view-target="true"]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-fragment-selected="true"]')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: '有向边' }));
    expect(container.querySelectorAll('.graph-edge-label[data-label-selection="whole"]')).toHaveLength(4);
    fireEvent.change(screen.getByLabelText('预览消息类型'), { target: { value: 'reply' } });
    expect(container.querySelectorAll('.graph-edge-label[data-relation-type="reply"]')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: '装饰' }));
    expect(container.querySelectorAll('[data-skin-decoration="agree"][data-skin-selected="true"]')).toHaveLength(4);
  });

  it('preserves the arena preview and original theme behavior', () => {
    const { container, rerender } = render(<ThemeTierPreview theme="gpt-arena" />);
    expect(screen.queryByLabelText('预览消息类型')).not.toBeInTheDocument();
    expect(container.querySelector('[data-skin-type]')).toBeNull();
    expect(screen.getByText('星铸')).toBeInTheDocument();
    rerender(<ThemeTierPreview theme="gpt" />);
    expect(container.querySelector('.theme-carrier-preview')).toBeNull();
  });
});
