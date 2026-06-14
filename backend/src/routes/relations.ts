import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { RELATION_TYPES } from '../lib/relationTypes';
import { applyEvent } from '../lib/events';
import {
  extractTextTargetIds,
  extractNestedRelationIds,
  validateGroupingTargets,
} from '../lib/crossLinkValidator';

const relationsRouter = Router({ mergeParams: true });

// ============================================================
// Validation Schemas
// ============================================================

// RELATION_TYPES is imported from lib/relationTypes.ts.
// To add a new relation type, update that file — no changes needed here.

/**
 * TargetRef - a discriminated union for what a relation points to.
 *
 * 'message'       - targets a whole text message
 * 'text-fragment' - targets a specific fragment of a text message
 * 'relation'      - targets a relation message (or a specific selectable part of it)
 *
 * Sources (relSourceId) can be any message (TEXT or RELATION kind) in this topic.
 * Targets can be text messages, fragments, OR relation messages.
 */
const targetRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    messageId: z.string().min(1, '消息 ID 不能为空'),
  }),
  z.object({
    kind: z.literal('text-fragment'),
    messageId: z.string().min(1, '消息 ID 不能为空'),
    text: z.string().min(1).max(2000),
    hash: z.string().min(1),
    contextBefore: z.string().max(200).optional(),
    contextAfter: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal('relation'),
    relationId: z.string().min(1, '关系消息 ID 不能为空'),
    part: z.enum(['label', 'decoration', 'frame', 'whole']).optional(),
  }),
]);

const createRelationSchema = z.object({
  relationType: z.enum(RELATION_TYPES, {
    errorMap: () => ({ message: `关系类型必须是以下之一: ${RELATION_TYPES.join(', ')}` }),
  }),
  sourceMessageId: z.string().min(1, '来源消息 ID 不能为空').nullable().optional(),
  targetRefs: z.array(targetRefSchema).max(200),
  supersedesRelationId: z.string().nullable().optional(),
  stakeAmount: z.number().int().min(1).optional(),
  payload: z.object({
    label: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    targetLayout: z.enum(['single-column', 'multi-column', 'single-row']).optional(),
  }).strict().optional(),
}).superRefine((data, ctx) => {
  if (data.relationType === 'TAG' && !(data.payload && data.payload.label)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '标注关系需要提供标签文本',
      path: ['payload', 'label'],
    });
  }
  if (data.relationType === 'CLASSIFY' && !data.payload?.title) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '分类关系需要提供分类名称',
      path: ['payload', 'title'],
    });
  }
  if (data.relationType === 'SUMMARY' && !data.payload?.title) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '总结关系需要提供总结内容标题',
      path: ['payload', 'title'],
    });
  }
});

const SOURCE_OPTIONAL_RELATION_TYPES = new Set(['AGREE', 'DISAGREE', 'ARRANGE', 'CORRECT', 'REPLY', 'TAG', 'CLASSIFY', 'MERGE', 'SUMMARY', 'RECOMMEND', 'ARCHIVE']);
const TARGET_OPTIONAL_RELATION_TYPES = new Set(['CLASSIFY']);

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(20),
});

// ============================================================
// Routes
// ============================================================

