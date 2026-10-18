import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';
import { api } from '../api';
import { useWorkbenchData } from '../pages/workbench/useWorkbenchData';
import WorkbenchLoadingBoundary, { useWorkbenchLoadingProgress } from '../components/WorkbenchLoadingBoundary';
import { resetWorkbenchActivity } from '../utils/workbenchActivity';

const location = vi.hoisted(() => ({ archive: null as ExportData | null }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ state: { exportData: location.archive } }) }));
vi.mock('../api', () => ({ api: { getWorkbenchSnapshot: vi.fn(), subscribeChanges: vi.fn() } }));

const archive = (title: string, id: string): ExportData => ({
  formatVersion: 1, exportedAt: '', scope: { messageId: null, title },
  messages: [{ id, kind: 'TEXT', contentType: 'TEXT', content: title, createdAt: '', author: '阅览用户', authorId: 'u' }],
  relations: [],
});

afterEach(() => { localStorage.clear(); vi.clearAllMocks(); resetWorkbenchActivity(); vi.useRealTimers(); });

it('replaces the displayed archive when another file is opened on the same viewer route', async () => {
  location.archive = archive('第一份文件', 'first');
  const { result, rerender } = renderHook(() => useWorkbenchData({ user: null, authLoading: false, scopeMessageId: 'root', navigate: vi.fn(), viewMode: 'list' }));
  await waitFor(() => expect(result.current.messages.map(message => message.id)).toEqual(['first']));
  expect(result.current.scope?.title).toBe('第一份文件');
  act(() => result.current.setRelatedTraceContext({ messages: [{ id: 'external', kind: 'normal', content: '外部上下文', author: '', createdAt: '' }], edges: [], relations: [] }));
  expect(result.current.messages.map(message => message.id)).toContain('external');
  location.archive = archive('第二份文件', 'second');
  rerender();
  await waitFor(() => expect(result.current.messages.map(message => message.id)).toEqual(['second']));
  expect(result.current.scope?.title).toBe('第二份文件');
  expect(result.current.viewerUsers.map(user => user.username)).toEqual(['阅览用户']);
  expect(api.getWorkbenchSnapshot).not.toHaveBeenCalled();
});

it('opens with the exported viewer even if a different viewer was used previously', async () => {
  localStorage.setItem('export-viewer-username', '其他用户');
  location.archive = { ...archive('导出时的现场', 'claim'), viewerUsername: '当前用户', users: [
    { id: 'current', username: '当前用户', createdAt: '' }, { id: 'other', username: '其他用户', createdAt: '' },
  ] };
  const { result } = renderHook(() => useWorkbenchData({ user: null, authLoading: false, scopeMessageId: 'root', navigate: vi.fn(), viewMode: 'graph' }));
  await waitFor(() => expect(result.current.displayUser?.username).toBe('当前用户'));
  expect(result.current.displayUser?.id).toBe('current');
  expect(result.current.viewerUsers.map(user => user.username)).toContain('当前用户');
  act(() => result.current.setViewerUser(null));
  expect(result.current.displayUser).toBeNull();
});

it('shows drawing before converting each archive and keeps it open until the new messages settle', async () => {
  vi.useFakeTimers();
  location.archive = archive('第一份文件', 'first');
  function Viewer() {
    const data = useWorkbenchData({ user: null, authLoading: false, scopeMessageId: 'root', navigate: vi.fn(), viewMode: 'graph' });
    useWorkbenchLoadingProgress(data.loading && !data.preloadedData, data.loadError, data.preloadedData);
    return <div data-testid="archive-messages">{data.messages.map(message => message.id).join(',')}</div>;
  }
  const view = render(<WorkbenchLoadingBoundary><Viewer /></WorkbenchLoadingBoundary>);
  expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
  expect(screen.getByTestId('archive-messages')).toHaveTextContent('');
  await act(async () => { vi.advanceTimersByTime(34); });
  expect(screen.getByTestId('archive-messages')).toHaveTextContent('first');
  expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(240); });
  expect(screen.queryByRole('dialog')).toBeNull();
  location.archive = archive('第二份文件', 'second');
  view.rerender(<WorkbenchLoadingBoundary><Viewer /></WorkbenchLoadingBoundary>);
  expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(34); });
  expect(screen.getByTestId('archive-messages')).toHaveTextContent('second');
  expect(screen.getByRole('dialog', { name: '正在绘制' })).toBeInTheDocument();
  view.unmount();
});
