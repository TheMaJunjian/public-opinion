import type { WorkbenchSnapshot } from '@gonglun/core';
export type { WorkbenchSnapshot } from '@gonglun/core';
import type { Message, Relation, ScopeView, User, MessageStakes } from '../types';
import type { WorkbenchCache } from './workbenchCache';
export interface SnapshotQuery { parent: string; after?: number; cursor?: string; regionId?: string; signal?: AbortSignal; mode?: 'window'; limit?: number; batch?: number; ids?: string[]; knownIds?: string[]; viewParent?: string; relatedTo?: string }

/** The authoritative records are stored once; workbench models are derived from them. */
export class WorkbenchStore {
  private messages = new Map<string, Message>();
  private relations = new Map<string, Relation>();
  private users = new Map<string, User>();
  private versions = new Map<string, number>();
  private baselineSequence = 0;
  private scope?: ScopeView;
  private regionId?: string;
  private windowed = false;
  private scopeSequence = 0;
  private stakes: Record<string, MessageStakes> = {};
  private tagCounts: WorkbenchSnapshot['tagCounts'] = {};
  private attentionUsers: WorkbenchSnapshot['attentionUsers'] = {};
  sequence = 0;

  apply(page: WorkbenchSnapshot, replace = false) {
    // A restored complete snapshot also confirms the absence of older records.
    if (!replace && page.sequence < this.baselineSequence) return;
    if (replace) {
      this.messages.clear(); this.relations.clear(); this.users.clear(); this.versions.clear();
      this.stakes = {}; this.tagCounts = {}; this.attentionUsers = {}; this.sequence = 0; this.scopeSequence = 0;
      this.regionId = undefined;
      this.windowed = false;
      this.baselineSequence = page.sequence;
    }
    if (page.regionId) this.regionId = page.regionId;
    if (page.windowed) this.windowed = true;
    if (page.sequence >= this.scopeSequence) { this.scope = page.scope; this.scopeSequence = page.sequence; }
    const rejected = new Set<string>();
    for (const id of page.removedMessageIds ?? []) {
      if (page.sequence < (this.versions.get(id) ?? 0)) continue;
      this.messages.delete(id); this.relations.delete(id); delete this.stakes[id];
      delete this.tagCounts[id]; delete this.attentionUsers[id];
      this.versions.set(id, page.sequence);
      rejected.add(id);
    }
    for (const message of page.messages) {
      const current = this.messages.get(message.id);
      if (page.sequence < (this.versions.get(message.id) ?? 0) || (current?.revision ?? 0) > (message.revision ?? 0)) { rejected.add(message.id); continue; }
      this.messages.set(message.id, message); this.versions.set(message.id, page.sequence);
    }
    for (const relation of page.relations) {
      const current = this.relations.get(relation.id);
      if (page.sequence < (this.versions.get(relation.id) ?? 0) || (current?.revision ?? 0) > (relation.revision ?? 0)) continue;
      this.relations.set(relation.id, relation);
    }
    for (const user of page.users) this.users.set(user.id, user);
    const merge = <T,>(target: Record<string, T>, incoming: Record<string, T>) => {
      for (const [id, value] of Object.entries(incoming)) {
        if (rejected.has(id) || page.sequence < (this.versions.get(id) ?? 0)) continue;
        target[id] = value;
        this.versions.set(id, page.sequence);
      }
    };
    merge(this.stakes, page.stakes);
    merge(this.tagCounts, page.tagCounts);
    merge(this.attentionUsers, page.attentionUsers);
    this.sequence = Math.max(this.sequence, page.sequence);
  }
  snapshot(): WorkbenchSnapshot {
    if (!this.scope) throw new Error('尚未载入讨论');
    return {
      ...(this.regionId ? { regionId: this.regionId } : {}),
      ...(this.windowed ? { windowed: true } : {}),
      scope: this.scope, messages: [...this.messages.values()], relations: [...this.relations.values()],
      users: [...this.users.values()], stakes: { ...this.stakes }, tagCounts: { ...this.tagCounts },
      attentionUsers: { ...this.attentionUsers }, sequence: this.sequence,
    };
  }
}

interface SyncOptions {
  parent: string;
  cache?: WorkbenchCache;
  load: (query: SnapshotQuery) => Promise<WorkbenchSnapshot>;
  events: (after: number) => EventSource;
  onSnapshot: (snapshot: WorkbenchSnapshot) => void;
  onError: (error: Error) => void;
  onSyncState?: (active: boolean) => void;
  onPages?: (pages: Record<string, { hasMore: boolean; loading: boolean }>) => void;
}

