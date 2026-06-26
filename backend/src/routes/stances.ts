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

    // ═══════════════════════════════════════════════════════════
    // 1. 站队 — AGREE/DISAGREE 关系表态
    // ═══════════════════════════════════════════════════════════
    const stanceFilter: Record<string, unknown> = {
      createdById: targetUserId,
      kind: 'RELATION',
      relationType: { in: ['AGREE', 'DISAGREE'] },
    };
    if (topicId) stanceFilter.topicId = topicId;

    const stanceRelations = await prisma.message.findMany({
      where: stanceFilter,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true, topicId: true, relationType: true,
        targetRefs: true, createdAt: true,
        topic: { select: { id: true, title: true } },
      },
    });

    // AGREE/DISAGEE stakes are on the TARGET message (events.ts line 556)
    const targetMsgIds = new Set(
      stanceRelations.flatMap(r =>
        ((r.targetRefs as Array<{ messageId?: string }> | undefined) ?? [])
          .map(ref => ref.messageId).filter(Boolean) as string[]
      )
    );
    const [targetMsgs, targetStakes] = targetMsgIds.size > 0
      ? await Promise.all([
          prisma.message.findMany({
            where: { id: { in: [...targetMsgIds] } },
            select: { id: true, createdById: true },
          }),
          prisma.stake.findMany({
            where: { messageId: { in: [...targetMsgIds] }, userId: targetUserId },
            select: { messageId: true, amount: true },
          }),
        ])
      : [[], []];

    const ownMsgIds = new Set(targetMsgs.filter(m => m.createdById === targetUserId).map(m => m.id));
    const stakeByTarget = new Map(targetStakes.map(s => [s.messageId, s.amount]));

    const relations = stanceRelations.map(r => {
      const refs = (r.targetRefs as Array<{ messageId?: string }> | undefined) ?? [];
      const tid = refs.find(ref => ref.messageId)?.messageId;
      return {
        kind: 'relation' as const,
        id: r.id, topicId: r.topicId, topicTitle: r.topic.title,
        type: (tid && ownMsgIds.has(tid)) ? 'SELF_AGREE' : r.relationType as string,
        amount: tid ? (stakeByTarget.get(tid) ?? 0) : 0,
        targetMessageId: tid ?? null,
        content: null as string | null,
        createdAt: r.createdAt,
      };
    });

    // ═══════════════════════════════════════════════════════════
    // 2. 立场 — 所有非 AGREE/DISAGREE 的发送消息（含自押）
    // ═══════════════════════════════════════════════════════════
    const positionFilter: Record<string, unknown> = {
      createdById: targetUserId,
      NOT: [{ kind: 'RELATION', relationType: { in: ['AGREE', 'DISAGREE'] } }],
    };
    if (topicId) positionFilter.topicId = topicId;

    const positionMessages = await prisma.message.findMany({
      where: positionFilter,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true, content: true, kind: true, relationType: true,
        topicId: true, createdAt: true,
        topic: { select: { id: true, title: true } },
      },
    });

    // Non-AGREE/DISAGEE stakes are on the message itself
    const posMsgIds = positionMessages.map(m => m.id);
    const posStakes = posMsgIds.length > 0
      ? new Map((await prisma.stake.findMany({
          where: { messageId: { in: posMsgIds }, userId: targetUserId, side: 'PRO' },
          orderBy: { createdAt: 'asc' },
          distinct: ['messageId'],
          select: { messageId: true, amount: true },
        })).map(s => [s.messageId, s.amount]))
      : new Map<string, number>();

    const stakes = positionMessages
      .filter(m => posStakes.has(m.id))
      .map(m => ({
        kind: 'stake' as const,
        id: m.id, topicId: m.topicId, topicTitle: m.topic.title,
        messageId: m.id,
        content: m.content?.slice(0, 80) ?? '',
        amount: posStakes.get(m.id)!,
        createdAt: m.createdAt,
      }));

    // ═══════════════════════════════════════════════════════════
    // Response
    // ═══════════════════════════════════════════════════════════
    const [relationCount, positionCount] = await Promise.all([
      prisma.message.count({ where: stanceFilter }),
      prisma.message.count({ where: positionFilter }),
    ]);

    res.json({
      user: { id: targetUserId },
      stances: { relations, stakes },
      pagination: { page, limit, totalRelations: relationCount, totalStakes: positionCount },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
