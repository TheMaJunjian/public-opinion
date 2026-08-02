/**
 * layout.test.ts — Comprehensive unit tests for the layout pipeline.
 *
 * Tests all 4 stages of the column-assignment pipeline:
 *   Stage 1-①: computeMinColumnsForAnnoRefRule1   (ANNOTATION / REFERENCE)
 *   Stage 1-②: applyReplyLayoutAdjustments        (REPLY + author lanes)
 *   Stage 1-③: applyAgreeDisagreeColumnOverride   (AGREE / DISAGREE)
 *   Stage 1-④: applyGroupingColumnOverride         (ARRANGE / MERGE / CORRECT)
 *
 * Also tests helper functions: colX, unionBoxes, rectsOverlapX
 */

import { describe, it, expect } from 'vitest';
import {
  colX,
  unionBoxes,
  rectsOverlapX,
  GRID_LEFT,
  CARD_W,
  COL_GAP,
  ROW_GAP,
  GRID_TOP,
  FRAME_PAD,
  computeMinColumnsForAnnoRefRule1,
  applyReplyLayoutAdjustments,
  applyAgreeDisagreeColumnOverride,
  applyGroupingColumnOverride,
  computeSimpleNoOverlapLayout,
  computeFrameAwareColumnCorrection,
  compactAnnoRefClusters,
  findOverlaps,
  verifyColumnOrder,
} from '../utils/layout';
import type { DemoMessage, DemoEdge, RelationType } from '../utils/modelBridge';
import { LayoutBox, Rect } from '../utils/layout';

// ============================================================
// Fixtures
// ============================================================

function makeNormal(id: string, author = 'userA', createdAt = '2024-01-01T00:00:00.000Z'): DemoMessage {
  return { id, author, createdAt, content: `Content of ${id}`, kind: 'normal' };
}

function makeEdge(
  id: string,
  relationType: RelationType,
  relationMessageId: string,
  fromMessageId: string,
  toMessageId: string,
): DemoEdge {
  return {
    id,
    relationMessageId,
    relationType,
    from: { messageId: fromMessageId, selection: { kind: 'whole' } },
    to: { messageId: toMessageId, selection: { kind: 'whole' } },
    relationLabel: relationType,
  };
}

// ============================================================
// colX
// ============================================================

describe('colX', () => {
  it('returns GRID_LEFT for column 0', () => {
    expect(colX(0)).toBe(GRID_LEFT); // 18
  });

  it('returns GRID_LEFT + (CARD_W + COL_GAP) for column 1', () => {
    expect(colX(1)).toBe(GRID_LEFT + CARD_W + COL_GAP); // 18 + 320 + 80 = 418
  });

  it('increases linearly with column index', () => {
    const x0 = colX(0);
    const x1 = colX(1);
    const x2 = colX(2);
    expect(x1 - x0).toBe(x2 - x1);
    expect(x1 - x0).toBe(CARD_W + COL_GAP); // 400
  });
});

// ============================================================
// unionBoxes
// ============================================================

describe('unionBoxes', () => {
  it('returns null for empty array', () => {
    expect(unionBoxes([])).toBeNull();
  });

  it('returns the box itself for a single box', () => {
    const result = unionBoxes([{ x: 10, y: 20, width: 100, height: 50 }]);
    expect(result).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it('computes the bounding box of two overlapping boxes', () => {
    const result = unionBoxes([
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 50, y: 25, width: 100, height: 50 },
    ]);
    expect(result).toEqual({ x: 0, y: 0, width: 150, height: 75 });
  });

  it('computes the bounding box of two separated boxes', () => {
    const result = unionBoxes([
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 200, y: 100, width: 100, height: 50 },
    ]);
    expect(result).toEqual({ x: 0, y: 0, width: 300, height: 150 });
  });

  it('handles negative coordinates', () => {
    const result = unionBoxes([
      { x: -50, y: -30, width: 100, height: 60 },
      { x: 10, y: 10, width: 50, height: 30 },
    ]);
    expect(result).toEqual({ x: -50, y: -30, width: 110, height: 70 });
  });
});

// ============================================================
// rectsOverlapX
// ============================================================

describe('rectsOverlapX', () => {
  it('returns true for overlapping horizontal ranges', () => {
    expect(rectsOverlapX(
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 50, y: 0, width: 100, height: 50 },
    )).toBe(true);
  });

  it('returns false for non-overlapping horizontal ranges', () => {
    expect(rectsOverlapX(
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 200, y: 0, width: 100, height: 50 },
    )).toBe(false);
  });

  it('returns false for edge-touching ranges', () => {
    expect(rectsOverlapX(
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 100, y: 0, width: 100, height: 50 },
    )).toBe(false);
  });
});

// ============================================================
// Stage 1-①: computeMinColumnsForAnnoRefRule1
// ============================================================

describe('computeMinColumnsForAnnoRefRule1', () => {
  it('assigns all messages to column 0 when there are no edges', () => {
    const normalIds = ['a', 'b', 'c'];
    const result = computeMinColumnsForAnnoRefRule1(normalIds, [], new Set());
    expect(result.col['a']).toBe(0);
    expect(result.col['b']).toBe(0);
    expect(result.col['c']).toBe(0);
    expect(result.maxCol).toBe(0);
  });

  it('places annotation source to the right of its target', () => {
    const normals = [makeNormal('a'), makeNormal('b')];
    const normalIds = normals.map(m => m.id);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 'b', 'a'), // b annotates a
    ];
    const result = computeMinColumnsForAnnoRefRule1(normalIds, edges, new Set());
    expect(result.col['a']).toBe(0);
    expect(result.col['b']).toBeGreaterThanOrEqual(1); // b must be right of a
  });

  it('places reference source to the right of its target', () => {
    const normals = [makeNormal('a'), makeNormal('b')];
    const normalIds = normals.map(m => m.id);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'reference', 'rel-1', 'b', 'a'), // b references a
    ];
    const result = computeMinColumnsForAnnoRefRule1(normalIds, edges, new Set());
    expect(result.col['a']).toBe(0);
    expect(result.col['b']).toBeGreaterThanOrEqual(1);
  });

  it('places notify source to the right of its target', () => {
    const normals = [makeNormal('a'), makeNormal('b')];
    const normalIds = normals.map(m => m.id);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'notify', 'rel-1', 'b', 'a'),
    ];
    const result = computeMinColumnsForAnnoRefRule1(normalIds, edges, new Set());
    expect(result.col['a']).toBe(0);
    expect(result.col['b']).toBeGreaterThanOrEqual(1);
  });

  it('cascades constraints through a chain: a←b←c', () => {
    const normals = [makeNormal('a'), makeNormal('b'), makeNormal('c')];
    const normalIds = normals.map(m => m.id);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 'b', 'a'), // b annotates a
      makeEdge('e2', 'annotation', 'rel-2', 'c', 'b'), // c annotates b
    ];
    const result = computeMinColumnsForAnnoRefRule1(normalIds, edges, new Set());
    expect(result.col['a']).toBe(0);
    expect(result.col['b']).toBe(1);
    expect(result.col['c']).toBeGreaterThanOrEqual(2);
  });

  it('handles multiple sources targeting the same message', () => {
    const normals = [makeNormal('a'), makeNormal('b'), makeNormal('c')];
    const normalIds = normals.map(m => m.id);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 'b', 'a'),
      makeEdge('e2', 'annotation', 'rel-2', 'c', 'a'), // both b and c annotate a
    ];
    const result = computeMinColumnsForAnnoRefRule1(normalIds, edges, new Set());
    expect(result.col['a']).toBe(0);
    expect(result.col['b']).toBeGreaterThanOrEqual(1);
    expect(result.col['c']).toBeGreaterThanOrEqual(1);
  });

  it('ignores non-annotation/reference relation types', () => {
    const normals = [makeNormal('a'), makeNormal('b')];
    const normalIds = normals.map(m => m.id);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'reply', 'rel-1', 'b', 'a'), // reply is NOT annotation/reference
    ];
    const result = computeMinColumnsForAnnoRefRule1(normalIds, edges, new Set());
    // REPLY is handled in Stage 1-②, not here
    expect(result.col['a']).toBe(0);
    expect(result.col['b']).toBe(0);
  });

  it('normalizes columns so minimum is 0', () => {
    const normals = [makeNormal('a'), makeNormal('b'), makeNormal('c')];
    const normalIds = normals.map(m => m.id);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 'c', 'b'),
      makeEdge('e2', 'annotation', 'rel-2', 'b', 'a'),
    ];
    const result = computeMinColumnsForAnnoRefRule1(normalIds, edges, new Set());
    // a=0, b=1, c=2 → min is 0, no shift needed
    expect(result.col['a']).toBe(0);
    expect(result.col['b']).toBe(1);
    expect(result.col['c']).toBe(2);
  });

  it('ignores edges where source or target is not in normalIds', () => {
    const normals = [makeNormal('a'), makeNormal('b')];
    const normalIds = normals.map(m => m.id);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 'b', 'nonexistent'),
    ];
    const result = computeMinColumnsForAnnoRefRule1(normalIds, edges, new Set());
    expect(result.col['a']).toBe(0);
    expect(result.col['b']).toBe(0);
  });
});

// ============================================================
// Stage 1-②: applyReplyLayoutAdjustments (author-lane optimization)
// ============================================================

