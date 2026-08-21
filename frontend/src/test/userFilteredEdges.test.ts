/**
 * userFilteredEdges.test.ts — Unit tests for computeUserFilteredEdges,
 * computeUserSuppressedRelIds, and computeTransitiveVoteStats.
 *
 * Tests the per-user branch semantics and transitive vote counting.
 */

import { describe, it, expect } from 'vitest';
import { computeUserFilteredEdges, computeUserSuppressedRelIds, computeTransitiveVoteStats, computeEffectiveSuppressedRelIds } from '../utils/modelBridge';
import type { DemoMessage, DemoEdge, UnitSelection } from '../utils/modelBridge';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function wholeSel(messageId: string): UnitSelection {
  return { messageId, selection: { kind: 'whole' } };
}

function makeNormalMsg(id: string, author: string, content = `Content of ${id}`): DemoMessage {
  return {
    id,
    author,
    createdAt: new Date().toISOString(),
    content,
    kind: 'normal',
  };
}

function makeRelationMsg(
  id: string,
  author: string,
  relationType: string,
): DemoMessage {
  return {
    id,
    author,
    createdAt: new Date().toISOString(),
    content: `建立${relationType}关系\n来源：${author}\n目标：…`,
    kind: 'relation',
    relationType: relationType as any,
  };
}

function makeEdge(
  id: string,
  relationMessageId: string,
  relationType: string,
  fromId: string,
  toId: string,
): DemoEdge {
  return {
    id,
    relationMessageId,
    relationType: relationType as any,
    from: wholeSel(fromId),
    to: wholeSel(toId),
    relationLabel: relationType,
  };
}

// ─── computeUserFilteredEdges ────────────────────────────────────────────

