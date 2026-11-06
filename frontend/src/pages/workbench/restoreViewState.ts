/** Create history closures outside the workbench render's lexical environment.
 * Otherwise a snapshot can keep that render's entire message model alive. */
export function restoreViewState(options: {
  values: Array<readonly [(value: any) => void, any]>;
  refs?: Array<readonly [{ current: any }, any]>;
  before?: () => void;
  filters?: { clear(): void; add(value: any): void; rules: any[] };
}) {
  const copy = (value: any) => Array.isArray(value) ? [...value] : value instanceof Set ? new Set(value) : value;
  return () => {
    options.before?.();
    for (const [ref, value] of options.refs ?? []) ref.current = copy(value);
    for (const [set, value] of options.values) set(copy(value));
    if (options.filters) { options.filters.clear(); options.filters.rules.forEach(rule => options.filters!.add({ ...rule })); }
  };
}
