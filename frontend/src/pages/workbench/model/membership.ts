import type { Relation, TargetRef } from '../../../types';
import type { DemoEdge } from '../../../utils/modelBridge';
import { targetIsOwnedByContainer } from './containerTargets';

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

/** Return rejected container IDs that must also receive AGREE to restore a JOIN. */
export function getJoinRecoveryTargetIds(
  targetMessageIds: string[],
  relations: Pick<Relation, 'id' | 'relationType' | 'sourceMessageId'>[],
  rejectedContainerIds: Set<string>,
): string[] {
  const targetIdSet = new Set(targetMessageIds);
  return Array.from(new Set(
    relations
      .filter(relation =>
        targetIdSet.has(relation.id) &&
        relation.relationType?.toUpperCase() === 'JOIN' &&
        !!relation.sourceMessageId &&
        rejectedContainerIds.has(relation.sourceMessageId)
      )
      .map(relation => relation.sourceMessageId!)
  ));
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

type JoinRelationRecord = Omit<Pick<Relation, 'id' | 'relationType' | 'sourceMessageId' | 'targetRefs' | 'createdAt'>, 'createdAt'> & { createdAt?: string; createdBy?: Relation['createdBy'] };

function getJoinTargetKey(ref: TargetRef): string {
  return ref.kind === 'relation' ? `relation:${ref.relationId}` : `message:${ref.messageId}`;
}

function joinTargetsMessage(joinRelation: JoinRelationRecord, messageId: string): boolean {
  return (joinRelation.targetRefs as TargetRef[]).some(ref =>
    (ref.kind === 'message' || ref.kind === 'text-fragment') && ref.messageId === messageId
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
  const staleJoinRelationIds = new Set(getStaleJoinRelationIds(relations));
  const candidates = relations
    .filter(r =>
      JOIN_RELATION_TYPES.has(r.relationType) &&
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
  const staleJoinRelationIds = new Set(getStaleJoinRelationIds(relations));
  const targetKeys = new Set<string>();
  for (const relation of relations) {
    if (relation.relationType?.toUpperCase() !== 'JOIN') continue;
    for (const ref of relation.targetRefs as TargetRef[]) {
      targetKeys.add(getJoinTargetKey(ref));
    }
  }
  const effective = new Set<string>();
  for (const targetKey of targetKeys) {
    const candidates = relations.filter(relation =>
      relation.relationType?.toUpperCase() === 'JOIN' &&
      !!relation.sourceMessageId &&
      !rejectedContainerIds.has(relation.id) &&
      !rejectedJoinRelationIds.has(relation.id) &&
      !userDisagreedJoinRelationIds?.has(relation.id) &&
      !staleJoinRelationIds.has(relation.id) &&
      !rejectedContainerIds.has(relation.sourceMessageId) &&
      (relation.targetRefs as TargetRef[]).some(ref => getJoinTargetKey(ref) === targetKey)
    );
    const join = [...candidates]
      .sort((a, b) => {
        return new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime();
      })[0];
    if (join) effective.add(join.id);
  }
  return effective;
}

/** Keep container frame edges only for their currently effective JOIN members. */
export function filterContainerEdgesByEffectiveJoins(
  edges: DemoEdge[],
  relations: Pick<Relation, 'id' | 'relationType' | 'sourceMessageId' | 'targetRefs'>[],
  effectiveJoinRelationIds: Set<string>,
): DemoEdge[] {
  const containerTypes = new Set(['CLASSIFY', 'SUMMARY', 'ARRANGE', 'MERGE']);
  return edges.filter(edge => {
    if (!containerTypes.has(edge.relationType.toUpperCase())) return true;
    const container = relations.find(relation => relation.id === edge.relationMessageId);
    const originalTargetRef = (container?.targetRefs as TargetRef[] | undefined)?.find(ref =>
      (ref.kind === 'relation' && ref.relationId === edge.to.messageId) ||
      (ref.kind !== 'relation' && ref.messageId === edge.to.messageId)
    );
    if (originalTargetRef && targetIsOwnedByContainer(
      edge.relationMessageId,
      originalTargetRef,
      relations,
      effectiveJoinRelationIds,
    )) return true;
    return relations.some(relation =>
      relation.relationType?.toUpperCase() === 'JOIN' &&
      relation.sourceMessageId === edge.relationMessageId &&
      effectiveJoinRelationIds.has(relation.id) &&
      (relation.targetRefs as TargetRef[]).some(ref =>
        (ref.kind === 'relation' && ref.relationId === edge.to.messageId) ||
        (ref.kind !== 'relation' && ref.messageId === edge.to.messageId)
      )
    );
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
