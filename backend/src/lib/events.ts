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
    stakeAmount?: number; // Phase 2: override selfStakeOnCreate
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

export interface PointMintedEvent {
  type: 'POINT_MINTED';
  actorId: string;
  payload: {
    amount: number;
    reason: string; // 'REGISTRATION_BONUS' | 'CONTENT_REWARD' | etc.
    note?: string;
  };
}

export interface PointTransferredEvent {
  type: 'POINT_TRANSFERRED';
  actorId: string;
  payload: {
    fromUserId: string;
    toUserId: string;
    amount: number;
    note?: string;
  };
}

export interface StakePlacedEvent {
  type: 'STAKE_PLACED';
  actorId: string;
  topicId: string;
  payload: {
    messageId: string;
    side: 'PRO' | 'CON';
    amount: number;
    roundId?: string | null;
  };
}

export type AppEvent =
  | UserRegisteredEvent
  | TopicCreatedEvent
  | TopicStatusChangedEvent
  | MessageCreatedEvent
  | RelationCreatedEvent
  | PointMintedEvent
  | PointTransferredEvent
  | StakePlacedEvent;

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
    case 'POINT_MINTED':
      return applyPointMinted(event);
    case 'POINT_TRANSFERRED':
      return applyPointTransferred(event);
    case 'STAKE_PLACED':
      return applyStakePlaced(event);
  }
}

// ── Handlers ─────────────────────────────────────────────────

async function applyUserRegistered(event: UserRegisteredEvent) {
  const { actorId, payload } = event;
  const REGISTRATION_BONUS = 100;

  const [user] = await prisma.$transaction([
    prisma.user.create({
      data: {
        id: actorId,
        username: payload.username,
        password: payload.passwordHash,
      },
      select: { id: true, username: true, createdAt: true },
    }),
    // Create Balance account
    prisma.balance.create({
      data: {
        userId: actorId,
        balance: REGISTRATION_BONUS,
        debtFrozen: false,
      },
    }),
    // Create PointAccount
    prisma.pointAccount.create({
      data: {
        userId: actorId,
        available: REGISTRATION_BONUS,
        locked: 0,
      },
    }),
    // Record point transaction (MINT)
    prisma.pointTransaction.create({
      data: {
        userId: actorId,
        type: 'MINT',
        amount: REGISTRATION_BONUS,
        balanceAfter: REGISTRATION_BONUS,
        data: { reason: 'REGISTRATION_BONUS' },
      },
    }),
    // Record ledger entry (MINT_INITIAL)
    prisma.ledgerEntry.create({
      data: {
        userId: actorId,
        entryType: 'MINT_INITIAL',
        amount: REGISTRATION_BONUS,
        balanceAfter: REGISTRATION_BONUS,
        data: { reason: 'REGISTRATION_BONUS' },
      },
    }),
    // Audit log: USER_REGISTERED
    prisma.auditLog.create({
      data: {
        actorId,
        action: 'USER_REGISTERED',
        entityType: 'User',
        entityId: actorId,
        data: { username: payload.username },
      },
    }),
    // Audit log: POINT_MINTED
    prisma.auditLog.create({
      data: {
        actorId,
        action: 'POINT_MINTED',
        entityType: 'PointTransaction',
        entityId: actorId,
        data: { amount: REGISTRATION_BONUS, reason: 'REGISTRATION_BONUS' },
      },
    }),
  ]);

  return user;
}

