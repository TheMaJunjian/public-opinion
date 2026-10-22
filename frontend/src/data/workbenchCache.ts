import type { WorkbenchSnapshot } from '@gonglun/core';

export interface WorkbenchCache {
  load(): Promise<WorkbenchSnapshot | null>;
  save(snapshot: WorkbenchSnapshot): Promise<void>;
  clear(): Promise<void>;
}

const DATABASE_NAME = 'gonglun-workbench';
const STORE_NAME = 'snapshots';

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const opening = indexedDB.open(DATABASE_NAME, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE_NAME);
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => { blocked = true; reject(new Error('消息缓存暂时不可用')); };
    opening.onsuccess = () => {
      const database = opening.result;
      if (blocked) { database.close(); return; }
      database.onversionchange = () => database.close();
      try {
        const transaction = database.transaction(STORE_NAME, mode);
        const result = run(transaction.objectStore(STORE_NAME));
        transaction.oncomplete = () => { database.close(); resolve(result()); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
      } catch (error) { database.close(); reject(error); }
    };
  });
}

function isSnapshot(value: unknown, parent: string): value is WorkbenchSnapshot {
  if (!value || typeof value !== 'object') return false;
  const page = value as WorkbenchSnapshot;
  return typeof page.regionId === 'string' && page.regionId.length > 0
    && Number.isSafeInteger(page.sequence) && page.sequence >= 0
    && !!page.scope && (page.scope.messageId ?? 'root') === parent && typeof page.scope.title === 'string'
    && (page.nextCursor === undefined || page.nextCursor === null || typeof page.nextCursor === 'string') && !page.hasMore
    && Array.isArray(page.messages) && page.messages.every(message => typeof message?.id === 'string' && typeof message.createdBy?.id === 'string')
    && Array.isArray(page.relations) && page.relations.every(relation => typeof relation?.id === 'string' && typeof relation.createdBy?.id === 'string')
    && Array.isArray(page.users) && page.users.every(user => typeof user?.id === 'string')
    && [page.stakes, page.tagCounts, page.attentionUsers].every(map => !!map && typeof map === 'object' && !Array.isArray(map));
}

/** Persist only loaded pages, their continuation cursors, and the confirmed sync cursor. */
export function createWorkbenchCache(userId: string, parent: string, apiUrl = import.meta.env.VITE_API_BASE_URL || '/api'): WorkbenchCache {
  // Rebuild snapshots after returning correction effects to the viewing flow.
  const key = JSON.stringify([4, new URL(apiUrl.replace(/\/$/, ''), location.href).href, userId, parent]);
  return {
    async load() {
      try {
        const value = await withStore('readonly', store => {
          const request = store.get(key);
          return () => request.result as unknown;
        });
        return isSnapshot(value, parent) ? value : null;
      } catch { return null; } // Storage may be disabled; network loading still works.
    },
    async save(snapshot) {
      if (!isSnapshot(snapshot, parent)) return;
      try {
        await withStore('readwrite', store => {
          const request = store.get(key);
          request.onsuccess = () => {
            const previous = request.result as unknown;
            // A slow tab must not overwrite a later confirmed snapshot.
            if (isSnapshot(previous, parent) && previous.regionId === snapshot.regionId && previous.sequence > snapshot.sequence) return;
            store.put(snapshot, key);
          };
          return () => undefined;
        });
      } catch { /* Quota failures must not interrupt synchronization. */ }
    },
    async clear() {
      try { await withStore('readwrite', store => { store.delete(key); return () => undefined; }); }
      catch { /* An unavailable cache will be ignored on the next load. */ }
    },
  };
}
