import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { Link, MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportData } from '../api/client';
import CloudMeetingLogout from '../components/CloudMeetingLogout';
import { useWpsMeetingSync } from '../hooks/useWpsMeetingSync';
import { CLOUD_LOGOUT_KEY, configuredWpsMeetingUrl, isClosedLegacyInlineViewer, legacyLogoutTarget, requestCloudMeetingLogout, WPS_MEETING_SESSION_KEY } from '../utils/cloudMeetingAccount';
import { forgetLegacyWpsArchive, getExportCacheReference, loadLastExport, loadReferencedExport, openFolderMeetingExport, saveLastExport } from '../utils/exportViewerCache';
import { createLocalMessageFile } from '../utils/localMessageFile';
import { createMeetingStart } from '../utils/meetingExchange';

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../utils/wpsMeetingTransport', async importOriginal => ({
  ...await importOriginal<typeof import('../utils/wpsMeetingTransport')>(),
  openWpsMeetingTransport: () => new Promise(() => {}),
}));

beforeEach(async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('indexedDB', new IDBFactory());
  localStorage.clear(); sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function LegacyViewer({ data }: { data: ExportData }) {
  useWpsMeetingSync(data, async () => {});
  return <button onClick={() => requestCloudMeetingLogout()}>退出旧会议</button>;
}
function App({ data, close }: { data: ExportData; close: (active: boolean) => void }) {
  const { pathname } = useLocation();
  return <><output>{pathname}</output>{pathname === '/viewer' && <LegacyViewer data={data} />}
    <CloudMeetingLogout closeViewers={close} /></>;
}

it.each(['此标签页', '另一标签页'])('%s 退出时关闭旧格式 WPS 工作台，仅删除它实际打开的档案', async trigger => {
  const start = await createMeetingStart(createLocalMessageFile());
  const folder = await openFolderMeetingExport(structuredClone(start));
  const keep = getExportCacheReference(folder)!;
  await saveLastExport(start);
  const old = getExportCacheReference(start)!;
  sessionStorage.setItem(WPS_MEETING_SESSION_KEY, JSON.stringify({
    meetingId: start.meeting!.id, baseHash: start.meeting!.baseHash, url: 'https://www.kdocs.cn/l/legacy',
  }));
  const close = vi.fn();
  render(<MemoryRouter initialEntries={[{ pathname: '/viewer', state: { viewerCacheRef: old } }]}>
    <App data={start} close={close} /></MemoryRouter>);
  expect(legacyLogoutTarget()?.archiveId).toBe(old.archiveId);
  fireEvent.click(screen.getByRole('button', { name: '退出旧会议' }));
  expect(screen.getByRole('checkbox')).toBeChecked();
  if (trigger === '此标签页') {
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '退出并清除' }));
    await screen.findByRole('dialog', { name: '已退出云端讨论' });
  } else {
    localStorage.setItem(CLOUD_LOGOUT_KEY, 'remote-logout');
    fireEvent(window, new StorageEvent('storage', { key: CLOUD_LOGOUT_KEY }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }
  expect(close).toHaveBeenCalledWith(true);
  expect(screen.getByRole('status')).toHaveTextContent(/^\/$/);
  expect(sessionStorage.getItem(WPS_MEETING_SESSION_KEY)).toBeNull();
  expect(sessionStorage.getItem('lastExportData')).toBeNull();
  await expect(loadReferencedExport(old)).rejects.toThrow();
  await expect(loadReferencedExport(keep)).resolves.toMatchObject({ meeting: start.meeting });
});

it('preserves a last-opened ordinary archive that has no verified match to the old WPS session', async () => {
  const room = await createMeetingStart(createLocalMessageFile());
  const unrelated = await openFolderMeetingExport(room);
  sessionStorage.setItem(WPS_MEETING_SESSION_KEY, JSON.stringify({
    meetingId: room.meeting!.id, baseHash: 'different-baseline', url: 'https://www.kdocs.cn/l/legacy',
  }));
  expect(await forgetLegacyWpsArchive(legacyLogoutTarget())).toBeUndefined();
  await expect(loadReferencedExport(getExportCacheReference(unrelated))).resolves.toMatchObject({ meeting: room.meeting });
});

