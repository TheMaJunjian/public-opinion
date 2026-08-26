import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RegistrationGuideHint from '../components/RegistrationGuideHint';

describe('RegistrationGuideHint', () => {
  afterEach(() => cleanup());

  it('highlights the guide button and closes without completing the guide', () => {
    const onClose = vi.fn();
    render(
      <>
        <button data-guide-button="true">引导</button>
        <RegistrationGuideHint open onClose={onClose} />
      </>,
    );

    expect(document.querySelector('[data-guide-button="true"]')).toBeInTheDocument();
    expect(screen.getByText(/顶部的“教程”按钮可以随时查看完整教程/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '已阅' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
