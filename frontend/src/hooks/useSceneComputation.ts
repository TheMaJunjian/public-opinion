import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { computeSceneLayout, type SceneLayoutInput } from '../utils/frameLayout';
import { planMessageStructures, type MessageStructureInput } from '../utils/messageStructurePlan';
import { useWorkbenchDrawingTask } from '../context/WorkbenchDrawingContext';

type Job = { kind: 'layout'; input: SceneLayoutInput } | { kind: 'structures'; input: MessageStructureInput };
export interface SceneComputationRequest { id: number; job: Job }
type Result = ReturnType<typeof computeSceneLayout> | ReturnType<typeof planMessageStructures>;
const compute = (job: Job): Result => job.kind === 'layout' ? computeSceneLayout(job.input) : planMessageStructures(job.input);

/** One active worker job plus one latest replacement; stale results never reach the scene. */
export function useSceneComputation<K extends Job['kind']>(job: Extract<Job, { kind: K }> | null, retainPrevious = false) {
  const startTask = useWorkbenchDrawingTask('projection');
  const workerRef = useRef<Worker | null>(null);
  const latest = useRef<{ job: Job; id: number; finish(result: Result): void; fail(error: unknown): void } | null>(null);
  const active = useRef<number | null>(null);
  const revision = useRef(0);
  const [workerUnavailable, setWorkerUnavailable] = useState(() => typeof Worker !== 'function');
  const [completed, setCompleted] = useState<{ job: Job; result: Result } | null>(null);
  const fallback = useMemo(() => workerUnavailable && job ? { job, result: compute(job) } : null, [workerUnavailable, job]);
  useLayoutEffect(() => {
    if (workerUnavailable) return;
    let worker: Worker;
    try { worker = new Worker(new URL('../workers/sceneComputation.worker.ts', import.meta.url), { type: 'module' }); }
    catch { setWorkerUnavailable(true); return; }
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<{ id: number; result: Result; error?: string }>) => {
      active.current = null;
      const request = latest.current;
      if (!request) return;
      if (event.data.id === request.id) {
        if (event.data.error) request.fail(new Error(event.data.error));
        else request.finish(event.data.result);
      } else {
        active.current = request.id;
        try { worker.postMessage({ id: request.id, job: request.job }); }
        catch { active.current = null; setWorkerUnavailable(true); }
      }
    };
    worker.onerror = () => { active.current = null; setWorkerUnavailable(true); };
    return () => { worker.terminate(); workerRef.current = null; active.current = null; };
  }, [workerUnavailable]);
  useLayoutEffect(() => {
    if (!job || workerUnavailable || !workerRef.current) return;
    const task = startTask();
    const id = ++revision.current;
    latest.current = { job, id, finish(result) { if (task.active) { setCompleted({ job, result }); task.complete(); } }, fail: task.fail };
    if (active.current === null) {
      active.current = id;
      try { workerRef.current.postMessage({ id, job }); }
      catch { active.current = null; setWorkerUnavailable(true); }
    }
    return () => { if (latest.current?.id === id) latest.current = null; task.cancel(); };
  }, [job, workerUnavailable, startTask]);
  const value = fallback ?? completed;
  return (value && (value.job === job || retainPrevious) ? value.result : null) as (K extends 'layout' ? ReturnType<typeof computeSceneLayout> : ReturnType<typeof planMessageStructures>) | null;
}
