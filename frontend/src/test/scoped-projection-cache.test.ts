import { expect, it } from 'vitest';
import { createScopedProjectionCache } from '../utils/scopedProjectionCache';

it('evicts the least recently used scope and clears bodies when source or identity changes', () => {
  const cache = createScopedProjectionCache<object>(), source = {}, a = {}, b = {}, c = {};
  cache.select(source, '甲');
  cache.put('a', a, 100, 2); cache.put('b', b, 100, 2);
  expect(cache.get('a')).toBe(a);
  cache.put('c', c, 100, 2);
  expect(cache.get('b')).toBeUndefined(); expect(cache.size).toBe(2);
  cache.select(source, '乙'); expect(cache.size).toBe(0);
  cache.put('a', a, 100, 2); cache.select({}, '乙'); expect(cache.size).toBe(0);
  expect(cache.isCurrent(source, '甲')).toBe(false);
});

it('limits cached body memory even when the page count is high', () => {
  const cache = createScopedProjectionCache<object>(); cache.select({}, null);
  cache.put('a', {}, 20 * 1024 * 1024, 12);
  cache.put('b', {}, 20 * 1024 * 1024, 12);
  expect(cache.get('a')).toBeUndefined(); expect(cache.size).toBe(1);
  cache.put('oversized', {}, 33 * 1024 * 1024, 12);
  expect(cache.get('oversized')).toBeUndefined(); expect(cache.size).toBe(1);
});
