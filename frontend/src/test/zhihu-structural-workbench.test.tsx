import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbenchData } from '../pages/workbench/useWorkbenchData';
import { largeStructuralFixture } from './zhihu-structural-fixture';
import type { NativeZhihuView } from '../utils/nativeZhihuView';
import { nativeZhihuDocument, sendNativeZhihuRelation } from '../utils/nativeZhihuEditor';
import { saveLastExportPersistent } from '../utils/exportViewerCache';
import { pageNativeZhihuData } from '../utils/pagedZhihuArchive';

const route = vi.hoisted(() => ({ current: { pathname: '/viewer', search: '', hash: '', key: 'structure',
  state: null as { exportData: NativeZhihuView; viewerNavigation?: { classificationId: string | null } } | null } }));
vi.mock('react-router-dom', () => ({ useLocation: () => route.current }));
vi.mock('../utils/exportViewerCache', () => ({ loadCachedExport: vi.fn(), loadLastExport: vi.fn(), saveLastExportPersistent: vi.fn(),
  loadReferencedExport: vi.fn(), loadExportNavigation: vi.fn(async () => null), releaseDurableExportMemory: vi.fn(), inheritExportCacheReference: (data: unknown) => data }));
const input = { user: null, authLoading: false, scopeMessageId: 'root', navigate: vi.fn(), viewMode: 'list' as const };
const category = (id: string) => `zhihu:question:q${id}`;
const comment = (id: string) => `zhihu:comment:answer%3A${id}:c${id}`;

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  route.current = { ...route.current, state: { exportData: largeStructuralFixture() } };
  vi.mocked(saveLastExportPersistent).mockResolvedValue();
});
afterEach(() => { vi.unstubAllGlobals(); });

it('keeps only a paged source and discards a category read that completes after a newer request', async () => {
  const { Blob: NativeBlob } = await vi.importActual<{ Blob: typeof Blob }>('node:buffer');
  vi.stubGlobal('Blob', NativeBlob);
  const source = route.current.state!.exportData;
  const target = source.messages.find(row => row.id === comment('a'))!;
  target.content = '原始正文'; target.parts = [{ id: 'body', type: 'text', text: target.content }];
  route.current.state!.exportData = await pageNativeZhihuData(source);
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.loadedExport?.messages.find(row => row.id === comment('a'))?.content).toBe('x');
  expect(result.current.messages).toHaveLength(1);
  let release!: () => void;
  const original = NativeBlob.prototype.arrayBuffer;
  const read = vi.spyOn(NativeBlob.prototype, 'arrayBuffer').mockImplementationOnce(function (this: Blob) {
    return new Promise<ArrayBuffer>(resolve => { release = () => { void original.call(this).then(resolve); }; });
  });
  let pending!: Promise<void>;
  act(() => { pending = result.current.loadViewerScope({ classificationId: category('a') }); });
  await waitFor(() => expect(release).toBeTypeOf('function'));
  await act(async () => { await result.current.loadViewerScope({ classificationId: category('b') }); });
  await act(async () => { release(); await pending; });
  expect(result.current.messages.some(row => row.id === comment('b'))).toBe(true);
  expect(result.current.messages.some(row => row.id === comment('a'))).toBe(false);
  read.mockRestore();
});

it('projects only the current layer and keeps the full source for exports and edits', async () => {
  const source = route.current.state!.exportData;
  source.messages.find(row => row.id === comment('b'))!.author = '未打开分类中的作者';
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.messages.map(row => row.id)).toEqual(['zhihu:type:answer']);
  expect(result.current.loadedExport).toBe(source);
  expect(result.current.viewerUsers.some(user => user.username === '未打开分类中的作者')).toBe(true);
  expect(result.current.viewerStructure?.memberCounts('zhihu:type:answer').total).toBeGreaterThan(10_000);
  await act(async () => { await result.current.loadViewerScope({ classificationId: category('a') }); });
  expect(result.current.messages.some(row => row.id === comment('a'))).toBe(true);
  expect(result.current.messages.some(row => row.id === comment('b'))).toBe(false);
  expect(result.current.messages.length).toBeLessThan(10);
  await act(async () => { await result.current.loadViewerScope({ classificationId: category('b') }); });
  expect(result.current.messages.some(row => row.id === comment('b'))).toBe(true);
  expect(result.current.messages.some(row => row.id === comment('a'))).toBe(false);
  expect(result.current.loadedExport?.messages).toHaveLength(source.messages.length);
});

it('opens a saved inner layer directly and cancels an obsolete category request', async () => {
  route.current.state!.viewerNavigation = { classificationId: category('a') };
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.messages.some(row => row.id === comment('a'))).toBe(true);
  await act(async () => {
    const old = result.current.loadViewerScope({ classificationId: category('bulk') });
    const latest = result.current.loadViewerScope({ classificationId: category('b') });
    await Promise.all([old, latest]);
  });
  expect(result.current.messages.some(row => row.id === comment('b'))).toBe(true);
  expect(result.current.messages.length).toBeLessThan(10);
});

