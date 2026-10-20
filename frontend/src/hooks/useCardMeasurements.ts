import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { MIN_CARD_H } from '../utils/layout';
import { useWorkbenchDrawingTask } from '../context/WorkbenchDrawingContext';

function measuredHeight(element: HTMLElement, height: number): number {
  const configured = Number(element.dataset.measureMinHeight);
  const minimum = Number.isFinite(configured) && configured > 0 ? configured : MIN_CARD_H;
  return Math.max(minimum, Number.isFinite(height) ? Math.ceil(height) : minimum);
}

/** Keep one observer while positions change; observe only mounted/replaced cards. */
export function useCardMeasurements(
  canvas: RefObject<HTMLDivElement>,
  cards: RefObject<Record<string, HTMLDivElement | null>>,
) {
  const startMeasurement = useWorkbenchDrawingTask('measurement');
  const [heights, setHeights] = useState<Record<string, number>>({});
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef(new Set<Element>());
  const pending = useRef<Record<string, number>>({});
  const scheduled = useRef<number | null>(null);
  const measurement = useRef<ReturnType<typeof startMeasurement> | null>(null);
  useLayoutEffect(() => {
    const measure = (entries: ResizeObserverEntry[]) => {
      const task = measurement.current ?? startMeasurement();
      if (!measurement.current) {
        measurement.current = task;
        task.onCancel(() => {
          if (scheduled.current !== null) cancelAnimationFrame(scheduled.current);
          scheduled.current = null;
          measurement.current = null;
          pending.current = {};
        });
      }
      task.run(() => {
        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          const id = element.dataset.msgid;
          if (!id) continue;
          // offsetHeight is in canvas CSS pixels, independent of zoom transforms.
          const height = entry.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight;
          pending.current[id] = measuredHeight(element, height);
        }
        if (scheduled.current !== null) return;
        scheduled.current = requestAnimationFrame(() => {
          task.run(() => {
            scheduled.current = null;
            const updates = pending.current;
            pending.current = {};
            setHeights(previous => {
              let changed = false;
              const next = { ...previous };
              for (const [id, height] of Object.entries(updates)) {
                if (Math.abs((previous[id] ?? 0) - height) > 1) { next[id] = height; changed = true; }
              }
              return changed ? next : previous;
            });
            task.complete();
            measurement.current = null;
          });
        });
      });
    };
    const instance = new ResizeObserver(measure);
    observer.current = instance;
    return () => {
      instance.disconnect();
      observer.current = null;
      observed.current.clear();
      if (scheduled.current !== null) cancelAnimationFrame(scheduled.current);
      scheduled.current = null;
      measurement.current?.cancel();
      measurement.current = null;
      pending.current = {};
    };
  }, [startMeasurement]);
  useLayoutEffect(() => {
    const instance = observer.current;
    if (!instance) return;
    const mounted = new Set(Object.values(cards.current ?? {}).filter((element): element is HTMLDivElement => !!element && !!canvas.current?.contains(element)));
    for (const element of observed.current) if (!mounted.has(element as HTMLDivElement)) {
      instance.unobserve(element); observed.current.delete(element);
    }
    const added: HTMLElement[] = [];
    for (const element of mounted) if (!observed.current.has(element)) {
      instance.observe(element); observed.current.add(element);
      added.push(element as HTMLElement);
    }
    // Initial measurements are explicit; readiness never depends on when the
    // browser happens to deliver the first ResizeObserver notification.
    if (added.length) {
      const task = startMeasurement();
      task.run(() => {
        setHeights(previous => {
          const next = { ...previous };
          for (const element of added) if (element.dataset.msgid) {
            next[element.dataset.msgid] = measuredHeight(element, element.offsetHeight);
          }
          return next;
        });
        task.complete();
      });
    }
  });
  return heights;
}
