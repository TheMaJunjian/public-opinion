import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { RELATION_TYPES } from '../lib/relationTypes';

const relationsRouter = Router({ mergeParams: true });

// ============================================================
// Validation Schemas
// ============================================================

// RELATION_TYPES is imported from lib/relationTypes.ts.
// To add a new relation type, update that file — no changes needed here.

/**
 * TargetRef - a discriminated union for what a relation points to.
 *
 * 'message'       - targets a whole text message
 * 'text-fragment' - targets a specific fragment of a text message
 * 'relation'      - targets a relation message (or a specific selectable part of it)
 *
 * Sources (relSourceId) can be any message (TEXT or RELATION kind) in this topic.
 * Targets can be text messages, fragments, OR relation messages.
 */
const targetRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    messageId: z.string().min(1, '消息 ID 不能为空'),
  }),
  z.object({
    kind: z.literal('text-fragment'),
    messageId: z.string().min(1, '消息 ID 不能为空'),
    text: z.string().min(1).max(2000),
    hash: z.string().min(1),
    contextBefore: z.string().max(200).optional(),
    contextAfter: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal('relation'),
    relationId: z.string().min(1, '关系消息 ID 不能为空'),
    part: z.enum(['label', 'decoration', 'frame', 'whole']).optional(),
  }),
]);

const createRelationSchema = z.object({
  relationType: z.enum(RELATION_TYPES, {
    errorMap: () => ({ message: `关系类型必须是以下之一: ${RELATION_TYPES.join(', ')}` }),
  }),
  // sourceMessageId is required for most relation types, but optional for
  // relation types that support source-less semantics (AGREE, DISAGREE, SUPPLEMENT,
  // CORRECT, REPLY, TAG, CLASSIFY, MERGE).
  sourceMessageId: z.string().min(1, '来源消息 ID 不能为空').optional(),
  // targetRefs schema allows empty arrays; route-level validation below enforces non-empty
  // for relation types not listed in TARGET_OPTIONAL_RELATION_TYPES (currently only CLASSIFY).
  targetRefs: z.array(targetRefSchema).max(20),
  payload: z.object({
    label: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    targetLayout: z.enum(['single-column', 'multi-column']).optional(),
  }).strict().optional(),
}).superRefine((data, ctx) => {
  if (data.relationType === 'TAG' && !(data.payload && data.payload.label)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '标注关系需要提供标签文本',
      path: ['payload', 'label'],
    });
  }
  if (data.relationType === 'CLASSIFY' && !data.payload?.title) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '分类关系需要提供话题名称',
      path: ['payload', 'title'],
    });
  }
  if (data.relationType === 'SUMMARY' && !data.payload?.title) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '总结关系需要提供总结内容标题',
      path: ['payload', 'title'],
    });
  }
});

const SOURCE_OPTIONAL_RELATION_TYPES = new Set(['AGREE', 'DISAGREE', 'SUPPLEMENT', 'CORRECT', 'REPLY', 'TAG', 'CLASSIFY', 'MERGE', 'SUMMARY']);
const TARGET_OPTIONAL_RELATION_TYPES = new Set(['CLASSIFY']);
const CLASSIFY_CROSS_LINK_ERROR = '分类目标与已分类消息存在非引用关联，无法建立分类关系';
const MERGE_CROSS_LINK_ERROR = '归并目标与已分类消息存在非引用关联，无法建立归并关系';
const SUMMARY_CROSS_LINK_ERROR = '总结目标与已分类消息存在非引用关联，无法建立总结关系';

