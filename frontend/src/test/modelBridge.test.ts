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

describe('convertMessagesToDemoModel', () => {
  it('preserves delegation content from the relation payload', () => {
    const content = '报酬数量=100\n委托内容=请完成这项工作';
    const result = convertMessagesToDemoModel([] as Message[], [makeDelegation('CREATE', content)]);

    expect(result.messages[0]?.content).toBe(content);
  });
});