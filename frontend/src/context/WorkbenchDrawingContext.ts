import { createContext, useCallback, useContext, useLayoutEffect, useReducer, useRef } from 'react';
import { startWorkbenchTiming } from '../utils/workbenchTiming';

export type DrawingTaskKind = 'loading' | 'module' | 'projection' | 'measurement' | 'overlays' | 'positioning' | 'fonts';
export type DrawingFailure = { kind: DrawingTaskKind | 'render'; reason: 'error' | 'timeout'; error?: unknown };
export const WORKBENCH_DRAWING_TIMEOUT_MS = 30_000;

/** Share one visible-time budget across pauses and interrupted ready commits. */
export function watchWorkbenchDrawingDeadline(onTimeout: () => void, budget = { remaining: WORKBENCH_DRAWING_TIMEOUT_MS }) {
  let startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (document.hidden) return;
    startedAt = performance.now();
    timer = setTimeout(onTimeout, budget.remaining);
  };
  const pause = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    budget.remaining = Math.max(0, budget.remaining - (performance.now() - startedAt));
  };
  const visibilityChanged = () => { pause(); arm(); };
  arm();
  document.addEventListener('visibilitychange', visibilityChanged);
  return () => { pause(); document.removeEventListener('visibilitychange', visibilityChanged); };
}

export interface WorkbenchDrawingTask {
  readonly active: boolean;
  complete(): void;
  cancel(): void;
  fail(error: unknown): void;
  run(work: () => void): void;
  onCancel(cleanup: () => void): void;
  afterLayout?(work: () => void): void;
}

