import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, verifySignature, AuthRequest } from '../middleware/auth';
import { RELATION_TYPES } from '../lib/relationTypes';
import { applyEvent } from '../lib/events';
import { log } from '../lib/logger';
import { attentionUsersToJson, getAttentionUsersByTargetIds } from '../lib/attention';
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
  stakeAmount: z.number().int().min(0).optional(),
  payload: z.object({
    label: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    targetLayout: z.enum(['single-column', 'multi-column', 'single-row']).optional(),
    content: z.string().trim().min(1).max(50000).optional(),
    correctionContent: z.string().max(50000).optional(),
    subType: z.enum(['SPAM', 'OFFTOPIC', 'LOWVALUE', 'IMPORTANT', 'CUSTOM']).optional(),
    customLabel: z.string().trim().min(1).max(20).optional(),
    operationType: z.string().trim().min(1).max(80).optional(),
    amount: z.number().int().positive().optional(),
    revenuePoolShare: z.number().int().min(0).optional(),
    recipientUserId: z.string().trim().min(1).optional(),
    source: z.string().trim().min(1).max(200).optional(),
    note: z.string().max(2000).optional(),
    delegationKind: z.enum(['CREATE', 'FULFILL']).optional(),
    rewardAmount: z.number().int().positive().optional(),
    rewardRatio: z.number().int().positive().max(100).optional(),
    attentionUserIds: z.array(z.string().min(1)).max(100).optional(),
    notifyUserIds: z.array(z.string().min(1)).max(100).optional(),
  }).strict().optional(),
}).superRefine((data, ctx) => {
  if (data.relationType === 'TAG' && !(data.payload && data.payload.label)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '标注关系需要提供标签文本',
      path: ['payload', 'label'],
    });
  }
  if (data.relationType === 'CLASSIFY' && !data.sourceMessageId && !data.payload?.title) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '分类关系需要提供分类名称',
      path: ['payload', 'title'],
    });
  }
  if (data.relationType === 'SUMMARY' && !data.sourceMessageId && !data.payload?.title) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '总结关系需要提供总结内容标题',
      path: ['payload', 'title'],
    });
  }
  if ((data.relationType === 'PROPOSAL' || data.relationType === 'DELEGATION' || data.relationType === 'CODE_CHANGE' || data.relationType === 'OPERATIONS') && !data.payload?.content) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '提案/代码变更/运营关系需要提供内容',
      path: ['payload', 'content'],
    });
  }
  if (data.relationType === 'DELEGATION') {
    const kind = data.payload?.delegationKind;
    if (!kind) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '委托关系需要指定是创建委托还是完成委托', path: ['payload', 'delegationKind'] });
    } else if (kind === 'CREATE') {
      if (data.targetRefs.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '创建委托不能有目标关系消息', path: ['targetRefs'] });
      }
      if (data.payload?.rewardRatio !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '创建委托必须填写固定报酬数量，比例只能用于完成委托', path: ['payload', 'rewardRatio'] });
      }
      if (data.payload?.rewardAmount === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '创建委托需要填写报酬数量', path: ['payload', 'rewardAmount'] });
      }
    } else {
      if (data.targetRefs.length > 1 || (data.targetRefs.length === 1 && data.targetRefs[0]?.kind !== 'relation')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '完成委托最多目标一条委托关系消息', path: ['targetRefs'] });
      }
      if (data.payload?.rewardAmount !== undefined || data.payload?.rewardRatio !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '完成委托的报酬规则必须继承目标委托', path: ['payload'] });
      }
    }
  }
  if (data.relationType === 'NOTIFY' && data.targetRefs.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '通知关系需要至少一个目标消息', path: ['targetRefs'] });
  }
  if (data.relationType === 'CORRECT' && data.targetRefs.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '更正关系只能有一个目标',
      path: ['targetRefs'],
    });
  }
  if (data.relationType === 'CORRECT') {
    if (data.sourceMessageId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '更正关系不能有来源消息',
        path: ['sourceMessageId'],
      });
    }
    if (data.targetRefs.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '更正关系必须且只能有一个目标',
        path: ['targetRefs'],
      });
    }
    if (data.targetRefs[0]?.kind !== 'text-fragment') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '更正关系只能针对消息片段，不能针对整个消息',
        path: ['targetRefs'],
      });
    }
    if (data.payload?.correctionContent === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '更正关系需要提供替换内容（可以为空，表示删除）',
        path: ['payload', 'correctionContent'],
      });
    }
  }
});

