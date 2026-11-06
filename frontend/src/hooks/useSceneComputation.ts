import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { computeSceneLayout } from '../utils/frameLayout';
import { planMessageStructures } from '../utils/messageStructurePlan';
import { useWorkbenchDrawingTask } from '../context/WorkbenchDrawingContext';
import { createSceneComputationKey } from '../utils/sceneComputationKey';
import { createSceneComputationInput, type SceneComputationJob as Job } from '../utils/sceneComputationInput';
import { createSceneRequestEncoder } from '../utils/sceneComputationTransport';

export type { SceneComputationRequest } from '../utils/sceneComputationTransport';
type Result = ReturnType<typeof computeSceneLayout> | ReturnType<typeof planMessageStructures>;
export type SceneLayoutComputer = typeof computeSceneLayout;
const compute = (job: Job, layoutComputer?: SceneLayoutComputer): Result => {
  if (job.kind === 'structures') return planMessageStructures(job.input);
  if (!layoutComputer) throw new Error('图形布局需要提供同步计算器');
  return layoutComputer(job.input);
};

/** Queue replacements within a scope; opening another scope cancels obsolete work. */
export function useSceneComputation<K extends Job['kind']>(inputJob: Extract<Job, { kind: K }> | null, retainPrevious = false, retentionKey?: unknown, layoutComputer?: SceneLayoutComputer) {
  // Worker inputs contain value data. Equal restored projections can reuse
  // this retained view's completed result even when their references change.
  const sceneKey = useMemo(createSceneComputationKey, []);
  const workerInput = useMemo(createSceneComputationInput, []);
  const inputKey=useMemo(()=>sceneKey(inputJob),[sceneKey,inputJob]);
  const stableJob=useRef({key:inputKey,job:inputJob});
  if(stableJob.current.key!==inputKey)stableJob.current={key:inputKey,job:inputJob};
  const job=stableJob.current.job;
  const workerRef = useRef<Worker | null>(null);
  const postJob = useRef<((id: number, job: Job) => void) | null>(null);
  const latest = useRef<{ job: Job; id: number; scope: unknown; finish(result: Result): void; fail(error: unknown): void } | null>(null);
  const active = useRef<number | null>(null);
  const activeScope = useRef(retentionKey);
  const revision = useRef(0);
  const [workerUnavailable, setWorkerUnavailable] = useState(() => typeof Worker !== 'function');
  const [completed, setCompleted] = useState<{ job: Job; result: Result; retentionKey: unknown } | null>(null);
  // A new view has no usable scene yet; refreshing a retained scene is background work.
  const startTask = useWorkbenchDrawingTask(job?.kind === 'structures' ? 'loading' : 'projection',
    !completed || !retainPrevious || completed.retentionKey !== retentionKey);
  // Only the graph view needs the layout implementation. Its injected function
  // keeps this shared paging hook light while preserving synchronous fallback.
  const fallback = useMemo(() => workerUnavailable && job ? { job, result: compute(job, layoutComputer), retentionKey } : null, [workerUnavailable, job, retentionKey, layoutComputer]);
  const openWorker = useCallback(() => {
    let worker: Worker;
    try { worker = new Worker(new URL('../workers/sceneComputation.worker.ts', import.meta.url), { type: 'module' }); }
    catch { setWorkerUnavailable(true); return; }
    workerRef.current = worker;
    const encode = createSceneRequestEncoder();
    const post = (id: number, job: Job) => worker.postMessage(encode(id, workerInput(job)));
    postJob.current = post;
    worker.onmessage = (event: MessageEvent<{ id: number; result: Result; error?: string }>) => {
      if (workerRef.current !== worker) return;
      active.current = null;
      const request = latest.current;
      if (!request) return;
      if (event.data.id === request.id) {
        if (event.data.error) request.fail(new Error(event.data.error));
        else request.finish(event.data.result);
      } else {
        active.current = request.id;
        activeScope.current = request.scope;
        try { post(request.id, request.job); }
        catch { active.current = null; setWorkerUnavailable(true); }
      }
    };
    worker.onerror = () => { if (workerRef.current === worker) { active.current = null; setWorkerUnavailable(true); } };
    return worker;
  }, [workerInput]);
  useLayoutEffect(() => {
    if (workerUnavailable) return;
    openWorker();
    return () => { workerRef.current?.terminate(); workerRef.current = null; postJob.current = null; active.current = null; };
  }, [workerUnavailable, openWorker]);
  useLayoutEffect(() => {
    if (!job || workerUnavailable || !workerRef.current || completed?.job === job) return;
    // Reuse idle workers, but never queue an opened classification behind work
    // for a scope the user has already left.
    if (active.current !== null && activeScope.current !== retentionKey) {
      workerRef.current.terminate(); workerRef.current = null; active.current = null;
      if (!openWorker()) return;
    }
    const worker = workerRef.current;
    if (!worker) return;
    const task = startTask();
    const id = ++revision.current;
    latest.current = { job, id, scope: retentionKey, finish(result) { if (task.active) { setCompleted({ job, result, retentionKey }); task.complete(); } }, fail: task.fail };
    if (active.current === null) {
      active.current = id;
      activeScope.current = retentionKey;
      try { postJob.current!(id, job); }
      catch { active.current = null; setWorkerUnavailable(true); }
    }
    return () => { if (latest.current?.id === id) latest.current = null; task.cancel(); };
  }, [job, workerUnavailable, startTask, retentionKey, completed?.job, openWorker, workerInput]);
  const value = fallback ?? completed;
  return (job && value && (value.job === job || retainPrevious && value.retentionKey === retentionKey) ? value.result : null) as (K extends 'layout' ? ReturnType<typeof computeSceneLayout> : ReturnType<typeof planMessageStructures>) | null;
}
