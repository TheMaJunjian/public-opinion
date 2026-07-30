import { Router, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// GET /api/points/balance — 查询当前用户贡献点余额和账户状态
router.get('/balance', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;

    const [pointAccount, balance, mintAgg, feeEntries] = await Promise.all([
      prisma.pointAccount.findUnique({
        where: { userId },
        select: { available: true, locked: true },
      }),
      prisma.balance.findUnique({
        where: { userId },
        select: { balance: true, debtFrozen: true, totalLost: true, totalEarned: true },
      }),
      prisma.ledgerEntry.aggregate({
        where: { userId, entryType: 'MINT_INITIAL' },
        _sum: { amount: true },
      }),
      prisma.ledgerEntry.findMany({
        where: { userId, entryType: { in: ['STAKE_LOCK', 'VOTE_LOCK'] } },
        select: { amount: true, data: true },
      }),
    ]);

    if (!pointAccount || !balance) {
      res.status(404).json({ error: '账户不存在' });
      return;
    }

    const initialMinted = mintAgg._sum.amount ?? 0;
    const totalProtocolFees = feeEntries
      .filter(e => (e.data as Record<string, unknown> | null)?.fee === true)
      .reduce((sum, e) => sum + Math.abs(e.amount), 0);
    const totalLost = balance.totalLost ?? 0;
    const totalEarned = balance.totalEarned ?? 0;  // net profit (excludes own stake/vote return)

    res.json({
      points: {
        available: pointAccount.available,
        locked: pointAccount.locked,
      },
      balance: {
        amount: balance.balance,
        debtFrozen: balance.debtFrozen,
      },
      breakdown: {
        initialMinted,
        totalEarned,
        totalLost,
        totalProtocolFees,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/points/transactions — 查询当前用户贡献点流水
router.get('/transactions', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      prisma.pointTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          type: true,
          amount: true,
          balanceAfter: true,
          createdAt: true,
          data: true,
        },
      }),
      prisma.pointTransaction.count({ where: { userId } }),
    ]);

    res.json({
      data: transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