describe('computeUserFilteredEdges', () => {
  // ── Basic cases ──

  it('returns all edges when no user is logged in', () => {
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeRelationMsg('rel-arr', 'alice', 'arrange'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'), // hypothetical m2
    ];
    const result = computeUserFilteredEdges(edges, msgs, null);
    expect(result).toEqual(edges);
  });

  it('returns all edges when user has no DISAGREE relations', () => {
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeNormalMsg('m2', 'bob'),
      makeRelationMsg('rel-arr', 'alice', 'arrange'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
    ];
    const result = computeUserFilteredEdges(edges, msgs, 'bob');
    expect(result).toEqual(edges);
  });

  it('returns empty when input edges is empty', () => {
    const result = computeUserFilteredEdges([], [], 'alice');
    expect(result).toEqual([]);
  });

  // ── DISAGREE on relation message → suppression ──

  it('suppresses edges of a relation message the user DISAGREEs with', () => {
    // Alice creates an ARRANGE relation (rel-arr) between m1 and m2.
    // Bob sends a DISAGREE targeting rel-arr.
    // Bob should not see edges produced by rel-arr.
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeNormalMsg('m2', 'alice'),
      makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-disagree', 'bob'),   // Bob's DISAGREE stance message
      makeRelationMsg('rel-disagree', 'bob', 'disagree'),
    ];
    const edges: DemoEdge[] = [
      // The ARRANGE relation produces edges
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-arr', 'arrange', 'm1', 'm2'),
      // Bob's DISAGREE targets the ARRANGE relation message
      makeEdge('e3', 'rel-disagree', 'disagree', 'm-disagree', 'rel-arr'),
    ];
    const result = computeUserFilteredEdges(edges, msgs, 'bob');

    // Bob should no longer see the arrange edges
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('e3'); // only Bob's own DISAGREE edge remains
  });

  it('uses full stance edges when the displayed edge scope is a classify subset', () => {
    const msgs: DemoMessage[] = [
      makeNormalMsg('annotation-source', 'alice'),
      makeNormalMsg('target', 'alice'),
      makeRelationMsg('rel-annotation', 'alice', 'annotation'),
      makeNormalMsg('bob-disagree-source', 'bob'),
      makeRelationMsg('rel-disagree', 'bob', 'disagree'),
    ];
    const allEdges: DemoEdge[] = [
      makeEdge('annotation-edge', 'rel-annotation', 'annotation', 'annotation-source', 'target'),
      makeEdge('disagree-edge', 'rel-disagree', 'disagree', 'bob-disagree-source', 'rel-annotation'),
    ];

    // The current classify view contains the annotation edge but not Bob's
    // stance edge. Suppression must still be calculated from allEdges.
    const result = computeUserFilteredEdges(
      [allEdges[0]],
      msgs,
      'bob',
      allEdges,
    );
    expect(result).toEqual([]);
  });

  it('does NOT suppress edges for other users (only the disagreeing user)', () => {
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeNormalMsg('m2', 'alice'),
      makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-disagree', 'bob'),
      makeRelationMsg('rel-disagree', 'bob', 'disagree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e3', 'rel-disagree', 'disagree', 'm-disagree', 'rel-arr'),
    ];

    // Alice (the arranger) still sees everything
    const aliceResult = computeUserFilteredEdges(edges, msgs, 'alice');
    expect(aliceResult).toHaveLength(3);

    // Charlie (a third party) also sees everything
    const charlieResult = computeUserFilteredEdges(edges, msgs, 'charlie');
    expect(charlieResult).toHaveLength(3);
  });

  it('each user only sees suppression for their own DISAGREEs', () => {
    // Alice arranges, Bob disagrees with her arrange,
    // Charlie also disagrees with a different arrange.
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeNormalMsg('m2', 'alice'),
      makeRelationMsg('rel-arr1', 'alice', 'arrange'),
      makeRelationMsg('rel-arr2', 'alice', 'arrange'),
      makeNormalMsg('m-bob-dis', 'bob'),
      makeRelationMsg('rel-bob-dis', 'bob', 'disagree'),
      makeNormalMsg('m-charlie-dis', 'charlie'),
      makeRelationMsg('rel-charlie-dis', 'charlie', 'disagree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr1', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-arr2', 'arrange', 'm1', 'm2'),
      // Bob disagrees with rel-arr1
      makeEdge('e3', 'rel-bob-dis', 'disagree', 'm-bob-dis', 'rel-arr1'),
      // Charlie disagrees with rel-arr2
      makeEdge('e4', 'rel-charlie-dis', 'disagree', 'm-charlie-dis', 'rel-arr2'),
    ];

    // Bob sees e2, e3, e4 (e1 suppressed because he disagreed with rel-arr1)
    const bobResult = computeUserFilteredEdges(edges, msgs, 'bob');
    expect(bobResult.map(e => e.id).sort()).toEqual(['e2', 'e3', 'e4']);

    // Charlie sees e1, e3, e4 (e2 suppressed because he disagreed with rel-arr2)
    const charlieResult = computeUserFilteredEdges(edges, msgs, 'charlie');
    expect(charlieResult.map(e => e.id).sort()).toEqual(['e1', 'e3', 'e4']);
  });

  // ── DISAGREE on text message → no suppression ──

  it('does NOT suppress when DISAGREE targets a text message (not a relation)', () => {
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeNormalMsg('m2', 'bob'),
      makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-disagree', 'bob'),
      makeRelationMsg('rel-disagree', 'bob', 'disagree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      // Bob disagrees with m2 (a text message, not a relation)
      makeEdge('e2', 'rel-disagree', 'disagree', 'm-disagree', 'm2'),
    ];

    // Disagreeing with a text message should not suppress any relation edges
    const result = computeUserFilteredEdges(edges, msgs, 'bob');
    expect(result).toHaveLength(2);
  });

  // ── AGREE does not suppress ──

  it('does NOT suppress edges when user AGREEs with a relation message', () => {
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeNormalMsg('m2', 'alice'),
      makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-agree', 'bob'),
      makeRelationMsg('rel-agree', 'bob', 'agree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      // Bob AGREEs with the arrange (not DISAGREE)
      makeEdge('e2', 'rel-agree', 'agree', 'm-agree', 'rel-arr'),
    ];

    const result = computeUserFilteredEdges(edges, msgs, 'bob');
    expect(result).toHaveLength(2); // AGREE does not suppress
  });

  // ── Latest stance wins (toggle support) ──

  it('AGREE after DISAGREE restores the relation (latest stance wins)', () => {
    // Bob first disagrees, then later agrees. The later AGREE should win.
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeRelationMsg('rel-arr', 'alice', 'arrange'),
      // Bob's DISAGREE (older)
      makeNormalMsg('m-dis', 'bob'),
      makeRelationMsg('rel-dis', 'bob', 'disagree'),
      // Bob's AGREE (newer — should win)
      makeNormalMsg('m-agree', 'bob'),
      makeRelationMsg('rel-agree', 'bob', 'agree'),
    ];
    // Override timestamps: make DISAGREE older, AGREE newer
    msgs.find(m => m.id === 'm-dis')!.createdAt = '2025-01-01T00:00:00Z';
    msgs.find(m => m.id === 'm-agree')!.createdAt = '2025-01-02T00:00:00Z';

    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-dis', 'disagree', 'm-dis', 'rel-arr'),
      makeEdge('e3', 'rel-agree', 'agree', 'm-agree', 'rel-arr'),
    ];

    const result = computeUserFilteredEdges(edges, msgs, 'bob');
    // Latest is AGREE → no suppression
    expect(result).toHaveLength(3);
  });

  it('DISAGREE after AGREE suppresses the relation (latest stance wins)', () => {
    // Bob first agrees, then later disagrees. The later DISAGREE should win.
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-agree', 'bob'),
      makeRelationMsg('rel-agree', 'bob', 'agree'),
      makeNormalMsg('m-dis', 'bob'),
      makeRelationMsg('rel-dis', 'bob', 'disagree'),
    ];
    msgs.find(m => m.id === 'm-agree')!.createdAt = '2025-01-01T00:00:00Z';
    msgs.find(m => m.id === 'm-dis')!.createdAt = '2025-01-02T00:00:00Z';

    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-agree', 'agree', 'm-agree', 'rel-arr'),
      makeEdge('e3', 'rel-dis', 'disagree', 'm-dis', 'rel-arr'),
    ];

    const result = computeUserFilteredEdges(edges, msgs, 'bob');
    // Latest is DISAGREE → suppress rel-arr's edges
    expect(result.map(e => e.id)).toEqual(['e2', 'e3']);
  });

  it('multiple toggles: only the latest stance matters', () => {
    // Bob: agree → disagree → agree → disagree → ... only the latest matters
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-a1', 'bob'),
      makeRelationMsg('rel-a1', 'bob', 'agree'),
      makeNormalMsg('m-d1', 'bob'),
      makeRelationMsg('rel-d1', 'bob', 'disagree'),
      makeNormalMsg('m-a2', 'bob'),
      makeRelationMsg('rel-a2', 'bob', 'agree'),
    ];
    msgs.find(m => m.id === 'm-a1')!.createdAt = '2025-01-01T00:00:00Z';
    msgs.find(m => m.id === 'm-d1')!.createdAt = '2025-01-02T00:00:00Z';
    msgs.find(m => m.id === 'm-a2')!.createdAt = '2025-01-03T00:00:00Z'; // latest = AGREE

    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-a1', 'agree', 'm-a1', 'rel-arr'),
      makeEdge('e3', 'rel-d1', 'disagree', 'm-d1', 'rel-arr'),
      makeEdge('e4', 'rel-a2', 'agree', 'm-a2', 'rel-arr'),
    ];

    const result = computeUserFilteredEdges(edges, msgs, 'bob');
    // Latest is AGREE → all edges visible
    expect(result).toHaveLength(4);
  });

  // ── DISAGREE not authored by current user → no suppression ──

  it('ignores DISAGREE edges authored by other users', () => {
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-disagree', 'bob'),
      makeRelationMsg('rel-disagree', 'bob', 'disagree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      // Bob DISAGREEs, but current user is Charlie
      makeEdge('e2', 'rel-disagree', 'disagree', 'm-disagree', 'rel-arr'),
    ];

    // Charlie is not Bob, so Bob's DISAGREE doesn't affect Charlie's view
    const result = computeUserFilteredEdges(edges, msgs, 'charlie');
    expect(result).toHaveLength(2);
  });

  // ── Multiple relations suppressed ──

  it('suppresses edges from multiple relation messages the user DISAGREEs with', () => {
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeNormalMsg('m2', 'alice'),
      makeRelationMsg('rel-arr1', 'alice', 'arrange'),
      makeRelationMsg('rel-arr2', 'alice', 'arrange'),
      makeRelationMsg('rel-arr3', 'alice', 'arrange'),
      makeNormalMsg('m-dis1', 'bob'),
      makeRelationMsg('rel-dis1', 'bob', 'disagree'),
      makeNormalMsg('m-dis2', 'bob'),
      makeRelationMsg('rel-dis2', 'bob', 'disagree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr1', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-arr2', 'arrange', 'm1', 'm2'),
      makeEdge('e3', 'rel-arr3', 'arrange', 'm1', 'm2'),
      // Bob disagrees with rel-arr1 and rel-arr2
      makeEdge('e4', 'rel-dis1', 'disagree', 'm-dis1', 'rel-arr1'),
      makeEdge('e5', 'rel-dis2', 'disagree', 'm-dis2', 'rel-arr2'),
    ];

    const result = computeUserFilteredEdges(edges, msgs, 'bob');
    // Only e3 (rel-arr3, not disagreed) and the DISAGREE edges remain
    expect(result.map(e => e.id).sort()).toEqual(['e3', 'e4', 'e5']);
  });

  // ── DISAGREE via pure stance (anon: source) ──

  it('suppresses edges when pure-stance DISAGREE is authored by current user', () => {
    // Bob sends a pure-stance DISAGREE (anon: source) targeting rel-arr.
    // The relation message rel-dis is authored by Bob, so the DISAGREE
    // should be attributed to Bob and suppress rel-arr's edges.
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeRelationMsg('rel-dis', 'bob', 'disagree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      // Pure-stance DISAGREE: from is anon, but rel-dis's author is Bob
      {
        id: 'e2',
        relationMessageId: 'rel-dis',
        relationType: 'disagree' as any,
        from: wholeSel('anon:rel-dis'),
        to: wholeSel('rel-arr'),
        relationLabel: 'disagree',
      },
    ];

    const result = computeUserFilteredEdges(edges, msgs, 'bob');
    // Bob authored rel-dis → his DISAGREE suppresses rel-arr's edges
    expect(result.map(e => e.id)).toEqual(['e2']);
  });

  it('does NOT suppress when pure-stance DISAGREE is authored by a different user', () => {
    // Alice sends a pure-stance DISAGREE targeting rel-arr.
    // Bob is the current user — Alice's DISAGREE should not affect Bob's view.
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeRelationMsg('rel-arr', 'charlie', 'arrange'),
      makeRelationMsg('rel-dis', 'alice', 'disagree'),  // authored by Alice
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      {
        id: 'e2',
        relationMessageId: 'rel-dis',
        relationType: 'disagree' as any,
        from: wholeSel('anon:rel-dis'),
        to: wholeSel('rel-arr'),
        relationLabel: 'disagree',
      },
    ];

    const result = computeUserFilteredEdges(edges, msgs, 'bob');
    // Alice's DISAGREE — Bob is not affected
    expect(result).toHaveLength(2);
  });
});

