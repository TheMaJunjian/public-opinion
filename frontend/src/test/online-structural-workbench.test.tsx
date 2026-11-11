import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { structureSnapshot, type WorkbenchSnapshot } from '@gonglun/core';
import { useWorkbenchData } from '../pages/workbench/useWorkbenchData';
import { projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import type { CatalogData } from '../data/catalogEngine';
import type { SnapshotQuery } from '../data/workbench';
import { bindRoles, type Part } from '@gonglun/core';
import { createZhihuStructuralViewer } from '../utils/zhihuStructuralViewer';
import { hydrateOnlineStructure, onlineStructuralSource } from '../utils/onlineStructuralSource';

const harness = vi.hoisted(() => ({ ready: null as null | ((data: CatalogData) => void), get: vi.fn(), catchUp: vi.fn(), reload: vi.fn() }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/messages', key: 'normal', state: null }) }));
vi.mock('../api', () => ({ api: { getWorkbenchSnapshot: (query: SnapshotQuery) => harness.get(query),
  subscribeChanges: () => ({ addEventListener: vi.fn(), close: vi.fn() }) } }));
vi.mock('../data/catalogClient', () => ({ createCatalogClient: (_user: string, _parent: string, callbacks: { onReady(data: CatalogData): void }) => {
  harness.ready = callbacks.onReady;
  return { prioritize: vi.fn(), catchUp: harness.catchUp, stop: vi.fn(), applyCommitted: vi.fn(), refresh: vi.fn(), reload: harness.reload };
} }));
const user = { id: 'u', username: '甲', createdAt: '' };
const text = (id: string, body: string) => ({ id, revision: 1, kind: 'TEXT', contentType: 'TEXT' as const, content: body,
  parts: [{ id: 'body', type: 'text' as const, text: body }], createdAt: '', createdBy: user });
function fixture(): WorkbenchSnapshot {
  const relations = ['A', 'B'].map(id => ({ id, revision: 1, relationType: 'CLASSIFY', sourceMessageId: null,
    targetRefs: [{ kind: 'message' as const, messageId: `body-${id}` }], payload: { title: id }, createdAt: '', createdBy: user }));
  return { sequence: 10, regionId: 'test', scope: { messageId: null, title: '讨论' }, users: [user], stakes: {}, tagCounts: {}, attentionUsers: {}, relations,
    messages: [...relations.map(row => ({ ...text(row.id, row.id), kind: 'RELATION', relationType: row.relationType,
      targetRefs: row.targetRefs, relationPayload: row.payload })), text('body-A', '分类 A 的完整原文'), text('body-B', '分类 B 的完整原文')] };
}
let full: WorkbenchSnapshot;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); harness.ready = null; full = fixture();
  harness.get.mockImplementation(async (query: SnapshotQuery) => {
    const ids = new Set(query.ids ?? (query.after === undefined ? ['A', 'B'] : []));
    return { ...full, windowed: true, messages: full.messages.filter(row => ids.has(row.id)), relations: full.relations.filter(row => ids.has(row.id)) };
  });
});
afterEach(() => { vi.unstubAllGlobals(); });
const input = { user, authLoading: false, scopeMessageId: 'root', navigate: vi.fn(), viewMode: 'list' as const };
const publish = (update?: CatalogData['update']) => {
  const index = structureSnapshot(full);
  act(() => harness.ready!({ snapshot: index, index, ...(update ? { update } : {}), projected: projectWorkbenchSnapshot({ ...index, messages: [], relations: [] }) }));
};
function largeCategory(count = 125) {
  const rows = Array.from({ length: count }, (_, i) => ({ ...text(`a-${String(i).padStart(3, '0')}`, `完整正文 ${i}`),
    createdAt: new Date(i * 1000).toISOString(), sequence: i + 1 }));
  const targetRefs = rows.map(row => ({ kind: 'message' as const, messageId: row.id }));
  full = { ...full, messages: [...full.messages.filter(row => row.id !== 'body-A').map(row => row.id === 'A' ? { ...row, targetRefs } : row), ...rows],
    relations: full.relations.map(row => row.id === 'A' ? { ...row, targetRefs } : row) };
  return rows;
}

