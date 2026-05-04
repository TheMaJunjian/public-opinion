/**
 * graph.test.ts — Unit tests for graph utility functions.
 *
 * Tests: buildMessageTree, computeStanceStats, computeTextHops, buildFocusSubgraph
 */

import { describe, it, expect } from 'vitest';
import {
  buildMessageTree,
  computeStanceStats,
  computeTextHops,
  buildFocusSubgraph,
} from '../utils/graph';
import type { Message, Relation } from '../types';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeMsg(id: string, username = 'user'): Message {
  return {
    id,
    topicId: 'topic1',
    contentType: 'TEXT',
    content: `Content of message ${id}`,
    createdAt: new Date().toISOString(),
    createdBy: { id: `u-${username}`, username, createdAt: new Date().toISOString() },
  };
}

function makeRelation(
  id: string,
  relationType: string,
  sourceMessageId: string | null,
  targetRef: Relation['targetRefs'][number],
): Relation {
  return {
    id,
    topicId: 'topic1',
    relationType,
    sourceMessageId,
    targetRefs: [targetRef],
    createdAt: new Date().toISOString(),
    createdBy: { id: 'u-user', username: 'user', createdAt: new Date().toISOString() },
  };
}

// ─── buildMessageTree ────────────────────────────────────────────────────

describe('buildMessageTree', () => {
  it('returns all messages as roots when there are no relations', () => {
    const msgs = [makeMsg('a'), makeMsg('b'), makeMsg('c')];
    const tree = buildMessageTree(msgs, []);
    expect(tree).toHaveLength(3);
    expect(tree.every(n => n.children.length === 0)).toBe(true);
  });

  it('forms a parent-child link for a REPLY relation', () => {
    const msgs = [makeMsg('parent'), makeMsg('child')];
    const rels = [
      makeRelation('r1', 'REPLY', 'child', { kind: 'message', messageId: 'parent' }),
    ];
    const tree = buildMessageTree(msgs, rels);
    // Only root (parent) at top level
    expect(tree).toHaveLength(1);
    expect(tree[0].message.id).toBe('parent');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].message.id).toBe('child');
    expect(tree[0].children[0].relationType).toBe('REPLY');
  });

  it('does NOT form a tree link for ANNOTATION (formsTrees=false)', () => {
    const msgs = [makeMsg('m1'), makeMsg('m2')];
    const rels = [
      makeRelation('r1', 'ANNOTATION', 'm1', { kind: 'message', messageId: 'm2' }),
    ];
    const tree = buildMessageTree(msgs, rels);
    // Both are roots because ANNOTATION is not tree-forming
    expect(tree).toHaveLength(2);
  });

  it('does NOT form a tree link when target is a relation (not a text message)', () => {
    const msgs = [makeMsg('m1')];
    const rels = [
      makeRelation('r1', 'REPLY', 'm1', { kind: 'relation', relationId: 'r-other' }),
    ];
    const tree = buildMessageTree(msgs, rels);
    // m1 stays as root because its only target is a relation-kind ref
    expect(tree).toHaveLength(1);
    expect(tree[0].message.id).toBe('m1');
  });

  it('handles multi-level nesting', () => {
    const msgs = [makeMsg('root'), makeMsg('mid'), makeMsg('leaf')];
    const rels = [
      makeRelation('r1', 'REPLY', 'mid',  { kind: 'message', messageId: 'root' }),
      makeRelation('r2', 'REPLY', 'leaf', { kind: 'message', messageId: 'mid'  }),
    ];
    const tree = buildMessageTree(msgs, rels);
    expect(tree).toHaveLength(1);
    const mid = tree[0].children[0];
    expect(mid.message.id).toBe('mid');
    expect(mid.children[0].message.id).toBe('leaf');
  });
});

// ─── computeStanceStats ──────────────────────────────────────────────────

