import type { DiscussionQuery, WorkbenchSnapshot } from '@gonglun/core';
import { createZhihuStructuralViewer, type ZhihuViewerScope } from '../utils/zhihuStructuralViewer';
import { onlineStructuralSource } from '../utils/onlineStructuralSource';
import { projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import { startWorkbenchTiming } from '../utils/workbenchTiming';

export interface DiscussionPageState { page: number; previous: boolean; next: boolean; loading: boolean; error?: string; restricted?: boolean }

/** One active server window. Navigation cancels requests and never retains a global graph. */
export function createDiscussionClient(initialFocus: string, options: {
  load(query: DiscussionQuery, signal: AbortSignal): Promise<WorkbenchSnapshot>;
  publish(value: { snapshot: WorkbenchSnapshot; projected: ReturnType<typeof projectWorkbenchSnapshot>;
    index: ReturnType<typeof createZhihuStructuralViewer>; scope: ZhihuViewerScope }): void;
  status(value: DiscussionPageState): void;
  username: string;
  baseClassificationId?: string;
}) {
  let focusId = initialFocus, activeScope: ZhihuViewerScope = { classificationId: null };
  let key = '', publishedKey = '', pageKey = '', generation = 0, stopped = false, controller: AbortController | undefined;
  let cursors: Array<string | undefined> = [undefined], page = 0, nextCursor: string | null = null;
  let pending: Promise<void> | undefined;
  let snapshot: WorkbenchSnapshot | undefined;
  const contextRequests = new Set<AbortController>();
  const queryFor = (scope: ZhihuViewerScope): DiscussionQuery => ({ focusId, classificationId: scope.classificationId ?? options.baseClassificationId ?? null,
    extraIds: [...new Set([...scope.extraIds ?? [], ...scope.pinnedIds ?? []])].sort(), recordIds: [...new Set(scope.recordIds ?? [])].sort(), trace: scope.trace });
  const report = (loading: boolean, error?: string, restricted?: boolean) => options.status({ page: page + 1, previous: page > 0, next: !!nextCursor, loading, error, restricted });
  const fingerprint = (value: WorkbenchSnapshot) => JSON.stringify({ ...value, sequence: 0,
    discussion: value.discussion && { ...value.discussion, nextCursor: !!value.discussion.nextCursor } });
  async function select(scope: ZhihuViewerScope, force = false, destination?: number) {
    if (stopped) return;
    const query = queryFor(scope), nextKey = JSON.stringify(query);
    const nextPageKey = JSON.stringify([query.focusId, query.classificationId, query.trace]);
    const sameScope = nextPageKey === pageKey;
    if (!force && nextKey === key && pending) return pending;
    if (!force && nextKey === publishedKey && nextKey === key && snapshot) { activeScope = scope; return; }
    if (!force && sameScope && snapshot && [...query.extraIds ?? [], ...query.recordIds ?? []]
      .every(id => snapshot!.messages.some(message => message.id === id))) {
      // Selecting a loaded card changes composer context, not the active page.
      // Returning here also cancels a still-pending navigation to another scope.
      controller?.abort(); generation++; pending = undefined;
      activeScope = scope; key = publishedKey = nextKey; report(false); return;
    }
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal, ticket = ++generation;
    const nextPage = sameScope ? destination ?? page : 0;
    const requestCursor = sameScope ? cursors[nextPage] : undefined;
    activeScope = scope; key = nextKey;
    report(true);
    const finish = startWorkbenchTiming('discussion-request');
    pending = (async () => {
      try {
        const value = await options.load({ ...query, cursor: requestCursor }, signal);
        if (stopped || signal.aborted || ticket !== generation) return;
        if (!value.discussion) throw new Error('讨论范围响应不完整，请刷新页面');
        if (sameScope && nextPage === page && snapshot && fingerprint(snapshot) === fingerprint(value)) {
          snapshot = value; publishedKey = nextKey; nextCursor = value.discussion.nextCursor;
          // Advance the pagination watermark without rebuilding an unchanged graph.
          cursors.length = page + 1;
          if (nextCursor) cursors.push(nextCursor);
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
        if (!sameScope) cursors = [undefined];
        page = nextPage; nextCursor = value.discussion.nextCursor; snapshot = value; publishedKey = nextKey; pageKey = nextPageKey;
        cursors.length = page + 1;
        if (nextCursor) cursors.push(nextCursor);
        options.publish({ snapshot: value, projected, index, scope: activeScope });
        report(false);
      } catch (error) {
        if (stopped || signal.aborted || ticket !== generation) return;
        const restricted = [401,403].includes((error as {status:number}).status);
        // A restored permission must publish even if its body matches the last
        // readable version, so the view can clear its access error.
        if (restricted) snapshot = undefined;
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
      const previousFocus = focusId, previousScope = activeScope;
      focusId = ids[0]!;
      const requestedScope = { ...activeScope, classificationId: null, extraIds: ids };
      try { await select(requestedScope, true); }
      catch (error) {
        if (activeScope === requestedScope) { focusId = previousFocus; activeScope = previousScope; }
        throw error;
      }
    },
    turn: (direction: -1 | 1) => {
      const destination = page + direction;
      if (destination < 0 || destination >= cursors.length) return Promise.resolve();
      return select(activeScope, true, destination);
    },
    refresh: () => select(activeScope, true),
    get sequence() { return snapshot?.sequence ?? 0; },
    stop() { stopped = true; generation++; controller?.abort(); contextRequests.forEach(request => request.abort()); contextRequests.clear(); },
  };
}
export type DiscussionClient = ReturnType<typeof createDiscussionClient>;
