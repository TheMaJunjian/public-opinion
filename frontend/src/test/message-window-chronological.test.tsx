import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useMessageWindow } from '../hooks/useMessageWindow';
import { planMessageStructures } from '../utils/messageStructurePlan';
import { layoutDiscussion } from '../utils/discussionLayout';
import type { DemoEdge, DemoMessage } from '../utils/modelBridge';

const timestamp = (time: number) => new Date(Date.UTC(2026, 0, 1) + time).toISOString();
const message = (id: string, time: number, sequence = 0): DemoMessage => ({
  id, sequence, createdAt: timestamp(time), kind: 'normal', author: 'structure-fixture', content: '', parts: [],
});
const sourceId = (index: number) => `source-${String(index).padStart(3, '0')}`;
const recordId = (index: number) => `${sourceId(index)}:relation`;

/** Empty native structures: input groups all supports before all refutations,
 * while their timestamps alternate. No discussion text is generated. */
function mixed(count = 120, replyChain = false) {
  const root = message('root', 0);
  const entries = Array.from({ length: count }, (_, index) => {
    const source = message(sourceId(index), (index + 1) * 1000, index + 1);
    const type = replyChain ? 'reply' : index % 2 === 0 ? 'agree' : 'disagree';
    const target = replyChain && index > 0 ? sourceId(index - 1) : root.id;
    const record: DemoMessage = { ...message(recordId(index), (index + 1) * 1000 + 1, index + 1),
      kind: 'relation', relationType: type, sourceMessageId: source.id, sourceRefs: [{ messageId: source.id }],
      targetRefs: [{ kind: 'message', messageId: target }] };
    const edge: DemoEdge = { id: `${record.id}:edge`, relationMessageId: record.id, relationType: type, relationLabel: '',
      from: { messageId: source.id, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } } };
    return { source, record, edge };
  });
  const grouped = replyChain ? [...entries].reverse()
    : [...entries.filter(entry => entry.edge.relationType === 'agree'), ...entries.filter(entry => entry.edge.relationType === 'disagree')];
  return { messages: [...grouped.flatMap(entry => [entry.source, entry.record]), root], edges: grouped.map(entry => entry.edge),
    expected: (sources: number) => [root.id, ...entries.slice(0, sources).flatMap(entry => [entry.source.id, entry.record.id])] };
}
const ids = (messages: readonly DemoMessage[]) => messages.map(message => message.id);

it.each(['legacy', 'native'] as const)('pages bodies with their anonymous %s stance decorations so old votes cannot crowd later bodies out', format => {
  const bodies = Array.from({ length: 65 }, (_, index) => message(`body-${index}`, index * 1000));
  const votes: DemoMessage[] = Array.from({ length: 160 }, (_, index) => ({
    ...message(`vote-${index}`, index + 1), kind: 'relation', relationType: 'agree',
    targetRefs: [{ kind: 'message', messageId: bodies[0].id }],
    ...(format === 'native' ? { parts: [{ id: 'vote', type: 'relation' as const, relation: 'agree',
      roles: { target: [{ id: 'target', reference: { messageId: bodies[0].id, revision: 1 } }] } }] } : {}),
  }));
  const edges: DemoEdge[] = votes.map(vote => ({
    id: `${vote.id}:edge`, relationMessageId: vote.id, relationType: 'agree', relationLabel: '',
    from: { messageId: `anon:${vote.id}`, selection: { kind: 'whole' } },
    to: { messageId: bodies[0].id, selection: { kind: 'whole' } },
  }));
  const records = [...bodies, ...votes], original = structuredClone(records);
  const { result } = renderHook(() => useMessageWindow(records, edges, true, 'classification-with-many-votes', []));
  expect(result.current.messages.filter(record => record.kind === 'normal').map(record => record.id)).toEqual(ids(bodies.slice(0, 50)));
  expect(result.current.messages.filter(record => record.relationType === 'agree')).toHaveLength(160);
  expect(result.current.hasMore).toBe(true);
  expect(records).toEqual(original);
});

