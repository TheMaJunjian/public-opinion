import type { ExportData } from '../api/client';

const LAST_EXPORT_KEY = 'lastExportData';
const DATABASE_NAME = 'gonglun-export-viewer';
const STORE_NAME = 'archives';
type CachedArchive = { archiveId: string; data: ExportData };
let currentArchive: CachedArchive | null = null;

/** Keep large archives in IndexedDB, with a per-tab reference and an in-memory fallback. */
function withArchiveStore<T>(mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const opening = indexedDB.open(DATABASE_NAME, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE_NAME);
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => { blocked = true; reject(new Error('阅览缓存暂时不可用')); };
    opening.onsuccess = () => {
      const database = opening.result;
      if (blocked) { database.close(); return; }
      try {
        const transaction = database.transaction(STORE_NAME, mode);
        const result = request(transaction.objectStore(STORE_NAME));
        transaction.oncomplete = () => { database.close(); resolve(result.result); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
      } catch (error) { database.close(); reject(error); }
    };
  });
}

export async function saveLastExport(data: ExportData): Promise<void> {
  const entry = { archiveId: crypto.randomUUID(), data };
  currentArchive = entry;
  let previousId: string | undefined;
  // Replace the old reference before attempting a write. A quota failure must
  // never leave an earlier file masquerading as the most recent archive.
  try {
    const raw = sessionStorage.getItem(LAST_EXPORT_KEY);
    try { previousId = raw ? JSON.parse(raw)?.archiveId : undefined; } catch { /* Replace invalid caches as well. */ }
    sessionStorage.setItem(LAST_EXPORT_KEY, JSON.stringify({ archiveId: entry.archiveId }));
  }
  catch {
    try { sessionStorage.removeItem(LAST_EXPORT_KEY); } catch { /* Storage may be disabled entirely. */ }
  }
  try {
    await withArchiveStore('readwrite', store => {
      if (previousId) store.delete(previousId);
      return store.put(entry, entry.archiveId);
    });
  } catch {
    // Some standalone/offline browsers do not expose IndexedDB.
    try { sessionStorage.setItem(LAST_EXPORT_KEY, JSON.stringify(data)); }
    catch { /* Keep the latest archive in memory instead of reopening stale data. */ }
  }
}

export async function loadLastExport(): Promise<unknown | null> {
  // A new route must receive a fresh object even when persistent storage fails.
  if (currentArchive) return structuredClone(currentArchive.data);
  try {
    const raw = sessionStorage.getItem(LAST_EXPORT_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (typeof cached?.archiveId !== 'string') return cached;
    const entry = await withArchiveStore<CachedArchive | undefined>('readonly', store => store.get(cached.archiveId));
    return entry && entry.archiveId === cached.archiveId ? entry.data : null;
  } catch { return null; }
}
