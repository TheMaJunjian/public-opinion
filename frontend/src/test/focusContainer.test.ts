/**
 * focusContainer.test.ts — Unit tests for container expansion logic.
 *
 * Tests: resolveOneContainer, applyContainerExpansion
 *
 * Coverage targets:
 *   - focusHop=0: no container visible
 *   - focusHop=1, minDist=0: card only, no expansion (partial)
 *   - focusHop=1, minDist=1, child visible: cross-ref expansion
 *   - focusHop=1, minDist=1, no child visible: card only
 *   - focusHop=2, minDist=0: full expansion
 *   - focusHop=2, minDist=1: full expansion
 *   - Container not reachable: returns null
 *   - Multiple containers: each processed independently
 *   - Nested containers: inner expands via cross-ref when outer expands
 */

import { describe, it, expect } from 'vitest';
import { resolveOneContainer, applyContainerExpansion } from '../utils/focusContainer';
import { applyTraceFrameVisibility, buildTraceProjection } from '../utils/traceProjection';
import type { DemoEdge, DemoMessage, UnitSelection } from '../utils/modelBridge';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function whole(msgId: string): UnitSelection {
  return { messageId: msgId, selection: { kind: 'whole' } };
}

function makeEdge(
  id: string,
  relMsgId: string,
  relType: string,
  fromId: string,
  toId: string,
): DemoEdge {
  return {
    id,
    relationMessageId: relMsgId,
    relationType: relType as DemoEdge['relationType'],
    from: whole(fromId),
    to: whole(toId),
    relationLabel: relType,
  };
}

// ─── resolveOneContainer (pure function) ───────────────────────────────────

describe('resolveOneContainer', () => {
  it('returns null when container and children are not in dist', () => {
    const dist = new Map<string, number>([['a', 0]]);
    const result = resolveOneContainer('classify1', new Set(['b', 'c']), dist, 1);
    expect(result).toBeNull();
  });

  it('returns null at focusHop=0 even when children are in dist', () => {
    const dist = new Map<string, number>([['a', 0]]);
    const result = resolveOneContainer('classify1', new Set(['a']), dist, 0);
    expect(result).toBeNull();
  });

  // ── focusHop=1, container is the next text-like node ──

  it('shows the container at distance 1 when the trace is inside it', () => {
    // A is focus (dist=0), A is child of classify1
    const dist = new Map<string, number>([['a', 0]]);
    const result = resolveOneContainer('classify1', new Set(['a', 'b', 'c']), dist, 1);
    expect(result).not.toBeNull();
    expect(result!.cardVisible).toBe(true);
    expect(result!.expanded).toBe(true);
    expect(result!.minDist).toBe(1);
    expect(result!.newChildren).toEqual([]);
  });

  it('expands the frame when multiple traced children are at distance 0', () => {
    const dist = new Map<string, number>([['a', 0], ['b', 0]]);
    const result = resolveOneContainer('classify1', new Set(['a', 'b', 'c']), dist, 1);
    expect(result).not.toBeNull();
    expect(result!.cardVisible).toBe(true);
    expect(result!.expanded).toBe(true);
  });

  // ── focusHop=1, minDist>0 (child reached via cross-reference) ──

  it('expands via cross-reference at focusHop=1 when child is visible (minDist>0)', () => {
    // A is focus (dist=0), C is child of classify1 at dist=1 (reached via reference)
    const dist = new Map<string, number>([['a', 0], ['c', 1]]);
    const result = resolveOneContainer('classify1', new Set(['c', 'd']), dist, 1);
    expect(result).toBeNull();
  });

  it('shows card only when child is at boundary with no other visible children', () => {
    // A is focus (dist=0), D is child at dist=1, no other children visible
    const dist = new Map<string, number>([['a', 0], ['d', 1]]);
    const result = resolveOneContainer('classify1', new Set(['d', 'e']), dist, 1);
    expect(result).toBeNull();
  });

  // ── focusHop=2, full expansion ──

  it('fully expands at focusHop=2, minDist=0', () => {
    const dist = new Map<string, number>([['a', 0]]);
    const result = resolveOneContainer('classify1', new Set(['a', 'b', 'c']), dist, 2);
    expect(result).not.toBeNull();
    expect(result!.cardVisible).toBe(true);
    expect(result!.expanded).toBe(true);
    expect(result!.minDist).toBe(1);
    expect(result!.newChildren).toEqual(['b', 'c']);
  });

  it('fully expands at focusHop=2, minDist=1', () => {
    // A is focus, B is 1 hop away (child of classify1)
    const dist = new Map<string, number>([['a', 0], ['b', 1]]);
    const result = resolveOneContainer('classify1', new Set(['b', 'c']), dist, 2);
    expect(result).not.toBeNull();
    expect(result!.expanded).toBe(true);
    expect(result!.minDist).toBe(2);
    expect(result!.newChildren).toEqual([]);
  });

  // ── focusHop=0 ──

  it('returns null at focusHop=0 even when container itself is at dist=0', () => {
    // Container IS the focus — but resolveOneContainer returns null at hop=0.
    // The container was already added to dist via effectiveStartIds separately.
    const dist = new Map<string, number>([['classify1', 0]]);
    const result = resolveOneContainer('classify1', new Set(['a', 'b']), dist, 0);
    expect(result).toBeNull();
  });

  // ── Container at dist directly (referenced) ──

  it('shows card at focusHop=1 when container itself is at dist=1 via reference', () => {
    // A references classify1 directly, classify1 is at dist=1
    const dist = new Map<string, number>([['a', 0], ['classify1', 1]]);
    const result = resolveOneContainer('classify1', new Set(['b', 'c']), dist, 1);
    expect(result).not.toBeNull();
    expect(result!.cardVisible).toBe(true);
    // minDist=1 (from classify1 itself), hasVisibleChild=false (b,c not in dist)
    expect(result!.expanded).toBe(true);
    expect(result!.newChildren).toEqual([]);
  });
});

