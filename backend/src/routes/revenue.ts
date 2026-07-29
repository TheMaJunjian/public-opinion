import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';


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


export default router;