it.each(['anonymous', 'sourced'] as const)('defers an earlier %s decoration until its later host enters the loaded batch', async sourceKind => {
  const bodies = Array.from({ length: 65 }, (_, index) => message(`host-${index}`, index * 1000));
  const vote: DemoMessage = { ...message('earlier-vote', 1), kind: 'relation', relationType: 'agree' };
  const edge: DemoEdge = { id: 'vote-edge', relationMessageId: vote.id, relationType: 'agree', relationLabel: '',
    from: { messageId: sourceKind === 'sourced' ? bodies[0].id : 'anon:vote', selection: { kind: 'whole' } }, to: { messageId: bodies[60].id, selection: { kind: 'whole' } } };
  const records = [...bodies, vote], edges = [edge];
  const { result } = renderHook(() => useMessageWindow(records, edges, true, 'later-host', []));
  expect(result.current.messages.map(record => record.id)).toEqual(ids(bodies.slice(0, 50)));
  expect(result.current.visibleIds.has(vote.id)).toBe(false);
  expect(result.current.edges).toEqual([]);
  act(() => { void result.current.more(); });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.visibleIds.has(bodies[60].id)).toBe(true);
  expect(result.current.visibleIds.has(vote.id)).toBe(true);
  expect(result.current.edges).toEqual(edges);
});

it('defaults to a chronological 50-unit prefix containing both stances despite zone-grouped input', async () => {
  const fixture = mixed(), original = JSON.stringify([fixture.messages, fixture.edges]);
  const { result } = renderHook(() => useMessageWindow(fixture.messages, fixture.edges, true, 'mixed', []));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(ids(result.current.messages)).toEqual(fixture.expected(49));
  expect(result.current.messages.filter(message => message.relationType === 'agree')).toHaveLength(25);
  expect(result.current.messages.filter(message => message.relationType === 'disagree')).toHaveLength(24);
  expect(result.current.hasMore).toBe(true);
  const first = ids(result.current.messages);
  act(() => { void result.current.more(); });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(ids(result.current.messages)).toEqual(fixture.expected(99));
  expect(ids(result.current.messages).slice(0, first.length)).toEqual(first);
  act(() => { void result.current.more(); });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(ids(result.current.messages)).toEqual(fixture.expected(120));
  expect(result.current.hasMore).toBe(false);
  expect(JSON.stringify([fixture.messages, fixture.edges])).toBe(original);
});

it.each(['source', 'relation'] as const)('reveals a pinned %s through its chronological prefix and keeps that range after deselection', async pinnedKind => {
  const fixture = mixed();
  const { result, rerender } = renderHook(({ pinned }) => useMessageWindow(fixture.messages, fixture.edges, true, 'pinned', pinned),
    { initialProps: { pinned: [] as string[] } });
  expect(ids(result.current.messages)).toEqual(fixture.expected(49));
  rerender({ pinned: [pinnedKind === 'source' ? sourceId(91) : recordId(91)] });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(ids(result.current.messages)).toEqual(fixture.expected(92));
  expect(result.current.messages.filter(message => message.relationType === 'agree')).toHaveLength(46);
  expect(result.current.messages.filter(message => message.relationType === 'disagree')).toHaveLength(46);
  rerender({ pinned: [] });
  expect(ids(result.current.messages)).toEqual(fixture.expected(92));
  act(() => { void result.current.more(); });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(ids(result.current.messages)).toEqual(fixture.expected(120));
});

it('does not load a single connected reply tree with over 100 sources in one batch', async () => {
  const fixture = mixed(125, true), original = JSON.stringify(fixture);
  const { result } = renderHook(() => useMessageWindow(fixture.messages, fixture.edges, true, 'large-reply-tree', []));
  expect(ids(result.current.messages)).toEqual(fixture.expected(49));
  expect(result.current.visibleIds.has(sourceId(124))).toBe(false);
  expect(result.current.hasMore).toBe(true);
  act(() => { void result.current.more(); });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(ids(result.current.messages)).toEqual(fixture.expected(99));
  expect(result.current.hasMore).toBe(true);
  expect(JSON.stringify(fixture)).toBe(original);
});

