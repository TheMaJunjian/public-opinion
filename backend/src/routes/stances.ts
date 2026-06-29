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

    const [stanceRelations, tagRelations] = await Promise.all([
      prisma.message.findMany({
        where: stanceFilter,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true, topicId: true, relationType: true,
          targetRefs: true, createdAt: true,
          topic: { select: { id: true, title: true } },
        },
      }),
      prisma.message.findMany({
        where: {
          createdById: targetUserId,
          kind: 'RELATION',
          relationType: { in: ['TAG', 'RECOMMEND', 'ARCHIVE'] },
          supersededBy: null,
          ...(topicId ? { topicId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true, topicId: true, relationType: true,
          relationPayload: true, targetRefs: true, createdAt: true,
          topic: { select: { id: true, title: true } },
        },
      }),
    ]);

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
    // 2. 立场 — 所有非 AGREE/DISAGREE/TAG 的发送消息（含自押）
    // ═══════════════════════════════════════════════════════════
    // Also exclude RECOMMEND/ARCHIVE from positions (they are annotations, shown in "表态")
    const positionFilter: Record<string, unknown> = {
      createdById: targetUserId,
      NOT: [{ kind: 'RELATION', relationType: { in: ['AGREE', 'DISAGREE', 'TAG', 'RECOMMEND', 'ARCHIVE'] } }],
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
    // 3. 表态 — TAG / RECOMMEND / ARCHIVE 标注记录
    // ═══════════════════════════════════════════════════════════
    // TAG stakes are on the relation message itself (PRO); RECOMMEND/ARCHIVE stakes are on the target (PRO/CON)
    const tagOwnIds = tagRelations.filter(r => r.relationType === 'TAG').map(r => r.id);
    const tagTargetIds = new Set(
      tagRelations
        .filter(r => r.relationType !== 'TAG')
        .flatMap(r => ((r.targetRefs as Array<{ messageId?: string }> | undefined) ?? []).map(ref => ref.messageId).filter(Boolean) as string[])
    );
    const allTagStakeMsgIds = [...tagOwnIds, ...tagTargetIds];
    const tagStakeMap = allTagStakeMsgIds.length > 0
      ? new Map((await prisma.stake.findMany({
          where: { messageId: { in: allTagStakeMsgIds }, userId: targetUserId },
          select: { messageId: true, amount: true, side: true },
        })).map(s => [`${s.messageId}:${s.side}`, s.amount]))
      : new Map<string, number>();

    const tags = tagRelations.map(r => {
      const payload = r.relationPayload as Record<string, unknown> | null;
      const label = (payload?.label as string) || '';
      const subType = (payload?.subType as string) || null;
      const customLabel = (payload?.customLabel as string) || null;
      const refs = (r.targetRefs as Array<{ messageId?: string }> | undefined) ?? [];
      const targetMsgId = refs.find(ref => ref.messageId)?.messageId ?? null;
      // TAG: stake on self (PRO); RECOMMEND: stake on target (PRO); ARCHIVE: stake on target (CON)
      let amount = 0;
      if (r.relationType === 'TAG') {
        amount = tagStakeMap.get(`${r.id}:PRO`) ?? 0;
      } else if (targetMsgId) {
        const side = r.relationType === 'RECOMMEND' ? 'PRO' : 'CON';
        amount = tagStakeMap.get(`${targetMsgId}:${side}`) ?? 0;
      }
      return {
        kind: 'tag' as const,
        id: r.id, topicId: r.topicId, topicTitle: r.topic.title,
        relationType: r.relationType as string,
        label,
        subType,
        customLabel,
        targetMessageId: targetMsgId,
        amount,
        createdAt: r.createdAt,
      };
    });

    // ═══════════════════════════════════════════════════════════
    // Response
    // ═══════════════════════════════════════════════════════════
    const [relationCount, positionCount, tagCount] = await Promise.all([
      prisma.message.count({ where: stanceFilter }),
      prisma.message.count({ where: positionFilter }),
      prisma.message.count({
        where: {
          createdById: targetUserId,
          kind: 'RELATION',
          relationType: { in: ['TAG', 'RECOMMEND', 'ARCHIVE'] },
          supersededBy: null,
          ...(topicId ? { topicId } : {}),
        },
      }),
    ]);

    res.json({
      user: { id: targetUserId },
      stances: { relations, stakes, tags },
      pagination: { page, limit, totalRelations: relationCount, totalStakes: positionCount, totalTags: tagCount },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
