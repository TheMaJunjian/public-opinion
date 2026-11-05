import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import LocalReplyEditor from '../components/ZhihuReplyEditor';
import { prepareZhihuForViewing } from '../utils/zhihuArchive';

// Empty protocol records isolate DOM size and selection from discussion content.
function fixture(count: number, owner = 'pagination-fixture') {
  return prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1, owner: { id: owner },
    items: [{ id: '10', type: 'answer', text: '', completeness: { body: 'complete' } }],
    comments: Array.from({ length: count }, (_, index) => ({ id: String(index + 1), sourceId: String(index + 1),
      threadId: 'answer:10', text: '', rootCommentId: String(index + 1), parentCommentId: null })),
  });
}
const commentId = (number: number) => `zhihu:comment:answer%3A10:${number}`;
const summary = () => screen.getByText(/^缺失或待确认的内容（/);

it('mounts only an opened page, preserves the total and selects a later missing field without saving', async () => {
  const data = fixture(123), original = JSON.stringify(data.zhihu.archive);
  const onSelectCorrection = vi.fn(), onSave = vi.fn();
  const view = render(<LocalReplyEditor data={data} sourceUnits={[]} targetUnits={[]} draftUnits={[]} relationType={null}
    onSave={onSave} onSelectCorrection={onSelectCorrection} renderSendControls={controls => controls.feedback} />);
  const entries = () => [...view.container.querySelectorAll('[data-missing-message]')];
  expect(summary()).toHaveTextContent('123');
  expect(entries()).toHaveLength(0);
  expect(screen.queryByRole('navigation', { name: '缺失内容分页' })).toBeNull();
  fireEvent.click(summary());
  await waitFor(() => expect(entries()).toHaveLength(50));
  expect(entries()[0]).toHaveAttribute('data-missing-message', commentId(1));
  expect(entries().at(-1)).toHaveAttribute('data-missing-message', commentId(50));
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(entries()).toHaveLength(50);
  expect(entries()[0]).toHaveAttribute('data-missing-message', commentId(51));
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(entries()).toHaveLength(23);
  expect(entries()[0]).toHaveAttribute('data-missing-message', commentId(101));
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  expect(screen.getByRole('navigation', { name: '缺失内容分页' })).toHaveTextContent('第 3 / 3 页');
  fireEvent.click(entries().at(-1)!.querySelector('button')!);
  expect(onSelectCorrection).toHaveBeenCalledWith(commentId(123));
  expect(onSave).not.toHaveBeenCalled();
  expect(JSON.stringify(data.zhihu.archive)).toBe(original);
  fireEvent.click(summary());
  await waitFor(() => expect(entries()).toHaveLength(0));
  expect(screen.queryByRole('navigation', { name: '缺失内容分页' })).toBeNull();
  fireEvent.click(summary());
  await waitFor(() => expect(entries()).toHaveLength(23));
  expect(entries()[0]).toHaveAttribute('data-missing-message', commentId(101));
});

it('clamps the page after same-document updates and starts another document collapsed', async () => {
  const props = { sourceUnits: [], targetUnits: [], draftUnits: [], relationType: null, onSave: vi.fn(), onSelectCorrection: vi.fn(), renderSendControls: () => null };
  const data = fixture(110);
  const view = render(<LocalReplyEditor {...props} data={data} />);
  const entries = () => [...view.container.querySelectorAll('[data-missing-message]')];
  fireEvent.click(summary());
  await waitFor(() => expect(entries()).toHaveLength(50));
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(entries()).toHaveLength(10);
  const completeFirst100 = prepareZhihuForViewing({ ...data.zhihu.archive,
    comments: data.zhihu.archive.comments.map((comment, index) => index < 100 ? { ...comment, completeness: { body: 'complete' } } : comment),
  });
  view.rerender(<LocalReplyEditor {...props} data={completeFirst100} />);
  expect(entries()).toHaveLength(10);
  expect(entries()[0]).toHaveAttribute('data-missing-message', commentId(101));
  expect(screen.queryByRole('navigation', { name: '缺失内容分页' })).toBeNull();
  view.rerender(<LocalReplyEditor {...props} data={fixture(2, 'another-document')} />);
  await waitFor(() => expect(entries()).toHaveLength(0));
  expect(summary()).toHaveTextContent('2');
  fireEvent.click(summary());
  await waitFor(() => expect(entries()).toHaveLength(2));
  expect(entries()[0]).toHaveAttribute('data-missing-message', commentId(1));
});
