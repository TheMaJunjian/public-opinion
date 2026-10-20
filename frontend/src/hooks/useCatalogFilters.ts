import { useEffect, useState } from 'react';
import type { CatalogClient } from '../data/catalogClient';
import type { CatalogFilterQuery, CatalogFilterResult } from '../data/catalogEngine';

/** Correlate results with both the full snapshot and the current rules. */
export function useCatalogFilters(client: CatalogClient | null, version: number, ready: boolean, query: CatalogFilterQuery) {
  const [attempt, retry] = useState(0);
  const key = JSON.stringify([version, query, attempt]);
  const active = query.rules.length > 0 || query.home !== null;
  const [result, setResult] = useState<{ key: string; value?: CatalogFilterResult; error?: string } | null>(null);
  useEffect(() => {
    if (!client || !active) return;
    client.prioritize();
    if (!ready) return;
    let cancelled = false;
    void client.filters(query).then(value => { if (!cancelled) setResult({ key, value }); })
      .catch(error => { if (!cancelled) setResult({ key, error: error instanceof Error ? error.message : String(error) }); });
    return () => { cancelled = true; };
  }, [client, key, active, ready]);
  return { pending: active && (!ready || result?.key !== key || !result.value), result: result?.key === key ? result.value : null,
    error: result?.key === key ? result.error : undefined, retry: () => retry(value => value + 1) };
}
