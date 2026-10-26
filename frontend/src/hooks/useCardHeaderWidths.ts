import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { CARD_W } from '../utils/layout';

/** Measure intrinsic header content, never the assigned width (so cards can shrink again). */
export function useCardHeaderWidths(canvas: RefObject<HTMLDivElement>) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef(new Set<Element>());
  const measureRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const updates: Record<string, number> = {};
      for (const header of observed.current) {
        const element = header as HTMLElement;
        if (!canvas.current?.contains(element)) continue;
        const card = element.closest<HTMLElement>('[data-msgid]'), id = card?.dataset.msgid;
        if (!card || !id) continue;
        const style = getComputedStyle(card);
        const padding = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0')
          + parseFloat(style.borderLeftWidth || '0') + parseFloat(style.borderRightWidth || '0');
        const contents = element.matches('[data-card-header-content]') ? element : element.querySelector<HTMLElement>('[data-card-header-content]') ?? element;
        const contentStyle = getComputedStyle(contents);
        const natural = contentStyle.minWidth === '100%'
          ? Array.from(contents.children).reduce((width, child) => width + (child as HTMLElement).offsetWidth, 0)
            + Math.max(0, contents.children.length - 1) * (parseFloat(contentStyle.columnGap) || parseFloat(contentStyle.gap) || 0)
          : contents.scrollWidth;
        updates[id] = Math.max(CARD_W, updates[id] ?? 0, Math.ceil(natural + padding + 2));
      }
      setWidths(previous => {
        const entries = Object.entries(updates).filter(([id, width]) => Math.abs((previous[id] ?? CARD_W) - width) > 1);
        return entries.length ? { ...previous, ...Object.fromEntries(entries) } : previous;
      });
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(measure); };
    const instance = new ResizeObserver(schedule);
    observer.current = instance;
    measureRef.current = schedule;
    // Font loading can change intrinsic widths without changing the assigned card width.
    document.fonts?.addEventListener('loadingdone', schedule);
    return () => {
      instance.disconnect(); observer.current = null; observed.current.clear();
      if (frame !== null) cancelAnimationFrame(frame);
      document.fonts?.removeEventListener('loadingdone', schedule);
    };
  }, [canvas]);
  useLayoutEffect(() => {
    const mounted = new Set(canvas.current?.querySelectorAll('[data-card-header]') ?? []);
    for (const element of observed.current) if (!mounted.has(element)) { observer.current?.unobserve(element); observed.current.delete(element); }
    for (const element of mounted) if (!observed.current.has(element)) { observer.current?.observe(element); observed.current.add(element); }
    measureRef.current();
  });
  return widths;
}
