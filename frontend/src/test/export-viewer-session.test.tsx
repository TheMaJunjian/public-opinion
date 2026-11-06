import { StrictMode, type ReactNode } from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbenchData } from '../pages/workbench/useWorkbenchData';
import * as cache from '../utils/exportViewerCache';
import * as archive from '../utils/exportArchive';
import { createExportViewerState, getPreparedViewerExport, RETAINED_VIEWER_MESSAGE_LIMIT } from '../utils/exportViewerSession';
import { prepareZhihuForViewing } from '../utils/zhihuArchive';

vi.mock('../api', () => ({ api: { getWorkbenchSnapshot: vi.fn(), subscribeChanges: vi.fn() } }));
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

it('hands off verified data once without history copies or a second preparation, and reloads by reference after unmount', async () => {
  const data = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1,
    items: [{ id: 'article', type: 'article', text: '技术测试正文' }], comments: [] });
  await cache.saveLastExport(data);
  const state = createExportViewerState(data, { classificationId: 'zhihu:article:article' });
  expect(state.exportData).toBeUndefined();
  expect(JSON.stringify(state).length).toBeLessThan(350);
  const restore = vi.spyOn(cache, 'loadReferencedExport');
  const prepare = vi.spyOn(archive, 'prepareExportForViewing');
  const wrapper = ({ children }: { children: ReactNode }) => <StrictMode><MemoryRouter initialEntries={[
    { pathname: '/viewer', state: structuredClone(state) },
  ]}>{children}</MemoryRouter></StrictMode>;
  const input = { user: null, authLoading: false, scopeMessageId: 'root', navigate: vi.fn(), viewMode: 'list' as const };
  const first = renderHook(() => useWorkbenchData(input), { wrapper });
  await waitFor(() => expect(first.result.current.loadedExport).toBe(data));
  expect(restore).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(getPreparedViewerExport(state.viewerInstanceKey)).toBeNull();
  first.unmount();
  await cache.saveExportNavigation(data, { classificationId: null, classificationPath: [] });
  const reopened = renderHook(() => useWorkbenchData(input), { wrapper });
  await waitFor(() => expect(reopened.result.current.loadedExport?.messages).toEqual(data.messages));
  expect(restore).toHaveBeenCalledWith(state.viewerCacheRef, { sourceOnly: true, paged: true });
  expect(prepare).toHaveBeenCalled();
  expect(reopened.result.current.viewerNavigation).toEqual({ classificationId: null, classificationPath: [] });
  expect(reopened.result.current.loadError).toBeNull();
});

it('retains history recovery when durable storage is unavailable', async () => {
  vi.stubGlobal('indexedDB', undefined);
  const data = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1, items: [], comments: [] });
  await cache.saveLastExport(data);
  const state = createExportViewerState(data);
  expect(state.exportData).toBe(data);
  expect(state.viewerCacheRef).toBeUndefined();
});

it('marks large viewers for eviction on exit while preserving the navigation reference', async () => {
  const data = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1, items: [{ id: 'article', type: 'article', text: '' }], comments: [] });
  data.messages = Array.from({ length: RETAINED_VIEWER_MESSAGE_LIMIT + 1 }, (_, index) => ({ ...data.messages[0], id: `record-${index}` }));
  await cache.saveLastExport(data);
  const navigation = { classificationId: null, classificationPath: [] };
  const state = createExportViewerState(data, navigation);
  expect(state.viewerRetain).toBe(false);
  expect(state.exportData).toBeUndefined();
  expect(state.viewerCacheRef).toEqual(cache.getExportCacheReference(data));
  expect(state.viewerNavigation).toEqual(navigation);
});

it('never puts a large file into browser history when storage is unavailable', () => {
  const data = prepareZhihuForViewing({ format: 'gonglun-zhihu-archive', version: 1, items: [{ id: 'article', type: 'article', text: '' }], comments: [] });
  data.messages = Array(RETAINED_VIEWER_MESSAGE_LIMIT + 1).fill(data.messages[0]);
  const state = createExportViewerState(data);
  expect(state.exportData).toBeUndefined();
  expect(state.viewerCacheRef).toBeUndefined();
  expect(JSON.stringify(state).length).toBeLessThan(150);
  expect(getPreparedViewerExport(state.viewerInstanceKey)).toBe(data);
});
