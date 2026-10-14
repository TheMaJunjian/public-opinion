import type { Relation, TargetRef } from '../../../types';
import { normalizeContainerTargetRef, targetIsOwnedByContainer } from './containerTargets';
import { getEffectiveJoinRelationIds } from './membership';
import { getRelationTargetIds } from './relationComposition';

export function collectContainerVisibleIds(
  containerId: string,
  relations: Pick<Relation, 'id' | 'relationType' | 'sourceMessageId' | 'targetRefs'>[],
  rejectedContainerIds: Set<string> = new Set(),
  rejectedJoinRelationIds: Set<string> = new Set(),
): { textIds: Set<string>; relationIds: Set<string> } {
  const textIds = new Set<string>();
  const relationIds = new Set<string>();
  const effectiveJoinRelationIds = getEffectiveJoinRelationIds([...relations], rejectedContainerIds, rejectedJoinRelationIds);
  const container = relations.find(r => r.id === containerId);
  if (!container) return { textIds, relationIds };

  const containerType = container.relationType?.toUpperCase();
  if (containerType === 'ARRANGE' && container.sourceMessageId) {
    textIds.add(container.sourceMessageId);
  }

  for (const ref of container.targetRefs ?? []) {
    if (!targetIsOwnedByContainer(containerId, ref, relations, effectiveJoinRelationIds)) continue;
    const normalizedRef = normalizeContainerTargetRef(ref, relations);
    if (normalizedRef.kind === 'relation') {
      relationIds.add(normalizedRef.relationId);
    } else {
      textIds.add(normalizedRef.messageId);
    }
  }

  for (const relation of relations) {
    if (relation.relationType?.toUpperCase() !== 'JOIN') continue;
    if (relation.sourceMessageId !== containerId) continue;
    if (rejectedContainerIds.has(relation.id)) continue;
    if (rejectedContainerIds.has(relation.sourceMessageId)) continue;
    if (rejectedJoinRelationIds.has(relation.id)) continue;
    if (!effectiveJoinRelationIds.has(relation.id)) continue;
    for (const ref of relation.targetRefs ?? []) {
      const normalizedRef = normalizeContainerTargetRef(ref, relations);
      if (normalizedRef.kind === 'relation') {
        relationIds.add(normalizedRef.relationId);
      } else {
        textIds.add(normalizedRef.messageId);
      }
    }
  }

  return { textIds, relationIds };
}

