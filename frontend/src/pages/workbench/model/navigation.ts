import type { Relation, TargetRef } from '../../../types';
import { getPresentationSpec } from '../../../types';
import type { DemoMessage } from '../../../utils/modelBridge';
import { resolveMessageCanvas } from './membership';
import { areContainersOnSameChain } from './ownership';

export function getAutoClassifyTargetForSettlementMessage(msg: Pick<DemoMessage, 'id' | 'kind'>): TargetRef | null {
  if (msg.kind === 'round_result') {
    return { kind: 'message', messageId: msg.id };
  }
  return null;
}

export function getSettlementClassifyJoinTarget(msg: Pick<DemoMessage, 'id' | 'kind'>): TargetRef | null {
  return getAutoClassifyTargetForSettlementMessage(msg);
}

export function expandTextIdsWithSettlementResults(
  textIds: Set<string>,
  messages: Pick<DemoMessage, 'id' | 'kind' | 'settlementTargetId'>[],
): Set<string> {
  const expanded = new Set(textIds);
  for (const msg of messages) {
    if (msg.kind !== 'round_result') continue;
    if (msg.settlementTargetId && expanded.has(msg.settlementTargetId)) {
      expanded.add(msg.id);
    }
  }
  return expanded;
}

export function resolveNavigationTargetId(
  messageId: string,
  messages: DemoMessage[],
  relations: Relation[],
): string {
  const message = messages.find(item => item.id === messageId);
  if (message && (message.kind === 'round' || message.kind === 'round_result')) {
    return message.settlementTargetId ?? messageId;
  }
  const relation = relations.find(item => item.id === messageId);
  if (!relation) return messageId;

  if (relation.relationType.toUpperCase() === 'JOIN') {
    return messageId;
  }

  if (['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'].includes(relation.relationType.toUpperCase())) {
    return messageId;
  }

  if (['AGREE', 'DISAGREE', 'CORRECT'].includes(relation.relationType.toUpperCase())
    || getPresentationSpec(relation.relationType).kind === 'inline-badge') {
    return messageId;
  }

  if (getPresentationSpec(relation.relationType).kind === 'edge-label') {
    return messageId;
  }

  const firstTarget = (relation.targetRefs ?? []).find(ref =>
    (ref.kind === 'message' || ref.kind === 'text-fragment' || ref.kind === 'relation') &&
    (('messageId' in ref && !!ref.messageId) || ('relationId' in ref && !!ref.relationId))
  );
  if (firstTarget) {
    return firstTarget.kind === 'relation'
      ? (firstTarget.relationId ?? messageId)
      : ((firstTarget as { messageId?: string }).messageId ?? messageId);
  }

  return messageId;
}

/**
 * Check if a message can be added to (or agreed into) a container without conflict.
 * Uses resolveMessageCanvas to find the message's current container —
 * it must be null (main canvas) or on the same chain as the target.
 */
export function checkJoinConflict(
  messageId: string,
  targetContainerId: string,
  relations: Relation[],
  rejectedContainerIds: Set<string>,
  rejectedJoinRelationIds?: Set<string>,
): { ok: boolean; conflictContainerId?: string } {
  const current = resolveMessageCanvas(messageId, relations, rejectedContainerIds, rejectedJoinRelationIds);
  if (current === null) return { ok: true };
  if (current === targetContainerId) return { ok: true };
  if (areContainersOnSameChain(current, targetContainerId, relations)) return { ok: true };
  return { ok: false, conflictContainerId: current };
}

/**
 * Check whether disagreeing on a "加入" relation would leave a message
 * in two unrelated canvases.
 */
export function checkJoinConflictAfterRemoval(
  textMessageId: string,
  containerBeingLeft: string,
  relations: Relation[],
  rejectedContainerIds: Set<string>,
  rejectedJoinRelationIds?: Set<string>,
): { ok: boolean } {
  const current = resolveMessageCanvas(textMessageId, relations, rejectedContainerIds, rejectedJoinRelationIds);
  if (current === null) return { ok: true };
  // If the message's effective container IS the one being left, it leaves together.
  if (current === containerBeingLeft) return { ok: true };
  // If on the same chain, the message is inside a child container that also leaves.
  if (areContainersOnSameChain(current, containerBeingLeft, relations)) return { ok: true };
  // Unrelated container — no conflict from this removal.
  return { ok: true };
}
