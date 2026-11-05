import { describe, expect, it } from 'vitest';
import type { Relation, TargetRef } from '../types';
import { getJoinRelationsForMessage, indexJoinRelationsByTarget } from '../pages/workbench/model/membership';

const target = (messageId: string): TargetRef => ({ kind: 'message', messageId });
const record = (id: string, targetRefs: TargetRef[], changes: Partial<Relation> = {}): Relation => ({
  id, relationType: 'JOIN', sourceMessageId: 'structural-container', targetRefs, createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: { id: 'structural-author', username: '结构测试', createdAt: '' }, ...changes,
});

describe('JOIN records indexed by target', () => {
  it('matches direct lookup for message, fragment and relation targets without duplicating repeated targets', () => {
    const relations = [
      record('join-old', [target('message'), { kind: 'text-fragment', messageId: 'message', text: '', hash: 'structure' },
        { kind: 'relation', relationId: 'message' }, { kind: 'relation', relationId: 'container' }]),
      record('join-new', [target('message'), target('other')], { relationType: 'join', createdAt: '2026-01-02T00:00:00.000Z' }),
      record('source-missing', [target('message')], { sourceMessageId: null }),
      record('source-empty', [target('message')], { sourceMessageId: '' }),
      record('not-join', [target('message')], { relationType: 'CLASSIFY' }),
      record('retired', [target('message')], { state: { messageId: 'retired', revision: 1, suppressed: false,
        supportCount: 0, oppositionCount: 0, recommendationTotal: 0, membershipDisabled: true } }),
    ];
    const index = indexJoinRelationsByTarget(relations);
    expect([...index.keys()]).toEqual(['message', 'container', 'other']);
    for (const id of ['message', 'container', 'other', 'absent']) expect(index.get(id) ?? []).toEqual(getJoinRelationsForMessage(id, relations));
    expect(index.get('message')?.map(value => value.id)).toEqual(['join-new', 'join-old', 'retired']);
    expect(index.get('container')).toEqual([relations[0]]);
  });

  it('sorts descending while preserving input order for equal times and matching legacy invalid-date behavior', () => {
    const equalA = record('same-id', [target('target')]);
    const equalB = record('same-id', [target('target')]);
    const relations = [equalA, record('older', [target('target')], { createdAt: '2025-01-01T00:00:00.000Z' }), equalB,
      record('newer', [target('target')], { createdAt: '2026-02-01T00:00:00.000Z' })];
    const originalOrder = [...relations];
    const indexed = indexJoinRelationsByTarget(relations).get('target')!;
    expect(indexed).toEqual(getJoinRelationsForMessage('target', relations));
    expect(indexed[1]).toBe(equalA); expect(indexed[2]).toBe(equalB);
    expect(relations).toEqual(originalOrder);
    for (const value of indexed) expect(relations).toContain(value);
    const legacy = [...relations, record('legacy-invalid', [target('target')], { createdAt: '' })];
    expect(indexJoinRelationsByTarget(legacy).get('target')).toEqual(getJoinRelationsForMessage('target', legacy));
  });

  it('reads relation and target fields linearly before sorting, including one very large JOIN', () => {
    const count = 1500;
    let typeReads = 0, listReads = 0, targetReads = 0;
    const measuredTarget = (id: string): TargetRef => {
      const value = target(id);
      Object.defineProperty(value, 'messageId', { get: () => { targetReads++; return id; } });
      return value;
    };
    const relations = Array.from({ length: count }, (_, index) => {
      const value = record(`join-${index}`, []), refs = [measuredTarget(`member-${index}`), measuredTarget('shared'), measuredTarget('shared')];
      Object.defineProperties(value, {
        relationType: { get: () => { typeReads++; return 'JOIN'; } },
        targetRefs: { get: () => { listReads++; return refs; } },
      });
      return value;
    });
    const giant = record('large-join', Array.from({ length: count }, (_, index) => measuredTarget(`member-${index}`)));
    const index = indexJoinRelationsByTarget([...relations, giant]);
    expect(typeReads).toBe(count); expect(listReads).toBe(count); expect(targetReads).toBe(count * 4);
    expect(index.size).toBe(count + 1); expect(index.get('shared')?.length).toBe(count);
    for (let member = 0; member < count; member++) expect(index.get(`member-${member}`)).toEqual([relations[member], giant]);
  });
});
