import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GuideOverlay from '../components/GuideOverlay';

function renderGuide() {
  const onClose = vi.fn();
  render(
    <>
      <div data-guide-right-panel="true">
        <textarea data-guide-message-input="true" />
        <input data-guide-contribution-stake="true" />
        <span data-guide-contribution-consumption="true">总计 10 点</span>
        <button data-guide-text-message-send="true">发送</button>
      </div>
      <GuideOverlay open onClose={onClose} />
    </>,
  );
  return { onClose };
}

describe('GuideOverlay', () => {
  it('keeps the first next button disabled until text is entered', async () => {
    renderGuide();

    const nextButton = await screen.findByRole('button', { name: '下一步' });
    expect(nextButton).toBeDisabled();

    const input = document.querySelector<HTMLTextAreaElement>('[data-guide-message-input="true"]');
    expect(input).not.toBeNull();
    fireEvent.input(input!, { target: { value: '一条测试消息' } });

    await waitFor(() => expect(nextButton).toBeEnabled());
  });

  it('shows independent copy for the text stake stage', async () => {
    renderGuide();
    const input = document.querySelector<HTMLTextAreaElement>('[data-guide-message-input="true"]');
    fireEvent.input(input!, { target: { value: '一条测试消息' } });

    const nextButton = await screen.findByRole('button', { name: '下一步' });
    await waitFor(() => expect(nextButton).toBeEnabled());
    fireEvent.click(nextButton);

    expect(await screen.findByText('调整文本消息贡献点')).toBeInTheDocument();
    expect(screen.getByText('调整发送这条文本消息消耗的贡献点，确认发送时的贡献点押注数值，不能低于最低限制。')).toBeInTheDocument();
    expect(screen.queryByText('正确的内容会获得收益，错误的内容会付出代价。')).not.toBeInTheDocument();
  });

  it('blocks an operation outside the current guide target', async () => {
    renderGuide();
    const unrelatedButton = document.createElement('button');
    unrelatedButton.textContent = '无关操作';
    document.body.appendChild(unrelatedButton);

    fireEvent.click(unrelatedButton);

    expect(await screen.findByRole('status')).toHaveTextContent('当前步骤不可操作');
    expect(unrelatedButton).toBeInTheDocument();
  });
});
