import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import PromptModal from './PromptModal';

type Phase = 'loading' | 'drawing' | 'ready';
const LoadingContext = createContext<(phase: Phase) => void>(() => undefined);

/** Keep the loading dialog outside the expensive workbench render. */
export default function WorkbenchLoadingBoundary({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const content = useRef<HTMLDivElement>(null);
  const busy = phase !== 'ready';

  useLayoutEffect(() => {
    if (content.current) content.current.inert = busy;
  }, [busy]);

  useEffect(() => {
    const root = content.current;
    if (phase !== 'drawing' || !root) return;
    let changedAt = performance.now();
    let stableFrames = 0;
    let frame = 0;
    let completion: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      changedAt = performance.now();
      stableFrames = 0;
      if (completion !== undefined) {
        clearTimeout(completion);
        completion = undefined;
        frame = requestAnimationFrame(check);
      }
    };
    // Card measurement and relation-label placement commit in later renders.
    // Each content change restarts the quiet period. Frame cadence alone does
    // not mean layout is changing: mobile browsers may throttle every frame.
    const mutations = new MutationObserver(changed);
    mutations.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    const sizes = new ResizeObserver(changed);
    for (const child of root.children) sizes.observe(child);
    const check = (now: number) => {
      const fontsLoading = document.fonts?.status === 'loading';
      if (!fontsLoading && now - changedAt >= 120) stableFrames += 1;
      else stableFrames = 0;
      if (stableFrames >= 2) {
        // Yield once more so pending observer/measurement callbacks can run.
        completion = setTimeout(() => setPhase('ready'), 0);
      } else frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => {
      mutations.disconnect();
      sizes.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(completion);
    };
  }, [phase]);

  useEffect(() => {
    if (!busy) return;
    // Document-level workbench shortcuts also need to wait for drawing.
    const blockShortcut = (event: KeyboardEvent) => event.stopImmediatePropagation();
    window.addEventListener('keydown', blockShortcut, true);
    window.addEventListener('keyup', blockShortcut, true);
    return () => {
      window.removeEventListener('keydown', blockShortcut, true);
      window.removeEventListener('keyup', blockShortcut, true);
    };
  }, [busy]);

  return <LoadingContext.Provider value={setPhase}>
    <div ref={content} aria-busy={busy} style={{ display: 'contents' }}>{children}</div>
    <PromptModal open={busy} title={phase === 'drawing' ? '正在绘制' : '正在加载'}
      message={phase === 'drawing' ? '数据已收到，正在绘制消息与关系，请稍候…' : '正在加载消息数据，请稍候…'}
      hideActions onConfirm={() => undefined} />
  </LoadingContext.Provider>;
}

/** Errors must release the dialog as well, so the error remains visible. */
export function useWorkbenchLoadingProgress(loading: boolean, error: string | null) {
  const report = useContext(LoadingContext);
  useLayoutEffect(() => {
    report(error ? 'ready' : loading ? 'loading' : 'drawing');
  }, [report, loading, error]);
}
