import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ClassificationHeader from '../pages/workbench/ui/ClassificationHeader';
import type { DemoMessage } from '../utils/modelBridge';

vi.mock('../components/LazyMessageDisplayHints', () => ({ MessageDisplayMarker: () => null }));
afterEach(cleanup);

// Empty/formatting fixtures exercise the reader; they are not sample discussions.
const props: ComponentProps<typeof ClassificationHeader> = {
  isInsideClassify: true, isTemporaryJoinCategory: false, correctionFilterTargetId: null, comparisonMode: false,
  comparisonTargetCount: 0, correctionCount: 0, temporaryJoinCount: 0, classificationTitle: '问题标题', classifyKindLabel: '分类',
  comparisonTargetId: null, joinFilterTargetId: null, classifyTargetCount: 3, classifyExitLabel: '退出分类',
  onExitTemporary: vi.fn(), onExitClassify: vi.fn(),
  currentClassifyRelMsg: { id: 'question-1', kind: 'relation', relationType: 'classify', content: '', author: '作者未提供', createdAt: '' } as DemoMessage,
};

it('shows the question title and separate multiline description without executing source markup', () => {
  const description = '第一行\n第二行\n<script>technical fixture</script>';
  const { container } = render(<ClassificationHeader {...props} zhihuQuestion={{ description, known: true, completeness: 'complete' }} />);
  expect(screen.getByText('问题标题')).toBeTruthy();
  const details = container.querySelector('details')!;
  expect(details.open).toBe(true);
  expect(details.querySelector('div')?.textContent).toBe(description);
  expect(details.querySelector('div')?.style.whiteSpace).toBe('pre-wrap');
  expect(details.querySelector('script')).toBeNull();
  expect(screen.getByText('时间未记录')).toBeTruthy();
  expect(container.textContent).toContain('提问者：');
  expect(container.textContent).not.toContain('Invalid Date');
  fireEvent.click(screen.getByText('退出分类'));
  expect(props.onExitClassify).toHaveBeenCalled();
});

it('distinguishes a verified empty description from an unavailable description', () => {
  const { rerender } = render(<ClassificationHeader {...props} zhihuQuestion={{ description: '', known: true, completeness: 'complete' }} />);
  expect(screen.getByText('原站无问题描述')).toBeTruthy();
  rerender(<ClassificationHeader {...props} zhihuQuestion={{ description: '', known: false, completeness: 'unknown' }} />);
  expect(screen.getByText('问题描述未取得')).toBeTruthy();
  expect(screen.queryByText('原站无问题描述')).toBeNull();
});

it('marks partial descriptions and keeps source date text without inventing a year', () => {
  render(<ClassificationHeader {...props} zhihuQuestion={{ description: '技术夹具', known: true, completeness: 'partial', createdAtText: '10-28' }} />);
  expect(screen.getByText('技术夹具')).toBeTruthy();
  expect(screen.getByText('这里只取得部分问题描述，内容可能不完整。')).toBeTruthy();
  expect(screen.getByText('10-28')).toBeTruthy();
});

it('does not show question context in an ordinary Gonglun classification or temporary record view', () => {
  const { container, rerender } = render(<ClassificationHeader {...props} currentClassifyRelMsg={{ ...props.currentClassifyRelMsg!, createdAt: '2026-11-01T00:00:00Z' }} />);
  expect(screen.queryByText('问题描述')).toBeNull();
  expect(container.textContent).toContain('发起');
  rerender(<ClassificationHeader {...props} recordCategory={{ targetId: 'target', label: '赞同', recordIds: [] }}
    zhihuQuestion={{ description: '', known: false, completeness: 'unknown' }} />);
  expect(screen.queryByText('问题描述')).toBeNull();
});

it('does not invent a source date or question description for a generated type category', () => {
  const { container } = render(<ClassificationHeader {...props} classificationTitle="回答"
    currentClassifyRelMsg={{ ...props.currentClassifyRelMsg!, id: 'zhihu:type:answer', author: '阅览分类', createdAt: '' }} />);
  expect(screen.getByText('回答')).toBeInTheDocument();
  expect(screen.getByText('阅览分类')).toBeInTheDocument();
  expect(screen.queryByText('问题描述')).toBeNull();
  expect(container.textContent).not.toContain('Invalid Date');
  expect(container.textContent).not.toContain('时间未记录');
});

it('marks local title and description supplements while keeping unavailable source status', () => {
  const { container, rerender } = render(<ClassificationHeader {...props} classificationTitle="本地测试标题"
    zhihuQuestion={{ description: '本地测试描述', known: false, completeness: 'unknown', locallyCorrectedBody: true, locallyCorrectedTitle: true }} />);
  expect(screen.getByText('本地测试标题')).toBeInTheDocument();
  expect(screen.getByText('标题 · 本地补充')).toBeInTheDocument();
  expect(container.querySelector('[data-zhihu-question-description] summary')).toHaveTextContent('本地补充');
  expect(screen.getByText('原文件未取得问题描述；当前显示本地补充。')).toBeInTheDocument();
  rerender(<ClassificationHeader {...props} zhihuQuestion={{ description: '', known: false, completeness: 'unknown' }} />);
  expect(screen.getByText('问题描述未取得')).toBeInTheDocument();
  expect(screen.queryByText('标题 · 本地补充')).toBeNull();
});
