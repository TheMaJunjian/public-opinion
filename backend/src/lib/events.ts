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
    stakeAmount?: number;
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

// ── Phase 3: Settlement Events ──────────────────────────────

export interface RoundCreatedEvent {
  type: 'ROUND_CREATED';
  actorId: string;
  topicId: string;
  payload: {
    messageId: string;
    note?: string | null;
  };
}

export interface VoteCastEvent {
  type: 'VOTE_CAST';
  actorId: string;
  topicId: string;
  payload: {
    roundId: string;
    vote: 'TRUE' | 'FALSE' | 'UNKNOWN';
    amount: number;
  };
}

export interface RoundSettledEvent {
  type: 'ROUND_SETTLED';
  actorId: string;
  topicId: string;
  payload: {
    roundId: string;
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
  | StakePlacedEvent
  | RoundCreatedEvent
  | VoteCastEvent
  | RoundSettledEvent;

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
    case 'ROUND_CREATED':
      return applyRoundCreated(event);
    case 'VOTE_CAST':
      return applyVoteCast(event);
    case 'ROUND_SETTLED':
      return applyRoundSettled(event);
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

  // Check if user has enough balance for self-stake
  const rule = await prisma.ruleVersion.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { version: 'desc' },
    select: { parameters: true },
  });
  const requiredStake = payload.stakeAmount
    ?? (rule?.parameters as Record<string, unknown> | null)?.selfStakeOnCreate as number | undefined;
  if (requiredStake && requiredStake > 0) {
    const userBalance = await prisma.balance.findUnique({ where: { userId: actorId } });
    if (!userBalance || userBalance.debtFrozen || userBalance.balance < requiredStake) {
      throw new Error('贡献点余额不足');
    }
  }

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

  // Check balance for self-stake
  const rule = await prisma.ruleVersion.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { version: 'desc' },
    select: { parameters: true },
  });
  const requiredStake = payload.stakeAmount
    ?? (rule?.parameters as Record<string, unknown> | null)?.selfStakeOnCreate as number | undefined;
  if (requiredStake && requiredStake > 0) {
    const userBalance = await prisma.balance.findUnique({ where: { userId: actorId } });
    if (!userBalance || userBalance.debtFrozen || userBalance.balance < requiredStake) {
      throw new Error('贡献点余额不足');
    }
  }

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

  // Auto-stake based on relation type (Phase 2.6)
  const relType = payload.relationType?.toUpperCase();
  if (relType === 'AGREE' || relType === 'DISAGREE') {
    // AGREE = PRO on target, DISAGREE = CON on target
    const side = relType === 'AGREE' ? 'PRO' : 'CON';
    const targets = payload.targetRefs as Array<{ kind?: string; messageId?: string }>;
    for (const ref of targets) {
      if (ref.messageId) {
        await autoSelfStake(actorId, topicId, ref.messageId, payload.stakeAmount, side);
      }
    }
  } else {
    // Other relations: PRO on the relation message itself
    await autoSelfStake(actorId, topicId, message.id, payload.stakeAmount);
  }

  return message;
}

// ── Auto Self-Stake Helper (Phase 2.5-2.6) ───────────────────

