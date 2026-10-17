import { describe, expect, it } from 'vitest';
import { applyTraceFrameVisibility, buildTraceProjection } from '../utils/traceProjection';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';
import { convertMessagesToDemoModel, type DemoEdge, type DemoMessage } from '../utils/modelBridge';
import type { Relation } from '../types';

const message = (id: string, relationType?: DemoMessage['relationType']): DemoMessage => ({
  id, kind: relationType ? 'relation' : 'normal', relationType, content: id, author: 'tester', createdAt: '',
});
const edge = (owner: string, type: DemoEdge['relationType'], target: string, source = `anon:${owner}`): DemoEdge => ({
  id: `${owner}:${target}`, relationMessageId: owner, relationType: type, relationLabel: type,
  from: { messageId: source, selection: { kind: 'whole' } }, to: { messageId: target, selection: { kind: 'whole' } },
});

describe('trace boundaries', () => {
  it('does not expose an arrangement sibling at distance one through a reference in the parent classification', () => {
    const messages = [message('A', 'classify'), message('B', 'classify'), message('C', 'arrange'),
      message('D'), message('E'), message('F'), message('ref', 'reference')];
    const edges = [edge('A', 'classify', 'B'), edge('B', 'classify', 'E'), edge('B', 'classify', 'C'),
      edge('C', 'arrange', 'D'), edge('C', 'arrange', 'F'), edge('ref', 'reference', 'D', 'E')];
    for (const distance of [1, 2]) {
      const trace = buildTraceProjection({ messages, edges, startIds: ['E'], distance });
      expect(trace.messages.some(item => item.id === 'F')).toBe(distance === 2);
      const expanded = applyTraceFrameVisibility(trace, new Set(['A', 'B']));
      expect(expanded.messages.some(item => item.id === 'F')).toBe(distance === 2);
      expect(expanded.messages.some(item => item.id === 'D')).toBe(true);
      expect(expanded.edges.some(item => item.relationMessageId === 'C' && item.to.messageId === 'F')).toBe(distance === 2);
    }
  });

  it.each(['merge', 'arrange'] as const)('does not complete %s members beyond the distance limit', type => {
    const messages = [message('anchor'), message('near'), message('far'), message('ref', 'reference'), message('group', type)];
    const edges = [edge('ref', 'reference', 'near', 'anchor'), edge('group', type, 'near'), edge('group', type, 'far')];
    const one = buildTraceProjection({ messages, edges, startIds: ['anchor'], distance: 1 });
    expect(one.messages.map(item => item.id)).not.toContain('far');
    const two = buildTraceProjection({ messages, edges, startIds: ['anchor'], distance: 2 });
    expect(two.messages.map(item => item.id)).toContain('far');
  });

  it.each(['summary', 'merge', 'arrange'] as const)('keeps expanded grandchildren behind a collapsed ancestor through %s regardless of record order', type => {
    const messages = [message('outer', 'classify'), message('middle', type), message('inner', 'classify'), message('leaf')];
    const edges = [edge('outer', 'classify', 'middle'), edge('middle', type, 'inner'), edge('inner', 'classify', 'leaf')];
    for (const ordered of [messages, [...messages].reverse()]) {
      const trace = buildTraceProjection({ messages: ordered, edges, startIds: ['leaf'], distance: 3 });
      const collapsed = applyTraceFrameVisibility(trace, new Set(['inner']));
      expect(collapsed.messages.map(item => item.id)).toEqual(['outer']);
      const expanded = applyTraceFrameVisibility(trace, new Set(['outer', 'middle', 'inner']));
      expect(new Set(expanded.messages.map(item => item.id))).toEqual(new Set(messages.map(item => item.id)));
    }
  });

  it('does not restore a migrated multi-target JOIN member that moved to another classification', () => {
    const user = { id: 'tester', username: 'tester', createdAt: '' };
    const relation = (id: string, type: string, targets: string[], source: string | null = null, createdAt = '2026-01-01'): Relation => ({
      id, relationType: type, sourceMessageId: source, targetRefs: targets.map(messageId => ({ kind: 'message', messageId })),
      createdAt, createdBy: user,
    });
    const relations = [relation('old', 'CLASSIFY', []), relation('current', 'CLASSIFY', []),
      relation('old-join', 'JOIN', ['moved', 'stayed'], 'old'), relation('new-join', 'JOIN', ['moved'], 'current', '2026-01-02')];
    const model = convertMessagesToDemoModel(['moved', 'stayed'].map(id => ({
      id, kind: 'TEXT', content: id, contentType: 'TEXT', createdAt: '', createdBy: user,
    })), relations);
    const effect = deriveContainerEffect({ ...model, relations, username: 'tester' });
    const trace = buildTraceProjection({ messages: effect.messages, edges: effect.edges, containerMemberships: effect.memberships,
      startIds: ['old'], distance: 1 });
    expect(trace.messages.map(item => item.id)).not.toContain('moved');
    expect(trace.messages.map(item => item.id)).toContain('stayed');
  });
});
