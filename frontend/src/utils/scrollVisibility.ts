/** Reveal a target with the least movement; oversized targets expose their beginning. */
export function nearestScrollDelta(start: number, end: number, viewportStart: number, viewportEnd: number): number {
  const available = viewportEnd - viewportStart;
  if (available <= 0) return 0;
  if (end - start > available) {
    if (start < viewportStart || start >= viewportEnd) return start - viewportStart;
    // Keep a visible heading in place, but expose enough of the beginning to read it.
    return Math.max(0, start + Math.min(80, available) - viewportEnd);
  }
  if (start < viewportStart) return start - viewportStart;
  return Math.max(0, end - viewportEnd);
}
