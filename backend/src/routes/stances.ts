import { Router, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

/**
 * GET /api/users/:id/stances — 查询用户的表态历史
 * 返回用户在系统中的所有立场表态：AGREE/DISAGREE 关系、投票、押注，
 * 以及每条表态引用的证据。
 *
 * Query params:
 *   page  — 分页（默认 1）
 *   limit — 每页条数（默认 20，最大 50）
 *   topicId — 可选，筛选指定话题
 */
router.get('/api/users/:id/stances', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const targetUserId = req.params.id as string;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;
    const topicId = req.query.topicId as string | undefined;

    // ── 1. AGREE/DISAGREE 关系表态 ──
    const relationFilter: Record<string, unknown> = {
      createdById: targetUserId,
      kind: 'RELATION',
      relationType: { in: ['AGREE', 'DISAGREE'] },
    };
    if (topicId) relationFilter.topicId = topicId;

    const stanceRelations = await prisma.message.findMany({
      where: relationFilter,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        topicId: true,
        relationType: true,
        relationPayload: true,
        targetRefs: true,
        createdAt: true,
        topic: { select: { id: true, title: true } },
      },
    });

    // ── 1b. REFERENCE(证据) 关系（该用户发出的证据引用）──
    // 证据引用复用 REFERENCE 关系 + payload.label = "evidence"
    const evidenceFilter: Record<string, unknown> = {
      createdById: targetUserId,
      kind: 'RELATION',
      relationType: 'REFERENCE',
    };
    if (topicId) evidenceFilter.topicId = topicId;

    const evidenceRefs = await prisma.message.findMany({
      where: evidenceFilter,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        topicId: true,
        relationPayload: true,
        targetRefs: true,
        createdAt: true,
        topic: { select: { id: true, title: true } },
      },
    });

    // ── 2. 投票表态（AGREE/DISAGREE 关系消息，relationPayload.vote = true）──
    const voteFilter: Record<string, unknown> = {
      createdById: targetUserId,
      kind: 'RELATION',
      relationType: { in: ['AGREE', 'DISAGREE'] },
      // Pure-stance votes: no source message, relationPayload carries vote metadata
      relSourceId: null,
    };
    if (topicId) voteFilter.topicId = topicId;

    const voteRelations = await prisma.message.findMany({
      where: voteFilter,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        topicId: true,
        relationType: true,
        relationPayload: true,
        targetRefs: true,
        createdAt: true,
        topic: { select: { id: true, title: true } },
      },
    });

    // ── 3. 押注表态 ──
    const stakeFilter: Record<string, unknown> = { userId: targetUserId };
    if (topicId) stakeFilter.topicId = topicId;

    const stakes = await prisma.stake.findMany({
      where: stakeFilter,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        side: true,
        amount: true,
        messageId: true,
        createdAt: true,
        message: {
          select: {
            id: true,
            topicId: true,
            topic: { select: { id: true, title: true } },
          },
        },
      },
    });

    // ── Counts for pagination ──
    const [relationCount, voteCount, stakeCount, evidenceCount] = await Promise.all([
      prisma.message.count({ where: relationFilter }),
      prisma.message.count({ where: voteFilter }),
      prisma.stake.count({ where: stakeFilter }),
      prisma.message.count({ where: evidenceFilter }),
    ]);

    res.json({
      user: { id: targetUserId },
      stances: {
        relations: stanceRelations.map(r => ({
          kind: 'relation' as const,
          id: r.id,
          topicId: r.topicId,
          topicTitle: r.topic.title,
          type: r.relationType as string,
          payload: r.relationPayload,
          targetRefs: r.targetRefs,
          createdAt: r.createdAt,
        })),
        votes: voteRelations.map(v => {
          const payload = v.relationPayload as Record<string, unknown> | null;
          const targets = v.targetRefs as Array<{ messageId?: string }> | undefined;
          const targetMessageId = targets?.[0]?.messageId;
          return {
            kind: 'vote' as const,
            id: v.id,
            topicId: v.topicId,
            topicTitle: v.topic.title,
            messageId: targetMessageId,
            vote: v.relationType === 'AGREE' ? 'TRUE' : 'FALSE',
            amount: (payload?.amount as number) ?? 0,
            roundStatus: 'VOTING',
            roundResult: null,
            createdAt: v.createdAt,
          };
        }),
        stakes: stakes.map(s => ({
          kind: 'stake' as const,
          id: s.id,
          topicId: s.message?.topicId,
          topicTitle: s.message?.topic?.title,
          messageId: s.messageId,
          side: s.side,
          amount: s.amount,
          createdAt: s.createdAt,
        })),
        evidence: evidenceRefs.map(e => ({
          id: e.id,
          topicId: e.topicId,
          topicTitle: e.topic.title,
          relationPayload: e.relationPayload,
          targetRefs: e.targetRefs,
          createdAt: e.createdAt,
        })),
      },
      pagination: {
        page,
        limit,
        totalRelations: relationCount,
        totalVotes: voteCount,
        totalStakes: stakeCount,
        totalEvidence: evidenceCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
