import { expect, it } from 'vitest';
import { indexReadingStructure, readingNeighbors, nextStructuredReadingVisit } from '../pages/workbench/model/readingStructure';
import type { ReadingTask } from '../pages/workbench/model/readingTasks';
import type { DemoMessage, DemoEdge } from '../utils/modelBridge';

const message = (id: string, extra: Partial<DemoMessage> = {}): DemoMessage => ({ id, kind: 'normal', content: id, author: 'writer', createdAt: '', ...extra });
const edge = (source: string, target: string, type: DemoEdge['relationType'] = 'reply', id = `${source}:${target}:${type}`): DemoEdge => ({
  id, relationMessageId: id, relationType: type, relationLabel: type,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } },
});
const baseMessages = ['parent', 'current', 'peer', 'child', 'grandchild', 'unrelated'].map(id => message(id));
const baseEdges = [edge('current', 'parent'), edge('peer', 'parent', 'reference'), edge('child', 'current'), edge('grandchild', 'child')];

it('distinguishes direct predecessors, shared-predecessor peers and direct successors independently of screen order', () => {
  const edges = [...baseEdges, edge('peer', 'parent', 'annotation'), edge('unrelated', 'current', 'arrange')];
  const result = readingNeighbors(indexReadingStructure(baseMessages, edges), ['current']);
  expect(result.up).toEqual([{ id: 'parent', relationTypes: ['reply'], viaIds: [] }]);
  expect(result.peer).toEqual([{ id: 'peer', relationTypes: ['reference', 'annotation'], viaIds: ['parent'] }]);
  expect(result.down).toEqual([{ id: 'child', relationTypes: ['reply'], viaIds: [] }]);
});

it('keeps all common predecessors, deduplicates a selected group and excludes its members', () => {
  const messages = [...baseMessages, message('basis'), message('peer2')];
  const edges = [...baseEdges, edge('current', 'basis', 'reference'), edge('peer', 'basis', 'reference'), edge('peer2', 'parent')];
  const index = indexReadingStructure(messages, edges);
  expect(readingNeighbors(index, ['current']).peer.find(item => item.id === 'peer')?.viaIds).toEqual(['parent', 'basis']);
  const result = readingNeighbors(index, ['current', 'peer']);
  expect(result.peer.map(item => item.id)).toEqual(['peer2']);
  expect(result.up.map(item => item.id)).toEqual(['basis', 'parent']);
});

it('retains real directions through cycles without inventing peer or self links', () => {
  const result = readingNeighbors(indexReadingStructure(baseMessages, [...baseEdges, edge('parent', 'current'), edge('current', 'current')]), ['current']);
  expect(result.up.map(item => item.id)).toEqual(['parent']);
  expect(result.down.map(item => item.id)).toEqual(['child', 'parent']);
  expect(result.peer.map(item => item.id)).toEqual(['peer']);
});

it('ignores membership, settlement, bodyless records and inactive relationships', () => {
  const messages = [...baseMessages, message('join', { kind: 'join' }), message('vote', { kind: 'relation', relationType: 'agree', content: '' }),
    message('round', { kind: 'round' })];
  const edges = [...baseEdges, edge('unrelated', 'current', 'summary'), edge('unrelated', 'current', 'classify'),
    edge('unrelated', 'current', 'merge'), edge('unrelated', 'current', 'reference', 'join'), edge('round', 'current'),
    edge('anon:vote', 'current', 'agree', 'vote')];
  const result = readingNeighbors(indexReadingStructure(messages, edges, new Set([baseEdges[2].relationMessageId])), ['current']);
  expect(result.down).toEqual([]);
  expect(result.peer.map(item => item.id)).toEqual(['peer']);
});

it('lets an authored relation body participate without exposing every bodyless label', () => {
  const messages = [...baseMessages, message('note', { kind: 'relation', relationType: 'annotation', parts: [{ id: 'body', type: 'text', text: '说明' }] })];
  const result = readingNeighbors(indexReadingStructure(messages, [...baseEdges, edge('anon:note', 'current', 'annotation', 'note')]), ['current']);
  expect(result.down.map(item => item.id)).toEqual(['child', 'note']);
  expect(result.down[1].relationTypes).toEqual(['annotation']);
});

it('honors the selected reading order within each direction', () => {
  const messages = [...baseMessages, message('peer2')];
  const result = readingNeighbors(indexReadingStructure(messages, [...baseEdges, edge('peer2', 'parent')]), ['current'], ['peer2', 'peer']);
  expect(result.peer.map(item => item.id)).toEqual(['peer2', 'peer']);
});

it('uses the same directional target for preview and confirmation without falling through to another direction', () => {
  const neighbors = readingNeighbors(indexReadingStructure(baseMessages, baseEdges), ['current']);
  const visits = ['current', 'child', 'peer', 'parent', 'unrelated'].map(id => ({ id, tasks: [{ key: id, destinationId: id,
    targetId: id, kind: 'body', reason: '正文未读', location: 'inside', createdAt: '' } as ReadingTask] }));
  const queue = { pending: visits, visits, position: 1 }, current = visits[0].tasks;
  expect(nextStructuredReadingVisit(queue, current, 'auto', neighbors)?.id).toBe('child');
  expect(nextStructuredReadingVisit(queue, current, 'peer', neighbors)?.id).toBe('peer');
  expect(nextStructuredReadingVisit(queue, current, 'up', neighbors)?.id).toBe('parent');
  expect(nextStructuredReadingVisit(queue, current, 'down', neighbors)?.id).toBe('child');
  expect(nextStructuredReadingVisit({ ...queue, pending: visits.filter(visit => visit.id !== 'peer') }, current, 'peer', neighbors)).toBeUndefined();
});
