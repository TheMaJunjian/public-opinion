import { describe, expect, it } from 'vitest';
import type { Relation } from '../types';
import { buildHomeFilterDisplayIds, deriveHomeContentMatchSetsBySender, filterUnreadRelatedTraceMatchIds, getContainerAncestorChain, getLatestUserReadStatusByMessageId, partitionHomeContentMatchIds, partitionHomeFilterMatchIds } from '../pages/topicDetailHelpers';
import { buildTraceProjection } from '../utils/traceProjection';

const user = { id: 'user-1', username: 'alice', createdAt: '2026-01-01T00:00:00.000Z' };
const otherUser = { id: 'user-2', username: 'bob', createdAt: '2026-01-01T00:00:00.000Z' };

function relation(
  relationType: 'READ' | 'UNREAD',
  createdAt: string,
  createdBy: typeof user,
  messageId: string,
): Relation {
  return {
    id: `${relationType}-${createdAt}`,
    topicId: 'topic-1',
    relationType,
    sourceMessageId: null,
    targetRefs: [{ kind: 'message', messageId }],
    createdAt,
    createdBy,
  };
}

describe('getLatestUserReadStatusByMessageId', () => {
  it('uses the latest status when READ and UNREAD history overlap', () => {
    const statuses = getLatestUserReadStatusByMessageId([
      relation('UNREAD', '2026-01-02T00:00:00.000Z', user, 'message-1'),
      relation('READ', '2026-01-01T00:00:00.000Z', user, 'message-1'),
    ], currentRelation => currentRelation.createdBy.id === user.id);

    expect(statuses.get('message-1')).toBe('UNREAD');
  });

  it('ignores another user\'s status relation', () => {
    const statuses = getLatestUserReadStatusByMessageId([
      relation('READ', '2026-01-02T00:00:00.000Z', otherUser, 'message-1'),
    ], currentRelation => currentRelation.createdBy.id === user.id);

    expect(statuses).toEqual(new Map());
  });
});

describe('getContainerAncestorChain', () => {
  it('falls back to legacy container targetRefs when no JOIN relation exists', () => {
    const chain = getContainerAncestorChain('inner-classify', [
      {
        id: 'outer-classify',
        topicId: 'topic-1',
        relationType: 'CLASSIFY',
        sourceMessageId: null,
        targetRefs: [{ kind: 'relation', relationId: 'inner-classify' }],
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: user,
      },
    ]);

    expect(chain).toEqual(['outer-classify']);
  });
});

