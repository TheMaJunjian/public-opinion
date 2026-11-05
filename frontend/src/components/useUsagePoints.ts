import { useEffect, useState } from 'react';
import { api } from '../api';
import type { UsagePointProgress } from '../types';

type Timer = { progress: UsagePointProgress; deadline: number };

/** Each round claims automatically while the app is running, including in the background. */
export function useUsagePoints(userId?: string) {
  const [timer, setTimer] = useState<Timer | null>(null);
  const [now, setNow] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    setTimer(null);
    setError(false);
    if (!userId) return;
    const controller = new AbortController();
    let current: Timer | null = null, busy = false, nextTimer: ReturnType<typeof setTimeout> | undefined;
    const sync = async (action: 'start' | 'tick') => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        const progress = await api.updateUsagePoints({ action, ...(current ? { roundId: current.progress.roundId } : {}) }, controller.signal);
        if (controller.signal.aborted) return;
        const receivedAt = performance.now();
        const changed = progress.awarded || current && progress.totalEarned !== current.progress.totalEarned;
        current = { progress, deadline: receivedAt + progress.remainingMs };
        setTimer(current);
        setNow(receivedAt);
        setError(false);
        if (changed) window.dispatchEvent(new Event('points-refresh'));
        clearTimeout(nextTimer);
        nextTimer = setTimeout(() => void sync('tick'), Math.max(20, Math.min(progress.remainingMs, progress.refreshInMs) + 20));
      } catch {
        if (!controller.signal.aborted) {
          setError(true);
          clearTimeout(nextTimer);
          nextTimer = setTimeout(() => void sync(current ? 'tick' : 'start'), 5000);
        }
      } finally { busy = false; }
    };
    const focus = () => void sync(current ? 'tick' : 'start');
    const visible = () => { if (document.visibilityState === 'visible') focus(); };
    window.addEventListener('focus', focus);
    window.addEventListener('online', focus);
    document.addEventListener('visibilitychange', visible);
    const interval = setInterval(() => setNow(performance.now()), 250);
    void sync('start');
    return () => {
      controller.abort();
      clearTimeout(nextTimer);
      clearInterval(interval);
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', focus);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [userId]);
  const remainingMs = timer ? Math.max(0, timer.deadline - now) : null;
  const completion = timer && remainingMs !== null ? Math.max(0, Math.min(1, 1 - remainingMs / (timer.progress.waitSeconds * 1000))) : 0;
  return { progress: timer?.progress ?? null, completion, remainingMs, error };
}
