import { readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/** Precache the complete build, including lazy views and worker chunks. Never cache API responses. */
export function createOfflineWorkerSource(files: string[], version: string): string {
  return `const VERSION = ${JSON.stringify(version)};
const PREFIX = 'gonglun-offline-viewer-';
const CACHE = PREFIX + VERSION;
const ROOT = self.registration.scope;
const FILES = ${JSON.stringify(files)}.map(path => new URL(path, ROOT).href);
const ASSETS = new Set(FILES);
const INDEX = new URL('index.html', ROOT).href;
const BASE = new URL(ROOT).pathname;
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  try {
    await cache.addAll(FILES.map(url => new Request(url, { cache: 'reload', credentials: 'omit' })));
    await self.skipWaiting();
  } catch (error) { await caches.delete(CACHE); throw error; }
})()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// Older version caches remain usable by tabs still holding old lazy-chunk URLs.
async function cachedAsset(request) {
  const current = await caches.open(CACHE);
  // These are anonymous, build-time static resources. Some static hosts add
  // Vary: Origin even though module and worker responses have identical bytes.
  const found = await current.match(request, { ignoreVary: true });
  if (found) return found;
  for (const name of await caches.keys()) {
    if (!name.startsWith(PREFIX) || name === CACHE) continue;
    const previous = await (await caches.open(name)).match(request, { ignoreVary: true });
    if (previous) return previous;
  }
}
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== new URL(ROOT).origin || !url.pathname.startsWith(BASE)) return;
  const path = url.pathname.slice(BASE.length);
  if (path === 'api' || path.startsWith('api/') || path === 'build.json' || path === 'offline-worker.js') return;
  const isAppPage = request.mode === 'navigate' && /^(?:index\\.html|viewer|messages(?:\\/[^/]+)?|login|register)?\\/?$/.test(path);
  if (isAppPage) {
    event.respondWith((async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch(request, { signal: controller.signal });
        if (response.ok) return response;
        return await (await caches.open(CACHE)).match(INDEX) || response;
      } catch (error) {
        const fallback = await (await caches.open(CACHE)).match(INDEX);
        if (fallback) return fallback;
        throw error;
      } finally { clearTimeout(timer); }
    })());
  } else if (ASSETS.has(url.href) || path.startsWith('assets/')) {
    event.respondWith((async () => await cachedAsset(request) || fetch(request))());
  }
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'OFFLINE_VIEWER_STATUS' || !event.ports?.[0]) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const saved = new Set((await cache.keys()).map(request => request.url));
    event.ports[0].postMessage({ version: VERSION, ready: FILES.every(url => saved.has(url)) });
  })());
});
`;
}

export function offlineViewerPlugin(version: string): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'offline-viewer', apply: 'build', enforce: 'post',
    configResolved(value) { config = value; },
    async writeBundle() {
      const directory = resolve(config.root, config.build.outDir);
      const walk = async (folder: string): Promise<string[]> => {
        const entries = await readdir(folder, { withFileTypes: true });
        const parts = await Promise.all(entries.map(entry => entry.isDirectory() ? walk(resolve(folder, entry.name))
          : Promise.resolve([relative(directory, resolve(folder, entry.name)).replaceAll('\\', '/')]))) ;
        return parts.flat();
      };
      const files = (await walk(directory)).filter(file => !['offline-worker.js', 'build.json'].includes(file) && !file.endsWith('.map')).sort();
      if (!files.includes('index.html')) throw new Error('离线阅览构建缺少入口页面');
      await writeFile(resolve(directory, 'offline-worker.js'), createOfflineWorkerSource(files, version));
    },
  };
}