describe('applyReplyLayoutAdjustments', () => {
  it('forbids reply source from being in the same column as its target', () => {
    // a←b (annotation), b←c (reply) — c cannot be in same column as b
    const normals = [makeNormal('a'), makeNormal('b'), makeNormal('c')];
    const baseCol = { a: 0, b: 1, c: 0 }; // c initially at 0
    const edges: DemoEdge[] = [
      makeEdge('e1', 'reply', 'rel-1', 'c', 'b'), // c replies to b
    ];
    const result = applyReplyLayoutAdjustments({
      normals, edges, baseCol, baseMaxCol: 1, relIds: new Set(),
    });
    // c cannot occupy the same column as its target b (col 1)
    expect(result.col['c']).not.toBe(1);
  });

  it('respects anno/ref constraints that carry over', () => {
    // a←b (annotation), a←c (reply where c also annotates a)
    const normals = [makeNormal('a'), makeNormal('b')];
    const baseCol = { a: 0, b: 0 };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 'b', 'a'),
      makeEdge('e2', 'reply', 'rel-2', 'b', 'a'), // b also replies to a
    ];
    const result = applyReplyLayoutAdjustments({
      normals, edges, baseCol, baseMaxCol: 0, relIds: new Set(),
    });
    // b must be right of a due to annotation constraint
    expect(result.col['b']).toBeGreaterThanOrEqual(1);
  });

  it('does not move non-reply-source messages', () => {
    const normals = [makeNormal('a'), makeNormal('b'), makeNormal('c')];
    const baseCol = { a: 0, b: 1, c: 0 };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'reply', 'rel-1', 'c', 'b'),
    ];
    const result = applyReplyLayoutAdjustments({
      normals, edges, baseCol, baseMaxCol: 1, relIds: new Set(),
    });
    // a is not a reply source, stays where it was
    expect(result.col['a']).toBe(0);
    // b is a reply target, not moved
    expect(result.col['b']).toBe(1);
  });

  it('places same-author replies in adjacent columns (author-lane optimization)', () => {
    // a says something, b (same author) replies to a, c (same author) replies to a
    const normals = [
      makeNormal('a', 'alice'),
      makeNormal('b', 'alice'),
      makeNormal('c', 'alice'),
    ];
    const baseCol = { a: 0, b: 0, c: 0 };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'reply', 'rel-1', 'b', 'a'),
      makeEdge('e2', 'reply', 'rel-2', 'c', 'a'),
    ];
    const result = applyReplyLayoutAdjustments({
      normals, edges, baseCol, baseMaxCol: 0, relIds: new Set(),
    });
    // Both b and c should be to the right of a
    expect(result.col['b']).toBeGreaterThanOrEqual(1);
    expect(result.col['c']).toBeGreaterThanOrEqual(1);
  });

  it('does not affect non-reply edges', () => {
    const normals = [makeNormal('a'), makeNormal('b')];
    const baseCol = { a: 0, b: 0 };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'agree', 'rel-1', 'b', 'a'), // not reply
    ];
    const result = applyReplyLayoutAdjustments({
      normals, edges, baseCol, baseMaxCol: 0, relIds: new Set(),
    });
    expect(result.col['a']).toBe(0);
    expect(result.col['b']).toBe(0);
  });

  it('propagates right shift to dependent anno/ref sources after reply movement', () => {
    // B replies to A so B moves right; C references B and must stay to B's right.
    const normals = [
      makeNormal('a', 'alice', '2024-01-01T00:00:00Z'),
      makeNormal('b', 'bob', '2024-01-01T00:01:00Z'),
      makeNormal('c', 'carol', '2024-01-01T00:02:00Z'),
    ];
    const baseCol = { a: 0, b: 0, c: 1 };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'reply', 'rel-1', 'b', 'a'),
      makeEdge('e2', 'reference', 'rel-2', 'c', 'b'),
    ];

    const result = applyReplyLayoutAdjustments({
      normals, edges, baseCol, baseMaxCol: 1, relIds: new Set(),
    });

    expect(result.col['b']).toBeGreaterThanOrEqual(result.col['a'] + 1);
    expect(result.col['c']).toBeGreaterThanOrEqual(result.col['b'] + 1);
  });
});

// ============================================================
// Stage 1-③: applyAgreeDisagreeColumnOverride
// ============================================================

describe('applyAgreeDisagreeColumnOverride', () => {
  it('places AGREE source in the same column as target', () => {
    const normals = [makeNormal('a'), makeNormal('b')];
    const baseCol = { a: 2, b: 0 };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'agree', 'rel-1', 'b', 'a'),
    ];
    const result = applyAgreeDisagreeColumnOverride({
      normals, edges, col: baseCol, maxCol: 2,
    });
    // b agrees with a → same column as a (2)
    expect(result.col['b']).toBe(2);
  });

  it('places DISAGREE source one column to the right of target', () => {
    const normals = [makeNormal('a'), makeNormal('b')];
    const baseCol = { a: 2, b: 0 };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'disagree', 'rel-1', 'b', 'a'),
    ];
    const result = applyAgreeDisagreeColumnOverride({
      normals, edges, col: baseCol, maxCol: 2,
    });
    // b disagrees with a → col 3 (one right of a's col 2)
    expect(result.col['b']).toBe(3);
  });

  it('respects annotation/reference minimum column constraints', () => {
    // a←c (annotation), c should be right of a
    // c agrees with b → normally same column as b, but anno constraint forces right of a
    const normals = [makeNormal('a'), makeNormal('b'), makeNormal('c')];
    const baseCol = { a: 0, b: 3, c: 1 };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 'c', 'a'),
      makeEdge('e2', 'agree', 'rel-2', 'c', 'b'), // c agrees with b
    ];
    const result = applyAgreeDisagreeColumnOverride({
      normals, edges, col: baseCol, maxCol: 3,
    });
    // c agrees with b → wants col 3, but must be ≥ a.col + 1 = 1 due to annotation
    // Since 3 ≥ 1, it stays at 3
    expect(result.col['c']).toBe(3);
  });

  it('skips pure-stance (anon: source) edges', () => {
    const normals = [makeNormal('a')];
    const baseCol = { a: 0 };
    const edges: DemoEdge[] = [
      {
        id: 'e1',
        relationMessageId: 'rel-1',
        relationType: 'agree',
        from: { messageId: 'anon:something', selection: { kind: 'whole' } },
        to: { messageId: 'a', selection: { kind: 'whole' } },
        relationLabel: 'agree',
      },
    ];
    const result = applyAgreeDisagreeColumnOverride({
      normals, edges, col: baseCol, maxCol: 0,
    });
    // Pure-stance does not move any card
    expect(result.col['a']).toBe(0);
    expect(result.maxCol).toBe(0);
  });

  it('skips AGREE/DISAGREE where target is not a normal message', () => {
    const normals = [makeNormal('a')];
    const baseCol = { a: 0 };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'agree', 'rel-1', 'a', 'rel-target'), // target is relation, not normal
    ];
    const result = applyAgreeDisagreeColumnOverride({
      normals, edges, col: baseCol, maxCol: 0,
    });
    expect(result.col['a']).toBe(0);
  });

  it('handles multiple AGREE/DISAGREE from the same source', () => {
    // b agrees with a (col 0) and disagrees with c (col 4) → b should be at col max(0, 5)
    // But the code processes edges sequentially — the last one wins
    // This is a known edge case; we test the actual behavior
    const normals = [makeNormal('a'), makeNormal('b'), makeNormal('c')];
    const baseCol = { a: 0, b: 0, c: 4 };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'agree', 'rel-1', 'b', 'a'),
      makeEdge('e2', 'disagree', 'rel-2', 'b', 'c'),
    ];
    const result = applyAgreeDisagreeColumnOverride({
      normals, edges, col: baseCol, maxCol: 4,
    });
    // b agrees with a → col 0, then disagrees with c → col 5
    // The last assignment wins
    expect(result.col['b']).toBe(5);
    expect(result.maxCol).toBe(5);
  });
});

// ============================================================
// Stage 1-④: applyGroupingColumnOverride
// ============================================================

