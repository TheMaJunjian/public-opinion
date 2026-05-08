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
  // tagLabel: optional label text for TAG relations (stored in place of a source message).
  // When provided, the TAG relation is a user-to-message relation without a source text message.
  tagLabel: z.string().max(200).optional(),
  // classifyTitle: optional topic title for CLASSIFY relations (stored in relation content).
  classifyTitle: z.string().trim().min(1).max(200).optional(),
}).superRefine((data, ctx) => {
  if (data.relationType === 'CLASSIFY' && !data.classifyTitle) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '分类关系需要提供话题名称',
      path: ['classifyTitle'],
    });
  }
});

const SOURCE_OPTIONAL_RELATION_TYPES = new Set(['AGREE', 'DISAGREE', 'SUPPLEMENT', 'CORRECT', 'REPLY', 'TAG', 'CLASSIFY', 'MERGE']);
const TARGET_OPTIONAL_RELATION_TYPES = new Set(['CLASSIFY']);
const CLASSIFY_CROSS_LINK_ERROR = '分类目标与其他消息存在非引用关联，无法建立分类关系';
const MERGE_CROSS_LINK_ERROR = '归并目标与其他消息存在非引用关联，无法建立归并关系';

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

function extractNestedClassifyRelationIds(targetRefs: unknown): string[] {
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
  const classifyRelations = new Map(
    params.targetRelations
      .filter(rel => rel.relationType === 'CLASSIFY')
      .map(rel => [rel.id, rel] as const)
  );

  // Also include text targets of MERGE relations in targetRelations
  // (when a MERGE relation is a CLASSIFY target, its text targets are part of the group).
  for (const rel of params.targetRelations) {
    if (rel.relationType === 'MERGE') {
      extractTextTargetIds(rel.targetRefs).forEach(id => selectedTextIds.add(id));
    }
  }

  const queue = Array.from(classifyRelations.keys());
  const visited = new Set<string>();

  while (queue.length > 0) {
    const relId = queue.shift()!;
    if (visited.has(relId)) continue;
    visited.add(relId);
    const rel = classifyRelations.get(relId);
    if (!rel) continue;
    extractTextTargetIds(rel.targetRefs).forEach(id => selectedTextIds.add(id));
    for (const nestedRelId of extractNestedClassifyRelationIds(rel.targetRefs)) {
      if (!visited.has(nestedRelId) && classifyRelations.has(nestedRelId)) queue.push(nestedRelId);
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
      tagLabel: m.relationType === 'TAG' ? (m.content ?? undefined) : undefined,
      classifyTitle: m.relationType === 'CLASSIFY' ? (m.content ?? undefined) : undefined,
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
    // SUPPLEMENT: optional (no-source form wraps target messages in a frame without a source text)
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

    // CLASSIFY and MERGE are user-to-message relations: no source text message.
    if (data.relationType === 'CLASSIFY' && data.sourceMessageId) {
      res.status(400).json({ error: '分类关系不应提供来源消息 ID' });
      return;
    }
    if (data.relationType === 'MERGE' && data.sourceMessageId) {
      res.status(400).json({ error: '归并关系不应提供来源消息 ID' });
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
      foundTargetRelations = await prisma.message.findMany({
        where: { id: { in: uniqueRelationIds }, topicId, kind: 'RELATION' },
        select: { id: true, relationType: true, targetRefs: true },
      });
      if (foundTargetRelations.length !== uniqueRelationIds.length) {
        res.status(404).json({ error: '部分目标关系消息不存在或不属于该话题' });
        return;
      }
    }

    // CLASSIFY targets cannot have non-reference cross-message links with non-target text messages.
    if (data.relationType === 'CLASSIFY' || data.relationType === 'MERGE') {
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

        for (const relMsg of relationMessages) {
          if (relMsg.relationType === 'REFERENCE') continue;
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
          if (sourceTextId !== null && !selectedTargetTextIdSet.has(sourceTextId)) {
            res.status(400).json({
              error: data.relationType === 'CLASSIFY' ? CLASSIFY_CROSS_LINK_ERROR : MERGE_CROSS_LINK_ERROR,
            });
            return;
          }
          if (targetTextIds.some(id => !selectedTargetTextIdSet.has(id))) {
            res.status(400).json({
              error: data.relationType === 'CLASSIFY' ? CLASSIFY_CROSS_LINK_ERROR : MERGE_CROSS_LINK_ERROR,
            });
            return;
          }
        }
      }
    }

    // Create the relation as a RELATION-kind message in the unified Message table.
    // For TAG/CLASSIFY relations, label/title is stored in the content field so it survives round-trips.
    const message = await prisma.message.create({
      data: {
        topicId,
        createdById: req.user!.id,
        kind: 'RELATION',
        relationType: data.relationType,
        relSourceId: data.sourceMessageId ?? null,
        targetRefs: data.targetRefs,
        content: data.relationType === 'TAG'
          ? (data.tagLabel ?? null)
          : data.relationType === 'CLASSIFY'
            ? (data.classifyTitle ?? null)
            : null,
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
      tagLabel: message.relationType === 'TAG' ? (message.content ?? undefined) : undefined,
      classifyTitle: message.relationType === 'CLASSIFY' ? (message.content ?? undefined) : undefined,
      createdAt: message.createdAt,
      createdBy: message.createdBy,
    });
  } catch (err) {
    next(err);
  }
});

export default relationsRouter;
