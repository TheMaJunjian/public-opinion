import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ABOUT_HISTORY_KEY } from '../../utils/aboutNavigation';

const STATE_KEY = '__gonglunWorkbench';
type Marker = { owner: string; id: string; index: number };
type Entry<T> = { id: string; snapshot?: T };
type Session<T> = {
  key: unknown; owner: string; entries: Entry<T>[]; index: number;
  recorded: boolean; restoring: boolean; moving: boolean; branching: boolean;
};

function marker(state: unknown): Marker | null {
  const value = (state as Record<string, unknown> | null)?.[STATE_KEY] as Partial<Marker> | undefined;
  return value && typeof value.owner === 'string' && typeof value.id === 'string'
    && typeof value.index === 'number' && Number.isSafeInteger(value.index) && value.index >= 0 ? value as Marker : null;
}

function writeEntry<T>(session: Session<T>, push: boolean) {
  const value: Marker = { owner: session.owner, id: session.entries[session.index].id, index: session.index };
  // Snapshots contain restore closures. Only their IDs belong in structured browser state.
  // Retain the router key/state so offline documents and the composer stay mounted.
  const state = { ...window.history.state, [STATE_KEY]: value };
  if (push) window.history.pushState(state, '');
  else window.history.replaceState(state, '');
}

function anchorEntry<T>(session: Session<T>) {
  const active = marker(window.history.state);
  if (active?.owner !== session.owner || active.id !== session.entries[session.index].id) writeEntry(session, false);
}

/** The browser owns traversal; snapshots stay in the mounted workbench, outside history.state. */
export function useBrowserBrowsingHistory<T>(key: unknown, capture: () => T, restore: (snapshot: T) => void, enabled: boolean, routeState: unknown = window.history.state?.usr) {
  const callbacks = useRef({ capture, restore, routeState });
  callbacks.current = { capture, restore, routeState };
  const session = useRef<Session<T>>();
  const [, update] = useState(0);
  if (enabled && (!session.current || session.current.key !== key)) {
    session.current = { key, owner: crypto.randomUUID(), entries: [{ id: crypto.randomUUID() }], index: 0,
      recorded: false, restoring: false, moving: false, branching: false };
  }

  useLayoutEffect(() => {
    if (!enabled) return;
    const current = session.current!;
    const pop = (event: PopStateEvent) => {
      const destination = marker(event.state);
      if (!destination || destination.owner !== current.owner
        || current.entries[destination.index]?.id !== destination.id) return;
      // These entries belong to the same mounted route. Preserve its live route
      // payload before the router reads history.state: native traversal clones
      // it, which must not be mistaken for opening another local file.
      event.state.usr = callbacks.current.routeState;
      window.history.state.usr = callbacks.current.routeState;
      // Introduction/document entries carry the same workbench marker. They must
      // close/navigate their own viewer without replaying the workbench snapshot.
      if (destination.index === current.index) {
        current.moving = false;
        update(value => value + 1);
        return;
      }
      if (!current.restoring && !current.branching) current.entries[current.index].snapshot = callbacks.current.capture();
      current.index = destination.index;
      current.moving = false;
      current.recorded = true;
      if (current.branching) {
        // A category click can arrive while a toolbar Back is still traversing.
        // Keep that newest view and start its branch at the browser's destination.
        current.branching = false;
        current.entries.splice(current.index + 1);
        current.entries.push({ id: crypto.randomUUID(), snapshot: callbacks.current.capture() });
        current.index++;
        writeEntry(current, true);
      } else {
        const snapshot = current.entries[current.index].snapshot;
        if (snapshot !== undefined) { current.restoring = true; callbacks.current.restore(snapshot); }
      }
      update(value => value + 1);
    };
    const destination = marker(window.history.state);
    if (destination?.owner === current.owner) pop({ state: window.history.state } as PopStateEvent);
    else writeEntry(current, false);
    window.addEventListener('popstate', pop, true);
    return () => window.removeEventListener('popstate', pop, true);
  }, [enabled, key]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const current = session.current!;
    current.recorded = false;
    const active = marker(window.history.state);
    if (!current.moving && active?.owner === current.owner && active.id === current.entries[current.index].id
      && !window.history.state?.[ABOUT_HISTORY_KEY]) {
      current.restoring = false;
    }
  });

  const record = useCallback(() => {
    const current = session.current;
    if (!enabled || !current || current.recorded || window.history.state?.[ABOUT_HISTORY_KEY]) return;
    current.recorded = true;
    if (current.moving) { current.branching = true; update(value => value + 1); return; }
    // Router query cleanup uses replaceState and may remove our private marker.
    anchorEntry(current);
    current.entries[current.index].snapshot = callbacks.current.capture();
    current.entries.splice(current.index + 1);
    current.entries.push({ id: crypto.randomUUID() });
    current.index++;
    writeEntry(current, true);
    update(value => value + 1);
  }, [enabled]);

  const move = useCallback((delta: number) => {
    const current = session.current;
    if (!enabled || !current || current.moving || !current.entries[current.index + delta]
      || window.history.state?.[ABOUT_HISTORY_KEY]) return;
    anchorEntry(current);
    if (!current.restoring) current.entries[current.index].snapshot = callbacks.current.capture();
    current.moving = true;
    window.history.go(delta);
    update(value => value + 1);
  }, [enabled]);
  const back = useCallback(() => move(-1), [move]);
  const forward = useCallback(() => move(1), [move]);
  const current = enabled ? session.current : undefined;
  return { record, back, forward,
    canGoBack: !!current && !current.moving && current.index > 0,
    canGoForward: !!current && !current.moving && current.index < current.entries.length - 1,
    backSnapshot: current?.entries[current.index - 1]?.snapshot,
    forwardSnapshot: current?.entries[current.index + 1]?.snapshot };
}