// ─── computeUserSuppressedRelIds ──────────────────────────────────────────

describe('computeUserSuppressedRelIds', () => {
  it('returns empty set when no user is logged in', () => {
    const msgs: DemoMessage[] = [makeNormalMsg('m1', 'alice'), makeRelationMsg('rel-arr', 'alice', 'arrange')];
    const edges: DemoEdge[] = [makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2')];
    expect(computeUserSuppressedRelIds(edges, msgs, null).size).toBe(0);
  });

  it('returns empty set when user has no stances', () => {
    const msgs: DemoMessage[] = [makeNormalMsg('m1', 'alice'), makeRelationMsg('rel-arr', 'alice', 'arrange')];
    const edges: DemoEdge[] = [makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2')];
    expect(computeUserSuppressedRelIds(edges, msgs, 'bob').size).toBe(0);
  });

  it('returns the ID when latest stance is DISAGREE', () => {
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'), makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-dis', 'bob'), makeRelationMsg('rel-dis', 'bob', 'disagree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-dis', 'disagree', 'm-dis', 'rel-arr'),
    ];
    const result = computeUserSuppressedRelIds(edges, msgs, 'bob');
    expect(result.has('rel-arr')).toBe(true);
  });

  it('does NOT return the ID when latest stance is AGREE', () => {
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'), makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-agree', 'bob'), makeRelationMsg('rel-agree', 'bob', 'agree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-agree', 'agree', 'm-agree', 'rel-arr'),
    ];
    const result = computeUserSuppressedRelIds(edges, msgs, 'bob');
    expect(result.size).toBe(0);
  });

  // ── Meta-stance: disagree with own disagree → cancel ──

  it('disagreeing with own disagree cancels the original suppression', () => {
    // Bob disagrees with rel-arr (creates rel-dis-1).
    // Then Bob disagrees with rel-dis-1 itself (creates rel-dis-2).
    // With transitive resolution: DISAGREE on DISAGREE on rel-arr = AGREE on rel-arr.
    // So rel-arr should NOT be suppressed.
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-dis1', 'bob'),
      makeRelationMsg('rel-dis-1', 'bob', 'disagree'),
      makeNormalMsg('m-dis2', 'bob'),
      makeRelationMsg('rel-dis-2', 'bob', 'disagree'),
    ];
    msgs.find(m => m.id === 'm-dis1')!.createdAt = '2025-01-01T00:00:00Z';
    msgs.find(m => m.id === 'm-dis2')!.createdAt = '2025-01-02T00:00:00Z'; // later

    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-dis-1', 'disagree', 'm-dis1', 'rel-arr'),
      makeEdge('e3', 'rel-dis-2', 'disagree', 'm-dis2', 'rel-dis-1'),
    ];

    const result = computeUserSuppressedRelIds(edges, msgs, 'bob');
    // rel-arr NOT suppressed: effective stance = DISAGREE(DISAGREE(rel-arr)) = AGREE
    expect(result.has('rel-arr')).toBe(false);
    // rel-dis-1 is not an ultimate target, so it's not in the suppressed set
    expect(result.has('rel-dis-1')).toBe(false);
  });

  it('meta-stance cancel only works when the cancel is newer', () => {
    // Bob disagrees with rel-dis-1 first (effective AGREE on rel-arr, older).
    // Then Bob disagrees with rel-arr directly (DISAGREE, newer).
    // Latest effective stance on rel-arr = DISAGREE → rel-arr IS suppressed.
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'),
      makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-dis1', 'bob'),
      makeRelationMsg('rel-dis-1', 'bob', 'disagree'),
      makeNormalMsg('m-dis2', 'bob'),
      makeRelationMsg('rel-dis-2', 'bob', 'disagree'),
    ];
    // m-dis2 is OLDER — effective AGREE on rel-arr comes first
    msgs.find(m => m.id === 'm-dis2')!.createdAt = '2025-01-01T00:00:00Z';
    // m-dis1 is NEWER — direct DISAGREE on rel-arr wins
    msgs.find(m => m.id === 'm-dis1')!.createdAt = '2025-01-02T00:00:00Z';

    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-dis-1', 'disagree', 'm-dis1', 'rel-arr'),
      makeEdge('e3', 'rel-dis-2', 'disagree', 'm-dis2', 'rel-dis-1'),
    ];

    const result = computeUserSuppressedRelIds(edges, msgs, 'bob');
    // rel-arr IS suppressed (direct DISAGREE is the latest effective stance)
    expect(result.has('rel-arr')).toBe(true);
    // Intermediate stances are not in the suppressed set
    expect(result.has('rel-dis-1')).toBe(false);
  });
});