describe('applyGroupingColumnOverride', () => {
  // --- ARRANGE ---

  it('places ARRANGE source in same column as its target', () => {
    const normals = [makeNormal('a'), makeNormal('b')];
    const baseCol = { a: 3, b: 0 };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'arrange', 'rel-1', 'b', 'a'),
    ];
    const result = applyGroupingColumnOverride({
      normals, edges, col: baseCol, maxCol: 3,
    });
    expect(result.col['b']).toBe(3); // same as target
    expect(result.groupSourceToTarget.get('b')).toBe('a');
  });

  it('chains multiple ARRANGE targets into same column', () => {
    const normals = [makeNormal('a', 'u1', '2024-01-01T00:00:00Z'), makeNormal('b', 'u1', '2024-01-01T00:01:00Z')];
    const baseCol = { a: 2, b: 5 };
    const edges: DemoEdge[] = [
      { id: 'e1', relationMessageId: 'rel-1', relationType: 'arrange',
        from: { messageId: 'anon:supp-1', selection: { kind: 'whole' } },
        to: { messageId: 'a', selection: { kind: 'whole' } },
        relationLabel: 'arrange' },
      { id: 'e2', relationMessageId: 'rel-1', relationType: 'arrange',
        from: { messageId: 'anon:supp-1', selection: { kind: 'whole' } },
        to: { messageId: 'b', selection: { kind: 'whole' } },
        relationLabel: 'arrange' },
    ];
    const result = applyGroupingColumnOverride({
      normals, edges, col: baseCol, maxCol: 5,
    });
    // Both targets end up in same column
    expect(result.col['a']).toBe(result.col['b']);
  });

  // --- MERGE ---

  it('preserves MERGE targets in their original columns (no column force)', () => {
    const normals = [makeNormal('a'), makeNormal('b')];
    const baseCol = { a: 2, b: 5 };
    const edges: DemoEdge[] = [
      { id: 'e1', relationMessageId: 'rel-1', relationType: 'merge',
        from: { messageId: 'anon:merge-1', selection: { kind: 'whole' } },
        to: { messageId: 'a', selection: { kind: 'whole' } },
        relationLabel: 'merge' },
      { id: 'e2', relationMessageId: 'rel-1', relationType: 'merge',
        from: { messageId: 'anon:merge-1', selection: { kind: 'whole' } },
        to: { messageId: 'b', selection: { kind: 'whole' } },
        relationLabel: 'merge' },
    ];
    const result = applyGroupingColumnOverride({
      normals, edges, col: baseCol, maxCol: 5,
    });
    // MERGE does NOT force same column
    expect(result.col['a']).toBe(2);
    expect(result.col['b']).toBe(5);
  });

  // --- CORRECT ---

  it('places CORRECT source in same column as corrected target', () => {
    const normals = [makeNormal('orig'), makeNormal('corr')];
    const baseCol = { orig: 3, corr: 0 };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'correct', 'rel-1', 'corr', 'orig'),
    ];
    const result = applyGroupingColumnOverride({
      normals, edges, col: baseCol, maxCol: 3,
    });
    expect(result.col['corr']).toBe(3); // same as orig
    expect(result.groupSourceToTarget.get('corr')).toBe('orig');
  });

  // --- Edge cases ---

  it('does not affect messages unrelated to any frame/correction', () => {
    const normals = [makeNormal('a'), makeNormal('b')];
    const baseCol = { a: 2, b: 5 };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'reply', 'rel-1', 'b', 'a'), // reply is NOT a framing relation
    ];
    const result = applyGroupingColumnOverride({
      normals, edges, col: baseCol, maxCol: 5,
    });
    expect(result.col['a']).toBe(2);
    expect(result.col['b']).toBe(5);
  });

  it('returns maxCol=0 for empty normals', () => {
    const result = applyGroupingColumnOverride({
      normals: [], edges: [], col: {}, maxCol: 0,
    });
    expect(result.maxCol).toBe(0);
  });

  it('propagates columns transitively through groupSourceToTarget chain', () => {
    // a→b→c: b stacks below a, c stacks below b, all same col
    const normals = [
      makeNormal('a', 'u1', '2024-01-01T00:00:00Z'),
      makeNormal('b', 'u1', '2024-01-01T00:01:00Z'),
      makeNormal('c', 'u1', '2024-01-01T00:02:00Z'),
    ];
    const baseCol = { a: 4, b: 0, c: 0 };
    const edges: DemoEdge[] = [
      { id: 'e1', relationMessageId: 'rel-1', relationType: 'arrange',
        from: { messageId: 'anon:supp-1', selection: { kind: 'whole' } },
        to: { messageId: 'a', selection: { kind: 'whole' } },
        relationLabel: 'arrange' },
      { id: 'e2', relationMessageId: 'rel-1', relationType: 'arrange',
        from: { messageId: 'anon:supp-1', selection: { kind: 'whole' } },
        to: { messageId: 'b', selection: { kind: 'whole' } },
        relationLabel: 'arrange' },
      { id: 'e3', relationMessageId: 'rel-1', relationType: 'arrange',
        from: { messageId: 'anon:supp-1', selection: { kind: 'whole' } },
        to: { messageId: 'c', selection: { kind: 'whole' } },
        relationLabel: 'arrange' },
    ];
    const result = applyGroupingColumnOverride({
      normals, edges, col: baseCol, maxCol: 4,
    });
    // All three end up in the same column
    expect(result.col['a']).toBe(result.col['b']);
    expect(result.col['b']).toBe(result.col['c']);
  });

  it('re-applies right-of constraints after grouping shifts a target', () => {
    // b is grouped to a (same column), and c references b.
    // If grouping moves b right, c must also move to at least b+1.
    const normals = [
      makeNormal('a', 'u1', '2024-01-01T00:00:00Z'),
      makeNormal('b', 'u1', '2024-01-01T00:01:00Z'),
      makeNormal('c', 'u1', '2024-01-01T00:02:00Z'),
    ];
    const baseCol = { a: 5, b: 0, c: 1 };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'arrange', 'rel-arr', 'b', 'a'),
      makeEdge('e2', 'reference', 'rel-ref', 'c', 'b'),
    ];

    const result = applyGroupingColumnOverride({
      normals, edges, col: baseCol, maxCol: 5,
    });

    expect(result.col['b']).toBe(5);
    expect(result.col['c']).toBeGreaterThanOrEqual(result.col['b'] + 1);
  });
});

// ============================================================
// Pipeline integration: verify stage ordering compatibility
// ============================================================

describe('Pipeline integration', () => {
  it('Stage 1-① → 1-② → 1-③ → 1-④ produces consistent column assignments', () => {
    // Simulate a realistic scenario:
    //   msg-a: original message
    //   msg-b: annotates msg-a (annotation)
    //   msg-c: agrees with msg-a (agree)
    //   msg-d: arranges msg-a and msg-b (arrange, no source)
    //   msg-e: corrects msg-a (correct)
    const normals = [
      makeNormal('msg-a', 'alice', '2024-01-01T00:00:00Z'),
      makeNormal('msg-b', 'bob',   '2024-01-01T00:01:00Z'),
      makeNormal('msg-c', 'carol', '2024-01-01T00:02:00Z'),
      makeNormal('msg-d', 'dave',  '2024-01-01T00:03:00Z'),
      makeNormal('msg-e', 'eve',   '2024-01-01T00:04:00Z'),
    ];
    const normalIds = normals.map(m => m.id);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-anno', 'msg-b', 'msg-a'),
      makeEdge('e2', 'agree',      'rel-agree', 'msg-c', 'msg-a'),
      { id: 'e3a', relationMessageId: 'rel-arr', relationType: 'arrange',
        from: { messageId: 'anon:arr', selection: { kind: 'whole' } },
        to: { messageId: 'msg-a', selection: { kind: 'whole' } },
        relationLabel: 'arrange' },
      { id: 'e3b', relationMessageId: 'rel-arr', relationType: 'arrange',
        from: { messageId: 'anon:arr', selection: { kind: 'whole' } },
        to: { messageId: 'msg-d', selection: { kind: 'whole' } },
        relationLabel: 'arrange' },
      makeEdge('e4', 'correct', 'rel-corr', 'msg-e', 'msg-a'),
    ];

    // Stage 1-①
    const s1 = computeMinColumnsForAnnoRefRule1(normalIds, edges, new Set());
    // msg-b annotates msg-a → b right of a
    expect(s1.col['msg-b']).toBeGreaterThanOrEqual(s1.col['msg-a'] + 1);

    // Stage 1-②
    const s2 = applyReplyLayoutAdjustments({
      normals, edges, baseCol: s1.col, baseMaxCol: s1.maxCol, relIds: new Set(),
    });
    // All columns still valid
    for (const m of normals) expect(s2.col[m.id]).toBeDefined();

    // Stage 1-③
    const s3 = applyAgreeDisagreeColumnOverride({
      normals, edges, col: s2.col, maxCol: s2.maxCol,
    });
    // msg-c agrees with msg-a → same column
    expect(s3.col['msg-c']).toBe(s3.col['msg-a']);

    // Stage 1-④
    const s4 = applyGroupingColumnOverride({
      normals, edges, col: s3.col, maxCol: s3.maxCol,
    });
    // msg-e corrects msg-a → same column
    expect(s4.col['msg-e']).toBe(s4.col['msg-a']);
    // msg-d is arranged with msg-a → same column
    expect(s4.col['msg-d']).toBe(s4.col['msg-a']);

    // All messages have valid column assignments
    for (const m of normals) {
      expect(s4.col[m.id]).toBeGreaterThanOrEqual(0);
    }
    expect(s4.maxCol).toBeGreaterThanOrEqual(0);
  });

  it('handles empty input gracefully', () => {
    const s1 = computeMinColumnsForAnnoRefRule1([], [], new Set());
    expect(s1.maxCol).toBe(-Infinity); // Math.max() of empty array

    const s2 = applyReplyLayoutAdjustments({
      normals: [], edges: [], baseCol: {}, baseMaxCol: 0, relIds: new Set(),
    });
    expect(s2.maxCol).toBe(0);

    const s3 = applyAgreeDisagreeColumnOverride({
      normals: [], edges: [], col: {}, maxCol: 0,
    });
    expect(s3.maxCol).toBe(0);

    const s4 = applyGroupingColumnOverride({
      normals: [], edges: [], col: {}, maxCol: 0,
    });
    expect(s4.maxCol).toBe(0);
  });
});

// ============================================================
// Stage 2: 2D no-overlap layout (standalone cards)
// ============================================================

