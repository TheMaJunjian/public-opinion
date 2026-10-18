import { useSyncExternalStore } from 'react';

type ActivityKind = 'sync' | 'draw';
type ActivityEntry = { active: boolean; startedAt: number; lastDuration: number | null };
type ActivitySnapshot = Record<ActivityKind, ActivityEntry>;

const listeners = new Set<() => void>();
const durations = new Map<ActivityKind, ReturnType<typeof setTimeout>>();
const drawingOwners = new Set<symbol>();
let drawQuietTimer: ReturnType<typeof setTimeout> | null = null;
let snapshot: ActivitySnapshot = {
  sync: { active: false, startedAt: 0, lastDuration: null },
  draw: { active: false, startedAt: 0, lastDuration: null },
};

function publish(kind: ActivityKind, entry: ActivityEntry) {
  snapshot = { ...snapshot, [kind]: entry };
  listeners.forEach(listener => listener());
}

function clearDurationLater(kind: ActivityKind) {
  const previous = durations.get(kind);
  if (previous) clearTimeout(previous);
  durations.set(kind, setTimeout(() => {
    durations.delete(kind);
    if (!snapshot[kind].active) publish(kind, { ...snapshot[kind], lastDuration: null });
  }, 5000));
}

function begin(kind: ActivityKind) {
  if (snapshot[kind].active) return;
  publish(kind, { active: true, startedAt: performance.now(), lastDuration: null });
}

function finish(kind: ActivityKind) {
  const current = snapshot[kind];
  if (!current.active) return;
  const elapsed = Math.max(0, performance.now() - current.startedAt);
  publish(kind, { active: false, startedAt: 0, lastDuration: elapsed >= 150 ? elapsed : null });
  if (elapsed >= 150) clearDurationLater(kind);
}

export function beginWorkbenchSync() { begin('sync'); }
export function finishWorkbenchSync() { finish('sync'); }

export function beginWorkbenchDrawing() {
  begin('draw');
  noteWorkbenchDrawingProgress();
}

/** A failed scene must not leave a background timer showing successful completion. */
export function cancelWorkbenchDrawing() {
  if (drawQuietTimer) clearTimeout(drawQuietTimer);
  drawQuietTimer = null;
  const duration = durations.get('draw');
  if (duration) clearTimeout(duration);
  durations.delete('draw');
  publish('draw', { active: false, startedAt: 0, lastDuration: null });
}

/** The loading boundary owns completion while the scene is blocked for layout. */
export function manageWorkbenchDrawing() {
  const owner = Symbol();
  drawingOwners.add(owner);
  if (drawQuietTimer) clearTimeout(drawQuietTimer);
  drawQuietTimer = null;
  begin('draw');
  return (completed = true) => {
    if (!drawingOwners.delete(owner) || drawingOwners.size > 0) return;
    if (completed) finish('draw');
    else publish('draw', { active: false, startedAt: 0, lastDuration: null });
  };
}

/** Ordinary background redraws use a brief activity hint; blocked loads own completion explicitly. */
export function noteWorkbenchDrawingProgress() {
  if (!snapshot.draw.active) return;
  if (drawingOwners.size > 0) return;
  if (drawQuietTimer) clearTimeout(drawQuietTimer);
  drawQuietTimer = setTimeout(() => {
    drawQuietTimer = null;
    finish('draw');
  }, 180);
}

/** A long synchronous render can only be reported after the browser is responsive again. */
export function reportWorkbenchDrawingDuration(elapsed: number) {
  if (!Number.isFinite(elapsed) || elapsed < 150 || snapshot.draw.active) return;
  publish('draw', { active: false, startedAt: 0, lastDuration: elapsed });
  clearDurationLater('draw');
}

export function useWorkbenchActivity() {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => snapshot,
  );
}

export function resetWorkbenchActivity() {
  drawingOwners.clear();
  if (drawQuietTimer) clearTimeout(drawQuietTimer);
  drawQuietTimer = null;
  durations.forEach(timer => clearTimeout(timer));
  durations.clear();
  snapshot = {
    sync: { active: false, startedAt: 0, lastDuration: null },
    draw: { active: false, startedAt: 0, lastDuration: null },
  };
  listeners.forEach(listener => listener());
}
