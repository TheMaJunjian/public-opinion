import { useEffect, useState } from 'react';
import type { NotificationSummary } from '@gonglun/core';
import { getNotificationSummary, subscribeChanges } from '../api/client';
import { NOTIFICATIONS_CHANGED, NOTIFICATIONS_STORAGE_KEY } from '../data/notifications';

export function useNotifications(userId: string) {
  const [state, setState] = useState<{summary:NotificationSummary;error:string|null;revision:number}>({
    summary:{unseenCount:0,through:0,sequence:0},error:null,revision:0,
  });
  useEffect(() => {
    const abort = new AbortController();
    let stream: EventSource | undefined, running = false, queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0, lastFetch = 0, force = false;
    const visible = () => !document.hidden && navigator.onLine !== false;
    const schedule = (immediate = false) => {
      if (abort.signal.aborted || !visible()) return;
      force ||= immediate;
      if (running) { queued = true; return; }
      if (timer) { if (!immediate) return; clearTimeout(timer); }
      timer = setTimeout(() => { timer=undefined; void refresh(); }, immediate ? 0 : Math.max(0, 2000-(Date.now()-lastFetch)));
    };
    async function refresh() {
      if (abort.signal.aborted || !visible()) return;
      running = true; queued = false;
      const forced = force; force = false;
      try {
        const summary = await getNotificationSummary(abort.signal);
        if (abort.signal.aborted) return;
        cursor = summary.sequence;
        setState(previous => ({summary,error:null,revision:previous.revision + (forced || previous.summary.through !== summary.through || previous.summary.unseenCount !== summary.unseenCount || previous.summary.pendingReviewCount !== summary.pendingReviewCount ? 1 : 0)}));
        if (!stream || stream.readyState === 2) {
          stream?.close(); stream = subscribeChanges(cursor);
          stream.onmessage = event => { try { if (JSON.parse(event.data).sequence > cursor) schedule(); } catch { schedule(); } };
          stream.onopen = () => schedule();
          stream.onerror = () => schedule();
        }
      } catch (error) {
        if (!abort.signal.aborted) setState(previous => ({...previous,error:error instanceof Error ? error.message : '通知同步失败'}));
      } finally {
        running = false; lastFetch = Date.now();
        if (queued) schedule();
      }
    }
    const wake = () => { if (!visible()) { stream?.close(); stream=undefined; } else schedule(true); };
    const storage = (event: StorageEvent) => { if (event.key === NOTIFICATIONS_STORAGE_KEY) wake(); };
    const interval = setInterval(wake, 30_000);
    window.addEventListener('online',wake); window.addEventListener('focus',wake); window.addEventListener('pageshow',wake);
    window.addEventListener('storage',storage); window.addEventListener(NOTIFICATIONS_CHANGED,wake);
    document.addEventListener('visibilitychange',wake);
    schedule(true);
    return () => {
      abort.abort(); stream?.close(); clearInterval(interval); if(timer)clearTimeout(timer);
      window.removeEventListener('online',wake); window.removeEventListener('focus',wake); window.removeEventListener('pageshow',wake);
      window.removeEventListener('storage',storage); window.removeEventListener(NOTIFICATIONS_CHANGED,wake);
      document.removeEventListener('visibilitychange',wake);
    };
  }, [userId]);
  return state;
}