describe('partitionHomeFilterMatchIds', () => {
  it('assigns content by relation sender instead of undirected trace distance', () => {
    const messages = [
      { id: 'b', kind: 'normal', author: 'user-1' },
      { id: 'c', kind: 'normal', author: 'user-2' },
      { id: 'f', kind: 'normal', author: 'user-5' },
      { id: 'd', kind: 'relation', relationType: 'reference', author: 'user-3' },
      { id: 'e', kind: 'relation', relationType: 'reference', author: 'user-4' },
    ] as any;
    const edges = [
      { relationMessageId: 'd', relationType: 'reference', from: { messageId: 'b' }, to: { messageId: 'c' } },
      { relationMessageId: 'e', relationType: 'reference', from: { messageId: 'c' }, to: { messageId: 'f' } },
    ] as any;
    const contentIds = new Set(['b', 'c', 'f']);

    expect(deriveHomeContentMatchSetsBySender({ messages, edges, contentIds, currentUsername: 'user-1' })).toEqual({
      selfContentIds: new Set(['b']),
      readRelatedContentIds: new Set(),
      unreadRelatedContentIds: new Set(['c']),
    });
    expect(deriveHomeContentMatchSetsBySender({ messages, edges, contentIds, currentUsername: 'user-2' })).toEqual({
      selfContentIds: new Set(['c']),
      readRelatedContentIds: new Set(),
      unreadRelatedContentIds: new Set(['b', 'f']),
    });
    const user2Matches = partitionHomeContentMatchIds({
      contentIds,
      selfContentIds: new Set(['c']),
      unreadRelatedContentIds: new Set(['b', 'f']),
      readRelatedContentIds: new Set(),
      readContentIds: new Set(),
      unreadContentIds: new Set(),
    });
    expect(user2Matches.unreadRelatedMatchIds).toEqual(new Set(['b', 'f']));
    expect(buildHomeFilterDisplayIds(user2Matches.unreadRelatedMatchIds, edges, {
      includeRelationContext: true,
    })).toEqual(new Set(['b', 'c', 'd', 'e', 'f']));
    expect(deriveHomeContentMatchSetsBySender({ messages, edges, contentIds, currentUsername: 'user-4' })).toEqual({
      selfContentIds: new Set(),
      readRelatedContentIds: new Set(['c', 'f']),
      unreadRelatedContentIds: new Set(),
    });
  });

  it('partitions only content messages into mutually exclusive modes', () => {
    const result = partitionHomeContentMatchIds({
      contentIds: new Set(['b', 'c', 'other']),
      selfContentIds: new Set(['b']),
      unreadRelatedContentIds: new Set(['b', 'c']),
      readRelatedContentIds: new Set(['b', 'c']),
      readContentIds: new Set(),
      unreadContentIds: new Set(['c']),
    });

    expect(result.readSelfMatchIds).toEqual(new Set(['b']));
    expect(result.unreadRelatedMatchIds).toEqual(new Set(['c']));
    expect(result.readRelatedMatchIds).toEqual(new Set());
    expect(result.unreadOtherMatchIds).toEqual(new Set(['other']));

    const matchSets = [
      result.readSelfMatchIds,
      result.unreadRelatedMatchIds,
      result.readRelatedMatchIds,
      result.unreadOtherMatchIds,
    ];
    expect(new Set(matchSets.flatMap(ids => [...ids]))).toEqual(new Set(['b', 'c', 'other']));
  });

  it('uses a non-self, read distance-one target for read-related', () => {
    const result = partitionHomeContentMatchIds({
      contentIds: new Set(['b', 'c']),
      selfContentIds: new Set(),
      unreadRelatedContentIds: new Set(),
      readRelatedContentIds: new Set(['b', 'c']),
      readContentIds: new Set(),
      unreadContentIds: new Set(['c']),
    });

    expect(result.readRelatedMatchIds).toEqual(new Set(['b']));
    expect(result.unreadOtherMatchIds).toEqual(new Set(['c']));
  });

  it('honors explicit read status before sender-based grouping', () => {
    const result = partitionHomeContentMatchIds({
      contentIds: new Set(['self-unread', 'related-read']),
      selfContentIds: new Set(['self-unread']),
      unreadRelatedContentIds: new Set(['related-read']),
      readRelatedContentIds: new Set(),
      readContentIds: new Set(['related-read']),
      unreadContentIds: new Set(['self-unread']),
    });

    expect(result.readSelfMatchIds).toEqual(new Set());
    expect(result.readRelatedMatchIds).toEqual(new Set(['related-read']));
    expect(result.unreadRelatedMatchIds).toEqual(new Set());
    expect(result.unreadOtherMatchIds).toEqual(new Set(['self-unread']));
  });

  it('classifies a relation target as unread-related when it is reached from self content', () => {
    const messages = [
      { id: 'b', kind: 'normal', author: 'user-1', content: 'B', createdAt: '' },
      { id: 'c', kind: 'normal', author: 'user-2', content: 'C', createdAt: '' },
      { id: 'd', kind: 'relation', relationType: 'reference', author: 'user-3', content: '', createdAt: '' },
    ] as any;
    const edges = [
      { id: 'd-b', relationMessageId: 'd', relationType: 'reference', from: { messageId: 'b', selection: { kind: 'whole' } }, to: { messageId: 'c', selection: { kind: 'whole' } } },
    ] as any;
    const traceIds = buildTraceProjection({ messages, edges, startIds: ['b'], distance: 1 }).distanceMessageIds!;
    const result = partitionHomeContentMatchIds({
      contentIds: new Set(['b', 'c']),
      selfContentIds: new Set(['b']),
      unreadRelatedContentIds: traceIds,
      readRelatedContentIds: new Set(),
      readContentIds: new Set(),
      unreadContentIds: new Set(),
    });

    expect(traceIds).toEqual(new Set(['b', 'c']));
    expect(result.unreadRelatedMatchIds).toEqual(new Set(['c']));
  });

  it('keeps every message in exactly one home mode with unread-related priority', () => {
    const result = partitionHomeFilterMatchIds({
      allMessageIds: new Set(['self', 'self-relation', 'external-relation', 'read', 'unread', 'other']),
      selfCardMessageIds: new Set(['self']),
      selfRelatedMessageIds: new Set(['self-relation']),
      readRelatedIds: new Set(['self']),
      readMarkedTargets: new Set(['self', 'read']),
      unreadMarkedTargets: new Set(['unread']),
      unreadRelatedIds: new Set(['external-relation', 'unread']),
      statusAnnotationIds: new Set(),
    });

    expect(result.unreadRelatedMatchIds).toEqual(new Set(['external-relation', 'unread']));
    expect(result.readRelatedMatchIds).toEqual(new Set(['self-relation', 'read']));
    expect(result.readSelfMatchIds).toEqual(new Set(['self']));
    expect(result.unreadOtherMatchIds).toEqual(new Set(['other']));
  });

  it('does not add ordinary relation endpoints to another mode as context', () => {
    const edges = [
      { relationMessageId: 'reference-1', relationType: 'reference', from: { messageId: 'source' }, to: { messageId: 'hit' } } as any,
      { relationMessageId: 'classify-2', relationType: 'classify', from: { messageId: 'anon:classify-2' }, to: { messageId: 'other' } } as any,
    ];

    expect(buildHomeFilterDisplayIds(new Set(['hit']), edges)).toEqual(new Set(['hit']));
  });

  it('adds container cards required by hits in every mode', () => {
    const edges = [
      { relationMessageId: 'classify-1', relationType: 'classify', from: { messageId: 'anon:classify-1' }, to: { messageId: 'hit' } } as any,
      { relationMessageId: 'summary-1', relationType: 'summary', from: { messageId: 'anon:summary-1' }, to: { messageId: 'hit' } } as any,
      { relationMessageId: 'merge-1', relationType: 'merge', from: { messageId: 'anon:merge-1' }, to: { messageId: 'hit' } } as any,
      { relationMessageId: 'arrange-1', relationType: 'arrange', from: { messageId: 'anon:arrange-1' }, to: { messageId: 'hit' } } as any,
    ];

    expect(buildHomeFilterDisplayIds(new Set(['hit']), edges)).toEqual(
      new Set(['hit', 'classify-1', 'summary-1', 'merge-1', 'arrange-1']),
    );
  });

  it('does not show a relation target in read-self when the source is the hit', () => {
    const edges = [
      { relationMessageId: 'external-relation', relationType: 'reference', from: { messageId: 'self-source' }, to: { messageId: 'hit' } } as any,
    ];

    expect(buildHomeFilterDisplayIds(new Set(['hit']), edges)).toEqual(
      new Set(['hit']),
    );
  });

  it('shows the relation and self source as context for an unread-related hit', () => {
    const edges = [
      { relationMessageId: 'd', relationType: 'reference', from: { messageId: 'b' }, to: { messageId: 'c' } } as any,
    ];

    expect(buildHomeFilterDisplayIds(new Set(['c']), edges, { includeRelationContext: true })).toEqual(
      new Set(['b', 'c', 'd']),
    );
  });

  it('does not show read-status relations as relation context', () => {
    const edges = [
      { relationMessageId: 'read-1', relationType: 'read', from: { messageId: 'anon:read-1' }, to: { messageId: 'hit' } } as any,
      { relationMessageId: 'unread-1', relationType: 'unread', from: { messageId: 'anon:unread-1' }, to: { messageId: 'hit' } } as any,
    ];

    expect(buildHomeFilterDisplayIds(new Set(['hit']), edges, { includeRelationContext: true })).toEqual(
      new Set(['hit']),
    );
  });

  it('shows the relation and source when an unread-other target is the hit', () => {
    const edges = [
      { relationMessageId: 'e', relationType: 'reference', from: { messageId: 'c' }, to: { messageId: 'f' } } as any,
    ];

    expect(buildHomeFilterDisplayIds(new Set(['f']), edges, { includeRelationContext: true })).toEqual(
      new Set(['c', 'e', 'f']),
    );
  });

  it('does not show a read-related content endpoint in unread-related context', () => {
    const edges = [
      { relationMessageId: 'e', relationType: 'reference', from: { messageId: 'c' }, to: { messageId: 'f' } } as any,
    ];

    expect(buildHomeFilterDisplayIds(new Set(['f']), edges, {
      includeRelationContext: true,
      excludedContentContextIds: new Set(['c']),
    })).toEqual(
      new Set(['e', 'f']),
    );
  });

  it('recursively adds nested containers without ordinary relation context', () => {
    const edges = [
      { relationMessageId: 'outer-classify', relationType: 'classify', from: { messageId: 'anon:outer' }, to: { messageId: 'inner-arrange' } } as any,
      { relationMessageId: 'inner-arrange', relationType: 'arrange', from: { messageId: 'anon:inner' }, to: { messageId: 'hit' } } as any,
      { relationMessageId: 'external-relation', relationType: 'reference', from: { messageId: 'dependency-source' }, to: { messageId: 'hit' } } as any,
    ];

    expect(buildHomeFilterDisplayIds(new Set(['hit']), edges)).toEqual(new Set([
      'hit',
      'inner-arrange',
      'outer-classify',
    ]));
  });

  it('recursively adds containers joined around a matched message', () => {
    expect(buildHomeFilterDisplayIds(new Set(['hit']), [], {
      containerMemberships: [
        { containerId: 'inner-arrange', targetIds: ['hit'] },
        { containerId: 'outer-classify', targetIds: ['inner-arrange'] },
      ],
    })).toEqual(new Set(['hit', 'inner-arrange', 'outer-classify']));
  });

  it('keeps only non-self unread messages from trace distance one', () => {
    const result = filterUnreadRelatedTraceMatchIds({
      traceDistanceMessageIds: new Set(['self', 'unread-near', 'read-near', 'status', 'self-near']),
      selfMessageIds: new Set(['self', 'self-near']),
      readMarkedTargets: new Set(['read-near']),
      statusAnnotationIds: new Set(['status']),
    });

    expect(result).toEqual(new Set(['unread-near']));
  });

  it('uses trace distance one instead of every message connected through the graph', () => {
    const messages = [
      { id: 'self', kind: 'normal', author: 'alice', content: 'self', createdAt: '' },
      { id: 'relation-near', kind: 'relation', relationType: 'reference', author: 'bob', content: '', createdAt: '' },
      { id: 'near', kind: 'normal', author: 'bob', content: 'near', createdAt: '' },
      { id: 'relation-far', kind: 'relation', relationType: 'reference', author: 'bob', content: '', createdAt: '' },
      { id: 'far', kind: 'normal', author: 'bob', content: 'far', createdAt: '' },
    ] as any;
    const edges = [
      { id: 'edge-near', relationMessageId: 'relation-near', relationType: 'reference', from: { messageId: 'self', selection: { kind: 'whole' } }, to: { messageId: 'near', selection: { kind: 'whole' } } },
      { id: 'edge-far', relationMessageId: 'relation-far', relationType: 'reference', from: { messageId: 'near', selection: { kind: 'whole' } }, to: { messageId: 'far', selection: { kind: 'whole' } } },
    ] as any;
    const traceIds = buildTraceProjection({ messages, edges, startIds: ['self'], distance: 1 }).distanceMessageIds!;

    expect(filterUnreadRelatedTraceMatchIds({
      traceDistanceMessageIds: traceIds,
      selfMessageIds: new Set(['self']),
      readMarkedTargets: new Set(),
      statusAnnotationIds: new Set(),
    })).toEqual(new Set(['near']));
  });
});