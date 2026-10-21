import { expect, it } from 'vitest';
import type { Message, Relation } from '../types';
import { convertMessagesToDemoModel } from '../utils/modelBridge';
import { deriveContainerEffect } from '../pages/workbench/model/containerEffect';
import { projectContainerCanvas } from '../pages/workbench/projections/containerCanvas';
import type { JoinStakeCounts } from '../pages/workbench/model/joinDisplay';
import { projectGraphScene } from '../utils/graphProjection';

const viewer = { id: 'viewer', username: 'viewer', createdAt: '' };
const other = { id: 'other', username: 'other', createdAt: '' };
const at = (sequence: number) => `2026-10-21T00:00:${String(sequence).padStart(2, '0')}Z`;
function fixture(type = 'CLASSIFY') {
  const member: Message = { id: 'member', kind: 'TEXT', contentType: 'TEXT', content: '成员', createdAt: at(0), createdBy: other };
  const relations: Relation[] = ['A', 'B', 'C', 'D'].flatMap((id, index) => [
    { id, relationType: type, sourceMessageId: null, targetRefs: [{ kind: 'message', messageId: member.id }],
      payload: { independentMemberships: true }, createdAt: at(0), createdBy: other },
    { id: `join-${id}`, relationType: 'JOIN', sourceMessageId: id, targetRefs: [{ kind: 'message', messageId: member.id }],
      sequence: index + 1, revision: 1, createdAt: at(index + 1), createdBy: other,
      parts: [{ id: 'join', type: 'relation', relation: 'member-of', roles: {} }],
      payload: { membershipHistory: { id: `join-${id}`, memberId: member.id, parentId: id, previousId: index ? `join-${'ABCD'[index - 1]}` : null,
        previousParentId: index ? 'ABCD'[index - 1] : null, order: index + 1 } } },
  ]);
  const stakes: JoinStakeCounts = Object.fromEntries(['A', 'B', 'C', 'D'].map((id, index) => [`join-${id}`, { truth: { pro: [10, 30, 100, 0][index], con: 0 }, value: { pro: 0, con: 0 } }]));
  let sequence = 4;
  function stance(id: string, side: 'agree' | 'disagree', author = viewer) {
    sequence++;
    relations.push({ id: `stance-${sequence}`, relationType: side.toUpperCase(), sourceMessageId: null, sequence, revision: 1,
      createdAt: at(sequence), createdBy: author, targetRefs: [{ kind: 'relation', relationId: id }],
      executedStance: { partId: 'stance', sourceRevision: 1, target: { messageId: id, revision: 1, partId: 'join' }, side: side === 'agree' ? 'pro' : 'con' } });
  }
  function effect(username: string | null = viewer.username) {
    return deriveContainerEffect({ ...convertMessagesToDemoModel([member], relations), relations, username, stakeCounts: stakes });
  }
  function check(owner: string, username: string | null = viewer.username) {
    const result = effect(username);
    expect(result.joinByTarget.get(member.id)).toBe(`join-${owner}`);
    expect(result.effectiveJoinIds).toEqual(new Set([`join-${owner}`]));
    expect(['A', 'B', 'C', 'D'].filter(id => result.ownership.direct(id).textIds.has(member.id))).toEqual([owner]);
    expect(result.edges.filter(edge => ['A', 'B', 'C', 'D'].includes(edge.relationMessageId) && edge.to.messageId === member.id).map(edge => edge.relationMessageId)).toEqual([owner]);
    for (const id of ['A', 'B', 'C', 'D']) {
      expect(result.context.joinStatusByMessage.get(`join-${id}`) === 'valid').toBe(id === owner);
      const canvas = projectContainerCanvas(result, { kind: 'inside', id });
      expect(canvas.messages.filter(message => message.id === member.id)).toHaveLength(id === owner ? 1 : 0);
    }
    return result;
  }
  return { member, relations, stakes, stance, effect, check };
}

it.each(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'])('%s uses the latest personal choice immediately and restores its actual previous choice', type => {
  const t = fixture(type);
  expect(t.check('C').context.joinEffectSourcesByMessage).toEqual(new Map([['join-C',new Set(['recommended'])]]));
  t.stance('join-D', 'agree');
  expect(t.check('D').context.joinEffectSourcesByMessage).toEqual(new Map([['join-D',new Set(['personal'])]]));
  t.stance('join-B', 'agree'); t.check('B');
  t.stance('join-C', 'agree'); t.check('C');
  t.stance('join-C', 'disagree'); t.check('B');
  expect(t.effect().context.joinEffectSourcesByMessage?.get('join-B')).toEqual(new Set(['personal']));
  t.stance('join-B', 'disagree'); t.check('D');
  // Personal choices do not replace another viewer's recommended ownership.
  t.check('C', null); t.check('C', 'visitor');
});

