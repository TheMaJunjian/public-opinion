import type { Relation, TargetRef } from '../../../types';
import type { DemoEdge } from '../../../utils/modelBridge';
import { resolveMemberships, type MembershipAction } from '@gonglun/core';
import type { JoinEffectSource } from './joinDisplay';

export type JoinStatus = 'valid' | 'rejected' | 'container-rejected' | 'superseded' | 'inactive' | 'retired';
export const JOIN_STATUS_LABELS: Record<JoinStatus, string> = {
  valid: '生效',
  rejected: '被反对 · 未生效',
  'container-rejected': '容器被反对 · 未生效',
  superseded: '未选中 · 未生效',
  inactive: '未生效',
  retired: '已停用 · 历史记录',
};
export const JOIN_STATUS_HINTS: Record<JoinStatus, string> = {
  valid: '反对这条加入消息，将按它保存的前序归属移出。',
  rejected: '这条记录已被反对，不参与当前用户的回退或推荐；赞同后成为最新个人选择。',
  'container-rejected': '请先赞同并恢复容器，再赞同这条加入消息。',
  superseded: '赞同这条加入消息会成为你的最新选择；反对后按个人选择的前序恢复。',
  inactive: '当前消息不由这条加入记录决定归属。',
  retired: '这条加入记录对应的归属已停用，保留用于历史查看，不再参与当前归属。',
};

export function getJoinStatusPresentation(status: JoinStatus, sources?: ReadonlySet<JoinEffectSource>) {
  if (status !== 'valid' || !sources?.size) return {label:JOIN_STATUS_LABELS[status],hint:JOIN_STATUS_HINTS[status]};
  const personal=sources.has('personal'),recommended=sources.has('recommended');
  return {label:[...(personal?['当前用户生效']:[]),...(recommended?['推荐生效']:[])].join(' · '),
    hint:personal&&recommended?'这条记录的不同目标分别按当前用户选择和统计推荐生效。'
      :personal?'按当前用户的最新个人选择或其前序选择生效。'
      :'当前用户没有可用的个人赞同选择，按未被当前用户反对的加入记录中赞同押注最多的推荐生效。'};
}

/** Status badges use the same winners as ownership, including simulated views. */
export function getJoinStatusByMessage(
  relations: JoinRelationRecord[], effective: ReadonlySet<string>,
  rejectedContainers: ReadonlySet<string>, rejectedJoins: ReadonlySet<string>,
): Map<string, JoinStatus> {
  const joins = relations.filter(relation => relation.relationType.toUpperCase() === 'JOIN');
  const latestOrder = new Map<string, number>();
  for (const join of joins) {
    const action = join.payload?.membershipHistory;
    if (action) latestOrder.set(action.memberId, Math.max(action.order, latestOrder.get(action.memberId) ?? -Infinity));
  }
  return new Map(joins.map(relation => {
    const action = relation.payload?.membershipHistory;
    const superseded = relation.sourceMessageId && (!action || (latestOrder.get(action.memberId) ?? action.order) > action.order);
    const status: JoinStatus = relation.state?.membershipDisabled ? 'retired' : effective.has(relation.id) ? 'valid'
      : rejectedJoins.has(relation.id) ? 'rejected'
      : relation.sourceMessageId && rejectedContainers.has(relation.sourceMessageId) ? 'container-rejected'
      : superseded ? 'superseded' : 'inactive';
    return [relation.id, status];
  }));
}

