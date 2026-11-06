import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Box } from '../utils/frameLayout';
import { useWorkbenchDrawingTask } from '../context/WorkbenchDrawingContext';
import { intersectsViewport, useCanvasViewport } from './useCanvasViewport';

export const REVEAL_VIRTUAL_MESSAGE = 'workbench:reveal-virtual-message';
export interface VirtualMessageRevealDetail {
  ids: string[];
  /** The frame scroll must commit before navigation can read target geometry. */
  positioningPending?: boolean;
}

/** Measure only the viewport, overscan and explicit targets; retain sizes after unmounting. */
export function useVirtualMessageMounts(ref: RefObject<HTMLElement>, ids: string[], boxes: Record<string, Box>,
  heights: Record<string, number>, pinned: ReadonlySet<string>, verticalOnly = false,
  revealGroups?: ReadonlyMap<string, ReadonlySet<string>>, resolveRevealIds?: (ids: string[], detail: VirtualMessageRevealDetail) => string[]) {
  const viewport = useCanvasViewport(ref);
  const [revealed, setRevealed] = useState<string[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const startMeasurement = useWorkbenchDrawingTask('measurement');
  const ticket = useRef<ReturnType<typeof startMeasurement> | null>(null);
  const missing = useMemo(() => ids.filter(id => heights[id] === undefined), [ids, heights]);
  const retained = useMemo(() => new Set([...pinned, ...revealed, ...(focused ? [focused] : [])]), [pinned, revealed, focused]);
  const previousGeometry = useRef({ ids, boxes, heights });
  useLayoutEffect(() => {
    const previous = previousGeometry.current;
    if (previous.boxes === boxes) return;
    previousGeometry.current = { ids, boxes, heights };
    const surface = ref.current;
    const host = surface?.closest<HTMLElement>('[data-workbench-left-panel]');
    if (!surface || !host || !host.scrollTop || revealed.length || previous.ids !== ids || previous.heights === heights) return;
    // Offscreen estimates become real sizes as the user scrolls. Keep the
    // current reading anchor still when newly measured rows above it expand.
    const rect = surface.getBoundingClientRect(), clip = host.getBoundingClientRect();
    const scale = surface.offsetHeight > 0 ? rect.height / surface.offsetHeight : 1;
    if (!scale) return;
    const top = (Math.max(clip.top, 0) - rect.top) / scale;
    const bottom = (Math.min(clip.bottom, window.innerHeight) - rect.top) / scale;
    let anchor: string | undefined, distance = Infinity;
    for (const id of ids) {
      const box = previous.boxes[id];
      if (!box || !boxes[id] || box.height <= 0 || box.y + box.height <= top || box.y >= bottom) continue;
      const nextDistance = Math.abs(box.y - top);
      if (nextDistance < distance) { distance = nextDistance; anchor = id; }
    }
    if (!anchor) return;
    const shift = (boxes[anchor].y - previous.boxes[anchor].y) * scale;
    if (Math.abs(shift) < 1) return;
    host.scrollTop += shift;
    host.dispatchEvent(new Event('scroll'));
  }, [ref, ids, boxes, heights, revealed]);
  const within = useCallback((box: Box) => box.width>0&&box.height>0&&(!viewport || intersectsViewport(verticalOnly ? { ...box, x: viewport.x, width: viewport.width } : box, viewport)), [viewport, verticalOnly]);
  const requiredMissing = useMemo(() => missing.filter(id => retained.has(id) || !boxes[id] || viewport === null
    || !!viewport && within(boxes[id])), [missing, retained, boxes, viewport, within]);
  useLayoutEffect(() => {
    if (!requiredMissing.length) { ticket.current?.complete(); ticket.current = null; return; }
    ticket.current ??= startMeasurement();
  }, [requiredMissing, startMeasurement]);
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
    const comparisonViewport = surface.closest('[data-comparison-viewport]');
    host.addEventListener(REVEAL_VIRTUAL_MESSAGE, reveal);
    // Review navigation reveals each pane independently, while ordinary
    // workbench navigation can still reveal both through their shared host.
    if (comparisonViewport && comparisonViewport !== host) comparisonViewport.addEventListener(REVEAL_VIRTUAL_MESSAGE, reveal);
    return () => {
      host.removeEventListener(REVEAL_VIRTUAL_MESSAGE, reveal);
      if (comparisonViewport && comparisonViewport !== host) comparisonViewport.removeEventListener(REVEAL_VIRTUAL_MESSAGE, reveal);
    };
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
  const mounted = useMemo(() => {
    const keep = new Set(retained);
    for (const id of ids) if (boxes[id] && (viewport === null || viewport && within(boxes[id]))) keep.add(id);
    return keep;
  }, [ids, boxes, retained, viewport, within]);
  const isOnscreen = (id: string) => pinned.has(id) || revealed.includes(id) || focused === id || viewport === null
    || !!viewport && !!boxes[id] && within(boxes[id]);
  return { mounted, retained, viewport, isOnscreen, pending: requiredMissing.length > 0 };
}
