import type React from 'react';
import { api } from '../../../api';
import type { WorkbenchComposer } from '../useWorkbenchComposer';

interface HandleSendClickDependencies {
  composer: Pick<WorkbenchComposer, 'capture' | 'restore' | 'setRecommendationAmount' | 'relationType'>;
  captureOptimisticRollback(): () => void;
  sendInFlightRef: React.MutableRefObject<boolean>;
  setSendInFlight: React.Dispatch<React.SetStateAction<boolean>>;
  handleQuickSendAndRelateFromDraftTargets(): Promise<void>;
  setSendError: React.Dispatch<React.SetStateAction<string | null>>;
  onCommitted?: () => void;
  prepare?: () => Promise<void>;
  onSettled?: () => void;
}

export async function handleSendClick(dependencies: HandleSendClickDependencies): Promise<void> {
  const { composer, captureOptimisticRollback, sendInFlightRef, setSendInFlight,
    handleQuickSendAndRelateFromDraftTargets, setSendError } = dependencies;
  if (sendInFlightRef.current) return;
  sendInFlightRef.current = true;
  let draft: ReturnType<typeof composer.capture> | undefined;
  let rollback: (() => void) | undefined;
  try {
    if (dependencies.prepare) await dependencies.prepare();
    setSendInFlight(true);
    draft = composer.capture();
    rollback = captureOptimisticRollback();
    let committedCount = 0;
    await api.withCommandBatch(handleQuickSendAndRelateFromDraftTargets, count => { committedCount = count; });
    if (committedCount === 0) composer.restore(draft);
    else {
      if (draft.state.relationType !== 'correct') composer.setRecommendationAmount(0);
      dependencies.onCommitted?.();
    }
  } catch (error) {
    if (draft) composer.restore(draft);
    rollback?.();
    setSendError(error instanceof Error ? error.message : '发送失败，输入与选择已保留');
    window.dispatchEvent(new Event('gonglun:reload'));
  } finally {
    sendInFlightRef.current = false;
    setSendInFlight(false);
    dependencies.onSettled?.();
  }
}
