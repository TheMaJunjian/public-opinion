import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';

const relationsRouter = Router({ mergeParams: true });

const targetRefSchema = z.object({
  targetMessageId: z.string().min(1, '目标消息 ID 不能为空'),
  targetSelectedText: z.string().max(2000).optional(),
  targetSelectedTextHash: z.string().optional(),
});

const createRelationSchema = z.object({
  relationType: z.enum(['QUOTE', 'REPLY', 'SUPPORT', 'OPPOSE', 'CORRECT', 'LINK', 'UNLINK']),
  sourceMessageId: z.string().min(1, '来源消息 ID 不能为空'),
  targetRefs: z.array(targetRefSchema).min(1, '至少需要一个目标引用'),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

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

    const sourceMessage = await prisma.message.findFirst({
      where: { id: data.sourceMessageId, topicId },
    });
    if (!sourceMessage) {
      res.status(404).json({ error: '来源消息不存在或不属于该话题' });
      return;
    }

    const targetIds = data.targetRefs.map((r) => r.targetMessageId);
    // 检查目标消息 ID 是否有重复
    const uniqueTargetIds = [...new Set(targetIds)];
    if (uniqueTargetIds.length !== targetIds.length) {
      res.status(400).json({ error: 'targetRefs 中存在重复的目标消息 ID' });
      return;
    }
    const targetMessages = await prisma.message.findMany({
      where: { id: { in: uniqueTargetIds }, topicId },
      select: { id: true },
    });
    if (targetMessages.length !== uniqueTargetIds.length) {
      res.status(404).json({ error: '部分目标消息不存在或不属于该话题' });
      return;
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
