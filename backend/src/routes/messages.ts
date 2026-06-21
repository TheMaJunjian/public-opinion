import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createHash } from 'crypto';
import { prisma } from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { applyEvent } from '../lib/events';

const messagesRouter = Router({ mergeParams: true });

const createMessageSchema = z.object({
  kind: z.enum(['TEXT', 'GOVERNANCE', 'CODE']).optional().default('TEXT'),
  contentType: z.enum(['TEXT', 'MARKDOWN']).optional().default('TEXT'),
  content: z.string().min(1, '内容不能为空').max(20000, '内容最多 20000 个字符'),
  quoteSourceId: z.string().optional(),
  quotedText: z.string().max(2000, '引用文本最多 2000 个字符').optional(),
  quoteContextBefore: z.string().max(200, '前置上下文最多 200 个字符').optional(),
  quoteContextAfter: z.string().max(200, '后置上下文最多 200 个字符').optional(),
  stakeAmount: z.number().int().min(1).optional(), // Phase 2: inline stake amount
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(20),
});

// GET /api/topics/:topicId/messages
messagesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;
    const { page, limit } = paginationSchema.parse(req.query);
    const skip = (page - 1) * limit;

    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic) {
      res.status(404).json({ error: '分类不存在' });
      return;
    }

    const [total, messages] = await Promise.all([
      prisma.message.count({ where: { topicId, kind: { in: ['TEXT', 'GOVERNANCE', 'CODE', 'ROUND', 'ROUND_RESULT'] } } }),
      prisma.message.findMany({
        where: { topicId, kind: { in: ['TEXT', 'GOVERNANCE', 'CODE', 'ROUND', 'ROUND_RESULT'] } },
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
      res.status(404).json({ error: '分类不存在' });
      return;
    }
    if (topic.status === 'ARCHIVED') {
      res.status(403).json({ error: '该分类已归档，不允许发布新消息' });
      return;
    }

    let quotedTextHash: string | undefined;
    if (data.quotedText) {
      quotedTextHash = createHash('sha256').update(data.quotedText).digest('hex');
    }

    const message = await applyEvent({
      type: 'MESSAGE_CREATED',
      actorId: req.user!.id,
      topicId,
      payload: {
        kind: data.kind,
        contentType: data.contentType,
        content: data.content,
        quoteSourceId: data.quoteSourceId ?? null,
        quotedText: data.quotedText ?? null,
        quotedTextHash: quotedTextHash ?? null,
        quoteContextBefore: data.quoteContextBefore ?? null,
        quoteContextAfter: data.quoteContextAfter ?? null,
        stakeAmount: data.stakeAmount,
      },
    });

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

export default messagesRouter;
