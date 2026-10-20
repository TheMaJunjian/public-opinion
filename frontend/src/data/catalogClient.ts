import { getDeviceId } from '../api/client';
import type { CatalogData, CatalogFilterQuery, CatalogFilterResult, CatalogOptions } from './catalogEngine';
import type { CatalogProgress } from './globalCatalog';
import type { WorkbenchSnapshot } from '@gonglun/core';

export function createCatalogClient(userId: string, parent: string, callbacks: {
  onReady(data: CatalogData): void;
  onProgress(progress: CatalogProgress): void;
}, regionId?: string) {
  const baseUrl = new URL((import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, ''), location.href).href;
  const options: CatalogOptions = { baseUrl, parent, deviceId: getDeviceId(), regionId, key: JSON.stringify([1, baseUrl, userId, parent]) };
  let stopped = false, priority = false, nextId = 0;
  let failure: Error | undefined;
  let progress: CatalogProgress = { ready: false, count: 0, syncing: true };
  const listeners = new Set<() => void>();
  const onProgress = (next: CatalogProgress) => {
    progress = next; callbacks.onProgress(next); for (const listener of listeners) listener();
  };
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const budgets = new Map<number, () => void>();
  let idle: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    idle = undefined; timer = undefined;
    if (stopped || (!priority && document.hidden)) return;
    for (const resolve of budgets.values()) resolve();
    budgets.clear();
  };
  const schedule = () => {
    if (stopped || idle !== undefined || timer !== undefined || !budgets.size) return;
    if (priority) timer = setTimeout(release, 0);
    else if (!document.hidden) {
      if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(release, { timeout: 2000 });
      else timer = setTimeout(release, 250);
    }
  };
  const prioritize = () => {
    priority = true;
    if (idle !== undefined) window.cancelIdleCallback(idle);
    if (timer !== undefined) clearTimeout(timer);
    idle = undefined; timer = undefined; schedule();
  };
  document.addEventListener('visibilitychange', schedule);
  let worker: Worker | undefined;
  let fallback: Promise<ReturnType<typeof import('./catalogEngine').createCatalogEngine>> | undefined;
  if (typeof Worker === 'function') {
    try { worker = new Worker(new URL('./catalog.worker.ts', import.meta.url), { type: 'module' }); }
    catch { /* A browser policy may disable workers; use the same yielded engine below. */ }
  }
  if (worker) {
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data;
      if (stopped || failure) return;
      if (message.type === 'ready') { priority = false; callbacks.onReady(message.data); }
      else if (message.type === 'progress') onProgress(message.progress);
      else if (message.type === 'idle') { budgets.set(message.id, () => worker?.postMessage({ type: 'idle', id: message.id })); schedule(); }
      else if (message.type === 'result') {
        const request = pending.get(message.id); pending.delete(message.id);
        if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.result);
      }
    };
    worker.onerror = () => {
      const error = new Error('全局消息计算暂时不可用，请刷新重试');
      failure = error;
      onProgress({ ready: false, count: 0, syncing: false, error: error.message });
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    worker.postMessage({ type: 'init', options });
  } else {
    // Older browsers use the identical engine with a yield between bounded pages.
    fallback = import('./catalogEngine').then(({ createCatalogEngine }) => {
      const engine = createCatalogEngine(options, { ...callbacks, onProgress,
        onReady(data) { priority = false; callbacks.onReady(data); },
        idle: () => new Promise(resolve => { budgets.set(++nextId, resolve); schedule(); }),
      });
      if (stopped) engine.stop();
      return engine;
    });
  }
  const request = <T>(type: string, query?: CatalogFilterQuery) => new Promise<T>((resolve, reject) => {
    if (stopped) { reject(new Error('全局消息同步已停止')); return; }
    if (failure) { reject(failure); return; }
    const id = ++nextId; pending.set(id, { resolve: value => resolve(value as T), reject });
    worker!.postMessage({ type, id, query });
  });
  return {
    getProgress: () => progress,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    prioritize,
    catchUp() { if (worker) worker.postMessage({ type: 'catch-up' }); else void fallback?.then(engine => engine.catchUp()); },
    applyCommitted(pages: WorkbenchSnapshot[]) {
      prioritize();
      if (worker) worker.postMessage({ type: 'committed', pages });
      else void fallback?.then(engine => pages.forEach(page => engine.applyCommitted(page)));
    },
    refresh() { prioritize(); return worker ? request<boolean>('refresh') : fallback!.then(engine => engine.refresh()); },
    filters(query: CatalogFilterQuery) { return worker ? request<CatalogFilterResult>('filters', query) : fallback!.then(engine => engine.filters(query)); },
    stop() {
      stopped = true; worker?.terminate(); void fallback?.then(engine => engine.stop());
      document.removeEventListener('visibilitychange', schedule);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer !== undefined) clearTimeout(timer);
      for (const resolve of budgets.values()) resolve(); budgets.clear();
      for (const request of pending.values()) request.reject(new Error('全局消息同步已停止'));
      pending.clear();
    },
  };
}
export type CatalogClient = ReturnType<typeof createCatalogClient>;
