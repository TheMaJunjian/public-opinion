import type { DiscussionQuery, WorkbenchSnapshot } from '@gonglun/core';
import { createZhihuStructuralViewer, type ZhihuViewerScope } from '../utils/zhihuStructuralViewer';
import { onlineStructuralSource } from '../utils/onlineStructuralSource';
import { projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import { startWorkbenchTiming } from '../utils/workbenchTiming';
import { mergeDiscussionSnapshots } from './mergeDiscussionSnapshots';

export interface DiscussionPageState {
  focusId: string; classificationId: string | null; loadedCount: number; hasMore: boolean;
  recommendedPath?: NonNullable<WorkbenchSnapshot['discussion']>['recommendedPath'];
  expanded: boolean; loading: boolean; loadingMore: boolean; error?: string; restricted?: boolean;
}

/** Append within one discussion; navigation cancels requests and releases the previous scope. */
export function createDiscussionClient(initialFocus: string, options: {
  load(query: DiscussionQuery, signal: AbortSignal): Promise<WorkbenchSnapshot>;
  publish(value: { snapshot: WorkbenchSnapshot; projected: ReturnType<typeof projectWorkbenchSnapshot>;
    index: ReturnType<typeof createZhihuStructuralViewer>; scope: ZhihuViewerScope }): void;
  status(value: DiscussionPageState): void;
  openFull?(query: DiscussionQuery, scope: ZhihuViewerScope): Promise<void>;
  username: string;
  baseClassificationId?: string;
}) {
  let focusId = initialFocus, activeScope: ZhihuViewerScope = { classificationId: null };
  let rootScope = false;
  let key = '', publishedKey = '', pageKey = '', requestingScopeKey = '', generation = 0, stopped = false, controller: AbortController | undefined;
  let pages: WorkbenchSnapshot[] = [], nextCursor: string | null = null, expanded = false, loadingMore = false;
  let pending: Promise<void> | undefined;
  let snapshot: WorkbenchSnapshot | undefined;
  const contextRequests = new Set<AbortController>();
  const queryFor = (scope: ZhihuViewerScope): DiscussionQuery => ({ focusId, classificationId: scope.classificationId ?? options.baseClassificationId ?? (!scope.trace && rootScope ? 'root' : null),
    extraIds: [...new Set([...scope.extraIds ?? [], ...scope.pinnedIds ?? []])].sort(), recordIds: [...new Set(scope.recordIds ?? [])].sort(), trace: scope.trace });
  const report = (loading: boolean, error?: string, restricted?: boolean) => options.status({ focusId,
    recommendedPath: snapshot?.discussion?.recommendedPath,
    classificationId: queryFor(activeScope).classificationId
      ?? (['CLASSIFY','SUMMARY','MERGE','ARRANGE'].includes(snapshot?.messages.find(message => message.id === focusId)?.relationType ?? '') ? focusId : null),
    loadedCount: snapshot?.discussion?.pageIds.length ?? 0, hasMore: !!nextCursor, expanded, loading, loadingMore: loading && loadingMore, error, restricted });
  const fingerprint = (value: WorkbenchSnapshot) => JSON.stringify({ ...value, sequence: 0,
    discussion: value.discussion && { ...value.discussion, cursor: undefined, nextCursor: !!value.discussion.nextCursor } });
  async function select(scope: ZhihuViewerScope, force = false, append = false) {
    if (stopped) return;
    // A null layer initially means the linked discussion. After leaving a
    // classification it means the root, including subsequent refresh/appends.
    if (!scope.trace && !scope.classificationId && activeScope.classificationId) rootScope = true;
    const query = queryFor(scope), nextKey = JSON.stringify(query);
    const nextPageKey = JSON.stringify([query.focusId, query.classificationId, query.trace]);
    const sameScope = nextPageKey === pageKey;
    if (nextKey === key && pending) return pending;
    if (!force && nextKey === publishedKey && nextKey === key && snapshot) { activeScope = scope; return; }
    const expandedIds = new Set(snapshot?.discussion?.expandedIds ?? snapshot?.messages.map(message=>message.id));
    const loadedContext = sameScope && snapshot && [...query.extraIds ?? [], ...query.recordIds ?? []]
      .every(id => expandedIds.has(id));
    // Selection and its subsequent background refresh share an in-flight append.
    if (loadedContext && pending && requestingScopeKey === nextPageKey) { activeScope = scope; return pending; }
    if (!force && loadedContext) {
      controller?.abort(); generation++; pending = undefined;
      activeScope = scope; key = publishedKey = nextKey; report(false); return;
    }
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal, ticket = ++generation;
    const previousPages = sameScope ? pages : [];
    loadingMore = append;
    activeScope = scope; key = nextKey; requestingScopeKey = nextPageKey;
    report(true);
    const finish = startWorkbenchTiming('discussion-request');
    pending = (async () => {
      try {
        const loadPage = async (cursor?: string) => {
          const value = await options.load({ ...query, cursor }, signal);
          if (!value.discussion) throw new Error('讨论范围响应不完整，请刷新讨论');
          return { ...value, discussion: { ...value.discussion, cursor: value.discussion.cursor ?? cursor } };
        };
        const revalidate = async (values: WorkbenchSnapshot[]) => {
          const refreshed: WorkbenchSnapshot[] = [];
          for (let offset = 0; offset < values.length && !signal.aborted; offset += 4)
            refreshed.push(...await Promise.all(values.slice(offset, offset + 4).map(value => loadPage(value.discussion!.cursor))));
          return refreshed;
        };
        const connectPages = async (values: WorkbenchSnapshot[]) => {
          const connected: WorkbenchSnapshot[] = [];
          for (const value of values) {
            const ids = new Set(value.discussion!.pageIds);
            if (connected.length && !ids.size) continue;
            let previous = connected.at(-1)?.discussion;
            // New replies or changed memberships can leave a gap between
            // retained cursor windows. Follow it until the windows meet.
            while (!signal.aborted && previous?.nextCursor && previous.nextCursor !== value.discussion!.cursor
              && !previous.pageIds.some(id => ids.has(id))) {
              const bridge = await loadPage(previous.nextCursor);
              connected.push(bridge); previous = bridge.discussion;
            }
            connected.push(value);
          }
          return connected;
        };
        let refreshed: WorkbenchSnapshot[];
        if (append && previousPages.length) {
          refreshed = await connectPages(await revalidate(previousPages));
          if (signal.aborted) return;
          const cursor = refreshed.at(-1)!.discussion!.nextCursor;
          if (cursor) refreshed.push(await loadPage(cursor));
        } else {
          const head = await loadPage();
          const covered = new Set(head.discussion.pageIds);
          // A new reply can push an already loaded reply off the first batch.
          // Re-read its original cursor instead of dropping it or keeping stale text.
          refreshed = await connectPages([head, ...await revalidate(previousPages.filter(value => value.discussion!.pageIds.some(id => !covered.has(id))))]);
        }
        if (stopped || signal.aborted || ticket !== generation) return;
        const value = mergeDiscussionSnapshots(refreshed);
        pages = refreshed; nextCursor = value.discussion!.nextCursor; expanded = sameScope ? expanded || append : false;
        if (sameScope && snapshot && fingerprint(snapshot) === fingerprint(value)) {
          snapshot = value; publishedKey = nextKey; nextCursor = value.discussion.nextCursor;
          report(false); return;
        }
        const source = onlineStructuralSource(value, async () => { throw new Error('讨论正文必须通过当前范围重新验证'); });
        const local = createZhihuStructuralViewer(source, options.username);
        const index: typeof local = { ...local,
          memberCounts: id => value.discussion!.memberCounts[id] ?? local.memberCounts(id),
          readContext: async ids => {
            const context = new AbortController(), owner = generation;
            contextRequests.add(context);
            try {
              const result = await options.load({ focusId: ids[0] ?? focusId, extraIds: ids }, context.signal);
              if (stopped || owner !== generation) throw new DOMException('讨论范围已切换', 'AbortError');
              return result;
            } finally { contextRequests.delete(context); }
          },
        };
        const projected = projectWorkbenchSnapshot(value, { loadedOnly: true });
        snapshot = value; publishedKey = nextKey; pageKey = nextPageKey;
        options.publish({ snapshot: value, projected, index, scope: activeScope });
        report(false);
      } catch (error) {
        if (stopped || signal.aborted || ticket !== generation) return;
        if ((error as { code?: string } | null)?.code === 'DISCUSSION_TOO_LARGE' && options.openFull) {
          // The complete catalog owns the next publication. Keep callers waiting
          // for it so a pending jump cannot mistake the old page for its result.
          await options.openFull(query, activeScope);
          return;
        }
        const restricted = [401,403].includes((error as {status:number}).status);
        // A restored permission must publish even if its body matches the last
        // readable version, so the view can clear its access error.
        if (restricted) { snapshot = undefined; pages = []; nextCursor = null; }
        key = ''; report(false, error instanceof Error ? error.message : '讨论加载失败', restricted);
        throw error;
      } finally { finish(); if (ticket === generation) pending = undefined; }
    })();
    return pending;
  }
  return {
    select,
    ensure: async (ids: string[]) => {
      if (!ids.length) return;
      const previousFocus = focusId, previousScope = activeScope, previousRoot = rootScope;
      focusId = ids[0]!;
      rootScope = false;
      const requestedScope = { ...activeScope, classificationId: null, extraIds: ids };
      activeScope = requestedScope;
      try { await select(requestedScope, true); }
      catch (error) {
        if (activeScope === requestedScope) { focusId = previousFocus; activeScope = previousScope; rootScope = previousRoot; }
        throw error;
      }
    },
    loadMore: () => nextCursor ? select(activeScope, true, true) : Promise.resolve(),
    refresh: () => select(activeScope, true),
    get sequence() { return snapshot?.sequence ?? 0; },
    stop() { stopped = true; generation++; controller?.abort(); contextRequests.forEach(request => request.abort()); contextRequests.clear(); },
  };
}
export type DiscussionClient = ReturnType<typeof createDiscussionClient>;
