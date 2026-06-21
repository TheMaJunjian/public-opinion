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
import { logSettlement, logUserSettlement, logLoserSettlement, logClawback, logClawbackLoser, logBetPoolRestore } from './settlementLogger';

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
    kind?: 'TEXT' | 'ROUND' | 'GOVERNANCE' | 'CODE';
    contentType?: 'TEXT' | 'MARKDOWN';
    content?: string;
    quoteSourceId?: string | null;
    quotedText?: string | null;
    quotedTextHash?: string | null;
    quoteContextBefore?: string | null;
    quoteContextAfter?: string | null;
    stakeAmount?: number;
    targetMessageId?: string;       // Phase 6: for ROUND messages
    note?: string | null;           // Phase 6: round note
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
    vote: 'TRUE' | 'FALSE';
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
  const REGISTRATION_BONUS = 200;

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
  const kind = payload.kind ?? 'TEXT';

  // ── ROUND messages: create SettlementRound as side effect ──
  if (kind === 'ROUND') {
    if (!payload.targetMessageId) throw new Error('ROUND 消息必须指定目标消息');

    // Validate target message
    const targetMsg = await prisma.message.findUnique({
      where: { id: payload.targetMessageId },
      select: { id: true, kind: true },
    });
    if (!targetMsg) throw new Error('目标消息不存在');

    // Check user not debt-frozen
    const bal = await prisma.balance.findUnique({
      where: { userId: actorId },
      select: { debtFrozen: true },
    });
    if (bal?.debtFrozen) throw new Error('账户负债冻结，无法发起结算');

    // Concurrent constraint
    const existing = await prisma.settlementRound.findFirst({
      where: { messageId: payload.targetMessageId, status: { in: ['OPEN', 'VOTING'] } },
    });
    if (existing) throw new Error('该消息已有进行中的结算轮次');

    // Link to latest settled round
    const latestSettled = await prisma.settlementRound.findFirst({
      where: { messageId: payload.targetMessageId, status: 'SETTLED' },
      orderBy: { closedAt: 'desc' },
      select: { id: true },
    });

    const [message] = await prisma.$transaction([
      prisma.message.create({
        data: {
          topicId,
          createdById: actorId,
          kind: 'ROUND',
          content: null,
          targetRefs: [{ messageId: payload.targetMessageId }],
          relationPayload: { note: payload.note ?? null },
        },
        include: { createdBy: { select: { id: true, username: true } } },
      }),
      // Create SettlementRound (settlement engine unchanged)
      prisma.settlementRound.create({
        data: {
          messageId: payload.targetMessageId,
          createdByUserId: actorId,
          status: 'VOTING',
          previousRoundId: latestSettled?.id ?? null,
          note: payload.note ?? null,
        },
      }),
      prisma.auditLog.create({
        data: {
          actorId,
          action: 'MESSAGE_CREATED',
          entityType: 'Message',
          entityId: '',
          topicId,
          data: { kind: 'ROUND', targetMessageId: payload.targetMessageId },
        },
      }),
    ]);

    await prisma.auditLog.updateMany({
      where: { action: 'MESSAGE_CREATED', entityId: '', actorId, topicId },
      data: { entityId: message.id },
    });

    return message;
  }

  // ── TEXT / GOVERNANCE / CODE messages ──
  if (!payload.content) throw new Error(`${kind} 消息内容不能为空`);
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

  if (!payload.content) throw new Error('TEXT 消息内容不能为空');

  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        topicId,
        createdById: actorId,
        kind: kind as 'TEXT' | 'GOVERNANCE' | 'CODE',
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
          kind,
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

  // Auto-create voting round for this message (Phase 3.1)
  await ensureVotingRound(message.id, actorId, topicId);

  return message;
}

