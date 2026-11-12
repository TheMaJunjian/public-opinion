export type OfflineViewerState = 'preparing' | 'ready' | 'unavailable' | 'failed' | 'preview';
let state: OfflineViewerState = import.meta.env.PROD ? 'preparing' : 'preview';
const subscribers = new Set<() => void>();
let starting: Promise<void> | null = null;
let generation = 0;
const buildId = typeof __APP_BUILD_ID__ === 'string' ? __APP_BUILD_ID__ : '';
function publish(value: OfflineViewerState) {
  if (state === value) return;
  state = value;
  subscribers.forEach(callback => callback());
}
export const getOfflineViewerState = () => state;
export function subscribeOfflineViewer(callback: () => void) {
  subscribers.add(callback);
  return () => { subscribers.delete(callback); };
}

function workerReady(worker: ServiceWorker): Promise<boolean | 'updating'> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (ready: boolean | 'updating') => { clearTimeout(timer); channel.port1.close(); resolve(ready); };
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('未收到离线缓存状态')); }, 6000);
    channel.port1.onmessage = event => finish(event.data?.version !== buildId ? 'updating' : event.data.ready === true);
    worker.postMessage({ type: 'OFFLINE_VIEWER_STATUS' }, [channel.port2]);
  });
}

/** Start on the first website visit; opening a file is never sent to the worker or server. */
export function startOfflineViewer(): Promise<void> {
  if (starting) return starting;
  if (!import.meta.env.PROD) return Promise.resolve();
  if (!('serviceWorker' in navigator) || !window.isSecureContext || location.protocol === 'file:') {
    publish('unavailable'); return Promise.resolve();
  }
  const current = ++generation;
  publish('preparing');
  starting = (async () => {
    try {
      const base = new URL(import.meta.env.BASE_URL, document.baseURI);
      const registration = await navigator.serviceWorker.register(new URL('offline-worker.js', base), { scope: base.pathname, updateViaCache: 'none' });
      const check = async (worker: ServiceWorker | null) => {
        if (!worker || worker.state !== 'activated') return;
        try {
          const ready = await workerReady(worker);
          if (current === generation) publish(ready === true ? 'ready' : ready === 'updating' || registration.installing ? 'preparing' : 'failed');
        } catch { if (current === generation && !registration.installing) publish('failed'); }
      };
      const track = () => {
        const worker = registration.installing;
        if (!worker) return;
        const changed = () => {
          if (worker.state === 'activated') { worker.removeEventListener('statechange', changed); void check(worker); }
          else if (worker.state === 'redundant') { worker.removeEventListener('statechange', changed); if (current === generation) publish('failed'); }
        };
        worker.addEventListener('statechange', changed);
        changed();
      };
      registration.addEventListener('updatefound', track);
      track();
      if (!registration.installing) await check(registration.active);
    } catch { if (current === generation) publish('failed'); }
  })();
  return starting;
}
export function retryOfflineViewer() { starting = null; return startOfflineViewer(); }

/** Give first-use authentication and reading priority over downloading the complete offline build. */
export function scheduleOfflineViewer() {
  if (!import.meta.env.PROD) return () => {};
  let done = false;
  const dispose = () => {
    clearTimeout(timer);
    window.removeEventListener('gonglun:entry-ready', ready);
    window.removeEventListener('open-export-viewer', begin);
  };
  const begin = () => { if (done) return; done = true; dispose(); void startOfflineViewer(); };
  const ready = () => { clearTimeout(timer); timer = setTimeout(begin, 1500); };
  let timer = setTimeout(begin, 15000);
  window.addEventListener('gonglun:entry-ready', ready, { once: true });
  window.addEventListener('open-export-viewer', begin, { once: true });
  return () => { done = true; dispose(); };
}
