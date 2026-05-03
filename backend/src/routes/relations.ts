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
 * Sources (sourceMessageId) must always be text messages.
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
  sourceMessageId: z.string().min(1, '来源消息 ID 不能为空'),
  targetRefs: z.array(targetRefSchema).min(1, '至少需要一个目标引用').max(20),
});

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

    const [total, relations] = await Promise.all([
      prisma.relation.count({ where: { topicId } }),
      prisma.relation.findMany({
        where: { topicId },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: { createdBy: { select: { id: true, username: true } } },
      }),
    ]);

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

    // sourceMessageId must reference a text message in this topic
    const sourceMessage = await prisma.message.findFirst({
      where: { id: data.sourceMessageId, topicId },
    });
    if (!sourceMessage) {
      res.status(404).json({ error: '来源消息不存在或不属于该话题' });
      return;
    }

    // Validate all target refs
    const targetMessageIds = data.targetRefs
      .filter(r => r.kind === 'message' || r.kind === 'text-fragment')
      .map(r => (r as { kind: 'message' | 'text-fragment'; messageId: string }).messageId);

    const targetRelationIds = data.targetRefs
      .filter(r => r.kind === 'relation')
      .map(r => (r as { kind: 'relation'; relationId: string }).relationId);

    // Check for duplicate target IDs
    const allTargetIds = [...targetMessageIds, ...targetRelationIds];
    if (new Set(allTargetIds).size !== allTargetIds.length) {
      res.status(400).json({ error: 'targetRefs 中存在重复的目标 ID' });
      return;
    }

    // Validate target messages exist in this topic
    if (targetMessageIds.length > 0) {
      const uniqueMessageIds = [...new Set(targetMessageIds)];
      const foundMessages = await prisma.message.findMany({
        where: { id: { in: uniqueMessageIds }, topicId },
        select: { id: true },
      });
      if (foundMessages.length !== uniqueMessageIds.length) {
        res.status(404).json({ error: '部分目标消息不存在或不属于该话题' });
        return;
      }
    }

    // Validate target relations exist in this topic
    if (targetRelationIds.length > 0) {
      const uniqueRelationIds = [...new Set(targetRelationIds)];
      const foundRelations = await prisma.relation.findMany({
        where: { id: { in: uniqueRelationIds }, topicId },
        select: { id: true },
      });
      if (foundRelations.length !== uniqueRelationIds.length) {
        res.status(404).json({ error: '部分目标关系消息不存在或不属于该话题' });
        return;
      }
    }

    const relation = await prisma.relation.create({
      data: {
        topicId,
        createdById: req.user!.id,
        relationType: data.relationType,
        sourceMessageId: data.sourceMessageId,
        targetRefs: data.targetRefs,
      },
      include: { createdBy: { select: { id: true, username: true } } },
    });

    res.status(201).json(relation);
  } catch (err) {
    next(err);
  }
});

export default relationsRouter;
