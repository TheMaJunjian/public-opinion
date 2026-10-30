import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { OperationProgressDialog } from './OperationFeedback';
import ErrorBoundary from './ErrorBoundary';
import { cancelWorkbenchDrawing, manageWorkbenchDrawing } from '../utils/workbenchActivity';
import { createWorkbenchDrawingTasks, WorkbenchDrawingContext, WORKBENCH_DRAWING_TIMEOUT_MS, watchWorkbenchDrawingDeadline, type DrawingFailure } from '../context/WorkbenchDrawingContext';

type Phase = 'loading' | 'drawing' | 'sending' | 'ready';
const LoadingContext = createContext<(phase: Phase, resetFailure?: boolean) => void>(() => undefined);
const SendingContext = createContext<(sending: boolean) => void>(() => undefined);
const DrawingPreparationContext = createContext<((work: () => void) => () => void) | null>(null);
export const WORKBENCH_REQUEST_WAIT_MS = 60_000;
const taskNames = { module: '界面加载', projection: '消息整理', measurement: '尺寸测量', overlays: '连线绘制', positioning: '消息定位', fonts: '字体加载', render: '页面绘制' };

/** Keep the loading dialog outside the expensive workbench render. */
export default function WorkbenchLoadingBoundary({ children }: { children: ReactNode }) {
  const [attempt, setAttempt] = useState(() => ({ tasks: createWorkbenchDrawingTasks(), key: 0 }));
  const { tasks } = attempt;
  const [failure, setFailure] = useState<DrawingFailure | null>(null);
  const [cycle, setCycle] = useState(0);
  const [waitNotice, setWaitNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ phase: Phase; sending: boolean; reason: 'loading' | 'sending'; drawingRevision?: number }>({ phase: 'loading', sending: false, reason: 'loading' });
  const { phase, reason, drawingRevision } = progress;
  const reportLoading = useCallback((next: Phase, resetFailure = false) => {
    tasks.committed();
    if (resetFailure) { tasks.clearFailure(); setFailure(null); setCycle(value => value + 1); }
    if (next !== 'ready' && !tasks.failure) tasks.setBlocking(true);
    setProgress(previous => previous.sending ? previous : { ...previous, phase: next, reason: 'loading', drawingRevision: undefined });
  }, [tasks]);
  const reportSending = useCallback((sending: boolean) => {
    if (sending) {
      tasks.clearFailure(); setFailure(null); setCycle(value => value + 1);
      tasks.setBlocking(true);
    }
    setProgress(previous => previous.sending === sending ? previous : { phase: tasks.failure ? 'ready' : sending ? 'sending' : 'drawing', sending, reason: 'sending' });
  }, [tasks]);
  const content = useRef<HTMLDivElement>(null);
  const finishDrawing = useRef<((completed?: boolean) => void) | null>(null);
  const drawingWait = useRef<{ tasks: typeof tasks; cycle: number; remaining: number } | null>(null);
  const preparations = useRef(new Set<{ schedule(): void; cancel(): void }>());
  const prepareDrawing = useCallback((work: () => void) => {
    if (tasks.failure) return () => {};
    const task = tasks.begin('projection');
    let frame = 0, paintFrame = 0, scheduled = false, disposed = false;
    const preparation = {
      schedule() {
        if (scheduled || disposed) return;
        scheduled = true;
        frame = requestAnimationFrame(() => { paintFrame = requestAnimationFrame(() => {
          if (disposed || !task.active) return;
          preparations.current.delete(preparation);
          try { work(); task.release(); } catch (error) { task.fail(error); }
        }); });
      },
      cancel() {
        if (disposed) return;
        disposed = true;
        preparations.current.delete(preparation); cancelAnimationFrame(frame); cancelAnimationFrame(paintFrame);
        task.cancel();
      },
    };
    task.onCancel(preparation.cancel);
    preparations.current.add(preparation);
    tasks.committed(); tasks.setBlocking(true);
    setWaitNotice(null); setCycle(value => value + 1);
    setProgress(previous => ({ ...previous, phase: previous.phase === 'sending' ? 'sending' : 'drawing',
      reason: previous.phase === 'sending' ? 'sending' : 'loading', drawingRevision: undefined }));
    return preparation.cancel;
  }, [tasks]);
  const busy = phase !== 'ready';

  useLayoutEffect(() => {
    if (phase === 'drawing' && !tasks.failure) for (const preparation of preparations.current) preparation.schedule();
  }, [phase, cycle, tasks]);
  useLayoutEffect(() => () => { for (const preparation of preparations.current) preparation.cancel(); }, []);

  useEffect(() => { setWaitNotice(null); }, [cycle, attempt.key]);
  useEffect(() => {
    if (phase !== 'loading' && phase !== 'sending') return;
    const timer = setTimeout(() => {
      setWaitNotice(phase === 'sending'
        ? '等待已超过 60 秒，发送结果尚未确认。已恢复界面；请先核对记录，不要重复提交。'
        : '加载等待已超过 60 秒，已恢复界面；数据尚未准备完成，可稍后重试。');
      // This releases presentation only. The write and its duplicate guard keep their owner.
      setProgress(previous => previous.phase === phase ? { ...previous, phase: 'ready' } : previous);
    }, WORKBENCH_REQUEST_WAIT_MS);
    return () => clearTimeout(timer);
  }, [phase, cycle]);

  useLayoutEffect(() => {
    const failed = () => {
      if (!tasks.failure) return;
      setFailure(tasks.failure);
      setProgress(previous => previous.phase === 'ready' && previous.drawingRevision === undefined
        ? previous : { ...previous, phase: 'ready', drawingRevision: undefined });
    };
    const unsubscribe = tasks.subscribe(failed);
    failed(); // A child layout effect may have failed before subscription.
    return unsubscribe;
  }, [tasks]);

  useLayoutEffect(() => {
    // A task can register in a child layout effect in this very commit.
    // Recheck before publishing completion or removing interaction guards.
    if (phase === 'ready' && drawingRevision !== undefined && (tasks.pending || tasks.revision !== drawingRevision)) {
      if (content.current) content.current.inert = true;
      setProgress(previous => ({ ...previous, phase: 'drawing', drawingRevision: undefined }));
      return;
    }
    tasks.setBlocking(busy);
    if (content.current) content.current.inert = busy;
    if (phase === 'drawing') {
      finishDrawing.current ??= manageWorkbenchDrawing();
    } else {
      finishDrawing.current?.(phase === 'ready' && !tasks.failure);
      finishDrawing.current = null;
      if (tasks.failure) cancelWorkbenchDrawing();
    }
  }, [busy, phase, drawingRevision, tasks]);

  useLayoutEffect(() => () => {
    finishDrawing.current?.(false);
    finishDrawing.current = null;
  }, []);

  useEffect(() => {
    if (phase !== 'drawing') return;
    let frame = 0, paintFrame = 0;
    let disposed = false;
    const schedule = () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(paintFrame);
      if (disposed || tasks.failure || tasks.pending) return;
      const revision = tasks.revision;
      // Cross a browser paint only after every registered task has committed.
      // This is a commit fence, not an elapsed-time or DOM-quiet heuristic.
      frame = requestAnimationFrame(() => {
        paintFrame = requestAnimationFrame(() => {
          if (disposed || tasks.failure || tasks.pending || tasks.revision !== revision) return;
          setProgress(previous => previous.phase === 'drawing' && !tasks.failure && !tasks.pending && tasks.revision === revision
            ? { ...previous, phase: 'ready', drawingRevision: revision } : previous);
        });
      });
    };
    const unsubscribe = tasks.subscribe(schedule);
    let fontTask: ReturnType<typeof tasks.begin> | undefined;
    const waitForFonts = () => {
      if (fontTask || tasks.failure || document.fonts?.status !== 'loading') return;
      const task = tasks.begin('fonts');
      fontTask = task;
      const complete = () => {
        if (fontTask === task) fontTask = undefined;
        task.release();
      };
      void document.fonts.ready.then(complete, error => task.fail(error));
    };
    document.fonts?.addEventListener?.('loading', waitForFonts);
    waitForFonts();
    schedule();
    return () => {
      disposed = true;
      unsubscribe();
      document.fonts?.removeEventListener?.('loading', waitForFonts);
      fontTask?.cancel();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(paintFrame);
    };
  }, [phase, tasks, cycle]);

  useEffect(() => {
    if (phase !== 'drawing' || tasks.failure) return;
    if (drawingWait.current?.tasks !== tasks || drawingWait.current.cycle !== cycle) {
      drawingWait.current = { tasks, cycle, remaining: WORKBENCH_DRAWING_TIMEOUT_MS };
    }
    // A failed ready-commit can return to drawing. Preserve this cycle's
    // elapsed time so repeated layout work cannot extend the deadline forever.
    return watchWorkbenchDrawingDeadline(() => tasks.abort({ kind: 'render', reason: 'timeout' }), drawingWait.current);
  }, [phase, tasks, cycle]);

  useLayoutEffect(() => {
    if (!busy) return;
    // Document-level workbench shortcuts also need to wait for drawing.
    const isProgressControl = (event: Event) => event.target instanceof Element && !!event.target.closest('[data-operation-progress="true"]');
    const blockShortcut = (event: KeyboardEvent) => { if (!isProgressControl(event)) event.stopImmediatePropagation(); };
    // Keep the viewport width unchanged while blocking scroll. Toggling body
    // overflow on close would resize the scene after the dialog had disappeared.
    const blockScroll = (event: Event) => { if (!isProgressControl(event)) event.preventDefault(); };
    window.addEventListener('keydown', blockShortcut, true);
    window.addEventListener('keyup', blockShortcut, true);
    window.addEventListener('wheel', blockScroll, { capture: true, passive: false });
    window.addEventListener('touchmove', blockScroll, { capture: true, passive: false });
    return () => {
      window.removeEventListener('keydown', blockShortcut, true);
      window.removeEventListener('keyup', blockShortcut, true);
      window.removeEventListener('wheel', blockScroll, true);
      window.removeEventListener('touchmove', blockScroll, true);
    };
  }, [busy]);

  return <WorkbenchDrawingContext.Provider value={tasks}><LoadingContext.Provider value={reportLoading}><SendingContext.Provider value={reportSending}><DrawingPreparationContext.Provider value={prepareDrawing}>
    {waitNotice && <div role="alert" style={{ padding: 12, background: 'var(--surface-3b2616)', color: 'var(--ink-fde68a)' }}>{waitNotice}</div>}
    {failure && <div role="alert" style={{ padding: 12, background: 'var(--surface-3b2616)', color: 'var(--ink-fde68a)' }}>
      {failure.reason === 'timeout' ? '绘制等待超过 30 秒，已停止等待并恢复操作。' : `${taskNames[failure.kind]}失败，已恢复操作。`}
      页面可能显示不完整，请重新加载。
      <button type="button" onClick={() => {
        setFailure(null);
        setProgress({ phase: 'loading', sending: false, reason: 'loading' });
        setAttempt(previous => ({ tasks: createWorkbenchDrawingTasks(), key: previous.key + 1 }));
      }} style={{ marginLeft: 12 }}>重新加载</button>
    </div>}
    <div key={attempt.key} ref={content} aria-busy={busy} style={{ display: 'contents' }}>
      <ErrorBoundary onError={error => tasks.abort({ kind: 'render', reason: 'error', error })}>{children}</ErrorBoundary>
    </div>
    {busy && <OperationProgressDialog title={reason === 'sending' ? '正在发送' : phase === 'drawing' ? '正在绘制' : '正在加载'}>
      <div data-workbench-progress-active="true">
        {phase === 'sending' ? '正在等待服务器确认发送，请勿重复提交。' : phase === 'drawing' ? reason === 'sending'
          ? '正在完成消息绘制和新消息定位，请稍候。' : '正在更新消息与关系，等待绘制和定位完成。' : '正在加载消息数据，请稍候。'}
        <p>完成后将自动关闭，并恢复工作区操作。</p>
      </div>
    </OperationProgressDialog>}
  </DrawingPreparationContext.Provider></SendingContext.Provider></LoadingContext.Provider></WorkbenchDrawingContext.Provider>;
}