/** Tasks belong to one mounted workbench; stale completions only release their own ticket. */
export function createWorkbenchDrawingTasks() {
  const pending = new Map<symbol, { kind: DrawingTaskKind; foreground: boolean; cancel: () => void }>();
  const listeners = new Set<() => void>();
  let revision = 0;
  let foregroundRevision = 0;
  let blocking = true;
  let failure: DrawingFailure | null = null;
  const changed = () => { revision++; listeners.forEach(listener => listener()); };
  const abort = (next: DrawingFailure) => {
    if (!failure) failure = next;
    const cancelled = [...pending.values()];
    pending.clear(); // Invalidate every callback before invoking cleanup.
    for (const task of cancelled) task.cancel();
    changed();
  };
  const tasks = {
    begin(kind: DrawingTaskKind, foreground = false) {
      const finishTiming = startWorkbenchTiming(`drawing:${kind}`);
      const id = Symbol(kind);
      const cleanups = new Set<() => void>();
      const release = () => { if (pending.delete(id)) { finishTiming(); cleanups.clear(); changed(); } };
      const cancel = () => {
        pending.delete(id);
        for (const cleanup of cleanups) {
          try { cleanup(); } catch (error) { console.error('取消绘制任务失败', error); }
        }
        cleanups.clear();
      };
      pending.set(id, { kind, foreground, cancel });
      if (foreground) foregroundRevision++;
      changed();
      const registration = {
        release,
        get active() { return pending.has(id); },
        cancel() { if (pending.has(id)) { cancel(); changed(); } },
        fail(error: unknown) { if (pending.has(id)) abort({ kind, reason: 'error', error }); },
        onCancel(cleanup: () => void) { if (pending.has(id)) cleanups.add(cleanup); else cleanup(); },
      };
      return {
        ...registration,
        // Spread accessors would snapshot active rather than read it live.
        get active() { return pending.has(id); },
        afterLayout(work: () => void) {
          let frame = 0, paintFrame = 0, disposed = false;
          const hasLayoutTasks = () => [...pending.values()].some(task => task.kind !== 'positioning');
          const dispose = () => {
            if (disposed) return;
            disposed = true;
            listeners.delete(schedule);
            document.removeEventListener('visibilitychange', schedule);
            cancelAnimationFrame(frame);
            cancelAnimationFrame(paintFrame);
            stopDeadline();
          };
          const schedule = () => {
            cancelAnimationFrame(frame);
            cancelAnimationFrame(paintFrame);
            if (disposed) return;
            if (!pending.has(id) || failure) { dispose(); return; }
            if (document.hidden || hasLayoutTasks()) return;
            const committedRevision = revision;
            frame = requestAnimationFrame(() => {
              paintFrame = requestAnimationFrame(() => {
                if (disposed || !pending.has(id) || failure || hasLayoutTasks() || revision !== committedRevision) return;
                dispose();
                work();
              });
            });
          };
          const stopDeadline = watchWorkbenchDrawingDeadline(() => {
            if (registration.active) abort({ kind, reason: 'timeout' });
          });
          listeners.add(schedule);
          // A background tab may not deliver its queued paint callbacks.
          // Recheck the same task when the tab becomes visible again.
          document.addEventListener('visibilitychange', schedule);
          registration.onCancel(dispose);
          schedule();
        },
      };
    },
    abort,
    clearFailure() { if (failure) { failure = null; changed(); } },
    get failure() { return failure; },
    committed: changed,
    setBlocking(value: boolean) {
      if (blocking === value) return;
      blocking = value;
      // Resuming interaction must wake deferred pagination without invalidating
      // the drawing revision that just passed its ready-commit fence.
      listeners.forEach(listener => listener());
    },
    get blocking() { return blocking; },
    get revision() { return revision; },
    get pending() { return pending.size; },
    get foregroundPending() { return [...pending.values()].some(task => task.foreground); },
    get foregroundRevision() { return foregroundRevision; },
    get stage(): 'loading' | 'drawing' | 'positioning' | null {
      if ([...pending.values()].some(task => task.kind === 'loading' || task.kind === 'module')) return 'loading';
      if ([...pending.values()].some(task => task.kind !== 'positioning')) return 'drawing';
      return pending.size ? 'positioning' : null;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return tasks;
}

export const WorkbenchDrawingContext = createContext<ReturnType<typeof createWorkbenchDrawingTasks> | null>(null);

/** Complete asynchronous work only after its React state updates have committed. */
export function useWorkbenchDrawingTask(kind: DrawingTaskKind, foreground = false) {
  const tasks = useContext(WorkbenchDrawingContext);
  type Registration = ReturnType<NonNullable<typeof tasks>['begin']>;
  const owned = useRef(new Set<Registration>());
  const completed = useRef(new Set<Registration>());
  const [, commit] = useReducer(value => value + 1, 0);
  useLayoutEffect(() => {
    for (const task of completed.current) { owned.current.delete(task); task.release(); }
    completed.current.clear();
  });
  useLayoutEffect(() => () => {
    for (const task of [...owned.current]) task.cancel();
    owned.current.clear();
    completed.current.clear();
  }, []);
  return useCallback((): WorkbenchDrawingTask => {
    if (!tasks) return { active: true, complete() {}, cancel() {}, fail(error) { throw error; }, run(work) { work(); }, onCancel() {} };
    const registration = tasks.begin(kind, foreground);
    owned.current.add(registration);
    registration.onCancel(() => { owned.current.delete(registration); completed.current.delete(registration); });
    let done = false;
    return {
      get active() { return !done && registration.active; },
      complete() {
        if (done || !registration.active) return;
        done = true;
        // Later scrolling can measure an unchanged layout. It must not force
        // the whole workbench to render just to acknowledge a background task.
        if (!tasks.blocking) { owned.current.delete(registration); registration.release(); return; }
        completed.current.add(registration);
        commit();
      },
      cancel() {
        done = true;
        registration.cancel();
      },
      fail(error) { registration.fail(error); },
      run(work) {
        if (done || !registration.active) return;
        try { work(); } catch (error) { registration.fail(error); }
      },
      onCancel: registration.onCancel,
      afterLayout(work) {
        registration.afterLayout(() => {
          if (done || !registration.active) return;
          try { work(); } catch (error) { registration.fail(error); }
        });
      },
    };
  }, [tasks, kind, foreground]);
}

export function useWorkbenchDrawingFailure() {
  const tasks = useContext(WorkbenchDrawingContext);
  return useCallback((error: Error) => { tasks?.abort({ kind: 'render', reason: 'error', error }); }, [tasks]);
}

/** Layout effects (including nested measurement renders) finish before the paint fence. */
export function useWorkbenchDrawingCommit() {
  const tasks = useContext(WorkbenchDrawingContext);
  useLayoutEffect(() => { tasks?.committed(); });
}