it('uses sequence then ID for equal timestamps independent of input permutation', async () => {
  const ordered = Array.from({ length: 120 }, (_, index) => message(`tie-${String(index).padStart(3, '0')}`, 0, Math.floor(index / 2)));
  const reversed = [...ordered].reverse(), original = JSON.stringify(reversed);
  const { result, rerender } = renderHook(({ records }) => useMessageWindow(records, [], true, 'ties', []), { initialProps: { records: reversed } });
  expect(ids(result.current.messages)).toEqual(ids(ordered.slice(0, 50)));
  rerender({ records: [...ordered.filter((_, index) => index % 2 === 0), ...ordered.filter((_, index) => index % 2 !== 0)] });
  expect(ids(result.current.messages)).toEqual(ids(ordered.slice(0, 50)));
  act(() => { void result.current.more(); });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(ids(result.current.messages)).toEqual(ids(ordered.slice(0, 100)));
  expect(JSON.stringify(reversed)).toBe(original);
});

it('keeps fold and visual placement computations separate from the chronological paging plan', () => {
  const fixture = mixed(), input = { messages: fixture.messages, edges: fixture.edges, order: 'time' as const };
  const original = JSON.stringify([fixture.messages, fixture.edges]), before = planMessageStructures(input);
  const items = fixture.messages.filter(message => message.kind === 'normal').map(message => ({
    id: message.id, width: 320, height: 120, time: Date.parse(message.createdAt), sequence: message.sequence,
  }));
  const regions = (['agree', 'disagree'] as const).map(type => ({ key: `root:${type}`, targetId: 'root', type, directCount: 60, collapsed: false }));
  const expanded = layoutDiscussion(items, fixture.edges, { regions });
  const folded = layoutDiscussion(items, fixture.edges, { regions: regions.map(region => ({ ...region, collapsed: region.type === 'agree' })) });
  expect(expanded.hiddenIds).toHaveLength(0);
  expect(folded.hiddenIds).toHaveLength(60);
  // The legacy graph plan remains an explicit visual choice; neither it nor a
  // fold may reorder or mutate the complete source used for time paging.
  planMessageStructures({ ...input, order: 'placement' });
  const after = planMessageStructures(input);
  expect(after.order).toEqual(fixture.expected(120));
  expect(after.order).toEqual(before.order);
  expect(after.units).toEqual(before.units);
  expect([...after.byId]).toEqual([...before.byId]);
  expect(new Set(after.units.slice(0, 50)).size).toBe(50);
  expect(JSON.stringify([fixture.messages, fixture.edges])).toBe(original);
});

it('keeps a late target out of the first batch but reveals its full time prefix when navigating to its relation', () => {
  const records = Array.from({ length: 120 }, (_, index) => message(`m-${String(index).padStart(3, '0')}`, index * 1000));
  const record: DemoMessage = { ...message('early-relation', 1), kind: 'relation', relationType: 'reference', sourceMessageId: records[0].id };
  const edge: DemoEdge = { id: 'early-relation:edge', relationMessageId: record.id, relationType: 'reference', relationLabel: '',
    from: { messageId: records[0].id, selection: { kind: 'whole' } }, to: { messageId: records[90].id, selection: { kind: 'whole' } } };
  const all = [...records].reverse().concat(record);
  const { result, rerender } = renderHook(({ pinned }) => useMessageWindow(all, [edge], true, 'late-target', pinned),
    { initialProps: { pinned: [] as string[] } });
  expect(result.current.visibleIds.has(records[90].id)).toBe(false);
  expect(ids(result.current.messages)).toEqual([records[0].id, record.id, ...ids(records.slice(1, 50))]);
  rerender({ pinned: [record.id] });
  expect(ids(result.current.messages)).toEqual([records[0].id, record.id, ...ids(records.slice(1, 91))]);
  expect(result.current.hasMore).toBe(true);
});
