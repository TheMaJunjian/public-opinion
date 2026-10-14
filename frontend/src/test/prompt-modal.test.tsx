import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import PromptModal from '../components/PromptModal';

function ModalPair({ showFirst, showSecond }: { showFirst: boolean; showSecond: boolean }) {
  return <>
    <PromptModal open={showFirst} title="第一个弹窗" message="内容" onConfirm={() => undefined} />
    <PromptModal open={showSecond} title="第二个弹窗" message="内容" onConfirm={() => undefined} />
  </>;
}

describe('PromptModal body scroll lock', () => {
  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('keeps scrolling locked until the last open modal closes', () => {
    document.body.style.overflow = 'scroll';
    const { rerender, unmount } = render(<ModalPair showFirst showSecond />);

    expect(document.body.style.overflow).toBe('hidden');

    rerender(<ModalPair showFirst={false} showSecond />);
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.body.style.overflow).toBe('scroll');
  });
});