import { useEffect } from 'react';
import { updateReviewPresence } from '../api/client';

/** Hidden tabs and background polling must not keep an absent reviewer online. */
export function useReviewPresence(userId?: string) {
  useEffect(() => {
    if (!userId) return;
    const abort = new AbortController();
    let running = false;
    const heartbeat = async () => {
      if (abort.signal.aborted || running || document.hidden || navigator.onLine === false) return;
      running = true;
      try { await updateReviewPresence(abort.signal); }
      catch { /* Presence expires safely; retry on the next heartbeat or return to the page. */ }
      finally { running = false; }
    };
    const wake = () => { void heartbeat(); };
    const interval = setInterval(wake, 30_000);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    wake();
    return () => {
      abort.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
    };
  }, [userId]);
}
