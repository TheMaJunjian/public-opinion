import { useEffect, useRef, useState } from 'react';
import type { Change } from '@gonglun/core';
import { api } from './api';

export function useLiveSync(enabled: boolean, sequence: number, receive: (change: Change) => void) {
  const [status, setStatus] = useState<'connecting' | 'live' | 'recovering'>('connecting');
  const cursor = useRef(sequence);
  const callback = useRef(receive);
  callback.current = receive;
  cursor.current = Math.max(cursor.current, sequence);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let recovering = true;
    let recovery: Promise<void> | null = null;
    let highWater = cursor.current;
    const buffered = new Map<number, Change>();
    const source = new EventSource(`/api/events?after=${cursor.current}`);
    const accept = (change: Change): boolean => {
      if (disposed || change.sequence <= cursor.current) return true;
      if (change.sequence !== cursor.current + 1) return false;
      callback.current(change);
      cursor.current = change.sequence;
      return true;
    };
    const recover = () => {
      if (recovery) return recovery;
      recovering = true;
      setStatus('recovering');
      recovery = (async () => {
        let hasMore = true;
        while (!disposed && hasMore) {
          const page = await api.changes(cursor.current);
          if (disposed) return;
          for (const change of page.changes) if (!accept(change)) throw new Error('正在补齐消息');
          hasMore = page.hasMore || cursor.current < highWater;
          if (hasMore && !page.changes.length) throw new Error('变更记录暂时不可用');
        }
        if (disposed) return;
        for (const change of [...buffered.values()].sort((a, b) => a.sequence - b.sequence)) if (!accept(change)) throw new Error('正在补齐消息');
        buffered.clear();
        recovering = false;
        setStatus('live');
      })().catch(() => { if (!disposed) setStatus('recovering'); }).finally(() => { recovery = null; });
      return recovery;
    };
    source.onopen = () => { void recover(); };
    source.onmessage = event => {
      try {
        const change = JSON.parse(event.data) as Change;
        if (typeof change.sequence !== 'number' || !Array.isArray(change.messages)) return;
        highWater = Math.max(highWater, change.sequence);
        if (recovering || !accept(change)) { if (buffered.size < 256) buffered.set(change.sequence, change); recovering = true; void recover(); }
      } catch { setStatus('recovering'); void recover(); }
    };
    source.onerror = () => { recovering = true; setStatus('recovering'); };
    const timer = window.setInterval(() => { if (recovering) void recover(); }, 5000);
    return () => { disposed = true; source.close(); window.clearInterval(timer); };
  }, [enabled]);
  return status;
}
