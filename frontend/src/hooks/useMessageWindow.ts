import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';
import { useSceneComputation } from './useSceneComputation';
import { WorkbenchDrawingContext, useWorkbenchDrawingTask, type WorkbenchDrawingTask } from '../context/WorkbenchDrawingContext';
import { useWorkbenchDrawingPreparation } from '../components/WorkbenchLoadingBoundary';

/** Reveal chronological message units; placement paging remains an explicit legacy option. */
export function useMessageWindow(messages: DemoMessage[], edges: DemoEdge[], enabled: boolean, key: string, pinned: string[], organize = enabled, order:'placement'|'time'='time', bodies?: { limit: number; hasMore: boolean; loadMore(): Promise<void> }) {
  const [limits, setLimits] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const startTask = useWorkbenchDrawingTask('positioning');
  const prepareDrawing = useWorkbenchDrawingPreparation();
  const tasks = useContext(WorkbenchDrawingContext);
  const request = useRef<{ key: string; limit: number; task: WorkbenchDrawingTask; promise: Promise<void>; finish(): void; cancelPreparation(): void; started?: boolean } | null>(null);
  const job = useMemo(() => organize ? { kind: 'structures' as const, input: { messages, edges, order } } : null, [messages, edges, organize,order]);
  // A body-version change must not unmount the existing canvas while its new
  // structure order is computed. Never reuse another scope's paging plan.
  const structure = useSceneComputation(job, true, key);
  const limit = limits.get(key) ?? bodies?.limit ?? 50;
  const pinnedKey = pinned.join('\0');
  const effectiveLimit = useMemo(() => {
    let next = limit;
    if (structure) {
      const unitIndex = new Map(structure.units.map((unit, index) => [unit, index]));
      for (const requested of pinned) for (const id of [requested, ...(structure.pinDependencies.get(requested) ?? [])]) {
      const unit = structure.byId.get(id);
      // Navigation reveals the preceding prefix too, so later mounting cannot
      // insert an unmeasured structure above the selected target.
      if (unit !== undefined) next = Math.max(next, (unitIndex.get(unit) ?? -1) + 1);
      }
    }
    return next;
  }, [structure, limit, pinnedKey]);
  const visible = useMemo(() => {
    if (!organize) return messages;
    if (!structure) return [];
    const selected = new Set(structure.units.slice(0, enabled ? effectiveLimit : undefined));
    const records = new Map(messages.map(message => [message.id, message]));
    const candidates = new Set(structure.order.filter(id => selected.has(structure.byId.get(id)!)));
    if (enabled) {
      const dependents = new Map<string, string[]>(), blocked: string[] = [];
      for (const id of candidates) for (const host of structure.displayDependencies.get(id) ?? []) {
        if (!candidates.has(host)) blocked.push(id);
        else {
          const attached = dependents.get(host) ?? [];
          attached.push(id); dependents.set(host, attached);
        }
      }
      // Defer decorations and their descendants until every host is loaded.
      for (let index = 0; index < blocked.length; index++) {
        const id = blocked[index];
        if (candidates.delete(id)) blocked.push(...dependents.get(id) ?? []);
      }
    }
    return structure.order.filter(id => candidates.has(id)).flatMap(id => {
      const message=records.get(id);return message?[message]:[];
    });
  }, [messages, structure, effectiveLimit, enabled, organize]);
  const visibleIds = useMemo(() => new Set(visible.map(message => message.id)), [visible]);
  const visibleEdges = useMemo(() => {
    if (!enabled) return edges;
    if (order === 'time' && organize) {
      if (!structure) return [];
      const units = new Set(structure.units.slice(0, effectiveLimit));
      const knownIds = new Set(messages.map(message => message.id));
      return edges.filter(edge => {
        const unit = structure.byId.get(edge.relationMessageId) ?? structure.byId.get(edge.from.messageId);
        return unit !== undefined && units.has(unit)
          && [edge.from.messageId, edge.to.messageId].every(id => id.startsWith('anon:') || !knownIds.has(id) || visibleIds.has(id));
      });
    }
    return edges.filter(edge => visibleIds.has(edge.relationMessageId) || visibleIds.has(edge.from.messageId) || visibleIds.has(edge.to.messageId));
  }, [messages, edges, visibleIds, enabled, order, organize, structure, effectiveLimit]);
  const edgeIds = useMemo(() => new Set(visibleEdges.map(edge => edge.id)), [visibleEdges]);
  const hasMore = enabled && !!structure && (effectiveLimit < structure.units.length || !!bodies?.hasMore);
  useLayoutEffect(() => {
    if (enabled && effectiveLimit > limit) setLimits(previous => new Map(previous).set(key, effectiveLimit));
  }, [enabled, effectiveLimit, limit, key]);
  useLayoutEffect(() => {
    const current = request.current;
    if (!current) return;
    if (current.key !== key || !enabled) { current.task.cancel(); current.finish(); return; }
    if (limit < current.limit || current.started) return;
    current.started = true;
    if (current.task.afterLayout) current.task.afterLayout(() => { current.task.complete(); current.finish(); });
    else {
      let second = 0;
      const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { current.task.complete(); current.finish(); }); });
      const cancel = current.task.cancel;
      current.task.cancel = () => { cancelAnimationFrame(first); cancelAnimationFrame(second); cancel(); };
    }
  }, [key, limit, enabled]);
  useLayoutEffect(() => () => { const current = request.current; if (current) { current.task.cancel(); current.finish(); } }, []);
  const more = useCallback((): Promise<void> => {
    if (request.current) return request.current.promise;
    if (!hasMore || !structure || tasks?.failure || tasks?.blocking) return Promise.resolve();
    const task = startTask();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const nextLimit = bodies?.hasMore ? effectiveLimit + 50 : Math.min(structure.units.length, effectiveLimit + 50);
    const current = { key, limit: nextLimit, task, promise, cancelPreparation() {}, finish() {
      current.cancelPreparation();
      if (request.current === current) { request.current = null; setLoading(false); }
      resolve();
    } };
    request.current = current;
    task.onCancel(current.finish);
    current.cancelPreparation = prepareDrawing(() => task.run(() => {
      setLoading(true);
      const reveal = () => {
        if (request.current === current) setLimits(previous => new Map(previous).set(key, nextLimit));
      };
      if (bodies?.hasMore) void bodies.loadMore().then(reveal, error => {
        if (request.current !== current) return;
        reject(error); task.cancel(); current.finish();
      });
      else reveal();
    }));
    return promise;
  }, [key, structure, effectiveLimit, hasMore, startTask, tasks, prepareDrawing, bodies?.hasMore, bodies?.loadMore]);
  return { messages: visible, edges: visibleEdges, visibleIds, edgeIds, structureOrder: structure?.placementOrder,
    totalCount: messages.length, hasMore, more, loading: loading || (organize && !structure), enabled };
}
