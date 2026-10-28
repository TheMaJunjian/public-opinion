import { resolveMemberships, type MembershipAction, type Reference } from '@gonglun/core';
import type { Relation } from '../../../types';
import { buildStanceTargetMap, computePublicStanceStats, resolveDisplayedStance, type DemoEdge, type DemoMessage } from '../../../utils/modelBridge';

export type JoinStakeCounts = Record<string, { truth: { pro: number; con: number }; value: { pro: number; con: number } }>;
export type JoinEffectSource = 'personal' | 'recommended';
type Choice = { joinId: string; order: number; previous?: Choice };
type Event = { id: string; time: number; sequence: number; targetId: string; side: 'agree' | 'disagree'; join?: Relation; creation?: boolean };
const containers = new Set(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE']);
const targetId = (ref: Relation['targetRefs'][number]) => ref.kind === 'relation' ? ref.relationId : ref.messageId;

/** Personal choices are a separate history; shared recommendations only fill gaps. */
export function resolveJoinDisplay(input: {
  relations: Relation[]; messages: DemoMessage[]; edges: DemoEdge[]; username: string | null;
  stakes: JoinStakeCounts; suppressed: ReadonlySet<string>;
  assumption?: { messageId: string; side: 'agree' | 'disagree' };
}) {
  const { relations, messages, edges, username, stakes } = input;
  const byId = new Map(relations.map(relation => [relation.id, relation]));
  const msgMap = new Map(messages.map(message => [message.id, message]));
  const stanceMap = buildStanceTargetMap(edges, msgMap);
  const joins = relations.filter(relation => relation.relationType.toUpperCase() === 'JOIN' && relation.sourceMessageId);
  const retired = new Set(relations.filter(relation => relation.state?.organizationRetired).map(relation => relation.id));
  const excluded = new Set(input.suppressed);
  const publicStances=computePublicStanceStats(edges,messages);
  for (const relation of relations) {
    if (!containers.has(relation.relationType.toUpperCase()) && relation.relationType.toUpperCase() !== 'JOIN') continue;
    const score = stakes[relation.id];
    if (!score) continue;
    const pro=score.truth.pro+score.value.pro,con=score.truth.con+score.value.con;
    if (con>pro||con===pro&&publicStances.get(relation.id)?.latest?.type==='disagree') excluded.add(relation.id);
    else excluded.delete(relation.id);
  }
  const events: Event[] = [];
  const whole = (ref: Reference, relation: Relation) => !ref.memberId && !ref.path?.length && !ref.range
    && (ref.revision === undefined || ref.revision === (relation.revision ?? 1))
    && (!ref.partId || relation.parts?.some(part => part.id === ref.partId && part.type === 'relation'
      && (part.relation === 'member-of' || containers.has(part.relation.toUpperCase()))));
  if (username) {
    for (const relation of relations) {
      if (relation.createdBy.username !== username || (!containers.has(relation.relationType.toUpperCase()) && relation.relationType.toUpperCase() !== 'JOIN')) continue;
      events.push({ id: relation.id, targetId: relation.id, time: Date.parse(relation.createdAt) || 0,
        sequence: relation.relationType.toUpperCase() === 'JOIN' ? relation.sequence ?? 0 : 0,
        side: 'agree', creation: true, ...(relation.relationType.toUpperCase() === 'JOIN' ? { join: relation } : {}) });
    }
    const seen = new Set<string>();
    for (const edge of edges) {
      if (!['agree', 'disagree'].includes(edge.relationType) || seen.has(edge.relationMessageId)) continue;
      const message = msgMap.get(edge.relationMessageId);
      if (message?.author !== username) continue;
      const executed = message.executedStance ?? message.state?.executedStance;
      const resolved = resolveDisplayedStance(edge, msgMap, stanceMap);
      const id = executed?.target.messageId ?? resolved?.targetId;
      const relation = id ? byId.get(id) : undefined;
      if (!relation || (!containers.has(relation.relationType.toUpperCase()) && relation.relationType.toUpperCase() !== 'JOIN')) continue;
      if (executed && !whole(executed.target, relation)) continue;
      seen.add(edge.relationMessageId);
      const side = executed ? executed.side === 'pro' ? 'agree' : 'disagree' : resolved!.type;
      events.push({ id: message.id, targetId: relation.id, time: Date.parse(message.createdAt) || 0,
        sequence: byId.get(message.id)?.sequence ?? 0, side,
        ...(side === 'agree' && relation.relationType.toUpperCase() === 'JOIN' ? { join: relation } : {}) });
    }
  }
  events.sort((a, b) => (a.sequence && b.sequence ? a.sequence - b.sequence : a.time - b.time)
    || Number(!!b.creation) - Number(!!a.creation)
    || (byId.get(a.id)?.payload?.membershipHistory?.order ?? 0) - (byId.get(b.id)?.payload?.membershipHistory?.order ?? 0) || a.id.localeCompare(b.id));
  if (input.assumption) {
    const relation = byId.get(input.assumption.messageId);
    if (relation && !retired.has(relation.id) && !retired.has(relation.sourceMessageId ?? '')) events.push({ id: 'assumed-choice', time: Infinity, sequence: Infinity, targetId: relation.id, side: input.assumption.side,
      ...(relation.relationType.toUpperCase() === 'JOIN' && input.assumption.side === 'agree' ? { join: relation } : {}) });
  }
  const votes = new Map<string, 'agree' | 'disagree'>();
  const heads = new Map<string, Choice>();
  const active = (choice?: Choice): Choice | undefined => {
    while (choice) {
      const join = byId.get(choice.joinId)!;
      if (retired.has(join.sourceMessageId!)) return choice;
      if (votes.get(join.id) !== 'disagree' && votes.get(join.sourceMessageId!) !== 'disagree') return choice;
      choice = choice.previous;
    }
  };
  for (const [order, event] of events.entries()) {
    const previous = event.join ? new Map(event.join.targetRefs.map(ref => [targetId(ref),active(heads.get(targetId(ref)))])) : undefined;
    votes.set(event.targetId, event.side);
    if(event.join?.sourceMessageId&&votes.get(event.join.sourceMessageId)!=='disagree')votes.set(event.join.sourceMessageId,'agree');
    if (event.join) for (const ref of event.join.targetRefs) {
      const memberId = targetId(ref);
      heads.set(memberId, { joinId: event.join.id, order: order + 1, previous: previous?.get(memberId) });
    }
  }
  // Personal opposition remains an exclusion even after the choice history is
  // exhausted; shared support must never restore an explicitly rejected JOIN.
  for (const [id, side] of votes) {
    if (side === 'agree') excluded.delete(id);
    else excluded.add(id);
  }
  for (const join of joins) if (join.state?.membershipDisabled) excluded.add(join.id);
  retired.forEach(id => excluded.add(id));
  const recommended = new Map<string, Relation[]>();
  for (const join of joins) {
    if (excluded.has(join.id) || excluded.has(join.sourceMessageId!)) continue;
    for (const ref of join.targetRefs) {
      const id = targetId(ref), list = recommended.get(id) ?? [];
      list.push(join); recommended.set(id, list);
    }
  }
  const pro = (join: Relation) => (stakes[join.id]?.truth.pro ?? 0) + (stakes[join.id]?.value.pro ?? 0);
  for (const list of recommended.values()) list.sort((a, b) => pro(b) - pro(a)
    || (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
    || (b.sequence??0)-(a.sequence??0)
    || (b.payload?.membershipHistory?.order ?? 0) - (a.payload?.membershipHistory?.order ?? 0) || b.id.localeCompare(a.id));
  const actions: MembershipAction[] = [], joinForAction = new Map<string, string>();
  const sourceForAction = new Map<string, JoinEffectSource>();
  for (const memberId of new Set([...heads.keys(), ...recommended.keys()])) {
    const candidates: Array<{ joinId: string; order: number; source: JoinEffectSource }> = [], seen = new Set<string>();
    let rootCheckpoint = false;
    for (let choice = heads.get(memberId); choice; choice = choice.previous) {
      if (retired.has(byId.get(choice.joinId)?.sourceMessageId ?? '')) { rootCheckpoint = true; break; }
      if (!seen.has(choice.joinId)) { candidates.push({...choice,source:'personal'}); seen.add(choice.joinId); }
    }
    for (const [index, join] of (rootCheckpoint ? [] : recommended.get(memberId) ?? []).entries()) if (!seen.has(join.id)) candidates.push({ joinId: join.id, order: -index - 1, source:'recommended' });
    let previousId: string | null = null, previousParentId: string | null = null;
    for (const [index, candidate] of [...candidates].reverse().entries()) {
      const join = byId.get(candidate.joinId)!;
      if (excluded.has(join.id) || excluded.has(join.sourceMessageId!)) continue;
      const id = `display:${memberId}:${index}`;
      actions.push({ id, memberId, parentId: join.sourceMessageId!, order: candidate.order, previousId, previousParentId });
      joinForAction.set(id, join.id); previousId = id; previousParentId = join.sourceMessageId!;
      sourceForAction.set(id,candidate.source);
    }
  }
  const resolved = resolveMemberships(actions, new Set());
  const sourcesByJoin = new Map<string, Set<JoinEffectSource>>();
  for (const action of resolved.effective.values()) {
    const joinId = joinForAction.get(action.id)!, sources = sourcesByJoin.get(joinId) ?? new Set<JoinEffectSource>();
    sources.add(sourceForAction.get(action.id)!); sourcesByJoin.set(joinId,sources);
  }
  return { byTarget: new Map([...resolved.effective].map(([id, action]) => [id, joinForAction.get(action.id)!])), sourcesByJoin, suppressed: excluded };
}
