import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AppUpdateNotice from '../components/AppUpdateNotice';

const fetchMock = vi.fn();
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('fetch', fetchMock); fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'old' }) }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
const flush = async () => { await act(async () => {}); };

it('detects a new deployment in an already-open tab, bypassing cache, without automatically refreshing', async () => {
  const refresh = vi.fn();
  render(<AppUpdateNotice enabled buildId="old" onRefresh={refresh} />);
  await flush();
  expect(screen.queryByRole('dialog')).toBeNull();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'new' }) });
  await act(async () => { vi.advanceTimersByTime(60000); });
  expect(screen.getByRole('dialog', { name: '版本更新' })).toHaveTextContent('发现新版本');
  expect(fetchMock).toHaveBeenLastCalledWith(expect.any(URL), expect.objectContaining({ cache: 'no-store' }));
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '立即刷新' }));
  expect(refresh).toHaveBeenCalledOnce();
});

it('checks again when returning to the tab, and ignores failed or invalid version responses', async () => {
  render(<AppUpdateNotice enabled buildId="old" />);
  await flush();
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  fireEvent(window, new Event('focus')); await flush();
  expect(screen.queryByRole('dialog')).toBeNull();
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
  fireEvent(document, new Event('visibilitychange')); await flush();
  expect(screen.queryByRole('dialog')).toBeNull();
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'new' }) });
  fireEvent(window, new Event('focus')); await flush();
  expect(screen.getByRole('dialog', { name: '版本更新' })).toHaveTextContent('发现新版本');
});

it('centers the modal within the visible viewport and allows deferring the same version without repeated interruptions', async () => {
  const viewport = new EventTarget();
  Object.assign(viewport, { offsetLeft: 80, offsetTop: 120, width: 360, height: 440 });
  vi.stubGlobal('visualViewport', viewport);
  const refresh = vi.fn();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'new' }) });
  render(<AppUpdateNotice enabled buildId="old" onRefresh={refresh} />); await flush();
  const dialog = screen.getByRole('dialog', { name: '版本更新' });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  const overlay = dialog.closest('[data-popup-content-layer]')!;
  expect(overlay).toHaveStyle({ left: '80px', top: '120px', width: '360px', height: '440px',
    display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' });
  fireEvent.click(screen.getByRole('button', { name: '稍后处理' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.body.style.overflow).not.toBe('hidden');
  await act(async () => { vi.advanceTimersByTime(60000); });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(refresh).not.toHaveBeenCalled();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'newer' }) });
  fireEvent(window, new Event('focus')); await flush();
  expect(screen.getByRole('dialog', { name: '版本更新' })).toBeInTheDocument();
});

it('cancels its pending check on unmount and does not keep polling', async () => {
  fetchMock.mockReturnValue(new Promise(() => {}));
  const { unmount } = render(<AppUpdateNotice enabled buildId="old" />);
  const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => { vi.advanceTimersByTime(120000); });
  expect(fetchMock).toHaveBeenCalledOnce();
});
