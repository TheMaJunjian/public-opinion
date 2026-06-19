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
import type { ContainerExpansionResult } from '../utils/focusContainer';
import type { DemoEdge, UnitSelection } from '../utils/modelBridge';

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

  // ── focusHop=1, minDist=0 (focus is inside container) ──

  it('shows card but does NOT expand at focusHop=1, minDist=0 (partial expansion)', () => {
    // A is focus (dist=0), A is child of classify1
    const dist = new Map<string, number>([['a', 0]]);
    const result = resolveOneContainer('classify1', new Set(['a', 'b', 'c']), dist, 1);
    expect(result).not.toBeNull();
    expect(result!.cardVisible).toBe(true);
    expect(result!.expanded).toBe(false);
    expect(result!.minDist).toBe(0);
    expect(result!.newChildren).toEqual([]);
  });

  it('shows card only when focus is inside container, even with multiple visible children at dist=0', () => {
    const dist = new Map<string, number>([['a', 0], ['b', 0]]);
    const result = resolveOneContainer('classify1', new Set(['a', 'b', 'c']), dist, 1);
    expect(result).not.toBeNull();
    expect(result!.cardVisible).toBe(true);
    // minDist=0, focusHop=1: fullExpand = (0+1<=1 && 1>=2) = false
    // crossRefExpand = (0>0) = false
    expect(result!.expanded).toBe(false);
  });

  // ── focusHop=1, minDist>0 (child reached via cross-reference) ──

  it('expands via cross-reference at focusHop=1 when child is visible (minDist>0)', () => {
    // A is focus (dist=0), C is child of classify1 at dist=1 (reached via reference)
    const dist = new Map<string, number>([['a', 0], ['c', 1]]);
    const result = resolveOneContainer('classify1', new Set(['c', 'd']), dist, 1);
    expect(result).not.toBeNull();
    expect(result!.cardVisible).toBe(true);
    expect(result!.expanded).toBe(true);
    expect(result!.minDist).toBe(1);
    // 'c' already in dist, 'd' is new
    expect(result!.newChildren).toEqual(['d']);
  });

  it('shows card only when child is at boundary with no other visible children', () => {
    // A is focus (dist=0), D is child at dist=1, no other children visible
    const dist = new Map<string, number>([['a', 0], ['d', 1]]);
    const result = resolveOneContainer('classify1', new Set(['d', 'e']), dist, 1);
    expect(result).not.toBeNull();
    expect(result!.cardVisible).toBe(true);
    // minDist=1, hasVisibleChild=true (d is in dist), crossRefExpand=(1>0 && true)=true
    expect(result!.expanded).toBe(true);
    expect(result!.newChildren).toEqual(['e']);
  });

  // ── focusHop=2, full expansion ──

  it('fully expands at focusHop=2, minDist=0', () => {
    const dist = new Map<string, number>([['a', 0]]);
    const result = resolveOneContainer('classify1', new Set(['a', 'b', 'c']), dist, 2);
    expect(result).not.toBeNull();
    expect(result!.cardVisible).toBe(true);
    expect(result!.expanded).toBe(true);
    expect(result!.minDist).toBe(0);
    expect(result!.newChildren).toEqual(['b', 'c']);
  });

  it('fully expands at focusHop=2, minDist=1', () => {
    // A is focus, B is 1 hop away (child of classify1)
    const dist = new Map<string, number>([['a', 0], ['b', 1]]);
    const result = resolveOneContainer('classify1', new Set(['b', 'c']), dist, 2);
    expect(result).not.toBeNull();
    expect(result!.expanded).toBe(true);
    expect(result!.minDist).toBe(1);
    expect(result!.newChildren).toEqual(['c']);
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
    // fullExpand = (1+1<=1 && 1>=2) = false
    // crossRefExpand = (1>0 && false) = false
    expect(result!.expanded).toBe(false);
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
    applyContainerExpansion(dist, edges, 1);
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
    expect(dist.get('classify1')).toBe(0);
    // Children NOT added (partial expansion)
    expect(dist.has('b')).toBe(false);
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
    // New children get distance minDist+1=1
    expect(dist.get('b')).toBe(1);
    expect(dist.get('c')).toBe(1);
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
    expect(dist.has('classify1')).toBe(true);
    // Cross-ref expansion: 'd' added
    expect(dist.has('d')).toBe(true);
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
    // classify1: minDist=0, card visible, no expansion
    expect(dist.has('classify1')).toBe(true);
    expect(dist.has('b')).toBe(false);
    // classify2: minDist=1, cross-ref expansion
    expect(dist.has('classify2')).toBe(true);
    expect(dist.has('e')).toBe(true);
  });

  it('handles MERGE containers the same as CLASSIFY', () => {
    const dist = new Map<string, number>([['a', 0]]);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'merge1', 'merge', 'anon:merge1', 'a'),
      makeEdge('e2', 'merge1', 'merge', 'anon:merge1', 'b'),
    ];
    applyContainerExpansion(dist, edges, 2);
    expect(dist.has('merge1')).toBe(true);
    expect(dist.has('b')).toBe(true);
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

  it('does NOT treat ARRANGE as container', () => {
    const dist = new Map<string, number>([['a', 0]]);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'arrange1', 'arrange', 'anon:arrange1', 'a'),
    ];
    applyContainerExpansion(dist, edges, 1);
    // ARRANGE is not a container type
    expect(dist.has('arrange1')).toBe(false);
  });
});