const SOURCE_OPTIONAL_RELATION_TYPES = new Set(['AGREE', 'DISAGREE', 'ARRANGE', 'CORRECT', 'REPLY', 'NOTIFY', 'TAG', 'READ', 'UNREAD', 'CLASSIFY', 'MERGE', 'SUMMARY', 'RECOMMEND', 'ARCHIVE', 'ATTENTION', 'BLOCK', 'PROPOSAL', 'DELEGATION', 'CODE_CHANGE', 'OPERATIONS']);
const TARGET_OPTIONAL_RELATION_TYPES = new Set(['CLASSIFY', 'PROPOSAL', 'DELEGATION', 'CODE_CHANGE', 'OPERATIONS']);
const DECORATION_RELATION_TYPES = new Set(['AGREE', 'DISAGREE', 'TAG', 'READ', 'UNREAD', 'ANNOTATION', 'REFERENCE', 'REPLY', 'NOTIFY', 'CORRECT', 'RECOMMEND', 'ARCHIVE', 'ATTENTION', 'BLOCK']);

// Types that forbid sourceMessageId entirely (must be null)
const SOURCE_FORBIDDEN_RELATION_TYPES: Record<string, string> = {
  RECOMMEND: '推荐', ARCHIVE: '冷藏', ATTENTION: '关注', BLOCK: '拉黑',
  PROPOSAL: '提案', DELEGATION: '委托', CODE_CHANGE: '代码变更', OPERATIONS: '运营',
};
// Types that forbid targetRefs entirely (must be empty array)
const TARGET_FORBIDDEN_RELATION_TYPES: Record<string, string> = {};

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(20),
});

// ============================================================
// Routes
// ============================================================