async function applyRelationCreated(event: RelationCreatedEvent) {
  const { actorId, topicId, payload } = event;

  // Check balance for self-stake (relation-type-specific minimum)
  const rule = await prisma.ruleVersion.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { version: 'desc' },
    select: { parameters: true },
  });
  const ruleParams = rule?.parameters as Record<string, unknown> | null;
  const relationTypeMinStake = (ruleParams?.relationTypeMinStake as Record<string, number> | null) ?? {};
  const typeDefault = relationTypeMinStake[payload.relationType.toUpperCase()]
    ?? (ruleParams?.selfStakeOnCreate as number | undefined);
  const requiredStake = payload.stakeAmount ?? typeDefault;
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
        // Auto-create voting round first, so the stake gets its roundId (Phase 3.1)
        const round = await ensureVotingRound(ref.messageId, actorId, topicId);
        await autoSelfStake(actorId, topicId, ref.messageId, payload.stakeAmount, side, round?.id);
      }
    }
  } else {
    // Other relations: PRO on the relation message itself
    await autoSelfStake(actorId, topicId, message.id, payload.stakeAmount);
  }

  return message;
}

// ── Auto Self-Stake Helper (Phase 2.5-2.6) ───────────────────

async function autoSelfStake(userId: string, topicId: string, messageId: string, overrideAmount?: number, side: 'PRO' | 'CON' = 'PRO', roundId?: string | null): Promise<number | undefined> {
  try {
    const rule = await prisma.ruleVersion.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { version: 'desc' },
      select: { parameters: true },
    });
    const selfStakeAmount = overrideAmount
      ?? (rule?.parameters as Record<string, unknown> | null)?.selfStakeOnCreate as number | undefined;
    if (!selfStakeAmount || selfStakeAmount <= 0) return undefined;

    const userBalance = await prisma.balance.findUnique({ where: { userId } });
    if (!userBalance || userBalance.debtFrozen || userBalance.balance < selfStakeAmount) return undefined;

    await executeStake({
      userId,
      topicId,
      messageId,
      side,
      amount: selfStakeAmount,
      roundId: roundId ?? null,
    });

    return selfStakeAmount;
  } catch {
    // Silently skip auto-stake if it fails (e.g., balance too low);
    // the message was already created successfully.
    return undefined;
  }
}

// ── Auto Round & Vote Helpers (Phase 3.1) ─────────────────────

/**
 * Ensure a VOTING settlement round exists for a message.
 * If none exists, creates one. Returns the round or undefined.
 */
async function ensureVotingRound(messageId: string, actorId: string, topicId: string) {
  // Check for existing active round
  const existing = await prisma.settlementRound.findFirst({
    where: { messageId, status: { in: ['OPEN', 'VOTING'] } },
    select: { id: true },
  });
  if (existing) return existing;

  // Link to latest settled round for overturn chain
  const latestSettled = await prisma.settlementRound.findFirst({
    where: { messageId, status: 'SETTLED' },
    orderBy: { closedAt: 'desc' },
    select: { id: true },
  });

  const [round] = await prisma.$transaction([
    prisma.settlementRound.create({
      data: {
        messageId,
        createdByUserId: actorId,
        status: 'VOTING',
        previousRoundId: latestSettled?.id ?? null,
        note: null,
      },
    }),
    prisma.auditLog.create({
      data: {
        actorId,
        action: 'ROUND_CREATED',
        entityType: 'SettlementRound',
        entityId: '',
        topicId,
        data: { messageId, previousRoundId: latestSettled?.id ?? null, autoCreated: true },
      },
    }),
  ]);

  await prisma.auditLog.updateMany({
    where: { action: 'ROUND_CREATED', entityId: '', actorId, topicId },
    data: { entityId: round.id },
  });

  return round;
}

// ── Points & Ledger Handlers ─────────────────────────────────

