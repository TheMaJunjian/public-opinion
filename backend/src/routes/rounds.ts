import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, optionalAuth, verifySignature, AuthRequest } from '../middleware/auth';
import { applyEvent } from '../lib/events';
import { calculatePersonalSettlement } from '../lib/personalSettlement';
import { isCurrentRoundVote, isVoteBeforeCutoff, sumCumulativeFees, sumCumulativeStakeAmounts } from '../lib/personalSettlementInputs';

const router = Router({ mergeParams: true });

// ── Schemas ──────────────────────────────────────────────────

const createRoundSchema = z.object({
  note: z.string().max(500).optional(),
  settlementType: z.enum(['TRUTH', 'VALUE']).optional().default('TRUTH'),
});

const voteSchema = z.object({
  vote: z.enum(['TRUE', 'FALSE']),
  amount: z.number().int().min(1, '投票金额至少为 1 点'),
});

// ============================================================
// POST /api/messages/:id/rounds — 发起结算（Phase 6：通过创建 ROUND 消息实现）
// ============================================================
router.post('/api/messages/:id/rounds', requireAuth, verifySignature, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const messageId = req.params.id as string;
    const data = createRoundSchema.parse(req.body);

    // Validate target message exists and get topicId
    const targetMsg = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, topicId: true, kind: true },
    });

    if (!targetMsg) {
      res.status(404).json({ error: '消息不存在' });
      return;
    }

    // Create ROUND message (SettlementRound created as side effect in applyMessageCreated)
    const roundMsg = await applyEvent({
      type: 'MESSAGE_CREATED',
      actorId: req.user!.id,
      topicId: targetMsg.topicId,
      payload: {
        kind: 'ROUND',
        targetMessageId: messageId,
        note: data.note ?? null,
        settlementType: data.settlementType,
      },
    });

    // Query the SettlementRound to return familiar data to frontend
    const round = await prisma.settlementRound.findFirst({
      where: { messageId, settlementType: data.settlementType, status: 'VOTING' },
      orderBy: { openedAt: 'desc' },
      include: { createdBy: { select: { id: true, username: true } } },
    });

    res.status(201).json({ ...round, roundMessageId: (roundMsg as { id: string }).id });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /api/messages/:id/rounds — 查询消息的结算轮次历史
