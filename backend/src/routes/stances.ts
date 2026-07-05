import { Router, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

type RelationCandidate = {
  id: string;
  topicId: string;
  relationType: string | null;
  relationPayload: unknown;
  targetRefs: unknown;
  createdAt: Date;
  topic: { id: string; title: string };
};

type StakeRecord = {
  id: string;
  topicId: string;
  messageId: string;
  side: string;
  amount: number;
  roundId: string | null;
  createdAt: Date;
  message: {
    id: string;
    content: string | null;
    kind: string;
    relationType: string | null;
    relationPayload: unknown;
    supersededBy: string | null;
    createdById: string;
    topicId: string;
    topic: { id: string; title: string };
  };
};

function relationTargetsMessage(relation: RelationCandidate, messageId: string) {
  const refs = (relation.targetRefs as Array<{ messageId?: string; relationId?: string }> | undefined) ?? [];
  return refs.some(ref => ref.messageId === messageId || ref.relationId === messageId);
}

function relationPayload(relation: RelationCandidate) {
  return relation.relationPayload as Record<string, unknown> | null;
}

function relationSide(relationType: string | null) {
  if (relationType === 'AGREE' || relationType === 'RECOMMEND') return 'PRO';
  if (relationType === 'DISAGREE' || relationType === 'ARCHIVE') return 'CON';
  return null;
}

function latestMatchingRelation(stake: StakeRecord, candidates: RelationCandidate[], types: string[]) {
  const exact = candidates.find(r =>
    r.createdAt <= stake.createdAt &&
    types.includes(r.relationType ?? '') &&
    relationSide(r.relationType) === stake.side &&
    relationTargetsMessage(r, stake.messageId)
  );
  if (exact) return exact;
  return candidates.find(r =>
    types.includes(r.relationType ?? '') &&
    relationSide(r.relationType) === stake.side &&
    relationTargetsMessage(r, stake.messageId)
  ) ?? null;
}

/**
 * GET /api/users/:id/stances — 查询用户的贡献点消耗历史
 *
 * 面板记录以 Stake 为准：站队、立场、表态都是贡献点消耗记录，
 * 再根据 settlementType、side 和关联关系消息还原显示语义。
 */
router.get('/api/users/:id/stances', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const targetUserId = req.params.id as string;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;
    const topicId = req.query.topicId as string | undefined;

    const allStakes = await prisma.stake.findMany({
      where: { userId: targetUserId, ...(topicId ? { topicId } : {}) },
      orderBy: { createdAt: 'desc' },
      include: {
        message: {
          select: {
            id: true,
            content: true,
            kind: true,
            relationType: true,
            relationPayload: true,
            supersededBy: true,
            createdById: true,
            topicId: true,
            topic: { select: { id: true, title: true } },
          },
        },
      },
    }) as StakeRecord[];

    // Resolve stake.messageId through supersededBy chain to the latest non-superseded ID.
    // When a message (e.g. CLASSIFY relation) is modified, the old record gets
    // supersededBy pointing to the new ID.  Stake records still reference the old
    // message ID.  We must resolve to the current ID so the frontend can locate
    // the message card on the canvas.
    const supersedeChain = new Map<string, string>();
    {
      const toResolve = allStakes
        .map(s => s.message.supersededBy)
        .filter((id): id is string => id !== null);
      let queue = [...toResolve];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const batch = queue.splice(0, 100);
        const msgs = await prisma.message.findMany({
          where: { id: { in: batch } },
          select: { id: true, supersededBy: true },
        });
        for (const m of msgs) {
          seen.add(m.id);
          if (m.supersededBy) {
            supersedeChain.set(m.id, m.supersededBy);
            if (!seen.has(m.supersededBy)) queue.push(m.supersededBy);
          }
        }
      }
    }

    // Walk chain to terminal ID
    function resolveSupersede(msgId: string): string {
      let cur = msgId;
      const visited = new Set<string>();
      while (supersedeChain.has(cur) && !visited.has(cur)) {
        visited.add(cur);
        cur = supersedeChain.get(cur)!;
      }
      return cur;
    }

    const roundIds = [...new Set(allStakes.map(s => s.roundId).filter(Boolean) as string[])];
    const rounds = roundIds.length > 0
      ? new Map((await prisma.settlementRound.findMany({
          where: { id: { in: roundIds } },
          select: { id: true, settlementType: true },
        })).map(r => [r.id, r.settlementType]))
      : new Map<string, string>();

    const relationCandidates = await prisma.message.findMany({
      where: {
        createdById: targetUserId,
        kind: 'RELATION',
        relationType: { in: ['AGREE', 'DISAGREE', 'RECOMMEND', 'ARCHIVE'] },
        supersededBy: null,
        ...(topicId ? { topicId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        topicId: true,
        relationType: true,
        relationPayload: true,
        targetRefs: true,
        createdAt: true,
        topic: { select: { id: true, title: true } },
      },
    }) as RelationCandidate[];

    const relationItems = [] as Array<{
      kind: 'relation';
      id: string;
      relationMessageId: string;
      topicId: string;
      topicTitle: string;
      type: string;
      amount: number;
      stakeId: string;
      targetMessageId: string;
      content: string | null;
      createdAt: Date;
    }>;

    const stakeItems = [] as Array<{
      kind: 'stake';
      id: string;
      topicId: string;
      topicTitle: string;
      messageId: string;
      messageKind: string;
      content: string;
      amount: number;
      createdAt: Date;
    }>;

    const tagItems = [] as Array<{
      kind: 'tag';
      id: string;
      relationMessageId: string;
      topicId: string;
      topicTitle: string;
      relationType: string;
      label: string;
      subType: string | null;
      customLabel: string | null;
      targetMessageId: string;
      stakeId: string;
      amount: number;
      createdAt: Date;
    }>;

    for (const stake of allStakes) {
      const settlementType = stake.roundId ? (rounds.get(stake.roundId) ?? 'TRUTH') : 'TRUTH';

      if (settlementType === 'VALUE') {
        const relation = latestMatchingRelation(stake, relationCandidates, ['RECOMMEND', 'ARCHIVE']);
        if (relation) {
          const payload = relationPayload(relation);
          tagItems.push({
            kind: 'tag',
            id: stake.id,
            relationMessageId: relation.id,
            topicId: stake.topicId,
            topicTitle: stake.message.topic.title,
            relationType: relation.relationType as string,
            label: (payload?.label as string) || '',
            subType: (payload?.subType as string) || null,
            customLabel: (payload?.customLabel as string) || null,
            targetMessageId: stake.messageId,
            stakeId: stake.id,
            amount: stake.amount,
            createdAt: stake.createdAt,
          });
          continue;
        }
      }

      if (settlementType === 'TRUTH') {
        const relation = latestMatchingRelation(stake, relationCandidates, ['AGREE', 'DISAGREE']);
        if (relation) {
          relationItems.push({
            kind: 'relation',
            id: stake.id,
            relationMessageId: relation.id,
            topicId: stake.topicId,
            topicTitle: stake.message.topic.title,
            type: stake.message.createdById === targetUserId ? 'SELF_AGREE' : relation.relationType as string,
            amount: stake.amount,
            stakeId: stake.id,
            targetMessageId: stake.messageId,
            content: null,
            createdAt: stake.createdAt,
          });
          continue;
        }
      }

      const relType = stake.message.relationType;
      const isStanceRelation = stake.message.kind === 'RELATION' && ['AGREE', 'DISAGREE', 'RECOMMEND', 'ARCHIVE'].includes(relType ?? '');
      if (stake.message.createdById === targetUserId && !isStanceRelation) {
        // Build display text: prefer message content; for relation messages
        // without content, derive a label from relationType + payload.
        let displayContent = stake.message.content?.slice(0, 80) ?? '';
        if (!displayContent && stake.message.kind === 'RELATION') {
          const rp = stake.message.relationPayload as Record<string, unknown> | null;
          const rt = (relType ?? '').toUpperCase();
          if (rt === 'CLASSIFY' || rt === 'SUMMARY') {
            displayContent = (rp?.title as string) || `[${rt === 'CLASSIFY' ? '分类' : '汇总'}]`;
          } else if (rt === 'TAG') {
            displayContent = (rp?.label as string) || '[标签]';
          } else if (rt === 'CORRECT') {
            displayContent = '[更正]';
          } else if (rt === 'REPLY') {
            displayContent = '[回复]';
          } else if (rt === 'REFERENCE') {
            displayContent = '[引用]';
          } else if (rt === 'ANNOTATION') {
            displayContent = '[批注]';
          } else {
            displayContent = `[${rt || '关系'}]`;
          }
        }
        stakeItems.push({
          kind: 'stake',
          id: stake.id,
          topicId: stake.topicId,
          topicTitle: stake.message.topic.title,
          messageId: resolveSupersede(stake.messageId),
          messageKind: stake.message.kind,
          content: displayContent,
          amount: stake.amount,
          createdAt: stake.createdAt,
        });
      }
    }

    const relations = relationItems.slice(skip, skip + limit);
    const stakes = stakeItems.slice(skip, skip + limit);
    const tags = tagItems.slice(skip, skip + limit);

    res.json({
      user: { id: targetUserId },
      stances: { relations, stakes, tags },
      pagination: {
        page,
        limit,
        totalRelations: relationItems.length,
        totalStakes: stakeItems.length,
        totalTags: tagItems.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