it('hydrates twenty initial category units, then only missing bodies in fifty-unit increments', async () => {
  const rows = largeCategory();
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(harness.ready).not.toBeNull()); publish();
  await waitFor(() => expect(result.current.loading).toBe(false));
  harness.get.mockClear();
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'A' }); });
  expect(result.current.viewerBodyPage).toMatchObject({ limit: 20, totalUnits: 125, hasMore: true });
  expect(result.current.messages.filter(row => row.id.startsWith('a-')).map(row => row.content)).toEqual(rows.slice(0, 20).map(row => row.content));
  expect(result.current.viewerStructure?.memberCounts('A').total).toBe(125);
  expect(harness.get.mock.calls.flatMap(([query]) => query.ids)).toEqual(rows.slice(0, 20).map(row => row.id));
  for (const end of [70, 120, 125]) {
    harness.get.mockClear();
    await act(async () => { await result.current.loadMoreViewerBodies(); });
    expect(result.current.messages.filter(row => row.id.startsWith('a-'))).toHaveLength(end);
    expect(harness.get.mock.calls.flatMap(([query]) => query.ids).length).toBe(end === 125 ? 5 : 50);
  }
  expect(result.current.viewerBodyPage?.hasMore).toBe(false);
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'B' }); });
  harness.get.mockClear();
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'A' }); });
  expect(result.current.messages.filter(row => row.id.startsWith('a-'))).toHaveLength(125);
  expect(harness.get).not.toHaveBeenCalled();
});

it('keeps the old category page after a failed body batch and retries the same prefix', async () => {
  largeCategory();
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(harness.ready).not.toBeNull()); publish();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'A' }); });
  const before = result.current.messages;
  harness.get.mockRejectedValueOnce(new Error('网络中断'));
  await act(async () => { await expect(result.current.loadMoreViewerBodies()).rejects.toThrow('网络中断'); });
  expect(result.current.messages).toBe(before);
  expect(result.current.viewerBodyPage?.limit).toBe(20);
  await act(async () => { await result.current.loadMoreViewerBodies(); });
  expect(result.current.messages.filter(row => row.id.startsWith('a-'))).toHaveLength(70);
});

it('cancels a late body page when navigating to another category', async () => {
  largeCategory();
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(harness.ready).not.toBeNull()); publish();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'A' }); });
  let release!: (snapshot: WorkbenchSnapshot) => void;
  harness.get.mockImplementationOnce(() => new Promise<WorkbenchSnapshot>(resolve => { release = resolve; }));
  let next!: Promise<void>;
  act(() => { next = result.current.loadMoreViewerBodies(); });
  await waitFor(() => expect(release).toBeTypeOf('function'));
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'B' }); });
  await act(async () => { release(full); await next; });
  expect(result.current.messages.find(row => row.id === 'body-B')?.content).toBe('分类 B 的完整原文');
  expect(result.current.messages.some(row => row.id.startsWith('a-'))).toBe(false);
});

it('preserves a revealed prefix across index updates and pinned-message deselection', async () => {
  largeCategory();
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(harness.ready).not.toBeNull()); publish();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'A', pinnedIds: ['a-090'] }); });
  expect(result.current.viewerBodyPage?.limit).toBe(91);
  expect(result.current.messages.find(row => row.id === 'a-090')?.content).toBe('完整正文 90');
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'A' }); });
  expect(result.current.messages.filter(row => row.id.startsWith('a-'))).toHaveLength(91);
  full = { ...full, sequence: 11, messages: full.messages.map(row => row.id === 'a-090' ? { ...row, revision: 2, content: '更新后的正文' } : row) };
  publish();
  await waitFor(() => expect(result.current.messages.find(row => row.id === 'a-090')?.content).toBe('更新后的正文'));
  expect(result.current.viewerBodyPage?.limit).toBe(91);
  expect(result.current.messages.some(row => row.id === 'a-091')).toBe(false);
});