// GET /api/topics/:topicId/relations
relationsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;
    const { page, limit } = paginationSchema.parse(req.query);
    const skip = (page - 1) * limit;

    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic) {
      res.status(404).json({ error: '分类不存在' });
      return;
    }

    // Relation messages are stored in the unified Message table with kind=RELATION.
    const [total, messages] = await Promise.all([
      prisma.message.count({ where: { topicId, kind: 'RELATION', supersededBy: null } }),
      prisma.message.findMany({
        where: { topicId, kind: 'RELATION', supersededBy: null },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: { createdBy: { select: { id: true, username: true } } },
      }),
    ]);

    // Map unified Message rows back to the Relation API shape expected by the frontend.
    const relations = messages.map(m => ({
      id: m.id,
      topicId: m.topicId,
      relationType: m.relationType!,
      sourceMessageId: m.relSourceId ?? null,
      targetRefs: m.targetRefs,
      payload: m.relationPayload ?? undefined,
      createdAt: m.createdAt,
      createdBy: m.createdBy,
    }));

    res.json({
      data: relations,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/topics/:topicId/relations
relationsRouter.post('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;
    const data = createRelationSchema.parse(req.body);

    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic) {
      res.status(404).json({ error: '分类不存在' });
      return;
    }
    if (topic.status === 'ARCHIVED') {
      res.status(403).json({ error: '该分类已归档，不允许建立新关系' });
      return;
    }

    // Relation types that require a source message (non-stance types and TAG which needs content)
    // AGREE/DISAGREE: optional (pure-stance declaration without text)
    // ARRANGE: always null source — user-to-message relation; arranged messages are targets, not a source
    // CORRECT: optional (can be used to mark a relation message as needing correction without a source text)
    // REPLY: optional (can express a pure-stance reply to a relation message without source text)
    // TAG: optional (user-to-message relation; label text is stored in tagLabel instead of sourceMessageId)
    const requiresSource = !SOURCE_OPTIONAL_RELATION_TYPES.has(data.relationType);

    if (requiresSource && !data.sourceMessageId) {
      res.status(400).json({ error: '该关系类型需要提供来源消息 ID' });
      return;
    }

    if (!TARGET_OPTIONAL_RELATION_TYPES.has(data.relationType) && data.targetRefs.length === 0) {
      res.status(400).json({ error: '至少需要一个目标引用' });
      return;
    }

    // CLASSIFY, MERGE, SUMMARY, and ARRANGE are user-to-message relations: no source text message.
    // For ARRANGE: the arranged text messages are stored as targets, not sources.
    const noSourceRelTypeNames: Record<string, string> = {
      CLASSIFY: '分类', MERGE: '归并', SUMMARY: '总结', ARRANGE: '排列',
      RECOMMEND: '推荐', ARCHIVE: '冷藏',
    };
    if (data.relationType in noSourceRelTypeNames && data.sourceMessageId) {
      res.status(400).json({ error: `${noSourceRelTypeNames[data.relationType]}关系不应提供来源消息 ID` });
      return;
    }
    // sourceMessageId can reference ANY message in this topic (TEXT or RELATION kind),
    // because relation messages are also messages — a single unified table lookup suffices.
    if (data.sourceMessageId) {
      const sourceMessage = await prisma.message.findFirst({
        where: { id: data.sourceMessageId, topicId },
      });
      if (!sourceMessage) {
        res.status(404).json({ error: '来源消息不存在或不属于该分类' });
        return;
      }
    }

    // Validate all target refs
    const targetMessageIds = data.targetRefs
      .filter(r => r.kind === 'message' || r.kind === 'text-fragment')
      .map(r => (r as { kind: 'message' | 'text-fragment'; messageId: string }).messageId);

    const targetRelationIds = data.targetRefs
      .filter(r => r.kind === 'relation')
      .map(r => (r as { kind: 'relation'; relationId: string }).relationId);

    // CLASSIFY supports empty targets and relation-message targets (e.g., topic-to-topic grouping).

    // Check for duplicate target IDs
    const allTargetIds = [...targetMessageIds, ...targetRelationIds];
    if (new Set(allTargetIds).size !== allTargetIds.length) {
      res.status(400).json({ error: 'targetRefs 中存在重复的目标 ID' });
      return;
    }

    // Validate target text messages exist in this topic (kind=TEXT)
    if (targetMessageIds.length > 0) {
      const uniqueMessageIds = [...new Set(targetMessageIds)];
      const foundMessages = await prisma.message.findMany({
        where: { id: { in: uniqueMessageIds }, topicId, kind: 'TEXT' },
        select: { id: true },
      });
      if (foundMessages.length !== uniqueMessageIds.length) {
        res.status(404).json({ error: '部分目标消息不存在或不属于该分类' });
        return;
      }
    }

    // Validate target relation messages exist in this topic (kind=RELATION)
    let foundTargetRelations: Array<{ id: string; relationType: string | null; targetRefs: unknown }> = [];
    if (targetRelationIds.length > 0) {
      const uniqueRelationIds = [...new Set(targetRelationIds)];
      const directTargetRelations = await prisma.message.findMany({
        where: { id: { in: uniqueRelationIds }, topicId, kind: 'RELATION' },
        select: { id: true, relationType: true, targetRefs: true },
      });
      if (directTargetRelations.length !== uniqueRelationIds.length) {
        res.status(404).json({ error: '部分目标关系消息不存在或不属于该分类' });
        return;
      }

      // Expand nested relation-message targets for grouping relations so CLASSIFY/MERGE can
      // treat ARRANGE/MERGE/CLASSIFY target relations as their owned text targets.
      const relationById = new Map<string, { id: string; relationType: string | null; targetRefs: unknown }>();
      directTargetRelations.forEach(rel => relationById.set(rel.id, rel));
      const expandableRelationTypes = new Set(['CLASSIFY', 'MERGE', 'ARRANGE', 'SUMMARY']);
      const queued = new Set<string>();
      const queue: string[] = [];
      const enqueue = (id: string) => {
        if (queued.has(id)) return;
        queued.add(id);
        queue.push(id);
      };
      directTargetRelations
        .filter(rel => expandableRelationTypes.has(rel.relationType ?? ''))
        .forEach(rel => enqueue(rel.id));

      while (queue.length > 0) {
        const relId = queue.shift()!;
        const rel = relationById.get(relId);
        if (!rel || !expandableRelationTypes.has(rel.relationType ?? '')) continue;
        const nestedRelationIds = extractNestedRelationIds(rel.targetRefs).filter(id => !relationById.has(id));
        if (nestedRelationIds.length === 0) continue;
        const nestedRelations = await prisma.message.findMany({
          where: { id: { in: nestedRelationIds }, topicId, kind: 'RELATION' },
          select: { id: true, relationType: true, targetRefs: true },
        });
        nestedRelations.forEach(nestedRel => {
          relationById.set(nestedRel.id, nestedRel);
          enqueue(nestedRel.id);
        });
      }

      foundTargetRelations = [...relationById.values()];
    }

    // CLASSIFY, MERGE, and SUMMARY: validate grouping targets.
    // SUMMARY target-type check and cross-link BFS are delegated to the
    // crossLinkValidator module to keep the route handler lean.
    if (data.relationType === 'CLASSIFY' || data.relationType === 'MERGE' || data.relationType === 'SUMMARY') {
      const validationResult = await validateGroupingTargets({
        topicId,
        relationType: data.relationType,
        targetRefs: data.targetRefs,
        targetRelationIds,
        foundTargetRelations,
      });
      if (!validationResult.ok) {
        res.status(400).json({ error: validationResult.error });
        return;
      }
    }

    const relationPayload =
      (data.relationType === 'MERGE' || data.relationType === 'SUMMARY') && !data.payload?.targetLayout
        ? { ...data.payload, targetLayout: 'multi-column' as const }
        : data.payload;

    // Validate supersedesRelationId BEFORE any write, so we don't leave orphans.
    if (data.supersedesRelationId) {
      const oldRel = await prisma.message.findFirst({
        where: { id: data.supersedesRelationId, topicId, kind: 'RELATION' },
      });
      if (!oldRel) {
        res.status(404).json({ error: '被取代的关系消息不存在或不属于该分类' });
        return;
      }
      if (oldRel.relationType !== data.relationType) {
        res.status(400).json({ error: '被取代的关系类型必须与新关系一致' });
        return;
      }
      if (oldRel.supersededBy) {
        res.status(400).json({ error: '该关系已被取代，不可重复取代' });
        return;
      }
    }

    // Apply the event — state write + audit log on critical path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message: any = await applyEvent({
      type: 'RELATION_CREATED',
      actorId: req.user!.id,
      topicId,
      payload: {
        relationType: data.relationType,
        sourceMessageId: data.sourceMessageId ?? null,
        targetRefs: data.targetRefs,
        relationPayload: (relationPayload ?? undefined) as Record<string, unknown> | undefined,
        supersedesRelationId: data.supersedesRelationId ?? null,
        stakeAmount: data.stakeAmount,
      },
    });

    // Return in the Relation API shape expected by the frontend.
    res.status(201).json({
      id: message.id,
      topicId: message.topicId,
      relationType: message.relationType!,
      sourceMessageId: message.relSourceId ?? null,
      targetRefs: message.targetRefs,
      payload: message.relationPayload ?? undefined,
      createdAt: message.createdAt,
      createdBy: message.createdBy,
    });
  } catch (err) {
    next(err);
  }
});

export default relationsRouter;
