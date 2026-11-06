import { useEffect, useState } from 'react';
import type { CatalogClient } from '../data/catalogClient';
import type { CatalogFilterQuery, CatalogFilterResult } from '../data/catalogEngine';

/** Correlate results with both the full snapshot and the current rules. */
export function useCatalogFilters(client: CatalogClient | null, version: number, ready: boolean, query: CatalogFilterQuery) {
  const [attempt, retry] = useState(0);
  const queryKey = JSON.stringify([query, attempt]);
  const key = JSON.stringify([version, query, attempt]);
  const active = query.rules.length > 0 || query.home !== null;
  const [result, setResult] = useState<{ client: CatalogClient; key: string; queryKey: string; value?: CatalogFilterResult; error?: string } | null>(null);
  useEffect(() => {
    if (!client || !active) return;
    client.prioritize();
    if (!ready) return;
    let cancelled = false;
    void client.filters(query).then(value => { if (!cancelled) setResult({ client, key, queryKey, value }); })
      .catch(error => { if (!cancelled) setResult(previous => ({ client, key, queryKey,
        value: previous?.client === client && previous.queryKey === queryKey ? previous.value : undefined,
        error: error instanceof Error ? error.message : String(error) })); });
    return () => { cancelled = true; };
  }, [client, key, queryKey, active, ready]);
  // New filters need a foreground wait. A synchronized snapshot refreshes the
  // same filters behind the already usable view instead of blanking it again.
  const current = result?.client === client && result?.queryKey === queryKey ? result : null;
  return { pending: active && (!ready || !current?.value), result: current?.value ?? null,
    error: current?.key === key ? current.error : undefined, retry: () => retry(value => value + 1) };
}
