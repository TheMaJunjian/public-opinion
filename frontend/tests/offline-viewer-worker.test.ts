import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createOfflineWorkerSource } from '../offlineViewerPlugin';

function runtime(files = ['index.html', 'assets/app.js', 'assets/lazy-view.js', 'assets/scene.worker.js'], failInstall = false) {
  const handlers = new Map<string, (event: any) => void>();
  const saved = new Map<string, Map<string, { url: string; body: string }>>();
  const fetch = vi.fn(async () => { throw new Error('offline'); });
  const addRequests: Request[] = [];
  const caches = {
    open: async (name: string) => {
      if (!saved.has(name)) saved.set(name, new Map());
      const values = saved.get(name)!;
      return {
        addAll: async (requests: Request[]) => {
          addRequests.push(...requests);
          for (const request of requests) {
            values.set(request.url, { url: request.url, body: request.url.endsWith('index.html') ? 'app shell' : 'lazy code' });
            if (failInstall) throw new Error('quota');
          }
        },
        match: async (request: Request | string, options?: { ignoreVary?: boolean }) => {
          // Module requests send Origin, while an anonymous worker precache may not.
          if (typeof request !== 'string' && request.url.includes('/assets/') && !options?.ignoreVary) return undefined;
          return values.get(typeof request === 'string' ? request : request.url);
        },
        keys: async () => [...values.keys()].map(url => ({ url })),
      };
    }, keys: async () => [...saved.keys()], delete: async (name: string) => saved.delete(name),
  };
  const skipWaiting = vi.fn(), claim = vi.fn();
  runInNewContext(createOfflineWorkerSource(files, 'build-one'), {
    self: { registration: { scope: 'https://gonglun.test/' }, addEventListener: (kind: string, action: (event: any) => void) => handlers.set(kind, action), skipWaiting, clients: { claim } },
    caches, fetch, Request, URL, AbortController, setTimeout, clearTimeout,
  });
  const dispatch = async (kind: string, properties: Record<string, unknown> = {}) => {
    let result: Promise<unknown> | undefined;
    handlers.get(kind)!({ ...properties, waitUntil: (value: Promise<unknown>) => { result = value; }, respondWith: (value: Promise<unknown>) => { result = value; } });
    return result ? await result : undefined;
  };
  const request = (path: string, mode = 'cors', method = 'GET') => ({ url: `https://gonglun.test${path}`, mode, method });
  return { dispatch, request, saved, fetch, addRequests, skipWaiting, claim };
}

describe('offline viewing build cache', () => {
  it('opens the app and previously unopened lazy views/workers after the network is lost', async () => {
    const app = runtime();
    await app.dispatch('install');
    await app.dispatch('activate');
    expect(app.skipWaiting).toHaveBeenCalledOnce();
    expect(app.claim).toHaveBeenCalledOnce();
    expect(app.addRequests.every(request => request.credentials === 'omit')).toBe(true);
    expect(await app.dispatch('fetch', { request: app.request('/viewer', 'navigate') })).toMatchObject({ body: 'app shell' });
    for (const path of ['/assets/lazy-view.js', '/assets/scene.worker.js']) {
      expect(await app.dispatch('fetch', { request: app.request(path) })).toMatchObject({ body: 'lazy code' });
    }
    expect(app.fetch).toHaveBeenCalledTimes(1);
    const postMessage = vi.fn();
    await app.dispatch('message', { data: { type: 'OFFLINE_VIEWER_STATUS' }, ports: [{ postMessage }] });
    expect(postMessage).toHaveBeenCalledWith({ version: 'build-one', ready: true });
  });

  it('leaves API, submissions, external pages and version checks outside the cache', async () => {
    const app = runtime();
    await app.dispatch('install');
    for (const request of [app.request('/api/session'), app.request('/api/commands', 'cors', 'POST'), app.request('/build.json'),
      app.request('/api/session', 'navigate'), { ...app.request('/assets/private.js'), url: 'https://other.test/assets/private.js' }]) {
      expect(await app.dispatch('fetch', { request })).toBeUndefined();
    }
    expect(app.fetch).not.toHaveBeenCalled();
  });

  it('never activates or reports readiness after an incomplete install', async () => {
    const app = runtime(undefined, true);
    await expect(app.dispatch('install')).rejects.toThrow('quota');
    expect(app.skipWaiting).not.toHaveBeenCalled();
    expect(app.saved.size).toBe(0);
    const postMessage = vi.fn();
    await app.dispatch('message', { data: { type: 'OFFLINE_VIEWER_STATUS' }, ports: [{ postMessage }] });
    expect(postMessage).toHaveBeenCalledWith({ version: 'build-one', ready: false });
  });

  it('keeps an older open tab’s cached lazy chunks available during an update', async () => {
    const app = runtime();
    await app.dispatch('install');
    const url = 'https://gonglun.test/assets/previous-view.js';
    app.saved.set('gonglun-offline-viewer-previous', new Map([[url, { url, body: 'previous code' }]]));
    await app.dispatch('activate');
    expect(await app.dispatch('fetch', { request: app.request('/assets/previous-view.js') })).toMatchObject({ body: 'previous code' });
    expect(app.fetch).not.toHaveBeenCalled();
  });
});
