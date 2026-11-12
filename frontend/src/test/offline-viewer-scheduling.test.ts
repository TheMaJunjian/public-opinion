import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('defers full offline caching until after the first readable page, while explicit offline use can start immediately', async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.stubEnv('PROD', true);
  const register = vi.fn(async () => ({ addEventListener: vi.fn(), installing: null, active: null }));
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  const { scheduleOfflineViewer } = await import('../utils/offlineViewer');
  const cancel = scheduleOfflineViewer();
  await vi.advanceTimersByTimeAsync(5000);
  expect(register).not.toHaveBeenCalled();
  window.dispatchEvent(new Event('gonglun:entry-ready'));
  await vi.advanceTimersByTimeAsync(1499);
  expect(register).not.toHaveBeenCalled();
  window.dispatchEvent(new Event('open-export-viewer'));
  await vi.advanceTimersByTimeAsync(0);
  expect(register).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(20000);
  expect(register).toHaveBeenCalledOnce(); cancel();
});
