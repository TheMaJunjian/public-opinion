import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';

const router = Router();

router.get('/api/users/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id as string },
      select: { id: true, username: true, createdAt: true },
    });
    if (!user) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    res.json(user);
  } catch (err) {
    next(err);
  }
});

router.get('/api/users/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.id as string;
    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const where: Prisma.MessageWhereInput = { createdById: userId, kind: { in: ['TEXT', 'GOVERNANCE', 'CODE', 'OPERATIONS', 'ROUND', 'ROUND_RESULT'] } };
    const [total, messages] = await Promise.all([
      prisma.message.count({ where }),
      prisma.message.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { createdBy: { select: { id: true, username: true } } },
      }),
    ]);
    res.json({ data: messages, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
});

export default router;
