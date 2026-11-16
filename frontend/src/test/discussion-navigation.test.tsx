import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import DiscussionNavigation from '../components/DiscussionNavigation';

afterEach(cleanup);
const a = { id: 'a', title: '公共分类' }, b = { id: 'b', title: '个人分类' };
it('distinguishes shared and personal paths and navigates without overriding a personal choice', () => {
  const onCategory = vi.fn(), onRelated = vi.fn();
  render(<DiscussionNavigation recommended={[a]} personal={[b]} onCategory={onCategory} onRelated={onRelated} />);
  expect(within(screen.getByRole('navigation', { name: '统计推荐分类' })).getByRole('button', { name: a.title })).toBeVisible();
  expect(within(screen.getByRole('navigation', { name: '个人显示分类' })).getByRole('button', { name: b.title })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '查看所属分类' })); expect(onCategory).toHaveBeenLastCalledWith('b');
  fireEvent.click(screen.getByRole('button', { name: '查看推荐分类' })); expect(onCategory).toHaveBeenLastCalledWith('a');
  fireEvent.click(screen.getByRole('button', { name: '展开相关内容' })); expect(onRelated).toHaveBeenCalledOnce();
});

it('keeps a deep path expandable, avoids duplicate paths, and never links restricted titles', () => {
  const path = [a, { id: '', title: '不可查看的分类' }, b, { id: 'c', title: '末级分类' }];
  render(<DiscussionNavigation recommended={path} personal={path} onCategory={vi.fn()} onRelated={vi.fn()} />);
  const details = document.querySelector('details')!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText('分类路径 · 末级分类')); details.open = true;
  expect(screen.getByText(/不可查看的分类/)).toBeVisible();
  expect(screen.queryByRole('button', { name: '不可查看的分类' })).toBeNull();
  expect(screen.queryByRole('navigation', { name: '个人显示分类' })).toBeNull();
});
