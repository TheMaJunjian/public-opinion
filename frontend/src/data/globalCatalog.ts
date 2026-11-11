import type { WorkbenchSnapshot } from '@gonglun/core';
import { WorkbenchStore, type SnapshotQuery } from './workbench';

export interface CatalogCheckpoint {
  snapshot: WorkbenchSnapshot;
  boundary: number;
  after: number;
  nextCursor: string | null;
  phase: 'pages' | 'changes';
  complete: boolean;
  pages: number;
}
export interface CatalogCache {
  load(): Promise<CatalogCheckpoint | null>;
  save(value: CatalogCheckpoint): Promise<void>;
  clear(): Promise<void>;
  /** Atomically append just the received page and its replay position. */
  append?(position: CatalogPosition, page: WorkbenchSnapshot): Promise<void>;
}
export type CatalogPosition = Omit<CatalogCheckpoint, 'snapshot'> & { regionId: string; sequence: number };
export interface CatalogProgress { ready: boolean; count: number; syncing: boolean; error?: string }
/** Complete replay since the previous published index; absent after reset or optimistic publication. */
export interface CatalogUpdate { previousSequence: number; changedIds: string[] }

/** A separate cursor is essential: fetching a visible window cannot complete the global index. */
export function syncGlobalCatalog(options: {
  parent: string;
  regionId?: string;
  cache: CatalogCache;
  load(query: SnapshotQuery): Promise<WorkbenchSnapshot>;
  idle(signal: AbortSignal): Promise<void>;
  onReady(snapshot: WorkbenchSnapshot, update?: CatalogUpdate): void;
  onProgress(progress: CatalogProgress): void;
}) {
  const abort = new AbortController();
  let store = new WorkbenchStore();
  let checkpoint: CatalogCheckpoint | null = null;
  let initialized = false, stopped = false, running = false, queued = false, ready = false;
  let resetRequested = false;
  let publishedAfter = -1, failures = 0;
  let previousPublication: number | undefined;
  const changedIds = new Set<string>();
  const rememberChanges = (page: WorkbenchSnapshot) => {
    for (const id of [...page.messages.map(row => row.id), ...page.relations.map(row => row.id),
      ...page.removedMessageIds ?? [], ...page.removedMemberships ?? [],
      ...Object.keys(page.stakes), ...Object.keys(page.tagCounts), ...Object.keys(page.attentionUsers)]) changedIds.add(id);
  };
  let journalPages = 0;
  let lastError: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiters = new Set<{ resolve(changed: boolean): void; reject(error: Error): void }>();
  const report = () => { if (!stopped) options.onProgress({ ready, count: store.size, syncing: running || queued, ...(lastError ? { error: lastError } : {}) }); };
  const request = (query: Partial<SnapshotQuery>) => {
    abort.signal.throwIfAborted();
    return options.load({ parent: options.parent, ...query, signal: abort.signal });
  };
  const save = async (page: WorkbenchSnapshot) => {
    if (!checkpoint) return;
    const { snapshot, ...position } = checkpoint;
    // Bounded page writes avoid copying and serializing the growing catalog on
    // every request. Compact only after a complete replay, at most once per 64 pages.
    if (options.cache.append && snapshot.regionId && !(checkpoint.complete && journalPages >= 64)) {
      await options.cache.append({ ...position, regionId: snapshot.regionId, sequence: store.sequence }, page);
      journalPages++;
      return;
    }
    checkpoint = { ...checkpoint, snapshot: store.snapshot() };
    await options.cache.save(checkpoint);
    journalPages = 0;
  };
  const publish = () => {
    if (!checkpoint || stopped || resetRequested) return;
    if (!ready || publishedAfter !== checkpoint.after) {
      publishedAfter = checkpoint.after;
      ready = true;
      const snapshot = { ...store.snapshot(), sequence: checkpoint.after };
      const update = previousPublication === undefined ? undefined : { previousSequence: previousPublication, changedIds: [...changedIds] };
      previousPublication = snapshot.sequence; changedIds.clear();
      if (update) options.onReady(snapshot, update); else options.onReady(snapshot);
    }
  };
  const schedule = (delay = 0) => {
    queued = true;
    if (!stopped && !running && !timer) timer = setTimeout(() => { timer = undefined; void run(); }, delay);
  };
  async function run() {
    if (running || stopped) return;
    running = true; queued = false; report();
    const waiting = [...waiters];
    const before = publishedAfter;
    try {
      if (resetRequested) {
        resetRequested = false;
        await options.cache.clear();
        if (stopped) return;
        store = new WorkbenchStore(); checkpoint = null; ready = false; publishedAfter = -1; initialized = true; journalPages = 0;
        previousPublication = undefined; changedIds.clear();
      }
      if (!initialized) {
        checkpoint = await options.cache.load();
        if (checkpoint && options.regionId && checkpoint.snapshot.regionId !== options.regionId) {
          await options.cache.clear(); checkpoint = null;
        }
        initialized = true;
        if (checkpoint) {
          // An incomplete cache may contain pages newer than the replay boundary.
          // Replaying from that boundary, rather than snapshot.sequence, closes pagination races.
          store.apply({ ...checkpoint.snapshot, sequence: checkpoint.complete ? checkpoint.after : 0 }, true);
          // Confirm cached records against server changes before enabling automatic writes.
        }
      }
      if (!checkpoint) {
        await options.idle(abort.signal);
        const page = await request({ limit: 200, batch: 4 });
        if (stopped || resetRequested) return;
        store.apply(page);
        checkpoint = { snapshot: store.snapshot(), boundary: page.sequence, after: page.sequence,
          nextCursor: page.nextCursor ?? null, phase: 'pages', complete: false, pages: 1 };
        await save(page); report();
      }
      while (checkpoint.phase === 'pages' && checkpoint.nextCursor) {
        await options.idle(abort.signal);
        const page = await request({ cursor: checkpoint.nextCursor, regionId: checkpoint.snapshot.regionId, limit: 200, batch: 4 });
        if (stopped || resetRequested) return;
        store.apply(page);
        checkpoint.pages++;
        checkpoint.nextCursor = page.nextCursor ?? null;
        await save(page); report();
      }
      if (checkpoint.phase === 'pages') {
        checkpoint.phase = 'changes';
        checkpoint.after = checkpoint.boundary;
      }
      let more: boolean;
      do {
        await options.idle(abort.signal);
        const page = await request({ after: checkpoint.after, regionId: checkpoint.snapshot.regionId });
        if (stopped || resetRequested) return;
        if (page.sequence < checkpoint.after || (page.hasMore && page.sequence === checkpoint.after)) throw new Error('全局消息同步进度无效');
        const unchanged = checkpoint.complete && page.sequence === checkpoint.after && !page.messages.length
          && !page.relations.length && !page.removedMessageIds?.length;
        rememberChanges(page); store.apply(page);
        checkpoint.after = page.sequence;
        more = !!page.hasMore || store.sequence > checkpoint.after;
        checkpoint.complete = !more;
        if (!unchanged) await save(page);
        report();
      } while (more && !stopped);
      if (stopped || resetRequested) return;
      publish(); failures = 0; lastError = undefined;
      for (const waiter of waiting) { waiters.delete(waiter); waiter.resolve(before !== publishedAfter); }
    } catch (error) {
      if (stopped) return;
      if ((error as { status?: number }).status === 409) {
        await options.cache.clear();
        store = new WorkbenchStore(); checkpoint = null; ready = false; publishedAfter = -1; journalPages = 0;
        previousPublication = undefined; changedIds.clear();
        schedule();
      } else {
        const failure = error instanceof Error ? error : new Error(String(error));
        for (const waiter of waiting) { waiters.delete(waiter); waiter.reject(failure); }
        lastError = failure.message; report();
        schedule(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)));
      }
    } finally {
      running = false;
      if (!stopped) {
        report();
        if (queued || waiters.size) schedule(failures ? Math.min(30000, 1000 * 2 ** Math.min(failures, 5)) : 0);
      }
    }
  }
  schedule();
  return {
    reload() {
      if (stopped) return;
      resetRequested = true; ready = false; failures = 0; lastError = undefined;
      if (timer) { clearTimeout(timer); timer = undefined; }
      schedule(); report();
    },
    catchUp: () => schedule(),
    applyCommitted(page: WorkbenchSnapshot) {
      if (stopped || !ready || !checkpoint || (page.scope.messageId ?? 'root') !== options.parent) return;
      // Command responses update the visible model immediately, but never advance the replay cursor.
      store.apply({ ...page, windowed: false });
      // A command response may skip intervening changes. Resume reuse only
      // after the next complete replay has established a new baseline.
      previousPublication = undefined; changedIds.clear();
      options.onReady(store.snapshot());
      schedule();
    },
    refresh: () => new Promise<boolean>((resolve, reject) => {
      if (stopped) { reject(new Error('讨论同步已停止')); return; }
      waiters.add({ resolve, reject });
      if (timer) { clearTimeout(timer); timer = undefined; }
      schedule();
    }),
    stop() {
      stopped = true; abort.abort(); if (timer) clearTimeout(timer);
      for (const waiter of waiters) waiter.reject(new Error('讨论同步已停止'));
      waiters.clear();
    },
  };
}
