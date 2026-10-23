import type { Store } from './db.js';

export const retiredOrganizationsKey = 'retired-organizations';

/** Retirement is permanent; a later vote cannot restore the organization's effects. */
export async function retiredOrganizationIds(store: Pick<Store, 'db'>): Promise<Set<string>> {
  const value = await store.db.cachedSetting(retiredOrganizationsKey, async () => {
    const row = await store.db.prepare('SELECT value FROM settings WHERE key=$1').get(retiredOrganizationsKey);
    return row ? String(row.value) : '[]';
  });
  return new Set(JSON.parse(value) as string[]);
}
