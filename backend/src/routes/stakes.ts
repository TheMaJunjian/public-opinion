import { Router, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middleware/auth';

const router = Router({ mergeParams: true }); // mergeParams to access :id from parent router

// GET /api/messages/:id/stakes — 查询消息押注统计
// Query params: ?settlementType=TRUTH|VALUE (optional, aggregates all if omitted)
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const messageId = req.params.id as string;
    const stype = req.query.settlementType as string | undefined;
    const stakeWhere: Record<string, unknown> = { messageId };
    if (stype === 'TRUTH' || stype === 'VALUE') {
      stakeWhere.settlementType = stype;
    }

    const [stakes, proAgg, conAgg] = await Promise.all([
      prisma.stake.findMany({
        where: stakeWhere,
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          side: true,
          amount: true,
          createdAt: true,
          roundId: true,
          settlementType: true,
          user: { select: { id: true, username: true } },
        },
      }),
      prisma.stake.aggregate({ where: { ...stakeWhere, side: 'PRO' }, _sum: { amount: true } }),
      prisma.stake.aggregate({ where: { ...stakeWhere, side: 'CON' }, _sum: { amount: true } }),
    ]);

    const proCount = proAgg._sum.amount ?? 0;
    const conCount = conAgg._sum.amount ?? 0;

    // Also fetch per-settlementType pool breakdown from BetPool
    const betPools = await prisma.betPool.findMany({
      where: { messageId },
      select: { settlementType: true, lockedPro: true, lockedCon: true },
    });
    const pools: Record<string, { lockedPro: number; lockedCon: number }> = {};
    for (const bp of betPools) {
      pools[bp.settlementType] = { lockedPro: bp.lockedPro, lockedCon: bp.lockedCon };
    }

    // Per-settlementType cumulative counts (only when no filter, for frontend display)
    let countsByType: Record<string, { pro: number; con: number }> | undefined;
    if (!stype) {
      const [truthPro, truthCon, valuePro, valueCon] = await Promise.all([
        prisma.stake.aggregate({ where: { messageId, settlementType: 'TRUTH', side: 'PRO' }, _sum: { amount: true } }),
        prisma.stake.aggregate({ where: { messageId, settlementType: 'TRUTH', side: 'CON' }, _sum: { amount: true } }),
        prisma.stake.aggregate({ where: { messageId, settlementType: 'VALUE', side: 'PRO' }, _sum: { amount: true } }),
        prisma.stake.aggregate({ where: { messageId, settlementType: 'VALUE', side: 'CON' }, _sum: { amount: true } }),
      ]);
      countsByType = {
        TRUTH: { pro: truthPro._sum.amount ?? 0, con: truthCon._sum.amount ?? 0 },
        VALUE: { pro: valuePro._sum.amount ?? 0, con: valueCon._sum.amount ?? 0 },
      };
    }

    res.json({
      messageId,
      pool: { lockedPro: proCount, lockedCon: conCount },
      pools,
      stakes,
      counts: { pro: proCount, con: conCount },
      ...(countsByType ? { countsByType } : {}),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