export function collectOwnedByRelation(
  relationId: string,
  relationById: Map<string, Relation>,
  visited = new Set<string>(),
  rejectedContainerIds?: Set<string>,
  rejectedJoinRelationIds?: Set<string>,
): { textIds: Set<string>; relationIds: Set<string> } {
  const textIds = new Set<string>();
  const relationIds = new Set<string>();
  if (visited.has(relationId)) return { textIds, relationIds };
  visited.add(relationId);
  const relation = relationById.get(relationId);
  if (!relation) return { textIds, relationIds };
  const effectiveJoinRelationIds = getEffectiveJoinRelationIds([...relationById.values()], rejectedContainerIds ?? new Set(), rejectedJoinRelationIds ?? new Set());

  for (const targetRef of relation.targetRefs ?? []) {
    if (!targetIsOwnedByContainer(relationId, targetRef, [...relationById.values()], effectiveJoinRelationIds)) continue;
    const normalizedRef = normalizeContainerTargetRef(targetRef, [...relationById.values()]);
    if (normalizedRef.kind === 'relation') relationIds.add(normalizedRef.relationId);
    else textIds.add(normalizedRef.messageId);
  }
  const relType = relation.relationType.toUpperCase();
  if (relType === 'ARRANGE' && relation.sourceMessageId) {
    textIds.add(relation.sourceMessageId);
  }
  for (const childRelationId of getRelationTargetIds(relation.targetRefs)) {
    relationIds.add(childRelationId);
    const child = relationById.get(childRelationId);
    if (!child) continue;
    const childType = child.relationType.toUpperCase();
    if (childType !== 'CLASSIFY' && childType !== 'MERGE' && childType !== 'ARRANGE' && childType !== 'SUMMARY') continue;

    // Skip "加入" relations whose parent container is rejected —
    // their targets return to the parent canvas instead of being owned here.
    if (rejectedContainerIds && rejectedContainerIds.size > 0) {
      // A child with sourceMessageId is a "加入" relation (any container type).
      // If its parent container is rejected, the membership is dissolved.
      if (child.sourceMessageId && rejectedContainerIds.has(child.sourceMessageId)) {
        continue;
      }
      // Skip child containers that are themselves rejected.
      if (rejectedContainerIds.has(childRelationId)) {
        continue;
      }
    }
    if (rejectedJoinRelationIds && rejectedJoinRelationIds.size > 0 && rejectedJoinRelationIds.has(childRelationId)) {
      continue;
    }

    const nested = collectOwnedByRelation(childRelationId, relationById, visited, rejectedContainerIds, rejectedJoinRelationIds);
    nested.textIds.forEach(id => textIds.add(id));
    nested.relationIds.forEach(id => relationIds.add(id));
  }

  for (const joinRel of relationById.values()) {
    if (joinRel.id === relationId) continue;
    if (joinRel.relationType?.toUpperCase() !== 'JOIN') continue;
    if (joinRel.sourceMessageId !== relationId) continue;
    if (rejectedContainerIds && rejectedContainerIds.size > 0 && rejectedContainerIds.has(joinRel.id)) continue;
    if (rejectedJoinRelationIds && rejectedJoinRelationIds.size > 0 && rejectedJoinRelationIds.has(joinRel.id)) continue;
    if (!effectiveJoinRelationIds.has(joinRel.id)) continue;
    for (const targetRef of joinRel.targetRefs ?? []) {
      const normalizedRef = normalizeContainerTargetRef(targetRef, [...relationById.values()]);
      if (normalizedRef.kind === 'message' || normalizedRef.kind === 'text-fragment') {
        textIds.add(normalizedRef.messageId);
      } else if (normalizedRef.kind === 'relation') {
        relationIds.add(normalizedRef.relationId);
        const targetRelation = relationById.get(normalizedRef.relationId);
        if (targetRelation && (targetRelation.relationType?.toUpperCase() === 'CLASSIFY' || targetRelation.relationType?.toUpperCase() === 'MERGE' || targetRelation.relationType?.toUpperCase() === 'ARRANGE' || targetRelation.relationType?.toUpperCase() === 'SUMMARY')) {
          const nested = collectOwnedByRelation(normalizedRef.relationId, relationById, visited, rejectedContainerIds, rejectedJoinRelationIds);
          nested.textIds.forEach(id => textIds.add(id));
          nested.relationIds.forEach(id => relationIds.add(id));
        }
      }
    }
  }

  return { textIds, relationIds };
}

/**
 * Walk up the container chain: find all ancestor containers of a given container
 * by following JOIN relations that target it.
 * Returns a Set of container IDs ordered from innermost to outermost.
 */
export function getContainerAncestorChain(
  containerId: string,
  relations: Relation[],
): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  const containerRelationTypes = new Set(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE']);
  let current = containerId;

  while (current && !visited.has(current)) {
    visited.add(current);
    // Find a JOIN relation whose targetRefs contain `current`.
    const joinRel = relations.find(r =>
      r.relationType?.toUpperCase() === 'JOIN' &&
      !!r.sourceMessageId &&
      (r.targetRefs as TargetRef[]).some(ref =>
        (ref.kind === 'relation' && ref.relationId === current) ||
        (ref.kind === 'message' && ref.messageId === current)
      )
    );
    const directParent = joinRel ? undefined : relations.find(r =>
      containerRelationTypes.has(r.relationType?.toUpperCase() ?? '') &&
      (r.targetRefs as TargetRef[]).some(ref =>
        (ref.kind === 'relation' && ref.relationId === current) ||
        (ref.kind === 'message' && ref.messageId === current)
      )
    );
    const parentId = joinRel?.sourceMessageId ?? directParent?.id;
    if (!parentId) break;
    chain.push(parentId);
    current = parentId;
  }

  return chain;
}

/**
 * Check whether two containers are on the same ancestor chain.
 */
export function areContainersOnSameChain(
  a: string,
  b: string,
  relations: Relation[],
): boolean {
  if (a === b) return true;
  const chainA = new Set(getContainerAncestorChain(a, relations));
  const chainB = getContainerAncestorChain(b, relations);
  // If b is in a's ancestor chain, or a is in b's ancestor chain
  if (chainA.has(b)) return true;
  if (chainB.includes(a)) return true;
  return false;
}