// ─── computeTransitiveVoteStats ───────────────────────────────────────────

describe('computeTransitiveVoteStats', () => {
  it('counts direct stances', () => {
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'), makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-agree', 'bob'), makeRelationMsg('rel-agree', 'bob', 'agree'),
      makeNormalMsg('m-dis', 'charlie'), makeRelationMsg('rel-dis', 'charlie', 'disagree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-agree', 'agree', 'm-agree', 'rel-arr'),
      makeEdge('e3', 'rel-dis', 'disagree', 'm-dis', 'rel-arr'),
    ];
    const stats = computeTransitiveVoteStats(edges, msgs);
    expect(stats['rel-arr'].agreeCount).toBe(1);
    expect(stats['rel-arr'].disagreeCount).toBe(1);
  });

  it('projects agree-on-disagree as disagree on the original target', () => {
    // Bob disagrees with rel-arr. Charlie agrees with Bob's disagree.
    // Charlie's AGREE should count as DISAGREE on rel-arr.
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'), makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-bob-dis', 'bob'), makeRelationMsg('rel-bob-dis', 'bob', 'disagree'),
      makeNormalMsg('m-charlie-agree', 'charlie'), makeRelationMsg('rel-charlie-agree', 'charlie', 'agree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-bob-dis', 'disagree', 'm-bob-dis', 'rel-arr'),
      makeEdge('e3', 'rel-charlie-agree', 'agree', 'm-charlie-agree', 'rel-bob-dis'),
    ];
    const stats = computeTransitiveVoteStats(edges, msgs);
    // Direct: Bob disagrees with rel-arr → +1 disagree
    // Transitive: Charlie agrees with rel-bob-dis (which is disagree on rel-arr) → +1 disagree on rel-arr
    expect(stats['rel-arr'].disagreeCount).toBe(2);
    expect(stats['rel-arr'].agreeCount || 0).toBe(0);
  });

  it('projects disagree-on-disagree as agree on the original target', () => {
    // Bob disagrees with rel-arr. Charlie disagrees with Bob's disagree.
    // Charlie's DISAGREE should count as AGREE on rel-arr.
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'), makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-bob-dis', 'bob'), makeRelationMsg('rel-bob-dis', 'bob', 'disagree'),
      makeNormalMsg('m-charlie-dis', 'charlie'), makeRelationMsg('rel-charlie-dis', 'charlie', 'disagree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-bob-dis', 'disagree', 'm-bob-dis', 'rel-arr'),
      makeEdge('e3', 'rel-charlie-dis', 'disagree', 'm-charlie-dis', 'rel-bob-dis'),
    ];
    const stats = computeTransitiveVoteStats(edges, msgs);
    expect(stats['rel-arr'].disagreeCount).toBe(1);  // Bob's direct disagree
    expect(stats['rel-arr'].agreeCount).toBe(1);      // Charlie's disagree-on-disagree → agree
  });

  it('same user disagreeing with own disagree: both counts present', () => {
    // Bob disagrees with rel-arr, then disagrees with his own disagree.
    // Both stances should count: 1 disagree + 1 agree on rel-arr.
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'), makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-dis1', 'bob'), makeRelationMsg('rel-dis-1', 'bob', 'disagree'),
      makeNormalMsg('m-dis2', 'bob'), makeRelationMsg('rel-dis-2', 'bob', 'disagree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-dis-1', 'disagree', 'm-dis1', 'rel-arr'),
      makeEdge('e3', 'rel-dis-2', 'disagree', 'm-dis2', 'rel-dis-1'),
    ];
    const stats = computeTransitiveVoteStats(edges, msgs);
    expect(stats['rel-arr'].disagreeCount).toBe(1);
    expect(stats['rel-arr'].agreeCount).toBe(1);
  });

  it('same user pure-stance disagree-on-own-disagree: both counts present', () => {
    // Same as above, but using anon: sources (like the UI's quick disagree).
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'), makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeRelationMsg('rel-dis-1', 'bob', 'disagree'),
      makeRelationMsg('rel-dis-2', 'bob', 'disagree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      { id: 'e2', relationMessageId: 'rel-dis-1', relationType: 'disagree' as any, from: wholeSel('anon:rel-dis-1'), to: wholeSel('rel-arr'), relationLabel: 'disagree' },
      { id: 'e3', relationMessageId: 'rel-dis-2', relationType: 'disagree' as any, from: wholeSel('anon:rel-dis-2'), to: wholeSel('rel-dis-1'), relationLabel: 'disagree' },
    ];
    const stats = computeTransitiveVoteStats(edges, msgs);
    expect(stats['rel-arr'].disagreeCount).toBe(1);
    expect(stats['rel-arr'].agreeCount).toBe(1);
  });

  it('agree-on-agree stays agree', () => {
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'), makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-agree1', 'bob'), makeRelationMsg('rel-agree1', 'bob', 'agree'),
      makeNormalMsg('m-agree2', 'charlie'), makeRelationMsg('rel-agree2', 'charlie', 'agree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-agree1', 'agree', 'm-agree1', 'rel-arr'),
      makeEdge('e3', 'rel-agree2', 'agree', 'm-agree2', 'rel-agree1'),
    ];
    const stats = computeTransitiveVoteStats(edges, msgs);
    expect(stats['rel-arr'].agreeCount).toBe(2);
    expect(stats['rel-arr'].disagreeCount || 0).toBe(0);
  });

  it('disagree-on-agree counts as disagree on original', () => {
    // Bob agrees with rel-arr. Charlie disagrees with Bob's agree.
    // Charlie's DISAGREE should count as DISAGREE on rel-arr.
    const msgs: DemoMessage[] = [
      makeNormalMsg('m1', 'alice'), makeRelationMsg('rel-arr', 'alice', 'arrange'),
      makeNormalMsg('m-bob-agree', 'bob'), makeRelationMsg('rel-bob-agree', 'bob', 'agree'),
      makeNormalMsg('m-charlie-dis', 'charlie'), makeRelationMsg('rel-charlie-dis', 'charlie', 'disagree'),
    ];
    const edges: DemoEdge[] = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm2'),
      makeEdge('e2', 'rel-bob-agree', 'agree', 'm-bob-agree', 'rel-arr'),
      makeEdge('e3', 'rel-charlie-dis', 'disagree', 'm-charlie-dis', 'rel-bob-agree'),
    ];
    const stats = computeTransitiveVoteStats(edges, msgs);
    expect(stats['rel-arr'].agreeCount).toBe(1);   // Bob's direct agree
    expect(stats['rel-arr'].disagreeCount).toBe(1);  // Charlie's disagree-on-agree → disagree
  });

  it('handles empty edges', () => {
    const stats = computeTransitiveVoteStats([], []);
    expect(Object.keys(stats).length).toBe(0);
  });
});