async function applyTopicCreated(event: TopicCreatedEvent) {
  const { actorId, payload } = event;

  const [topic] = await prisma.$transaction([
    prisma.topic.create({
      data: { title: payload.title, body: payload.body, createdById: actorId },
      include: { createdBy: { select: { id: true, username: true } } },
    }),
    prisma.auditLog.create({
      data: {
        actorId,
        action: 'TOPIC_CREATED',
        entityType: 'Topic',
        entityId: '',
        topicId: null,
        data: { title: payload.title, body: payload.body },
      },
    }),
  ]);

  await prisma.auditLog.updateMany({
    where: { action: 'TOPIC_CREATED', entityId: '', actorId },
    data: { entityId: topic.id, topicId: topic.id },
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

  // Auto-self-stake PRO (Phase 2.5)
  await autoSelfStake(actorId, topicId, message.id, payload.stakeAmount);

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

  // Auto-self-stake PRO (Phase 2.6)
  await autoSelfStake(actorId, topicId, message.id);

  return message;
}

// ── Auto Self-Stake Helper (Phase 2.5-2.6) ───────────────────

async function autoSelfStake(userId: string, topicId: string, messageId: string, overrideAmount?: number) {
  try {
    const rule = await prisma.ruleVersion.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { version: 'desc' },
      select: { parameters: true },
    });
    const selfStakeAmount = overrideAmount
      ?? (rule?.parameters as Record<string, unknown> | null)?.selfStakeOnCreate as number | undefined;
    if (!selfStakeAmount || selfStakeAmount <= 0) return;

    const userBalance = await prisma.balance.findUnique({ where: { userId } });
    if (!userBalance || userBalance.debtFrozen || userBalance.balance < selfStakeAmount) return;

    await executeStake({
      userId,
      topicId,
      messageId,
      side: 'PRO',
      amount: selfStakeAmount,
    });
  } catch {
    // Silently skip auto-stake if it fails (e.g., balance too low);
    // the message was already created successfully.
  }
}

// ── Points & Ledger Handlers ─────────────────────────────────

async function applyPointMinted(event: PointMintedEvent) {
  const { actorId, payload } = event;

  const account = await prisma.pointAccount.findUnique({ where: { userId: actorId } });
  if (!account) {
    throw new Error('PointAccount not found for user');
  }

  const newAvailable = account.available + payload.amount;

  const [, , currentBalance] = await prisma.$transaction([
    prisma.pointAccount.update({
      where: { userId: actorId },
      data: { available: newAvailable },
    }),
    prisma.pointTransaction.create({
      data: {
        userId: actorId,
        type: 'MINT',
        amount: payload.amount,
        balanceAfter: newAvailable,
        data: { reason: payload.reason, note: payload.note },
      },
    }),
    prisma.balance.update({
      where: { userId: actorId },
      data: { balance: { increment: payload.amount } },
    }),
    prisma.ledgerEntry.create({
      data: {
        userId: actorId,
        entryType: payload.reason === 'REGISTRATION_BONUS' ? 'MINT_INITIAL' : 'MINT_DAILY',
        amount: payload.amount,
        balanceAfter: 0,
        data: { reason: payload.reason, note: payload.note },
      },
    }),
    prisma.auditLog.create({
      data: {
        actorId,
        action: 'POINT_MINTED',
        entityType: 'PointTransaction',
        entityId: actorId,
        data: { amount: payload.amount, reason: payload.reason, note: payload.note },
      },
    }),
  ]);

  // Update ledger entry with correct balance_after
  const actualBalance = await prisma.balance.findUnique({ where: { userId: actorId } });
  await prisma.ledgerEntry.updateMany({
    where: { userId: actorId, entryType: payload.reason === 'REGISTRATION_BONUS' ? 'MINT_INITIAL' : 'MINT_DAILY', balanceAfter: 0 },
    data: { balanceAfter: actualBalance?.balance ?? 0 },
  });

  return { available: newAvailable, balance: currentBalance.balance };
}

async function applyPointTransferred(event: PointTransferredEvent) {
  const { actorId, payload } = event;

  const fromAccount = await prisma.pointAccount.findUnique({ where: { userId: payload.fromUserId } });
  if (!fromAccount || fromAccount.available < payload.amount) {
    throw new Error('Insufficient available points');
  }

  const toAccount = await prisma.pointAccount.findUnique({ where: { userId: payload.toUserId } });
  if (!toAccount) {
    throw new Error('Recipient PointAccount not found');
  }

  const fromNewAvailable = fromAccount.available - payload.amount;
  const toNewAvailable = toAccount.available + payload.amount;

  await prisma.$transaction([
    prisma.pointAccount.update({
      where: { userId: payload.fromUserId },
      data: { available: fromNewAvailable },
    }),
    prisma.pointAccount.update({
      where: { userId: payload.toUserId },
      data: { available: toNewAvailable },
    }),
    prisma.pointTransaction.create({
      data: {
        userId: payload.fromUserId,
        type: 'SPEND',
        amount: -payload.amount,
        balanceAfter: fromNewAvailable,
        data: { note: payload.note, direction: 'out', counterparty: payload.toUserId },
      },
    }),
    prisma.pointTransaction.create({
      data: {
        userId: payload.toUserId,
        type: 'TRANSFER',
        amount: payload.amount,
        balanceAfter: toNewAvailable,
        data: { note: payload.note, direction: 'in', counterparty: payload.fromUserId },
      },
    }),
    prisma.balance.update({
      where: { userId: payload.fromUserId },
      data: { balance: { decrement: payload.amount } },
    }),
    prisma.balance.update({
      where: { userId: payload.toUserId },
      data: { balance: { increment: payload.amount } },
    }),
    prisma.ledgerEntry.create({
      data: {
        userId: payload.fromUserId,
        entryType: 'STAKE_UNLOCK',
        amount: -payload.amount,
        balanceAfter: 0,
        data: { transferTo: payload.toUserId, note: payload.note },
      },
    }),
    prisma.auditLog.create({
      data: {
        actorId,
        action: 'POINT_TRANSFERRED',
        entityType: 'PointTransaction',
        entityId: payload.fromUserId,
        data: { from: payload.fromUserId, to: payload.toUserId, amount: payload.amount, note: payload.note },
      },
    }),
  ]);

  return { fromAvailable: fromNewAvailable, toAvailable: toNewAvailable };
}

