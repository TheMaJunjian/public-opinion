import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { ExportData } from '../api/client';
import WorkbenchViewToolbar from '../pages/workbench/ui/WorkbenchViewToolbar';
import { useDiscussionView } from '../pages/workbench/useDiscussionView';
import { prepareZhihuForViewing } from '../utils/zhihuArchive';
import type { DiscussionView } from '../utils/discussionView';

const storage = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('../utils/exportViewerCache', () => ({ loadExportDiscussionView: storage.load, saveExportDiscussionView: storage.save }));
vi.mock('../theme/theme', () => ({ useThemeSettings: () => ({ layout: { messageJump: 'none' } }) }));
vi.mock('../components/HomeFilterPanel', () => ({ default: () => null }));
vi.mock('../components/CleanFilterPanel', () => ({ default: () => null }));
vi.mock('../components/DeferredWorkbench', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));

const empty = (): ExportData => ({ formatVersion: 5, exportedAt: '', scope: { messageId: null, title: '' }, messages: [], relations: [] });
const source = () => prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1, items: [], comments: [] });
const folded: DiscussionView = { mode: 'discussion', collapsed: [JSON.stringify(['m1', 'reply'])] };
beforeEach(() => { storage.load.mockReset().mockResolvedValue(null); storage.save.mockReset().mockResolvedValue(undefined); });

it('defaults all documents and live views to discussion without writing on mount', async () => {
  const hook = renderHook(({ data }: { data: ExportData | null }) => useDiscussionView(data), { initialProps: { data: source() as ExportData | null } });
  expect(hook.result.current.value).toEqual({ mode: 'discussion', collapsed: [] });
  hook.rerender({ data: empty() });
  expect(hook.result.current.value).toEqual({ mode: 'discussion', collapsed: [] });
  hook.rerender({ data: null });
  expect(hook.result.current.value).toEqual({ mode: 'discussion', collapsed: [] });
  act(() => hook.result.current.onChange(folded));
  expect(hook.result.current.value).toEqual(folded);
  expect(storage.save).not.toHaveBeenCalled();
});

it('restores folds but never lets a slow cache read undo a newer click', async () => {
  let resolve!: (value: DiscussionView) => void;
  storage.load.mockReturnValueOnce(new Promise<DiscussionView>(done => { resolve = done; }));
  const data = source();
  const hook = renderHook(() => useDiscussionView(data));
  act(() => hook.result.current.onChange(folded));
  await act(async () => { resolve({ mode: 'graph', collapsed: [] }); });
  expect(hook.result.current.value).toEqual(folded);
  expect(storage.save).toHaveBeenCalledWith(data, folded);
  const reopened = { ...data };
  storage.load.mockResolvedValueOnce(folded);
  const restored = renderHook(() => useDiscussionView(reopened));
  await waitFor(() => expect(restored.result.current.value).toEqual(folded));
});

it('keeps visible folds after a persistence failure and retries the current choice', async () => {
  const data = source();
  storage.save.mockRejectedValueOnce(new Error('讨论布局未保存'));
  const hook = renderHook(() => useDiscussionView(data));
  act(() => hook.result.current.onChange(folded));
  await waitFor(() => expect(hook.result.current.error).toBe('讨论布局未保存'));
  expect(hook.result.current.value).toEqual(folded);
  act(() => hook.result.current.retry());
  await waitFor(() => expect(hook.result.current.error).toBeNull());
  expect(storage.save).toHaveBeenLastCalledWith(data, folded);
});

function toolbar(): ComponentProps<typeof WorkbenchViewToolbar> {
  return { top: 0, scopeMessageId: 'root', exportTitle: '', showAlert: vi.fn(), onJump: vi.fn(), onLeaderboard: vi.fn(),
    home: { mode: null, onChange: vi.fn() },
    clean: { active: false, filters: [], matchCount: 0, totalCount: 0, onAdd: vi.fn(), onRemove: vi.fn(), onUpdate: vi.fn(), onClear: vi.fn() },
    filter: { settings: { hideJoin: true, hideSettlement: true }, onChange: vi.fn() },
    view: { viewMode: 'graph', setViewMode: vi.fn(), leftPanelRef: { current: null }, viewModeScrollRef: { current: { list: null, graph: null } },
      draftUnits: [], targetUnits: [], traceCount: 0, currentClassifyRelMsgId: null, messages: [], relations: [],
      findContainingClassification: vi.fn(), exitClassification: vi.fn(), enterClassification: vi.fn(), scheduleViewNavigation: vi.fn() },
    comparison: { comparisonMode: false, comparisonReviewed: false, comparisonTargetId: null, setComparisonTargetId: vi.fn(), onStartComparison: vi.fn() },
    correctionFilterTargetId: null,
    discussion: { value: folded, onChange: vi.fn(), error: null, retry: vi.fn() }, onLocalExport: vi.fn(),
  };
}

it('chooses the optional legacy layout from settings and exports its folds without changing selection', async () => {
  const props = toolbar(), ui = render(<WorkbenchViewToolbar {...props} />);
  expect(screen.queryByRole('button', { name: '讨论布局' })).toBeNull();
  expect(screen.queryByRole('button', { name: '关系图' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: '布局设置' }));
  expect(screen.getByRole('radio', { name: '讨论布局（默认）' })).toBeChecked();
  fireEvent.click(screen.getByRole('radio', { name: '原关系图排布' }));
  expect(props.discussion!.onChange).toHaveBeenCalledWith({ ...folded, mode: 'graph' });
  expect(props.view.setViewMode).not.toHaveBeenCalled();
  const chosen = { ...folded, mode: 'graph' as const };
  ui.rerender(<WorkbenchViewToolbar {...props} discussion={{ ...props.discussion!, value: chosen }} />);
  fireEvent.keyDown(screen.getByRole('dialog', { name: '布局设置' }), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: '下载阅览文件' }));
  expect(props.onLocalExport).toHaveBeenCalledWith(expect.objectContaining({ discussion: chosen }));
  ui.rerender(<WorkbenchViewToolbar {...props} view={{ ...props.view, viewMode: 'list' }} />);
  expect(screen.queryByRole('button', { name: '布局设置' })).toBeNull();
  expect(screen.queryByRole('dialog', { name: '布局设置' })).toBeNull();
});

it('makes unsuccessful layout persistence visible and offers an explicit retry', () => {
  const props = toolbar(); props.discussion!.error = '讨论布局未保存';
  render(<WorkbenchViewToolbar {...props} />);
  expect(screen.getByRole('alert')).toHaveTextContent('讨论布局未保存');
  fireEvent.click(screen.getByRole('button', { name: '重试保存布局' }));
  expect(props.discussion!.retry).toHaveBeenCalledOnce();
});

it('opens local full or update export options immediately for a native Zhihu document', async () => {
  const props = toolbar();
  props.exportData = { format: 'gonglun-view-3', formatVersion: 5, exportedAt: '',
    scope: { messageId: null, title: '知乎收藏' }, messages: [], relations: [],
    source: { provider: 'zhihu', version: 1, scope: 'collections', ownerId: 'fixture', ownerUrl: null } } as NonNullable<typeof props.exportData>;
  render(<WorkbenchViewToolbar {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '下载阅览文件' }));
  expect(await screen.findByRole('dialog', { name: '保存阅览文件' })).toBeVisible();
  expect(screen.getByLabelText('选择要更新的导出文件（可选）')).toBeEnabled();
  expect(props.onLocalExport).not.toHaveBeenCalled();
});