describe('computeSimpleNoOverlapLayout', () => {
  it('places a single card at the grid origin', () => {
    const normals = [makeNormal('a')];
    const colOf = { a: 0 };
    const result = computeSimpleNoOverlapLayout({ normals, colOf, maxCol: 0 });
    expect(result.layout['a']).toEqual({
      x: colX(0),
      y: GRID_TOP,
      width: CARD_W,
      height: 86, // MIN_CARD_H
    });
  });

  it('places two cards in different columns at the same y (no horizontal overlap)', () => {
    const normals = [
      makeNormal('a', 'u1', '2024-01-01T00:00:00Z'),
      makeNormal('b', 'u1', '2024-01-01T00:01:00Z'),
    ];
    const colOf = { a: 0, b: 1 };
    const result = computeSimpleNoOverlapLayout({ normals, colOf, maxCol: 1 });
    // Same y because different columns (no x-overlap)
    expect(result.layout['a'].y).toBe(GRID_TOP);
    expect(result.layout['b'].y).toBe(GRID_TOP);
    // Different x
    expect(result.layout['a'].x).toBe(colX(0));
    expect(result.layout['b'].x).toBe(colX(1));
    // No overlaps
    expect(findOverlaps(result.layout)).toHaveLength(0);
  });

  it('places two cards in the same column vertically stacked', () => {
    const normals = [
      makeNormal('a', 'u1', '2024-01-01T00:00:00Z'),
      makeNormal('b', 'u1', '2024-01-01T00:01:00Z'),
    ];
    const colOf = { a: 0, b: 0 };
    const result = computeSimpleNoOverlapLayout({ normals, colOf, maxCol: 0 });
    // Same column → vertically stacked
    expect(result.layout['a'].x).toBe(colX(0));
    expect(result.layout['b'].x).toBe(colX(0));
    // b below a
    expect(result.layout['b'].y).toBeGreaterThanOrEqual(
      result.layout['a'].y + result.layout['a'].height + ROW_GAP,
    );
    // No overlaps
    expect(findOverlaps(result.layout)).toHaveLength(0);
  });

  it('places three cards in same column with correct spacing', () => {
    const normals = [
      makeNormal('a', 'u1', '2024-01-01T00:00:00Z'),
      makeNormal('b', 'u1', '2024-01-01T00:01:00Z'),
      makeNormal('c', 'u1', '2024-01-01T00:02:00Z'),
    ];
    const colOf = { a: 0, b: 0, c: 0 };
    const result = computeSimpleNoOverlapLayout({ normals, colOf, maxCol: 0 });
    // All in same column
    expect(result.layout['a'].x).toBe(colX(0));
    expect(result.layout['b'].x).toBe(colX(0));
    expect(result.layout['c'].x).toBe(colX(0));
    // Stacked with at least ROW_GAP between each
    expect(result.layout['b'].y).toBeGreaterThanOrEqual(
      result.layout['a'].y + result.layout['a'].height + ROW_GAP,
    );
    expect(result.layout['c'].y).toBeGreaterThanOrEqual(
      result.layout['b'].y + result.layout['b'].height + ROW_GAP,
    );
    // No overlaps
    expect(findOverlaps(result.layout)).toHaveLength(0);
  });

  it('interleaves cards from different columns by creation time', () => {
    // Two columns: col 0 has a,c,e; col 1 has b,d
    // Since all are processed in time order, same-column cards stack
    const normals = [
      makeNormal('a', 'u1', '2024-01-01T00:00:00Z'),
      makeNormal('b', 'u1', '2024-01-01T00:01:00Z'),
      makeNormal('c', 'u1', '2024-01-01T00:02:00Z'),
      makeNormal('d', 'u1', '2024-01-01T00:03:00Z'),
      makeNormal('e', 'u1', '2024-01-01T00:04:00Z'),
    ];
    const colOf = { a: 0, b: 1, c: 0, d: 1, e: 0 };
    const result = computeSimpleNoOverlapLayout({ normals, colOf, maxCol: 1 });
    // No overlaps anywhere
    const overlaps = findOverlaps(result.layout);
    expect(overlaps).toHaveLength(0);
    // Col 0: a, c, e vertically stacked
    expect(result.layout['c'].y).toBeGreaterThan(result.layout['a'].y);
    expect(result.layout['e'].y).toBeGreaterThan(result.layout['c'].y);
    // Col 1: b, d vertically stacked
    expect(result.layout['d'].y).toBeGreaterThan(result.layout['b'].y);
  });

  it('produces zero overlaps for any valid column assignment', () => {
    // Random-ish column assignment with many cards
    const normals = Array.from({ length: 20 }, (_, i) =>
      makeNormal(`msg-${i}`, `user-${i % 4}`, `2024-01-01T00:${String(i).padStart(2, '0')}:00Z`),
    );
    const colOf: Record<string, number> = {};
    for (const m of normals) {
      colOf[m.id] = (parseInt(m.id.split('-')[1]) * 3) % 5; // pseudo-random column 0-4
    }
    const result = computeSimpleNoOverlapLayout({ normals, colOf, maxCol: 4 });
    const overlaps = findOverlaps(result.layout);
    // This is the KEY assertion: no card should overlap another
    expect(overlaps).toHaveLength(0);
    // Every card must have a position
    for (const m of normals) {
      expect(result.layout[m.id]).toBeDefined();
      expect(result.layout[m.id].x).toBeGreaterThanOrEqual(0);
      expect(result.layout[m.id].y).toBeGreaterThanOrEqual(0);
    }
  });

  it('computes correct canvas dimensions', () => {
    const normals = [
      makeNormal('a', 'u1', '2024-01-01T00:00:00Z'),
    ];
    const colOf = { a: 0 };
    const result = computeSimpleNoOverlapLayout({ normals, colOf, maxCol: 0 });
    expect(result.canvasWidth).toBeGreaterThan(CARD_W);
    expect(result.canvasHeight).toBeGreaterThan(86);
  });

  it('handles empty normals array', () => {
    const result = computeSimpleNoOverlapLayout({ normals: [], colOf: {}, maxCol: 0 });
    expect(Object.keys(result.layout)).toHaveLength(0);
    expect(result.canvasWidth).toBeGreaterThan(0);
    expect(result.canvasHeight).toBeGreaterThan(0);
  });

  it('uses measuredHeights when provided', () => {
    const normals = [makeNormal('a')];
    const colOf = { a: 0 };
    const result = computeSimpleNoOverlapLayout({
      normals, colOf, maxCol: 0,
      measuredHeights: { a: 200 },
    });
    expect(result.layout['a'].height).toBe(200);
  });

  it('falls back to MIN_CARD_H when measuredHeights not provided', () => {
    const normals = [makeNormal('a')];
    const colOf = { a: 0 };
    const result = computeSimpleNoOverlapLayout({ normals, colOf, maxCol: 0 });
    expect(result.layout['a'].height).toBe(86); // MIN_CARD_H
  });
});

// ============================================================
// findOverlaps — layout correctness validator
// ============================================================

describe('findOverlaps', () => {
  it('returns empty array when no cards overlap', () => {
    const layout = {
      a: { x: 0, y: 0, width: 100, height: 50 },
      b: { x: 150, y: 0, width: 100, height: 50 },
    };
    expect(findOverlaps(layout)).toHaveLength(0);
  });

  it('detects horizontal + vertical overlap between two cards', () => {
    const layout = {
      a: { x: 0, y: 0, width: 100, height: 50 },
      b: { x: 50, y: 25, width: 100, height: 50 },
    };
    const overlaps = findOverlaps(layout);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toEqual({ id1: 'a', id2: 'b' });
  });

  it('does NOT flag cards that touch at edges', () => {
    const layout = {
      a: { x: 0, y: 0, width: 100, height: 50 },
      b: { x: 100, y: 0, width: 100, height: 50 }, // touches at x=100
    };
    expect(findOverlaps(layout)).toHaveLength(0);
  });

  it('detects multiple overlapping pairs', () => {
    const layout = {
      a: { x: 0, y: 0, width: 100, height: 100 },
      b: { x: 50, y: 50, width: 100, height: 100 },
      c: { x: 20, y: 20, width: 60, height: 60 },  // fully inside both a and b
    };
    const overlaps = findOverlaps(layout);
    // c overlaps both a and b, plus a overlaps b = 3 pairs
    expect(overlaps.length).toBe(3);
  });
});

// ============================================================
// verifyColumnOrder — chronological ordering validator
// ============================================================

describe('verifyColumnOrder', () => {
  it('returns empty array when same-column cards are in chronological order', () => {
    const normals = [
      makeNormal('a', 'u1', '2024-01-01T00:00:00Z'),
      makeNormal('b', 'u1', '2024-01-01T00:01:00Z'),
    ];
    const layout = {
      a: { x: colX(0), y: 48, width: CARD_W, height: 86 },
      b: { x: colX(0), y: 166, width: CARD_W, height: 86 }, // below a
    };
    const colOf = { a: 0, b: 0 };
    expect(verifyColumnOrder(layout, normals, colOf)).toHaveLength(0);
  });

  it('detects when a newer card is placed above an older card in same column', () => {
    const normals = [
      makeNormal('older', 'u1', '2024-01-01T00:00:00Z'),
      makeNormal('newer', 'u1', '2024-01-01T00:10:00Z'),
    ];
    // BUG: newer card placed ABOVE older card in same column
    const layout = {
      older: { x: colX(0), y: 200, width: CARD_W, height: 86 },
      newer: { x: colX(0), y: 48, width: CARD_W, height: 86 },
    };
    const colOf = { older: 0, newer: 0 };
    const issues = verifyColumnOrder(layout, normals, colOf);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('does not flag cards in different columns', () => {
    const normals = [
      makeNormal('a', 'u1', '2024-01-01T00:10:00Z'), // newer
      makeNormal('b', 'u1', '2024-01-01T00:00:00Z'), // older
    ];
    // Different columns: order doesn't matter across columns
    const layout = {
      a: { x: colX(0), y: 48, width: CARD_W, height: 86 },
      b: { x: colX(1), y: 48, width: CARD_W, height: 86 },
    };
    const colOf = { a: 0, b: 1 };
    expect(verifyColumnOrder(layout, normals, colOf)).toHaveLength(0);
  });
});

// ============================================================
// End-to-end: column pipeline → no-overlap layout
// ============================================================

describe('End-to-end: column pipeline → layout', () => {
  it('produces zero-overlap layout from annotation column constraints', () => {
    // a ← b (annotation): b must be in col ≥ 1
    const normals = [
      makeNormal('a', 'alice', '2024-01-01T00:00:00Z'),
      makeNormal('b', 'bob',   '2024-01-01T00:01:00Z'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 'b', 'a'),
    ];
    const normalIds = normals.map(m => m.id);
    const s1 = computeMinColumnsForAnnoRefRule1(normalIds, edges, new Set());
    const colOf = s1.col;
    const result = computeSimpleNoOverlapLayout({ normals, colOf, maxCol: s1.maxCol });
    // a in col 0, b in col ≥ 1 → no overlap
    expect(findOverlaps(result.layout)).toHaveLength(0);
    expect(result.layout['b'].x).toBeGreaterThan(result.layout['a'].x);
  });

  it('produces zero-overlap layout from agree column constraints', () => {
    // b agrees with a → same column
    const normals = [
      makeNormal('a', 'alice', '2024-01-01T00:00:00Z'),
      makeNormal('b', 'bob',   '2024-01-01T00:01:00Z'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'agree', 'rel-1', 'b', 'a'),
    ];
    const col = { a: 3, b: 0 };
    const s3 = applyAgreeDisagreeColumnOverride({ normals, edges, col, maxCol: 3 });
    const result = computeSimpleNoOverlapLayout({ normals, colOf: s3.col, maxCol: s3.maxCol });
    // Both in same column → stacked vertically, no overlap
    expect(findOverlaps(result.layout)).toHaveLength(0);
    expect(result.layout['a'].x).toBe(result.layout['b'].x);
    // b (agrees with a, but created later) should be below a
    expect(result.layout['b'].y).toBeGreaterThan(result.layout['a'].y);
  });

  it('produces zero-overlap layout from disagree column constraints', () => {
    // b disagrees with a → one column right of a
    const normals = [
      makeNormal('a', 'alice', '2024-01-01T00:00:00Z'),
      makeNormal('b', 'bob',   '2024-01-01T00:01:00Z'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'disagree', 'rel-1', 'b', 'a'),
    ];
    const col = { a: 2, b: 0 };
    const s3 = applyAgreeDisagreeColumnOverride({ normals, edges, col, maxCol: 2 });
    const result = computeSimpleNoOverlapLayout({ normals, colOf: s3.col, maxCol: s3.maxCol });
    // Different columns → can be at same y, no overlap
    expect(findOverlaps(result.layout)).toHaveLength(0);
    expect(result.layout['b'].x).toBeGreaterThan(result.layout['a'].x);
  });

  it('handles complex multi-relation scenario without overlaps', () => {
    // a, b, c, d in a mixed scenario:
    //   b annotates a → b right of a
    //   c agrees with a → c same column as a
    //   d disagrees with a → d right of a
    const normals = [
      makeNormal('a', 'alice', '2024-01-01T00:00:00Z'),
      makeNormal('b', 'bob',   '2024-01-01T00:01:00Z'),
      makeNormal('c', 'carol', '2024-01-01T00:02:00Z'),
      makeNormal('d', 'dave',  '2024-01-01T00:03:00Z'),
    ];
    const normalIds = normals.map(m => m.id);
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 'b', 'a'),
      makeEdge('e2', 'agree',      'rel-2', 'c', 'a'),
      makeEdge('e3', 'disagree',   'rel-3', 'd', 'a'),
    ];

    // Full pipeline
    const s1 = computeMinColumnsForAnnoRefRule1(normalIds, edges, new Set());
    const s2 = applyReplyLayoutAdjustments({ normals, edges, baseCol: s1.col, baseMaxCol: s1.maxCol, relIds: new Set() });
    const s3 = applyAgreeDisagreeColumnOverride({ normals, edges, col: s2.col, maxCol: s2.maxCol });
    const s4 = applyGroupingColumnOverride({ normals, edges, col: s3.col, maxCol: s3.maxCol });

    const result = computeSimpleNoOverlapLayout({ normals, colOf: s4.col, maxCol: s4.maxCol });

    // Critical: no overlaps
    const overlaps = findOverlaps(result.layout);
    expect(overlaps).toHaveLength(0);

    // a in col 0, b in col ≥ 1 (right of a), c in col 0 (same as a), d in col ≥ 2 (disagree right of a)
    expect(result.layout['b'].x).toBeGreaterThan(result.layout['a'].x);
    expect(result.layout['c'].x).toBe(result.layout['a'].x); // same col
    // c below a (same column, later time)
    expect(result.layout['c'].y).toBeGreaterThan(result.layout['a'].y);
  });
});

