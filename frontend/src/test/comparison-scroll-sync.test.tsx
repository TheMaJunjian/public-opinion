import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import CorrectionComparisonPopup from '../components/CorrectionComparisonPopup';
import CorrectionTextComparison from '../components/CorrectionTextComparison';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

afterEach(cleanup);

function versionColumns() {
  return [...document.querySelectorAll<HTMLElement>('[data-version-side]')] as [HTMLElement, HTMLElement];
}

it('独立正文对比默认双向同步，取消后可独立滚动，再开启恢复同步', () => {
  const before = '原始全文\n'.repeat(200);
  const after = '更正全文\n'.repeat(200);
  render(<CorrectionTextComparison before={before} after={after} />);
  const toggle = screen.getByLabelText('同步滚动');
  const [first, second] = versionColumns();
  expect(toggle).toBeChecked();
  first.scrollTop = 120;
  fireEvent.scroll(first);
  expect(second.scrollTop).toBe(120);
  fireEvent.scroll(second);
  second.scrollTop = 240;
  fireEvent.scroll(second);
  expect(first.scrollTop).toBe(240);

  fireEvent.click(toggle);
  expect(toggle).not.toBeChecked();
  first.scrollTop = 360;
  fireEvent.scroll(first);
  expect(second.scrollTop).toBe(240);
  fireEvent.click(toggle);
  first.scrollTop = 480;
  fireEvent.scroll(first);
  expect(second.scrollTop).toBe(480);
  expect(first.querySelector('pre')?.textContent).toBe(before);
  expect(second.querySelector('pre')?.textContent).toBe(after);
});

it('较短版本到达滚动终点时，异步镜像事件不会把较长版本拉回', () => {
  render(<CorrectionTextComparison before={'长文本\n'.repeat(200)} after={'短文本\n'.repeat(20)} />);
  const [first, second] = versionColumns();
  let clampedPosition = 0;
  Object.defineProperty(second, 'scrollTop', {
    configurable: true,
    get: () => clampedPosition,
    set: value => { clampedPosition = Math.min(40, value); },
  });
  first.scrollTop = 120;
  fireEvent.scroll(first);
  expect(second.scrollTop).toBe(40);
  fireEvent.scroll(second);
  expect(first.scrollTop).toBe(120);
  second.scrollTop = 20;
  fireEvent.scroll(second);
  expect(first.scrollTop).toBe(20);
});

it.each([true, false])('实际更正弹窗只提供一个同步控件，支持%s记录格式的完整版本列', recordedBodies => {
  const before = '开头\n旧版本\n结尾';
  const after = '开头\n更正版本\n结尾';
  const original: DemoMessage = { id: 'original', kind: 'normal', content: before, author: 'writer', createdAt: '2026-01-01' };
  const correction: DemoMessage = { id: 'correction', kind: 'relation', content: after, author: 'writer', createdAt: '2026-01-02',
    relationPayload: recordedBodies ? { correctionBeforeContent: before, correctionAfterContent: after } : { correctionContent: after } };
  const edge: DemoEdge = { id: 'edge', relationMessageId: correction.id, relationType: 'correct', relationLabel: '更正',
    from: { messageId: 'anon:correction', selection: { kind: 'whole' } }, to: { messageId: original.id, selection: { kind: 'whole' } } };
  const onClose = vi.fn();
  render(<CorrectionComparisonPopup popup={{ relMsgId: correction.id, x: 0, y: 0 }} messages={[original, correction]} edges={[edge]} onClose={onClose} />);
  expect(screen.getAllByLabelText('同步滚动')).toHaveLength(1);
  const [first, second] = versionColumns();
  first.scrollTop = 90;
  fireEvent.scroll(first);
  expect(second.scrollTop).toBe(90);
  expect(first.querySelector('pre')?.textContent).toBe(before);
  expect(second.querySelector('pre')?.textContent).toBe(after);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(onClose).toHaveBeenCalledOnce();
});

it('正文容器自身滚动不会被当成版本列滚动', () => {
  const view = render(<CorrectionTextComparison before="原文" after="更正后" />);
  const [first, second] = versionColumns();
  const content = view.container.querySelector<HTMLElement>('[data-comparison-content]')!;
  content.scrollTop = 70;
  fireEvent.scroll(content);
  expect(first.scrollTop).toBe(0);
  expect(second.scrollTop).toBe(0);
});
