/**
 * crossLinkValidator.ts — Cross-link validation for grouping relations.
 *
 * Extracted from routes/relations.ts to keep route handlers lean.
 *
 * Validates that CLASSIFY / MERGE / SUMMARY relations do not create
 * cross-links with text messages already owned by existing CLASSIFY or
 * SUMMARY relations — preventing a text message from belonging to
 * multiple non-overlapping classification scopes.
 */

import { prisma } from './prisma';

// ============================================================
// Error messages (exported for test assertions)
// ============================================================

export const CLASSIFY_CROSS_LINK_ERROR = '分类目标与其他文本消息存在非引用关联，无法建立分类关系';
export const MERGE_CROSS_LINK_ERROR = '归并目标与其他文本消息存在非引用关联，无法建立归并关系';
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
  relationType: 'CLASSIFY' | 'MERGE' | 'SUMMARY';
  targetRefs: Array<{ kind: string; messageId?: string; relationId?: string }>;
  targetRelationIds: string[];
  foundTargetRelations: Array<{ id: string; relationType: string | null; targetRefs: unknown }>;
}

export interface GroupingValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate that a CLASSIFY / MERGE / SUMMARY relation does not create
 * forbidden cross-links with already-classified messages.
 *
 * Performs:
 *   1. SUMMARY target-type check (target relations must be ARRANGE/MERGE/CLASSIFY).
 *   2. Cross-link BFS: ensure no non-REFERENCE/non-CORRECT relation bridges
 *      between the new grouping's text messages and text messages already
 *      owned by an existing CLASSIFY or SUMMARY.
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

  const selectedTargetTextIdSet = new Set(groupedTargetTextIds);
  console.log('[CrossLink] Checking', JSON.stringify({
    relationType,
    selectedTextIds: groupedTargetTextIds.slice(0, 10),
    targetRelationIds: targetRelationIds.slice(0, 5),
  }));
  const relationMessages = await prisma.message.findMany({
    where: { topicId, kind: 'RELATION' },
    select: { id: true, relationType: true, relSourceId: true, targetRefs: true },
  });

  // Build the set of text message IDs already owned by existing CLASSIFY/SUMMARY relations.
  // A single BFS processes all CLASSIFY/SUMMARY relations together to avoid redundant traversals.
  // Skip relations that are themselves targets of this operation — they are being absorbed,
  // so their text messages should not count as "already classified".
  const allRelById = new Map(relationMessages.map(r => [r.id, r]));
  const expandableTypes = new Set(['CLASSIFY', 'MERGE', 'ARRANGE', 'SUMMARY']);
  const absorbedRelationIds = new Set(foundTargetRelations.map(r => r.id));
  const alreadyClassifiedTextIds = new Set<string>();
  const bfsQueue: string[] = [];
  const bfsVisited = new Set<string>();

  for (const rel of relationMessages) {
    if ((rel.relationType === 'CLASSIFY' || rel.relationType === 'SUMMARY') && !bfsVisited.has(rel.id)) {
      bfsQueue.push(rel.id);
    }
  }

  while (bfsQueue.length > 0) {
    const bfsId = bfsQueue.shift()!;
    if (bfsVisited.has(bfsId)) continue;
    bfsVisited.add(bfsId);
    if (absorbedRelationIds.has(bfsId)) continue;
    const bfsRel = allRelById.get(bfsId);
    if (!bfsRel) continue;
    extractTextTargetIds(bfsRel.targetRefs).forEach(id => alreadyClassifiedTextIds.add(id));
    if (!expandableTypes.has(bfsRel.relationType ?? '')) continue;
    for (const nestedId of extractNestedRelationIds(bfsRel.targetRefs)) {
      if (!bfsVisited.has(nestedId)) bfsQueue.push(nestedId);
    }
  }

  // Build the set of text message IDs that are valid relation sources.
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

  const crossLinkError =
    relationType === 'CLASSIFY' ? CLASSIFY_CROSS_LINK_ERROR
    : relationType === 'MERGE' ? MERGE_CROSS_LINK_ERROR
    : SUMMARY_CROSS_LINK_ERROR;

  for (const relMsg of relationMessages) {
    // REFERENCE (citation) does not imply semantic grouping.
    // CORRECT edges are already handled by expandTextIdsWithCorrections
    // and should not trigger cross-link blocks.
    // CLASSIFY / SUMMARY / MERGE are grouping relations — a cross-link through
    // them means reclassification (moving messages between groups), not a violation.
    if (relMsg.relationType === 'REFERENCE' || relMsg.relationType === 'CORRECT'
        || relMsg.relationType === 'CLASSIFY' || relMsg.relationType === 'SUMMARY'
        || relMsg.relationType === 'MERGE') continue;
    // Relations that are themselves direct targets of this classification
    // (e.g., when classifying a ARRANGE or MERGE, its own edges should not
    // trigger cross-link errors).
    if (targetRelationIds.includes(relMsg.id)) continue;

    const sourceTextId =
      relMsg.relSourceId && sourceTextIdSet.has(relMsg.relSourceId)
        ? relMsg.relSourceId
        : null;

    const refs = Array.isArray(relMsg.targetRefs)
      ? relMsg.targetRefs as Array<{ kind?: unknown; messageId?: unknown }>
      : [];

    const targetTextIds = [...new Set(
      refs
        .filter(ref =>
          (ref.kind === 'message' || ref.kind === 'text-fragment') &&
          typeof ref.messageId === 'string'
        )
        .map(ref => ref.messageId as string)
    )];

    const hasSelectedEndpoint =
      (sourceTextId !== null && selectedTargetTextIdSet.has(sourceTextId)) ||
      targetTextIds.some(id => selectedTargetTextIdSet.has(id));

    if (!hasSelectedEndpoint) continue;

    // Block if the non-selected endpoint is already owned by a CLASSIFY/SUMMARY
    // AND is NOT part of the same expanded selection.
    if (sourceTextId !== null && !selectedTargetTextIdSet.has(sourceTextId) && alreadyClassifiedTextIds.has(sourceTextId)) {
      console.log('[CrossLink] BLOCKED', JSON.stringify({
        reason: 'source-endpoint-classified',
        relationType: relMsg.relationType,
        relationId: relMsg.id,
        sourceTextId,
        selectedSet: [...selectedTargetTextIdSet].slice(0, 10),
        classifiedSet: [...alreadyClassifiedTextIds].slice(0, 10),
      }));
      return { ok: false, error: crossLinkError };
    }
    if (targetTextIds.some(id => !selectedTargetTextIdSet.has(id) && alreadyClassifiedTextIds.has(id))) {
      const offender = targetTextIds.find(id => !selectedTargetTextIdSet.has(id) && alreadyClassifiedTextIds.has(id));
      console.log('[CrossLink] BLOCKED', JSON.stringify({
        reason: 'target-endpoint-classified',
        relationType: relMsg.relationType,
        relationId: relMsg.id,
        offenderTargetId: offender,
        targetTextIds,
        selectedSet: [...selectedTargetTextIdSet].slice(0, 10),
        classifiedSet: [...alreadyClassifiedTextIds].slice(0, 10),
      }));
      return { ok: false, error: crossLinkError };
    }
  }

  console.log('[CrossLink] PASS', JSON.stringify({ classifiedCount: alreadyClassifiedTextIds.size }));
  return { ok: true };
}