/** Errors must release the dialog as well, so the error remains visible. */
export function useWorkbenchLoadingProgress(loading: boolean, error: string | null, revision?: unknown) {
  const report = useContext(LoadingContext);
  const previous = useRef({ loading, revision });
  useLayoutEffect(() => {
    const resetFailure = previous.current.revision !== revision || (loading && !previous.current.loading);
    previous.current = { loading, revision };
    report(error ? 'ready' : loading ? 'loading' : 'drawing', resetFailure);
  }, [report, loading, error, revision]);
}

/** Paint progress before committing DOM work that can prevent the browser responding. */
export function useWorkbenchDrawingPreparation() {
  const prepare = useContext(DrawingPreparationContext);
  return useCallback((work: () => void) => {
    if (prepare) return prepare(work);
    work(); return () => {};
  }, [prepare]);
}

/** After sending, wait for drawing, measurement and positioning to commit together. */
export function useWorkbenchSendingProgress(sending: boolean) {
  const report = useContext(SendingContext);
  useLayoutEffect(() => { report(sending); }, [report, sending]);
  const prepare = useCallback(() => {
    // Commit the lightweight boundary first, before copying or rendering the
    // workbench. Cross a paint so even synchronous command preparation is covered.
    flushSync(() => report(true));
    return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, [report]);
  return { prepare, finish: () => report(false) };
}