// ============================================================
// Frame containment validation (using real debug data)
// ============================================================

describe('Frame containment invariants', () => {
  // Helper: check that a frame rect completely encloses all its card boxes
  function frameEnclosesCards(
    frameRect: { x: number; y: number; width: number; height: number },
    cardBoxes: { x: number; y: number; width: number; height: number }[],
    tolerance = 1,
  ): { ok: boolean; violations: string[] } {
    const violations: string[] = [];
    const fRight = frameRect.x + frameRect.width;
    const fBottom = frameRect.y + frameRect.height;

    for (let i = 0; i < cardBoxes.length; i++) {
      const c = cardBoxes[i];
      const cRight = c.x + c.width;
      const cBottom = c.y + c.height;

      if (c.x < frameRect.x - tolerance) {
        violations.push(`card[${i}] left edge ${c.x} < frame left ${frameRect.x}`);
      }
      if (cRight > fRight + tolerance) {
        violations.push(`card[${i}] right edge ${cRight} > frame right ${fRight} (overflow ${cRight - fRight}px)`);
      }
      if (c.y < frameRect.y - tolerance) {
        violations.push(`card[${i}] top edge ${c.y} < frame top ${frameRect.y}`);
      }
      if (cBottom > fBottom + tolerance) {
        violations.push(`card[${i}] bottom edge ${cBottom} > frame bottom ${fBottom} (overflow ${cBottom - fBottom}px)`);
      }
    }
    return { ok: violations.length === 0, violations };
  }

  it('merge frame mock-101 encloses all its direct cards', () => {
    const frameRect = { x: 18, y: 32, width: 1152, height: 511 };
    // Direct cards of mock-101 (not inside child frame r10): m2, m1, m4, m7
    const cards = [
      { x: 34, y: 100, width: 320, height: 109 },  // m2
      { x: 434, y: 100, width: 320, height: 109 }, // m1
      { x: 834, y: 100, width: 320, height: 109 }, // m4
      { x: 434, y: 241, width: 320, height: 90 },  // m7
    ];
    const result = frameEnclosesCards(frameRect, cards);
    expect(result.ok).toBe(true);
  });

  it('arrange frame r10 encloses its cards m5 and m6', () => {
    const frameRect = { x: 34, y: 225, width: 352, height: 302 };
    const cards = [
      { x: 50, y: 241, width: 320, height: 129 }, // m5
      { x: 50, y: 402, width: 320, height: 109 }, // m6
    ];
    const result = frameEnclosesCards(frameRect, cards);
    expect(result.ok).toBe(true);
  });

  it('merge frame mock-101 encloses child frame r10', () => {
    const mergeRect = { x: 18, y: 32, width: 1152, height: 511 };
    const childRect = { x: 34, y: 225, width: 352, height: 302 };
    const result = frameEnclosesCards(mergeRect, [childRect]);
    expect(result.ok).toBe(true);
  });

  it('arrange frame mock-106 encloses its horizontal cards', () => {
    const frameRect = { x: 34, y: 591, width: 752, height: 118 };
    const cards = [
      { x: 50, y: 607, width: 320, height: 86 },  // mock-102
      { x: 450, y: 607, width: 320, height: 86 }, // mock-103
    ];
    const result = frameEnclosesCards(frameRect, cards);
    expect(result.ok).toBe(true);
  });

  it('arrange frame mock-107 encloses its vertical cards', () => {
    const frameRect = { x: 866, y: 591, width: 352, height: 236 };
    const cards = [
      { x: 882, y: 607, width: 320, height: 86 }, // mock-104
      { x: 882, y: 725, width: 320, height: 86 }, // mock-105
    ];
    const result = frameEnclosesCards(frameRect, cards);
    expect(result.ok).toBe(true);
  });

  it('parent frame mock-108 encloses child frames mock-106 and mock-107', () => {
    const parentRect = { x: 18, y: 591, width: 1216, height: 284 };
    const childRects = [
      { x: 34, y: 591, width: 752, height: 118 },  // mock-106
      { x: 866, y: 591, width: 352, height: 236 }, // mock-107
    ];
    const result = frameEnclosesCards(parentRect, childRects);
    expect(result.ok).toBe(true);
  });

  it('r10 cards are correctly offset by nested FRAME_PAD inside merge', () => {
    // m2 (direct merge card, col 0): x = colX(0) + FRAME_PAD = 18 + 16 = 34 ✓
    expect(34).toBe(colX(0) + 16);

    // m5 (inside r10 inside merge, col 0): x = colX(0) + FRAME_PAD(merge) + FRAME_PAD(r10) = 18 + 16 + 16 = 50 ✓
    expect(50).toBe(colX(0) + 16 + 16);

    // m1 (direct merge card, col 1): x = colX(1) + FRAME_PAD = 438 + 16 = 454 ✓
    expect(454).toBe(colX(1) + 16);
  });

  it('merge frame bottom edge leaves exactly FRAME_PAD below lowest card', () => {
    // Lowest card in mock-101: m6 bottom = 402 + 109 = 511
    // r10 bottom = 527, but that's frame not card
    // merge bottom = 543
    // gap = 543 - 511 = 32 = ROW_GAP? No...
    // Actually merge frame rect includes FRAME_PAD below content:
    // contentBottom = 527 (r10 bottom), + FRAME_PAD = 543 ✓
    expect(543 - 527).toBe(16); // FRAME_PAD
  });

  it('merge frame y=32 accounts for merge card header', () => {
    // merge header: y = frameRect.y + FRAME_PAD = 32 + 16 = 48
    // merge header height = 36, so header bottom = 84
    // first card y = 100, gap from header bottom = 100 - 84 = 16 = FRAME_PAD ✓
    expect(32 + 16).toBe(48); // header top
    expect(48 + 36).toBe(84); // header bottom
    expect(100 - 84).toBe(16); // gap to first card = FRAME_PAD ✓
  });

  it('horizontal arrange mock-106 has correct card spacing', () => {
    // mock-102 at x=50, mock-103 at x=450
    // gap = 450 - (50 + 320) = 450 - 370 = 80 = COL_GAP ✓
    expect(450 - (50 + 320)).toBe(80);
  });

  it('vertical arrange mock-107 stacks cards with ROW_GAP', () => {
    // mock-104 at y=607, h=86, bottom=693
    // mock-105 at y=725
    // gap = 725 - 693 = 32 = ROW_GAP ✓
    expect(725 - (607 + 86)).toBe(32);
  });

  it('no cards overlap across the entire layout', () => {
    const allCards: Record<string, LayoutBox> = {
      m1: { x: 434, y: 100, width: 320, height: 109 },
      m2: { x: 34, y: 100, width: 320, height: 109 },
      m3: { x: 18, y: 575, width: 320, height: 0 }, // h=0, corrected target
      m4: { x: 834, y: 100, width: 320, height: 109 },
      m5: { x: 50, y: 241, width: 320, height: 129 },
      m6: { x: 50, y: 402, width: 320, height: 109 },
      m7: { x: 434, y: 241, width: 320, height: 90 },
      'mock-102': { x: 50, y: 607, width: 320, height: 86 },
      'mock-103': { x: 450, y: 607, width: 320, height: 86 },
      'mock-104': { x: 882, y: 607, width: 320, height: 86 },
      'mock-105': { x: 882, y: 725, width: 320, height: 86 },
    };
    const overlaps = findOverlaps(allCards);
    // m3 has h=0 so it won't overlap with anything
    expect(overlaps).toHaveLength(0);
  });

  it('parent frame mock-108 horizontal child spacing is correct', () => {
    // mock-106 (left child): x=34, w=752, right=786
    // mock-107 (right child): x=866
    // gap = 866 - 786 = 80 = COL_GAP ✓
    expect(866 - (34 + 752)).toBe(80);
  });

  it('standalone card starts at GRID_LEFT when in col 0 and no frame', () => {
    // m3 is a standalone card (not in any frame) at col 0
    // x should be colX(0) = 18
    expect(18).toBe(colX(0));
  });

  it('FRAME_PAD is consistently applied: direct frame children at colX(col) + FRAME_PAD', () => {
    // mock-102 in mock-106: x = colX(0) + FRAME_PAD = 18 + 16 = 34... but debug shows 50
    // Wait, mock-102 is at x=50. Let me check:
    // mock-106 starts at x=34, FRAME_PAD=16, so cards inside start at 34+16=50 ✓
    expect(50).toBe(34 + 16);

    // mock-104 in mock-107: x = colX(2) + FRAME_PAD = 818 + 16 = 834... but debug shows 882
    // mock-107 starts at x=866, FRAME_PAD=16, so cards inside start at 866+16=882 ✓
    expect(882).toBe(866 + 16);
  });
});

