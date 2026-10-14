import type { Relation, TargetRef } from '../../../types';

export function targetIsOwnedByContainer(
  containerId: string,
  targetRef: TargetRef,
  relations: Pick<Relation, 'id' | 'relationType' | 'sourceMessageId' | 'targetRefs'>[],
  effectiveJoinRelationIds: Set<string>,
): boolean {
  const normalizedTargetRef = normalizeContainerTargetRef(targetRef, relations);
  const matchingJoins = relations.filter(relation =>
    relation.relationType?.toUpperCase() === 'JOIN' &&
    (relation.targetRefs ?? []).some(candidate =>
      sameTargetRef(normalizeContainerTargetRef(candidate, relations), normalizedTargetRef)
    )
  );
  if (matchingJoins.length === 0) return true;
  return matchingJoins.some(join =>
    join.sourceMessageId === containerId && effectiveJoinRelationIds.has(join.id)
  );
}

export function normalizeContainerTargetRef(
  targetRef: TargetRef,
  relations: Pick<Relation, 'id' | 'relationType'>[],
): TargetRef {
  if (targetRef.kind === 'relation') return targetRef;
  const targetRelation = relations.find(relation => relation.id === targetRef.messageId);
  const targetType = targetRelation?.relationType?.toUpperCase();
  if (targetType === 'CLASSIFY' || targetType === 'MERGE' || targetType === 'ARRANGE' || targetType === 'SUMMARY') {
    return { kind: 'relation', relationId: targetRef.messageId };
  }
  return targetRef;
}

function sameTargetRef(left: TargetRef, right: TargetRef): boolean {
  if (left.kind === 'relation' || right.kind === 'relation') {
    return left.kind === 'relation' && right.kind === 'relation' && left.relationId === right.relationId;
  }
  return left.messageId === right.messageId;
}