describe('computeStanceStats', () => {
  it('returns 0/0 when there are no relations', () => {
    const msgs = [makeMsg('m1')];
    const stats = computeStanceStats(msgs, []);
    expect(stats.get('m1')).toEqual({ support: 0, oppose: 0 });
  });

  it('counts AGREE as support', () => {
    const msgs = [makeMsg('m1'), makeMsg('m2')];
    const rels = [
      makeRelation('r1', 'AGREE', 'm2', { kind: 'message', messageId: 'm1' }),
    ];
    const stats = computeStanceStats(msgs, rels);
    expect(stats.get('m1')).toEqual({ support: 1, oppose: 0 });
    expect(stats.get('m2')).toEqual({ support: 0, oppose: 0 });
  });

  it('counts DISAGREE as oppose', () => {
    const msgs = [makeMsg('m1'), makeMsg('m2')];
    const rels = [
      makeRelation('r1', 'DISAGREE', 'm2', { kind: 'message', messageId: 'm1' }),
    ];
    const stats = computeStanceStats(msgs, rels);
    expect(stats.get('m1')).toEqual({ support: 0, oppose: 1 });
  });

  it('handles AGREE with null sourceMessageId (pure-stance)', () => {
    const msgs = [makeMsg('m1')];
    const rel: Relation = {
      id: 'r1', topicId: 'topic1', relationType: 'AGREE',
      sourceMessageId: null, targetRefs: [{ kind: 'message', messageId: 'm1' }],
      createdAt: new Date().toISOString(), createdBy: { id: 'u-user', username: 'user', createdAt: new Date().toISOString() },
    };
    const stats = computeStanceStats(msgs, [rel]);
    expect(stats.get('m1')).toEqual({ support: 1, oppose: 0 });
  });

  it('does NOT count stance when target is a relation-kind ref', () => {
    const msgs = [makeMsg('m1')];
    const rels = [
      makeRelation('r1', 'AGREE', 'm1', { kind: 'relation', relationId: 'r-other' }),
    ];
    const stats = computeStanceStats(msgs, rels);
    expect(stats.get('m1')).toEqual({ support: 0, oppose: 0 });
  });

  it('aggregates multiple votes', () => {
    const msgs = [makeMsg('m1'), makeMsg('m2'), makeMsg('m3')];
    const rels = [
      makeRelation('r1', 'AGREE',    'm2', { kind: 'message', messageId: 'm1' }),
      makeRelation('r2', 'AGREE',    'm3', { kind: 'message', messageId: 'm1' }),
      makeRelation('r3', 'DISAGREE', 'm2', { kind: 'message', messageId: 'm1' }),
    ];
    const stats = computeStanceStats(msgs, rels);
    expect(stats.get('m1')).toEqual({ support: 2, oppose: 1 });
  });
});

// ─── computeTextHops ──────────────────────────────────────────────────────

