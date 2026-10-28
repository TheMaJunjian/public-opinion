import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Box } from '../utils/frameLayout';
import { useWorkbenchDrawingTask } from '../context/WorkbenchDrawingContext';
import { intersectsViewport, useCanvasViewport } from './useCanvasViewport';

export const MESSAGE_MEASUREMENT_BATCH = 32;
export const REVEAL_VIRTUAL_MESSAGE = 'workbench:reveal-virtual-message';
export interface VirtualMessageRevealDetail {
  ids: string[];
  /** The frame scroll must commit before navigation can read target geometry. */
  positioningPending?: boolean;
}

/** Measure new records in bounded batches; keep their cached geometry after unmounting. */
export function useVirtualMessageMounts(ref: RefObject<HTMLElement>, ids: string[], boxes: Record<string, Box>,
  heights: Record<string, number>, pinned: ReadonlySet<string>, verticalOnly = false,
  revealGroups?: ReadonlyMap<string, ReadonlySet<string>>, resolveRevealIds?: (ids: string[], detail: VirtualMessageRevealDetail) => string[]) {
  const viewport = useCanvasViewport(ref);
  const [batch, setBatch] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<string[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const startMeasurement = useWorkbenchDrawingTask('measurement');
  const ticket = useRef<ReturnType<typeof startMeasurement> | null>(null);
  const missing = useMemo(() => ids.filter(id => heights[id] === undefined), [ids, heights]);
  const measuring = useMemo(() => {
    // Membership/scope changes can remove a card before its layout mounts it.
    // Only the current scene's missing cards can keep a measurement batch alive.
    const required = new Set(missing);
    return new Set(batch.filter(id => required.has(id)));
  }, [batch, missing]);
  useLayoutEffect(() => {
    if (!missing.length) { ticket.current?.complete(); ticket.current = null; return; }
    ticket.current ??= startMeasurement();
    if (measuring.size) return;
    const frame = requestAnimationFrame(() => { setBatch(missing.slice(0, MESSAGE_MEASUREMENT_BATCH)); });
    return () => cancelAnimationFrame(frame);
  }, [missing, measuring, startMeasurement]);
  useLayoutEffect(() => () => { ticket.current?.cancel(); ticket.current = null; }, []);
  useLayoutEffect(() => {
    const surface = ref.current;
    if (!surface) return;
    const reveal = (event: Event) => {
      const detail = (event as CustomEvent<VirtualMessageRevealDetail>).detail;
      if (!detail?.ids) return;
      // Nested frames need their descendants too; a Set also breaks malformed cycles.
      const expanded = new Set(detail.ids);
      for (const id of expanded) for (const member of revealGroups?.get(id) ?? []) expanded.add(member);
      for (const id of resolveRevealIds?.([...expanded], detail) ?? []) expanded.add(id);
      for (const id of expanded) for (const member of revealGroups?.get(id) ?? []) expanded.add(member);
      const ids = [...expanded];
      setRevealed(previous => previous.length === ids.length && previous.every((id, index) => id === ids[index]) ? previous : ids);
    };
    const host = surface.closest('[data-workbench-left-panel]') ?? surface;
    host.addEventListener(REVEAL_VIRTUAL_MESSAGE, reveal);
    return () => host.removeEventListener(REVEAL_VIRTUAL_MESSAGE, reveal);
  }, [ref, ids, revealGroups, resolveRevealIds]);
  useLayoutEffect(() => {
    const surface = ref.current;
    if (!surface) return;
    const focus = () => {
      const active = document.activeElement;
      setFocused(active instanceof Element && surface.contains(active) ? active.closest<HTMLElement>('[data-msgid]')?.dataset.msgid ?? null : null);
    };
    document.addEventListener('focusin', focus);
    return () => document.removeEventListener('focusin', focus);
  }, [ref]);
  const within = useCallback((box: Box) => box.width>0&&box.height>0&&(!viewport || intersectsViewport(verticalOnly ? { ...box, x: viewport.x, width: viewport.width } : box, viewport)), [viewport, verticalOnly]);
  const mounted = useMemo(() => {
    const keep = new Set([...pinned, ...revealed, ...measuring, ...(focused ? [focused] : [])]);
    for (const id of ids) if (boxes[id] && (viewport === null || viewport && within(boxes[id]))) keep.add(id);
    return keep;
  }, [ids, boxes, pinned, revealed, measuring, viewport, focused, within]);
  const isOnscreen = (id: string) => pinned.has(id) || revealed.includes(id) || focused === id || viewport === null
    || !!viewport && !!boxes[id] && within(boxes[id]);
  const retained = useMemo(() => new Set([...pinned, ...revealed, ...(focused ? [focused] : [])]), [pinned, revealed, focused]);
  return { mounted, measuring, retained, viewport, isOnscreen, pending: missing.length > 0 };
}