it.each(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'])('%s keeps an inactive opposition local and applies it on later personal recovery', type => {
  const t = fixture(type);
  t.stance('join-D', 'agree'); t.stance('join-B', 'agree'); t.stance('join-C', 'agree');
  t.stance('join-B', 'disagree'); t.check('C');
  t.stance('join-C', 'disagree'); t.check('D');
  t.stance('join-B', 'agree'); t.check('B');
  t.stance('join-B', 'disagree'); t.check('D');
});

it('reversing personal B/C approval order reverses the immediate selection, independently of stake totals', () => {
  const t = fixture();
  t.stance('join-D', 'agree'); t.stance('join-C', 'agree'); t.stance('join-B', 'agree'); t.check('B');
  t.stance('join-B', 'disagree'); t.check('C');
});

it('uses support amounts for viewers without choices, with a stable tie and no influence from another user approval time', () => {
  const t = fixture();
  t.stance('join-A', 'agree', other);
  t.check('C', null);
  t.stakes['join-B'].truth.pro = 150;
  t.check('B', null);
  t.stakes['join-B'].truth.pro = 100;
  t.check('C', null);
  t.stakes['join-C'].truth.con = 200;
  t.check('B', null);
});

it('assumed agreement uses the same latest-choice rules without mutating the source', () => {
  const t = fixture();
  t.stance('join-D', 'agree');
  const before = t.effect(), original = JSON.stringify(t.relations);
  const after = deriveContainerEffect({ messages: before.messages, edges: before.traceEdges, relations: t.relations,
    username: viewer.username, stakeCounts: t.stakes, assumption: { messageId: 'join-B', side: 'agree' } });
  expect(after.joinByTarget.get('member')).toBe('join-B');
  expect(after.context.joinEffectSourcesByMessage?.get('join-B')).toEqual(new Set(['personal']));
  expect(before.joinByTarget.get('member')).toBe('join-D');
  expect(JSON.stringify(t.relations)).toBe(original);
});

it('never restores an authorized retired JOIN, even with an explicit personal approval', () => {
  const t = fixture();
  const old = t.relations.find(relation => relation.id === 'join-B')!;
  old.state = { messageId: old.id, revision: 1, suppressed: true, supportCount: 0, oppositionCount: 0, recommendationTotal: 0, membershipDisabled: true };
  t.stance('join-D', 'agree'); t.stance('join-B', 'agree');
  t.check('D');
});

it('keeps later moves and internal structures while a retired Topic becomes a terminal root placement', () => {
  const t = fixture();
  const topic = t.relations.find(relation => relation.id === 'B')!;
  topic.state = { messageId: topic.id, revision: 1, suppressed: true, supportCount: 0, oppositionCount: 0, recommendationTotal: 0, organizationRetired: true };
  const join = t.relations.find(relation => relation.id === 'join-B')!;
  join.state = { ...topic.state, messageId: join.id, organizationRetired: undefined, membershipDisabled: true };
  t.stance('join-A', 'agree'); t.stance('join-B', 'agree'); t.stance('join-C', 'agree');
  t.check('C');
  const before = t.effect();
  const preview = deriveContainerEffect({ messages: before.messages, edges: before.traceEdges, relations: t.relations,
    username: viewer.username, stakeCounts: t.stakes, assumption: { messageId: 'join-B', side: 'agree' } });
  expect(preview.joinByTarget.get('member')).toBe('join-C');
  t.stance('join-C', 'disagree');
  expect(t.effect().joinByTarget.has('member')).toBe(false);
  expect(projectContainerCanvas(t.effect(), {kind:'root'}).messages.filter(message => message.id === 'member')).toHaveLength(1);
  expect(projectContainerCanvas(t.effect(), {kind:'root'}).messages.some(message => message.id === 'B')).toBe(false);
});

it('preserves the latest personal selection when community weights change or records arrive in a different order', () => {
  const t = fixture();
  t.stance('join-D', 'agree'); t.stance('join-B', 'agree'); t.stance('join-C', 'agree');
  t.stakes['join-A'].truth.pro = 1000;
  t.stakes.C = { truth: { pro: 0, con: 500 }, value: { pro: 0, con: 0 } };
  t.relations.reverse();
  t.check('C'); t.check('A', null);
});

it('keeps the current personal choice when an inactive D is opposed, then respects that opposition during recovery', () => {
  const t = fixture();
  t.stance('join-A', 'agree'); t.stance('join-D', 'agree');
  t.stance('join-B', 'agree'); t.stance('join-C', 'agree');
  t.stance('join-D', 'disagree'); t.check('C');
  t.stance('join-C', 'disagree'); t.check('B');
  t.stance('join-B', 'disagree'); t.check('A');
});

