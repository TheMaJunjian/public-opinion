import { describe, expect, it } from 'vitest';
import { convertMessagesToDemoModel } from '../utils/modelBridge';
import type { Message, Relation, User } from '../types';

const user: User = { id: 'user-1', username: 'tester', createdAt: '2024-01-01T00:00:00.000Z' };

function makeDelegation(kind: 'CREATE' | 'FULFILL', content: string): Relation {
  return {
    id: `delegation-${kind.toLowerCase()}`,
    topicId: 'topic-1',
    relationType: 'DELEGATION',
    sourceMessageId: null,
    targetRefs: [],
    payload: { content, delegationKind: kind, rewardAmount: 100 },
    createdAt: '2024-01-01T00:01:00.000Z',
    createdBy: user,
  };
}

function makeSummary(): Relation {
  return {
    id: 'summary-1',
    topicId: 'topic-1',
    relationType: 'SUMMARY',
    sourceMessageId: null,
    targetRefs: [{ kind: 'message', messageId: 'text-1' }],
    payload: { title: '阶段总结' },
    createdAt: '2024-01-01T00:02:00.000Z',
    createdBy: user,
  };
}

describe('convertMessagesToDemoModel', () => {
  it('preserves delegation content from the relation payload', () => {
    const content = '报酬数量=100\n委托内容=请完成这项工作';
    const result = convertMessagesToDemoModel([] as Message[], [makeDelegation('CREATE', content)]);

    expect(result.messages[0]?.content).toBe(content);
  });

  it('keeps SUMMARY title when rebuilding messages from refreshed relations', () => {
    const result = convertMessagesToDemoModel([] as Message[], [makeSummary()]);

    expect(result.messages[0]?.content).toBe('总结：阶段总结');
  });

  it('uses one content card for a governance message and its compatibility relation', () => {
    const message: Message = {
      id: 'proposal-1',
      topicId: 'topic-1',
      kind: 'GOVERNANCE',
      contentType: 'TEXT',
      content: '请表决这个提案',
      createdAt: '2024-01-01T00:01:00.000Z',
      createdBy: user,
      relationType: 'PROPOSAL',
      targetRefs: [{ kind: 'message', messageId: 'text-1' }],
      relationPayload: { content: '请表决这个提案', operationType: 'DISTRIBUTE_REVENUE' },
    };
    const compatibilityRelation: Relation = {
      id: message.id,
      topicId: message.topicId,
      relationType: 'PROPOSAL',
      sourceMessageId: null,
      targetRefs: message.targetRefs ?? [],
      payload: message.relationPayload ?? undefined,
      createdAt: message.createdAt,
      createdBy: user,
    };

    const result = convertMessagesToDemoModel([message], [compatibilityRelation]);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: 'proposal-1',
      kind: 'governance',
      relationType: 'proposal',
      relationPayload: message.relationPayload,
      targetRefs: message.targetRefs,
    });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.relationMessageId).toBe('proposal-1');
  });
});