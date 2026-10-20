import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';
import { useSceneComputation } from './useSceneComputation';
import { WorkbenchDrawingContext, useWorkbenchDrawingTask, type WorkbenchDrawingTask } from '../context/WorkbenchDrawingContext';
import { useWorkbenchDrawingPreparation } from '../components/WorkbenchLoadingBoundary';

/** Reveal complete structures in the graph's placement order, in either presentation. */
export function useMessageWindow(messages: DemoMessage[], edges: DemoEdge[], enabled: boolean, key: string, pinned: string[], organize = enabled) {
  const [limits, setLimits] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const startTask = useWorkbenchDrawingTask('positioning');
  const prepareDrawing = useWorkbenchDrawingPreparation();
  const tasks = useContext(WorkbenchDrawingContext);
  const request = useRef<{ key: string; limit: number; task: WorkbenchDrawingTask; promise: Promise<void>; finish(): void; cancelPreparation(): void; started?: boolean } | null>(null);
  const job = useMemo(() => organize ? { kind: 'structures' as const, input: { messages, edges } } : null, [messages, edges, organize]);
  const structure = useSceneComputation(job);
  const limit = limits.get(key) ?? 50;
  const pinnedKey = pinned.join('\0');
  const effectiveLimit = useMemo(() => {
    let next = limit;
    if (structure) for (const id of pinned) {
      const unit = structure.byId.get(id);
      // Navigation reveals the preceding prefix too, so later mounting cannot
      // insert an unmeasured structure above the selected target.
      if (unit) next = Math.max(next, structure.units.indexOf(unit) + 1);
    }
    return next;
  }, [structure, limit, pinnedKey]);
  const visible = useMemo(() => {
    if (!organize) return messages;
    if (!structure) return [];
    const selected = new Set(structure.units.slice(0, enabled ? effectiveLimit : undefined));
    const records = new Map(messages.map(message => [message.id, message]));
    return structure.order.filter(id => selected.has(structure.byId.get(id)!)).map(id => records.get(id)!);
  }, [messages, structure, effectiveLimit, enabled, organize]);
  const visibleIds = useMemo(() => new Set(visible.map(message => message.id)), [visible]);
  const visibleEdges = useMemo(() => enabled ? edges.filter(edge => visibleIds.has(edge.relationMessageId)
    || visibleIds.has(edge.from.messageId) || visibleIds.has(edge.to.messageId)) : edges, [edges, visibleIds, enabled]);
  const edgeIds = useMemo(() => new Set(visibleEdges.map(edge => edge.id)), [visibleEdges]);
  const hasMore = enabled && !!structure && effectiveLimit < structure.units.length;
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
    const promise = new Promise<void>(done => { resolve = done; });
    const nextLimit = Math.min(structure.units.length, effectiveLimit + 50);
    const current = { key, limit: nextLimit, task, promise, cancelPreparation() {}, finish() {
      current.cancelPreparation();
      if (request.current === current) { request.current = null; setLoading(false); }
      resolve();
    } };
    request.current = current;
    task.onCancel(current.finish);
    current.cancelPreparation = prepareDrawing(() => task.run(() => {
      setLoading(true);
      setLimits(previous => new Map(previous).set(key, nextLimit));
    }));
    return promise;
  }, [key, structure, effectiveLimit, hasMore, startTask, tasks, prepareDrawing]);
  return { messages: visible, edges: visibleEdges, visibleIds, edgeIds, structureOrder: structure?.order,
    hasMore, more, loading: loading || (organize && !structure), enabled };
}
