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
  targetRelations: Array<{ id: string; relationType: string | null; targetRefs: unknown }>;
}): string[] {
  const selectedTextIds = new Set(params.targetTextIds);
  const relationById = new Map(
    params.targetRelations.map(rel => [rel.id, rel] as const)
  );
  const expandableRelationTypes = new Set(['CLASSIFY', 'MERGE', 'ARRANGE', 'SUMMARY']);
  const queue = params.targetRelations
    .filter(rel => expandableRelationTypes.has(rel.relationType ?? ''))
    .map(rel => rel.id);
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
  const groupedTargetTextIds = collectSelectedGroupTargetTextIds({
    targetTextIds: [...new Set(
      targetRefs
        .filter(r => r.kind === 'message' || r.kind === 'text-fragment')
        .map(r => r.messageId!)
        .filter(Boolean)
    )],
    targetRelations: foundTargetRelations,
  });

  if (groupedTargetTextIds.length === 0) return { ok: true };

  const relationMessages = await prisma.message.findMany({
    where: { topicId, kind: 'RELATION' },
    select: { id: true, relationType: true, relSourceId: true, targetRefs: true },
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

  for (const relMsg of relationMessages) {
    // REFERENCE is the only explicitly non-grouping relation.
    if (relMsg.relationType === 'REFERENCE') continue;
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