async function autoSelfStake(userId: string, topicId: string, messageId: string, overrideAmount?: number, side: 'PRO' | 'CON' = 'PRO') {
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
      side,
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

  // ── Calculate fixed stake fee (extra burn on top of stake) ──
  const rule = await prisma.ruleVersion.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { version: 'desc' },
    select: { parameters: true },
  });
  const feeAmount = (rule?.parameters as Record<string, unknown> | null)?.stakeFeeAmount as number | undefined ?? 0;
  const totalCost = amount + feeAmount;  // locked amount + burned fee

  if (pointAccount.available < totalCost) {
    throw new Error('可用贡献点不足（含手续费）');
  }

  const newAvailable = pointAccount.available - totalCost;
  const newLocked = pointAccount.locked + amount;
  const newBalance = userBalance.balance - totalCost;

  // Atomic write: account + stake + betPool + ledger + fee burn + auditLog
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
        amount: -totalCost,
        balanceAfter: newAvailable,
        data: { side, messageId, topicId, amount, feeAmount },
      },
    }),
    // Upsert BetPool (full amount enters the pool)
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
        data: { side, feeAmount },
      },
    }),
    // Fee burned: permanently deducted
    ...(feeAmount > 0 ? [prisma.ledgerEntry.create({
      data: {
        userId,
        entryType: 'STAKE_LOCK',
        amount: -feeAmount,
        balanceAfter: newBalance,
        messageId,
        roundId: roundId ?? null,
        data: { fee: true, side },
      },
    })] : []),
    prisma.auditLog.create({
      data: {
        actorId: userId,
        action: 'STAKE_PLACED',
        entityType: 'Stake',
        entityId: '',
        topicId,
        data: { messageId, side, amount, feeAmount, roundId },
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

// ── Phase 3: Settlement Handlers ────────────────────────────

async function applyRoundCreated(event: RoundCreatedEvent) {
  const { actorId, topicId, payload } = event;

  // Validate message exists
  const message = await prisma.message.findUnique({
    where: { id: payload.messageId },
    select: { id: true, kind: true },
  });
  if (!message) {
    throw new Error('消息不存在');
  }

  // Concurrent constraint: at most 1 OPEN/VOTING round per message
  const existing = await prisma.settlementRound.findFirst({
    where: {
      messageId: payload.messageId,
      status: { in: ['OPEN', 'VOTING'] },
    },
  });
  if (existing) {
    throw new Error('该消息已有进行中的结算轮次');
  }

  const [round] = await prisma.$transaction([
    prisma.settlementRound.create({
      data: {
        messageId: payload.messageId,
        createdByUserId: actorId,
        status: 'OPEN',
        note: payload.note ?? null,
      },
    }),
    prisma.auditLog.create({
      data: {
        actorId,
        action: 'ROUND_CREATED',
        entityType: 'SettlementRound',
        entityId: '',
        topicId,
        data: { messageId: payload.messageId },
      },
    }),
  ]);

  await prisma.auditLog.updateMany({
    where: { action: 'ROUND_CREATED', entityId: '', actorId, topicId },
    data: { entityId: round.id },
  });

  return round;
}

async function applyVoteCast(event: VoteCastEvent) {
  const { actorId, topicId, payload } = event;

  // Validate round exists and is in VOTING
  const round = await prisma.settlementRound.findUnique({
    where: { id: payload.roundId },
    select: { id: true, status: true, messageId: true },
  });
  if (!round) {
    throw new Error('结算轮次不存在');
  }
  if (round.status !== 'VOTING') {
    throw new Error('该轮次不在投票阶段');
  }

  // Validate user balance
  const [userBalance, pointAccount] = await Promise.all([
    prisma.balance.findUnique({ where: { userId: actorId } }),
    prisma.pointAccount.findUnique({ where: { userId: actorId } }),
  ]);

  if (!userBalance || !pointAccount) {
    throw new Error('账户不存在');
  }
  if (userBalance.debtFrozen) {
    throw new Error('账户负债冻结，无法投票');
  }
  if (payload.amount < 1) {
    throw new Error('投票金额至少为 1 点');
  }

  // ── Calculate fixed vote fee (extra burn on top of vote) ──
  const rule = await prisma.ruleVersion.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { version: 'desc' },
    select: { parameters: true },
  });
  const feeAmount = (rule?.parameters as Record<string, unknown> | null)?.stakeFeeAmount as number | undefined ?? 0;
  const totalCost = payload.amount + feeAmount;

  if (pointAccount.available < totalCost) {
    throw new Error('可用贡献点不足（含手续费）');
  }

  const newAvailable = pointAccount.available - totalCost;
  const newLocked = pointAccount.locked + payload.amount;
  const newBalance = userBalance.balance - totalCost;

  const [vote] = await prisma.$transaction([
    prisma.voteStake.create({
      data: {
        roundId: payload.roundId,
        userId: actorId,
        vote: payload.vote,
        amount: payload.amount, // full amount = voting weight
      },
    }),
    prisma.pointAccount.update({
      where: { userId: actorId },
      data: { available: newAvailable, locked: newLocked },
    }),
    prisma.balance.update({
      where: { userId: actorId },
      data: {
        balance: newBalance,
        debtFrozen: newBalance < 0,
      },
    }),
    prisma.pointTransaction.create({
      data: {
        userId: actorId,
        type: 'LOCK',
        amount: -totalCost,
        balanceAfter: newAvailable,
        data: { vote: payload.vote, roundId: payload.roundId, messageId: round.messageId, amount: payload.amount, feeAmount },
      },
    }),
    prisma.ledgerEntry.create({
      data: {
        userId: actorId,
        entryType: 'VOTE_LOCK',
        amount: -payload.amount,
        balanceAfter: newBalance,
        roundId: payload.roundId,
        messageId: round.messageId,
        data: { vote: payload.vote, feeAmount },
      },
    }),
    // Fee burned
    ...(feeAmount > 0 ? [prisma.ledgerEntry.create({
      data: {
        userId: actorId,
        entryType: 'VOTE_LOCK',
        amount: -feeAmount,
        balanceAfter: newBalance,
        roundId: payload.roundId,
        messageId: round.messageId,
        data: { fee: true, vote: payload.vote },
      },
    })] : []),
    prisma.auditLog.create({
      data: {
        actorId,
        action: 'VOTE_CAST',
        entityType: 'VoteStake',
        entityId: '',
        topicId,
        data: { roundId: payload.roundId, vote: payload.vote, amount: payload.amount, feeAmount },
      },
    }),
  ]);

  await prisma.auditLog.updateMany({
    where: { action: 'VOTE_CAST', entityId: '', actorId, topicId },
    data: { entityId: vote.id },
  });

  return {
    voteId: vote.id,
    vote: payload.vote,
    amount: payload.amount,
    newAvailable,
    newLocked,
    newBalance,
  };
}

/**
 * Settlement algorithm: compute result and distribute funds.
 *
 * Weight determination:
 *   weight_TRUE  = sum(VoteStake.amount where vote=TRUE)
 *   weight_FALSE = sum(VoteStake.amount where vote=FALSE)
 *   weight_UNKNOWN = sum(VoteStake.amount where vote=UNKNOWN)
 *
 * Result:
 *   - Unique max → that result
 *   - Tie → UNKNOWN
 *
 * Distribution:
 *   TRUE: PRO side gets their stake back + proportional share of CON side's stakes
 *   FALSE: CON side gets their stake back + proportional share of PRO side's stakes
 *   UNKNOWN: All stakes returned
 */
async function applyRoundSettled(event: RoundSettledEvent) {
  const { actorId, topicId, payload } = event;

  // Validate round exists, is in VOTING, and actor is the creator
  const round = await prisma.settlementRound.findUnique({
    where: { id: payload.roundId },
    select: {
      id: true,
      status: true,
      messageId: true,
      createdByUserId: true,
      previousRoundId: true,
    },
  });

  if (!round) {
    throw new Error('结算轮次不存在');
  }
  if (round.status !== 'VOTING') {
    throw new Error('该轮次不在投票阶段');
  }
  if (round.createdByUserId !== actorId) {
    // Check rule: settlementPermission
    const rule = await prisma.ruleVersion.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { version: 'desc' },
      select: { parameters: true },
    });
    const permission = (rule?.parameters as Record<string, unknown> | null)?.settlementPermission ?? 'creator_only';

    if (permission === 'anyone') {
      // Anyone can settle — proceed
    } else if (permission === 'any_voter') {
      const userVoted = await prisma.voteStake.findFirst({
        where: { roundId: payload.roundId, userId: actorId },
      });
      if (!userVoted) {
        throw new Error('规则要求投票者才可结算');
      }
    } else {
      // creator_only (default)
      throw new Error('当前规则仅允许轮次发起者结算');
    }
  }

  const messageId = round.messageId;

  // ── Clawback: if there's a previous round with a different result, clawback ──
  if (round.previousRoundId) {
    await executeClawback(round.previousRoundId, messageId);
  }

  // ── Compute vote weights ──
  const voteAgg = await prisma.voteStake.groupBy({
    by: ['vote'],
    where: { roundId: payload.roundId },
    _sum: { amount: true },
  });

  const weights: Record<string, number> = { TRUE: 0, FALSE: 0, UNKNOWN: 0 };
  for (const row of voteAgg) {
    weights[row.vote] = row._sum.amount ?? 0;
  }

  // Determine result
  let result: 'TRUE' | 'FALSE' | 'UNKNOWN';
  const maxWeight = Math.max(weights.TRUE, weights.FALSE, weights.UNKNOWN);
  const winners = Object.entries(weights).filter(([, w]) => w === maxWeight);
  if (winners.length === 1) {
    result = winners[0][0] as 'TRUE' | 'FALSE' | 'UNKNOWN';
  } else {
    result = 'UNKNOWN';
  }

  // ── Distribution ──
  const betPool = await prisma.betPool.findUnique({
    where: { messageId },
    select: { lockedPro: true, lockedCon: true },
  });
  const totalPro = betPool?.lockedPro ?? 0;
  const totalCon = betPool?.lockedCon ?? 0;
  const totalPool = totalPro + totalCon;

  // ── Settlement fixed fee ──
  const settlementRule = await prisma.ruleVersion.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { version: 'desc' },
    select: { parameters: true },
  });
  const settlementFeeTotal = Math.min(
    (settlementRule?.parameters as Record<string, unknown> | null)?.settlementFeeAmount as number | undefined ?? 0,
    totalPool
  );
  // Deduct fee proportionally from PRO and CON pools
  const feeFromPro = totalPool > 0 ? Math.floor(settlementFeeTotal * (totalPro / totalPool)) : 0;
  const feeFromCon = settlementFeeTotal - feeFromPro;
  const distributablePro = totalPro - feeFromPro;
  const distributableCon = totalCon - feeFromCon;

  // Get all stakes for this message (all stakes, not just votes)
  const allStakes = await prisma.stake.findMany({
    where: { messageId },
    select: { id: true, userId: true, side: true, amount: true },
  });

  // Get all vote stakes for this round
  const voteStakes = await prisma.voteStake.findMany({
    where: { roundId: payload.roundId },
    select: { id: true, userId: true, vote: true, amount: true },
  });

  const now = new Date();
  const ledgerOps: Prisma.PrismaPromise<unknown>[] = [];
  const pointOps: Array<{ userId: string; available: number; locked: number }> = [];
  const balanceOps: Array<{ userId: string; balance: number }> = [];

  // Track per-user balance changes
  const userDelta = new Map<string, number>();

  function addUserDelta(userId: string, delta: number) {
    userDelta.set(userId, (userDelta.get(userId) ?? 0) + delta);
  }

  if (result === 'TRUE') {
    // PRO wins: PRO gets their stake back + proportional share of distributable CON
    for (const stake of allStakes) {
      if (stake.side === 'PRO') {
        // Return PRO stake
        addUserDelta(stake.userId, stake.amount);
        // PRO shares distributable CON pool proportionally
        if (totalPro > 0 && distributableCon > 0) {
          const share = Math.floor((stake.amount / totalPro) * distributableCon);
          addUserDelta(stake.userId, share);
        }
      }
      // CON loses their stake (no return)
    }
  } else if (result === 'FALSE') {
    // CON wins: CON gets their stake back + proportional share of distributable PRO
    for (const stake of allStakes) {
      if (stake.side === 'CON') {
        addUserDelta(stake.userId, stake.amount);
        if (totalCon > 0 && distributablePro > 0) {
          const share = Math.floor((stake.amount / totalCon) * distributablePro);
          addUserDelta(stake.userId, share);
        }
      }
      // PRO loses their stake
    }
  } else {
    // UNKNOWN: return all stakes
    for (const stake of allStakes) {
      addUserDelta(stake.userId, stake.amount);
    }
  }

  // Return locked vote amounts to voters (votes are returned regardless of result)
  for (const vs of voteStakes) {
    addUserDelta(vs.userId, vs.amount);
  }

  // ── Apply all balance changes atomically ──
  // First, collect current states
  const affectedUsers = [...userDelta.keys()];
  const currentBalances = new Map<string, { balance: number; available: number; locked: number }>();
  for (const uid of affectedUsers) {
    const [bal, pa] = await Promise.all([
      prisma.balance.findUnique({ where: { userId: uid } }),
      prisma.pointAccount.findUnique({ where: { userId: uid } }),
    ]);
    currentBalances.set(uid, {
      balance: bal?.balance ?? 0,
      available: pa?.available ?? 0,
      locked: pa?.locked ?? 0,
    });
  }

  // Build transaction operations
  for (const [uid, delta] of userDelta) {
    const cur = currentBalances.get(uid)!;
    const newBal = cur.balance + delta;
    const newAvail = cur.available + delta;
    const newLocked = Math.max(0, cur.locked - Math.max(0, delta)); // unlock returned amounts

    ledgerOps.push(
      prisma.balance.update({
        where: { userId: uid },
        data: { balance: newBal, debtFrozen: newBal < 0 },
      }),
      prisma.pointAccount.update({
        where: { userId: uid },
        data: { available: newAvail, locked: newLocked },
      }),
      prisma.pointTransaction.create({
        data: {
          userId: uid,
          type: delta >= 0 ? 'UNLOCK' : 'SPEND',
          amount: delta,
          balanceAfter: newAvail,
          data: { roundId: payload.roundId, messageId, settlementResult: result },
        },
      }),
      prisma.ledgerEntry.create({
        data: {
          userId: uid,
          entryType: delta >= 0 ? 'SETTLEMENT_PAYOUT' : 'STAKE_LOCK',
          amount: delta,
          balanceAfter: newBal,
          roundId: payload.roundId,
          messageId,
          data: { settlementResult: result },
        },
      }),
    );
  }

  // Update round status
  ledgerOps.push(
    prisma.settlementRound.update({
      where: { id: payload.roundId },
      data: { status: 'SETTLED', result, closedAt: now },
    }),
  );

  // Audit log
  ledgerOps.push(
    prisma.auditLog.create({
      data: {
        actorId,
        action: 'ROUND_SETTLED',
        entityType: 'SettlementRound',
        entityId: payload.roundId,
        topicId,
        data: {
          messageId,
          result,
          weights,
          totalPro,
          totalCon,
          affectedUsers: affectedUsers.length,
        },
      },
    }),
  );

  await prisma.$transaction(ledgerOps);

  return {
    roundId: payload.roundId,
    messageId,
    result,
    weights,
    totalPro,
    totalCon,
    distributablePro,
    distributableCon,
    settlementFeeTotal,
    affectedUsers: affectedUsers.length,
  };
}

