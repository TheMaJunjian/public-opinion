import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => cleanup());

  it('keeps the first next button disabled until text is entered', async () => {
    renderGuide();

    const nextButton = await screen.findByRole('button', { name: '下一步' });
    expect(nextButton).toBeDisabled();
    const actions = document.querySelector<HTMLElement>('[data-guide-actions="true"]');
    expect(actions).not.toBeNull();
    expect(actions).toHaveStyle({ marginTop: '12px', justifyContent: 'flex-end' });
    expect(nextButton).not.toHaveStyle({ position: 'absolute' });
    expect(document.querySelector<HTMLElement>('[data-guide-bubble="true"]')).toHaveStyle({ padding: '15px 18px 18px' });

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

    expect(await screen.findByRole('status')).toHaveTextContent('当前步骤目标区域外有操作限制');
    expect(unrelatedButton).toBeInTheDocument();
  });

  it('keeps selection staging controls read-only during the staging step', async () => {
    renderGuide();
    const stagingButton = document.createElement('button');
    stagingButton.textContent = '加入目标集合';
    const staging = document.createElement('div');
    staging.dataset.guideSelectionStaging = 'true';
    staging.appendChild(stagingButton);
    document.body.appendChild(staging);

    act(() => window.dispatchEvent(new Event('guide-selection-complete')));
    await screen.findByText('消息已加入选择暂存区');
    fireEvent.click(stagingButton);

    expect(await screen.findByRole('status')).toHaveTextContent('当前步骤目标区域外有操作限制');
  });

});
