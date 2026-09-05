/**
 * crossLinkValidator.ts — Cross-link validation for grouping relations.
 *
 * Extracted from routes/relations.ts to keep route handlers lean.
 *
 * Validates that grouping and JOIN relations do not split a non-reference
 * relation across the selected grouping boundary.
 */

import { prisma } from './prisma';

// ============================================================
// Error messages (exported for test assertions)
// ============================================================

export const CLASSIFY_CROSS_LINK_ERROR = '分类目标与其他文本消息存在非引用关联，无法建立分类关系';
export const MERGE_CROSS_LINK_ERROR = '归并目标与其他文本消息存在非引用关联，无法建立归并关系';
export const ARRANGE_CROSS_LINK_ERROR = '排列目标与其他文本消息存在非引用关联，无法建立排列关系';
export const SUMMARY_CROSS_LINK_ERROR = '总结目标与其他文本消息存在非引用关联，无法建立总结关系';
export const SUMMARY_TARGET_TYPE_ERROR = '总结关系的目标关系消息只能是排列、归并或分类关系消息';

// ============================================================
// Pure utility functions
// ============================================================

/** Extract text message IDs from a targetRefs array. */
export function extractTextTargetIds(targetRefs: unknown): string[] {
  if (!Array.isArray(targetRefs)) return [];
  return [...new Set(
    targetRefs
      .filter((ref): ref is { kind: 'message' | 'text-fragment'; messageId: string } =>
        !!ref &&
        typeof ref === 'object' &&
        ((ref as { kind?: unknown }).kind === 'message' || (ref as { kind?: unknown }).kind === 'text-fragment') &&
        typeof (ref as { messageId?: unknown }).messageId === 'string'
      )
      .map(ref => ref.messageId)
  )];
}

/** Extract relation message IDs from a targetRefs array. */
export function extractNestedRelationIds(targetRefs: unknown): string[] {
  if (!Array.isArray(targetRefs)) return [];
  return [...new Set(
    targetRefs
      .filter((ref): ref is { kind: 'relation'; relationId: string } =>
        !!ref &&
        typeof ref === 'object' &&
        (ref as { kind?: unknown }).kind === 'relation' &&
        typeof (ref as { relationId?: unknown }).relationId === 'string'
      )
      .map(ref => ref.relationId)
  )];
}

/**
 * Expand a set of target text IDs by following expandable relation targets
 * (CLASSIFY, MERGE, ARRANGE, SUMMARY).  Used to collect the full set of
 * selected text messages when a grouping relation targets other grouping
 * relations.
 */
export function collectSelectedGroupTargetTextIds(params: {
  targetTextIds: string[];
  selectedRelationIds: string[];
  targetRelations: Array<{ id: string; relationType: string | null; targetRefs: unknown }>;
}): string[] {
  const selectedTextIds = new Set(params.targetTextIds);
  const relationById = new Map(
    params.targetRelations.map(rel => [rel.id, rel] as const)
  );
  const expandableRelationTypes = new Set(['CLASSIFY', 'MERGE', 'ARRANGE', 'SUMMARY']);
  const queue = params.selectedRelationIds.filter(relId => relationById.has(relId));
  const visited = new Set<string>();

  while (queue.length > 0) {
    const relId = queue.shift()!;
    if (visited.has(relId)) continue;
    visited.add(relId);
    const rel = relationById.get(relId);
    if (!rel) continue;
    if (!expandableRelationTypes.has(rel.relationType ?? '')) continue;
    extractTextTargetIds(rel.targetRefs).forEach(id => selectedTextIds.add(id));
    for (const nestedRelId of extractNestedRelationIds(rel.targetRefs)) {
      if (!visited.has(nestedRelId) && relationById.has(nestedRelId)) queue.push(nestedRelId);
    }
  }

  return [...selectedTextIds];
}

// ============================================================
// Validation entry point
// ============================================================