/** Materialize active JOIN membership for display without changing declarations. */
export function projectJoinMembershipEdges(edges:DemoEdge[],relations:Relation[],effective:Set<string>,visibleContainers:ReadonlySet<string>,displayWinners?:ReadonlyMap<string,string>):DemoEdge[] {
  const byId=new Map(relations.map(relation=>[relation.id,relation]));
  const seen=new Set(edges.map(edge=>`${edge.relationMessageId}:${edge.to.messageId}`));
  const result=[...edges];
  const winners = displayWinners??getEffectiveJoinByTarget(relations.filter(relation => relation.relationType.toUpperCase() !== 'JOIN' || effective.has(relation.id)), new Set(), new Set());
  for(const join of relations){
    if(join.relationType.toUpperCase()!=='JOIN'||!effective.has(join.id)||!join.sourceMessageId||!visibleContainers.has(join.sourceMessageId))continue;
    const container=byId.get(join.sourceMessageId),type=container?.relationType.toLowerCase();
    if(!type||!['classify','summary','merge','arrange'].includes(type))continue;
    for(const [index,ref] of join.targetRefs.entries()){
      const id=ref.kind==='relation'?ref.relationId:ref.messageId,key=`${join.sourceMessageId}:${id}`;
      if (winners.get(id) !== join.id) continue;
      if(seen.has(key))continue;
      seen.add(key);
      result.push({id:`membership:${join.id}:${index}`,relationMessageId:join.sourceMessageId,relationType:type as DemoEdge['relationType'],relationLabel:type,from:{messageId:`anon:${join.sourceMessageId}`,selection:{kind:'whole'}},to:{messageId:id,selection:{kind:'whole'},reference:ref.reference}});
    }
  }
  return result;
}

export function isAppendToExistingClassifyAction(options: {
  relationType: string | null;
  draftCount: number;
  targetCount: number;
  text: string;
  sourceClassifyCount: number;
}): boolean {
  return options.relationType === 'classify' &&
    (options.draftCount > 0 || options.targetCount > 0) &&
    options.text.trim().length === 0 &&
    options.sourceClassifyCount === 1;
}

export function getRejectedJoinRelationIds(
  relations: Pick<Relation, 'id' | 'relationType'>[],
  voteStats: Record<string, { agreeCount: number; disagreeCount: number }> | Map<string, { agreeCount: number; disagreeCount: number }>,
): string[] {
  const statsMap = voteStats instanceof Map ? voteStats : new Map(Object.entries(voteStats));
  return relations
    .filter(r => {
      if (r.relationType?.toUpperCase() !== 'JOIN') return false;
      const stats = statsMap.get(r.id);
      return !!stats && stats.disagreeCount > stats.agreeCount;
    })
    .map(r => r.id);
}

/**
 * Get all active (non-rejected) "加入" relations for a message.
 * Covers all four container types: CLASSIFY, SUMMARY, ARRANGE, MERGE.
 * A "加入" relation is identified by having a sourceMessageId (the container
 * being joined) and targeting this message.
 * Returns sorted by createdAt descending (latest first).
 */
const JOIN_RELATION_TYPES = new Set(['JOIN']);

type JoinRelationRecord = Omit<Pick<Relation, 'id' | 'relationType' | 'sourceMessageId' | 'targetRefs' | 'createdAt'>, 'createdAt'> & { createdAt?: string; createdBy?: Relation['createdBy']; payload?: Relation['payload']; state?: Relation['state'] };

function getJoinTargetKey(ref: TargetRef): string {
  return ref.kind === 'relation' ? ref.relationId : ref.messageId;
}

function joinTargetsMessage(joinRelation: JoinRelationRecord, messageId: string): boolean {
  return (joinRelation.targetRefs as TargetRef[]).some(ref =>
    (ref.kind === 'relation' ? ref.relationId : ref.messageId) === messageId
  );
}

/** JOIN records whose source container no longer exists. */
export function getStaleJoinRelationIds(
  relations: JoinRelationRecord[],
): string[] {
  const joins = relations.filter(relation => JOIN_RELATION_TYPES.has(relation.relationType?.toUpperCase() ?? ''));
  return joins
    .filter(join => !join.sourceMessageId)
    .map(join => join.id);
}

export function getActiveJoinRelationsForMessage(
  messageId: string,
  relations: JoinRelationRecord[],
  rejectedContainerIds: Set<string>,
  rejectedJoinRelationIds?: Set<string>,
): JoinRelationRecord[] {
  const effective = getEffectiveJoinRelationIds(relations, rejectedContainerIds, rejectedJoinRelationIds ?? new Set());
  const staleJoinRelationIds = new Set(getStaleJoinRelationIds(relations));
  const candidates = relations
    .filter(r =>
      JOIN_RELATION_TYPES.has(r.relationType.toUpperCase()) && effective.has(r.id) &&
      !!r.sourceMessageId &&
      !rejectedContainerIds.has(r.id) &&
      !rejectedContainerIds.has(r.sourceMessageId) &&
      !(rejectedJoinRelationIds && rejectedJoinRelationIds.has(r.id)) &&
      !staleJoinRelationIds.has(r.id) &&
      joinTargetsMessage(r, messageId)
    );
  return candidates
    .sort((a, b) =>
      new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
    )
    .slice(0, 1);
}

