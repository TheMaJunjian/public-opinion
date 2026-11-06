import type { WorkbenchSnapshot } from '@gonglun/core';
import { WorkbenchStore } from './workbench';
import type { CatalogCache, CatalogCheckpoint, CatalogPosition } from './globalCatalog';

interface Head { token: string; position: CatalogPosition; chunks: number }
interface Chunk { snapshot: WorkbenchSnapshot; baseline?: number }
const stores = ['catalogs', 'heads', 'pages'];
const validSnapshot = (s: WorkbenchSnapshot) => !!s && typeof s.regionId === 'string' && !!s.regionId && !s.windowed
  && typeof s.scope?.title === 'string' && Number.isSafeInteger(s.sequence) && s.sequence >= 0
  && Array.isArray(s.messages) && s.messages.every(m => typeof m?.id === 'string' && typeof m.createdBy?.id === 'string')
  && Array.isArray(s.relations) && s.relations.every(r => typeof r?.id === 'string' && typeof r.createdBy?.id === 'string')
  && Array.isArray(s.users) && s.users.every(u => typeof u?.id === 'string')
  && [s.stakes, s.tagCounts, s.attentionUsers].every(map => !!map && typeof map === 'object' && !Array.isArray(map));
const validPosition = (p: CatalogPosition) => !!p && typeof p.regionId === 'string' && !!p.regionId
  && Number.isSafeInteger(p.boundary) && p.boundary >= 0 && Number.isSafeInteger(p.after) && p.after >= p.boundary
  && Number.isSafeInteger(p.sequence) && p.sequence >= p.after
  && (p.nextCursor === null || typeof p.nextCursor === 'string') && (p.phase === 'pages' || p.phase === 'changes')
  && typeof p.complete === 'boolean' && Number.isSafeInteger(p.pages) && p.pages > 0
  && (!p.complete || (p.phase === 'changes' && p.nextCursor === null));
const positionOf = ({ snapshot, ...position }: CatalogCheckpoint): CatalogPosition => ({ ...position, regionId: snapshot.regionId!, sequence: snapshot.sequence });
const validCheckpoint = (c: CatalogCheckpoint) => !!c && validSnapshot(c.snapshot) && validPosition(positionOf(c));
const validHead = (h: Head) => !!h && typeof h.token === 'string' && validPosition(h.position) && Number.isSafeInteger(h.chunks) && h.chunks > 0;
const ahead = (old: CatalogPosition, next: CatalogPosition) => old.regionId === next.regionId
  && (old.boundary > next.boundary || (old.boundary === next.boundary
    && (old.pages > next.pages || old.after > next.after || (old.complete && !next.complete && old.after === next.after))));

/** A small head and append-only pages commit together; no growing snapshot is cloned per page. */
export function createGlobalCatalogCache(key: string): CatalogCache {
  let token: string | null | undefined;
  let superseded = false;
  const range = () => IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]);
  const transaction = <T>(mode: IDBTransactionMode, run: (tx: IDBTransaction) => () => T) => new Promise<T>((resolve, reject) => {
    // v1 writers must stop instead of overwriting the journal with an obsolete full snapshot.
    const opening = indexedDB.open('gonglun-global-catalog', 2);
    let blocked = false;
    opening.onupgradeneeded = () => {
      for (const name of stores) if (!opening.result.objectStoreNames.contains(name)) opening.result.createObjectStore(name);
    };
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => { blocked = true; reject(new Error('缓存暂时不可用')); };
    opening.onsuccess = () => {
      const db = opening.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      const tx = db.transaction(stores, mode);
      let result: () => T;
      try { result = run(tx); } catch (error) { tx.abort(); db.close(); reject(error); return; }
      tx.oncomplete = () => { db.close(); resolve(result()); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
  const write = async (position: CatalogPosition, snapshot: WorkbenchSnapshot, replace: boolean) => {
    if (superseded) return;
    const nextToken = crypto.randomUUID();
    const written = await transaction('readwrite', tx => {
      const heads = tx.objectStore('heads'), pages = tx.objectStore('pages');
      const read = heads.get(key);
      let accepted = false;
      read.onsuccess = () => {
        const old = validHead(read.result) ? read.result as Head : undefined;
        // A different tab may have reset or advanced this catalog since our read.
        // Never attach a page to another tab's continuation, even at the same cursor.
        if (token !== undefined && (old?.token ?? null) !== token) {
          superseded = true; return;
        }
        if (old && ahead(old.position, position)) return;
        if (!replace && old && old.position.regionId !== position.regionId) { superseded = true; return; }
        if (replace) pages.delete(range());
        const offset = replace ? 0 : old?.chunks ?? 0;
        pages.put({ snapshot, ...(replace ? { baseline: position.complete ? position.after : 0 } : {}) } satisfies Chunk, [key, offset]);
        heads.put({ token: nextToken, position, chunks: offset + 1 } satisfies Head, key);
        tx.objectStore('catalogs').delete(key);
        accepted = true;
      };
      return () => accepted;
    });
    if (written) token = nextToken;
  };
  const cache: CatalogCache = {
    async load() {
      try {
        const result = await transaction('readonly', tx => {
          const head = tx.objectStore('heads').get(key), pages = tx.objectStore('pages').getAll(range());
          const legacy = tx.objectStore('catalogs').get(key);
          return () => ({ head: head.result as Head, chunks: pages.result as Chunk[], legacy: legacy.result as CatalogCheckpoint });
        });
        superseded = false; token = validHead(result.head) ? result.head.token : null;
        if (!validHead(result.head)) {
          if (!validCheckpoint(result.legacy)) return null;
          await cache.save(result.legacy); // One-time atomic conversion of a v1 checkpoint.
          return result.legacy;
        }
        if (result.chunks.length !== result.head.chunks) { await cache.clear(); return null; }
        const store = new WorkbenchStore();
        for (const chunk of result.chunks) {
          if (!validSnapshot(chunk.snapshot) || chunk.snapshot.regionId !== result.head.position.regionId) { await cache.clear(); return null; }
          if (chunk.baseline !== undefined) store.apply({ ...chunk.snapshot, sequence: chunk.baseline }, true);
          store.apply(chunk.snapshot);
        }
        const { regionId: _region, sequence: _sequence, ...position } = result.head.position;
        const value = { ...position, snapshot: store.snapshot() };
        if (!validCheckpoint(value) || store.sequence !== result.head.position.sequence) { await cache.clear(); return null; }
        // Repeated short sessions must not leave an indefinitely growing change journal.
        if (value.complete && result.head.chunks >= 64) await cache.save(value);
        return value;
      } catch { superseded = true; return null; }
    },
    async save(value) {
      if (!validCheckpoint(value)) return;
      try { await write(positionOf(value), value.snapshot, true); }
      catch { superseded = true; /* Cache failure must not block live calculations. */ }
    },
    async append(position, page) {
      if (!validPosition(position) || !validSnapshot(page) || page.regionId !== position.regionId) { superseded = true; return; }
      try { await write(position, page, false); }
      catch { superseded = true; /* An unsaved page must never be skipped by a later saved cursor. */ }
    },
    async clear() {
      try {
        await transaction('readwrite', tx => {
          const heads = tx.objectStore('heads'), read = heads.get(key);
          read.onsuccess = () => {
            if (token !== undefined && (read.result?.token ?? null) !== token) { superseded = true; return; }
            heads.delete(key); tx.objectStore('pages').delete(range()); tx.objectStore('catalogs').delete(key);
            token = null; superseded = false;
          };
          return () => undefined;
        });
      } catch { superseded = true; }
    },
  };
  return cache;
}