// GET /api/topics/:topicId/relations
relationsRouter.get('/attention-users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;
    const topic = await prisma.topic.findUnique({ where: { id: topicId }, select: { id: true } });
    if (!topic) {
      res.status(404).json({ error: '分类不存在' });
      return;
    }
    const attentionUsers = await getAttentionUsersByTargetIds(topicId);
    res.json({ data: attentionUsersToJson(attentionUsers) });
  } catch (err) {
    next(err);
  }
});

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

    const notifyUserIds = new Set<string>();
    for (const message of messages) {
      if (message.relationType !== 'NOTIFY') continue;
      const payload = message.relationPayload as { notifyUserIds?: unknown } | null;
      if (!Array.isArray(payload?.notifyUserIds)) continue;
      for (const id of payload.notifyUserIds) {
        if (typeof id === 'string') notifyUserIds.add(id);
      }
    }
    const notifyUsers = notifyUserIds.size > 0
      ? await prisma.user.findMany({ where: { id: { in: [...notifyUserIds] } }, select: { id: true, username: true } })
      : [];
    const notifyUserById = new Map(notifyUsers.map(user => [user.id, user]));

    // Map unified Message rows back to the Relation API shape expected by the frontend.
    const relations = messages.map(m => ({
      id: m.id,
      topicId: m.topicId,
      relationType: m.relationType!,
      sourceMessageId: m.relSourceId ?? null,
      targetRefs: m.targetRefs,
      payload: m.relationType === 'NOTIFY' && m.relationPayload
        ? {
            ...(m.relationPayload as Record<string, unknown>),
            notifyUsers: Array.isArray((m.relationPayload as { notifyUserIds?: unknown }).notifyUserIds)
              ? ((m.relationPayload as { notifyUserIds: unknown[] }).notifyUserIds)
                  .filter((id): id is string => typeof id === 'string')
                  .map(id => notifyUserById.get(id))
                  .filter((user): user is { id: string; username: string } => Boolean(user))
              : [],
          }
        : m.relationPayload ?? undefined,
      createdAt: m.createdAt,
      createdBy: m.createdBy,
    }));

    log('rel-query', `GET topic=${topicId.slice(-6)} total=${total} msgs=[${messages.map(m=>`${m.id.slice(-6)}:${m.relationType}`).join(',')}]`);
    res.json({
      data: relations,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/topics/:topicId/relations/:id — update targetRefs in-place
// Unlike the POST / supersede flow, this does NOT create a new message record.
// Used for operations like adding/removing targets from a CLASSIFY without
// changing the relation's ID, so external references (stance records, etc.)
// remain valid.
relationsRouter.patch('/:id', requireAuth, verifySignature, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const topicId = req.params.topicId as string;
    const relationId = req.params.id as string;
    const { targetRefs } = req.body as { targetRefs?: Array<{ kind?: string; messageId?: string; relationId?: string }> };

    const existing = await prisma.message.findFirst({
      where: { id: relationId, topicId, kind: { in: ['RELATION', 'GOVERNANCE', 'CODE'] }, supersededBy: null },
    });
    if (!existing) {
      res.status(404).json({ error: '关系不存在、不属于该分类或已被取代' });
      return;
    }

    if (!targetRefs || !Array.isArray(targetRefs)) {
      res.status(400).json({ error: 'targetRefs 是必需的数组字段' });
      return;
    }

    // Validate new target refs exist in this topic
    const targetMessageIds = targetRefs
      .filter((r: any) => r.kind === 'message' || r.kind === 'text-fragment')
      .map((r: any) => r.messageId);
    const targetRelationIds = targetRefs
      .filter((r: any) => r.kind === 'relation')
      .map((r: any) => r.relationId);

    if (targetMessageIds.length > 0) {
      const found = await prisma.message.count({
        where: { id: { in: [...new Set(targetMessageIds)] }, topicId },
      });
      if (found !== new Set(targetMessageIds).size) {
        res.status(404).json({ error: '部分目标消息不存在或不属于该分类' });
        return;
      }
    }
    if (targetRelationIds.length > 0) {
      const found = await prisma.message.count({
        where: { id: { in: [...new Set(targetRelationIds)] }, topicId, kind: { in: ['RELATION', 'GOVERNANCE', 'CODE'] } },
      });
      if (found !== new Set(targetRelationIds).size) {
        res.status(404).json({ error: '部分目标关系消息不存在或不属于该分类' });
        return;
      }
    }

    const updated = await applyEvent({
      type: 'RELATION_TARGETS_UPDATED',
      actorId: req.user!.id,
      topicId,
      payload: {
        relationId,
        targetRefs: targetRefs as any,
        previousTargetRefs: existing.targetRefs as any,
      },
    }) as any;

    res.json({
      id: updated.id,
      topicId: updated.topicId,
      relationType: updated.relationType!,
      sourceMessageId: updated.relSourceId ?? null,
      targetRefs: updated.targetRefs,
      payload: updated.relationPayload ?? undefined,
      createdAt: updated.createdAt,
      createdBy: updated.createdBy,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/topics/:topicId/relations
relationsRouter.post('/', requireAuth, verifySignature, async (req: AuthRequest, res: Response, next: NextFunction) => {
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

    // Source-forbidden types: must not provide a sourceMessageId
    if (data.relationType in SOURCE_FORBIDDEN_RELATION_TYPES && data.sourceMessageId) {
      res.status(400).json({ error: `${SOURCE_FORBIDDEN_RELATION_TYPES[data.relationType]}关系不应提供来源消息 ID` });
      return;
    }

    // Target-forbidden types: must not provide targetRefs
    if (data.relationType in TARGET_FORBIDDEN_RELATION_TYPES) {
      if (data.targetRefs.length > 0) {
        res.status(400).json({ error: `${TARGET_FORBIDDEN_RELATION_TYPES[data.relationType]}关系不应提供目标引用` });
        return;
      }
    } else if (!TARGET_OPTIONAL_RELATION_TYPES.has(data.relationType) && data.targetRefs.length === 0) {
      res.status(400).json({ error: '至少需要一个目标引用' });
      return;
    }
    if (data.sourceMessageId) {
      const sourceMessage = await prisma.message.findFirst({
        where: { id: data.sourceMessageId, topicId },
      });
      if (!sourceMessage) {
        res.status(404).json({ error: '来源消息不存在或不属于该分类' });
        return;
      }
      if (data.relationType === 'JOIN' && (
        sourceMessage.kind !== 'RELATION'
        || !['CLASSIFY', 'SUMMARY', 'ARRANGE', 'MERGE'].includes(sourceMessage.relationType ?? '')
      )) {
        res.status(400).json({ error: '加入消息的来源必须是分类、总结、排列或归并容器消息' });
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

    // Validate target messages exist in this topic (any kind, including RELATION for AGREE/DISAGREE stances)
    if (targetMessageIds.length > 0) {
      const uniqueMessageIds = [...new Set(targetMessageIds)];
      const foundMessages = await prisma.message.findMany({
        where: { id: { in: uniqueMessageIds }, topicId },
        select: { id: true, kind: true, relationType: true },
      });
      if (foundMessages.length !== uniqueMessageIds.length) {
        res.status(404).json({ error: '部分目标消息不存在或不属于该分类' });
        return;
      }
      if (data.relationType === 'CORRECT') {
        const correctableRelationTypes = new Set(['CLASSIFY', 'SUMMARY', 'PROPOSAL', 'DELEGATION', 'CODE_CHANGE', 'OPERATIONS']);
        const invalidMessage = foundMessages.find(message =>
          message.kind !== 'TEXT'
          && !(message.kind === 'RELATION' && correctableRelationTypes.has(message.relationType ?? ''))
        );
        if (invalidMessage) {
          res.status(400).json({ error: '更正关系只能指向文本消息或允许更正的关系消息' });
          return;
        }
      }
      if (data.relationType === 'JOIN') {
        const invalidTarget = foundMessages.find(message =>
          message.kind === 'RELATION' && DECORATION_RELATION_TYPES.has(message.relationType ?? '')
        );
        if (invalidTarget) {
          res.status(400).json({ error: '加入消息的目标不能是绑定在其他消息上的装饰关系消息' });
          return;
        }
      }
    }

    // Validate target relation messages exist in this topic (kind=RELATION/GOVERNANCE/CODE/OPERATIONS)
    let foundTargetRelations: Array<{ id: string; relationType: string | null; targetRefs: unknown }> = [];
    if (targetRelationIds.length > 0) {
      const uniqueRelationIds = [...new Set(targetRelationIds)];
      const directTargetRelations = await prisma.message.findMany({
        where: { id: { in: uniqueRelationIds }, topicId, kind: { in: ['RELATION', 'GOVERNANCE', 'CODE', 'OPERATIONS'] } },
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

      if (data.relationType === 'CORRECT') {
        const correctableRelationTypes = new Set(['CLASSIFY', 'SUMMARY', 'PROPOSAL', 'DELEGATION', 'CODE_CHANGE', 'OPERATIONS']);
        const target = foundTargetRelations.find(relation => relation.id === targetRelationIds[0]);
        if (!target || !correctableRelationTypes.has(target.relationType ?? '')) {
          res.status(400).json({ error: '更正关系只能指向分类、总结、提案、委托、代码或运营消息' });
          return;
        }
      }
      if (data.relationType === 'JOIN') {
        const invalidTarget = directTargetRelations.find(relation => DECORATION_RELATION_TYPES.has(relation.relationType ?? ''));
        if (invalidTarget) {
          res.status(400).json({ error: '加入消息的目标不能是绑定在其他消息上的装饰关系消息' });
          return;
        }
      }

      if (data.relationType === 'DELEGATION' && data.payload?.delegationKind === 'FULFILL') {
        const target = foundTargetRelations.find(rel => rel.id === targetRelationIds[0]);
        if (!target || target.relationType !== 'DELEGATION') {
          res.status(400).json({ error: '完成委托的目标必须是委托关系消息' });
          return;
        }
      }
    }

    // CLASSIFY, MERGE, and SUMMARY: validate grouping targets.
    // SUMMARY target-type check and cross-link BFS are delegated to the
    // crossLinkValidator module to keep the route handler lean.
    if (data.relationType === 'CLASSIFY' || data.relationType === 'MERGE' || data.relationType === 'ARRANGE' || data.relationType === 'SUMMARY') {
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

    // A container/member pair has one canonical JOIN record. Re-adding the
    // same target must support that record instead of creating a duplicate
    // membership record that could compete in the JOIN stack.
    let relationTypeToCreate = data.relationType;
    let targetRefsToCreate = data.targetRefs;
    if (data.relationType === 'JOIN' && data.targetRefs.length === 1) {
      const targetRef = data.targetRefs[0];
      const existingJoins = await prisma.message.findMany({
        where: {
          topicId,
          kind: 'RELATION',
          relationType: 'JOIN',
          relSourceId: data.sourceMessageId ?? null,
          supersededBy: null,
        },
        select: { id: true, targetRefs: true },
      });
      const sameTarget = existingJoins.find(join => {
        const existingTarget = (join.targetRefs as Array<Record<string, unknown>> | null)?.[0];
        if (!existingTarget || existingTarget.kind !== targetRef.kind) return false;
        return targetRef.kind === 'relation'
          ? existingTarget.relationId === targetRef.relationId
          : existingTarget.messageId === targetRef.messageId;
      });
      if (sameTarget) {
        relationTypeToCreate = 'AGREE';
        targetRefsToCreate = [{ kind: 'relation', relationId: sameTarget.id }];
      }
    }

    if (data.relationType === 'PROPOSAL' && data.payload?.operationType === 'RECHARGE') {
      const recipientUserId = data.payload.recipientUserId;
      if (!recipientUserId) {
        res.status(400).json({ error: '充值分账提案必须指定用户' });
        return;
      }
      const recipient = await prisma.user.findUnique({
        where: { id: recipientUserId },
        select: { id: true },
      });
      if (!recipient) {
        res.status(400).json({ error: `指定用户不存在：${recipientUserId}` });
        return;
      }
    }

    if (data.relationType === 'NOTIFY') {
      const targetMessageIds = data.targetRefs
        .filter(ref => ref.kind === 'message' || ref.kind === 'text-fragment')
        .map(ref => ref.messageId);
      const attentionUsers = await getAttentionUsersByTargetIds(topicId, targetMessageIds);
      if (targetMessageIds.length === 0 || !targetMessageIds.every(id => (attentionUsers.get(id)?.size ?? 0) > 0)) {
        res.status(400).json({ error: '通知目标没有关注用户，无法发送通知' });
        return;
      }
    }

    // Validate supersedesRelationId BEFORE any write, so we don't leave orphans.
    if (data.supersedesRelationId) {
      const oldRel = await prisma.message.findFirst({
        where: { id: data.supersedesRelationId, topicId, kind: { in: ['RELATION', 'GOVERNANCE', 'CODE'] } },
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
    // PROPOSAL / CODE_CHANGE / OPERATIONS: create a GOVERNANCE / CODE / OPERATIONS
    // message (with relation fields) instead of a RELATION message.
    const isGovernanceRelation = relationTypeToCreate === 'PROPOSAL' || relationTypeToCreate === 'CODE_CHANGE' || relationTypeToCreate === 'OPERATIONS';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let message: any;
    if (isGovernanceRelation) {
      const messageKind = data.relationType === 'PROPOSAL' ? 'GOVERNANCE' as const
        : data.relationType === 'CODE_CHANGE' ? 'CODE' as const
        : 'OPERATIONS' as const;
      message = await applyEvent({
        type: 'MESSAGE_CREATED',
        actorId: req.user!.id,
        topicId,
        payload: {
          kind: messageKind,
          content: (relationPayload as Record<string, unknown>)?.content as string ?? '',
          contentType: 'MARKDOWN' as const,
          stakeAmount: data.stakeAmount,
          relationType: relationTypeToCreate,
          sourceMessageId: data.sourceMessageId ?? null,
          targetRefs: targetRefsToCreate,
          relationPayload: (relationPayload ?? undefined) as Record<string, unknown> | undefined,
        },
      });
    } else {
      message = await applyEvent({
        type: 'RELATION_CREATED',
        actorId: req.user!.id,
        topicId,
        payload: {
          relationType: relationTypeToCreate,
          sourceMessageId: data.sourceMessageId ?? null,
          targetRefs: targetRefsToCreate,
          relationPayload: (relationPayload ?? undefined) as Record<string, unknown> | undefined,
          supersedesRelationId: data.supersedesRelationId ?? null,
          stakeAmount: data.stakeAmount,
        },
      });
    }

    log('rel-create', `POST type=${relationTypeToCreate} msg=${message.id.slice(-6)} kind=${message.kind}`);
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