it('reuses unaffected category bodies across complete updates and refreshes only changed dependencies', async () => {
  largeCategory();
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(harness.ready).not.toBeNull()); publish();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'A' }); });
  harness.get.mockClear(); const before = result.current.viewerStructure;
  full = { ...full, sequence: 11, messages: full.messages.map(row => row.id === 'body-B' ? { ...row, revision: 2, content: '分类 B 更新' } : row) };
  publish({ previousSequence: 10, changedIds: ['body-B'] });
  await waitFor(() => expect(result.current.viewerStructure).not.toBe(before));
  expect(harness.get).not.toHaveBeenCalled();
  expect(result.current.viewerBodyPage).toMatchObject({ limit: 20, totalUnits: 125 });
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'B' }); });
  expect(result.current.messages.find(row => row.id === 'body-B')?.content).toBe('分类 B 更新');
  harness.get.mockClear(); const second = result.current.viewerStructure;
  full = { ...full, sequence: 12, messages: full.messages.map(row => row.id === 'a-000' ? { ...row, revision: 2, content: '分类 A 更新' } : row) };
  publish({ previousSequence: 11, changedIds: ['a-000'] });
  await waitFor(() => expect(result.current.viewerStructure).not.toBe(second));
  expect(harness.get).not.toHaveBeenCalled();
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'A' }); });
  expect(harness.get.mock.calls.flatMap(([query]) => query.ids)).toEqual(['A', 'a-000']);
  expect(result.current.messages.find(row => row.id === 'a-000')?.content).toBe('分类 A 更新');
  expect(result.current.messages.filter(row => row.id.startsWith('a-'))).toHaveLength(20);
});

it('starts the structural index before the initial window finishes replaying its delta', async () => {
  harness.get.mockImplementation((query: SnapshotQuery) => query.after === undefined
    ? Promise.resolve({ ...full, windowed: true }) : new Promise(() => {}));
  const { result, unmount } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(harness.ready).not.toBeNull());
  expect(result.current.loading).toBe(true);
  unmount();
});

it('preserves the full-snapshot path without starting a redundant structural catalog', async () => {
  harness.get.mockResolvedValue(full);
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(harness.ready).toBeNull();
  expect(result.current.catalog).toBeNull();
});

it('hydrates a large category in bounded exact batches while retaining order and all relations', async () => {
  full.messages.push(...Array.from({ length: 700 }, (_, index) => text(`extra-${index}`, `正文 ${index}`)));
  const source = onlineStructuralSource(structureSnapshot(full), harness.get);
  const result = await hydrateOnlineStructure(source, source);
  expect(harness.get.mock.calls.map(([query]) => query.ids.length)).toEqual([200, 200, 200, 104]);
  expect(harness.get.mock.calls.every(([query]) => query.includeContext === false)).toBe(true);
  expect(result.messages.map(row => row.id)).toEqual(full.messages.map(row => row.id));
  expect(result.messages.map(row => row.content)).toEqual(full.messages.map(row => row.content));
  expect(result.relations.map(row => row.id)).toEqual(full.relations.map(row => row.id));
});

