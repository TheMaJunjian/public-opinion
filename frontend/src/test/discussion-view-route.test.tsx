import { act, renderHook, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';
import { api } from '../api';
import { useWorkbenchData } from '../pages/workbench/useWorkbenchData';
import { useDiscussionView } from '../pages/workbench/useDiscussionView';
import { getExportCacheReference, loadExportDiscussionView, saveExportDiscussionView, saveLastExport } from '../utils/exportViewerCache';
import { resetWorkbenchActivity } from '../utils/workbenchActivity';

vi.mock('../api', () => ({ api: { getWorkbenchSnapshot: vi.fn(), subscribeChanges: vi.fn() } }));
const doc = (id: string): ExportData => ({ format: 'gonglun-view-3', formatVersion: 5, exportedAt: '',
  scope: { messageId: null, title: '' }, messages: [{ id, kind: 'TEXT', contentType: 'TEXT', content: '',
    author: '', authorId: '', createdAt: '', revision: 1, parts: [{ id: 'body', type: 'text', text: '' }] }], relations: [] });
const folds = (id: string) => ({ mode: 'discussion' as const, collapsed: [JSON.stringify([id, 'reply'])] });

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); resetWorkbenchActivity(); window.history.replaceState(null, '', '/'); });

it('restores the exact native document and its folds after router state cloning, independently of the last file', async () => {
  const first = doc('1'), second = doc('2');
  await saveLastExport(first);
  await saveExportDiscussionView(first, folds('1'));
  const route = structuredClone({ exportData: first, viewerCacheRef: getExportCacheReference(first) });
  await saveLastExport(second);
  await saveExportDiscussionView(second, folds('2'));
  window.history.replaceState({ usr: route, key: 'native-cached-route', idx: 0 }, '', '/viewer');
  const hook = renderHook(() => {
    const data = useWorkbenchData({ user: null, authLoading: false, scopeMessageId: 'root', navigate: vi.fn(), viewMode: 'graph' });
    return { data, discussion: useDiscussionView(data.loadedExport) };
  }, { wrapper: BrowserRouter });
  await waitFor(() => expect(hook.result.current.data.messages.map(message => message.id)).toEqual(['1']));
  await waitFor(() => expect(hook.result.current.discussion.value).toEqual(folds('1')));
  act(() => hook.result.current.discussion.onChange({ mode: 'graph', collapsed: [] }));
  await waitFor(async () => expect(await loadExportDiscussionView(first)).toEqual({ mode: 'graph', collapsed: [] }));
  expect(await loadExportDiscussionView(second)).toEqual(folds('2'));
  expect(api.getWorkbenchSnapshot).not.toHaveBeenCalled();
  expect(api.subscribeChanges).not.toHaveBeenCalled();
});

it('rejects a reference assembled from two files instead of displaying or modifying either as the other', async () => {
  const first = doc('1'), second = doc('2');
  await saveLastExport(first); const firstRef = getExportCacheReference(first)!;
  await saveLastExport(second); const secondRef = getExportCacheReference(second)!;
  window.history.replaceState({ usr: structuredClone({ exportData: first,
    viewerCacheRef: { ...firstRef, viewCacheId: secondRef.viewCacheId } }), key: 'invalid-cached-route', idx: 0 }, '', '/viewer');
  const hook = renderHook(() => useWorkbenchData({ user: null, authLoading: false, scopeMessageId: 'root', navigate: vi.fn(), viewMode: 'graph' }), { wrapper: BrowserRouter });
  await waitFor(() => expect(hook.result.current.loadError).toContain('已更换或不存在'));
  expect(hook.result.current.loadedExport).toBeNull();
  expect(hook.result.current.messages).toHaveLength(0);
  expect(await loadExportDiscussionView(first)).toBeNull();
  expect(await loadExportDiscussionView(second)).toBeNull();
  expect(api.getWorkbenchSnapshot).not.toHaveBeenCalled();
});
