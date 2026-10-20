import { useLayoutEffect, useState, type RefObject } from 'react';
import type { Box } from '../utils/frameLayout';

export function intersectsViewport(box: Box, viewport: Box | null | undefined, padding = 0) {
  return !viewport || (box.x + box.width >= viewport.x - padding && box.x <= viewport.x + viewport.width + padding
    && box.y + box.height >= viewport.y - padding && box.y <= viewport.y + viewport.height + padding);
}

/** Read scroll/clipping geometry once per frame, in the canvas's unscaled coordinates. */
export function useCanvasViewport(ref: RefObject<HTMLElement>, overscan = 500) {
  const [viewport, setViewport] = useState<Box | null>();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      if (!rect.width && !rect.height) { setViewport(previous => previous === null ? previous : null); return; }
      const visual = window.visualViewport;
      let left = visual?.offsetLeft ?? 0, top = visual?.offsetTop ?? 0;
      let right = left + (visual?.width ?? window.innerWidth), bottom = top + (visual?.height ?? window.innerHeight);
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        if (!bounds.width || !bounds.height) continue;
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX || style.overflow)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY || style.overflow)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      }
      const scaleX = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
      const scaleY = element.offsetHeight > 0 ? rect.height / element.offsetHeight : scaleX;
      const next = { x: (left - rect.left - overscan) / scaleX, y: (top - rect.top - overscan) / scaleY,
        width: Math.max(0, right - left + 2 * overscan) / scaleX, height: Math.max(0, bottom - top + 2 * overscan) / scaleY };
      setViewport(previous => previous && Object.keys(next).every(key => Math.abs(previous[key as keyof Box] - next[key as keyof Box]) < 1) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    update();
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [ref, overscan]);
  return viewport;
}
