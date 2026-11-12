/** Bounded, browser-local timings; no credentials or content are recorded. */
export function startEntryTiming(phase: 'session' | 'login' | 'feed-request' | 'feed-ready') {
  const start = performance.now();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    try {
      const name = `entry:${phase}`;
      performance.clearMeasures(name);
      performance.measure(name, { start, end: performance.now() });
    } catch { /* Timing must not affect login or reading. */ }
  };
}
