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

export default exportRouter;
