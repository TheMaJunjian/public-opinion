import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';

const exportRouter = Router({ mergeParams: true });

/**
 * GET /api/topics/:topicId/export
 *
 * Exports all messages and relations in a topic as a JSON text blob.
 * The returned JSON can be saved and later viewed in the 阅览 (preview) panel.
 * Economic data (stakes, balances, ledgers, etc.) is NOT included — export is
 * purely the discussion structure.
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
        createdBy: { select: { username: true } },
      },
    });

    // Fetch all RELATION messages and map to the Relation API shape
    const relationMessages = await prisma.message.findMany({
      where: {
        topicId,
        kind: 'RELATION',
        supersededBy: null,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        relationType: true,
        relSourceId: true,
        targetRefs: true,
        relationPayload: true,
        createdAt: true,
        createdBy: { select: { username: true } },
      },
    });

    const relations = relationMessages.map(m => ({
      id: m.id,
      relationType: m.relationType,
      sourceMessageId: m.relSourceId,
      targetRefs: m.targetRefs,
      payload: m.relationPayload,
      createdAt: m.createdAt,
      author: m.createdBy.username,
    }));

    const exportData = {
      exportedAt: new Date().toISOString(),
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
        author: m.createdBy.username,
        quoteSourceId: m.quoteSourceId,
        quotedText: m.quotedText,
        quotedTextHash: m.quotedTextHash,
        quoteContextBefore: m.quoteContextBefore,
        quoteContextAfter: m.quoteContextAfter,
      })),
      relations,
    };

    res.json(exportData);
  } catch (err) {
    next(err);
  }
});

export default exportRouter;
