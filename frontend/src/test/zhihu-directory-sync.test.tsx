import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import ExportViewerModal from '../components/ExportViewerModal';
import ZhihuDirectorySync from '../components/ZhihuDirectorySync';
import { prepareZhihuForViewing, sendZhihuLocalRelation, type ZhihuViewingData } from '../utils/zhihuArchive';
import { appendZhihuJournal, chooseZhihuDirectory, getZhihuDirectory, readZhihuDirectory, refreshZhihuDirectory, rememberZhihuDirectory, requireDirectoryPermission, type LinkedDirectory } from '../utils/zhihuDirectory';
import { EXPORT_DISCUSSION_VIEW_SAVED, loadCachedExport, loadCachedNativeExport, loadExportDiscussionView, saveLastExport } from '../utils/exportViewerCache';
import { prepareExportForViewing } from '../utils/exportArchive';
import { nativeZhihuDocument, sendNativeZhihuRelation } from '../utils/nativeZhihuEditor';
import { isNativeLocalMessage, isNativeZhihuView } from '../utils/nativeZhihuView';

vi.mock('../utils/zhihuDirectory', () => ({ canLinkZhihuDirectory: () => true, chooseZhihuDirectory: vi.fn(),
  getZhihuDirectory: vi.fn(), readZhihuDirectory: vi.fn(), refreshZhihuDirectory: vi.fn(),
  appendZhihuJournal: vi.fn(), rememberZhihuDirectory: vi.fn(), requireDirectoryPermission: vi.fn() }));
vi.mock('../utils/exportViewerCache', () => ({ loadCachedExport: vi.fn(), loadCachedNativeExport: vi.fn(), loadLastExport: vi.fn(async () => null), saveLastExport: vi.fn(),
  getExportCacheReference: () => ({ archiveId: 'fixture-cache', viewCacheId: 'fixture-view' }), inheritExportCacheReference: (data: unknown) => data,
  EXPORT_DISCUSSION_VIEW_SAVED: 'export-discussion-view-saved', loadExportDiscussionView: vi.fn() }));
const connection: LinkedDirectory = { directory: { name: 'collections' } as FileSystemDirectoryHandle,
  sourceName: 'gonglun.json', signature: '1:100', journalSignature: '', documentId: 'fixture-document' };
const source = (extra = false) => prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1, owner: { id: 'fixture-owner' },
  items: [{ id: '1', type: 'article', text: '' }, ...(extra ? [{ id: '2', type: 'article', text: '' }] : [])], comments: [],
  activitySource: { version: 1, scope: 'collections', events: [], folders: [], unparsedRecords: [],
    coverage: { scope: 'collections', status: 'complete', pagesComplete: true, allHistoryComplete: false, reason: '' } } });
