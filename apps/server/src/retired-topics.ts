import type { Store } from './db.js';

export const retiredTopicsKey = 'retired-legacy-topics';

/** Retirement is permanent; a later vote cannot restore a migration-only container. */
export async function retiredTopicIds(store: Pick<Store, 'db'>): Promise<Set<string>> {
  const value = await store.db.cachedSetting(retiredTopicsKey, async () => {
    const row = await store.db.prepare('SELECT value FROM settings WHERE key=$1').get(retiredTopicsKey);
    return row ? String(row.value) : '[]';
  });
  return new Set(JSON.parse(value) as string[]);
}
