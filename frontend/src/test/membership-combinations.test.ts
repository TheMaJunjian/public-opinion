import { expect, it } from 'vitest';
import type { MembershipAction } from '@gonglun/core';
import type { Message, Relation } from '../types';
import { convertMessagesToDemoModel } from '../utils/modelBridge';
import { projectGraphScene } from '../utils/graphProjection';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';
import { getActiveJoinRelationsForMessage, resolveMessageCanvas } from '../pages/workbench/model/membership';
import { projectContainerCanvas } from '../pages/workbench/projections/containerCanvas';

const user = { id: 'tester', username: 'tester', createdAt: '' };
const member: Message = { id: 'member', kind: 'TEXT', content: '成员', contentType: 'TEXT', createdAt: '', createdBy: user };
const histories = [
  { name: 'A → B → C', parents: ['A', 'B', 'C'], predecessors: [null, 0, 1], fallback: [2, 1, 0] },
  { name: 'A rejected before B', parents: ['A', 'B', 'C'], predecessors: [null, null, 1], fallback: [2, 1] },
  { name: 'B rejected before C', parents: ['A', 'B', 'C'], predecessors: [null, 0, 0], fallback: [2, 0] },
  { name: 'A and B rejected before C', parents: ['A', 'B', 'C'], predecessors: [null, 0, null], fallback: [2] },
  { name: 'A → B → A → C', parents: ['A', 'B', 'A', 'C'], predecessors: [null, 0, 1, 2], fallback: [3, 2, 1, 0] },
] as const;

const cases = ['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'].flatMap(type => histories.map(history => ({ type, ...history })));

it.each(cases)('$type: $name keeps position, records, graph and list consistent for every rejection/recovery combination', ({ type, parents, predecessors, fallback }) => {
  const actions: MembershipAction[] = parents.map((parentId, order) => {
    const previous = predecessors[order];
    return { id: `join-${order}`, memberId: member.id, parentId, order,
      previousId: previous === null ? null : `join-${previous}`,
      previousParentId: previous === null ? null : parents[previous] };
  });
  const base: Relation[] = [
    ...['A', 'B', 'C'].map(id => ({ id, relationType: type, sourceMessageId: null,
      targetRefs: [{ kind: 'message' as const, messageId: member.id }], payload: { independentMemberships: true }, createdAt: '', createdBy: user })),
    ...actions.map(action => ({ id: action.id, relationType: 'JOIN', sourceMessageId: action.parentId,
      targetRefs: [{ kind: 'message' as const, messageId: member.id }], payload: { membershipHistory: action }, createdAt: '', createdBy: user })),
  ];
  const targets = base.map(relation => relation.id);
  // Exhaust the three container states and each JOIN state. The expected path is
  // explicitly listed above, so restoring a skipped record cannot alter history.
  for (let mask = 0; mask < 2 ** targets.length; mask++) {
    const rejected = new Set(targets.filter((_, index) => mask & 2 ** index));
    const expected = fallback.map(index => actions[index]).find(action => !rejected.has(action.id) && !rejected.has(action.parentId));
    const label = `${type}, ${parents.join(' → ')}, rejected: ${[...rejected].join(', ')}`;
    const relations = base.map(relation => ({ ...relation, state: {
      messageId: relation.id, revision: 1, suppressed: rejected.has(relation.id),
      supportCount: 0, oppositionCount: Number(rejected.has(relation.id)), recommendationTotal: 0,
    } }));
    const model = convertMessagesToDemoModel([member], relations);
    const effect = deriveContainerEffect({ ...model, relations, username: user.username });
    expect(effect.effectiveJoinIds, label).toEqual(new Set(expected ? [expected.id] : []));
    expect(resolveMessageCanvas(member.id, relations, effect.rejectedContainerIds, effect.rejectedJoinRelationIds), label).toBe(expected?.parentId ?? null);
    expect(getActiveJoinRelationsForMessage(member.id, relations, effect.rejectedContainerIds, effect.rejectedJoinRelationIds).map(join => join.id), label).toEqual(expected ? [expected.id] : []);
    for (const action of actions) {
      expect(effect.context.joinStatusByMessage.get(action.id) === 'valid', label).toBe(action.id === expected?.id);
      if (rejected.has(action.id)) expect(effect.context.joinStatusByMessage.get(action.id), label).toBe('rejected');
      else if (rejected.has(action.parentId)) expect(effect.context.joinStatusByMessage.get(action.id), label).toBe('container-rejected');
    }
    const memberEdges = effect.edges.filter(edge => ['A', 'B', 'C'].includes(edge.relationMessageId) && edge.to.messageId === member.id);
    expect(memberEdges.map(edge => edge.relationMessageId), label).toEqual(expected ? [expected.parentId] : []);
    for (const id of ['A', 'B', 'C']) {
      expect(effect.ownership.direct(id).textIds.has(member.id), label).toBe(id === expected?.parentId);
      const inside = projectContainerCanvas(effect, { kind: 'inside', id });
      expect(inside.messages.filter(message => message.id === member.id).length, label).toBe(Number(id === expected?.parentId));
    }
    const root = projectContainerCanvas(effect, { kind: 'root' });
    const visibleAtRoot = !expected || type === 'MERGE' || type === 'ARRANGE';
    expect(root.messages.filter(message => message.id === member.id).length, label).toBe(Number(visibleAtRoot));
    const graph = projectGraphScene({ ...root, rejectedContainerIds: effect.rejectedContainerIds, isTraceWindow: false, traceExpandedFrameIds: new Set() });
    expect(graph.normalIds.filter(id => id === member.id).length, label).toBe(Number(visibleAtRoot));
    expect(graph.frameBlocks.filter(frame => frame.directCardIds.has(member.id)).map(frame => frame.relMsgId), label)
      .toEqual(expected && ['MERGE', 'ARRANGE'].includes(type) ? [expected.parentId] : []);
  }
});
