/**
 * events.ts — Event-sourcing foundation for all state mutations.
 *
 * Designdoc: Phase 7 Stage 1 — 事件化 Web 原型
 *   - 所有关键动作写 AuditLog（含完整 payload，可回放）
 *   - 审计日志在关键路径上：失败 = 请求失败
 *   - 不允许直接改最终状态
 *
 * applyEvent() is the SINGLE write path. Routes do validation only,
 * then delegate to applyEvent() which writes state + audit log.
 *
 * TODO(Phase 7 Stage 2): wrap state + audit in prisma.$transaction
 * for atomicity once test infrastructure supports it.
 */
import { prisma } from './prisma';
import { Prisma } from '@prisma/client';

// ============================================================
// Event Type Definitions
// ============================================================

export interface UserRegisteredEvent {
  type: 'USER_REGISTERED';
  actorId: string;
  payload: { username: string };
}

export interface TopicCreatedEvent {
  type: 'TOPIC_CREATED';
  actorId: string;
  payload: { title: string; body?: string | null };
}

export interface TopicStatusChangedEvent {
  type: 'TOPIC_STATUS_CHANGED';
  actorId: string;
  topicId: string;
  payload: { status: 'ARCHIVED' | 'OPEN' };
}

export interface MessageCreatedEvent {
  type: 'MESSAGE_CREATED';
  actorId: string;
  topicId: string;
  payload: {
    contentType?: 'TEXT' | 'MARKDOWN';
    content: string;
    quoteSourceId?: string | null;
    quotedText?: string | null;
    quotedTextHash?: string | null;
    quoteContextBefore?: string | null;
    quoteContextAfter?: string | null;
  };
}

export interface RelationCreatedEvent {
  type: 'RELATION_CREATED';
  actorId: string;
  topicId: string;
  payload: {
    relationType: string;
    sourceMessageId?: string | null;
    targetRefs: unknown[];
    relationPayload?: Record<string, unknown> | null;
    supersedesRelationId?: string | null;
  };
}

export type AppEvent =
  | UserRegisteredEvent
  | TopicCreatedEvent
  | TopicStatusChangedEvent
  | MessageCreatedEvent
  | RelationCreatedEvent;

// ============================================================
// Apply Event — the single write path
// ============================================================

/**
 * Apply an event: write state + write audit log in a single transaction.
 * Returns the primary created/updated entity for the route to respond with.
 */
export async function applyEvent(event: AppEvent): Promise<unknown> {
  switch (event.type) {
    case 'USER_REGISTERED':
      return applyUserRegistered(event);
    case 'TOPIC_CREATED':
      return applyTopicCreated(event);
    case 'TOPIC_STATUS_CHANGED':
      return applyTopicStatusChanged(event);
    case 'MESSAGE_CREATED':
      return applyMessageCreated(event);
    case 'RELATION_CREATED':
      return applyRelationCreated(event);
  }
}

// ── Handlers ─────────────────────────────────────────────────
// State write and audit log are on the critical path.
// $transaction is deferred for now; sequential writes are acceptable
// for Phase 1 single-server deployment. The key invariant is that
// audit log failure = request failure (no .catch(), no fire-and-forget).

async function applyUserRegistered(event: UserRegisteredEvent) {
  const { actorId, payload } = event;
  // User already created by auth route (needs bcrypt hash first).
  await prisma.auditLog.create({
    data: {
      actorId,
      action: 'USER_REGISTERED',
      entityType: 'User',
      entityId: actorId,
      data: { username: payload.username },
    },
  });
  return null;
}

async function applyTopicCreated(event: TopicCreatedEvent) {
  const { actorId, payload } = event;

  const topic = await prisma.topic.create({
    data: { title: payload.title, body: payload.body, createdById: actorId },
    include: { createdBy: { select: { id: true, username: true } } },
  });

  await prisma.auditLog.create({
    data: {
      actorId,
      action: 'TOPIC_CREATED',
      entityType: 'Topic',
      entityId: topic.id,
      topicId: topic.id,
      data: { title: topic.title, body: topic.body },
    },
  });

  return topic;
}

async function applyTopicStatusChanged(event: TopicStatusChangedEvent) {
  const { actorId, topicId, payload } = event;

  const topic = await prisma.topic.update({
    where: { id: topicId },
    data: { status: payload.status },
    include: { createdBy: { select: { id: true, username: true } } },
  });

  await prisma.auditLog.create({
    data: {
      actorId,
      action: payload.status === 'ARCHIVED' ? 'TOPIC_ARCHIVED' : 'TOPIC_REOPENED',
      entityType: 'Topic',
      entityId: topic.id,
      topicId: topic.id,
      data: { status: payload.status },
    },
  });

  return topic;
}

async function applyMessageCreated(event: MessageCreatedEvent) {
  const { actorId, topicId, payload } = event;

  const message = await prisma.message.create({
    data: {
      topicId,
      createdById: actorId,
      kind: 'TEXT',
      contentType: payload.contentType ?? 'TEXT',
      content: payload.content,
      quoteSourceId: payload.quoteSourceId ?? null,
      quotedText: payload.quotedText ?? null,
      quotedTextHash: payload.quotedTextHash ?? null,
      quoteContextBefore: payload.quoteContextBefore ?? null,
      quoteContextAfter: payload.quoteContextAfter ?? null,
    },
    include: { createdBy: { select: { id: true, username: true } } },
  });

  await prisma.auditLog.create({
    data: {
      actorId,
      action: 'MESSAGE_CREATED',
      entityType: 'Message',
      entityId: message.id,
      topicId,
      data: {
        kind: 'TEXT',
        contentType: payload.contentType ?? 'TEXT',
        content: payload.content,
        quoteSourceId: payload.quoteSourceId,
        quotedTextHash: payload.quotedTextHash,
      },
    },
  });

  return message;
}

async function applyRelationCreated(event: RelationCreatedEvent) {
  const { actorId, topicId, payload } = event;

  const message = await prisma.message.create({
    data: {
      topicId,
      createdById: actorId,
      kind: 'RELATION',
      relationType: payload.relationType,
      relSourceId: payload.sourceMessageId ?? null,
      targetRefs: payload.targetRefs as Prisma.InputJsonValue,
      relationPayload: (payload.relationPayload ?? undefined) as Prisma.InputJsonValue | undefined,
      content: null,
    },
    include: { createdBy: { select: { id: true, username: true } } },
  });

  // If superseding an older relation, mark it as superseded.
  if (payload.supersedesRelationId) {
    await prisma.message.update({
      where: { id: payload.supersedesRelationId },
      data: { supersededBy: message.id },
    });
  }

  await prisma.auditLog.create({
    data: {
      actorId,
      action: payload.supersedesRelationId ? 'RELATION_SUPERSEDED' : 'RELATION_CREATED',
      entityType: 'Relation',
      entityId: message.id,
      topicId,
      data: {
        relationType: payload.relationType,
        sourceMessageId: payload.sourceMessageId,
        supersedesRelationId: payload.supersedesRelationId,
        targetRefs: payload.targetRefs as Prisma.InputJsonValue,
        relationPayload: payload.relationPayload as Prisma.InputJsonValue | undefined,
      },
    },
  });

  return message;
}
