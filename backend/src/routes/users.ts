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

    const topicIds = [...new Set(messages.map(message => message.topicId))];
    const allTopicMessages = topicIds.length > 0
      ? await prisma.message.findMany({
          where: { topicId: { in: topicIds }, supersededBy: null },
          orderBy: { createdAt: 'asc' },
          include: { createdBy: { select: { id: true, username: true } } },
        })
      : [];
    const messageById = new Map(allTopicMessages.map(message => [message.id, message]));
    const relationDependencies = allTopicMessages
      .filter(message => message.kind === 'RELATION')
      .map(relation => {
        const targetIds = Array.isArray(relation.targetRefs)
          ? relation.targetRefs.flatMap(ref => {
              if (!ref || typeof ref !== 'object') return [];
              const value = ref as { kind?: string; messageId?: unknown; relationId?: unknown };
              if ((value.kind === 'message' || value.kind === 'text-fragment') && typeof value.messageId === 'string') return [value.messageId];
              if (value.kind === 'relation' && typeof value.relationId === 'string') return [value.relationId];
              return [];
            })
          : [];
        return { relation, dependencyIds: new Set([relation.relSourceId, ...targetIds].filter((id): id is string => Boolean(id))) };
      });
    const includedIds = new Set(messages.map(message => message.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const { relation, dependencyIds } of relationDependencies) {
        if ([...dependencyIds].some(id => includedIds.has(id))) {
          if (!includedIds.has(relation.id)) {
            includedIds.add(relation.id);
            changed = true;
          }
          for (const dependencyId of dependencyIds) {
            if (!includedIds.has(dependencyId) && messageById.has(dependencyId)) {
              includedIds.add(dependencyId);
              changed = true;
            }
          }
        }
      }
    }
    const context = allTopicMessages.filter(message => includedIds.has(message.id) && !messages.some(ownerMessage => ownerMessage.id === message.id));
    res.json({ data: messages, context, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
});

export default router;
