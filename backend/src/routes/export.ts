import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';

const exportRouter = Router({ mergeParams: true });

/**
 * GET /api/topics/:topicId/export
 *
 * Exports the discussion projection as a versioned JSON snapshot.
 * This is the public content/relationship format; it is not the complete
 * economic audit stream consumed by replay/verify.
 */
exportRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;

    const topic = await prisma.topic.findUnique({
      where: { id: topicId },
      select: { title: true, body: true, status: true },
    });

    if (!topic) {
      res.status(404).json({ error: '分类不存在' });
      return;
    }

    // Fetch all non-RELATION messages (TEXT, GOVERNANCE, CODE, OPERATIONS, ROUND, ROUND_RESULT)
    const messages = await prisma.message.findMany({
      where: {
        topicId,
        kind: { in: ['TEXT', 'GOVERNANCE', 'CODE', 'OPERATIONS', 'ROUND', 'ROUND_RESULT'] },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        kind: true,
        contentType: true,
        content: true,
        createdAt: true,
        quoteSourceId: true,
        quotedText: true,
        quotedTextHash: true,
        quoteContextBefore: true,
        quoteContextAfter: true,
        targetRefs: true,
        relationPayload: true,
        relationType: true,
        relSourceId: true,
        createdBy: { select: { id: true, username: true } },
        supersededBy: true,
      },
    });

    // Keep superseded relations in the export so relationship history is reproducible.
    const relationMessages = await prisma.message.findMany({
      where: {
        topicId,
        kind: 'RELATION',
        supersededBy: undefined,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        relationType: true,
        relSourceId: true,
        targetRefs: true,
        relationPayload: true,
        createdAt: true,
        createdBy: { select: { id: true, username: true } },
        supersededBy: true,
      },
    });

    const relations = relationMessages.map(m => ({
      id: m.id,
      relationType: m.relationType,
      sourceMessageId: m.relSourceId,
      targetRefs: m.targetRefs,
      payload: m.relationPayload,
      createdAt: m.createdAt,
      authorId: m.createdBy.id,
      author: m.createdBy.username,
      supersededBy: m.supersededBy,
    }));

    const exportData = {
      formatVersion: 2,
      exportedAt: new Date().toISOString(),
      topicId,
      topic: {
        title: topic.title,
        body: topic.body,
        status: topic.status,
      },
      messages: messages.map(m => ({
        id: m.id,
        kind: m.kind,
        contentType: m.contentType,
        content: m.content,
        createdAt: m.createdAt,
        authorId: m.createdBy.id,
        author: m.createdBy.username,
        quoteSourceId: m.quoteSourceId,
        quotedText: m.quotedText,
        quotedTextHash: m.quotedTextHash,
        quoteContextBefore: m.quoteContextBefore,
        quoteContextAfter: m.quoteContextAfter,
        targetRefs: m.targetRefs,
        relationPayload: m.relationPayload,
        relationType: m.relationType,
        sourceMessageId: m.relSourceId,
        supersededBy: m.supersededBy,
      })),
      relations,
    };

    res.json(exportData);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/topics/:topicId/audit-export
 *
 * Exports the immutable inputs needed by an independent economic replay.
 * This is intentionally separate from the public discussion projection above.
 */
exportRouter.get('/audit-export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;
    const topic = await prisma.topic.findUnique({
      where: { id: topicId },
      select: { title: true, body: true, status: true },
    });

    if (!topic) {
      res.status(404).json({ error: '分类不存在' });
      return;
    }

    const [messages, auditEvents, stakes, rounds, rules] = await Promise.all([
      prisma.message.findMany({
        where: { topicId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true, kind: true, contentType: true, content: true, createdAt: true,
          quoteSourceId: true, quotedText: true, quotedTextHash: true,
          quoteContextBefore: true, quoteContextAfter: true, relationType: true,
          relSourceId: true, targetRefs: true, relationPayload: true, supersededBy: true,
          createdById: true,
        },
      }),
      prisma.auditLog.findMany({
        where: { topicId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true, createdAt: true, actorId: true, action: true, entityType: true,
          entityId: true, topicId: true, data: true, signature: true,
        },
      }),
      prisma.stake.findMany({
        where: { topicId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true, userId: true, messageId: true, side: true, amount: true,
          roundId: true, settlementType: true, createdAt: true,
        },
      }),
      prisma.settlementRound.findMany({
        where: { message: { topicId } },
        orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true, messageId: true, createdByUserId: true, status: true,
          settlementType: true, result: true, previousRoundId: true,
          openedAt: true, closedAt: true, note: true, settlementPro: true,
          settlementCon: true, effectiveAt: true, terminatedByRoundId: true,
          votes: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, userId: true, vote: true, amount: true, createdAt: true },
          },
        },
      }),
      prisma.ruleVersion.findMany({
        orderBy: [{ version: 'asc' }, { id: 'asc' }],
        select: { id: true, createdAt: true, version: true, status: true, description: true, parameters: true },
      }),
    ]);

    const votes = auditEvents
      .filter(event => event.action === 'VOTE_CAST' || event.action === 'RELATION_CREATED')
      .map(event => {
        const details = (event.data as { details?: Record<string, unknown> } | null)?.details ?? {};
        const relationPayload = details.relationPayload as Record<string, unknown> | null | undefined;
        const isRelationVote = event.action === 'RELATION_CREATED' && relationPayload?.vote === true;
        if (event.action !== 'VOTE_CAST' && !isRelationVote) return null;
        const relationType = details.relationType as string | undefined;
        return {
          id: event.entityId,
          createdAt: event.createdAt,
          userId: event.actorId,
          messageId: details.messageId ?? (details.targetRefs as Array<{ messageId?: string }> | undefined)?.[0]?.messageId ?? null,
          roundId: details.roundId ?? relationPayload?.roundId ?? null,
          vote: details.vote ?? (relationType === 'AGREE' || relationType === 'RECOMMEND' ? 'TRUE' : 'FALSE'),
          amount: details.amount ?? relationPayload?.amount ?? null,
          feeAmount: details.feeAmount ?? 0,
        };
      })
      .filter((vote): vote is NonNullable<typeof vote> => vote !== null);

    res.json({
      formatVersion: 1,
      exportKind: 'economic-audit',
      exportedAt: new Date().toISOString(),
      topicId,
      topic,
      messages,
      auditEvents,
      stakes,
      votes,
      rounds,
      rules,
    });
  } catch (err) {
    next(err);
  }
});

export default exportRouter;
