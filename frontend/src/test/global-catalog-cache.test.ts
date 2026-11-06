import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGlobalCatalogCache } from '../data/globalCatalogCache';
import type { CatalogCheckpoint, CatalogPosition } from '../data/globalCatalog';
import type { WorkbenchSnapshot } from '@gonglun/core';

const checkpoint = (after = 10, pages = 1): CatalogCheckpoint => ({ boundary: 10, after, pages, phase: 'pages', complete: false, nextCursor: `page-${pages + 1}`,
  snapshot: { regionId: 'region', sequence: after, scope: { messageId: null, title: '公论' }, messages: [], relations: [], users: [], stakes: {}, tagCounts: {}, attentionUsers: {} } });
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('atomically restores incomplete records and cursor, isolates accounts/scopes, and rejects slower tab progress', async () => {
  const cache = createGlobalCatalogCache('api/user/root');
  await cache.save(checkpoint(10, 3));
  await cache.save(checkpoint(10, 1));
  expect(await createGlobalCatalogCache('api/user/root').load()).toMatchObject({ pages: 3, nextCursor: 'page-4', complete: false });
  expect(await createGlobalCatalogCache('api/other/root').load()).toBeNull();
  expect(await createGlobalCatalogCache('api/user/child').load()).toBeNull();
  const complete = { ...checkpoint(15, 3), phase: 'changes' as const, complete: true, nextCursor: null };
  await cache.save(complete);
  await cache.save(checkpoint(11, 3));
  expect(await cache.load()).toEqual(complete);
  await cache.clear(); expect(await cache.load()).toBeNull();
});

it('never accepts a visible window as a complete global catalog, and tolerates disabled storage', async () => {
  const cache = createGlobalCatalogCache('scope');
  const value = checkpoint(); value.snapshot.windowed = true;
  await cache.save(value); expect(await cache.load()).toBeNull();
  vi.stubGlobal('indexedDB', undefined);
  await expect(cache.save(checkpoint())).resolves.toBeUndefined();
  await expect(cache.load()).resolves.toBeNull();
  await expect(cache.clear()).resolves.toBeUndefined();
});

const user = { id: 'u', username: '用户', createdAt: '' };
const message = (id: string, revision = 1) => ({ id, revision, kind: 'TEXT', contentType: 'TEXT' as const, content: `${id}-${revision}`, createdBy: user, createdAt: '' });
const page = (sequence: number, messages: WorkbenchSnapshot['messages'] = []): WorkbenchSnapshot => ({ ...checkpoint().snapshot, sequence, messages });
const position = (pages: number, sequence = 10, after = 10, complete = false): CatalogPosition => ({ boundary: 10, after, pages,
  phase: complete ? 'changes' : 'pages', complete, nextCursor: complete ? null : `page-${pages + 1}`, regionId: 'region', sequence });

it('writes only each received page and restores revisions, removals and statistics with the same replay cursor', async () => {
  const put = vi.spyOn(IDBObjectStore.prototype, 'put');
  const cache = createGlobalCatalogCache('journal');
  expect(await cache.load()).toBeNull();
  await cache.append!(position(1), page(10, [message('first')]));
  await cache.append!(position(2, 15), { ...page(15, [message('first', 2), message('removed')]), tagCounts: { first: { RECOMMEND: 9 } } });
  await cache.append!(position(2, 15, 11), { ...page(11, [message('first')]), tagCounts: { first: { RECOMMEND: 1 } } });
  await cache.append!(position(2, 16, 16, true), { ...page(16), removedMessageIds: ['removed'] });
  expect(await createGlobalCatalogCache('journal').load()).toMatchObject({ boundary: 10, after: 16, pages: 2, complete: true,
    snapshot: { messages: [message('first', 2)], tagCounts: { first: { RECOMMEND: 9 } } } });
  const chunks = put.mock.calls.map(([value]) => value as { snapshot?: WorkbenchSnapshot }).filter(value => value.snapshot);
  expect(chunks.map(value => value.snapshot!.messages.length)).toEqual([1, 2, 1, 0]);
});

it('rejects another tab\'s divergent continuation and prevents its later writes or invalidation from erasing the winner', async () => {
  const first = createGlobalCatalogCache('shared');
  await first.append!(position(1), page(10, [message('base')]));
  const second = createGlobalCatalogCache('shared');
  await second.load();
  await first.append!(position(2, 11), page(11, [message('winner')]));
  await second.append!(position(2, 12), page(12, [message('other-branch')]));
  await second.append!(position(3, 13), page(13, [message('missing-predecessor')]));
  await second.clear();
  const saved = await createGlobalCatalogCache('shared').load();
  expect(saved?.snapshot.messages.map(m => m.id)).toEqual(['base', 'winner']);
  expect(saved).toMatchObject({ pages: 2, nextCursor: 'page-3' });
});

it('keeps the previous checkpoint after a failed transaction and never saves a cursor beyond the missing page', async () => {
  const cache = createGlobalCatalogCache('quota');
  await cache.append!(position(1), page(10, [message('base')]));
  const original = IDBObjectStore.prototype.put;
  const fail = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'pages') this.transaction.abort();
    return original.apply(this, args);
  });
  await cache.append!(position(2, 11), page(11, [message('failed')]));
  fail.mockRestore();
  await cache.append!(position(3, 12, 12, true), page(12, [message('later')]));
  expect(await createGlobalCatalogCache('quota').load()).toMatchObject({ pages: 1, nextCursor: 'page-2', complete: false,
    snapshot: { messages: [message('base')] } });
});

it('converts a v1 cache once without losing its pagination boundary or local records', async () => {
  const old = { ...checkpoint(12, 3), snapshot: page(12, [message('cached')]) };
  await new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open('gonglun-global-catalog', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('catalogs');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result, tx = db.transaction('catalogs', 'readwrite');
      tx.objectStore('catalogs').put(old, 'legacy');
      tx.oncomplete = () => { db.close(); resolve(); };
    };
  });
  const cache = createGlobalCatalogCache('legacy');
  expect(await cache.load()).toEqual(old);
  await cache.append!({ ...position(4, 13), after: 12 }, page(13, [message('next')]));
  expect(await createGlobalCatalogCache('legacy').load()).toMatchObject({ boundary: 10, after: 12, pages: 4,
    snapshot: { messages: [message('cached'), message('next')] } });
});

it('compacts complete journals across short sessions and preserves tombstones against older replay pages', async () => {
  const cache = createGlobalCatalogCache('compact');
  const complete = { ...checkpoint(10), complete: true, phase: 'changes' as const, nextCursor: null, snapshot: page(10, [message('kept')]) };
  await cache.save(complete);
  for (let n = 1; n <= 64; n++) await cache.append!(position(1, 10 + n, 10 + n, true), page(10 + n));
  const put = vi.spyOn(IDBObjectStore.prototype, 'put');
  const restored = createGlobalCatalogCache('compact');
  expect(await restored.load()).toMatchObject({ after: 74, snapshot: { messages: [message('kept')] } });
  expect(put.mock.calls.filter(([value]) => (value as { snapshot?: unknown }).snapshot)).toHaveLength(1);
  await restored.append!(position(1, 74, 74, true), page(20, [message('obsolete')]));
  expect((await restored.load())?.snapshot.messages.map(m => m.id)).toEqual(['kept']);
});
