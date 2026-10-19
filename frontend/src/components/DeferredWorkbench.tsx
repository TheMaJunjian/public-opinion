import { Suspense, useContext, useLayoutEffect, type ReactNode } from 'react';
import { WorkbenchDrawingContext, useWorkbenchDrawingFailure } from '../context/WorkbenchDrawingContext';
import ErrorBoundary from './ErrorBoundary';

function Pending({ label, blocksDrawing }: { label: string; blocksDrawing: boolean }) {
  const tasks = useContext(WorkbenchDrawingContext);
  useLayoutEffect(() => {
    if (!blocksDrawing || !tasks) return;
    const task = tasks.begin('module');
    return () => task.cancel();
  }, [tasks, blocksDrawing]);
  return <div role="status" aria-live="polite" style={{ padding: 24 }}>正在加载{label}…</div>;
}

/** Loading a view participates in the same readiness fence as drawing it. */
export default function DeferredWorkbench({ children, label, blocksDrawing = false }: {
  children: ReactNode; label: string; blocksDrawing?: boolean;
}) {
  const fail = useWorkbenchDrawingFailure();
  return <ErrorBoundary onError={blocksDrawing ? fail : undefined}>
    <Suspense fallback={<Pending label={label} blocksDrawing={blocksDrawing} />}>{children}</Suspense>
  </ErrorBoundary>;
}
