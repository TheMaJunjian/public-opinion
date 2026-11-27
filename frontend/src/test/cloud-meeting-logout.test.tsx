import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CloudMeetingLogout from '../components/CloudMeetingLogout';
import { CLOUD_LOGOUT_KEY, requestCloudMeetingLogout } from '../utils/cloudMeetingAccount';
import { clearGitMeetingTokens, gitMeetingToken, setGitMeetingToken } from '../utils/gitMeetingSession';
import { getPendingWpsDocument } from '../utils/wpsAccessReturn';

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: null, logout: vi.fn() }) }));
const repository = 'https://github.com/example/group';
const closeViewers = vi.fn();

function Page() {
  const { pathname } = useLocation();
  return <><output data-testid="route">{pathname}</output>
    <button onClick={() => requestCloudMeetingLogout()}>退出云端讨论</button>
    <CloudMeetingLogout closeViewers={closeViewers} /></>;
}

function openDiscussion(provider: 'git' | 'wps') {
  render(<MemoryRouter initialEntries={[{ pathname: '/viewer', state: { viewerCacheRef: { archiveId: provider === 'git' ? 'git-issue:example' : 'wps-document:example' } } }]}>
    <Page />
  </MemoryRouter>);
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  setGitMeetingToken(repository, 'test-credential');
});
afterEach(() => {
  cleanup(); clearGitMeetingTokens(); localStorage.clear(); sessionStorage.clear();
  window.history.replaceState(null, ''); vi.unstubAllGlobals(); vi.clearAllMocks();
});

it('allows cancelling a Git sign-out, then clears credentials and leaves the viewer on confirmation', async () => {
  const pending = 'gonglun:git-pending:' + 'a'.repeat(64);
  sessionStorage.setItem(pending, 'pending test batch');
  localStorage.setItem('unrelated-test-key', 'keep');
  openDiscussion('git');
  fireEvent.click(screen.getByRole('button', { name: '退出云端讨论' }));
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(gitMeetingToken(repository)).toBe('test-credential');
  expect(closeViewers).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '退出云端讨论' }));
  fireEvent.click(screen.getByRole('button', { name: '退出并清除' }));
  await screen.findByRole('dialog', { name: '已退出云端讨论' });
  expect(screen.getByTestId('route')).toHaveTextContent(/^\/$/);
  expect(gitMeetingToken(repository)).toBe('');
  expect(sessionStorage.getItem(pending)).toBeNull();
  expect(localStorage.getItem('unrelated-test-key')).toBe('keep');
  expect(closeViewers).toHaveBeenCalledWith(true);
});

it('offers WPS account management and stops this viewer when another tab signs out', async () => {
  openDiscussion('wps');
  fireEvent.click(screen.getByRole('button', { name: '退出云端讨论' }));
  expect(screen.getByRole('checkbox')).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  const previousHistory = { gonglunWpsAccessReturn: 'https://www.kdocs.cn/l/example' };
  window.history.replaceState(previousHistory, '');
  expect(getPendingWpsDocument()).toBe(previousHistory.gonglunWpsAccessReturn);
  localStorage.setItem(CLOUD_LOGOUT_KEY, 'logout-in-another-tab');
  fireEvent(window, new StorageEvent('storage', { key: CLOUD_LOGOUT_KEY, newValue: 'logout-in-another-tab' }));
  await waitFor(() => expect(gitMeetingToken(repository)).toBe(''));
  expect(screen.getByTestId('route')).toHaveTextContent(/^\/$/);
  window.history.replaceState(previousHistory, '');
  expect(getPendingWpsDocument()).toBeNull();
});