beforeEach(() => {
  vi.mocked(getZhihuDirectory).mockResolvedValue({ ...connection });
  vi.mocked(requireDirectoryPermission).mockResolvedValue();
  vi.mocked(appendZhihuJournal).mockResolvedValue();
  vi.mocked(rememberZhihuDirectory).mockResolvedValue();
  vi.mocked(refreshZhihuDirectory).mockImplementation(async (connection, data) => ({ data, signature: connection.signature, journalSignature: '' }));
  vi.mocked(loadExportDiscussionView).mockResolvedValue(null);
  vi.mocked(loadCachedExport).mockResolvedValue(null);
  vi.mocked(loadCachedNativeExport).mockResolvedValue(null);
  vi.mocked(saveLastExport).mockResolvedValue();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

it('adopts a newer collection in place and flushes local history after the cache commit', async () => {
  const initial = source(), next = source(true), commit = vi.fn();
  expect(initial.zhihu.archiveId).toBe(next.zhihu.archiveId);
  vi.mocked(refreshZhihuDirectory).mockResolvedValueOnce({ data: next, signature: '2:200', journalSignature: '' });
  function Viewer() {
    const [data, setData] = useState(initial);
    return <><output data-testid="item-count">{data.zhihu.archive.items.length}</output><ZhihuDirectorySync data={data} onUpdate={async (next, options) => {
      commit(next, options); setData(next);
    }} /></>;
  }
  render(<Viewer />);
  await waitFor(() => expect(commit).toHaveBeenCalledWith(next, { sourceUpdate: true }));
  await waitFor(() => expect(appendZhihuJournal).toHaveBeenCalled());
  expect(screen.getByTestId('item-count')).toHaveTextContent('2');
  expect(commit.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(appendZhihuJournal).mock.invocationCallOrder[0]);
  expect(rememberZhihuDirectory).toHaveBeenCalled();
});

it('checks periodically and on return to the page, stopping all checks after unmount', async () => {
  vi.useFakeTimers();
  render(<ZhihuDirectorySync data={source()} onUpdate={vi.fn()} />);
  await act(async () => {});
  expect(screen.getByRole('status')).toHaveTextContent('已同步');
  const before = vi.mocked(refreshZhihuDirectory).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(vi.mocked(refreshZhihuDirectory).mock.calls.length).toBeGreaterThan(before);
  const polled = vi.mocked(refreshZhihuDirectory).mock.calls.length;
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(vi.mocked(refreshZhihuDirectory).mock.calls.length).toBeGreaterThan(polled);
  cleanup();
  const stopped = vi.mocked(refreshZhihuDirectory).mock.calls.length;
  await act(async () => { vi.advanceTimersByTime(10000); window.dispatchEvent(new Event('focus')); });
  expect(vi.mocked(refreshZhihuDirectory).mock.calls.length).toBe(stopped);
});

it('retains a visible pending state after a write failure and retries without making another content edit', async () => {
  vi.mocked(appendZhihuJournal).mockRejectedValue(new Error('磁盘暂不可写'));
  const onUpdate = vi.fn();
  render(<ZhihuDirectorySync data={source()} onUpdate={onUpdate} />);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('尚未同步'));
  expect(screen.getByRole('status')).toHaveAttribute('title', expect.stringContaining('磁盘暂不可写'));
  expect(screen.getByRole('status').closest('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByRole('status').closest('summary')!);
  vi.mocked(appendZhihuJournal).mockResolvedValue();
  fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已同步'));
  expect(onUpdate).not.toHaveBeenCalled();
});

it('renews directory access only when the check button is clicked', async () => {
  vi.mocked(requireDirectoryPermission).mockImplementation(async (_connection, request) => { if (!request) throw new Error('目录权限需要恢复'); });
  render(<ZhihuDirectorySync data={source()} onUpdate={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('尚未同步'));
  expect(requireDirectoryPermission).toHaveBeenCalledWith(expect.anything(), false);
  fireEvent.click(screen.getByRole('status').closest('summary')!);
  fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
  await waitFor(() => expect(requireDirectoryPermission).toHaveBeenCalledWith(expect.anything(), true));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已同步'));
});

it('adds saved fold settings to the sidecar without rebuilding the canvas', async () => {
  const onUpdate = vi.fn();
  render(<ZhihuDirectorySync data={source()} onUpdate={onUpdate} />);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已同步'));
  const discussion = { mode: 'discussion' as const, collapsed: ['fixture-target:reply'] };
  vi.mocked(loadExportDiscussionView).mockResolvedValue(discussion);
  await act(async () => { window.dispatchEvent(new CustomEvent(EXPORT_DISCUSSION_VIEW_SAVED, { detail: { key: '__discussion_view__:fixture-view' } })); });
  expect(appendZhihuJournal).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ view: expect.objectContaining({ discussion }) }));
  expect(onUpdate).not.toHaveBeenCalled();
});

it('associates the chosen folder and preserves the existing local edits before navigating', async () => {
  const initial = source(), incoming = source(true);
  const edited = sendZhihuLocalRelation(initial, { relationType: 'AGREE', targetMessageIds: ['zhihu:item:article:1'] });
  vi.mocked(chooseZhihuDirectory).mockResolvedValue(connection.directory);
  vi.mocked(readZhihuDirectory).mockResolvedValue({ data: incoming, connection: { ...connection } });
  vi.mocked(loadCachedExport).mockResolvedValue(edited);
  function Chooser() {
    const [open, setOpen] = useState(true), location = useLocation();
    return <><ExportViewerModal open={open} onClose={() => setOpen(false)} /><output data-testid="route">{JSON.stringify(location)}</output></>;
  }
  render(<MemoryRouter><Chooser /></MemoryRouter>);
  expect(screen.getByRole('button', { name: '关联知乎导出目录' }).closest('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('本地辅助'));
  fireEvent.click(screen.getByRole('button', { name: '关联知乎导出目录' }));
  fireEvent.click(await screen.findByRole('button', { name: '关联并阅览' }));
  await waitFor(() => expect(rememberZhihuDirectory).toHaveBeenCalled());
  const route = JSON.parse(screen.getByTestId('route').textContent!);
  expect(route.pathname).toBe('/viewer');
  const data = route.state.exportData as ZhihuViewingData;
  expect(data.zhihu.archive.items).toHaveLength(2);
  expect(data.zhihu.localOperations).toEqual(edited.zhihu.localOperations);
  expect(saveLastExport).toHaveBeenCalledBefore(vi.mocked(rememberZhihuDirectory));
});

it('preserves native edits still pending on this machine when relinking the directory', async () => {
  const nativeSource = async (extra = false) => {
    const { zhihu: _legacy, ...data } = source(extra);
    const native = (await prepareExportForViewing({ ...data, source: {
      provider: 'zhihu', version: 1, scope: 'collections', ownerId: 'fixture-owner', ownerUrl: null,
    } })).data;
    if (!isNativeZhihuView(native)) throw new Error('Invalid fixture');
    return native;
  };
  const initial = await nativeSource(), incoming = await nativeSource(true);
  const edited = nativeZhihuDocument(sendNativeZhihuRelation(initial, {
    relationType: 'AGREE', targetMessageIds: [initial.messages.find(message => message.kind === 'TEXT')!.id],
  }));
  vi.mocked(chooseZhihuDirectory).mockResolvedValue(connection.directory);
  vi.mocked(readZhihuDirectory).mockResolvedValue({ data: incoming, connection: { ...connection } });
  vi.mocked(loadCachedNativeExport).mockResolvedValue(edited);
  function Chooser() {
    const [open, setOpen] = useState(true), location = useLocation();
    return <><ExportViewerModal open={open} onClose={() => setOpen(false)} /><output data-testid="route">{JSON.stringify(location)}</output></>;
  }
  render(<MemoryRouter><Chooser /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '关联知乎导出目录' }));
  fireEvent.click(await screen.findByRole('button', { name: '关联并阅览' }));
  await waitFor(() => expect(rememberZhihuDirectory).toHaveBeenCalled());
  const data = JSON.parse(screen.getByTestId('route').textContent!).state.exportData;
  expect(data.messages.filter(isNativeLocalMessage).map((message: { id: string }) => message.id))
    .toEqual(edited.messages.filter(isNativeLocalMessage).map(message => message.id));
  expect(data.messages.some((message: { id: string }) => !initial.messages.some(original => original.id === message.id) && !isNativeLocalMessage(message))).toBe(true);
  expect(data).not.toHaveProperty('zhihu');
});
