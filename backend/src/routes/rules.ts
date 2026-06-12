import { Router, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

// GET /api/rules/current — 查询当前生效的规则版本
router.get('/current', async (_req, res: Response, next: NextFunction) => {
  try {
    const rule = await prisma.ruleVersion.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        status: true,
        description: true,
        parameters: true,
        createdAt: true,
      },
    });

    if (!rule) {
      res.status(404).json({ error: '没有生效的规则版本' });
      return;
    }

    res.json(rule);
  } catch (err) {
    next(err);
  }
});

export default router;