it('fetches a known ID from an unloaded branch and rejects missing IDs', async () => {
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { await result.current.ensureMessages([comment('b')]); });
  expect(result.current.messages.some(row => row.id === comment('b'))).toBe(true);
  await expect(result.current.ensureMessages(['absent-id'])).rejects.toThrow('没有该消息');
  expect(result.current.messages.length).toBeLessThan(10);
});

it('commits a synchronized structure and its new counts together, preserving the selected layer', async () => {
  const source = route.current.state!.exportData;
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { await result.current.loadViewerScope({ classificationId: category('b') }); });
  const before = result.current.viewerStructure!, beforeWindow = result.current.viewingExport;
  const next = nativeZhihuDocument(sendNativeZhihuRelation(source, { relationType: 'CLASSIFY', sourceMessageIds: [category('b')], targetMessageIds: [comment('a')] }));
  let commit!: () => void;
  vi.mocked(saveLastExportPersistent).mockImplementationOnce(() => new Promise(resolve => { commit = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.persistPreloadedExport(next, { sourceUpdate: true }); });
  await waitFor(() => expect(commit).toBeTypeOf('function'));
  expect(result.current.viewerStructure).toBe(before);
  expect(result.current.viewingExport).toBe(beforeWindow);
  await act(async () => { commit(); await pending; });
  expect(result.current.loadedExport).toBe(next);
  expect(result.current.viewerStructure?.memberCounts(category('b')).total).toBeGreaterThan(before.memberCounts(category('b')).total);
  expect(result.current.viewerStructure?.containingClassification(comment('a'))).toBe(category('b'));
  expect(result.current.messages.some(row => row.id === comment('a'))).toBe(true);
  expect(result.current.messages.length).toBeLessThan(20);
  expect(saveLastExportPersistent).toHaveBeenCalledWith(next, source, { sourceUpdate: true });
});

it('keeps the old source, window and statistics when a save fails', async () => {
  const source = route.current.state!.exportData;
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(result.current.loading).toBe(false));
  const before = result.current.viewerStructure, beforeWindow = result.current.viewingExport;
  vi.mocked(saveLastExportPersistent).mockRejectedValueOnce(new Error('存储失败'));
  const next = nativeZhihuDocument(sendNativeZhihuRelation(source, { relationType: 'CLASSIFY', sourceMessageIds: [category('b')], targetMessageIds: [comment('a')] }));
  await act(async () => { await expect(result.current.persistPreloadedExport(next)).rejects.toThrow('存储失败'); });
  expect(result.current.viewerStructure).toBe(before);
  expect(result.current.viewingExport).toBe(beforeWindow);
  expect(result.current.loadedExport).toBe(source);
});

it('keeps the newest navigation when a source save completes during a category switch', async () => {
  const source = route.current.state!.exportData;
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { await result.current.loadViewerScope({ classificationId: category('a') }); });
  const next = nativeZhihuDocument(sendNativeZhihuRelation(source, { relationType: 'AGREE', targetMessageIds: [comment('a')] }));
  let commit!: () => void;
  vi.mocked(saveLastExportPersistent).mockImplementationOnce(() => new Promise(resolve => { commit = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.persistPreloadedExport(next, { sourceUpdate: true }); });
  await act(async () => { await result.current.loadViewerScope({ classificationId: category('b') }); });
  await act(async () => { commit(); await pending; });
  expect(result.current.loadedExport).toBe(next);
  expect(result.current.messages.some(row => row.id === comment('b'))).toBe(true);
  expect(result.current.messages.some(row => row.id === comment('a'))).toBe(false);
});
it('reuses the same category projections through repeated enter/exit cycles', async () => {
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(result.current.loading).toBe(false));
  const overview = result.current.messages;
  await act(async () => { await result.current.loadViewerScope({ classificationId: category('a') }); });
  const inside = result.current.messages;
  for (let n = 0; n < 12; n++) {
    await act(async () => { await result.current.loadViewerScope({ classificationId: null }); });
    expect(result.current.messages).toBe(overview);
    await act(async () => { await result.current.loadViewerScope({ classificationId: category('a') }); });
    expect(result.current.messages).toBe(inside);
  }
});

it('does not materialize edges inside closed categories while preserving their full counts', async () => {
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'zhihu:type:answer' }); });
  expect(result.current.messages.length).toBeLessThan(10);
  expect(result.current.edges.length).toBeLessThan(10);
  expect(result.current.viewerStructure?.memberCounts(category('bulk')).total).toBeGreaterThan(10_000);
  const ids = new Set(result.current.messages.map(message => message.id));
  expect(result.current.edges.every(edge => ids.has(edge.to.messageId))).toBe(true);
  expect(result.current.relations.find(row => row.id === category('bulk'))?.targetRefs.length).toBeGreaterThan(10_000);
});
