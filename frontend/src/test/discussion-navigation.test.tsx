import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import DiscussionNavigation from '../components/DiscussionNavigation';
import DiscussionStatusControl from '../components/DiscussionStatusControl';

afterEach(cleanup);
const a = { id: 'a', title: '公共分类' }, b = { id: 'b', title: '个人分类' };
it('refreshes the full workbench in place and keeps keyboard focus on the two available actions', async () => {
  const user = userEvent.setup();
  const refresh = vi.fn();
  render(<DiscussionStatusControl state={null} onRefresh={refresh} onOpenFull={vi.fn()} />);
  const trigger = screen.getByRole('button', { name: '讨论详情' });
  await user.click(trigger);
  const dialog = within(screen.getByRole('dialog', { name: '讨论详情' }));
  const close = dialog.getByRole('button', { name: '关闭讨论详情' });
  const reload = dialog.getByRole('button', { name: '刷新工作台' });
  expect(dialog.getAllByRole('button')).toEqual([close, reload]);
  expect(close).toHaveFocus();
  expect(close).toHaveAttribute('data-shortcut-confirm', 'true');
  expect(close).toHaveAttribute('data-shortcut-cancel', 'true');
  await user.tab({ shift: true });
  expect(reload).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(refresh).toHaveBeenCalledOnce();
  await user.tab();
  expect(close).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();
});

it('shows category paths and related content in discussion details and closes it when navigating', () => {
  const onCategory = vi.fn(), onRelated = vi.fn();
  const state = { focusId: 'message', classificationId: 'b', loadedCount: 1, hasMore: false, expanded: false, loading: false, loadingMore: false };
  render(<DiscussionStatusControl state={state} onRefresh={vi.fn()} onOpenFull={vi.fn()}
    navigation={{ recommended: [a], personal: [b], onCategory, onRelated }} />);
  const trigger = screen.getByRole('button', { name: '讨论详情' });
  const openDetails = () => {
    fireEvent.click(trigger);
    return within(screen.getByRole('dialog', { name: '讨论详情' }));
  };
  expect(screen.queryByText('分类路径')).toBeNull();
  expect(screen.queryByRole('button', { name: '查看所属分类' })).toBeNull();
  expect(screen.queryByRole('button', { name: '展开相关内容' })).toBeNull();
  const details = openDetails();
  expect(details.getByRole('status')).toHaveTextContent('已加载 1 条关联消息');
  expect(within(details.getByRole('navigation', { name: '统计推荐分类' })).getByRole('button', { name: a.title })).toBeVisible();
  expect(within(details.getByRole('navigation', { name: '个人显示分类' })).getByRole('button', { name: b.title })).toBeVisible();
  expect(details.queryByRole('button', { name: /查看(所属|推荐)分类/ })).toBeNull();
  fireEvent.click(details.getByRole('button', { name: b.title }));
  expect(onCategory).toHaveBeenLastCalledWith('b');
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(openDetails().getByRole('button', { name: a.title }));
  expect(onCategory).toHaveBeenLastCalledWith('a');
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(openDetails().getByRole('button', { name: '展开相关内容' }));
  expect(onRelated).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('swaps a deep path shortcut for its accessible category links when expanded', async () => {
  const path = [a, { id: '', title: '不可查看的分类' }, b, { id: 'c', title: '末级分类' }];
  const onCategory = vi.fn(), user = userEvent.setup();
  render(<DiscussionNavigation recommended={path} personal={path} onCategory={onCategory} onRelated={vi.fn()} />);
  expect(screen.queryByRole('navigation')).toBeNull();
  expect(screen.queryByRole('button', { name: '查看推荐分类' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看所属分类' }));
  expect(onCategory).toHaveBeenLastCalledWith('c');
  const summary = screen.getByText('分类路径 · 末级分类');
  await user.click(summary);
  expect(screen.queryByRole('button', { name: '查看所属分类' })).toBeNull();
  expect(screen.getByText(/不可查看的分类/)).toBeVisible();
  expect(screen.queryByRole('button', { name: '不可查看的分类' })).toBeNull();
  expect(screen.queryByRole('navigation', { name: '个人显示分类' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '末级分类' }));
  expect(onCategory).toHaveBeenLastCalledWith('c');
  await user.click(summary);
  expect(screen.getByRole('button', { name: '查看所属分类' })).toBeVisible();
});

it('keeps both paths readable when they share a destination and links same-named distinct ancestors independently', async () => {
  const common = { id: 'common', title: '共同祖先' }, leaf = { id: 'shared', title: '共同末级' };
  const recommended = [common, { id: 'r', title: '同名分类' }, leaf];
  const personal = [common, { id: 'p', title: '同名分类' }, leaf];
  const onCategory = vi.fn();
  render(<DiscussionNavigation recommended={recommended} personal={personal} onCategory={onCategory} onRelated={vi.fn()} />);
  const rec = within(screen.getByRole('navigation', { name: '统计推荐分类' }));
  const own = within(screen.getByRole('navigation', { name: '个人显示分类' }));
  expect(rec.getByRole('button', { name: common.title })).toBeVisible();
  expect(own.getByText(/共同祖先/)).toBeVisible();
  expect(own.getByText(/共同末级/)).toBeVisible();
  expect(screen.getAllByRole('button', { name: leaf.title })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: common.title })).toHaveLength(1);
  fireEvent.click(rec.getByRole('button', { name: '同名分类' }));
  fireEvent.click(own.getByRole('button', { name: '同名分类' }));
  expect(onCategory.mock.calls).toEqual([['r'], ['p']]);
  await userEvent.click(screen.getByText('分类路径'));
  expect(screen.queryByRole('button', { name: '查看推荐分类' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看所属分类' }));
  expect(onCategory).toHaveBeenLastCalledWith(leaf.id);
});

it('uses the latest accessible destinations after a refresh and preserves a manual disclosure choice', async () => {
  const onCategory = vi.fn(), onRelated = vi.fn();
  const nav = (recommended: typeof a[], personal: typeof a[]) =>
    <DiscussionNavigation {...{ recommended, personal, onCategory, onRelated }} />;
  const deep = [a, { id: 'middle', title: '中间分类' }, { id: 'next', title: '下一级' }, b];
  const { rerender } = render(nav([], []));
  expect(screen.getByRole('navigation')).toBeVisible();
  rerender(nav([a], deep));
  expect(screen.queryByRole('navigation')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看所属分类' }));
  fireEvent.click(screen.getByRole('button', { name: '查看推荐分类' }));
  expect(onCategory.mock.calls).toEqual([[b.id], [a.id]]);
  await userEvent.click(screen.getByText('分类路径 · 个人分类'));
  expect(screen.getByRole('navigation', { name: '个人显示分类' })).toBeVisible();
  rerender(nav([a], [b]));
  await userEvent.click(screen.getByText('分类路径'));
  rerender(nav([a], [{ id: '', title: '不可查看的分类' }]));
  expect(screen.queryByRole('navigation')).toBeNull();
  expect(screen.queryByRole('button', { name: '查看所属分类' })).toBeNull();
  expect(screen.getByRole('button', { name: '查看推荐分类' })).toBeVisible();
  rerender(nav([{ id: '', title: '不可查看的分类' }], []));
  expect(screen.queryByRole('button', { name: /查看(所属|推荐)分类/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '展开相关内容' }));
  expect(onRelated).toHaveBeenCalledOnce();
});