// ============================================================
router.get('/api/messages/:id/rounds', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const messageId = req.params.id as string;

    const rounds = await prisma.settlementRound.findMany({
      where: { messageId },
      orderBy: { openedAt: 'desc' },
      include: {
        createdBy: { select: { id: true, username: true } },
        _count: { select: { votes: true } },
      },
    });

    res.json({ data: rounds });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /api/rounds/:id — 查询单个轮次详情
// ============================================================
router.get('/api/rounds/:id', optionalAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const roundId = req.params.id as string;

    const round = await prisma.settlementRound.findUnique({
      where: { id: roundId },
      include: {
        createdBy: { select: { id: true, username: true } },
      },
    });

    if (!round) {
      res.status(404).json({ error: '结算轮次不存在' });
      return;
    }

    const roundStakes = (await prisma.stake.findMany({
      where: { roundId, settlementType: round.settlementType ?? 'TRUTH' },
      select: { side: true, amount: true },
    })) ?? [];
    const roundVotes = (await prisma.voteStake.findMany({
      where: { roundId },
      select: { vote: true, amount: true },
    })) ?? [];
    const roundPro = roundStakes.filter(stake => stake.side === 'PRO').reduce((sum, stake) => sum + stake.amount, 0)
      + roundVotes.filter(vote => vote.vote === 'TRUE').reduce((sum, vote) => sum + vote.amount, 0);
    const roundCon = roundStakes.filter(stake => stake.side === 'CON').reduce((sum, stake) => sum + stake.amount, 0)
      + roundVotes.filter(vote => vote.vote === 'FALSE').reduce((sum, vote) => sum + vote.amount, 0);

    // Compute current weights from BetPool scoped by settlementType
    const stype = round.settlementType ?? 'TRUTH';
    const betPool = await prisma.betPool.findUnique({
      where: { messageId_settlementType: { messageId: round.messageId, settlementType: stype } },
      select: { lockedPro: true, lockedCon: true },
    });

    // Query AGREE/DISAGREE pure-stance relations targeting this message (replaces VoteStake)
    const messageTopic = await prisma.message.findUnique({
      where: { id: round.messageId },
      select: { topicId: true },
    });
    const voteRelations = await prisma.message.findMany({
      where: {
        kind: 'RELATION',
        relationType: { in: ['AGREE', 'DISAGREE'] },
        relSourceId: null,
        topicId: messageTopic?.topicId,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        relationType: true,
        relationPayload: true,
        targetRefs: true,
        createdAt: true,
        createdBy: { select: { id: true, username: true } },
      },
    });

    // Filter to only those targeting this message
    const filteredVotes = voteRelations.filter(v => {
      const refs = v.targetRefs as Array<{ messageId?: string }> | undefined;
      if (!refs?.some(r => r.messageId === round.messageId)) return false;
      const payload = v.relationPayload as Record<string, unknown> | null;
      return payload?.roundId === roundId;
    });

    let personalSettlement: {
      principal: number;
      stakePrincipal: number;
      protocolFee: number;
      change: number;
      after: number;
      previousAfter?: number;
    } | undefined;
    if (req.user) {
      const cutoff = round.closedAt ?? new Date();
      const [userStakes, userLedger] = await Promise.all([
        prisma.stake.findMany({
          where: { messageId: round.messageId, settlementType: stype, userId: req.user.id, createdAt: { lte: cutoff } },
          select: { amount: true },
        }),
        prisma.ledgerEntry.findMany({
          where: { userId: req.user.id, messageId: round.messageId },
          select: { amount: true, roundId: true, entryType: true, data: true, createdAt: true },
        }),
      ]);
      const stakePrincipal = sumCumulativeStakeAmounts(userStakes, cutoff);
          const protocolFee = sumCumulativeFees(userLedger, cutoff);
      const principal = stakePrincipal + protocolFee;
      const payout = userLedger
        .filter(entry => entry.entryType === 'SETTLEMENT_PAYOUT' && entry.roundId === roundId)
        .reduce((sum, entry) => sum + entry.amount, 0);
      if (stakePrincipal === 0) {
        personalSettlement = undefined;
      } else {
      let previousAfter: number | undefined;
      if (round.previousRoundId) {
        const calculateAfter = async (targetRoundId: string): Promise<number | undefined> => {
          const targetRound = await prisma.settlementRound.findUnique({
            where: { id: targetRoundId },
            select: { closedAt: true, previousRoundId: true },
          });
          if (!targetRound) return undefined;
          const targetCutoff = targetRound.closedAt ?? new Date();
          const targetStakes = await prisma.stake.findMany({
            where: { messageId: round.messageId, settlementType: stype, userId: req.user!.id, createdAt: { lte: targetCutoff } },
            select: { amount: true },
          });
          const targetStakePrincipal = sumCumulativeStakeAmounts(targetStakes, targetCutoff);
          const targetProtocolFee = sumCumulativeFees(userLedger, targetCutoff);
          if (targetStakePrincipal === 0 && targetProtocolFee === 0) return undefined;
          const targetPayout = userLedger
            .filter(entry => entry.entryType === 'SETTLEMENT_PAYOUT' && entry.roundId === targetRoundId)
            .reduce((sum, entry) => sum + entry.amount, 0);
          const priorAfter = targetRound.previousRoundId
            ? await calculateAfter(targetRound.previousRoundId)
            : undefined;
          return calculatePersonalSettlement({
            principal: targetStakePrincipal + targetProtocolFee,
            stakePrincipal: targetStakePrincipal,
            protocolFee: targetProtocolFee,
            payout: targetPayout,
            previousAfter: priorAfter,
          }).after;
        };
        previousAfter = await calculateAfter(round.previousRoundId);
      }
      personalSettlement = calculatePersonalSettlement({
        principal,
        stakePrincipal,
        protocolFee,
        payout,
        previousAfter,
      });
      }
    }

    const weightMap: Record<string, number> = {
      TRUE: betPool?.lockedPro ?? 0,
      FALSE: betPool?.lockedCon ?? 0,
      UNKNOWN: 0,
    };

    const totalWeight = weightMap.TRUE + weightMap.FALSE;

    // For settled rounds, use stored settlement weights; for active rounds, use BetPool
    const settledPro = round.status === 'SETTLED' ? (round.settlementPro ?? 0) : undefined;
    const settledCon = round.status === 'SETTLED' ? (round.settlementCon ?? 0) : undefined;

    res.json({
      ...round,
      _count: { votes: filteredVotes.length },
      votes: filteredVotes.map(v => {
        const payload = v.relationPayload as Record<string, unknown> | null;
        return {
          id: v.id,
          vote: v.relationType === 'AGREE' ? 'TRUE' : 'FALSE',
          amount: (payload?.amount as number) ?? 0,
          createdAt: v.createdAt,
          user: v.createdBy,
        };
      }),
      weights: round.status === 'SETTLED'
        ? { TRUE: settledPro ?? 0, FALSE: settledCon ?? 0, UNKNOWN: 0 }
        : weightMap,
      totalWeight: round.status === 'SETTLED'
        ? ((settledPro ?? 0) + (settledCon ?? 0))
        : totalWeight,
      roundWeights: { TRUE: roundPro, FALSE: roundCon, UNKNOWN: 0 },
      personalSettlement,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /api/rounds/:id/votes — 投票（统一为发送无文本赞同/反对关系消息）
// ============================================================
router.post('/api/rounds/:id/votes', requireAuth, verifySignature, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const roundId = req.params.id as string;
    const { vote, amount } = voteSchema.parse(req.body);

    // Get round info for topicId, messageId, and settlementType
    const round = await prisma.settlementRound.findUnique({
      where: { id: roundId },
      select: { messageId: true, status: true, settlementType: true },
    });
    if (!round) {
      res.status(404).json({ error: '结算轮次不存在' });
      return;
    }
    if (round.status !== 'VOTING') {
      res.status(400).json({ error: '该轮次不在投票阶段' });
      return;
    }

    const message = await prisma.message.findUnique({
      where: { id: round.messageId },
      select: { topicId: true },
    });

    // Map vote to relation type based on settlement type:
    // TRUTH: TRUE→AGREE(PRO), FALSE→DISAGREE(CON)
    // VALUE: TRUE→RECOMMEND(PRO), FALSE→ARCHIVE(CON)
    const isValue = round.settlementType === 'VALUE';
    const relationType = vote === 'TRUE'
      ? (isValue ? 'RECOMMEND' : 'AGREE')
      : (isValue ? 'ARCHIVE' : 'DISAGREE');

    const result = await applyEvent({
      type: 'RELATION_CREATED',
      actorId: req.user!.id,
      topicId: message!.topicId,
      payload: {
        relationType,
        sourceMessageId: null,  // pure stance — no attached text message
        targetRefs: [{ kind: 'message', messageId: round.messageId }],
        stakeAmount: amount,
        relationPayload: { vote: true, amount, roundId },
      },
    });

    res.status(201).json({ message: '投票成功', ...(result as Record<string, unknown>) });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /api/rounds/:id/close-and-settle — 关闭并结算
// ============================================================
router.post('/api/rounds/:id/close-and-settle', requireAuth, verifySignature, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const roundId = req.params.id as string;

    // Get round info
    const round = await prisma.settlementRound.findUnique({
      where: { id: roundId },
      select: { messageId: true, createdByUserId: true, status: true },
    });
    if (!round) {
      res.status(404).json({ error: '结算轮次不存在' });
      return;
    }
    if (round.createdByUserId !== req.user!.id) {
      // Check rule: settlementPermission
      const rule = await prisma.ruleVersion.findFirst({
        where: { status: 'ACTIVE' },
        orderBy: { version: 'desc' },
        select: { parameters: true },
      });
      const permission = (rule?.parameters as Record<string, unknown> | null)?.settlementPermission ?? 'anyone';

      if (permission === 'anyone') {
        // Anyone can settle — proceed
      } else if (permission === 'any_voter') {
        // Check if user staked on this message (unified: AGREE→PRO stake, DISAGREE→CON stake)
        const userStaked = await prisma.stake.findFirst({
          where: { messageId: round.messageId, userId: req.user!.id },
        });
        if (!userStaked) {
          res.status(403).json({ error: '规则要求投票者才可结算，你尚未投票' });
          return;
        }
      } else {
        // creator_only (default)
        res.status(403).json({ error: '当前规则仅允许轮次发起者结算' });
        return;
      }
    }

    const message = await prisma.message.findUnique({
      where: { id: round.messageId },
      select: { topicId: true },
    });

    const result = await applyEvent({
      type: 'ROUND_SETTLED',
      actorId: req.user!.id,
      topicId: message!.topicId,
      payload: { roundId },
    });

    res.json({ message: '结算完成', ...(result as Record<string, unknown>) });
  } catch (err) {
    next(err);
  }
});

export default router;