async function applyPointMinted(event: PointMintedEvent) {
  const { actorId, payload } = event;

  const account = await prisma.pointAccount.findUnique({ where: { userId: actorId } });
  if (!account) {
    throw new Error('PointAccount not found for user');
  }

  // Query current balance before transaction for atomic ledger entry
  const currentBal = await prisma.balance.findUnique({ where: { userId: actorId } });
  const newBalance = (currentBal?.balance ?? 0) + payload.amount;
  const newAvailable = account.available + payload.amount;

  await prisma.$transaction([
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
        balanceAfter: newBalance,
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

  return { available: newAvailable, balance: newBalance };
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
        type: 'STAKE_LOCK',
        amount: -totalCost,
        balanceAfter: newAvailable,
        data: { side, messageId, topicId, staked: amount, burned: feeAmount },
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

  // Patch pointTransaction with stakeId for precise settlement-panel highlighting
  const pt = await prisma.pointTransaction.findFirst({
    where: { userId, type: 'STAKE_LOCK' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, data: true },
  });
  if (pt) {
    await prisma.pointTransaction.update({
      where: { id: pt.id },
      data: { data: { ...(pt.data as Record<string, unknown>), stakeId: stake.id } },
    });
  }

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

  // ── Auto-link to the most recent SETTLED round (overturn chain) ──
  const latestSettled = await prisma.settlementRound.findFirst({
    where: { messageId: payload.messageId, status: 'SETTLED' },
    orderBy: { closedAt: 'desc' },
    select: { id: true },
  });

  const [round] = await prisma.$transaction([
    prisma.settlementRound.create({
      data: {
        messageId: payload.messageId,
        createdByUserId: actorId,
        status: 'OPEN',
        previousRoundId: latestSettled?.id ?? null,
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
        data: { messageId: payload.messageId, previousRoundId: latestSettled?.id ?? null },
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
        type: 'VOTE_LOCK',
        amount: -totalCost,
        balanceAfter: newAvailable,
        data: { vote: payload.vote, roundId: payload.roundId, messageId: round.messageId, topicId, staked: payload.amount, burned: feeAmount },
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

  // Patch pointTransaction with voteId for precise settlement-panel highlighting
  const pt = await prisma.pointTransaction.findFirst({
    where: { userId: actorId, type: 'VOTE_LOCK' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, data: true },
  });
  if (pt) {
    await prisma.pointTransaction.update({
      where: { id: pt.id },
      data: { data: { ...(pt.data as Record<string, unknown>), voteId: vote.id } },
    });
  }

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
      const userStaked = await prisma.stake.findFirst({
        where: { messageId: round.messageId, userId: actorId },
      });
      if (!userStaked) {
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
    await executeClawback(round.previousRoundId, messageId, topicId);
  }

  // ── Compute total weights from BetPool (all stakes, including auto-stakes from AGREE/DISAGREE votes) ──
  // PRO stakes = AGREE votes, CON stakes = DISAGREE votes (unified in Phase 5)
  const betPool = await prisma.betPool.findUnique({
    where: { messageId },
    select: { lockedPro: true, lockedCon: true },
  });
  const totalPro = betPool?.lockedPro ?? 0;
  const totalCon = betPool?.lockedCon ?? 0;

  const weights: Record<string, number> = {
    TRUE: totalPro,
    FALSE: totalCon,
    UNKNOWN: 0,
  };

  // Determine result: UNKNOWN only on tie
  let result: 'TRUE' | 'FALSE' | 'UNKNOWN';
  if (weights.TRUE > weights.FALSE) {
    result = 'TRUE';
  } else if (weights.FALSE > weights.TRUE) {
    result = 'FALSE';
  } else {
    result = 'UNKNOWN';
  }

  logSettlement(payload.roundId, result, totalPro, totalCon);

  const totalPool = totalPro + totalCon;

  // ── Fetch message creator & rule params for creator reward ──
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { createdById: true },
  });
  const creatorId = message?.createdById ?? '';
  const settlementRule = await prisma.ruleVersion.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { version: 'desc' },
    select: { parameters: true },
  });
  const ruleParams = settlementRule?.parameters as Record<string, unknown> | null;

  // Get all stakes for this message (includes auto-stakes from AGREE/DISAGREE relations)
  const allStakes = await prisma.stake.findMany({
    where: { messageId },
    select: { id: true, userId: true, side: true, amount: true },
  });

  const now = new Date();
  const ledgerOps: Prisma.PrismaPromise<unknown>[] = [];
  const pointOps: Array<{ userId: string; available: number; locked: number }> = [];
  const balanceOps: Array<{ userId: string; balance: number }> = [];

  // Track per-user balance changes and which users are settlement winners
  const userDelta = new Map<string, number>();
  const settlementWinners = new Set<string>(); // users whose stakes should be unlocked

  function addUserDelta(userId: string, delta: number) {
    userDelta.set(userId, (userDelta.get(userId) ?? 0) + delta);
  }

  if (result === 'TRUE') {
    // TRUE wins: PRO stakers share the losing pool (CON stakes)
    const creatorRewardRatio = (ruleParams?.creatorRewardRatio as number | undefined) ?? 0;
    const creatorReward = totalCon > 0
      ? Math.floor(totalCon * creatorRewardRatio)
      : 0;
    const sharedPool = totalCon - creatorReward; // remainder shared among winners

    // PRO stakers (including AGREE votes): return stake + proportional share of losing pool
    for (const stake of allStakes) {
      if (stake.side === 'PRO') {
        settlementWinners.add(stake.userId);
        addUserDelta(stake.userId, stake.amount);
        if (totalPro > 0 && sharedPool > 0) {
          const share = Math.floor((stake.amount / totalPro) * sharedPool);
          addUserDelta(stake.userId, share);
        }
      }
      // CON stakers (DISAGREE votes): stake is lost — nothing returned
    }
    // Creator reward — also counts as totalEarned (pure profit, no stake deducted)
    if (creatorReward > 0) {
      settlementWinners.add(creatorId);
      addUserDelta(creatorId, creatorReward);
    }
  } else if (result === 'FALSE') {
    // FALSE wins: CON stakers share the losing pool (PRO stakes)
    for (const stake of allStakes) {
      if (stake.side === 'CON') {
        settlementWinners.add(stake.userId);
        addUserDelta(stake.userId, stake.amount);
        if (totalCon > 0 && totalPro > 0) {
          const share = Math.floor((stake.amount / totalCon) * totalPro);
          addUserDelta(stake.userId, share);
        }
      }
      // PRO stakers (AGREE votes): stake is lost — nothing returned
    }
  } else {
    // UNKNOWN: return all stakes
    for (const stake of allStakes) {
      settlementWinners.add(stake.userId);
      addUserDelta(stake.userId, stake.amount);
    }
  }

  // ── Distribute dust (rounding leftovers) to first winner BEFORE unlock loop ──
  const totalDistributed = [...userDelta.values()].reduce((s, d) => s + d, 0);
  const dust = totalPool - totalDistributed;
  if (dust > 0 && settlementWinners.size > 0) {
    const firstWinner = [...settlementWinners][0];
    addUserDelta(firstWinner, dust);
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

  // Build per-user contribution totals (stakes from current & clawed-back rounds)
  const userContributionMap = new Map<string, number>();
  for (const s of allStakes) {
    userContributionMap.set(s.userId, (userContributionMap.get(s.userId) ?? 0) + s.amount);
  }
  // If clawback happened, also include previous round stakes (they were re-locked)
  if (round.previousRoundId) {
    const prevRoundStakes = await prisma.stake.findMany({
      where: { messageId, roundId: round.previousRoundId },
      select: { userId: true, amount: true },
    });
    for (const ps of prevRoundStakes) {
      userContributionMap.set(ps.userId, (userContributionMap.get(ps.userId) ?? 0) + ps.amount);
    }
  }

  // Build transaction operations
  for (const [uid, delta] of userDelta) {
    const cur = currentBalances.get(uid)!;
    const newBal = cur.balance + delta;
    const newAvail = cur.available + delta;
    // Unlock logic: only unlock own contribution; profit is already in delta→available
    const userContribution = userContributionMap.get(uid) ?? 0;
    const isSettlementWinner = settlementWinners.has(uid);
    const unlockAmount = delta >= 0
      ? (isSettlementWinner
          ? Math.min(cur.locked, userContribution)  // only unlock own stake/vote (profit stays in available)
          : Math.min(cur.locked, delta))  // non-winner: only unlock delta amount
      : 0;  // clawback: don't unlock
    const newLocked = Math.max(0, cur.locked - unlockAmount);
    const netEarned = isSettlementWinner && delta > userContribution ? delta - userContribution : 0;

    // ── DEBUG: log settlement per-user state ──
    logUserSettlement(uid, isSettlementWinner, delta, userContribution, cur.locked, newLocked, cur.available, newAvail, netEarned);

    ledgerOps.push(
      prisma.balance.update({
        where: { userId: uid },
        data: {
          balance: newBal,
          debtFrozen: newBal < 0,
          ...(isSettlementWinner && delta > userContribution ? { totalEarned: { increment: delta - userContribution } } : {}),
        },
      }),
      prisma.pointAccount.update({
        where: { userId: uid },
        data: { available: newAvail, locked: newLocked },
      }),
      prisma.pointTransaction.create({
        data: {
          userId: uid,
          type: delta >= 0 ? 'SETTLEMENT_GAIN' : 'SETTLEMENT_LOSS',
          amount: delta,
          balanceAfter: newAvail,
          data: { roundId: payload.roundId, messageId, topicId, settlementResult: result, side: userContributionMap.has(uid) ? 'staker' : 'voter' },
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

  // ── Move loser contributions from locked → totalLost ──
  // Only count losing-side contributions (not all-time total) to avoid cross-message pollution
  const losingSide = result === 'TRUE' ? 'CON' : 'PRO';
  const loserContributionMap = new Map<string, number>();
  if (result !== 'UNKNOWN') {
    for (const s of allStakes) {
      if (s.side === losingSide) {
        loserContributionMap.set(s.userId, (loserContributionMap.get(s.userId) ?? 0) + s.amount);
      }
    }
  }
  for (const [uid, losingContribution] of loserContributionMap) {
    if (settlementWinners.has(uid)) continue;
    const pa = await prisma.pointAccount.findUnique({ where: { userId: uid }, select: { locked: true, available: true } });
    if (!pa || pa.locked <= 0) continue;
    const lostAmount = Math.min(pa.locked, losingContribution);
    if (lostAmount <= 0) continue;
    logLoserSettlement(uid, losingContribution, pa.locked, pa.locked - lostAmount, lostAmount);
    ledgerOps.push(
      prisma.pointAccount.update({
        where: { userId: uid },
        data: { locked: { decrement: lostAmount } },
      }),
      prisma.balance.update({
        where: { userId: uid },
        data: { totalLost: { increment: lostAmount } },
      }),
      prisma.pointTransaction.create({
        data: {
          userId: uid,
          type: 'SETTLEMENT_LOSS',
          amount: -lostAmount,
          balanceAfter: pa.available,
          data: { roundId: payload.roundId, messageId, topicId, settlementResult: result, lostAmount },
        },
      }),
      prisma.ledgerEntry.create({
        data: {
          userId: uid,
          entryType: 'SETTLEMENT_PAYOUT',
          amount: -lostAmount,
          balanceAfter: 0,
          roundId: payload.roundId,
          messageId,
          data: { settlementResult: result, lost: true },
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

  // ── Reset BetPool: funds have been distributed ──
  ledgerOps.push(
    prisma.betPool.update({
      where: { messageId },
      data: { lockedPro: 0, lockedCon: 0 },
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
          dust,
          affectedUsers: affectedUsers.length,
        },
      },
    }),
  );

  await prisma.$transaction(ledgerOps);

  // ── Phase 6: Create ROUND_RESULT message ──
  await prisma.message.create({
    data: {
      topicId,
      createdById: actorId,
      kind: 'ROUND_RESULT',
      content: null,
      targetRefs: [{ messageId }],
      relationPayload: { roundId: payload.roundId, result, weights, totalPro, totalCon },
    },
  });

  return {
    roundId: payload.roundId,
    messageId,
    result,
    weights,
    totalPro,
    totalCon,
    dust,
    affectedUsers: affectedUsers.length,
  };
}

/**
 * Clawback: reverse the previous round's payouts.
 * For each user who received a SETTLEMENT_PAYOUT in the previous round,
 * generate a SETTLEMENT_CLAWBACK entry that reverses it.
 */
async function executeClawback(previousRoundId: string, messageId: string, topicId: string) {
  const prevRound = await prisma.settlementRound.findUnique({
    where: { id: previousRoundId },
    select: { result: true, closedAt: true },
  });

  if (!prevRound || !prevRound.result || prevRound.result === 'UNKNOWN') {
    // Nothing to clawback — UNKNOWN returned all stakes
    return;
  }

  // Find all WINNER payout entries from the previous round (positive = actual payouts)
  const payouts = await prisma.ledgerEntry.findMany({
    where: {
      roundId: previousRoundId,
      entryType: 'SETTLEMENT_PAYOUT',
      amount: { gt: 0 },
    },
  });

  // ── Look up original stakes (only those from before previous round ended) ──
  // Also query AGREE/DISAGREE relations from the previous round for re-lock amounts
  const payoutUserIds = [...new Set(payouts.map(p => p.userId))];
  const [userStakes, prevRoundVoteRels] = await Promise.all([
    prisma.stake.findMany({
      where: {
        messageId,
        userId: { in: payoutUserIds },
        createdAt: prevRound.closedAt ? { lte: prevRound.closedAt } : undefined,
      },
      select: { userId: true, amount: true },
    }),
    // Query AGREE/DISAGREE relations with vote amounts from the topic
    prisma.message.findMany({
      where: {
        topicId,
        kind: 'RELATION',
        relationType: { in: ['AGREE', 'DISAGREE'] },
        relSourceId: null,
        createdById: { in: payoutUserIds },
        createdAt: prevRound.closedAt ? { lte: prevRound.closedAt } : undefined,
      },
      select: { createdById: true, relationPayload: true, targetRefs: true },
    }),
  ]);
  const userStakeTotal = new Map<string, number>();
  for (const s of userStakes) {
    userStakeTotal.set(s.userId, (userStakeTotal.get(s.userId) ?? 0) + s.amount);
  }
  // Count vote amounts from AGREE/DISAGREE relations targeting this message
  for (const v of prevRoundVoteRels) {
    const refs = v.targetRefs as Array<{ messageId?: string }> | undefined;
    if (refs?.some(r => r.messageId === messageId)) {
      const payload = v.relationPayload as Record<string, unknown> | null;
      const voteAmount = (payload?.amount as number) ?? 0;
      userStakeTotal.set(v.createdById, (userStakeTotal.get(v.createdById) ?? 0) + voteAmount);
    }
  }

  // ── Accumulate clawback per user (avoids duplicate reads overwriting) ──
  const userClawback = new Map<string, { amount: number; originalStake: number; payoutTotal: number }>();
  for (const payout of payouts) {
    const cur = userClawback.get(payout.userId) ?? { amount: 0, originalStake: 0, payoutTotal: 0 };
    cur.amount += -payout.amount;
    cur.payoutTotal += payout.amount;
    // Re-lock stake amounts
    cur.originalStake = userStakeTotal.get(payout.userId) ?? 0;
    userClawback.set(payout.userId, cur);
  }

  // ── Also reverse totalLost for previous losers ──
  const prevLostEntries = await prisma.ledgerEntry.findMany({
    where: { roundId: previousRoundId, entryType: 'SETTLEMENT_PAYOUT', amount: { lt: 0 } },
    select: { userId: true, amount: true },
  });
  const prevLost = new Map<string, number>();
  for (const e of prevLostEntries) {
    prevLost.set(e.userId, (prevLost.get(e.userId) ?? 0) + Math.abs(e.amount));
  }

  const clawbackOps: Prisma.PrismaPromise<unknown>[] = [];
  for (const [userId, acc] of userClawback) {
    const [bal, pa] = await Promise.all([
      prisma.balance.findUnique({ where: { userId } }),
      prisma.pointAccount.findUnique({ where: { userId } }),
    ]);

    const newBal = (bal?.balance ?? 0) + acc.amount;
    const newAvail = (pa?.available ?? 0) + acc.amount;
    const newLocked = (pa?.locked ?? 0) + acc.originalStake;
    // Reverse previous round's net profit: totalEarned -= (payout - own contribution)
    const prevNetProfit = Math.max(0, acc.payoutTotal - acc.originalStake);
    logClawback(userId, acc.payoutTotal, acc.originalStake, prevNetProfit, pa?.available ?? 0, newAvail, pa?.locked ?? 0, newLocked);

    clawbackOps.push(
      prisma.balance.update({
        where: { userId },
        data: {
          balance: newBal,
          debtFrozen: newBal < 0,
          ...(prevNetProfit > 0 ? { totalEarned: { decrement: prevNetProfit } } : {}),
        },
      }),
      prisma.pointAccount.update({
        where: { userId },
        data: { available: newAvail, locked: newLocked },
      }),
      prisma.pointTransaction.create({
        data: {
          userId,
          type: 'CLAWBACK',
          amount: acc.amount,
          balanceAfter: newAvail,
          data: { clawbackFromRound: previousRoundId, messageId, topicId, reLockedStake: acc.originalStake },
        },
      }),
      prisma.ledgerEntry.create({
        data: {
          userId,
          entryType: 'SETTLEMENT_CLAWBACK',
          amount: acc.amount,
          balanceAfter: newBal,
          roundId: previousRoundId,
          messageId,
          data: { reLockedStake: acc.originalStake },
        },
      }),
    );
  }

  // ── Reverse previous round's totalLost for losers AND re-lock their points ──
  for (const [userId, lostAmount] of prevLost) {
    logClawbackLoser(userId, lostAmount);
    clawbackOps.push(
      prisma.balance.update({
        where: { userId },
        data: { totalLost: { decrement: lostAmount } },
      }),
      prisma.pointAccount.update({
        where: { userId },
        data: { locked: { increment: lostAmount } },
      }),
    );
  }

  // ── Restore BetPool from original stakes AND votes ──
  // After clawback, the BetPool should reflect all contributions again
  // so that the new round can redistribute them.
  const stakes = await prisma.stake.findMany({
    where: { messageId },
    select: { side: true, amount: true },
  });
  const prevVotes = await prisma.voteStake.findMany({
    where: { roundId: previousRoundId },
    select: { vote: true, amount: true },
  });
  let restoredPro = 0;
  let restoredCon = 0;
  for (const s of stakes) {
    if (s.side === 'PRO') restoredPro += s.amount;
    else restoredCon += s.amount;
  }
  for (const v of prevVotes) {
    if (v.vote === 'TRUE') restoredPro += v.amount;
    else if (v.vote === 'FALSE') restoredCon += v.amount;
  }
  // Add back creator reward — it was taken from the losing side's pool
  let creatorRewardClawback = 0;
  for (const [, acc] of userClawback) {
    if (acc.originalStake === 0 && acc.payoutTotal > 0) {
      creatorRewardClawback += acc.payoutTotal;
    }
  }
  if (creatorRewardClawback > 0) {
    if (prevRound.result === 'TRUE') restoredCon += creatorRewardClawback;
    else restoredPro += creatorRewardClawback;
  }
  logBetPoolRestore(restoredPro, restoredCon, creatorRewardClawback);
  clawbackOps.push(
    prisma.betPool.upsert({
      where: { messageId },
      create: { messageId, lockedPro: restoredPro, lockedCon: restoredCon },
      update: { lockedPro: restoredPro, lockedCon: restoredCon },
    }),
  );

  // ── Audit log for clawback (actorId=null since it's system-triggered) ──
  clawbackOps.push(
    prisma.auditLog.create({
      data: {
        actorId: null,
        action: 'SETTLEMENT_CLAWBACK',
        entityType: 'SettlementRound',
        entityId: previousRoundId,
        topicId,
        data: {
          messageId,
          previousRoundId,
          restoredPro,
          restoredCon,
          affectedUsers: payouts.length,
        },
      },
    }),
  );

  if (clawbackOps.length > 0) {
    await prisma.$transaction(clawbackOps);
  }
}