it('keeps a folder copy independent after the legacy WPS session has bound another archive of the same meeting', async () => {
  const cloud = await createMeetingStart(createLocalMessageFile());
  await saveLastExport(cloud);
  const binding = getExportCacheReference(cloud)!;
  const url = 'https://www.kdocs.cn/l/legacy';
  sessionStorage.setItem(WPS_MEETING_SESSION_KEY, JSON.stringify({
    meetingId: cloud.meeting!.id, baseHash: cloud.meeting!.baseHash, url, ...binding,
  }));
  const folder = await openFolderMeetingExport(structuredClone(cloud));
  const copy = getExportCacheReference(folder)!;
  expect(configuredWpsMeetingUrl(cloud.meeting, binding)).toBe(url);
  expect(configuredWpsMeetingUrl(folder.meeting, copy)).toBeUndefined();
  const close = vi.fn();
  render(<MemoryRouter initialEntries={[{ pathname: '/viewer', state: { viewerCacheRef: copy } }]}>
    <App data={folder} close={close} /></MemoryRouter>);
  expect(legacyLogoutTarget()?.archiveId).toBe(binding.archiveId);
  localStorage.setItem(CLOUD_LOGOUT_KEY, 'remote-logout');
  fireEvent(window, new StorageEvent('storage', { key: CLOUD_LOGOUT_KEY }));
  await waitFor(() => expect(sessionStorage.getItem(WPS_MEETING_SESSION_KEY)).toBeNull());
  expect(close).toHaveBeenCalledWith(false);
  expect(screen.getByRole('status')).toHaveTextContent('/viewer');
  await expect(loadReferencedExport(binding)).rejects.toThrow();
  await expect(loadReferencedExport(copy)).resolves.toMatchObject({ meeting: cloud.meeting });
});

it('clears the old session-storage fallback and prevents history from reopening that inline viewer', async () => {
  vi.stubGlobal('indexedDB', undefined);
  const start = await createMeetingStart(createLocalMessageFile());
  await saveLastExport(start);
  expect(JSON.parse(sessionStorage.getItem('lastExportData')!).meeting).toEqual(start.meeting);
  sessionStorage.setItem(WPS_MEETING_SESSION_KEY, JSON.stringify({
    meetingId: start.meeting!.id, baseHash: start.meeting!.baseHash, url: 'https://www.kdocs.cn/l/legacy',
  }));
  const state = { exportData: start, viewerInstanceKey: 'old-instance' };
  render(<MemoryRouter initialEntries={[{ pathname: '/viewer', state }]}><App data={start} close={vi.fn()} /></MemoryRouter>);
  localStorage.setItem(CLOUD_LOGOUT_KEY, 'other-tab');
  fireEvent(window, new StorageEvent('storage', { key: CLOUD_LOGOUT_KEY }));
  await waitFor(() => expect(sessionStorage.getItem('lastExportData')).toBeNull());
  expect(await loadLastExport()).toBeNull();
  expect(isClosedLegacyInlineViewer(state, 'old-instance')).toBe(true);
  expect(isClosedLegacyInlineViewer(state, 'fresh-instance')).toBe(false);
});

it('invalidates inline WPS history when another tab logs out after navigation away from the viewer', async () => {
  vi.stubGlobal('indexedDB', undefined);
  const start = await createMeetingStart(createLocalMessageFile());
  await saveLastExport(start);
  sessionStorage.setItem(WPS_MEETING_SESSION_KEY, JSON.stringify({
    meetingId: start.meeting!.id, baseHash: start.meeting!.baseHash, url: 'https://www.kdocs.cn/l/legacy',
  }));
  const state = { exportData: start, viewerInstanceKey: 'previous-wps-visit' };
  render(<MemoryRouter initialEntries={[{ pathname: '/viewer', state }]}>
    <Link to="/">首页</Link><App data={start} close={vi.fn()} />
  </MemoryRouter>);
  expect(isClosedLegacyInlineViewer(state, state.viewerInstanceKey)).toBe(false);
  fireEvent.click(screen.getByRole('link', { name: '首页' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/^\/$/));
  localStorage.setItem(CLOUD_LOGOUT_KEY, 'logout-while-away');
  fireEvent(window, new StorageEvent('storage', { key: CLOUD_LOGOUT_KEY }));
  await waitFor(() => expect(sessionStorage.getItem(WPS_MEETING_SESSION_KEY)).toBeNull());
  expect(isClosedLegacyInlineViewer(state, state.viewerInstanceKey)).toBe(true);
  expect(isClosedLegacyInlineViewer(state, 'reopened-local-file')).toBe(false);
});
