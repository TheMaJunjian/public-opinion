import { expect, it } from 'vitest';
import type { Relation } from '../types';
import { collectAllContainerOwnership } from '../pages/workbench/model/ownership';

function container(id: string, relationType: string, targets: string[]): Relation {
  return { id, relationType, sourceMessageId: null, targetRefs: targets.map(messageId => ({ kind: 'message' as const, messageId })),
    createdAt: '', createdBy: { id: 'fixture', username: '技术测试账号', createdAt: '' } };
}

it('collects all preview container types while retaining rejected declarations and nested ownership', () => {
  const relations = [container('root', 'CLASSIFY', ['child']), container('child', 'CLASSIFY', ['one']),
    container('summary', 'SUMMARY', ['two']), container('merge', 'MERGE', ['three'])];
  relations[1].state = { messageId: 'child', revision: 1, supportCount: 0, oppositionCount: 1, recommendationTotal: 0, suppressed: true };
  const result = collectAllContainerOwnership(relations);
  expect(result.classify.textIds).toEqual(new Set(['one']));
  expect(result.classify.relationIds).toEqual(new Set(['child']));
  expect(result.summary.textIds).toEqual(new Set(['two']));
  expect(result.merge.textIds).toEqual(new Set(['three']));
});

it('reads container declarations linearly across many independent classifications', () => {
  const count = 400;
  let reads = 0;
  const relations = Array.from({ length: count }, (_, index) => {
    const relation = container(`category:${index}`, 'CLASSIFY', [`message:${index}`]);
    const refs = relation.targetRefs;
    Object.defineProperty(relation, 'targetRefs', { get() { reads++; return refs; } });
    return relation;
  });
  const result = collectAllContainerOwnership(relations);
  expect(result.classify.textIds.size).toBe(count);
  expect(reads).toBeLessThan(count * 12);
});