export interface GroupingValidationParams {
  topicId: string;
  relationType: 'CLASSIFY' | 'MERGE' | 'ARRANGE' | 'SUMMARY' | 'JOIN';
  targetRefs: Array<{ kind: string; messageId?: string; relationId?: string }>;
  targetRelationIds: string[];
  foundTargetRelations: Array<{ id: string; relationType: string | null; targetRefs: unknown }>;
}

export interface GroupingValidationResult {
  ok: boolean;
  error?: string;
}

export const CONTAINER_RELATION_TYPES = new Set(['CLASSIFY', 'SUMMARY', 'ARRANGE', 'MERGE']);

/** Reject a JOIN when the target already contains the source container. */
export async function validateContainerJoinCycle(params: {
  topicId: string;
  sourceContainerId: string;
  targetRefs: Array<{ kind: string; messageId?: string; relationId?: string }>;
}): Promise<GroupingValidationResult> {
  const containerMessages = await prisma.message.findMany({
    where: {
      topicId: params.topicId,
      kind: 'RELATION',
      relationType: { in: [...CONTAINER_RELATION_TYPES] },
      supersededBy: null,
    },
    select: { id: true, relationType: true },
  });
  const containerIds = new Set(containerMessages.map(message => message.id));
  if (!containerIds.has(params.sourceContainerId)) return { ok: true };

  const targetContainerIds = params.targetRefs
    .map(ref => ref.kind === 'relation' ? ref.relationId : ref.messageId)
    .filter((id): id is string => !!id && containerIds.has(id));
  if (targetContainerIds.length === 0) return { ok: true };

  const joins = await prisma.message.findMany({
    where: {
      topicId: params.topicId,
      kind: 'RELATION',
      relationType: 'JOIN',
      supersededBy: null,
      relSourceId: { not: null },
    },
    select: { relSourceId: true, targetRefs: true },
  });
  const childrenByContainer = new Map<string, string[]>();
  for (const join of joins) {
    if (!join.relSourceId || !containerIds.has(join.relSourceId)) continue;
    for (const ref of Array.isArray(join.targetRefs) ? join.targetRefs : []) {
      if (!ref || typeof ref !== 'object') continue;
      const record = ref as { kind?: unknown; messageId?: unknown; relationId?: unknown };
      const childId = record.kind === 'relation' ? record.relationId : record.messageId;
      if (typeof childId !== 'string' || !containerIds.has(childId)) continue;
      const children = childrenByContainer.get(join.relSourceId) ?? [];
      if (!children.includes(childId)) children.push(childId);
      childrenByContainer.set(join.relSourceId, children);
    }
  }

  const canReach = (start: string, goal: string): boolean => {
    const pending = [start];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.shift()!;
      if (current === goal) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(childrenByContainer.get(current) ?? []));
    }
    return false;
  };

  for (const targetId of targetContainerIds) {
    if (targetId === params.sourceContainerId || canReach(targetId, params.sourceContainerId)) {
      return {
        ok: false,
        error: `已有容器消息(${params.sourceContainerId})不能加入容器消息(${targetId})，因为两者已存在包含关系，会形成容器循环。`,
      };
    }
  }
  return { ok: true };
}

/**
 * Validate that a grouping or JOIN relation does not create forbidden
 * cross-links with messages outside the selected grouping.
 *
 * Performs:
 *   1. SUMMARY target-type check (target relations must be ARRANGE/MERGE/CLASSIFY).
 *   2. Cross-link scan: ensure no non-REFERENCE relation bridges
 *      between the selected messages and messages outside them.
 */
