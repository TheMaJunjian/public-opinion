import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, verifySignature, AuthRequest } from '../middleware/auth';
import { writeAuditLog } from '../lib/auditLog';

const router = Router();

// GET /api/revenue/pool
router.get('/api/revenue/pool', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let pool = await prisma.revenuePool.findFirst();
    if (!pool) {
      pool = await prisma.revenuePool.create({ data: {} });
    }
    res.json(pool);
  } catch (err) {
    next(err);
  }
});

// GET /api/revenue/distributions
router.get('/api/revenue/distributions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    const pool = await prisma.revenuePool.findFirst();
    if (!pool) {
      res.json({ data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      return;
    }

    const [total, dists] = await Promise.all([
      prisma.revenueDistribution.count({ where: { revenuePoolId: pool.id } }),
      prisma.revenueDistribution.findMany({
        where: { revenuePoolId: pool.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { user: { select: { id: true, username: true } } },
      }),
    ]);

    res.json({
      data: dists,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/revenue/distribute — 手动触发收入分配
router.post('/api/revenue/distribute', requireAuth, verifySignature, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const pool = await prisma.revenuePool.findFirst();
    if (!pool || pool.balance <= 0) {
      res.status(400).json({ error: '收入池余额为零，无需分配' });
      return;
    }

    // Read distribution rules
    const rule = await prisma.ruleVersion.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { version: 'desc' },
      select: { parameters: true },
    });
    const distRules = (rule?.parameters as Record<string, unknown> | null)?.revenueDistribution as Record<string, number> | undefined;
    const contributorShare = distRules?.contributorShare ?? 0.5;
    const totalBalance = pool.balance;
    const contributorAmount = Math.floor(totalBalance * contributorShare);
    const retainedAmount = totalBalance - contributorAmount;

    if (contributorAmount <= 0) {
      res.status(400).json({ error: '分配给用户的金额为零' });
      return;
    }

    // Get all users with positive balance for proportional distribution
    const balances = await prisma.balance.findMany({
      where: { balance: { gt: 0 } },
      select: { userId: true, balance: true },
    });
    const totalUserBalance = balances.reduce((s, b) => s + b.balance, 0);

    if (totalUserBalance <= 0 || balances.length === 0) {
      res.status(400).json({ error: '没有可分配的用户' });
      return;
    }

    const now = new Date();
    const distOps: Array<{ userId: string; amount: number; balanceAfter: number }> = [];
    const distributionRecords: Array<{ revenuePoolId: string; userId: string; amount: number }> = [];

    for (const b of balances) {
      const share = Math.floor((b.balance / totalUserBalance) * contributorAmount);
      if (share <= 0) continue;

      const currentBal = b.balance;
      const newBal = currentBal + share;

      distOps.push({ userId: b.userId, amount: share, balanceAfter: newBal });
      distributionRecords.push({
        revenuePoolId: pool.id,
        userId: b.userId,
        amount: share,
      });
    }

    // Distribute dust (rounding leftovers) to first user
    const totalDistributed = distOps.reduce((s, d) => s + d.amount, 0);
    const dust = contributorAmount - totalDistributed;
    if (dust > 0 && distOps.length > 0) {
      distOps[0].amount += dust;
      distOps[0].balanceAfter += dust;
      distributionRecords[0].amount += dust;
    }

    // Atomic write
    await prisma.$transaction([
      // Update each user's balance
      ...distOps.map(d =>
        prisma.balance.update({
          where: { userId: d.userId },
          data: { balance: { increment: d.amount } },
        }),
      ),
      // Update point accounts
      ...distOps.map(d =>
        prisma.pointAccount.update({
          where: { userId: d.userId },
          data: { available: { increment: d.amount } },
        }),
      ),
      // Ledger entries
      ...distOps.map(d =>
        prisma.ledgerEntry.create({
          data: {
            userId: d.userId,
            entryType: 'REVENUE_EARNED',
            amount: d.amount,
            balanceAfter: d.balanceAfter,
            data: { source: 'REVENUE_DISTRIBUTION', totalPool: totalBalance, contributorAmount, totalDistributed: contributorAmount },
          },
        }),
      ),
      // Revenue distributions
      ...distributionRecords.map(dr =>
        prisma.revenueDistribution.create({
          data: { revenuePoolId: pool.id, userId: dr.userId, amount: dr.amount },
        }),
      ),
      // Update pool: reduce balance, increase distributed
      prisma.revenuePool.update({
        where: { id: pool.id },
        data: {
          balance: retainedAmount,
          totalDistributed: { increment: contributorAmount },
        },
      }),
    ]);

    // Audit log
    await writeAuditLog({
      actorId: req.user!.id,
      action: 'REVENUE_DISTRIBUTED',
      entityType: 'RevenuePool',
      entityId: pool.id,
      summary: `收入分配：${contributorAmount} 点分给 ${distOps.length} 位用户`,
      details: {
        totalPool: totalBalance,
        contributorAmount,
        retainedAmount,
        recipientCount: distOps.length,
        contributorShare,
      },
    });

    res.json({
      message: '分配完成',
      contributorAmount,
      retainedAmount,
      recipientCount: distOps.length,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