it.each(['CLASSIFY','SUMMARY','MERGE','ARRANGE'])('%s keeps the member once at root after every JOIN is personally opposed, even when community support increases', type => {
  const t = fixture(type);
  t.stance('join-D','agree');t.stance('join-B','agree');t.stance('join-C','agree');
  for (const id of ['A', 'B', 'C', 'D']) t.stance(`join-${id}`, 'disagree');
  t.stakes['join-C'].truth.pro=10000;
  const effect = t.effect(), root = projectContainerCanvas(effect, { kind: 'root' });
  expect(effect.effectiveJoinIds.size).toBe(0);
  expect(effect.context.joinEffectSourcesByMessage?.size).toBe(0);
  expect(effect.joinByTarget.size).toBe(0);
  for(const id of ['A','B','C','D']){
    expect(effect.context.joinStatusByMessage.get(`join-${id}`)).toBe('rejected');
    expect(effect.ownership.direct(id).textIds.has('member')).toBe(false);
  }
  expect(root.messages.filter(message => message.id === 'member')).toHaveLength(1);
  t.check('C', null);
  t.stance('join-B','agree');t.check('B');
  t.stance('join-B','disagree');expect(t.effect().effectiveJoinIds.size).toBe(0);
});

it('marks the unopposed recommendation after personal choices are exhausted',()=>{
  const t=fixture();
  t.stance('join-D','agree');t.stance('join-D','disagree');
  expect(t.check('C').context.joinEffectSourcesByMessage?.get('join-C')).toEqual(new Set(['recommended']));
  t.stance('join-C','disagree');
  expect(t.check('B').context.joinEffectSourcesByMessage?.get('join-B')).toEqual(new Set(['recommended']));
});

it('does not treat an edited container publication cursor as a newer personal approval', () => {
  const t = fixture();
  t.stance('join-D', 'agree'); t.stance('join-C', 'agree');
  t.stance('C', 'disagree');
  // Address the container's organization component, rather than its JOIN component.
  t.relations.at(-1)!.executedStance!.target.partId = undefined;
  const container = t.relations.find(relation => relation.id === 'C')!;
  container.createdBy = viewer; container.sequence = 1000;
  t.check('D');
});

it('resolves each member of older multi-target JOINs without recomputing a different winner for frame edges', () => {
  const t = fixture();
  const a = t.relations.find(relation => relation.id === 'join-A')!, c = t.relations.find(relation => relation.id === 'join-C')!;
  a.targetRefs = [{ kind: 'message', messageId: 'member' }, { kind: 'message', messageId: 'second' }];
  c.targetRefs = [{ kind: 'message', messageId: 'second' }, { kind: 'message', messageId: 'third' }];
  delete a.payload!.membershipHistory; delete c.payload!.membershipHistory;
  t.stance(c.id, 'agree'); t.stance(a.id, 'agree');
  const messages = [t.member, ...['second', 'third'].map(id => ({ ...t.member, id }))];
  const effect = deriveContainerEffect({ ...convertMessagesToDemoModel(messages, t.relations), relations: t.relations,
    username: viewer.username, stakeCounts: t.stakes });
  expect(effect.joinByTarget).toEqual(new Map([['member', a.id], ['second', a.id], ['third', c.id]]));
  expect(effect.ownership.direct('A').textIds).toEqual(new Set(['member', 'second']));
  expect(effect.ownership.direct('C').textIds).toEqual(new Set(['third']));
  expect(effect.edges.filter(edge => ['A', 'C'].includes(edge.relationMessageId)).map(edge => `${edge.relationMessageId}:${edge.to.messageId}`).sort())
    .toEqual(['A:member', 'A:second', 'C:third']);
});

it.each(['CLASSIFY','MERGE'])('%s renders personal state instead of the protocol index state without rewriting source records', type => {
  const t = fixture(type), container = t.relations.find(relation => relation.id === 'C')!, joining = t.relations.find(relation => relation.id === 'join-C')!;
  container.state = { messageId: 'C', revision: 1, suppressed: true, supportCount: 0, oppositionCount: 1, recommendationTotal: 0 };
  joining.state = { ...container.state, messageId: joining.id, suppressed: false, membershipActive: false };
  t.stance('join-C', 'agree');
  const effect = t.check('C'), canvas = projectContainerCanvas(effect, { kind: 'root' });
  expect(effect.msgMap.get('C')!.state!.suppressed).toBe(false);
  expect(effect.msgMap.get(joining.id)!.state!.membershipActive).toBe(true);
  expect(container.state.suppressed).toBe(true); expect(joining.state.membershipActive).toBe(false);
  const graph = projectGraphScene({ ...canvas, rejectedContainerIds: effect.rejectedContainerIds, isTraceWindow: false, traceExpandedFrameIds: new Set() });
  if(type==='CLASSIFY')expect(graph.normalIds).toContain('C');
  else expect(graph.frameBlocks.find(frame=>frame.relMsgId==='C')?.directCardIds.has(t.member.id)).toBe(true);
});
