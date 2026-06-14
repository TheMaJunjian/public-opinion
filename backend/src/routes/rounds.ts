import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { applyEvent } from '../lib/events';

const router = Router({ mergeParams: true });

// ── Schemas ──────────────────────────────────────────────────

const createRoundSchema = z.object({
  note: z.string().max(500).optional(),
});

const voteSchema = z.object({
  vote: z.enum(['TRUE', 'FALSE', 'UNKNOWN']),
  amount: z.number().int().min(1, '投票金额至少为 1 点'),
});

// ============================================================
// POST /api/messages/:id/rounds — 发起结算轮次
// ============================================================
router.post('/api/messages/:id/rounds', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const messageId = req.params.id as string;
    const data = createRoundSchema.parse(req.body);

    // Validate message exists and get topicId
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, topicId: true, kind: true },
    });

    if (!message) {
      res.status(404).json({ error: '消息不存在' });
      return;
    }

    // Validate user not debt-frozen
    const userBalance = await prisma.balance.findUnique({
      where: { userId: req.user!.id },
      select: { debtFrozen: true },
    });
    if (userBalance?.debtFrozen) {
      res.status(403).json({ error: '账户负债冻结，无法发起结算' });
      return;
    }

    // Create round (status=OPEN) then transition to VOTING
    const round = await applyEvent({
      type: 'ROUND_CREATED',
      actorId: req.user!.id,
      topicId: message.topicId,
      payload: { messageId, note: data.note ?? null },
    });

    // Transition to VOTING
    const updated = await prisma.settlementRound.update({
      where: { id: (round as { id: string }).id },
      data: { status: 'VOTING' },
      include: {
        createdBy: { select: { id: true, username: true } },
      },
    });

    res.status(201).json(updated);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /api/messages/:id/rounds — 查询消息的结算轮次历史
// ============================================================
router.get('/api/messages/:id/rounds', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const messageId = req.params.id as string;

    const rounds = await prisma.settlementRound.findMany({
      where: { messageId },
      orderBy: { openedAt: 'desc' },
      include: {
        createdBy: { select: { id: true, username: true } },
        votes: {
          select: {
            id: true,
            vote: true,
            amount: true,
            createdAt: true,
            user: { select: { id: true, username: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { votes: true } },
      },
    });

    res.json({ data: rounds });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /api/rounds/:id — 查询单个轮次详情
// ============================================================
router.get('/api/rounds/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const roundId = req.params.id as string;

    const round = await prisma.settlementRound.findUnique({
      where: { id: roundId },
      include: {
        createdBy: { select: { id: true, username: true } },
        votes: {
          select: {
            id: true,
            vote: true,
            amount: true,
            createdAt: true,
            user: { select: { id: true, username: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { votes: true } },
      },
    });

    if (!round) {
      res.status(404).json({ error: '结算轮次不存在' });
      return;
    }

    // Compute current weights
    const weights = await prisma.voteStake.groupBy({
      by: ['vote'],
      where: { roundId },
      _sum: { amount: true },
    });

    const weightMap: Record<string, number> = { TRUE: 0, FALSE: 0, UNKNOWN: 0 };
    for (const row of weights) {
      weightMap[row.vote] = row._sum.amount ?? 0;
    }

    res.json({ ...round, weights: weightMap });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /api/rounds/:id/votes — 投票押注
// ============================================================
router.post('/api/rounds/:id/votes', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const roundId = req.params.id as string;
    const { vote, amount } = voteSchema.parse(req.body);

    // Get round info for topicId
    const round = await prisma.settlementRound.findUnique({
      where: { id: roundId },
      select: { messageId: true },
    });
    if (!round) {
      res.status(404).json({ error: '结算轮次不存在' });
      return;
    }

    const message = await prisma.message.findUnique({
      where: { id: round.messageId },
      select: { topicId: true },
    });

    const result = await applyEvent({
      type: 'VOTE_CAST',
      actorId: req.user!.id,
      topicId: message!.topicId,
      payload: { roundId, vote, amount },
    });

    res.status(201).json({ message: '投票成功', ...(result as Record<string, unknown>) });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /api/rounds/:id/close-and-settle — 关闭并结算
// ============================================================
router.post('/api/rounds/:id/close-and-settle', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const roundId = req.params.id as string;

    // Get round info
    const round = await prisma.settlementRound.findUnique({
      where: { id: roundId },
      select: { messageId: true, createdByUserId: true, status: true },
    });
    if (!round) {
      res.status(404).json({ error: '结算轮次不存在' });
      return;
    }
    if (round.createdByUserId !== req.user!.id) {
      // Check rule: settlementPermission
      const rule = await prisma.ruleVersion.findFirst({
        where: { status: 'ACTIVE' },
        orderBy: { version: 'desc' },
        select: { parameters: true },
      });
      const permission = (rule?.parameters as Record<string, unknown> | null)?.settlementPermission ?? 'creator_only';

      if (permission === 'anyone') {
        // Anyone can settle — proceed
      } else if (permission === 'any_voter') {
        // Check if user voted in this round
        const userVoted = await prisma.voteStake.findFirst({
          where: { roundId, userId: req.user!.id },
        });
        if (!userVoted) {
          res.status(403).json({ error: '规则要求投票者才可结算，你尚未投票' });
          return;
        }
      } else {
        // creator_only (default)
        res.status(403).json({ error: '当前规则仅允许轮次发起者结算' });
        return;
      }
    }

    const message = await prisma.message.findUnique({
      where: { id: round.messageId },
      select: { topicId: true },
    });

    const result = await applyEvent({
      type: 'ROUND_SETTLED',
      actorId: req.user!.id,
      topicId: message!.topicId,
      payload: { roundId },
    });

    res.json({ message: '结算完成', ...(result as Record<string, unknown>) });
  } catch (err) {
    next(err);
  }
});

export default router;
