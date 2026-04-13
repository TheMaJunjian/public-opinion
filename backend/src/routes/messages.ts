import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createHash } from 'crypto';
import { prisma } from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';

const messagesRouter = Router({ mergeParams: true });

const createMessageSchema = z.object({
  contentType: z.enum(['TEXT', 'MARKDOWN']).optional().default('TEXT'),
  content: z.string().min(1, '内容不能为空').max(20000, '内容最多 20000 个字符'),
  quoteSourceId: z.string().optional(),
  quotedText: z.string().max(2000, '引用文本最多 2000 个字符').optional(),
  quoteContextBefore: z.string().max(200, '前置上下文最多 200 个字符').optional(),
  quoteContextAfter: z.string().max(200, '后置上下文最多 200 个字符').optional(),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

// GET /api/topics/:topicId/messages
messagesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;
    const { page, limit } = paginationSchema.parse(req.query);
    const skip = (page - 1) * limit;

    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic) {
      res.status(404).json({ error: '话题不存在' });
      return;
    }

    const [total, messages] = await Promise.all([
      prisma.message.count({ where: { topicId } }),
      prisma.message.findMany({
        where: { topicId },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: { createdBy: { select: { id: true, username: true } } },
      }),
    ]);

    res.json({
      data: messages,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/topics/:topicId/messages
messagesRouter.post('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;
    const data = createMessageSchema.parse(req.body);

    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic) {
      res.status(404).json({ error: '话题不存在' });
      return;
    }
    if (topic.status === 'ARCHIVED') {
      res.status(403).json({ error: '该话题已归档，不允许发布新消息' });
      return;
    }

    let quotedTextHash: string | undefined;
    if (data.quotedText) {
      quotedTextHash = createHash('sha256').update(data.quotedText).digest('hex');
    }

    const message = await prisma.message.create({
      data: {
        topicId,
        createdById: req.user!.id,
        contentType: data.contentType,
        content: data.content,
        quoteSourceId: data.quoteSourceId,
        quotedText: data.quotedText,
        quotedTextHash,
        quoteContextBefore: data.quoteContextBefore,
        quoteContextAfter: data.quoteContextAfter,
      },
      include: { createdBy: { select: { id: true, username: true } } },
    });

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

export default messagesRouter;
