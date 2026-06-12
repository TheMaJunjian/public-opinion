/**
 * events.ts — Event-sourcing foundation for all state mutations.
 *
 * Designdoc: Phase 7 Stage 1 — 事件化 Web 原型
 *   - 所有关键动作写 AuditLog（含完整 payload，可回放）
 *   - 状态写入 + 审计日志在 prisma.$transaction 中原子执行
 *   - applyEvent() is the SINGLE write path
 */
import { prisma } from './prisma';
import { Prisma } from '@prisma/client';

// ============================================================
// Event Type Definitions
// ============================================================

export interface UserRegisteredEvent {
  type: 'USER_REGISTERED';
  actorId: string;
  payload: {
    username: string;
    passwordHash: string;
  };
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

async function applyUserRegistered(event: UserRegisteredEvent) {
  const { actorId, payload } = event;

  const [user] = await prisma.$transaction([
    prisma.user.create({
      data: {
        id: actorId,
        username: payload.username,
        password: payload.passwordHash,
      },
      select: { id: true, username: true, createdAt: true },
    }),
    prisma.auditLog.create({
      data: {
        actorId,
        action: 'USER_REGISTERED',
        entityType: 'User',
        entityId: actorId,
        data: { username: payload.username },
      },
    }),
  ]);

  return user;
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

  const [topic] = await prisma.$transaction([
    prisma.topic.update({
      where: { id: topicId },
      data: { status: payload.status },
      include: { createdBy: { select: { id: true, username: true } } },
    }),
    prisma.auditLog.create({
      data: {
        actorId,
        action: payload.status === 'ARCHIVED' ? 'TOPIC_ARCHIVED' : 'TOPIC_REOPENED',
        entityType: 'Topic',
        entityId: topicId,
        topicId,
        data: { status: payload.status },
      },
    }),
  ]);

  return topic;
}

async function applyMessageCreated(event: MessageCreatedEvent) {
  const { actorId, topicId, payload } = event;

  const [message] = await prisma.$transaction([
    prisma.message.create({
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
    }),
    prisma.auditLog.create({
      data: {
        actorId,
        action: 'MESSAGE_CREATED',
        entityType: 'Message',
        entityId: '',
        topicId,
        data: {
          kind: 'TEXT',
          contentType: payload.contentType ?? 'TEXT',
          content: payload.content,
          quoteSourceId: payload.quoteSourceId,
          quotedTextHash: payload.quotedTextHash,
        },
      },
    }),
  ]);

  await prisma.auditLog.updateMany({
    where: { action: 'MESSAGE_CREATED', entityId: '', actorId, topicId },
    data: { entityId: message.id },
  });

  return message;
}

async function applyRelationCreated(event: RelationCreatedEvent) {
  const { actorId, topicId, payload } = event;

  const [message] = await prisma.$transaction([
    prisma.message.create({
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
    }),
    prisma.auditLog.create({
      data: {
        actorId,
        action: payload.supersedesRelationId ? 'RELATION_SUPERSEDED' : 'RELATION_CREATED',
        entityType: 'Relation',
        entityId: '',
        topicId,
        data: {
          relationType: payload.relationType,
          sourceMessageId: payload.sourceMessageId,
          supersedesRelationId: payload.supersedesRelationId,
          targetRefs: payload.targetRefs as Prisma.InputJsonValue,
          relationPayload: payload.relationPayload as Prisma.InputJsonValue | undefined,
        },
      },
    }),
  ]);

  if (payload.supersedesRelationId) {
    await prisma.message.update({
      where: { id: payload.supersedesRelationId },
      data: { supersededBy: message.id },
    });
  }

  await prisma.auditLog.updateMany({
    where: {
      action: payload.supersedesRelationId ? 'RELATION_SUPERSEDED' : 'RELATION_CREATED',
      entityId: '', actorId, topicId,
    },
    data: { entityId: message.id },
  });

  return message;
}