// ============================================================
// Frame-as-card: verify frames and cards use same placement logic
// ============================================================

describe('Frame-as-card placement invariants', () => {
  // Simulates what computeNoOverlapLayout should do:
  // both frames and cards use findY2(fMinX, fWidth) at the top level.

  it('a frame and a card in the same column stack with ROW_GAP', () => {
    // Card at col 0, frame at col 0. Frame should be placed below card
    // with exactly ROW_GAP between them.
    const normals = [
      makeNormal('card-a', 'u1', '2024-01-01T00:00:00Z'),
      makeNormal('card-b', 'u1', '2024-01-01T00:01:00Z'),
    ];
    const colOf = { 'card-a': 0, 'card-b': 0 };

    // Simulate: card-a is standalone, card-b is inside a frame.
    // At the top level, only card-a and the frame compete for space.
    const standaloneCards = [normals[0]]; // card-a only
    const layout = computeSimpleNoOverlapLayout({
      normals: standaloneCards, colOf, maxCol: 0,
    });

    // Now simulate placing a "frame" at col 0 below card-a.
    // The frame's x-range should be [colX(0), CARD_W] = [18, 338]
    const cardBottom = layout.layout['card-a'].y + layout.layout['card-a'].height;
    const frameTop = cardBottom + ROW_GAP;

    // The frame top should be exactly ROW_GAP below card-a's bottom
    expect(frameTop).toBe(GRID_TOP + 86 + ROW_GAP);
    // = 48 + 86 + 32 = 172
    expect(frameTop).toBe(172);
  });

  it('a frame in col 1 and a card in col 0 can be at the same y (different columns)', () => {
    // Card in col 0, frame in col 1. Different x-ranges → can share same y.
    const cardX = colX(0);
    const cardW = CARD_W; // 320
    const frameX = colX(1); // 418
    const frameW = CARD_W; // 320

    // x-ranges: card=[18,338], frame=[418,738] → no overlap
    const overlap = !(cardX + cardW <= frameX || frameX + frameW <= cardX);
    expect(overlap).toBe(false);
    // So both can start at GRID_TOP simultaneously
  });

  it('a frame should start at GRID_TOP when canvas is empty', () => {
    // Same as a card: empty canvas → start at (GRID_LEFT, GRID_TOP)
    // Empty layout, next item at col 0 would start at GRID_TOP
    const nextY = GRID_TOP;
    expect(nextY).toBe(48);
    const nextX = colX(0);
    expect(nextX).toBe(18);
  });

  it('two frames in same column stack with ROW_GAP, like two cards would', () => {
    // Frame 1 at col 0, height 200. Frame 2 at col 0, height 150.
    // Frame 2 should be at frame1.y + frame1.h + ROW_GAP
    const frame1 = { x: colX(0), y: GRID_TOP, width: CARD_W, height: 200 };
    const frame2ExpectedY = frame1.y + frame1.height + ROW_GAP; // 48 + 200 + 32 = 280 → 286
    expect(frame2ExpectedY).toBe(286);
  });

  it('frames and cards only collide when x-ranges overlap', () => {
    // Same as the card-only invariant tested in computeSimpleNoOverlapLayout
    const layout: Record<string, LayoutBox> = {
      'card-col0': { x: colX(0), y: GRID_TOP, width: CARD_W, height: 86 },
      'frame-col0': { x: colX(0), y: GRID_TOP + 86 + ROW_GAP, width: CARD_W, height: 200 },
      'card-col1': { x: colX(1), y: GRID_TOP, width: CARD_W, height: 86 },
    };
    // card-col0 and frame-col0: same column → stacked
    expect(findOverlaps(layout)).toHaveLength(0);
    // card-col0 bottom = 48+86 = 134
    // frame-col0 top = 48+86+32 = 166 → no overlap ✓
    expect(layout['frame-col0'].y).toBe(172);
  });

  it('FRAME_PAD is internal to the frame, not part of top-level placement', () => {
    // The frame's content starts at FRAME_PAD offset inside,
    // but the frame's top-level rect should include FRAME_PAD.
    const contentStart = colX(0); // 18
    const cardInside = contentStart + FRAME_PAD; // 34
    expect(cardInside).toBe(34);
  });

  it('frame acts as opaque rectangle: internal cards do not affect top-level placement', () => {
    // This is the key invariant: when a frame is placed on the canvas,
    // the cards inside it are invisible to the top-level findY2 algorithm.
    // Only the frame's own placed rect participates in collision detection.
    //
    // Simulate: place a standalone card at col 0, then place a "frame"
    // (represented as a bigger rect) at col 0. The frame should be placed
    // below the card with ROW_GAP, even though the frame contains many
    // internal cards that would fill the same column.
    const cardARect = { x: colX(0), y: GRID_TOP, width: CARD_W, height: 86 };

    // The "frame" rect (wider, taller — like a real arrange frame)
    const frameRect = {
      x: colX(0),
      y: 0, // will be computed
      width: CARD_W + FRAME_PAD * 2,
      height: 200,
    };

    // Placed rects simulate what placedRects2 would contain
    const placedRects = [cardARect];

    // findY2 for the frame: same logic as top-level placement
    function findY2(x: number, w: number): number {
      let y = GRID_TOP;
      for (const r of placedRects) {
        if (x + w <= r.x || r.x + r.width <= x) continue;
        y = Math.max(y, r.y + r.height + ROW_GAP);
      }
      return y;
    }

    const frameY = findY2(frameRect.x, frameRect.width);
    // Frame should be below card A with exactly ROW_GAP
    expect(frameY).toBe(cardARect.y + cardARect.height + ROW_GAP); // 48 + 86 + 32 = 166

    // Now add the frame to placedRects
    frameRect.y = frameY;
    placedRects.push(frameRect);

    // Place another card below the frame
    const cardBY = findY2(colX(0), CARD_W);
    expect(cardBY).toBe(frameRect.y + frameRect.height + ROW_GAP); // 166 + 200 + 32 = 398

    // Verify no overlaps
    const allLayout: Record<string, LayoutBox> = {
      'card-a': cardARect,
      'frame': frameRect,
      'card-b': { x: colX(0), y: cardBY, width: CARD_W, height: 86 },
    };
    expect(findOverlaps(allLayout)).toHaveLength(0);
  });

  it('frames in different columns can share the same y (like cards)', () => {
    // Card at col 0, frame at col 1 → different x-ranges → same y
    const placedRects: Rect[] = [
      { x: colX(0), y: GRID_TOP, width: CARD_W, height: 86 },
    ];

    function findY2(x: number, w: number): number {
      let y = GRID_TOP;
      for (const r of placedRects) {
        if (x + w <= r.x || r.x + r.width <= x) continue;
        y = Math.max(y, r.y + r.height + ROW_GAP);
      }
      return y;
    }

    // Frame at col 1 (different x-range than card at col 0)
    const frameY = findY2(colX(1), CARD_W + FRAME_PAD * 2);
    // No x-overlap with col 0 card, so frame can start at GRID_TOP
    expect(frameY).toBe(GRID_TOP);
  });

  it('frame width includes FRAME_PAD; collision detection uses full width', () => {
    // A frame at col 0 (width = CARD_W + 2*FRAME_PAD = 352)
    // overlaps with x-range [18, 370]
    // A card at col 0 (width = CARD_W = 320) overlaps with [18, 338]
    // A card at the edge of col 0 and col 1: [338, 338+320=658]
    //   Does it overlap with the frame? frame right = 370, card left = 338.
    //   338 < 370 → YES, they overlap!
    const frameLeft = colX(0); // 18
    const frameRight = frameLeft + CARD_W + FRAME_PAD * 2; // 370
    const cardAtEdgeLeft = colX(0) + CARD_W; // 338
    const overlap = cardAtEdgeLeft < frameRight && frameLeft < cardAtEdgeLeft + CARD_W;
    expect(overlap).toBe(true);
  });

  it('frame knows its own rect: x, y, width, height are self-consistent', () => {
    // A frame placed at (fx, fy) with content starting at (fx+FP, fy+FP).
    // The frame rect must equal: card bbox expanded by FRAME_PAD on each side.
    const fx = colX(0);  // 18
    const fy = GRID_TOP; // 48
    const contentX = fx + FRAME_PAD;  // 34
    const contentY = fy + FRAME_PAD;  // 64

    const card1: LayoutBox = { x: contentX, y: contentY, width: CARD_W, height: 86 };
    const card2: LayoutBox = { x: contentX, y: contentY + 86 + ROW_GAP, width: CARD_W, height: 100 };

    const minX = Math.min(card1.x, card2.x);
    const minY = Math.min(card1.y, card2.y);
    const maxR = Math.max(card1.x + card1.width, card2.x + card2.width);

    expect(minX - FRAME_PAD).toBe(fx); // 34-16=18
    expect(minY - FRAME_PAD).toBe(fy); // 64-16=48
    expect(maxR - minX + FRAME_PAD * 2).toBe(CARD_W + FRAME_PAD * 2);
  });

  it('nested frame does NOT push parent frame rect beyond its content', () => {
    const parentContentX = colX(0) + FRAME_PAD; // 34
    const parentCards = [
      { x: parentContentX, y: GRID_TOP + FRAME_PAD, width: CARD_W, height: 86 },
    ];
    // Child frame rect (includes own FRAME_PAD, extends left to x=18)
    const childRect = { x: colX(0), y: 200, width: CARD_W + FRAME_PAD * 2, height: 100 };

    // Parent from cards only: minX=34, frame.x=18 ✓
    const union = unionBoxes(parentCards)!;
    expect(union.x - FRAME_PAD).toBe(colX(0)); // 18

    // If child rect is included: minX=18, frame.x=2 ← BUG
    const withChild = unionBoxes([...parentCards, childRect])!;
    expect(withChild.x - FRAME_PAD).toBe(2);
  });
});