it('reuses the validated first window and overlapping category bodies, including their statistics and relations', async () => {
  full.stakes.A = { messageId: 'A', counts: { pro: 4, con: 2 }, pool: { lockedPro: 3, lockedCon: 1 }, stakes: [] };
  full.tagCounts.A = { RECOMMEND: 7 }; full.attentionUsers.A = ['甲'];
  const seed = { ...full, messages: full.messages.slice(0, 2), relations: full.relations };
  const source = onlineStructuralSource(structureSnapshot(full), harness.get, seed);
  const select = (...ids: string[]) => ({ ...source, messages: source.messages.filter(row => ids.includes(row.id)),
    relations: source.relations.filter(row => ids.includes(row.id)) });
  const first = await hydrateOnlineStructure(source, select('A', 'body-A'));
  expect(harness.get.mock.calls.map(([query]) => query.ids)).toEqual([['body-A']]);
  expect(first.messages.map(row => row.content)).toEqual(['A', '分类 A 的完整原文']);
  expect(first.relations[0].payload).toEqual(full.relations[0].payload);
  expect(first.stakes?.A).toEqual(full.stakes.A);
  expect(first.tagCounts?.A).toEqual({ RECOMMEND: 7 });
  expect(first.attentionUsers?.A).toEqual(['甲']);
  await hydrateOnlineStructure(source, select('A', 'B', 'body-A', 'body-B'));
  expect(harness.get.mock.calls.map(([query]) => query.ids)).toEqual([['body-A'], ['body-B']]);
  await hydrateOnlineStructure(source, source);
  expect(harness.get).toHaveBeenCalledTimes(2);
});

it.each(['region', 'sequence', 'revision', 'visibility', 'structure'])('does not seed bodies with a mismatched %s', async mismatch => {
  const seed = structuredClone(full);
  seed.messages[0].content = '不能复用的旧正文';
  if (mismatch === 'region') seed.regionId = 'old-region';
  if (mismatch === 'sequence') seed.sequence--;
  if (mismatch === 'revision') seed.messages[0].revision = 0;
  if (mismatch === 'visibility') seed.messages[0].restricted = true;
  if (mismatch === 'structure') seed.structureOnly = true;
  const source = onlineStructuralSource(structureSnapshot(full), harness.get, seed);
  const result = await hydrateOnlineStructure(source, source);
  expect(harness.get.mock.calls.flatMap(([query]) => query.ids)).toContain('A');
  expect(result.messages[0].content).toBe('A');
});