// ── Stake Handlers (Phase 2) ─────────────────────────────────

/**
 * Shared internal stake execution — reusable by both the STAKE_PLACED event handler
 * and the message-creation auto-self-stake flow.
 */
export async function executeStake(params: {
  userId: string;
  topicId: string;
  messageId: string;
  side: 'PRO' | 'CON';
  amount: number;
  roundId?: string | null;
}) {
  const { userId, topicId, messageId, side, amount, roundId } = params;

  // Validate user state
  const [userBalance, pointAccount] = await Promise.all([
    prisma.balance.findUnique({ where: { userId } }),
    prisma.pointAccount.findUnique({ where: { userId } }),
  ]);

  if (!userBalance || !pointAccount) {
    throw new Error('Account not found');
  }
  if (userBalance.debtFrozen) {
    throw new Error('Account is frozen due to negative balance');
  }
  if (pointAccount.available < amount) {
    throw new Error('Insufficient available points');
  }

  const newAvailable = pointAccount.available - amount;
  const newLocked = pointAccount.locked + amount;
  const newBalance = userBalance.balance - amount;

  // Atomic write: account + stake + betPool + ledger + auditLog
  const [stake] = await prisma.$transaction([
    prisma.stake.create({
      data: { userId, topicId, messageId, side, amount, roundId: roundId ?? null },
    }),
    prisma.pointAccount.update({
      where: { userId },
      data: { available: newAvailable, locked: newLocked },
    }),
    prisma.balance.update({
      where: { userId },
      data: {
        balance: newBalance,
        debtFrozen: newBalance < 0,
      },
    }),
    prisma.pointTransaction.create({
      data: {
        userId,
        type: 'LOCK',
        amount: -amount,
        balanceAfter: newAvailable,
        data: { side, messageId, topicId },
      },
    }),
    // Upsert BetPool
    prisma.betPool.upsert({
      where: { messageId },
      create: {
        messageId,
        lockedPro: side === 'PRO' ? amount : 0,
        lockedCon: side === 'CON' ? amount : 0,
      },
      update: {
        lockedPro: side === 'PRO' ? { increment: amount } : undefined,
        lockedCon: side === 'CON' ? { increment: amount } : undefined,
      },
    }),
    prisma.ledgerEntry.create({
      data: {
        userId,
        entryType: 'STAKE_LOCK',
        amount: -amount,
        balanceAfter: newBalance,
        messageId,
        roundId: roundId ?? null,
        data: { side },
      },
    }),
    prisma.auditLog.create({
      data: {
        actorId: userId,
        action: 'STAKE_PLACED',
        entityType: 'Stake',
        entityId: '',
        topicId,
        data: { messageId, side, amount, roundId },
      },
    }),
  ]);

  // Patch audit log entityId
  await prisma.auditLog.updateMany({
    where: { action: 'STAKE_PLACED', entityId: '', actorId: userId, topicId },
    data: { entityId: stake.id },
  });

  return {
    stakeId: stake.id,
    side,
    amount,
    newAvailable,
    newLocked,
    newBalance,
  };
}

async function applyStakePlaced(event: StakePlacedEvent) {
  const { actorId, topicId, payload } = event;
  return executeStake({
    userId: actorId,
    topicId,
    messageId: payload.messageId,
    side: payload.side,
    amount: payload.amount,
    roundId: payload.roundId ?? null,
  });
}
