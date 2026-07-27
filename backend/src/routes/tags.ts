import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';

const router = Router({ mergeParams: true });

/**
 * GET /api/topics/:topicId/tag-counts
 *
 * Returns per-message tag counts grouped by subType, for clean-view folding.
 * Only counts RECOMMEND / ARCHIVE / TAG relations (non-superseded).
 */
router.get('/api/topics/:topicId/tag-counts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;

    const topic = await prisma.topic.findUnique({ where: { id: topicId }, select: { id: true } });
    if (!topic) {
      res.status(404).json({ error: '议题不存在' });
      return;
    }

    // Fetch all tag-style relations in this topic
    const tagRels = await prisma.message.findMany({
      where: {
        topicId,
        kind: 'RELATION',
        relationType: { in: ['RECOMMEND', 'ARCHIVE', 'TAG'] },
        supersededBy: null,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        relationType: true,
        relationPayload: true,
        targetRefs: true,
      },
    });

    // Aggregate: messageId → { subType → count, recommend → total, archive → total }
    const counts: Record<string, Record<string, number>> = {};

    for (const rel of tagRels) {
      const refs = rel.targetRefs as Array<{ messageId?: string }> | undefined;
      if (!refs) continue;
      const payload = rel.relationPayload as Record<string, unknown> | null;
      const subType = (payload?.subType as string) || null;
      const relType = rel.relationType ?? 'TAG';

      for (const ref of refs) {
        const targetId = ref.messageId;
        if (!targetId) continue;

        if (!counts[targetId]) {
          counts[targetId] = {};
        }

        // Increment subType count (SPAM / OFFTOPIC / LOWVALUE / IMPORTANT / CUSTOM)
        if (subType) {
          counts[targetId][subType] = (counts[targetId][subType] ?? 0) + 1;
        }

        // Increment relationType total (recommend / archive / tag)
        const relTypeKey = relType.toLowerCase();
        counts[targetId][relTypeKey] = (counts[targetId][relTypeKey] ?? 0) + 1;
      }
    }

    res.json({ topicId, counts });
  } catch (err) {
    next(err);
  }
});

export default router;
