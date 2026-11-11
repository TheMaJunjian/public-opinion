import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<{ ms: number; count: number }>();

/** Optional request-local timing; no SQL text, arguments or global counters. */
export async function measureQueries<T>(run: () => Promise<T>) {
  const timing = { ms: 0, count: 0 };
  const value = await scope.run(timing, run);
  return { value, ...timing };
}

export async function timeQuery<T>(run: () => Promise<T>): Promise<T> {
  const timing = scope.getStore();
  if (!timing) return run();
  const start = performance.now();
  try { return await run(); }
  finally { timing.ms += performance.now() - start; timing.count++; }
}
