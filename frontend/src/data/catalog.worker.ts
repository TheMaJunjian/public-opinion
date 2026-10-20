import { createCatalogEngine, type CatalogOptions, type CatalogFilterQuery } from './catalogEngine';
import type { WorkbenchSnapshot } from '@gonglun/core';

let engine: ReturnType<typeof createCatalogEngine> | undefined;
let nextIdle = 0;
const idleWaiters = new Map<number, () => void>();
self.onmessage = (event: MessageEvent<{ type: string; id: number; options: CatalogOptions; query: CatalogFilterQuery; pages: WorkbenchSnapshot[] }>) => {
  const { type, id, options, query } = event.data;
  if (type === 'idle') { idleWaiters.get(id)?.(); idleWaiters.delete(id); return; }
  if (type === 'init') {
    engine = createCatalogEngine(options, {
      idle: () => new Promise(resolve => { const id = ++nextIdle; idleWaiters.set(id, resolve); self.postMessage({ type: 'idle', id }); }),
      onReady: data => self.postMessage({ type: 'ready', data }),
      onProgress: progress => self.postMessage({ type: 'progress', progress }),
    });
  } else if (type === 'catch-up') engine?.catchUp();
  else if (type === 'committed') event.data.pages.forEach(page => engine?.applyCommitted(page));
  else if (type === 'refresh' || type === 'filters') {
    void (async () => {
      try {
        if (!engine) throw new Error('全局消息尚未载入');
        const result = type === 'refresh' ? await engine.refresh() : engine.filters(query);
        self.postMessage({ type: 'result', id, result });
      } catch (error) { self.postMessage({ type: 'result', id, error: error instanceof Error ? error.message : String(error) }); }
    })();
  }
};
