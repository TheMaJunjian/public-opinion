import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { bodyVersion, messageReadingKey, type ReadingMark } from '@gonglun/core';
import { useHomeFilterReadingMarks } from '../hooks/useHomeFilterReadingMarks';
import { useCatalogFilters } from '../hooks/useCatalogFilters';
import type { CatalogClient } from '../data/catalogClient';
import type { HomeFilterMode } from '../pages/workbench/model/homeFilter';

const mark: ReadingMark = { format: 3, messageId: 'm', scope: 'message', key: messageReadingKey('m'),
  bodySignature: messageReadingKey('m'), signature: 'display:test', version: bodyVersion('m'), state: 'READ' };
const pending: HomeFilterMode = { scope: 'all', status: 'pending' };

it('keeps the resolved unread canvas throughout read saves, then recomputes when the filter changes', async () => {
  const value = { clean: null, home: { matchIds: new Set(['m']), displayIds: new Set(['m']), reasonByMessageId: new Map() } };
  const filters = vi.fn().mockResolvedValue(value);
  const client = { prioritize: vi.fn(), filters } as unknown as CatalogClient;
  const view = renderHook(({ mode, marks }: { mode: HomeFilterMode | null; marks: ReadingMark[] }) => {
    const frozen = useHomeFilterReadingMarks(mode, 'user:scope', marks, true);
    return useCatalogFilters(client, 1, true, { rules: [], home: mode, user: null, readingMarks: frozen });
  }, { initialProps: { mode: pending as HomeFilterMode | null, marks: [] as ReadingMark[] } });
  await waitFor(() => expect(view.result.current.pending).toBe(false));
  view.rerender({ mode: { ...pending }, marks: [mark] });
  expect(view.result.current.pending).toBe(false);
  expect(view.result.current.result).toBe(value);
  expect(filters).toHaveBeenCalledOnce();
  view.rerender({ mode: null, marks: [mark] });
  view.rerender({ mode: pending, marks: [mark] });
  await waitFor(() => expect(filters).toHaveBeenCalledTimes(2));
  expect(filters.mock.lastCall![0].readingMarks).toEqual([mark]);
});

it('waits for reading-state readiness and resets snapshots across users and scopes', () => {
  const initial = { owner: 'user:one', marks: [] as ReadingMark[], ready: false };
  const view = renderHook(({ owner, marks, ready }) => useHomeFilterReadingMarks(pending, owner, marks, ready), { initialProps: initial });
  view.rerender({ ...initial, ready: true, marks: [mark] });
  expect(view.result.current).toEqual([mark]);
  view.rerender({ ...initial, ready: true, marks: [] });
  expect(view.result.current).toEqual([mark]);
  view.rerender({ ...initial, owner: 'user:two', ready: true });
  expect(view.result.current).toEqual([]);
  view.rerender({ ...initial, owner: 'other:two', ready: true, marks: [mark] });
  expect(view.result.current).toEqual([mark]);
  act(() => view.unmount());
});

it('retains a usable filtered view during background sync but waits for a new filter or catalog', async () => {
  const first = { clean: null, home: { matchIds: new Set(['m']), displayIds: new Set(['m']), reasonByMessageId: new Map() } };
  const updated = { ...first, home: { ...first.home, displayIds: new Set(['m', 'new']) } };
  let finishRefresh!: (value: typeof first) => void;
  const filters = vi.fn().mockResolvedValueOnce(first)
    .mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
  const client = { prioritize: vi.fn(), filters } as unknown as CatalogClient;
  const view = renderHook(({ catalog, version, mode }) => useCatalogFilters(catalog, version, true, { rules: [], home: mode, user: null }),
    { initialProps: { catalog: client, version: 1, mode: pending } });
  await waitFor(() => expect(view.result.current.pending).toBe(false));
  view.rerender({ catalog: client, version: 2, mode: pending });
  expect(view.result.current.pending).toBe(false);
  expect(view.result.current.result).toBe(first);
  await act(async () => finishRefresh(updated));
  expect(view.result.current.result).toBe(updated);
  filters.mockImplementationOnce(() => new Promise(() => {}));
  const mode: HomeFilterMode = { scope: 'all', status: 'all' };
  view.rerender({ catalog: client, version: 2, mode });
  expect(view.result.current.pending).toBe(true);
  expect(view.result.current.result).toBeNull();
  filters.mockResolvedValueOnce(first);
  const other = { prioritize: vi.fn(), filters } as unknown as CatalogClient;
  view.rerender({ catalog: other, version: 2, mode: pending });
  expect(view.result.current.pending).toBe(true);
  expect(view.result.current.result).toBeNull();
  await waitFor(() => expect(view.result.current.pending).toBe(false));
});
