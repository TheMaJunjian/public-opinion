import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { MIN_CARD_H } from '../utils/layout';

/** Keep one observer while positions change; observe only mounted/replaced cards. */
export function useCardMeasurements(
  canvas: RefObject<HTMLDivElement>,
  cards: RefObject<Record<string, HTMLDivElement | null>>,
) {
  const [heights, setHeights] = useState<Record<string, number>>({});
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef(new Set<Element>());
  const pending = useRef<Record<string, number>>({});
  const scheduled = useRef<number | null>(null);
  useLayoutEffect(() => {
    const instance = new ResizeObserver(entries => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const id = element.dataset.msgid;
        if (!id) continue;
        // offsetHeight is in canvas CSS pixels, independent of zoom transforms.
        const border = entry.borderBoxSize?.[0];
        const height = border?.blockSize ?? element.offsetHeight;
        pending.current[id] = Math.max(MIN_CARD_H, Math.ceil(height));
      }
      if (scheduled.current !== null) return;
      scheduled.current = requestAnimationFrame(() => {
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
      });
    });
    observer.current = instance;
    return () => {
      instance.disconnect();
      observer.current = null;
      observed.current.clear();
      if (scheduled.current !== null) cancelAnimationFrame(scheduled.current);
      scheduled.current = null;
      pending.current = {};
    };
  }, []);
  useLayoutEffect(() => {
    const instance = observer.current;
    if (!instance) return;
    const mounted = new Set(Object.values(cards.current ?? {}).filter((element): element is HTMLDivElement => !!element && !!canvas.current?.contains(element)));
    for (const element of observed.current) if (!mounted.has(element as HTMLDivElement)) {
      instance.unobserve(element); observed.current.delete(element);
    }
    for (const element of mounted) if (!observed.current.has(element)) {
      instance.observe(element); observed.current.add(element);
    }
  });
  return heights;
}
