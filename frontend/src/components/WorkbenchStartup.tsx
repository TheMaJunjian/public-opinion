import { Suspense, useLayoutEffect, useState, type ReactNode } from 'react';
import PromptModal from './PromptModal';

export function PageLoadingPrompt() {
  return <PromptModal open title="正在加载" message="正在加载界面，请稍候…" hideActions lockScroll={false} onConfirm={() => undefined} />;
}

/** Commit and paint the prompt before even starting the expensive route import. */
export default function WorkbenchStartup({ children }: { children: ReactNode }) {
  const [painted, setPainted] = useState(false);
  useLayoutEffect(() => {
    let nextFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      nextFrame = requestAnimationFrame(() => setPainted(true));
    });
    return () => { cancelAnimationFrame(firstFrame); cancelAnimationFrame(nextFrame); };
  }, []);
  return <Suspense fallback={<PageLoadingPrompt />}>{painted ? children : <PageLoadingPrompt />}</Suspense>;
}
