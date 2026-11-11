/** Small LRU scoped to one immutable source and viewing identity. */
export function createScopedProjectionCache<T>() {
  let source: unknown, identity: unknown;
  const entries = new Map<string, { value: T; bytes: number }>();
  let bytes = 0;
  return {
    select(nextSource: unknown, nextIdentity: unknown) {
      if (source !== nextSource || identity !== nextIdentity) { source = nextSource; identity = nextIdentity; entries.clear(); bytes = 0; }
    },
    get(key: string) {
      const entry = entries.get(key);
      if (entry) { entries.delete(key); entries.set(key, entry); }
      return entry?.value;
    },
    isCurrent(nextSource: unknown, nextIdentity: unknown) { return source === nextSource && identity === nextIdentity; },
    *entries() { for (const [key, entry] of entries) yield [key, entry.value, entry.bytes] as const; },
    put(key: string, value: T, weight: number, capacity: number) {
      const previous = entries.get(key); if (previous) { bytes -= previous.bytes; entries.delete(key); }
      if (weight > 32 * 1024 * 1024) return;
      entries.set(key, { value, bytes: weight }); bytes += weight;
      while (entries.size > Math.max(1, capacity) || bytes > 32 * 1024 * 1024) {
        const oldest = entries.keys().next().value!; bytes -= entries.get(oldest)!.bytes; entries.delete(oldest);
      }
    },
    get size() { return entries.size; },
  };
}
