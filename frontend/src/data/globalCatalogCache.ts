import type { CatalogCache, CatalogCheckpoint } from './globalCatalog';

/** Page records and their continuation are one atomic IndexedDB value. */
export function createGlobalCatalogCache(key: string): CatalogCache {
  const valid = (value: unknown): value is CatalogCheckpoint => {
    if (!value || typeof value !== 'object') return false;
    const c = value as CatalogCheckpoint;
    return typeof c.snapshot?.regionId === 'string' && !!c.snapshot.regionId && !c.snapshot.windowed
      && typeof c.snapshot.scope?.title === 'string' && Number.isSafeInteger(c.snapshot.sequence) && c.snapshot.sequence >= c.after
      && Array.isArray(c.snapshot.messages) && c.snapshot.messages.every(message => typeof message?.id === 'string' && typeof message.createdBy?.id === 'string')
      && Array.isArray(c.snapshot.relations) && c.snapshot.relations.every(relation => typeof relation?.id === 'string' && typeof relation.createdBy?.id === 'string')
      && Array.isArray(c.snapshot.users) && c.snapshot.users.every(user => typeof user?.id === 'string')
      && [c.snapshot.stakes, c.snapshot.tagCounts, c.snapshot.attentionUsers].every(map => !!map && typeof map === 'object' && !Array.isArray(map))
      && Number.isSafeInteger(c.boundary) && c.boundary >= 0 && Number.isSafeInteger(c.after) && c.after >= c.boundary
      && (c.nextCursor === null || typeof c.nextCursor === 'string')
      && (c.phase === 'pages' || c.phase === 'changes') && typeof c.complete === 'boolean'
      && Number.isSafeInteger(c.pages) && c.pages > 0
      && (!c.complete || (c.phase === 'changes' && c.nextCursor === null));
  };
  const transaction = <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => () => T) => new Promise<T>((resolve, reject) => {
    const opening = indexedDB.open('gonglun-global-catalog', 1);
    let blocked = false;
    opening.onupgradeneeded = () => opening.result.createObjectStore('catalogs');
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => { blocked = true; reject(new Error('缓存暂时不可用')); };
    opening.onsuccess = () => {
      const db = opening.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      const tx = db.transaction('catalogs', mode);
      const result = run(tx.objectStore('catalogs'));
      tx.oncomplete = () => { db.close(); resolve(result()); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
  return {
    async load() {
      try {
        const value = await transaction('readonly', store => { const read = store.get(key); return () => read.result as unknown; });
        return valid(value) ? value : null;
      } catch { return null; }
    },
    async save(value) {
      if (!valid(value)) return;
      try {
        await transaction('readwrite', store => {
          const read = store.get(key);
          read.onsuccess = () => {
            const old = read.result as unknown;
            if (valid(old) && old.snapshot.regionId === value.snapshot.regionId
              && (old.boundary > value.boundary || (old.boundary === value.boundary
                && (old.pages > value.pages || old.after > value.after || (old.complete && !value.complete && old.after === value.after))))) return;
            store.put(value, key);
          };
          return () => undefined;
        });
      } catch { /* Storage failure does not prevent live global calculations. */ }
    },
    async clear() {
      try { await transaction('readwrite', store => { store.delete(key); return () => undefined; }); }
      catch { /* A later successful sync will replace an obsolete checkpoint. */ }
    },
  };
}