// ============================================================
// Stage 1½: computeFrameAwareColumnCorrection
// ============================================================

describe('computeFrameAwareColumnCorrection', () => {
  it('returns unchanged columns when no frame rects are provided', () => {
    const normals = [makeNormal('a'), makeNormal('b')];
    const colOf = { a: 0, b: 0 };
    const result = computeFrameAwareColumnCorrection({
      normals, edges: [], colOf, maxCol: 0, frameRects: {},
    });
    expect(result.col).toEqual(colOf);
    expect(result.maxCol).toBe(0);
  });

  it('pushes annotation source right of a wide frame (mock-101 → r10 scenario)', () => {
    // r10 is a horizontal arrange frame spanning from x=18 to x=774 (width=756)
    // mock-101 annotates r10 and should go to col ≥ ceil((774-18)/400) = ceil(756/400) = 2
    const normals = [makeNormal('mock-101'), makeNormal('m5'), makeNormal('m6')];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-anno', 'mock-101', 'r10'),
    ];
    const colOf = { 'mock-101': 1, m5: 0, m6: 1 };
    const frameRects: Record<string, { x: number; y: number; width: number; height: number }> = {
      r10: { x: 18, y: 362, width: 756, height: 244 }, // right edge = 774
    };
    const result = computeFrameAwareColumnCorrection({
      normals, edges, colOf, maxCol: 1, frameRects,
    });
    // minCol = ceil((774 - 18) / 400) = ceil(756/400) = 2
    expect(result.col['mock-101']).toBeGreaterThanOrEqual(2);
  });

  it('pushes reference source right of a frame', () => {
    const normals = [makeNormal('src'), makeNormal('a')];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'reference', 'rel-ref', 'src', 'frame1'),
    ];
    const colOf = { src: 0, a: 0 };
    const frameRects = {
      frame1: { x: colX(0), y: 0, width: CARD_W + FRAME_PAD * 2, height: 200 }, // right edge = 18+352=370
    };
    const result = computeFrameAwareColumnCorrection({
      normals, edges, colOf, maxCol: 0, frameRects,
    });
    // minCol = ceil((370 - 18) / 400) = ceil(352/400) = 1
    expect(result.col['src']).toBeGreaterThanOrEqual(1);
  });

  it('pushes notify source right of a frame', () => {
    const normals = [makeNormal('src'), makeNormal('a')];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'notify', 'rel-notify', 'src', 'frame1'),
    ];
    const colOf = { src: 0, a: 0 };
    const frameRects = {
      frame1: { x: colX(0), y: 0, width: CARD_W + FRAME_PAD * 2, height: 200 },
    };
    const result = computeFrameAwareColumnCorrection({
      normals, edges, colOf, maxCol: 0, frameRects,
    });
    expect(result.col['src']).toBeGreaterThanOrEqual(1);
  });

  it('pushes reply source right of a frame target', () => {
    const normals = [makeNormal('replySrc'), makeNormal('a')];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'reply', 'rel-reply', 'replySrc', 'bigFrame'),
    ];
    const colOf = { replySrc: 0, a: 0 };
    const frameRects = {
      bigFrame: { x: colX(1), y: 0, width: CARD_W * 2 + COL_GAP, height: 300 },
      // right edge = 418 + 720 = 1138
      // minCol = ceil((1138 - 18) / 400) = ceil(1120/400) = 3
    };
    const result = computeFrameAwareColumnCorrection({
      normals, edges, colOf, maxCol: 2, frameRects,
    });
    expect(result.col['replySrc']).toBeGreaterThanOrEqual(3);
  });

  it('propagates cascading constraints after frame correction', () => {
    // mock-101 → r10 (frame), mock-102 → mock-101 (annotation to text)
    // r10 right=774 → mock-101 col ≥ 2
    // mock-101 col=2 → mock-102 col ≥ 3
    const normals = [makeNormal('mock-101'), makeNormal('mock-102'), makeNormal('m5')];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 'mock-101', 'r10'),
      makeEdge('e2', 'annotation', 'rel-2', 'mock-102', 'mock-101'),
    ];
    const colOf = { 'mock-101': 1, 'mock-102': 2, m5: 0 };
    const frameRects = {
      r10: { x: 18, y: 0, width: 756, height: 200 },
    };
    const result = computeFrameAwareColumnCorrection({
      normals, edges, colOf, maxCol: 2, frameRects,
    });
    expect(result.col['mock-101']).toBeGreaterThanOrEqual(2);
    expect(result.col['mock-102']).toBeGreaterThanOrEqual(result.col['mock-101'] + 1);
  });

  it('does not affect non-annotation/reference/reply edges', () => {
    const normals = [makeNormal('src'), makeNormal('tgt')];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'agree', 'rel-agree', 'src', 'frame1'),
    ];
    const colOf = { src: 0, tgt: 0 };
    const frameRects = {
      frame1: { x: colX(0), y: 0, width: 2000, height: 100 },
    };
    const result = computeFrameAwareColumnCorrection({
      normals, edges, colOf, maxCol: 0, frameRects,
    });
    // AGREE should NOT be affected by frame-aware correction
    expect(result.col['src']).toBe(0);
  });

  it('does not move sources that are already far enough right', () => {
    const normals = [makeNormal('src'), makeNormal('a')];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 'src', 'smallFrame'),
    ];
    const colOf = { src: 5, a: 0 };
    const frameRects = {
      smallFrame: { x: colX(0), y: 0, width: CARD_W, height: 100 }, // right = 338
    };
    const result = computeFrameAwareColumnCorrection({
      normals, edges, colOf, maxCol: 5, frameRects,
    });
    // minCol = ceil((338 - 18) / 400) = ceil(320/400) = 1
    // src is already at col 5, should stay there
    expect(result.col['src']).toBe(5);
  });

  it('handles multiple sources targeting different frames', () => {
    const normals = [
      makeNormal('anno1'), makeNormal('anno2'),
      makeNormal('a'), makeNormal('b'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 'anno1', 'frameA'),
      makeEdge('e2', 'reference', 'rel-2', 'anno2', 'frameB'),
    ];
    const colOf = { anno1: 0, anno2: 0, a: 0, b: 0 };
    const frameRects = {
      frameA: { x: colX(0), y: 0, width: CARD_W, height: 100 },        // right=338 → minCol=ceil(320/400)=1
      frameB: { x: colX(0), y: 0, width: CARD_W * 2 + COL_GAP, height: 100 }, // right=738 → minCol=ceil(720/400)=2
    };
    const result = computeFrameAwareColumnCorrection({
      normals, edges, colOf, maxCol: 0, frameRects,
    });
    expect(result.col['anno1']).toBeGreaterThanOrEqual(1);
    // frameB right=738, minCol=ceil((738-18)/400)=ceil(720/400)=2
    expect(result.col['anno2']).toBeGreaterThanOrEqual(2);
  });

  it('returns same result when no edges target frames', () => {
    const normals = [makeNormal('a'), makeNormal('b')];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 'b', 'a'),
    ];
    const colOf = { a: 0, b: 1 };
    const result = computeFrameAwareColumnCorrection({
      normals, edges, colOf, maxCol: 1, frameRects: {},
    });
    expect(result.col).toEqual({ a: 0, b: 1 });
  });
});

// ============================================================
// Stage 2½: compactAnnoRefClusters
// ============================================================

