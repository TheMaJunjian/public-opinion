import { act, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryRouter } from 'react-router-dom';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';
import { useWorkbenchData } from '../pages/workbench/useWorkbenchData';
import { getExportCacheReference, loadReferencedExport, saveLastExport, saveLastExportPersistent } from '../utils/exportViewerCache';
import { LocalDiscussion } from '../utils/localDiscussion';
import { createLocalMessageFile } from '../utils/localMessageFile';
import { createMeetingStart } from '../utils/meetingExchange';

beforeEach(async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('indexedDB', new IDBFactory());
  sessionStorage.clear(); localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

async function openMeeting() {
  const data = await createMeetingStart(createLocalMessageFile());
  await saveLastExport(data);
  const wrapper = ({ children }: PropsWithChildren) => <MemoryRouter initialEntries={[{ pathname: '/viewer', state: { exportData: data } }]}>{children}</MemoryRouter>;
  const view = renderHook(() => useWorkbenchData({ user: null, authLoading: false, scopeMessageId: 'root', navigate: vi.fn(), viewMode: 'list' }), { wrapper });
  await waitFor(() => expect(view.result.current.loadedExport).toBe(data));
  const cached = async () => await loadReferencedExport(getExportCacheReference(data)) as ExportData;
  return { ...view, data, cached };
}

async function speak(data: ExportData, speaker: string) {
  const draft = new LocalDiscussion(data, speaker);
  await draft.createMessage('root', { content: speaker });
  let result!: ExportData;
  await draft.commit(async next => { result = next; });
  return result;
}

it('serializes a local send and a folder import based on the same version', async () => {
  const { data, cached, result } = await openMeeting();
  const [local, incoming] = await Promise.all([speak(data, '本机发言'), speak(data, '另一台设备')]);
  const save = result.current.persistMeetingExport;
  await act(async () => {
    await Promise.all([save(local, data, true), save(incoming, data)]);
  });
  const saved = await cached();
  expect(saved.messages.map(row => row.content).sort()).toEqual(['本机发言', '另一台设备'].sort());
  expect(saved.viewerUsername).toBe('本机发言');
  expect(result.current.loadedExport?.messages).toEqual(saved.messages);
});

it('rebases after another tab saves the same meeting without switching the active speaker', async () => {
  const { data, cached, result } = await openMeeting();
  const secondTab = await cached();
  await saveLastExportPersistent(await speak(secondTab, '另一标签页'), secondTab);
  const incoming = await speak(data, '本标签页');
  await act(async () => { await result.current.persistMeetingExport(incoming, data, true); });
  const saved = await cached();
  expect(saved.messages.map(row => row.content).sort()).toEqual(['另一标签页', '本标签页'].sort());
  expect(saved.viewerUsername).toBe('本标签页');
  expect(result.current.loadedExport?.messages).toEqual(saved.messages);
});

it('rejects sync from another open copy or after leaving the viewer', async () => {
  const { data, cached, result, unmount } = await openMeeting();
  const copy = structuredClone(data);
  await saveLastExport(copy);
  const other = await speak(copy, '另外的阅览窗口');
  await expect(result.current.persistMeetingExport(other, copy)).rejects.toThrow('已切换');
  const save = result.current.persistMeetingExport;
  unmount();
  await expect(save(await speak(data, '旧窗口'), data)).rejects.toThrow('页面已切换');
  expect((await cached()).messages).toEqual([]);
});