/** Serialize snapshots and replay changes after the first page's sequence. SSE only wakes the reader. */
export function syncWorkbench(options: SyncOptions) {
  const store = new WorkbenchStore();
  const abort = new AbortController();
  let stopped = false, running = false, queued = false, reset = true, cursor = 0;
  let initialized = false, complete = false, pendingSnapshot = false;
  let regionId: string | undefined;
  let events: EventSource | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let committedPages: WorkbenchSnapshot[] = [];
  const pageCursors = new Map<string, string | null>();
  let viewParent = options.parent;
  type Demand = { parent: string; kind: 'more' | 'scope' | 'ids'; ids?: string[]; resolve: () => void; reject: (error: Error) => void };
  const demands: Demand[] = [];
  const activeDemands = new Set<Demand>();
  const loadingParents = new Set<string>();
  const waitingRefreshes = new Set<{ resolve: (changed: boolean) => void; reject: (error: Error) => void }>();
  const snapshot = (): WorkbenchSnapshot => ({ ...store.snapshot(), nextCursor: pageCursors.get(options.parent) ?? null, pageCursors: Object.fromEntries(pageCursors) });
  const reportPages = () => options.onPages?.(Object.fromEntries([...new Set([...pageCursors.keys(), ...loadingParents])].map(parent => [parent, { hasMore: !!pageCursors.get(parent), loading: loadingParents.has(parent) }])));
  const emit = () => { if (!stopped) options.onSnapshot(snapshot()); };
  const request = (query: Omit<SnapshotQuery, 'signal'>) => options.load({ mode: 'window', limit: 50, ...query, signal: abort.signal });
  const schedule = () => {
    queued = true;
    if (!running && !timer && !stopped) timer = setTimeout(() => { timer = undefined; void refresh(); }, 30);
  };
  const connect = () => {
    events?.close();
    events = options.events(cursor);
    events.onmessage = event => {
      try { if (Number(JSON.parse(event.data).sequence) > cursor) schedule(); }
      catch { schedule(); }
    };
    events.onopen = schedule; // Reconnects always catch up from the last applied sequence.
    events.onerror = () => { /* EventSource reconnects without resetting the applied cursor. */ };
  };
  async function refresh() {
    if (running || stopped) return;
    running = true; queued = false;
    const waiting = [...waitingRefreshes];
    const requested = demands.splice(0);
    for (const demand of requested) activeDemands.add(demand);
    options.onSyncState?.(true);
    try {
      let changed=false;
      if (!initialized) {
        initialized = true;
        const cached = options.cache ? await options.cache.load() : null;
        if (stopped) return;
        if (cached) {
          store.apply(cached, true); cursor = cached.sequence; regionId = cached.regionId;
          reset = false; complete = true; pendingSnapshot = true;
          for (const [parent, next] of Object.entries(cached.pageCursors ?? { [options.parent]: cached.nextCursor ?? null })) pageCursors.set(parent, next);
          for (const page of committedPages) store.apply(page);
        }
      }
      if (reset) {
        reset = false; complete = false;
        const first = await request({ parent: options.parent });
        if (stopped) return;
        store.apply(first, true); cursor = first.sequence; regionId = first.regionId; pendingSnapshot = true;
        pageCursors.clear(); pageCursors.set(options.parent, first.nextCursor ?? null);
        // A reload started before a send may finish after its response. Preserve
        // the acknowledged records while paging and catching up that older load.
        for (const page of committedPages) store.apply(page);
        complete = true;
      }
      for (const demand of requested) {
        const next = pageCursors.get(demand.parent);
        if (demand.kind === 'more' && pageCursors.has(demand.parent) && !next) continue;
        const relatedTo = demand.parent.startsWith('related:') ? demand.parent.slice(8) : undefined;
        const page = await request({ parent: relatedTo ? options.parent : demand.parent, ...(relatedTo ? { relatedTo } : {}),
          ...(demand.kind === 'more' && next ? { cursor: next } : {}),
          ...(demand.kind === 'ids' ? { ids: demand.ids } : {}),
        });
        if (stopped) return;
        if (demand.ids?.some(id => !page.messages.some(message => message.id === id))) throw new Error(`未找到消息 ${demand.ids.join('、')}`);
        if (demand.kind !== 'ids') {
          if (next && demand.kind === 'more' && page.nextCursor === next) throw new Error('消息分页游标未前进');
          pageCursors.set(demand.parent, page.nextCursor ?? null); viewParent = demand.parent;
        }
        store.apply({ ...page, scope: store.snapshot().scope }); pendingSnapshot = true;
      }
      let more: boolean;
      do {
        const page = await request({ parent: options.parent, ...(viewParent.startsWith('related:') ? { relatedTo: viewParent.slice(8) } : { viewParent }), after: cursor, knownIds: store.snapshot().messages.map(message => message.id), ...(regionId ? { regionId } : {}) });
        if (stopped) return;
        if (page.sequence < cursor || (page.hasMore && page.sequence === cursor)) throw new Error('同步游标未前进');
        pendingSnapshot ||= page.sequence!==cursor || page.messages.length>0 || !!page.removedMessageIds?.length;
        store.apply(page); cursor = page.sequence; more = !!page.hasMore;
        if (page.nextCursor) pageCursors.set(viewParent, page.nextCursor);
      } while (more && !stopped);
      // Derive and lay out the graph once per completed synchronization, not
      // once per page. A reconnect with no changes must not rebuild the scene.
      changed = pendingSnapshot;
      if(changed) { emit(); pendingSnapshot = false; }
      committedPages = committedPages.filter(page => page.sequence > cursor);
      failures = 0;
      if (!events) connect();
      // Never persist an unfinished page set or jump past unrelated changes
      // using the newer sequence of a command response.
      if (changed && store.sequence === cursor) await options.cache?.save(snapshot());
      for (const waiter of waiting) { waitingRefreshes.delete(waiter); waiter.resolve(changed); }
      for (const demand of requested) demand.resolve();
    } catch (error) {
      if (!stopped && complete && typeof error === 'object' && error !== null && 'status' in error && error.status === 409) {
        await options.cache?.clear();
        if (stopped) return;
        events?.close(); events = undefined;
        committedPages = []; cursor = 0; regionId = undefined;
        reset = true; complete = false; queued = true;
        demands.unshift(...requested);
        return;
      }
      for (const demand of requested) demand.reject(error instanceof Error ? error : new Error(String(error)));
      for (const waiter of waiting) {
        waitingRefreshes.delete(waiter);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
      if (!stopped) {
        if (!requested.length || !complete) options.onError(error instanceof Error ? error : new Error(String(error)));
        // Retry partial initial pages, but preserve a complete cache and the
        // last applied delta cursor through transient network failures.
        if (!complete) reset = true;
        timer = setTimeout(() => { timer = undefined; schedule(); }, Math.min(30000, 1000 * 2 ** failures++));
      }
    } finally {
      running = false;
      for (const demand of requested) activeDemands.delete(demand);
      for (const demand of requested) if (!demands.some(pending => pending.parent === demand.parent)) loadingParents.delete(demand.parent);
      reportPages();
      options.onSyncState?.(false);
      if (queued && !timer && !stopped) schedule();
    }
  }
  void refresh();
  const demand = (kind: Demand['kind'], parent: string, ids?: string[]) => new Promise<void>((resolve, reject) => {
    if (stopped) { reject(new Error('同步已停止')); return; }
    demands.push({ kind, parent, ids, resolve, reject }); loadingParents.add(parent); reportPages(); schedule();
  });
  return {
    loadMore(parent = options.parent) { return demand('more', parent); },
    loadScope(parent = options.parent) { return demand('scope', parent); },
    ensureMessages(ids: string[]) { return demand('ids', options.parent, ids); },
    applyCommitted(page: WorkbenchSnapshot) {
      if (stopped || (page.scope.messageId ?? 'root') !== options.parent) return false;
      committedPages.push(page);
      store.apply(page);
      emit();
      // Do not jump the reader's cursor: unrelated changes since its previous
      // snapshot must still be replayed, even if this send has a later sequence.
      schedule();
      return true;
    },
    reload() { reset = true; schedule(); },
    catchUp() { schedule(); },
    refresh(): Promise<boolean> {
      if (stopped) return Promise.reject(new Error('同步已停止'));
      return new Promise((resolve, reject) => { waitingRefreshes.add({ resolve, reject }); schedule(); });
    },
    stop() {
      stopped = true; abort.abort(); events?.close(); if (timer) clearTimeout(timer);
      for (const waiter of waitingRefreshes) waiter.reject(new Error('同步已停止'));
      waitingRefreshes.clear();
      for (const demand of demands.splice(0)) demand.reject(new Error('同步已停止'));
      for (const demand of activeDemands) demand.reject(new Error('同步已停止'));
    },
  };
}