describe('computeTextHops', () => {
  it('returns only the start set when maxHops=0', () => {
    const msgs = [makeMsg('a'), makeMsg('b')];
    const rels = [makeRelation('r1', 'REPLY', 'b', { kind: 'message', messageId: 'a' })];
    const result = computeTextHops(msgs, rels, new Set(['a']), 0);
    expect(result).toEqual(new Set(['a']));
  });

  it('reaches directly connected message in 1 hop', () => {
    const msgs = [makeMsg('a'), makeMsg('b')];
    const rels = [makeRelation('r1', 'REPLY', 'b', { kind: 'message', messageId: 'a' })];
    const result = computeTextHops(msgs, rels, new Set(['a']), 1);
    expect(result.has('b')).toBe(true);
  });

  it('does NOT cross beyond maxHops', () => {
    const msgs = [makeMsg('a'), makeMsg('b'), makeMsg('c')];
    const rels = [
      makeRelation('r1', 'REPLY', 'b', { kind: 'message', messageId: 'a' }),
      makeRelation('r2', 'REPLY', 'c', { kind: 'message', messageId: 'b' }),
    ];
    const result = computeTextHops(msgs, rels, new Set(['a']), 1);
    expect(result.has('b')).toBe(true);
    expect(result.has('c')).toBe(false);
  });

  it('traverses bidirectionally (source and target are both neighbors)', () => {
    const msgs = [makeMsg('a'), makeMsg('b')];
    const rels = [makeRelation('r1', 'REPLY', 'a', { kind: 'message', messageId: 'b' })];
    // Start from 'b', but edge is a→b direction; bidirectional BFS should still reach 'a'
    const result = computeTextHops(msgs, rels, new Set(['b']), 1);
    expect(result.has('a')).toBe(true);
  });

  it('ignores relation-to-relation targets for hop counting', () => {
    const msgs = [makeMsg('a'), makeMsg('b')];
    const rels = [
      // This relation targets another relation, not a text message
      makeRelation('r1', 'ANNOTATION', 'a', { kind: 'relation', relationId: 'r-other' }),
    ];
    const result = computeTextHops(msgs, rels, new Set(['a']), 1);
    // 'b' is not reachable because no text-message edge connects them
    expect(result.has('b')).toBe(false);
  });
});

// ─── buildFocusSubgraph ───────────────────────────────────────────────────

describe('buildFocusSubgraph', () => {
  it('includes the focus message itself', () => {
    const msgs = [makeMsg('focus')];
    const { visibleMessages } = buildFocusSubgraph(msgs, [], new Set(['focus']), 2);
    expect(visibleMessages.has('focus')).toBe(true);
  });

  it('includes only relations whose source AND all message-targets are visible', () => {
    const msgs = [makeMsg('a'), makeMsg('b'), makeMsg('c')];
    const rels = [
      // r1: a→b (visible in hop 1 from a)
      makeRelation('r1', 'REPLY', 'b', { kind: 'message', messageId: 'a' }),
      // r2: c→? (c is not reachable from a in 1 hop)
      makeRelation('r2', 'REPLY', 'c', { kind: 'message', messageId: 'a' }),
    ];
    const { visibleMessages, visibleRelations } = buildFocusSubgraph(
      msgs, rels, new Set(['a']), 1,
    );
    expect(visibleMessages.has('a')).toBe(true);
    expect(visibleMessages.has('b')).toBe(true);
    expect(visibleMessages.has('c')).toBe(true); // c is also 1 hop from a via r2
    expect(visibleRelations.has('r1')).toBe(true);
    expect(visibleRelations.has('r2')).toBe(true);
  });

  it('hides a relation when its source is outside the hop window', () => {
    const msgs = [makeMsg('a'), makeMsg('b'), makeMsg('c')];
    const rels = [
      makeRelation('r1', 'REPLY', 'b', { kind: 'message', messageId: 'a' }),
      // r2 source=c is 2 hops away; with maxHops=1 from 'a', c is not included
      makeRelation('r2', 'REPLY', 'c', { kind: 'message', messageId: 'b' }),
    ];
    const { visibleRelations } = buildFocusSubgraph(msgs, rels, new Set(['a']), 1);
    expect(visibleRelations.has('r1')).toBe(true);
    expect(visibleRelations.has('r2')).toBe(false);
  });

  it('recursively includes relation-targeting relations when base is visible', () => {
    const msgs = [makeMsg('a'), makeMsg('b')];
    const r1 = makeRelation('r1', 'REPLY', 'b', { kind: 'message', messageId: 'a' });
    // r2 targets the relation r1 itself
    const r2 = makeRelation('r2', 'ANNOTATION', 'a', { kind: 'relation', relationId: 'r1' });
    const rels = [r1, r2];
    const { visibleRelations } = buildFocusSubgraph(msgs, rels, new Set(['a']), 1);
    expect(visibleRelations.has('r1')).toBe(true);
    expect(visibleRelations.has('r2')).toBe(true);
  });
});