/** Return the single effective JOIN for every message target. */
export function getEffectiveJoinRelationIds(
  relations: JoinRelationRecord[],
  rejectedContainerIds: Set<string>,
  rejectedJoinRelationIds: Set<string>,
  userDisagreedJoinRelationIds?: ReadonlySet<string>,
): Set<string> {
  return new Set(getEffectiveJoinByTarget(relations, rejectedContainerIds, rejectedJoinRelationIds, userDisagreedJoinRelationIds).values());
}

/** Preserve the winning target as well as the record ID for older multi-target JOINs. */
export function getEffectiveJoinByTarget(
  relations: JoinRelationRecord[], rejectedContainerIds: Set<string>, rejectedJoinRelationIds: Set<string>, userDisagreedJoinRelationIds?: ReadonlySet<string>,
): Map<string, string> {
  const actions: MembershipAction[] = relations.flatMap(relation => relation.relationType.toUpperCase() === 'JOIN' && relation.payload?.membershipHistory ? [relation.payload.membershipHistory] : []);
  const retired = new Set(relations.filter(relation => relation.state?.organizationRetired).map(relation => relation.id));
  const rejected = new Set([...rejectedContainerIds, ...rejectedJoinRelationIds, ...(userDisagreedJoinRelationIds ?? [])]);
  for (const relation of relations) if (relation.state?.membershipDisabled) rejected.add(relation.id);
  const resolved = resolveMemberships(actions, rejected, retired);
  const latest = new Map<string, {id:string; time:number}>();
  for (const relation of relations) {
    if (relation.relationType?.toUpperCase() !== 'JOIN' || !relation.sourceMessageId
      || relation.state?.membershipDisabled || retired.has(relation.sourceMessageId)
      || rejectedContainerIds.has(relation.id) || rejectedJoinRelationIds.has(relation.id)
      || userDisagreedJoinRelationIds?.has(relation.id) || rejectedContainerIds.has(relation.sourceMessageId)) continue;
    const time = new Date(relation.createdAt ?? 0).getTime();
    for (const ref of relation.targetRefs as TargetRef[]) {
      const key = getJoinTargetKey(ref), previous = latest.get(key);
      if (resolved.trackedMembers.has(key)) continue;
      // Equal times keep the first source record, matching stable sort semantics.
      if (!previous || time > previous.time) latest.set(key, {id:relation.id,time});
    }
  }
  return new Map([...latest].map(([id, join]) => [id, join.id] as const).concat([...resolved.effective].map(([id, action]) => [id, action.id] as const)));
}

/** Keep container frame edges only for their currently effective JOIN members. */
export function filterContainerEdgesByEffectiveJoins(
  edges: DemoEdge[],
  relations: Pick<Relation, 'id' | 'relationType' | 'sourceMessageId' | 'targetRefs'>[],
  effectiveJoinRelationIds: Set<string>,
  displayWinners?: ReadonlyMap<string,string>,
): DemoEdge[] {
  const containerTypes = new Set(['CLASSIFY', 'SUMMARY', 'ARRANGE', 'MERGE']);
  const members=new Map(relations.filter(relation=>containerTypes.has(relation.relationType.toUpperCase())).map(relation=>[relation.id,new Set(relation.targetRefs.map(ref=>ref.kind==='relation'?ref.relationId:ref.messageId))]));
  const winners = displayWinners??getEffectiveJoinByTarget(relations.filter(relation => relation.relationType.toUpperCase() !== 'JOIN' || effectiveJoinRelationIds.has(relation.id)),new Set(),new Set());
  const joined=new Set<string>(),owners=new Map<string,Set<string>>();
  for(const join of relations) if(join.relationType.toUpperCase()==='JOIN') for(const ref of join.targetRefs) {
    const id=ref.kind==='relation'?ref.relationId:ref.messageId;
    joined.add(id);
    if(join.sourceMessageId&&effectiveJoinRelationIds.has(join.id)&&winners.get(id)===join.id) {
      const current=owners.get(id)??new Set<string>();current.add(join.sourceMessageId);owners.set(id,current);
    }
  }
  return edges.filter(edge=>{
    if(!containerTypes.has(edge.relationType.toUpperCase()))return true;
    const target=edge.to.messageId;
    if(owners.get(target)?.has(edge.relationMessageId))return true;
    return !joined.has(target)&&members.get(edge.relationMessageId)?.has(target)===true;
  });

}