function extractTextTargetIds(targetRefs: unknown): string[] {
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

function extractNestedRelationIds(targetRefs: unknown): string[] {
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

function collectSelectedGroupTargetTextIds(params: {
  targetTextIds: string[];
  targetRelations: Array<{ id: string; relationType: string | null; targetRefs: unknown }>;
}): string[] {
  const selectedTextIds = new Set(params.targetTextIds);
  const relationById = new Map(
    params.targetRelations.map(rel => [rel.id, rel] as const)
  );
  const expandableRelationTypes = new Set(['CLASSIFY', 'MERGE', 'SUPPLEMENT', 'SUMMARY']);
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

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

// ============================================================
// Routes
// ============================================================

// GET /api/topics/:topicId/relations
relationsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;
    const { page, limit } = paginationSchema.parse(req.query);
    const skip = (page - 1) * limit;

    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic) {
      res.status(404).json({ error: '话题不存在' });
      return;
    }

    // Relation messages are stored in the unified Message table with kind=RELATION.
    const [total, messages] = await Promise.all([
      prisma.message.count({ where: { topicId, kind: 'RELATION' } }),
      prisma.message.findMany({
        where: { topicId, kind: 'RELATION' },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: { createdBy: { select: { id: true, username: true } } },
      }),
    ]);

    // Map unified Message rows back to the Relation API shape expected by the frontend.
    const relations = messages.map(m => ({
      id: m.id,
      topicId: m.topicId,
      relationType: m.relationType!,
      sourceMessageId: m.relSourceId ?? null,
      targetRefs: m.targetRefs,
      payload: m.relationPayload ?? undefined,
      createdAt: m.createdAt,
      createdBy: m.createdBy,
    }));

    res.json({
      data: relations,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/topics/:topicId/relations
relationsRouter.post('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;
    const data = createRelationSchema.parse(req.body);

    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic) {
      res.status(404).json({ error: '话题不存在' });
      return;
    }
    if (topic.status === 'ARCHIVED') {
      res.status(403).json({ error: '该话题已归档，不允许建立新关系' });
      return;
    }

    // Relation types that require a source message (non-stance types and TAG which needs content)
    // AGREE/DISAGREE: optional (pure-stance declaration without text)
    // SUPPLEMENT: always null source — user-to-message relation; supplementary text is a target, not a source
    // CORRECT: optional (can be used to mark a relation message as needing correction without a source text)
    // REPLY: optional (can express a pure-stance reply to a relation message without source text)
    // TAG: optional (user-to-message relation; label text is stored in tagLabel instead of sourceMessageId)
    const requiresSource = !SOURCE_OPTIONAL_RELATION_TYPES.has(data.relationType);

    if (requiresSource && !data.sourceMessageId) {
      res.status(400).json({ error: '该关系类型需要提供来源消息 ID' });
      return;
    }

    if (!TARGET_OPTIONAL_RELATION_TYPES.has(data.relationType) && data.targetRefs.length === 0) {
      res.status(400).json({ error: '至少需要一个目标引用' });
      return;
    }

    // CLASSIFY, MERGE, SUMMARY, and SUPPLEMENT are user-to-message relations: no source text message.
    // For SUPPLEMENT: the supplementary text (if any) is stored as a target, not a source.
    const noSourceRelTypeNames: Record<string, string> = {
      CLASSIFY: '分类', MERGE: '归并', SUMMARY: '总结', SUPPLEMENT: '补充',
    };
    if (data.relationType in noSourceRelTypeNames && data.sourceMessageId) {
      res.status(400).json({ error: `${noSourceRelTypeNames[data.relationType]}关系不应提供来源消息 ID` });
      return;
    }
    // sourceMessageId can reference ANY message in this topic (TEXT or RELATION kind),
    // because relation messages are also messages — a single unified table lookup suffices.
    if (data.sourceMessageId) {
      const sourceMessage = await prisma.message.findFirst({
        where: { id: data.sourceMessageId, topicId },
      });
      if (!sourceMessage) {
        res.status(404).json({ error: '来源消息不存在或不属于该话题' });
        return;
      }
    }

    // Validate all target refs
    const targetMessageIds = data.targetRefs
      .filter(r => r.kind === 'message' || r.kind === 'text-fragment')
      .map(r => (r as { kind: 'message' | 'text-fragment'; messageId: string }).messageId);

    const targetRelationIds = data.targetRefs
      .filter(r => r.kind === 'relation')
      .map(r => (r as { kind: 'relation'; relationId: string }).relationId);

    // CLASSIFY supports empty targets and relation-message targets (e.g., topic-to-topic grouping).

    // Check for duplicate target IDs
    const allTargetIds = [...targetMessageIds, ...targetRelationIds];
    if (new Set(allTargetIds).size !== allTargetIds.length) {
      res.status(400).json({ error: 'targetRefs 中存在重复的目标 ID' });
      return;
    }

    // Validate target text messages exist in this topic (kind=TEXT)
    if (targetMessageIds.length > 0) {
      const uniqueMessageIds = [...new Set(targetMessageIds)];
      const foundMessages = await prisma.message.findMany({
        where: { id: { in: uniqueMessageIds }, topicId, kind: 'TEXT' },
        select: { id: true },
      });
      if (foundMessages.length !== uniqueMessageIds.length) {
        res.status(404).json({ error: '部分目标消息不存在或不属于该话题' });
        return;
      }
    }

    // Validate target relation messages exist in this topic (kind=RELATION)
    let foundTargetRelations: Array<{ id: string; relationType: string | null; targetRefs: unknown }> = [];
    if (targetRelationIds.length > 0) {
      const uniqueRelationIds = [...new Set(targetRelationIds)];
      const directTargetRelations = await prisma.message.findMany({
        where: { id: { in: uniqueRelationIds }, topicId, kind: 'RELATION' },
        select: { id: true, relationType: true, targetRefs: true },
      });
      if (directTargetRelations.length !== uniqueRelationIds.length) {
        res.status(404).json({ error: '部分目标关系消息不存在或不属于该话题' });
        return;
      }

      // Expand nested relation-message targets for grouping relations so CLASSIFY/MERGE can
      // treat SUPPLEMENT/MERGE/CLASSIFY target relations as their owned text targets.
      const relationById = new Map<string, { id: string; relationType: string | null; targetRefs: unknown }>();
      directTargetRelations.forEach(rel => relationById.set(rel.id, rel));
      const expandableRelationTypes = new Set(['CLASSIFY', 'MERGE', 'SUPPLEMENT', 'SUMMARY']);
      const queued = new Set<string>();
      const queue: string[] = [];
      const enqueue = (id: string) => {
        if (queued.has(id)) return;
        queued.add(id);
        queue.push(id);
      };
      directTargetRelations
        .filter(rel => expandableRelationTypes.has(rel.relationType ?? ''))
        .forEach(rel => enqueue(rel.id));

      while (queue.length > 0) {
        const relId = queue.shift()!;
        const rel = relationById.get(relId);
        if (!rel || !expandableRelationTypes.has(rel.relationType ?? '')) continue;
        const nestedRelationIds = extractNestedRelationIds(rel.targetRefs).filter(id => !relationById.has(id));
        if (nestedRelationIds.length === 0) continue;
        const nestedRelations = await prisma.message.findMany({
          where: { id: { in: nestedRelationIds }, topicId, kind: 'RELATION' },
          select: { id: true, relationType: true, targetRefs: true },
        });
        nestedRelations.forEach(nestedRel => {
          relationById.set(nestedRel.id, nestedRel);
          enqueue(nestedRel.id);
        });
      }

      foundTargetRelations = [...relationById.values()];
    }

    // SUMMARY targets must be text messages, SUPPLEMENT, MERGE, or CLASSIFY relation messages.
    if (data.relationType === 'SUMMARY' && foundTargetRelations.length > 0) {
      const allowedSummaryTargetRelTypes = new Set(['SUPPLEMENT', 'MERGE', 'CLASSIFY']);
      for (const rel of foundTargetRelations.filter(r => targetRelationIds.includes(r.id))) {
        if (!allowedSummaryTargetRelTypes.has(rel.relationType ?? '')) {
          res.status(400).json({ error: '总结关系的目标关系消息只能是补充、归并或分类关系消息' });
          return;
        }
      }
    }

    // CLASSIFY, MERGE, and SUMMARY targets cannot have non-reference cross-links with
    // text messages that are already owned by an existing CLASSIFY or SUMMARY relation.
    if (data.relationType === 'CLASSIFY' || data.relationType === 'MERGE' || data.relationType === 'SUMMARY') {
      const groupedTargetTextIds = collectSelectedGroupTargetTextIds({
        targetTextIds: [...new Set(
          data.targetRefs
            .filter((r): r is Extract<typeof data.targetRefs[number], { kind: 'message' | 'text-fragment' }> =>
              r.kind === 'message' || r.kind === 'text-fragment'
            )
            .map(r => r.messageId)
        )],
        targetRelations: foundTargetRelations,
      });
      if (groupedTargetTextIds.length > 0) {
        const selectedTargetTextIdSet = new Set(groupedTargetTextIds);
        const relationMessages = await prisma.message.findMany({
          where: { topicId, kind: 'RELATION' },
          select: { id: true, relationType: true, relSourceId: true, targetRefs: true },
        });

        // Build the set of text message IDs already owned by existing CLASSIFY/SUMMARY relations.
        // These are the "already classified" messages that make cross-links forbidden.
        // A single BFS processes all CLASSIFY/SUMMARY relations together to avoid redundant traversals.
        // Skip relations that are themselves targets of this merge/classify/summary — they are
        // being absorbed by the new relation, so their text messages should not count as
        // "already classified" for the cross-link check.
        const allRelById = new Map(relationMessages.map(r => [r.id, r]));
        const expandableTypes = new Set(['CLASSIFY', 'MERGE', 'SUPPLEMENT', 'SUMMARY']);
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
          // Skip relations that are being absorbed by this operation
          if (absorbedRelationIds.has(bfsId)) continue;
          const bfsRel = allRelById.get(bfsId);
          if (!bfsRel) continue;
          extractTextTargetIds(bfsRel.targetRefs).forEach(id => alreadyClassifiedTextIds.add(id));
          if (!expandableTypes.has(bfsRel.relationType ?? '')) continue;
          for (const nestedId of extractNestedRelationIds(bfsRel.targetRefs)) {
            if (!bfsVisited.has(nestedId)) bfsQueue.push(nestedId);
          }
        }

        const sourceIds = [...new Set(
          relationMessages
            .map(m => m.relSourceId)
            .filter((id): id is string => !!id)
        )];
        const sourceTextRows = sourceIds.length > 0
          ? await prisma.message.findMany({
              where: { topicId, kind: 'TEXT', id: { in: sourceIds } },
              select: { id: true },
            })
          : [];
        const sourceTextIdSet = new Set(sourceTextRows.map(row => row.id));

        const crossLinkError =
          data.relationType === 'CLASSIFY' ? CLASSIFY_CROSS_LINK_ERROR
          : data.relationType === 'MERGE' ? MERGE_CROSS_LINK_ERROR
          : SUMMARY_CROSS_LINK_ERROR;

        for (const relMsg of relationMessages) {
          if (relMsg.relationType === 'REFERENCE') continue;
          // Skip relations that are themselves direct targets of this classification
          // (e.g., when classifying a SUPPLEMENT or MERGE, its own edges should not
          // trigger cross-link errors — Bug 3 fix).
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
          // Only block if the non-selected endpoint is already owned by a CLASSIFY/SUMMARY
          // AND is NOT part of the same expanded selection (e.g., when a SUPPLEMENT bridges
          // between selected and already-classified messages, allow it — Bug 3 fix).
          if (sourceTextId !== null && !selectedTargetTextIdSet.has(sourceTextId) && alreadyClassifiedTextIds.has(sourceTextId)) {
            res.status(400).json({ error: crossLinkError });
            return;
          }
          if (targetTextIds.some(id => !selectedTargetTextIdSet.has(id) && alreadyClassifiedTextIds.has(id))) {
            res.status(400).json({ error: crossLinkError });
            return;
          }
        }
      }
    }

    const relationPayload =
      (data.relationType === 'MERGE' || data.relationType === 'SUMMARY') && !data.payload?.targetLayout
        ? { ...data.payload, targetLayout: 'multi-column' as const }
        : data.payload;

    // Create the relation as a RELATION-kind message in the unified Message table.
    const message = await prisma.message.create({
      data: {
        topicId,
        createdById: req.user!.id,
        kind: 'RELATION',
        relationType: data.relationType,
        relSourceId: data.sourceMessageId ?? null,
        targetRefs: data.targetRefs,
        relationPayload: relationPayload ?? undefined,
        content: null,
      },
      include: { createdBy: { select: { id: true, username: true } } },
    });

    // Return in the Relation API shape expected by the frontend.
    res.status(201).json({
      id: message.id,
      topicId: message.topicId,
      relationType: message.relationType!,
      sourceMessageId: message.relSourceId ?? null,
      targetRefs: message.targetRefs,
      payload: message.relationPayload ?? undefined,
      createdAt: message.createdAt,
      createdBy: message.createdBy,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/topics/:topicId/relations/:relationId
// Update a relation's targetRefs (e.g. add a new message to a classify topic).
const patchRelationSchema = z.object({
  targetRefs: z.array(targetRefSchema).max(20),
});

relationsRouter.patch('/:relationId', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;
    const relationId = req.params.relationId as string;
    const data = patchRelationSchema.parse(req.body);

    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic) {
      res.status(404).json({ error: '话题不存在' });
      return;
    }
    if (topic.status === 'ARCHIVED') {
      res.status(403).json({ error: '该话题已归档，不允许修改关系' });
      return;
    }

    const existing = await prisma.message.findFirst({
      where: { id: relationId, topicId, kind: 'RELATION' },
    });
    if (!existing) {
      res.status(404).json({ error: '关系消息不存在或不属于该话题' });
      return;
    }

    // Only CLASSIFY and SUMMARY relations support updating targets
    if (existing.relationType !== 'CLASSIFY' && existing.relationType !== 'SUMMARY') {
      res.status(400).json({ error: '仅分类和总结关系支持更新目标' });
      return;
    }

    // Validate new targets exist in this topic
    const targetMessageIds = data.targetRefs
      .filter(r => r.kind === 'message' || r.kind === 'text-fragment')
      .map(r => (r as { kind: 'message' | 'text-fragment'; messageId: string }).messageId);
    const targetRelationIds = data.targetRefs
      .filter(r => r.kind === 'relation')
      .map(r => (r as { kind: 'relation'; relationId: string }).relationId);

    if (targetMessageIds.length > 0) {
      const uniqueMessageIds = [...new Set(targetMessageIds)];
      const foundMessages = await prisma.message.findMany({
        where: { id: { in: uniqueMessageIds }, topicId, kind: 'TEXT' },
        select: { id: true },
      });
      if (foundMessages.length !== uniqueMessageIds.length) {
        res.status(404).json({ error: '部分目标消息不存在或不属于该话题' });
        return;
      }
    }
    if (targetRelationIds.length > 0) {
      const uniqueRelationIds = [...new Set(targetRelationIds)];
      const foundRelations = await prisma.message.findMany({
        where: { id: { in: uniqueRelationIds }, topicId, kind: 'RELATION' },
        select: { id: true },
      });
      if (foundRelations.length !== uniqueRelationIds.length) {
        res.status(404).json({ error: '部分目标关系消息不存在或不属于该话题' });
        return;
      }
    }

    const updated = await prisma.message.update({
      where: { id: relationId },
      data: { targetRefs: data.targetRefs },
      include: { createdBy: { select: { id: true, username: true } } },
    });

    res.json({
      id: updated.id,
      topicId: updated.topicId,
      relationType: updated.relationType!,
      sourceMessageId: updated.relSourceId ?? null,
      targetRefs: updated.targetRefs,
      payload: updated.relationPayload ?? undefined,
      createdAt: updated.createdAt,
      createdBy: updated.createdBy,
    });
  } catch (err) {
    next(err);
  }
});

export default relationsRouter;