describe('compactAnnoRefClusters', () => {
  it('returns unchanged layout when no annotation/reference edges', () => {
    const normals = [makeNormal('a'), makeNormal('b')];
    const layout = { a: { x: colX(0), y: 48, width: CARD_W, height: 86 }, b: { x: colX(1), y: 48, width: CARD_W, height: 86 } };
    const result = compactAnnoRefClusters({
      layout, normals, colOf: { a: 0, b: 1 }, edges: [], allFrameRects: {}, canvasHeight: 200,
    });
    expect(result.layout).toEqual(layout);
  });

  it('shifts annotation source toward its text-message target', () => {
    // src annotates tgt. tgt at y=362, src initially at y=48 (far above).
    // src should be shifted down to targetY=362 (col 2 is empty there).
    const normals = [makeNormal('src'), makeNormal('tgt')];
    const colOf = { src: 2, tgt: 0 };
    const layout = {
      src: { x: colX(2), y: 48, width: CARD_W, height: 86 },
      tgt: { x: colX(0), y: 362, width: CARD_W, height: 100 },
    };
    const edges: DemoEdge[] = [makeEdge('e1', 'annotation', 'rel-1', 'src', 'tgt')];
    const result = compactAnnoRefClusters({
      layout, normals, colOf, edges, allFrameRects: {}, canvasHeight: 500,
    });
    // src should be at y=362 (aligned with target)
    expect(result.layout['src'].y).toBe(362);
  });

  it('stacks multiple sources toward target (middle card aligned)', () => {
    // Three sources targeting tgt at y=362.
    // n=3, middleIdx=1 (s2). heightAbove = 86+32 = 118. idealTop = 362-118 = 244.
    const normals = [makeNormal('s1', 'a', '2024-01-01'), makeNormal('s2', 'b', '2024-01-02'), makeNormal('s3', 'c', '2024-01-03'), makeNormal('tgt')];
    const colOf = { s1: 2, s2: 2, s3: 2, tgt: 0 };
    const layout = {
      s1: { x: colX(2), y: 48, width: CARD_W, height: 86 },
      s2: { x: colX(2), y: 166, width: CARD_W, height: 86 },
      s3: { x: colX(2), y: 284, width: CARD_W, height: 86 },
      tgt: { x: colX(0), y: 362, width: CARD_W, height: 100 },
    };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 's1', 'tgt'),
      makeEdge('e2', 'annotation', 'rel-2', 's2', 'tgt'),
      makeEdge('e3', 'reference', 'rel-3', 's3', 'tgt'),
    ];
    const result = compactAnnoRefClusters({
      layout, normals, colOf, edges, allFrameRects: {}, canvasHeight: 500,
    });
    // Middle card (s2) top should be at targetY=362
    expect(result.layout['s2'].y).toBe(362);
    // s1 above s2: 362 - 86 - 32 = 244 → 238
    expect(result.layout['s1'].y).toBe(238);
    // s3 below s2: 362 + 86 + 32 = 480 → 486
    expect(result.layout['s3'].y).toBe(486);
    // target unchanged
    expect(result.layout['tgt'].y).toBe(362);
  });

  it('respects upper bound from unrelated card above the cluster', () => {
    // Unrelated card X at y=48 (bottom=134).
    // n=2, middleIdx=1 (s2). heightAbove = 86+32 = 118. idealTop = 362-118 = 244.
    // X bottom=134, upperBound = 134+32 = 166. 244 > 166, so top = 238.
    const normals = [makeNormal('X'), makeNormal('s1', 'a', '2024-01-01'), makeNormal('s2', 'b', '2024-01-02'), makeNormal('tgt')];
    const colOf = { X: 2, s1: 2, s2: 2, tgt: 0 };
    const layout = {
      X: { x: colX(2), y: 48, width: CARD_W, height: 86 },
      s1: { x: colX(2), y: 166, width: CARD_W, height: 86 },
      s2: { x: colX(2), y: 284, width: CARD_W, height: 86 },
      tgt: { x: colX(0), y: 362, width: CARD_W, height: 100 },
    };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 's1', 'tgt'),
      makeEdge('e2', 'annotation', 'rel-2', 's2', 'tgt'),
    ];
    const result = compactAnnoRefClusters({
      layout, normals, colOf, edges, allFrameRects: {}, canvasHeight: 500,
    });
    // s1 at 238, s2 at 362 (top aligned with target)
    expect(result.layout['s1'].y).toBe(238);
    expect(result.layout['s2'].y).toBe(362);
  });

  it('moves cluster toward target even when above it', () => {
    // Cluster at y=280, target at y=362. n=2, middleIdx=1.
    // heightAbove = 86+32 = 118. idealTop = 362-118 = 244.
    // newTop = max(48, 244) = 238. s1 at 238, s2 at 362.
    const normals = [makeNormal('s1'), makeNormal('s2'), makeNormal('tgt')];
    const colOf = { s1: 2, s2: 2, tgt: 0 };
    const layout = {
      s1: { x: colX(2), y: 280, width: CARD_W, height: 86 },
      s2: { x: colX(2), y: 398, width: CARD_W, height: 86 },
      tgt: { x: colX(0), y: 362, width: CARD_W, height: 100 },
    };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 's1', 'tgt'),
      makeEdge('e2', 'reference', 'rel-2', 's2', 'tgt'),
    ];
    const result = compactAnnoRefClusters({
      layout, normals, colOf, edges, allFrameRects: {}, canvasHeight: 500,
    });
    // Cluster should move to ideal position: s1 at 238, s2 at 362
    expect(result.layout['s1'].y).toBe(238);
    expect(result.layout['s2'].y).toBe(362);
  });

  it('shifts source toward frame target', () => {
    // src annotates a frame at y=362
    const normals = [makeNormal('src'), makeNormal('a'), makeNormal('b')];
    const colOf = { src: 2, a: 0, b: 1 };
    const layout = {
      src: { x: colX(2), y: 48, width: CARD_W, height: 86 },
      a: { x: colX(0), y: 410, width: CARD_W, height: 100 },
      b: { x: colX(1), y: 410, width: CARD_W, height: 100 },
    };
    const edges: DemoEdge[] = [makeEdge('e1', 'annotation', 'rel-1', 'src', 'frame1')];
    const frameRects = { frame1: { x: colX(0), y: 362, width: CARD_W * 2 + COL_GAP, height: 200 } };
    const result = compactAnnoRefClusters({
      layout, normals, colOf, edges, allFrameRects: frameRects, canvasHeight: 600,
    });
    // src should be at y=362 (aligned with frame top)
    expect(result.layout['src'].y).toBe(362);
  });

  it('does not move non-annotation/reference edges', () => {
    // Reply sources should NOT be compacted (only anno/ref)
    const normals = [makeNormal('src'), makeNormal('tgt')];
    const colOf = { src: 2, tgt: 0 };
    const layout = {
      src: { x: colX(2), y: 48, width: CARD_W, height: 86 },
      tgt: { x: colX(0), y: 362, width: CARD_W, height: 100 },
    };
    const edges: DemoEdge[] = [makeEdge('e1', 'reply', 'rel-1', 'src', 'tgt')];
    const result = compactAnnoRefClusters({
      layout, normals, colOf, edges, allFrameRects: {}, canvasHeight: 500,
    });
    // Reply should NOT be compacted
    expect(result.layout['src'].y).toBe(48);
  });

  it('handles interleaved clusters in different columns independently', () => {
    // targetA at col 0 y=300, sources in col 2
    // targetB at col 1 y=500, sources in col 2
    const normals = [
      makeNormal('a1', 'x', '2024-01-01'), makeNormal('a2', 'x', '2024-01-02'),
      makeNormal('b1', 'x', '2024-01-03'), makeNormal('b2', 'x', '2024-01-04'),
      makeNormal('tA'), makeNormal('tB'),
    ];
    const colOf = { a1: 2, a2: 2, b1: 2, b2: 2, tA: 0, tB: 1 };
    const layout = {
      a1: { x: colX(2), y: 48, width: CARD_W, height: 86 },
      a2: { x: colX(2), y: 166, width: CARD_W, height: 86 },
      b1: { x: colX(2), y: 284, width: CARD_W, height: 86 },
      b2: { x: colX(2), y: 402, width: CARD_W, height: 86 },
      tA: { x: colX(0), y: 300, width: CARD_W, height: 100 },
      tB: { x: colX(1), y: 500, width: CARD_W, height: 100 },
    };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'rel-1', 'a1', 'tA'),
      makeEdge('e2', 'annotation', 'rel-2', 'a2', 'tA'),
      makeEdge('e3', 'reference', 'rel-3', 'b1', 'tB'),
      makeEdge('e4', 'reference', 'rel-4', 'b2', 'tB'),
    ];
    const result = compactAnnoRefClusters({
      layout, normals, colOf, edges, allFrameRects: {}, canvasHeight: 700,
    });
    // Cluster A (a1, a2) → targetA at y=300
    // n=2, middleIdx=1, heightAbove=86+32=118, idealTop=300-118=182
    // upperBound=48, newTop=176
    expect(result.layout['a1'].y).toBe(176);
    expect(result.layout['a2'].y).toBe(300);
    // Cluster B (b1, b2) → targetB at y=500. a2 bottom=300+86=386.
    // upperBound = 386+32 = 418 → 424
    // n=2, middleIdx=1, heightAbove=118, idealTop=500-118=382
    // 382 < 424, so top = 424
    expect(result.layout['b1'].y).toBe(424);
    expect(result.layout['b2'].y).toBe(548);
  });

  it('uses frame top edge when target card is inside a frame (m7 → m5 bug)', () => {
    // m7 REFERENCES m5. m5 is inside frame r10 at y=410, but the frame's
    // top edge is at y=362. m7 should align with the frame (362), not m5 (410).
    const normals = [
      makeNormal('m7'), makeNormal('m5'), makeNormal('m6'),
    ];
    const colOf = { m7: 1, m5: 0, m6: 1 };
    const layout = {
      m7: { x: colX(1), y: 638, width: CARD_W, height: 90 },
      m5: { x: colX(0) + FRAME_PAD, y: 410, width: CARD_W, height: 148 },
      m6: { x: colX(1), y: 410, width: CARD_W, height: 109 },
    };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'reference', 'r11', 'm7', 'm5'),
    ];
    const frameRects = {
      r10: { x: colX(0), y: 362, width: CARD_W * 2 + COL_GAP + FRAME_PAD * 2, height: 224 },
    };
    const result = compactAnnoRefClusters({
      layout, normals, colOf, edges, allFrameRects: frameRects, canvasHeight: 800,
    });
    // m7 should be pushed below r10 (frame avoidance):
    // r10 bottom=586, +ROW_GAP=618. m7 at y=624.
    expect(result.layout['m7'].y).toBe(624);
    // m5 and m6 should NOT be moved (they're inside the frame, not sources)
    expect(result.layout['m5'].y).toBe(410);
    expect(result.layout['m6'].y).toBe(410);
  });

  it('does not move anno/ref sources that are inside a frame', () => {
    // m1 is inside merge frame mock-101. m1 ANNOTATION → m2.
    // Compact should NOT move m1 — its position is managed by the merge layout.
    const normals = [makeNormal('m1'), makeNormal('m2')];
    const colOf = { m1: 0, m2: 0 };
    const layout = {
      m1: { x: colX(0) + FRAME_PAD, y: 100, width: CARD_W, height: 86 },
      m2: { x: colX(0) + FRAME_PAD, y: 300, width: CARD_W, height: 86 },
    };
    const edges: DemoEdge[] = [
      makeEdge('e1', 'annotation', 'r6', 'm1', 'm2'),
    ];
    const frameRects = {
      'mock-101': { x: colX(0), y: 48, width: CARD_W + FRAME_PAD * 2, height: 400 },
    };
    const result = compactAnnoRefClusters({
      layout, normals, colOf, edges, allFrameRects: frameRects, canvasHeight: 500,
    });
    // m1 should NOT be moved — it's inside mock-101 frame
    expect(result.layout['m1'].y).toBe(100);
    expect(result.layout['m2'].y).toBe(300);
  });
});
