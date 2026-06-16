import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { applyEvent } from '../lib/events';

const router = Router({ mergeParams: true }); // mergeParams to access :id from parent router

const stakeSchema = z.object({
  side: z.enum(['PRO', 'CON']),
  amount: z.number().int().min(1, '最小押注额为 1 点'),
});

// POST /api/messages/:id/stakes — 对消息押注 PRO 或 CON
router.post('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const messageId = req.params.id as string;
    const userId = req.user!.id;
    const { side, amount } = stakeSchema.parse(req.body);

    // Verify message exists and is TEXT type (stakes only on TEXT messages)
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, topicId: true, kind: true },
    });

    if (!message) {
      res.status(404).json({ error: '消息不存在' });
      return;
    }

    // Check rule: minimum stake amount
    const rule = await prisma.ruleVersion.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { version: 'desc' },
      select: { parameters: true },
    });
    const minStake = (rule?.parameters as Record<string, unknown> | null)?.minStake ?? 1;
    if (amount < Number(minStake)) {
      res.status(400).json({ error: `最小押注额为 ${minStake} 点` });
      return;
    }

    const result = await applyEvent({
      type: 'STAKE_PLACED',
      actorId: userId,
      topicId: message.topicId,
      payload: { messageId, side, amount },
    });

    res.status(201).json({ message: '押注成功', ...(result as Record<string, unknown>) });
  } catch (err) {
    next(err);
  }
});

// GET /api/messages/:id/stakes — 查询消息押注统计
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const messageId = req.params.id as string;

    const [betPool, stakes, proAgg, conAgg, trueVoteAgg, falseVoteAgg] = await Promise.all([
      prisma.betPool.findUnique({
        where: { messageId },
        select: { lockedPro: true, lockedCon: true },
      }),
      prisma.stake.findMany({
        where: { messageId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          side: true,
          amount: true,
          createdAt: true,
          user: { select: { id: true, username: true } },
        },
      }),
      prisma.stake.aggregate({ where: { messageId, side: 'PRO' }, _sum: { amount: true } }),
      prisma.stake.aggregate({ where: { messageId, side: 'CON' }, _sum: { amount: true } }),
      // VoteStakes also count toward PRO/CON support (TRUE→PRO, FALSE→CON)
      prisma.voteStake.aggregate({ where: { round: { messageId }, vote: 'TRUE' }, _sum: { amount: true } }),
      prisma.voteStake.aggregate({ where: { round: { messageId }, vote: 'FALSE' }, _sum: { amount: true } }),
    ]);

    res.json({
      messageId,
      pool: betPool ?? { lockedPro: 0, lockedCon: 0 },
      stakes,
      counts: {
        pro: (proAgg._sum.amount ?? 0) + (trueVoteAgg._sum.amount ?? 0),
        con: (conAgg._sum.amount ?? 0) + (falseVoteAgg._sum.amount ?? 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
