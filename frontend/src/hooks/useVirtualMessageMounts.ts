import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Box } from '../utils/frameLayout';
import { useWorkbenchDrawingTask } from '../context/WorkbenchDrawingContext';
import { intersectsViewport, useCanvasViewport } from './useCanvasViewport';

export const MESSAGE_MEASUREMENT_BATCH = 32;
export const REVEAL_VIRTUAL_MESSAGE = 'workbench:reveal-virtual-message';

/** Measure new records in bounded batches; keep their cached geometry after unmounting. */
export function useVirtualMessageMounts(ref: RefObject<HTMLElement>, ids: string[], boxes: Record<string, Box>,
  heights: Record<string, number>, pinned: ReadonlySet<string>, verticalOnly = false) {
  const viewport = useCanvasViewport(ref);
  const [batch, setBatch] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<string[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const startMeasurement = useWorkbenchDrawingTask('measurement');
  const ticket = useRef<ReturnType<typeof startMeasurement> | null>(null);
  const missing = useMemo(() => ids.filter(id => heights[id] === undefined), [ids, heights]);
  const measuring = useMemo(() => new Set(batch.filter(id => heights[id] === undefined)), [batch, heights]);
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
      const detail = (event as CustomEvent<{ ids: string[] }>).detail;
      if (!detail?.ids) return;
      setRevealed(previous => previous.length === detail.ids.length && previous.every((id, index) => id === detail.ids[index]) ? previous : detail.ids);
    };
    const host = surface.closest('[data-workbench-left-panel]') ?? surface;
    host.addEventListener(REVEAL_VIRTUAL_MESSAGE, reveal);
    return () => host.removeEventListener(REVEAL_VIRTUAL_MESSAGE, reveal);
  }, [ref, ids]);
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
  const within = useCallback((box: Box) => !viewport || intersectsViewport(verticalOnly ? { ...box, x: viewport.x, width: viewport.width } : box, viewport), [viewport, verticalOnly]);
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
