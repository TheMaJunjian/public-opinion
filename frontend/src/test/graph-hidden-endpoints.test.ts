import { describe, expect, it } from 'vitest';
import type { ExportData } from '../api/client';
import { routeGraphEdges } from '../utils/graphEdgeRouting';
import { buildStanceTargetMap, resolveDisplayedStance, type DemoMessage } from '../utils/modelBridge';
import { archiveToWorkbenchSnapshot, projectWorkbenchSnapshot } from '../utils/workbenchProjection';
import { projectStanceLayoutEdges } from '../utils/stanceLayout';
import { pointOnRect, routingEdge, routingFixture } from './graph-routing-fixtures';

const record = (id: string, type: DemoMessage['relationType'] = 'reply'): DemoMessage => ({
  id, kind: 'relation', relationType: type, content: '', author: '结构测试', createdAt: '',
});

describe('view-only hidden endpoints in graph routing', () => {
  it.each(['source', 'target', 'record:edge'])('does not draw an edge whose %s is explicitly hidden, even with cached geometry', hidden => {
    const layout = { source: { x: 600, y: 0, width: 300, height: 100 }, target: { x: 0, y: 0, width: 300, height: 100 } };
    const edge = routingEdge('edge', 'source', 'target'), original = structuredClone(edge);
    const input = routingFixture(layout, [edge]);
    expect(routeGraphEdges(input)).toHaveLength(1);
    expect(routeGraphEdges({ ...input, hiddenMessageIds: new Set([hidden]) })).toEqual([]);
    expect(edge).toEqual(original);
  });

  it('does not borrow another endpoint or a stale label when a nested relationship anchor is folded', () => {
    const layout = {
      target: { x: 0, y: 0, width: 300, height: 100 }, source: { x: 600, y: 0, width: 300, height: 100 },
      next: { x: 600, y: 300, width: 300, height: 100 }, final: { x: 1200, y: 600, width: 300, height: 100 },
    };
    const first = routingEdge('first', 'source', 'target');
    const next = routingEdge('next', 'next', first.relationMessageId);
    const last = routingEdge('last', 'final', next.relationMessageId, 'disagree');
    last.to.reference = { messageId: next.relationMessageId, revision: 1, partId: 'relation', path: ['relation'] };
    const edges = [first, next, last], before = structuredClone(edges);
    const input = routingFixture(layout, edges, {
      messages: [record(first.relationMessageId), record(next.relationMessageId)],
      labelBboxes: { first: { x: 420, y: 20, width: 50, height: 20 } },
    });
    expect(routeGraphEdges(input).some(path => path.edge.id === last.id)).toBe(true);
    const folded = routeGraphEdges({ ...input, hiddenMessageIds: new Set(['target']) });
    expect(folded).toEqual([]);
    expect(edges).toEqual(before);
    expect(routeGraphEdges(input).find(path => path.edge.id === last.id)?.edge.to.reference).toEqual(last.to.reference);
  });

  it('uses a visible relationship card itself even when its underlying discussion is folded', () => {
    const first = routingEdge('first', 'source', 'target');
    const addressed = routingEdge('addressed', 'other', first.relationMessageId, 'disagree');
    addressed.to.reference = { messageId: first.relationMessageId, revision: 1, partId: 'relation' };
    const layout = {
      source: { x: 600, y: 0, width: 300, height: 100 }, target: { x: 0, y: 0, width: 300, height: 100 },
      other: { x: 600, y: 300, width: 300, height: 100 },
      [first.relationMessageId]: { x: 0, y: 300, width: 300, height: 100 },
    };
    const input = routingFixture(layout, [first, addressed], { messages: [record(first.relationMessageId)] });
    input.relationCardMsgIds.add(first.relationMessageId);
    const [path] = routeGraphEdges({ ...input, hiddenMessageIds: new Set(['source', 'target']) });
    expect(path.edge).toBe(addressed);
    expect(path.toBox).toEqual(layout[first.relationMessageId]);
    expect(pointOnRect(path.end, layout[first.relationMessageId])).toBe(true);
    expect(path.edge.to.reference).toEqual({ messageId: first.relationMessageId, revision: 1, partId: 'relation' });
  });

  it('anchors a multi-target relationship at its open edge, never the closed first edge label', () => {
    const first = routingEdge('first', 'source', 'first-target');
    const second = { ...routingEdge('second', 'source', 'second-target'), relationMessageId: first.relationMessageId };
    const addressed = routingEdge('addressed', 'other', first.relationMessageId, 'reference');
    addressed.to.reference = { messageId: first.relationMessageId, revision: 1, partId: 'relation' };
    const layout = { source: { x: 600, y: 0, width: 300, height: 100 }, 'first-target': { x: 0, y: 0, width: 300, height: 100 },
      'second-target': { x: 0, y: 300, width: 300, height: 100 }, other: { x: 600, y: 600, width: 300, height: 100 } };
    const closedLabel = { x: 350, y: 0, width: 50, height: 20 }, openLabel = { x: 350, y: 300, width: 50, height: 20 };
    const input = routingFixture(layout, [first, second, addressed], { messages: [record(first.relationMessageId)],
      labelBboxes: { first: closedLabel, second: openLabel } });
    const original = structuredClone(addressed);
    const result = routeGraphEdges({ ...input, edges: [second, addressed], hiddenMessageIds: new Set(['first-target']) });
    const incoming = result.find(path => path.edge.id === addressed.id)!;
    const target = result.find(path => path.edge.id === second.id)!;
    const currentLabel = { ...openLabel, x: target.labelX - openLabel.width / 2, y: target.labelY - openLabel.height / 2 };
    expect(incoming.toBox).toEqual(currentLabel);
    expect(pointOnRect(incoming.end, currentLabel)).toBe(true);
    expect(incoming.toBox).not.toEqual(closedLabel);
    expect(incoming.edge).toBe(addressed);
    expect(addressed).toEqual(original);
    expect(result.some(path => path.edge.id === first.id)).toBe(false);
  });

  it('keeps legacy stance resolution on the full archive catalog while hiding only its visual endpoints', () => {
    const data: ExportData = {
      formatVersion: 1, exportedAt: '', scope: { messageId: null, title: '' },
      messages: [
        ...['A', 'B', 'C'].map(id => ({ id, kind: 'TEXT', contentType: 'TEXT', content: '', createdAt: '', authorId: 'fixture', author: '结构测试' })),
        ...['R', 'D'].map(id => ({ id, kind: 'RELATION', contentType: null, content: null, createdAt: '', authorId: 'fixture', author: '结构测试' })),
      ],
      relations: [
        { id: 'R', relationType: 'AGREE', sourceMessageId: 'B', targetRefs: [{ kind: 'message', messageId: 'A' }], payload: null, createdAt: '', authorId: 'fixture', author: '结构测试', supersededBy: null },
        { id: 'D', relationType: 'DISAGREE', sourceMessageId: 'C', targetRefs: [{ kind: 'relation', relationId: 'R' }], payload: null, createdAt: '', authorId: 'fixture', author: '结构测试', supersededBy: null },
      ],
    };
    const projected = projectWorkbenchSnapshot(archiveToWorkbenchSnapshot(data));
    const opposition = projected.edges.find(edge => edge.relationMessageId === 'D')!;
    const original = structuredClone(projected), byId = new Map(projected.messages.map(message => [message.id, message]));
    const stances = buildStanceTargetMap(projected.edges, byId);
    const resolve = () => resolveDisplayedStance(opposition, byId, stances);
    expect(resolve()?.targetId).toBe('A');
    const input = routingFixture({ A: { x: 0, y: 0, width: 300, height: 100 }, B: { x: 600, y: 0, width: 300, height: 100 },
      C: { x: 600, y: 300, width: 300, height: 100 } }, projected.edges, { messages: projected.messages });
    routeGraphEdges(input);
    routeGraphEdges({ ...input, hiddenMessageIds: new Set(['B']) });
    expect(resolve()?.targetId).toBe('A');
    expect(opposition.to).toEqual(original.edges.find(edge => edge.id === opposition.id)!.to);
    expect(opposition.to.messageId).toBe('R');
    expect(projected).toEqual(original);
  });

  it('does not change an executed stance address or its declared selection while routing a folded view', () => {
    const support = routingEdge('support', 'B', 'A', 'agree');
    const opposition = routingEdge('opposition', 'C', support.relationMessageId, 'disagree');
    opposition.to.reference = { messageId: support.relationMessageId, revision: 1, partId: 'relation' };
    const vote = record(opposition.relationMessageId, 'disagree');
    vote.executedStance = { partId: 'relation', sourceRevision: 1, side: 'con', target: { messageId: 'A' } };
    const messages = [record(support.relationMessageId, 'agree'), vote], edges = [support, opposition], original = structuredClone(edges);
    const before = projectStanceLayoutEdges(messages, edges)[1];
    const input = routingFixture({ A: { x: 0, y: 0, width: 300, height: 100 }, B: { x: 600, y: 0, width: 300, height: 100 },
      C: { x: 600, y: 300, width: 300, height: 100 } }, edges, { messages });
    routeGraphEdges({ ...input, hiddenMessageIds: new Set(['B']) });
    expect(projectStanceLayoutEdges(messages, edges)[1].to).toEqual(before.to);
    expect(before.to.messageId).toBe('A');
    expect(edges).toEqual(original);
    expect(opposition.to.messageId).toBe(support.relationMessageId);
  });
});