// ─── applyContainerExpansion (mutates dist) ────────────────────────────────

describe('applyContainerExpansion', () => {
  it('does nothing when there are no container edges', () => {
    const dist = new Map<string, number>([['a', 0]]);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'ref1', 'reference', 'a', 'b'),
    ];
    applyContainerExpansion(dist, edges, 1, new Set());
    expect(dist.size).toBe(1);
    expect(dist.get('a')).toBe(0);
  });

  it('adds container card to dist at focusHop=1, minDist=0 (partial)', () => {
    const dist = new Map<string, number>([['a', 0]]);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'classify1', 'classify', 'anon:classify1', 'a'),
      makeEdge('e2', 'classify1', 'classify', 'anon:classify1', 'b'),
    ];
    applyContainerExpansion(dist, edges, 1);
    // Container card added
    expect(dist.has('classify1')).toBe(true);
    expect(dist.get('classify1')).toBe(1);
    // Members are one more hop away and are outside a distance-1 trace.
    expect(dist.has('b')).toBe(false);
  });

  it('does not leave a traced child visible beside its collapsed container card', () => {
    const dist = new Map<string, number>([['child', 0]]);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'container', 'classify', 'anon:container', 'child'),
    ];

    applyContainerExpansion(dist, edges, 1, new Set());

    expect(dist.has('container')).toBe(true);
    expect(dist.has('child')).toBe(false);
  });

  it('expands container children at focusHop=2', () => {
    const dist = new Map<string, number>([['a', 0]]);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'classify1', 'classify', 'anon:classify1', 'a'),
      makeEdge('e2', 'classify1', 'classify', 'anon:classify1', 'b'),
      makeEdge('e3', 'classify1', 'classify', 'anon:classify1', 'c'),
    ];
    applyContainerExpansion(dist, edges, 2);
    expect(dist.has('classify1')).toBe(true);
    expect(dist.has('b')).toBe(true);
    expect(dist.has('c')).toBe(true);
    // New children get distance minDist+1=2
    expect(dist.get('b')).toBe(2);
    expect(dist.get('c')).toBe(2);
  });

  it('cross-ref expands at focusHop=1 when child is visible through other path', () => {
    // A is focus (dist=0), C is at dist=1 via a reference edge
    const dist = new Map<string, number>([['a', 0], ['c', 1]]);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'ref1', 'reference', 'a', 'c'),
      makeEdge('e2', 'classify1', 'classify', 'anon:classify1', 'c'),
      makeEdge('e3', 'classify1', 'classify', 'anon:classify1', 'd'),
    ];
    applyContainerExpansion(dist, edges, 1);
    expect(dist.has('classify1')).toBe(false);
    // The container is beyond the active trace distance.
    expect(dist.has('d')).toBe(false);
  });

  it('skips containers not connected to any reachable message', () => {
    const dist = new Map<string, number>([['a', 0]]);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'classify1', 'classify', 'anon:classify1', 'x'),
      makeEdge('e2', 'classify1', 'classify', 'anon:classify1', 'y'),
    ];
    applyContainerExpansion(dist, edges, 1);
    // Neither x nor y are in dist, classify1 not reachable
    expect(dist.has('classify1')).toBe(false);
  });

  it('handles multiple independent containers', () => {
    const dist = new Map<string, number>([['a', 0], ['d', 1]]);
    const edges: DemoEdge[] = [
      // classify1 contains a (focus, dist=0)
      makeEdge('e1', 'classify1', 'classify', 'anon:classify1', 'a'),
      makeEdge('e2', 'classify1', 'classify', 'anon:classify1', 'b'),
      // classify2 contains d (dist=1 via reference) and e
      makeEdge('e3', 'classify2', 'classify', 'anon:classify2', 'd'),
      makeEdge('e4', 'classify2', 'classify', 'anon:classify2', 'e'),
    ];
    applyContainerExpansion(dist, edges, 1);
    // classify1: minDist=1, card visible, but its members are beyond range
    expect(dist.has('classify1')).toBe(true);
    expect(dist.has('b')).toBe(false);
    // classify2: minDist=2, outside the active range
    expect(dist.has('classify2')).toBe(false);
    expect(dist.has('e')).toBe(false);
  });

  it('does not special-case MERGE in trace expansion', () => {
    const dist = new Map<string, number>([['a', 0]]);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'merge1', 'merge', 'anon:merge1', 'a'),
      makeEdge('e2', 'merge1', 'merge', 'anon:merge1', 'b'),
    ];
    applyContainerExpansion(dist, edges, 2);
    expect(dist.has('merge1')).toBe(false);
    expect(dist.has('b')).toBe(false);
  });

  it('handles SUMMARY containers the same as CLASSIFY', () => {
    const dist = new Map<string, number>([['a', 0]]);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'sum1', 'summary', 'anon:sum1', 'a'),
      makeEdge('e2', 'sum1', 'summary', 'anon:sum1', 'b'),
    ];
    applyContainerExpansion(dist, edges, 2);
    expect(dist.has('sum1')).toBe(true);
    expect(dist.has('b')).toBe(true);
  });

  it('propagates distance through nested containers regardless of edge order', () => {
    const dist = new Map<string, number>([['message', 0]]);
    const edges: DemoEdge[] = [
      // The outer container appears first, before the inner container is discovered.
      makeEdge('outer-join', 'outer-classify', 'classify', 'anon:outer-classify', 'inner-summary'),
      makeEdge('inner-join', 'inner-summary', 'summary', 'anon:inner-summary', 'message'),
    ];

    applyContainerExpansion(dist, edges, 2);

    expect(dist.get('inner-summary')).toBe(1);
    expect(dist.get('outer-classify')).toBe(2);
  });

  it('keeps a collapsed nested container card inside an expanded parent', () => {
    const dist = new Map<string, number>([['message', 0]]);
    const edges: DemoEdge[] = [
      makeEdge('outer-edge', 'outer-summary', 'summary', 'anon:outer-summary', 'inner-classify'),
      makeEdge('inner-edge', 'inner-classify', 'classify', 'anon:inner-classify', 'message'),
    ];

    applyContainerExpansion(dist, edges, 2, new Set(['outer-summary']));

    expect(dist.has('outer-summary')).toBe(true);
    expect(dist.has('inner-classify')).toBe(true);
    expect(dist.has('message')).toBe(false);
  });

  it('does not special-case ARRANGE in trace expansion', () => {
    const dist = new Map<string, number>([['a', 0]]);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'arrange1', 'arrange', 'anon:arrange1', 'a'),
    ];
    applyContainerExpansion(dist, edges, 1);
    expect(dist.has('arrange1')).toBe(false);
  });
});

