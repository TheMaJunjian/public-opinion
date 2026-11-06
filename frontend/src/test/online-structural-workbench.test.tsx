import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { structureSnapshot, type WorkbenchSnapshot } from '@gonglun/core';
import { useWorkbenchData } from '../pages/workbench/useWorkbenchData';
import { projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import type { CatalogData } from '../data/catalogEngine';
import type { SnapshotQuery } from '../data/workbench';
import { bindRoles, type Part } from '@gonglun/core';
import { createZhihuStructuralViewer } from '../utils/zhihuStructuralViewer';
import { onlineStructuralSource } from '../utils/onlineStructuralSource';

const harness = vi.hoisted(() => ({ ready: null as null | ((data: CatalogData) => void), get: vi.fn(), catchUp: vi.fn() }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/messages', key: 'normal', state: null }) }));
vi.mock('../api', () => ({ api: { getWorkbenchSnapshot: (query: SnapshotQuery) => harness.get(query),
  subscribeChanges: () => ({ addEventListener: vi.fn(), close: vi.fn() }) } }));
vi.mock('../data/catalogClient', () => ({ createCatalogClient: (_user: string, _parent: string, callbacks: { onReady(data: CatalogData): void }) => {
  harness.ready = callbacks.onReady;
  return { prioritize: vi.fn(), catchUp: harness.catchUp, stop: vi.fn(), applyCommitted: vi.fn(), refresh: vi.fn(), reload: vi.fn() };
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
const publish = () => {
  const index = structureSnapshot(full);
  act(() => harness.ready!({ snapshot: index, index, projected: projectWorkbenchSnapshot({ ...index, messages: [], relations: [] }) }));
};

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
