import { Router, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middleware/auth';

const router = Router({ mergeParams: true }); // mergeParams to access :id from parent router

// GET /api/messages/:id/stakes — 查询消息押注统计
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const messageId = req.params.id as string;

    const [stakes, proAgg, conAgg] = await Promise.all([
      prisma.stake.findMany({
        where: { messageId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          side: true,
          amount: true,
          createdAt: true,
          roundId: true,
          user: { select: { id: true, username: true } },
        },
      }),
      prisma.stake.aggregate({ where: { messageId, side: 'PRO' }, _sum: { amount: true } }),
      prisma.stake.aggregate({ where: { messageId, side: 'CON' }, _sum: { amount: true } }),
    ]);

    const proCount = proAgg._sum.amount ?? 0;
    const conCount = conAgg._sum.amount ?? 0;
    res.json({
      messageId,
      pool: { lockedPro: proCount, lockedCon: conCount },
      stakes,
      counts: { pro: proCount, con: conCount },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
