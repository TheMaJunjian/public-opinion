import type { Message, Relation, ScopeView, User, MessageStakes } from '../types';

export interface WorkbenchSnapshot {
  scope: ScopeView;
  messages: Message[];
  relations: Relation[];
  users: User[];
  stakes: Record<string, MessageStakes>;
  tagCounts: Record<string, Record<string, number>>;
  attentionUsers: Record<string, string[]>;
  sequence: number;
  nextCursor?: string | null;
  hasMore?: boolean;
  removedMessageIds?: string[];
  removedMemberships?: string[];
}
export interface SnapshotQuery { parent: string; after?: number; cursor?: string; signal?: AbortSignal }

/** The authoritative records are stored once; workbench models are derived from them. */
export class WorkbenchStore {
  private messages = new Map<string, Message>();
  private relations = new Map<string, Relation>();
  private users = new Map<string, User>();
  private versions = new Map<string, number>();
  private scope?: ScopeView;
  private stakes: Record<string, MessageStakes> = {};
  private tagCounts: WorkbenchSnapshot['tagCounts'] = {};
  private attentionUsers: WorkbenchSnapshot['attentionUsers'] = {};
  sequence = 0;

  apply(page: WorkbenchSnapshot, replace = false) {
    if (replace) {
      this.messages.clear(); this.relations.clear(); this.users.clear(); this.versions.clear();
      this.stakes = {}; this.tagCounts = {}; this.attentionUsers = {}; this.sequence = 0;
    }
    this.scope = page.scope;
    for (const id of page.removedMessageIds ?? []) {
      if (page.sequence < (this.versions.get(id) ?? 0)) continue;
      this.messages.delete(id); this.relations.delete(id); delete this.stakes[id];
      this.versions.set(id, page.sequence);
    }
    for (const message of page.messages) {
      const current = this.messages.get(message.id);
      if (page.sequence < (this.versions.get(message.id) ?? 0) || (current?.revision ?? 0) > (message.revision ?? 0)) continue;
      this.messages.set(message.id, message); this.versions.set(message.id, page.sequence);
    }
    for (const relation of page.relations) {
      const current = this.relations.get(relation.id);
      if (page.sequence < (this.versions.get(relation.id) ?? 0) || (current?.revision ?? 0) > (relation.revision ?? 0)) continue;
      this.relations.set(relation.id, relation);
    }
    for (const user of page.users) this.users.set(user.id, user);
    Object.assign(this.stakes, page.stakes);
    Object.assign(this.tagCounts, page.tagCounts);
    Object.assign(this.attentionUsers, page.attentionUsers);
    this.sequence = Math.max(this.sequence, page.sequence);
  }
  snapshot(): WorkbenchSnapshot {
    if (!this.scope) throw new Error('尚未载入讨论');
    return {
      scope: this.scope, messages: [...this.messages.values()], relations: [...this.relations.values()],
      users: [...this.users.values()], stakes: this.stakes, tagCounts: this.tagCounts,
      attentionUsers: this.attentionUsers, sequence: this.sequence,
    };
  }
}

interface SyncOptions {
  parent: string;
  load: (query: SnapshotQuery) => Promise<WorkbenchSnapshot>;
  events: (after: number) => EventSource;
  onSnapshot: (snapshot: WorkbenchSnapshot) => void;
  onError: (error: Error) => void;
  onSyncState?: (active: boolean) => void;
}

/** Serialize snapshots and replay changes after the first page's sequence. SSE only wakes the reader. */
export function syncWorkbench(options: SyncOptions) {
  const store = new WorkbenchStore();
  const abort = new AbortController();
  let stopped = false, running = false, queued = false, reset = true, cursor = 0;
  let events: EventSource | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let committedPages: WorkbenchSnapshot[] = [];
  const emit = () => { if (!stopped) options.onSnapshot(store.snapshot()); };
  const request = (query: Omit<SnapshotQuery, 'parent' | 'signal'>) => options.load({ ...query, parent: options.parent, signal: abort.signal });
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
    options.onSyncState?.(true);
    try {
      let changed=false;
      if (reset) {
        reset = false;
        const first = await request({});
        if (stopped) return;
        store.apply(first, true); cursor = first.sequence; changed=true;
        // A reload started before a send may finish after its response. Preserve
        // the acknowledged records while paging and catching up that older load.
        for (const page of committedPages) store.apply(page);
        let next = first.nextCursor;
        const visited = new Set<string>();
        while (next && !stopped) {
          if (visited.has(next)) throw new Error('消息分页游标重复');
          visited.add(next);
          const page = await request({ cursor: next });
          store.apply(page); next = page.nextCursor;
        }
      }
      let more: boolean;
      do {
        const page = await request({ after: cursor });
        if (stopped) return;
        if (page.sequence < cursor || (page.hasMore && page.sequence === cursor)) throw new Error('同步游标未前进');
        changed ||= page.sequence!==cursor || page.messages.length>0 || !!page.removedMessageIds?.length;
        store.apply(page); cursor = page.sequence; more = !!page.hasMore;
      } while (more && !stopped);
      // Derive and lay out the graph once per completed synchronization, not
      // once per page. A reconnect with no changes must not rebuild the scene.
      if(changed)emit();
      committedPages = committedPages.filter(page => page.sequence > cursor);
      failures = 0;
      if (!events) connect();
    } catch (error) {
      if (!stopped) {
        options.onError(error instanceof Error ? error : new Error(String(error)));
        // A failed first load must retry a complete snapshot, never start from an empty delta.
        if (!events) reset = true;
        timer = setTimeout(() => { timer = undefined; schedule(); }, Math.min(30000, 1000 * 2 ** failures++));
      }
    } finally {
      running = false;
      options.onSyncState?.(false);
      if (queued && !timer && !stopped) schedule();
    }
  }
  void refresh();
  return {
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
    stop() { stopped = true; abort.abort(); events?.close(); if (timer) clearTimeout(timer); },
  };
}