/**
 * Clawback: reverse the previous round's payouts.
 * For each user who received a SETTLEMENT_PAYOUT in the previous round,
 * generate a SETTLEMENT_CLAWBACK entry that reverses it.
 */
async function executeClawback(previousRoundId: string, messageId: string) {
  const prevRound = await prisma.settlementRound.findUnique({
    where: { id: previousRoundId },
    select: { result: true },
  });

  if (!prevRound || !prevRound.result || prevRound.result === 'UNKNOWN') {
    // Nothing to clawback — UNKNOWN returned all stakes
    return;
  }

  // Find all payout ledger entries from the previous round
  const payouts = await prisma.ledgerEntry.findMany({
    where: {
      roundId: previousRoundId,
      entryType: 'SETTLEMENT_PAYOUT',
    },
  });

  const clawbackOps: Prisma.PrismaPromise<unknown>[] = [];
  for (const payout of payouts) {
    const clawbackAmount = -payout.amount; // reverse the payout

    const [bal, pa] = await Promise.all([
      prisma.balance.findUnique({ where: { userId: payout.userId } }),
      prisma.pointAccount.findUnique({ where: { userId: payout.userId } }),
    ]);

    const newBal = (bal?.balance ?? 0) + clawbackAmount;
    const newAvail = (pa?.available ?? 0) + clawbackAmount;
    const newLocked = pa?.locked ?? 0;

    clawbackOps.push(
      prisma.balance.update({
        where: { userId: payout.userId },
        data: { balance: newBal, debtFrozen: newBal < 0 },
      }),
      prisma.pointAccount.update({
        where: { userId: payout.userId },
        data: { available: newAvail, locked: newLocked },
      }),
      prisma.pointTransaction.create({
        data: {
          userId: payout.userId,
          type: 'SPEND',
          amount: clawbackAmount,
          balanceAfter: newAvail,
          data: { clawbackFromRound: previousRoundId, messageId },
        },
      }),
      prisma.ledgerEntry.create({
        data: {
          userId: payout.userId,
          entryType: 'SETTLEMENT_CLAWBACK',
          amount: clawbackAmount,
          balanceAfter: newBal,
          roundId: previousRoundId,
          messageId,
          data: { originalPayoutId: payout.id },
        },
      }),
    );
  }

  if (clawbackOps.length > 0) {
    await prisma.$transaction(clawbackOps);
  }
}