it('does not retain partial or cancelled hydration, and does not cache responses from a newer sequence', async () => {
  const source = onlineStructuralSource(structureSnapshot(full), harness.get);
  const load = harness.get.getMockImplementation()!;
  harness.get.mockResolvedValueOnce({ ...full, messages: full.messages.slice(0, -1) });
  await expect(hydrateOnlineStructure(source, source)).rejects.toMatchObject({ status: 409 });
  const controller = new AbortController();
  harness.get.mockImplementationOnce(async (query: SnapshotQuery) => { controller.abort(); return load(query); });
  await expect(hydrateOnlineStructure(source, source, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  harness.get.mockResolvedValueOnce({ ...full, sequence: 11 });
  await expect(hydrateOnlineStructure(source, source)).rejects.toMatchObject({ status: 409 });
  await hydrateOnlineStructure(source, source);
  expect(harness.get.mock.calls.map(([query]) => query.ids.length)).toEqual([4, 4, 4, 4]);
  await hydrateOnlineStructure(source, source);
  expect(harness.get).toHaveBeenCalledTimes(4);
});

it('evicts old bodies after the count bound and fetches only the evicted overlap', async () => {
  full.messages = Array.from({ length: 2001 }, (_, i) => text(String(i), `原文 ${i}`)); full.relations = [];
  const source = onlineStructuralSource(structureSnapshot(full), harness.get);
  await hydrateOnlineStructure(source, source);
  harness.get.mockClear();
  const two = { ...source, messages: source.messages.slice(0, 2) };
  const result = await hydrateOnlineStructure(source, two);
  expect(harness.get.mock.calls.map(([query]) => query.ids)).toEqual([['0']]);
  expect(result.messages.map(row => row.id)).toEqual(['0', '1']);
});

it('does not repopulate an invalidated body cache from a concurrent older response', async () => {
  const source = onlineStructuralSource(structureSnapshot(full), harness.get);
  let release!: (page: WorkbenchSnapshot) => void;
  harness.get.mockImplementationOnce(() => new Promise<WorkbenchSnapshot>(resolve => { release = resolve; }));
  const pending = hydrateOnlineStructure(source, source);
  harness.get.mockResolvedValueOnce({ ...full, sequence: 11 });
  await expect(hydrateOnlineStructure(source, source)).rejects.toMatchObject({ status: 409 });
  release(full);
  await expect(pending).rejects.toMatchObject({ status: 409, reloadCatalog: true });
  await hydrateOnlineStructure(source, source);
  expect(harness.get).toHaveBeenCalledTimes(3);
});

it.each(['region', 'revision', 'missing', 'structure', 'visibility'])('rejects %s mismatches instead of publishing an inconsistent category', async failure => {
  const source = onlineStructuralSource(structureSnapshot(full), harness.get);
  const changed = { ...full, messages: [...full.messages] };
  if (failure === 'region') changed.regionId = 'another-region';
  if (failure === 'revision') changed.messages[0] = { ...changed.messages[0], revision: 2 };
  if (failure === 'missing') changed.messages.pop();
  if (failure === 'structure') changed.structureOnly = true;
  if (failure === 'visibility') changed.messages[0] = { ...changed.messages[0], restricted: true, content: '' };
  harness.get.mockResolvedValue(changed);
  await expect(hydrateOnlineStructure(source, source)).rejects.toMatchObject({ status: 409 });
});

it('does not hydrate closed branches through unparented JOIN stances and settlement records on refresh or account changes', async () => {
  const add = (id: string, relationType: string, relation: string, source: string | null, targets: string[]) => {
    const part: Part = { id: 'relation', type: 'relation', relation, roles: bindRoles(relationType === 'JOIN'
      ? { parent: [{ messageId: source! }], member: targets.map(messageId => ({ messageId })) }
      : { target: targets.map(messageId => ({ messageId })) }) };
    const row = { id, revision: 1, relationType, sourceMessageId: source, targetRefs: targets.map(messageId => ({ kind: 'message' as const, messageId })), createdAt: '', createdBy: user, parts: [part] };
    full.relations.push(row);
    full.messages.push({ ...text(id, ''), ...row, kind: relationType === 'ROUND' ? 'ROUND' : 'RELATION' });
  };
  for (const name of ['A', 'B']) {
    add(`join-${name}`, 'JOIN', 'member-of', name, [`body-${name}`]);
    add(`agree-${name}`, 'AGREE', 'agree', null, [`join-${name}`]);
    add(`round-${name}`, 'ROUND', 'settlement', null, [`agree-${name}`]);
    add(`result-${name}`, 'ROUND_RESULT', 'distribution', null, [`round-${name}`]);
  }
  // A settlement for a visible category remains available from that category.
  add('category-round', 'ROUND', 'settlement', null, ['A']);
  for (const username of [user.username, '另一个用户']) {
    const index = createZhihuStructuralViewer(onlineStructuralSource(structureSnapshot(full), harness.get), username);
    const overview = index.window({ classificationId: null });
    expect(overview.data.messages.map(row => row.id)).toEqual(['A', 'B', 'category-round']);
    expect(index.memberCounts('A').total).toBe(1);
    const inside = index.window({ classificationId: 'A' });
    expect(inside.data.messages.map(row => row.id)).toEqual(expect.arrayContaining(['body-A', 'join-A', 'agree-A']));
    expect(inside.data.messages.some(row => row.id === 'body-B')).toBe(false);
    const context = await index.readContext(['round-B']);
    expect(context.messages.some(row => row.id === 'round-B')).toBe(true);
  }
});

it('fetches only overview bodies, loads categories and cross-category context on demand, and reuses four-page projections', async () => {
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(harness.ready).not.toBeNull()); publish();
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.isPreloaded).toBe(false);
  expect(result.current.messages.map(row => row.id)).toEqual(['A', 'B']);
  expect(result.current.viewerStructure?.memberCounts('A').total).toBe(1);
  expect(harness.get.mock.calls.flatMap(([query]) => query.ids ?? [])).not.toContain('body-A');
  expect(harness.get.mock.calls.some(([query]) => query.ids?.includes('A') || query.ids?.includes('B'))).toBe(false);
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'A' }); });
  expect(result.current.messages.find(row => row.id === 'body-A')?.content).toBe('分类 A 的完整原文');
  expect(result.current.messages.some(row => row.id === 'body-B')).toBe(false);
  const inside = result.current.messages, calls = harness.get.mock.calls.length;
  for (let n = 0; n < 8; n++) {
    await act(async () => { await result.current.loadViewerScope({ classificationId: null }); });
    await act(async () => { await result.current.loadViewerScope({ classificationId: 'A' }); });
    expect(result.current.messages).toBe(inside);
  }
  expect(harness.get).toHaveBeenCalledTimes(calls);
  const context = await result.current.viewerStructure!.readContext(['body-B']);
  expect(context.messages.find(row => row.id === 'body-B')?.content).toBe('分类 B 的完整原文');
});