export async function validateGroupingTargets(
  params: GroupingValidationParams
): Promise<GroupingValidationResult> {
  const { topicId, relationType, targetRefs, targetRelationIds, foundTargetRelations } = params;

  // ── 1. SUMMARY target-type check ──────────────────────────────────
  if (relationType === 'SUMMARY' && foundTargetRelations.length > 0) {
    const allowedSummaryTargetRelTypes = new Set(['ARRANGE', 'MERGE', 'CLASSIFY']);
    for (const rel of foundTargetRelations.filter(r => targetRelationIds.includes(r.id))) {
      if (!allowedSummaryTargetRelTypes.has(rel.relationType ?? '')) {
        return { ok: false, error: SUMMARY_TARGET_TYPE_ERROR };
      }
    }
  }

  // ── 2. Cross-link BFS ─────────────────────────────────────────────
  const directTargetTextIds = [...new Set(
    targetRefs
      .filter(r => r.kind === 'message' || r.kind === 'text-fragment')
      .map(r => r.messageId!)
      .filter(Boolean)
  )];
  const groupedTargetTextIds = relationType === 'JOIN'
    ? directTargetTextIds
    : collectSelectedGroupTargetTextIds({
        targetTextIds: directTargetTextIds,
        selectedRelationIds: targetRelationIds,
        targetRelations: foundTargetRelations,
      });

  const relationMessages = await prisma.message.findMany({
    where: { topicId, kind: 'RELATION' },
    select: { id: true, relationType: true, relSourceId: true, targetRefs: true, supersededBy: true },
  });

  // Build the set of message IDs that are valid relation sources.
  const sourceIds = [...new Set(
    relationMessages
      .map(m => m.relSourceId)
      .filter((id): id is string => !!id)
  )];
  const sourceTextRows = sourceIds.length > 0
    ? await prisma.message.findMany({
        where: { topicId, kind: { not: 'RELATION' }, id: { in: sourceIds } },
        select: { id: true },
      })
    : [];
  const sourceTextIdSet = new Set(sourceTextRows.map(row => row.id));

  const selectedIds = new Set<string>([
    ...groupedTargetTextIds,
    ...targetRelationIds,
  ]);
  const relationIds = new Set(relationMessages.map(message => message.id));
  const crossLinkError =
    relationType === 'CLASSIFY' ? CLASSIFY_CROSS_LINK_ERROR
    : relationType === 'MERGE' ? MERGE_CROSS_LINK_ERROR
    : relationType === 'ARRANGE' ? ARRANGE_CROSS_LINK_ERROR
    : CLASSIFY_CROSS_LINK_ERROR;

  // A text message that is already inside an unselected MERGE container
  // cannot be classified on its own. Report the ownership conflict directly;
  // treating the MERGE as an ordinary cross-link produces a misleading error.
  if (relationType === 'CLASSIFY') {
    // Do not treat text owned by a selected container as an independently
    // selected message. Container targets are checked as opaque units.
    const selectedTextIdSet = new Set(
      targetRefs
        .filter(ref => ref.kind === 'message' || ref.kind === 'text-fragment')
        .map(ref => ref.messageId)
        .filter((id): id is string => Boolean(id))
    );
    const selectedRelationIdSet = new Set(targetRelationIds);
    const relationById = new Map(relationMessages.map(message => [message.id, message]));
    for (const merge of relationMessages.filter(message =>
      message.relationType === 'MERGE' && !selectedRelationIdSet.has(message.id)
    )) {
      const mergeTextIds = new Set<string>();
      const pendingRelationIds = extractNestedRelationIds(merge.targetRefs);
      extractTextTargetIds(merge.targetRefs).forEach(id => mergeTextIds.add(id));
      const visited = new Set<string>();
      while (pendingRelationIds.length > 0) {
        const nestedId = pendingRelationIds.shift()!;
        if (visited.has(nestedId)) continue;
        visited.add(nestedId);
        const nested = relationById.get(nestedId);
        if (!nested) continue;
        extractTextTargetIds(nested.targetRefs).forEach(id => mergeTextIds.add(id));
        extractNestedRelationIds(nested.targetRefs).forEach(id => {
          if (!visited.has(id)) pendingRelationIds.push(id);
        });
      }
      const selectedId = [...selectedTextIdSet].find(id => mergeTextIds.has(id));
      if (selectedId) {
        return {
          ok: false,
          error: `消息(${selectedId})已在归并消息(${merge.id})中，不能建立分类关系。`,
        };
      }
    }
  }

  if (relationType !== 'JOIN') {
    const containerIds = new Set(
      relationMessages
        .filter(message => message.relationType === 'ARRANGE'
          || message.relationType === 'MERGE'
          || message.relationType === 'SUMMARY')
        .map(message => message.id)
    );
    const membershipErrors: string[] = [];
    for (const join of relationMessages.filter(message =>
      message.relationType === 'JOIN'
      && !message.supersededBy
      && !!message.relSourceId
      && containerIds.has(message.relSourceId)
    )) {
      const joinedTargetIds = new Set([
        ...extractTextTargetIds(join.targetRefs),
        ...extractNestedRelationIds(join.targetRefs),
      ]);
      const blockedTargetIds = targetRefs
        .map(ref => ref.kind === 'relation' ? ref.relationId : ref.messageId)
        .filter((id): id is string => typeof id === 'string' && joinedTargetIds.has(id));
      if (blockedTargetIds.length > 0 && join.relSourceId) {
        const containerType = relationMessages.find(message => message.id === join.relSourceId)?.relationType;
        const containerTypeLabel = containerType === 'ARRANGE' ? '排列'
          : containerType === 'MERGE' ? '归并'
          : containerType === 'SUMMARY' ? '总结'
          : containerType ?? '未知';
        for (const blockedTargetId of blockedTargetIds) {
          membershipErrors.push(
            `消息(${blockedTargetId})已加入${containerTypeLabel}关系消息(${join.relSourceId})，不能作为独立目标。`
          );
        }
      }
    }
    if (membershipErrors.length > 0) {
      return { ok: false, error: `以下消息不能作为具体容器的独立目标：\n${[...new Set(membershipErrors)].join('\n')}` };
    }
  }

  for (const relMsg of relationMessages) {
    // References and grouping relations do not create semantic cross-links
    // between the text messages represented by their endpoints. Grouping
    // membership is handled by the selected-target expansion above.
    if (relMsg.relationType === 'REFERENCE'
      || relMsg.relationType === 'CLASSIFY'
      || relMsg.relationType === 'SUMMARY'
      || relMsg.relationType === 'MERGE'
      || relMsg.relationType === 'ARRANGE') continue;
    // A JOIN is a membership record, not an independent semantic link. It is
    // validated when created, but existing JOIN records must not block every
    // later classification of their member.
    if (relMsg.relationType === 'JOIN') continue;
    // When a grouping relation is itself selected, its own target edges are
    // internal to the selected grouping.
    if (targetRelationIds.includes(relMsg.id)) continue;

    const sourceId = relMsg.relSourceId && (
      sourceTextIdSet.has(relMsg.relSourceId) || relationIds.has(relMsg.relSourceId)
    ) ? relMsg.relSourceId : null;
    const refs = Array.isArray(relMsg.targetRefs)
      ? relMsg.targetRefs as Array<{ kind?: unknown; messageId?: unknown; relationId?: unknown }>
      : [];
    const targetIds = refs.flatMap(ref => {
      if (ref.kind === 'relation' && typeof ref.relationId === 'string') return [ref.relationId];
      if ((ref.kind === 'message' || ref.kind === 'text-fragment') && typeof ref.messageId === 'string') return [ref.messageId];
      return [];
    });

  if (groupedTargetTextIds.length === 0) return { ok: true };
    const endpointIds = [...new Set([...(sourceId ? [sourceId] : []), ...targetIds])];
    const hasSelectedEndpoint = endpointIds.some(id => selectedIds.has(id));
    if (!hasSelectedEndpoint) continue;
    if (endpointIds.some(id => !selectedIds.has(id))) {
      const selectedId = endpointIds.find(id => selectedIds.has(id));
      const outsideId = endpointIds.find(id => !selectedIds.has(id));
      const detail = selectedId && outsideId
        ? `消息 ${selectedId} 与消息 ${outsideId} 存在 ${relMsg.relationType ?? '未知'} 关系`
        : '选中消息与分类外消息存在非引用关系';
      return {
        ok: false,
        error: `${crossLinkError}：${detail}。`,
      };
    }
  }

  return { ok: true };
}