/** Return the latest JOIN action for each target in the current user's view. */
export function getUserPreferredJoinByTarget(
  relations: JoinRelationRecord[],
  activeStanceMap: ReadonlyMap<string, { relMsgId: string; type: 'agree' | 'disagree' }>,
  username: string | null,
): Map<string, string> {
  const preferred = new Map<string, { relationId: string; time: number }>();
  const joins = relations.filter(relation => relation.relationType?.toUpperCase() === 'JOIN');
  const consider = (targetId: string, relationId: string, time: number) => {
    const current = preferred.get(targetId);
    if (!current || time > current.time) preferred.set(targetId, { relationId, time });
  };
  if (username) {
    for (const join of joins) {
      if (join.createdBy?.username !== username) continue;
      const time = new Date(join.createdAt ?? 0).getTime();
      for (const ref of join.targetRefs as TargetRef[]) {
        if (ref.kind === 'message' || ref.kind === 'text-fragment') consider(ref.messageId, join.id, time);
      }
    }
  }
  for (const [targetRelationId, stance] of activeStanceMap) {
    if (stance.type !== 'agree') continue;
    const join = joins.find(relation => relation.id === targetRelationId);
    const agree = relations.find(relation => relation.id === stance.relMsgId);
    if (!join || !agree) continue;
    const time = new Date(agree.createdAt ?? 0).getTime();
    for (const ref of join.targetRefs as TargetRef[]) {
      if (ref.kind === 'message' || ref.kind === 'text-fragment') consider(ref.messageId, join.id, time);
    }
  }
  return new Map(Array.from(preferred, ([targetId, value]) => [targetId, value.relationId]));
}

/** Get every JOIN record directly targeting a message or container relation. */
export function getJoinRelationsForMessage(messageId: string, relations: Relation[]): Relation[] {
  return relations
    .filter(r =>
      r.relationType?.toUpperCase() === 'JOIN' &&
      !!r.sourceMessageId &&
      (r.targetRefs as TargetRef[]).some(ref =>
        (ref.kind === 'relation' && ref.relationId === messageId) ||
        (ref.kind !== 'relation' && ref.messageId === messageId)
      )
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Resolve which container (if any) a message currently belongs to.
 *
 * Walks the "加入" relation chain bottom-up: finds the latest active CLASSIFY
 * relation targeting this message, returns its sourceMessageId (the container).
 * If the container itself is in another container, we still return the IMMEDIATE
 * container — nesting is handled by the caller via recursive expansion.
 *
 * Returns the container relation ID, or null if the message is on the main canvas.
 */
export function resolveMessageCanvas(
  messageId: string,
  relations: Relation[],
  rejectedContainerIds: Set<string>,
  rejectedJoinRelationIds?: Set<string>,
): string | null {
  const active = getActiveJoinRelationsForMessage(messageId, relations, rejectedContainerIds, rejectedJoinRelationIds);
  if (active.length === 0) return null;
  return active[0].sourceMessageId!;
}

/**
 * Build a map from content-kind message ID → immediate container ID (or null).
 * Used as a drop-in replacement for the activeClassifyOwnership.textIds pattern.
 */
export function buildMessageCanvasMap(
  messages: Array<{ id: string; kind: string }>,
  relations: Relation[],
  rejectedContainerIds: Set<string>,
  rejectedJoinRelationIds?: Set<string>,
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const m of messages) {
    map.set(m.id, resolveMessageCanvas(m.id, relations, rejectedContainerIds, rejectedJoinRelationIds));
  }
  return map;
}