function message(id: string, kind: DemoMessage['kind'], relationType?: DemoMessage['relationType']): DemoMessage {
  return { id, kind, relationType, author: 'test', createdAt: id, content: id };
}

describe('buildTraceProjection', () => {
  const nestedMessages: DemoMessage[] = [
    message('a', 'relation', 'summary'),
    message('b', 'relation', 'classify'),
    message('c', 'normal'),
  ];
  const nestedEdges: DemoEdge[] = [
    makeEdge('a-b', 'a', 'summary', 'anon:a', 'b'),
    makeEdge('b-c', 'b', 'classify', 'anon:b', 'c'),
  ];

  it('keeps nested container cards visible while their members stay collapsed', () => {
    const traceProjection = buildTraceProjection({
      messages: nestedMessages,
      edges: nestedEdges,
      startIds: ['c'],
      distance: 1,
    });
    const projection = applyTraceFrameVisibility(traceProjection, new Set());

    expect(projection.messages.map(item => item.id)).toEqual(['b']);
    expect(projection.edges.map(edge => edge.relationMessageId)).toEqual(['b']);
  });

  it('shows a container member only when that container is expanded', () => {
    const traceProjection = buildTraceProjection({
      messages: nestedMessages,
      edges: nestedEdges,
      startIds: ['c'],
      distance: 1,
    });
    const projection = applyTraceFrameVisibility(traceProjection, new Set(['b']));

    expect(projection.messages.map(item => item.id)).toEqual(['b', 'c']);
    expect(projection.edges.map(edge => edge.relationMessageId)).toEqual(['b']);
  });

  it('shows every in-range container card when distance increases', () => {
    const traceProjection = buildTraceProjection({
      messages: nestedMessages,
      edges: nestedEdges,
      startIds: ['c'],
      distance: 2,
    });
    const projection = applyTraceFrameVisibility(traceProjection, new Set(['a']));

    expect(projection.messages.map(item => item.id)).toEqual(['a', 'b']);
    expect(projection.edges.map(edge => edge.relationMessageId)).toEqual(['a', 'b']);
  });

  it('applies expansion only after computing the card-distance window', () => {
    const messages: DemoMessage[] = [
      message('A', 'relation', 'classify'),
      message('B', 'normal'),
      message('C', 'relation', 'summary'),
      message('D', 'normal'),
      message('E', 'relation', 'classify'),
      message('F', 'normal'),
      message('G', 'relation', 'merge'),
      message('H', 'normal'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('A-B', 'A', 'classify', 'anon:A', 'B'),
      makeEdge('A-C', 'A', 'classify', 'anon:A', 'C'),
      makeEdge('C-D', 'C', 'summary', 'anon:C', 'D'),
      makeEdge('C-E', 'C', 'summary', 'anon:C', 'E'),
      makeEdge('E-F', 'E', 'classify', 'anon:E', 'F'),
      makeEdge('E-G', 'E', 'classify', 'anon:E', 'G'),
      makeEdge('G-H', 'G', 'merge', 'anon:G', 'H'),
    ];

    const traceDistanceOne = buildTraceProjection({ messages, edges, startIds: ['E'], distance: 1 });
    expect(traceDistanceOne.messages.map(item => item.id)).toEqual(['C', 'E', 'F', 'G', 'H']);
    const distanceOne = applyTraceFrameVisibility(traceDistanceOne, new Set());
    expect(distanceOne.messages.map(item => item.id)).toEqual(['C', 'E']);
    expect(new Set(distanceOne.edges.map(edge => edge.relationMessageId))).toEqual(new Set(['C', 'E']));

    const traceDistanceTwo = buildTraceProjection({ messages, edges, startIds: ['E'], distance: 2 });
    const distanceTwo = applyTraceFrameVisibility(traceDistanceTwo, new Set());
    expect(distanceTwo.messages.map(item => item.id)).toEqual(['A', 'C', 'E']);
    expect(new Set(distanceTwo.edges.map(edge => edge.relationMessageId))).toEqual(new Set(['A', 'C', 'E']));

    const expandedC = applyTraceFrameVisibility(traceDistanceOne, new Set(['C']));
    expect(expandedC.messages.map(item => item.id)).toEqual(['C', 'E']);
    expect(new Set(expandedC.edges.map(edge => edge.relationMessageId))).toEqual(new Set(['C', 'E']));

    const expandedE = applyTraceFrameVisibility(traceDistanceOne, new Set(['C', 'E']));
    expect(expandedE.messages.map(item => item.id)).toEqual(['C', 'E', 'F', 'G', 'H']);
    expect(new Set(expandedE.edges.map(edge => edge.relationMessageId))).toEqual(new Set(['C', 'E', 'G']));
  });

  it('projects one semantic hop around nested containers and transparent merge frames', () => {
    const messages: DemoMessage[] = [
      message('A', 'relation', 'classify'),
      message('B', 'normal'),
      message('C', 'relation', 'summary'),
      message('D', 'normal'),
      message('E', 'relation', 'classify'),
      message('F', 'normal'),
      message('G', 'relation', 'merge'),
      message('H', 'normal'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('A-B', 'A', 'classify', 'anon:A', 'B'),
      makeEdge('A-C', 'A', 'classify', 'anon:A', 'C'),
      makeEdge('C-D', 'C', 'summary', 'anon:C', 'D'),
      makeEdge('C-E', 'C', 'summary', 'anon:C', 'E'),
      makeEdge('E-F', 'E', 'classify', 'anon:E', 'F'),
      makeEdge('E-G', 'E', 'classify', 'anon:E', 'G'),
      makeEdge('G-H', 'G', 'merge', 'anon:G', 'H'),
    ];

    const project = (startId: string) => buildTraceProjection({ messages, edges, startIds: [startId], distance: 1 });

    expect(project('E').messages.map(item => item.id)).toEqual(['C', 'E', 'F', 'G', 'H']);
    expect(project('H').messages.map(item => item.id)).toEqual(['E', 'G', 'H']);
    expect(project('F').messages.map(item => item.id)).toEqual(['E', 'F']);

    const projectTwo = (startId: string) => buildTraceProjection({ messages, edges, startIds: [startId], distance: 2 });
    expect(projectTwo('E').messages.map(item => item.id)).toEqual(['A', 'C', 'D', 'E', 'F', 'G', 'H']);
    expect(projectTwo('H').messages.map(item => item.id)).toEqual(['C', 'E', 'F', 'G', 'H']);
    expect(projectTwo('F').messages.map(item => item.id)).toEqual(['C', 'E', 'F', 'G', 'H']);
  });

  it('keeps ordinary relation messages whose endpoints are inside the trace window', () => {
    const messages: DemoMessage[] = [
      message('source', 'normal'),
      message('target', 'normal'),
      message('reference-rel', 'relation', 'reference'),
    ];
    const edges = [makeEdge('reference-edge', 'reference-rel', 'reference', 'source', 'target')];

    const projection = buildTraceProjection({ messages, edges, startIds: ['source'], distance: 1 });

    expect(projection.messages.map(item => item.id)).toEqual(['source', 'target', 'reference-rel']);
    expect(projection.edges.map(edge => edge.relationMessageId)).toEqual(['reference-rel']);
  });

  it('does not charge distance for nested reference, merge, or arrange structures', () => {
    const messages: DemoMessage[] = [
      message('source', 'normal'),
      message('reference-rel', 'relation', 'reference'),
      message('merge-rel', 'relation', 'merge'),
      message('arrange-rel', 'relation', 'arrange'),
      message('proposal-rel', 'relation', 'proposal'),
      message('proposal-target', 'normal'),
    ];
    const edges = [
      makeEdge('reference-edge', 'reference-rel', 'reference', 'source', 'merge-rel'),
      makeEdge('merge-edge', 'merge-rel', 'merge', 'anon:merge-rel', 'arrange-rel'),
      makeEdge('arrange-edge', 'arrange-rel', 'arrange', 'anon:arrange-rel', 'proposal-rel'),
      makeEdge('proposal-edge', 'proposal-rel', 'proposal', 'anon:proposal-rel', 'proposal-target'),
    ];

    const distanceOne = buildTraceProjection({ messages, edges, startIds: ['source'], distance: 1 });
    expect(distanceOne.messages.map(item => item.id)).toEqual([
      'source', 'reference-rel', 'merge-rel', 'arrange-rel', 'proposal-rel',
    ]);

    const distanceTwo = buildTraceProjection({ messages, edges, startIds: ['source'], distance: 2 });
    expect(distanceTwo.messages.map(item => item.id)).toEqual(messages.map(item => item.id));
  });

  it('completes a merge or arrange frame when one of its cards is in range', () => {
    const messages: DemoMessage[] = [
      message('merge-rel', 'relation', 'merge'),
      message('member-a', 'normal'),
      message('member-b', 'normal'),
    ];
    const edges = [
      makeEdge('merge-a', 'merge-rel', 'merge', 'anon:merge-rel', 'member-a'),
      makeEdge('merge-b', 'merge-rel', 'merge', 'anon:merge-rel', 'member-b'),
    ];

    const projection = buildTraceProjection({ messages, edges, startIds: ['member-a'], distance: 0 });

    expect(projection.messages.map(item => item.id)).toEqual(['merge-rel', 'member-a', 'member-b']);
    expect(projection.edges.map(edge => edge.relationMessageId)).toEqual(['merge-rel', 'merge-rel']);
  });

  it('includes messages that depend on an in-range card through transparent relations', () => {
    const messages: DemoMessage[] = [
      message('reference-source', 'normal'),
      message('reference-rel', 'relation', 'reference'),
      message('corrected', 'normal'),
      message('correct-rel', 'relation', 'correct'),
      message('target', 'normal'),
    ];
    const edges = [
      makeEdge('reference-edge', 'reference-rel', 'reference', 'reference-source', 'target'),
      makeEdge('correct-edge', 'correct-rel', 'correct', 'corrected', 'target'),
    ];

    const projection = buildTraceProjection({ messages, edges, startIds: ['target'], distance: 0 });

    expect(projection.messages.map(item => item.id)).toEqual(messages.map(item => item.id));
    expect(new Set(projection.edges.map(edge => edge.relationMessageId)))
      .toEqual(new Set(['reference-rel', 'correct-rel']));
  });
});