it('invalidates cached bodies and membership counts together after synchronization', async () => {
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(harness.ready).not.toBeNull()); publish();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'A' }); });
  const previous = result.current.messages;
  full = { ...full, sequence: 11, messages: full.messages.map(row => row.id === 'body-A' ? { ...text('body-A', '同步后的原文'), revision: 2 } : row) };
  publish();
  await waitFor(() => expect(result.current.messages.find(row => row.id === 'body-A')?.content).toBe('同步后的原文'));
  expect(result.current.messages).not.toBe(previous);
  expect(result.current.liveSequence).toBe(11);
});

it('drops body reuse when the signed-in account changes even at the same revision and sequence', async () => {
  const { result, rerender } = renderHook(props => useWorkbenchData(props), { initialProps: input });
  await waitFor(() => expect(harness.ready).not.toBeNull()); publish();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'A' }); });
  expect(result.current.messages.find(row => row.id === 'body-A')?.content).toBe('分类 A 的完整原文');
  full = { ...full, messages: full.messages.map(row => row.id === 'body-A' ? { ...row, content: '', restricted: true } : row) };
  harness.ready = null; harness.get.mockClear();
  rerender({ ...input, user: { ...user, id: 'another-user', username: '乙' } });
  await waitFor(() => expect(harness.ready).not.toBeNull()); publish();
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(harness.get.mock.calls.flatMap(([query]) => query.ids ?? [])).toContain('body-A');
  expect(result.current.messages.find(row => row.id === 'body-A')?.content).toBe('');
});

it('rebuilds the catalog when body visibility changes without advancing the cursor', async () => {
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(harness.ready).not.toBeNull()); publish();
  await waitFor(() => expect(result.current.loading).toBe(false));
  full = { ...full, messages: full.messages.map(row => row.id === 'body-A' ? { ...row, content: '', restricted: true } : row) };
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'A' }); });
  expect(harness.reload).toHaveBeenCalledOnce();
  publish();
  await waitFor(() => expect(result.current.messages.find(row => row.id === 'body-A')?.content).toBe(''));
});

it('updates ownership after a synchronized JOIN moves a message into another closed category', async () => {
  const { result } = renderHook(() => useWorkbenchData(input));
  await waitFor(() => expect(harness.ready).not.toBeNull()); publish();
  await waitFor(() => expect(result.current.loading).toBe(false));
  const join = { id: 'move', revision: 1, relationType: 'JOIN', sourceMessageId: 'B',
    targetRefs: [{ kind: 'message' as const, messageId: 'body-A' }], createdAt: '2026-11-06', createdBy: user };
  full = { ...full, sequence: 11, relations: [...full.relations, join], messages: [...full.messages,
    { ...text('move', ''), ...join, kind: 'RELATION' }] };
  publish();
  await waitFor(() => expect(result.current.viewerStructure?.containingClassification('body-A')).toBe('B'));
  expect(result.current.viewerStructure?.memberCounts('B').total).toBe(2);
  await act(async () => { await result.current.loadViewerScope({ classificationId: 'B' }); });
  expect(result.current.messages.find(row => row.id === 'body-A')?.content).toBe('分类 A 的完整原文');
  expect(result.current.messages.find(row => row.id === 'body-B')?.content).toBe('分类 B 的完整原文');
});