describe('computeEffectiveSuppressedRelIds', () => {
  it('uses community majority as default but lets the current user override it', () => {
    const messages = [
      makeNormalMsg('m1', 'author'), makeRelationMsg('rel-arr', 'author', 'arrange'),
      makeRelationMsg('rel-alice-agree', 'alice', 'agree'),
      makeRelationMsg('rel-alice-dis', 'alice', 'disagree'),
      makeRelationMsg('rel-bob-dis', 'bob', 'disagree'),
    ];
    const edges = [
      makeEdge('e1', 'rel-arr', 'arrange', 'm1', 'm1'),
      makeEdge('e2', 'rel-alice-agree', 'agree', 'anon:agree', 'rel-arr'),
      makeEdge('e3', 'rel-alice-dis', 'disagree', 'anon:dis', 'rel-arr'),
      makeEdge('e4', 'rel-bob-dis', 'disagree', 'anon:bob', 'rel-arr'),
    ];

    expect(computeEffectiveSuppressedRelIds(edges, messages, null).has('rel-arr')).toBe(true);
    expect(computeEffectiveSuppressedRelIds(edges, messages, 'alice').has('rel-arr')).toBe(false);
    expect(computeEffectiveSuppressedRelIds(edges, messages, 'bob').has('rel-arr')).toBe(true);
  });
});
