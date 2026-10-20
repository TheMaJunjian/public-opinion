import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGlobalCatalogCache } from '../data/globalCatalogCache';
import type { CatalogCheckpoint } from '../data/globalCatalog';

const checkpoint = (after = 10, pages = 1): CatalogCheckpoint => ({ boundary: 10, after, pages, phase: 'pages', complete: false, nextCursor: `page-${pages + 1}`,
  snapshot: { regionId: 'region', sequence: after, scope: { messageId: null, title: '公论' }, messages: [], relations: [], users: [], stakes: {}, tagCounts: {}, attentionUsers: {} } });
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { vi.unstubAllGlobals(); });

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
