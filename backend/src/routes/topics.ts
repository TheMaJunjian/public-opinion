import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

const createTopicSchema = z.object({
  title: z.string().min(1, '标题不能为空').max(80, '标题最多 80 个字符'),
  body: z.string().max(5000, '正文最多 5000 个字符').optional(),
});

const updateTopicSchema = z.object({
  status: z.enum(['OPEN', 'ARCHIVED']),
});

const listTopicsSchema = z.object({
  query: z.string().optional(),
  sort: z.enum(['createdAt', 'updatedAt']).optional().default('createdAt'),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

// GET /api/topics
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { query, sort, page, limit } = listTopicsSchema.parse(req.query);
    const skip = (page - 1) * limit;

    const where = query
      ? {
          OR: [
            { title: { contains: query, mode: 'insensitive' as const } },
            { body: { contains: query, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [total, topics] = await Promise.all([
      prisma.topic.count({ where }),
      prisma.topic.findMany({
        where,
        orderBy: { [sort]: 'desc' },
        skip,
        take: limit,
        include: {
          createdBy: { select: { id: true, username: true } },
          _count: { select: { messages: true } },
        },
      }),
    ]);

    res.json({
      data: topics,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/topics
router.post('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { title, body } = createTopicSchema.parse(req.body);
    const topic = await prisma.topic.create({
      data: { title, body, createdById: req.user!.id },
      include: { createdBy: { select: { id: true, username: true } } },
    });
    res.status(201).json(topic);
  } catch (err) {
    next(err);
  }
});

// GET /api/topics/:topicId
router.get('/:topicId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;
    const topic = await prisma.topic.findUnique({
      where: { id: topicId },
      include: {
        createdBy: { select: { id: true, username: true } },
        _count: { select: { messages: true, relations: true } },
      },
    });

    if (!topic) {
      res.status(404).json({ error: '话题不存在' });
      return;
    }

    res.json(topic);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/topics/:topicId
router.patch('/:topicId', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;
    const { status } = updateTopicSchema.parse(req.body);
    const existing = await prisma.topic.findUnique({ where: { id: topicId } });

    if (!existing) {
      res.status(404).json({ error: '话题不存在' });
      return;
    }

    if (existing.createdById !== req.user!.id) {
      res.status(403).json({ error: '无权限修改此话题' });
      return;
    }

    const topic = await prisma.topic.update({
      where: { id: topicId },
      data: { status },
      include: { createdBy: { select: { id: true, username: true } } },
    });

    res.json(topic);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/topics/:topicId
router.delete('/:topicId', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;
    const existing = await prisma.topic.findUnique({ where: { id: topicId } });

    if (!existing) {
      res.status(404).json({ error: '话题不存在' });
      return;
    }

    if (existing.createdById !== req.user!.id) {
      res.status(403).json({ error: '无权限删除此话题' });
      return;
    }

    await prisma.$transaction([
      prisma.relation.deleteMany({ where: { topicId } }),
      prisma.message.deleteMany({ where: { topicId } }),
      prisma.topic.delete({ where: { id: topicId } }),
    ]);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
