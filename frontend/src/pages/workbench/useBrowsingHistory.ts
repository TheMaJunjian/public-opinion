import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Keep view snapshots only; message data continues to come from the live store. */
export function useBrowsingHistory<T>(key: unknown, capture: () => T, restore: (snapshot: T) => void) {
  const callbacks = useRef({ capture, restore });
  callbacks.current = { capture, restore };
  const history = useRef({ key, back: [] as T[], forward: [] as T[], recorded: false });
  const [, update] = useState(0);
  if (history.current.key !== key) history.current = { key, back: [], forward: [], recorded: false };
  useLayoutEffect(() => { history.current.recorded = false; });

  const record = useCallback(() => {
    const current = history.current;
    // One user navigation can also enter a container or close a temporary view.
    // Those synchronous steps share the same origin.
    if (current.recorded) return;
    current.recorded = true;
    current.back.push(callbacks.current.capture());
    if (current.back.length > 100) current.back.shift();
    current.forward = [];
    update(value => value + 1);
  }, []);
  const move = useCallback((direction: 'back' | 'forward') => {
    const current = history.current, source = current[direction];
    if (!source.length) return;
    const snapshot = source.pop()!;
    current[direction === 'back' ? 'forward' : 'back'].push(callbacks.current.capture());
    current.recorded = true;
    callbacks.current.restore(snapshot);
    update(value => value + 1);
  }, []);
  const back = useCallback(() => move('back'), [move]);
  const forward = useCallback(() => move('forward'), [move]);
  return { record, back, forward, canGoBack: history.current.back.length > 0, canGoForward: history.current.forward.length > 0 };
}
