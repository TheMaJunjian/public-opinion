/** Browser-local diagnostics, bounded to the latest entry per phase. */
export function startWorkbenchTiming(phase: string) {
  const start = performance.now();
  let complete = false;
  return () => {
    if (complete) return;
    complete = true;
    const name = `workbench:${phase}`;
    // Older browsers/test environments may not implement User Timing Level 3.
    try {
      performance.clearMeasures(name);
      performance.measure(name, { start, end: performance.now() });
    } catch { /* Diagnostics must never interrupt navigation. */ }
  };
}
