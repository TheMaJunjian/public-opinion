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
import { log, debugLog } from './logger';
import { writeAuditLog } from './auditLog';

// ============================================================
// Event Type Definitions
// ============================================================

export interface UserRegisteredEvent {
  type: 'USER_REGISTERED';
  actorId: string;
  signature?: string | null;
  payload: {
    username: string;
    passwordHash: string;
    publicKey?: string | null;
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
  signature?: string | null;
  topicId: string;
  payload: {
    kind?: 'TEXT' | 'ROUND' | 'GOVERNANCE' | 'CODE' | 'OPERATIONS';
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
    settlementType?: string;        // Phase 7: 'TRUTH' | 'VALUE' for ROUND messages
    // Governance/Code relation fields (PROPOSAL / CODE_CHANGE)
    relationType?: string | null;
    sourceMessageId?: string | null;
    targetRefs?: unknown;
    relationPayload?: Record<string, unknown>;
  };
}

export interface RelationCreatedEvent {
  type: 'RELATION_CREATED';
  actorId: string;
  signature?: string | null;
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

export interface RevenueInjectedEvent {
  type: 'REVENUE_INJECTED';
  actorId: string;
  signature?: string | null;
  topicId: string;
  payload: { amount: number; source: string; note?: string | null };
}

export interface PointsRechargedEvent {
  type: 'POINTS_RECHARGED';
  actorId: string;
  signature?: string | null;
  topicId: string;
  payload: { amount: number; revenuePoolShare: number; note?: string | null };
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

export interface RelationTargetsUpdatedEvent {
  type: 'RELATION_TARGETS_UPDATED';
  actorId: string;
  topicId: string;
  payload: {
    relationId: string;
    targetRefs: unknown[];
    previousTargetRefs: unknown;
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
  | RevenueInjectedEvent
  | PointsRechargedEvent
  | StakePlacedEvent
  | RoundCreatedEvent
  | VoteCastEvent
  | RoundSettledEvent
  | RelationTargetsUpdatedEvent;

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
    case 'REVENUE_INJECTED':
      return applyRevenueInjected(event);
    case 'POINTS_RECHARGED':
      return applyPointsRecharged(event);
    case 'STAKE_PLACED':
      return applyStakePlaced(event);
    case 'ROUND_CREATED':
      return applyRoundCreated(event);
    case 'VOTE_CAST':
      return applyVoteCast(event);
    case 'ROUND_SETTLED':
      return applyRoundSettled(event);
    case 'RELATION_TARGETS_UPDATED':
      return applyRelationTargetsUpdated(event);
  }
}

// ── Handlers ─────────────────────────────────────────────────

async function applyUserRegistered(event: UserRegisteredEvent) {
  const { actorId, payload, signature } = event;
  const REGISTRATION_BONUS = 2000;

  const [user] = await prisma.$transaction([
    prisma.user.create({
      data: {
        id: actorId,
        username: payload.username,
        password: payload.passwordHash,
        publicKey: payload.publicKey ?? null,
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
  ]);

  await writeAuditLog({
    actorId,
    action: 'USER_REGISTERED',
    entityType: 'User',
    entityId: actorId,
    summary: '注册',
    details: { username: payload.username },
    signature,
  });
  await writeAuditLog({
    actorId,
    action: 'POINT_MINTED',
    entityType: 'PointTransaction',
    entityId: actorId,
    summary: `注册奖励 ${REGISTRATION_BONUS} 点`,
    details: { amount: REGISTRATION_BONUS, reason: 'REGISTRATION_BONUS' },
    signature,
  });

  return user;
}

async function applyTopicCreated(event: TopicCreatedEvent) {
  const { actorId, payload } = event;

  const [topic] = await prisma.$transaction([
    prisma.topic.create({
      data: { title: payload.title, body: payload.body, createdById: actorId },
      include: { createdBy: { select: { id: true, username: true } } },
    }),
  ]);

  await writeAuditLog({
    actorId,
    action: 'TOPIC_CREATED',
    entityType: 'Topic',
    entityId: topic.id,
    topicId: topic.id,
    summary: `创建议题「${payload.title}」`,
    details: { title: payload.title, body: payload.body },
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
  ]);

  await writeAuditLog({
    actorId,
    action: payload.status === 'ARCHIVED' ? 'TOPIC_ARCHIVED' : 'TOPIC_REOPENED',
    entityType: 'Topic',
    entityId: topicId,
    topicId,
    summary: payload.status === 'ARCHIVED' ? '归档分类' : '重开分类',
    details: { status: payload.status },
  });

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
      select: { id: true, kind: true, content: true },
    });
    if (!targetMsg) throw new Error('目标消息不存在');

    // Check user not debt-frozen
    const bal = await prisma.balance.findUnique({
      where: { userId: actorId },
      select: { debtFrozen: true },
    });
    if (bal?.debtFrozen) throw new Error('账户负债冻结，无法发起结算');

    // Check for existing active round of same settlement type
    const stype = payload.settlementType ?? 'TRUTH';
    const settlementLabel = stype === 'VALUE' ? '价值仲裁' : '真假仲裁';
    const targetPreview = (targetMsg.content ?? '').trim().replace(/\s+/g, ' ').slice(0, 120) || `消息 ${targetMsg.id.slice(-8)}`;
    const roundContent = `发起${settlementLabel}：目标消息「${targetPreview}」${payload.note ? `；说明：${payload.note}` : ''}`;
    const existing = await prisma.settlementRound.findFirst({
      where: { messageId: payload.targetMessageId, settlementType: stype, status: { in: ['OPEN', 'VOTING'] } },
      select: { id: true, status: true },
    });
    if (existing) {
      log('ROUND', `轮次已存在 type=${stype} roundId=${existing.id.slice(-6)} status=${existing.status}`);
    } else {
      log('ROUND', `创建新轮次 type=${stype} targetMsg=${payload.targetMessageId.slice(-6)}`);
    }

    // Link to latest settled round of same settlement type
    const latestSettled = await prisma.settlementRound.findFirst({
      where: { messageId: payload.targetMessageId, settlementType: stype, status: 'SETTLED' },
      orderBy: { closedAt: 'desc' },
      select: { id: true },
    });

    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.message.create({
        data: {
          topicId,
          createdById: actorId,
          kind: 'ROUND',
          contentType: 'TEXT',
          content: roundContent,
          targetRefs: [{ messageId: payload.targetMessageId }],
          relationPayload: { note: payload.note ?? null, settlementType: stype },
        },
        include: { createdBy: { select: { id: true, username: true } } },
      }),
    ];
    // Only create SettlementRound if no active round exists
    if (!existing) {
      ops.push(prisma.settlementRound.create({
        data: {
          messageId: payload.targetMessageId,
          createdByUserId: actorId,
          status: 'VOTING',
          settlementType: stype,
          previousRoundId: latestSettled?.id ?? null,
          note: payload.note ?? null,
        },
      }));
    }

    const txResults = await prisma.$transaction(ops);
    let message = txResults[0] as any;
    const roundId = existing?.id ?? (!existing ? (txResults[1] as { id: string } | undefined)?.id : null);
    if (roundId) {
      message = await prisma.message.update({
        where: { id: message.id },
        data: { relationPayload: { note: payload.note ?? null, settlementType: stype, roundId } },
        include: { createdBy: { select: { id: true, username: true } } },
      });
    }

    await writeAuditLog({
      actorId,
      action: 'MESSAGE_CREATED',
      entityType: 'Message',
      entityId: message.id,
      topicId,
      summary: `发起结算轮次`,
      details: { kind: 'ROUND', targetMessageId: payload.targetMessageId, settlementType: stype, roundId: roundId ?? null },
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
    if (!userBalance) throw new Error('Account not found');
    if (userBalance.debtFrozen) throw new Error('账户负债冻结，无法发送消息。当前余额为负，还清负债后将自动解冻。');
    if (userBalance.balance < requiredStake) {
      throw new Error(`贡献点余额不足：发送此消息需要自押 ${requiredStake} 点，你当前余额为 ${userBalance.balance} 点，还差 ${requiredStake - userBalance.balance} 点。`);
    }
  }

  if (!payload.content) throw new Error('TEXT 消息内容不能为空');

  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        topicId,
        createdById: actorId,
        kind: kind as 'TEXT' | 'GOVERNANCE' | 'CODE' | 'OPERATIONS',
        contentType: payload.contentType ?? 'TEXT',
        content: payload.content,
        quoteSourceId: payload.quoteSourceId ?? null,
        quotedText: payload.quotedText ?? null,
        quotedTextHash: payload.quotedTextHash ?? null,
        quoteContextBefore: payload.quoteContextBefore ?? null,
        quoteContextAfter: payload.quoteContextAfter ?? null,
        // Governance/Code relation fields
        relationType: payload.relationType ?? null,
        relSourceId: payload.sourceMessageId ?? null,
        targetRefs: (payload.targetRefs as Prisma.InputJsonValue) ?? null,
        relationPayload: (payload.relationPayload as Prisma.InputJsonValue) ?? null,
      },
      include: { createdBy: { select: { id: true, username: true } } },
    }),
  ]);

  await writeAuditLog({
    actorId,
    action: 'MESSAGE_CREATED',
    entityType: 'Message',
    entityId: message.id,
    topicId,
    summary: `发布${kind}消息`,
    details: {
      kind,
      contentType: payload.contentType ?? 'TEXT',
      contentLength: payload.content?.length ?? 0,
      quoteSourceId: payload.quoteSourceId ?? null,
      quotedTextHash: payload.quotedTextHash ?? null,
      relationType: payload.relationType ?? null,
    },
  });

  // Auto-self-stake PRO (Phase 2.5) — must run AFTER ensureVotingRound so stake gets roundId
  const round = await ensureVotingRound(message.id, actorId, topicId, 'TRUTH');
  const stakeAmount = await autoSelfStake(actorId, topicId, message.id, payload.stakeAmount, 'PRO', round?.id, 'TRUTH');
  log('消息', `TEXT msg=${message.id.slice(-6)} round=${round?.id.slice(-6) ?? 'none'} stake=${stakeAmount ?? 0}`);

  return message;
}

// ============================================================
// Revenue Distribution — triggered by OPERATIONS message
// ============================================================

async function executeRevenueDistribution(actorId: string, topicId: string, messageId: string) {
  const pool = await prisma.revenuePool.findFirst();
  if (!pool || pool.balance <= 0) return;

  const rule = await prisma.ruleVersion.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { version: 'desc' },
    select: { parameters: true },
  });
  const distRules = (rule?.parameters as Record<string, unknown> | null)?.revenueDistribution as Record<string, number> | undefined;
  const contributorShare = distRules?.contributorShare ?? 0.5;
  const totalBalance = pool.balance;
  const contributorAmount = Math.floor(totalBalance * contributorShare);
  const retainedAmount = totalBalance - contributorAmount;

  if (contributorAmount <= 0) return;

  const balances = await prisma.balance.findMany({
    where: { balance: { gt: 0 } },
    select: { userId: true, balance: true },
  });
  const totalUserBalance = balances.reduce((s, b) => s + b.balance, 0);
  if (totalUserBalance <= 0 || balances.length === 0) return;

  const distOps: Array<{ userId: string; amount: number; balanceAfter: number }> = [];
  const distributionRecords: Array<{ revenuePoolId: string; userId: string; amount: number }> = [];

  for (const b of balances) {
    const share = Math.floor((b.balance / totalUserBalance) * contributorAmount);
    if (share <= 0) continue;
    distOps.push({ userId: b.userId, amount: share, balanceAfter: b.balance + share });
    distributionRecords.push({ revenuePoolId: pool.id, userId: b.userId, amount: share });
  }

  const totalDistributed = distOps.reduce((s, d) => s + d.amount, 0);
  const dust = contributorAmount - totalDistributed;
  if (dust > 0 && distOps.length > 0) {
    distOps[0].amount += dust;
    distOps[0].balanceAfter += dust;
    distributionRecords[0].amount += dust;
  }

  await prisma.$transaction([
    ...distOps.map(d => prisma.balance.update({ where: { userId: d.userId }, data: { balance: { increment: d.amount } } })),
    ...distOps.map(d => prisma.pointAccount.update({ where: { userId: d.userId }, data: { available: { increment: d.amount } } })),
    ...distOps.map(d => prisma.ledgerEntry.create({ data: { userId: d.userId, entryType: 'REVENUE_EARNED', amount: d.amount, balanceAfter: d.balanceAfter, data: { source: 'REVENUE_DISTRIBUTION', messageId, totalPool: totalBalance, contributorAmount } } })),
    ...distributionRecords.map(dr => prisma.revenueDistribution.create({ data: { revenuePoolId: pool.id, userId: dr.userId, amount: dr.amount } })),
    prisma.revenuePool.update({ where: { id: pool.id }, data: { balance: retainedAmount, totalDistributed: { increment: contributorAmount } } }),
  ]);

  await writeAuditLog({
    actorId,
    action: 'REVENUE_DISTRIBUTED',
    entityType: 'RevenuePool',
    entityId: pool.id,
    topicId,
    summary: `收入分配：${contributorAmount} 点分给 ${distOps.length} 位用户`,
    details: { messageId, totalPool: totalBalance, contributorAmount, retainedAmount, recipientCount: distOps.length, contributorShare, distributions: distOps.map(d => ({ userId: d.userId, amount: d.amount })) },
  });
}

// ============================================================
// Proposal carryOut — unified governance action execution
// ============================================================

async function carryOutProposal(
  actorId: string, topicId: string, messageId: string, roundId: string,
  payload: Record<string, unknown> | null, opType?: string,
) {
  const rule = await prisma.ruleVersion.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { version: 'desc' },
    select: { parameters: true },
  });
  const reqs = (rule?.parameters as Record<string, unknown> | null)?.governanceRequirements as Record<string, number> | undefined;

  // Check governance requirements
  if (reqs?.minTotalStakeWeight) {
    const round = await prisma.settlementRound.findUnique({ where: { id: roundId }, select: { settlementPro: true, settlementCon: true } });
    const weight = (round?.settlementPro ?? 0) + (round?.settlementCon ?? 0);
    if (weight < reqs.minTotalStakeWeight) return;
  }

  const now = new Date();

  if (opType === 'DISTRIBUTE_REVENUE') {
    await executeRevenueDistribution(actorId, topicId, messageId);
  } else if (opType === 'REVENUE_INJECTION') {
    const amount = payload?.amount;
    const source = payload?.source;
    if (!Number.isInteger(amount) || (amount as number) <= 0 || typeof source !== 'string' || !source.trim()) return;
    await applyRevenueInjected({
      type: 'REVENUE_INJECTED', actorId, topicId,
      payload: { amount: amount as number, source: source.trim(), note: typeof payload?.note === 'string' ? payload.note : null },
    });
  } else if (opType === 'RECHARGE') {
    const amount = payload?.amount;
    const revenuePoolShare = payload?.revenuePoolShare;
    if (!Number.isInteger(amount) || (amount as number) <= 0 || !Number.isInteger(revenuePoolShare) || (revenuePoolShare as number) < 0 || (revenuePoolShare as number) > (amount as number)) return;
    await applyPointsRecharged({
      type: 'POINTS_RECHARGED', actorId, topicId,
      payload: { amount: amount as number, revenuePoolShare: revenuePoolShare as number, note: typeof payload?.note === 'string' ? payload.note : null },
    });
  } else if (opType === 'TERMINATE_SETTLEMENT') {
    await executeTermination(payload, roundId, topicId, actorId);
  } else {
    // Default: UPDATE_RULES
    const proposedParams = payload?.proposedParameters as Record<string, unknown> | undefined;
    if (!proposedParams || typeof proposedParams !== 'object') return;
    const currentActive = await prisma.ruleVersion.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, parameters: true },
    });
    const merged = { ...(currentActive?.parameters as Record<string, unknown> ?? {}), ...proposedParams };
    const newVersion = (currentActive?.version ?? 0) + 1;
    const newRule = await prisma.ruleVersion.create({
      data: { version: newVersion, status: 'ACTIVE', description: `治理提案通过 (消息 ${messageId.slice(-8)})`, parameters: merged as Prisma.InputJsonValue },
    });
    if (currentActive) {
      await prisma.ruleVersion.update({ where: { id: currentActive.id }, data: { status: 'SUPERSEDED' } });
    }
    await writeAuditLog({
      actorId, action: 'RULE_VERSION_CREATED', entityType: 'RuleVersion', entityId: newRule.id, topicId,
      summary: `治理提案通过 → 规则版本 v${newVersion}`,
      details: { version: newVersion, previousVersion: currentActive?.version ?? null, messageId, proposedKeys: Object.keys(proposedParams) },
    });
  }

  // Mark round as EFFECTED
  await prisma.settlementRound.update({
    where: { id: roundId },
    data: { status: 'EFFECTED', effectiveAt: now },
  });
}

async function executeTermination(payload: Record<string, unknown> | null, roundId: string, topicId: string, actorId: string) {
  // Resolve target message IDs to their latest SETTLED round
  const targetMsgIds = payload?.targetMessageIds as string[] | undefined;
  if (!targetMsgIds || targetMsgIds.length === 0) return;

  for (const msgId of targetMsgIds) {
    // Validate target is a GOVERNANCE message
    const targetMsg = await prisma.message.findUnique({
      where: { id: msgId },
      select: { kind: true },
    });
    if (targetMsg?.kind !== 'GOVERNANCE') continue;

    // Find the latest SETTLED round for this message
    const latestRound = await prisma.settlementRound.findFirst({
      where: { messageId: msgId, status: { in: ['SETTLED', 'EFFECTED'] } },
      orderBy: { closedAt: 'desc' },
      select: { id: true },
    });
    if (!latestRound) continue;

    await prisma.settlementRound.update({
      where: { id: latestRound.id },
      data: { terminatedByRoundId: roundId },
    });

    await writeAuditLog({
      actorId, action: 'SETTLEMENT_TERMINATED', entityType: 'SettlementRound', entityId: latestRound.id, topicId,
      summary: `结算轮次已被提案终止`,
      details: { terminateRoundId: latestRound.id, targetMessageId: msgId, byRoundId: roundId },
    });
  }
}

/**
 * Resolve an annotation/ stance target: follow AGREE/DISAGREE/RECOMMEND/ARCHIVE
 * chain to find the ultimate text message target, with side transformation.
 *
 * Rules:
 *   AGREE on RECOMMEND → RECOMMEND on original text (PRO for VALUE)
 *   DISAGREE on RECOMMEND → ARCHIVE on original text (CON for VALUE)
 *   AGREE on ARCHIVE → ARCHIVE on original text (CON for VALUE)
 *   DISAGREE on ARCHIVE → RECOMMEND on original text (PRO for VALUE)
 *   AGREE on AGREE → AGREE on original text (PRO for TRUTH)
 *   DISAGREE on AGREE → DISAGREE on original text (CON for TRUTH)
 *   AGREE on DISAGREE → DISAGREE on original text (CON for TRUTH)
 *   DISAGREE on DISAGREE → AGREE on original text (PRO for TRUTH)
 *
 * Returns { relationType, targetTextId, settlementType } or null if no resolution.
 * If targetTextId is same as existing same-type annotation, returns { dedup: true }.
 */
interface ResolvedAnnotation {
  relationType: string;
  targetTextId: string;
  settlementType: 'TRUTH' | 'VALUE';
  dedup?: boolean;
}

async function resolveAnnotationTarget(
  relationType: string,
  targetRelationId: string,
  topicId: string,
): Promise<ResolvedAnnotation | null> {
  const targetRel = await prisma.message.findUnique({
    where: { id: targetRelationId },
    select: { kind: true, relationType: true, targetRefs: true },
  });
  if (!targetRel || targetRel.kind !== 'RELATION') return null;

  const targetRelType = targetRel.relationType?.toUpperCase();
  const isAgree = relationType.toUpperCase() === 'AGREE';
  const isDisagree = relationType.toUpperCase() === 'DISAGREE';
  if (!isAgree && !isDisagree) return null;

  const refs = targetRel.targetRefs as Array<{ messageId?: string }> | undefined;
  const origTextId = refs?.[0]?.messageId;
  if (!origTextId) return null;

  // ── Annotation layer: RECOMMEND / ARCHIVE ──
  if (targetRelType === 'RECOMMEND' || targetRelType === 'ARCHIVE') {
    // AGREE on RECOMMEND → RECOMMEND, DISAGREE on RECOMMEND → ARCHIVE
    // AGREE on ARCHIVE → ARCHIVE, DISAGREE on ARCHIVE → RECOMMEND
    const promoteRecommend = (targetRelType === 'RECOMMEND' && isAgree) || (targetRelType === 'ARCHIVE' && isDisagree);
    const newType = promoteRecommend ? 'RECOMMEND' : 'ARCHIVE';

    // Check dedup: does same-type annotation already exist for this text target?
    const topicRelations = await prisma.message.findMany({
      where: {
        topicId,
        kind: 'RELATION',
        relationType: newType,
        supersededBy: null,
      },
      select: { id: true, targetRefs: true },
    });
    const existingSame = topicRelations.find(r => {
      const trefs = r.targetRefs as Array<{ messageId?: string }> | undefined;
      return trefs?.[0]?.messageId === origTextId;
    });

    return {
      relationType: newType,
      targetTextId: origTextId,
      settlementType: 'VALUE',
      dedup: !!existingSame,
    };
  }

  // ── Stance layer: AGREE / DISAGREE ──
  if (targetRelType === 'AGREE' || targetRelType === 'DISAGREE') {
    // AGREE on AGREE → AGREE, DISAGREE on AGREE → DISAGREE
    // AGREE on DISAGREE → DISAGREE, DISAGREE on DISAGREE → AGREE
    const opinionFlipped = (targetRelType === 'AGREE' && isDisagree) || (targetRelType === 'DISAGREE' && isAgree);
    const newType = opinionFlipped ? 'DISAGREE' : 'AGREE';

    return {
      relationType: newType,
      targetTextId: origTextId,
      settlementType: 'TRUTH',
    };
  }

  return null;
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
  const subTypeMinStake = (ruleParams?.subTypeMinStake as Record<string, number> | null) ?? {};
  let typeDefault = relationTypeMinStake[payload.relationType.toUpperCase()]
    ?? (ruleParams?.selfStakeOnCreate as number | undefined);

  // If the relation payload has a subType, enforce the higher of type-default and subType-default
  const payloadObj = payload.relationPayload as Record<string, unknown> | undefined;
  if (payloadObj?.subType) {
    const subTypeMin = subTypeMinStake[payloadObj.subType as string];
    if (subTypeMin && (!typeDefault || subTypeMin > typeDefault)) {
      typeDefault = subTypeMin;
    }
  }

  const requiredStake = payload.stakeAmount ?? typeDefault;
  if (requiredStake && requiredStake > 0) {
    const userBalance = await prisma.balance.findUnique({ where: { userId: actorId } });
    if (!userBalance) throw new Error('Account not found');
    if (userBalance.debtFrozen) throw new Error('账户负债冻结，无法发送消息。当前余额为负，还清负债后将自动解冻。');
    if (userBalance.balance < requiredStake) {
      throw new Error(`贡献点余额不足：发送此关系需要自押 ${requiredStake} 点，你当前余额为 ${userBalance.balance} 点，还差 ${requiredStake - userBalance.balance} 点。`);
    }
  }

  // ── Transformation: AGREE/DISAGREE on annotations/stances ──
  // When AGREE/DISAGREE targets a RECOMMEND/ARCHIVE/AGREE/DISAGREE relation message,
  // transform to the corresponding type pointing to the original text message.
  const relType = payload.relationType?.toUpperCase();
  let effectiveRelationType = payload.relationType;
  let effectiveSourceMessageId = payload.sourceMessageId ?? null;
  let effectiveTargetRefs = payload.targetRefs;
  let effectiveSettlementType: 'TRUTH' | 'VALUE' = 'TRUTH';
  let isDedup = false;
  let dedupExistingId: string | null = null;
  let transformedFrom: string | null = null;

  if (relType === 'AGREE' || relType === 'DISAGREE') {
    const targets = payload.targetRefs as Array<{ kind?: string; messageId?: string; relationId?: string }>;
    if (targets.length > 0) {
      const firstTarget = targets[0];
      const targetRelId = firstTarget.relationId;
      if (targetRelId) {
        const resolved = await resolveAnnotationTarget(payload.relationType, targetRelId, topicId);
        if (resolved) {
          transformedFrom = relType;
          effectiveRelationType = resolved.relationType;
          effectiveSourceMessageId = null; // Annotations have no source
          effectiveTargetRefs = [{ kind: 'message', messageId: resolved.targetTextId }];
          effectiveSettlementType = resolved.settlementType;
          // Don't dedup AGREE/DISAGREE on annotations — create a visible relation message card
        }
      }
    }
  }

  // ── Dedup: RECOMMEND/ARCHIVE same type on same text target ──
  // Only dedup if the subType matches — different subTypes produce distinct annotations.
  // Skip dedup entirely for transformed relations (AGREE/DISAGREE → RECOMMEND/ARCHIVE):
  // they should always create a visible independent annotation message.
  if (!isDedup && !transformedFrom && (effectiveRelationType.toUpperCase() === 'RECOMMEND' || effectiveRelationType.toUpperCase() === 'ARCHIVE')) {
    const targets = effectiveTargetRefs as Array<{ messageId?: string }>;
    const textTargetId = targets[0]?.messageId;
    if (textTargetId) {
      const newPayload = payload.relationPayload as Record<string, unknown> | null;
      const newSubType = newPayload?.subType as string | undefined;
      const newCustomLabel = newPayload?.customLabel as string | undefined;
      const reasonKey = (subType?: string, customLabel?: string) =>
        subType === 'CUSTOM' ? `CUSTOM:${(customLabel ?? '').trim()}` : (subType ?? '');
      const topicRelations = await prisma.message.findMany({
        where: {
          topicId,
          kind: 'RELATION',
          relationType: effectiveRelationType.toUpperCase(),
          supersededBy: null,
        },
        select: { id: true, targetRefs: true, relationPayload: true },
      });
      const existingSame = topicRelations.find(r => {
        const trefs = r.targetRefs as Array<{ messageId?: string }> | undefined;
        if (trefs?.[0]?.messageId !== textTargetId) return false;
        const existingPayload = r.relationPayload as Record<string, unknown> | null;
        const existSubType = existingPayload?.subType as string | undefined;
        const existCustomLabel = existingPayload?.customLabel as string | undefined;
        return reasonKey(newSubType, newCustomLabel) === reasonKey(existSubType, existCustomLabel);
      });
      if (existingSame) {
        isDedup = true;
        dedupExistingId = existingSame.id;
      }
    }
    effectiveSettlementType = 'VALUE';
  }

  // ── Dedup path: no new relation, just stake on existing ──
  if (isDedup) {
    const textTargetId = (effectiveTargetRefs as Array<{ messageId?: string }>)[0]?.messageId;
    if (!textTargetId) throw new Error('无法确定标注目标');

    const side = effectiveRelationType.toUpperCase() === 'RECOMMEND' ? 'PRO' as const : 'CON' as const;
    const round = await ensureVotingRound(textTargetId, actorId, topicId, effectiveSettlementType);
    await autoSelfStake(actorId, topicId, textTargetId, payload.stakeAmount, side, round?.id, effectiveSettlementType);

    // Increment sendCount on the existing relation's payload
    const existingRelRaw = await prisma.message.findUnique({
      where: { id: dedupExistingId! },
      select: { relationPayload: true },
    });
    const existingRp = (existingRelRaw?.relationPayload as Record<string, unknown>) ?? {};
    const curCount = (existingRp.sendCount as number) ?? 1;
    await prisma.message.update({
      where: { id: dedupExistingId! },
      data: { relationPayload: { ...existingRp, sendCount: curCount + 1 } as Prisma.InputJsonValue },
    });

    // Fetch the existing relation with full data, so frontend gets a complete object
    const existingRel = await prisma.message.findUnique({
      where: { id: dedupExistingId! },
      include: { createdBy: { select: { id: true, username: true } } },
    });

    // Audit log for deduplicated action
    await writeAuditLog({
      actorId,
      action: 'RELATION_CREATED',
      entityType: 'Relation',
      entityId: dedupExistingId ?? '',
      topicId,
      summary: `标注（重复） ${effectiveRelationType}`,
      details: {
        relationType: effectiveRelationType,
        originalType: transformedFrom ? payload.relationType : undefined,
        transformed: !!transformedFrom,
        deduplicated: true,
        targetRefs: effectiveTargetRefs as Prisma.InputJsonValue,
        settlementType: effectiveSettlementType,
      },
    });

    if (!existingRel) throw new Error('已存在的标注消息未找到');

    // Return in the same shape as Prisma Message model so route handler maps correctly
    return {
      id: existingRel.id,
      topicId: existingRel.topicId,
      relationType: existingRel.relationType ?? effectiveRelationType,
      relSourceId: existingRel.relSourceId ?? null,
      targetRefs: existingRel.targetRefs,
      relationPayload: existingRel.relationPayload ?? undefined,
      createdAt: existingRel.createdAt,
      createdBy: existingRel.createdBy,
      deduplicated: true,
    };
  }

  // ── Normal path: create new relation message ──
  // Attach sendCount and transformedFrom to relationPayload for annotation send-count display
  const rpForCreate: Record<string, unknown> | undefined = (effectiveRelationType.toUpperCase() === 'RECOMMEND' || effectiveRelationType.toUpperCase() === 'ARCHIVE')
    ? {
        ...(payload.relationPayload as Record<string, unknown> ?? {}),
        sendCount: 1,
        ...(transformedFrom ? { transformedFrom } : {}),
      }
    : (payload.relationPayload as Record<string, unknown> | undefined);
  const targetLabels = effectiveTargetRefs.map((target) => {
    if (!target || typeof target !== 'object') return String(target);
    const ref = target as Record<string, unknown>;
    const id = ref.messageId ?? ref.fragmentId ?? ref.relationId ?? ref.id;
    return id ? String(id).slice(-8) : JSON.stringify(target);
  });
  const relationContent = `建立关系：${effectiveRelationType}${targetLabels.length > 0 ? `；目标：${targetLabels.join('、')}` : ''}`;
  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        topicId,
        createdById: actorId,
        kind: 'RELATION',
        relationType: effectiveRelationType,
        relSourceId: effectiveSourceMessageId,
        targetRefs: effectiveTargetRefs as Prisma.InputJsonValue,
        relationPayload: rpForCreate as Prisma.InputJsonValue | undefined,
        contentType: 'TEXT',
        content: relationContent,
      },
      include: { createdBy: { select: { id: true, username: true } } },
    }),
  ]);

  log('rel-persist', `CREATED msg=${message.id.slice(-6)} kind=${message.kind} type=${effectiveRelationType} topic=${topicId.slice(-6)}`);
  if (payload.supersedesRelationId) {
    await prisma.message.update({
      where: { id: payload.supersedesRelationId },
      data: { supersededBy: message.id },
    });
  }

  const auditAction = payload.supersedesRelationId ? 'RELATION_SUPERSEDED' : 'RELATION_CREATED';
  await writeAuditLog({
    actorId,
    action: auditAction,
    entityType: 'Relation',
    entityId: message.id,
    topicId,
    summary: payload.supersedesRelationId ? `替换关系 ${effectiveRelationType}` : `建立关系 ${effectiveRelationType}`,
    details: {
      relationType: effectiveRelationType,
      originalRelationType: transformedFrom ? payload.relationType : undefined,
      transformed: !!transformedFrom,
      sourceMessageId: payload.sourceMessageId ?? null,
      supersedesRelationId: payload.supersedesRelationId ?? null,
      targetRefs: effectiveTargetRefs as Prisma.InputJsonValue,
      settlementType: effectiveSettlementType,
    },
  });

  // Auto-stake based on effective relation type
  const effRelType = effectiveRelationType.toUpperCase();
  if (effRelType === 'AGREE' || effRelType === 'DISAGREE') {
    const side = effRelType === 'AGREE' ? 'PRO' as const : 'CON' as const;
    const targets = effectiveTargetRefs as Array<{ kind?: string; messageId?: string; relationId?: string }>;
    for (const ref of targets) {
      const textTargetId = ref.messageId || ref.relationId;
      if (!textTargetId) continue;
      const round = await ensureVotingRound(textTargetId, actorId, topicId, 'TRUTH');
      const staked = await autoSelfStake(actorId, topicId, textTargetId, payload.stakeAmount, side, round?.id, 'TRUTH');
      log('站队', `${effRelType} msg=${message.id.slice(-6)} target=${textTargetId.slice(-6)} round=${round?.id.slice(-6) ?? 'none'} side=${side} stake=${staked ?? 0}${transformedFrom ? ` from=${transformedFrom}` : ''}`);
    }
  } else if (effRelType === 'RECOMMEND' || effRelType === 'ARCHIVE') {
    // Value settlement: RECOMMEND=PRO, ARCHIVE=CON
    const side = effRelType === 'RECOMMEND' ? 'PRO' as const : 'CON' as const;
    const targets = effectiveTargetRefs as Array<{ kind?: string; messageId?: string; relationId?: string }>;
    for (const ref of targets) {
      const textTargetId = ref.messageId || ref.relationId;
      if (!textTargetId) continue;
      const round = await ensureVotingRound(textTargetId, actorId, topicId, 'VALUE');
      const staked = await autoSelfStake(actorId, topicId, textTargetId, payload.stakeAmount, side, round?.id, 'VALUE');
      log('标注', `${effRelType} msg=${message.id.slice(-6)} target=${textTargetId.slice(-6)} round=${round?.id.slice(-6) ?? 'none'} side=${side} stake=${staked ?? 0}${transformedFrom ? ` from=${transformedFrom}` : ''}${isDedup ? '' : ' NEW'}`);
    }
  } else {
    // Other relations (including JOIN): PRO on the relation message itself
    const round = await ensureVotingRound(message.id, actorId, topicId);
    await autoSelfStake(actorId, topicId, message.id, payload.stakeAmount, 'PRO', round?.id);
  }

  return message;
}

/**
 * Follow AGREE/DISAGREE relation chain to find the ultimate non-stance target.
 * Each DISAGREE hop flips the effective side.
 * Returns { targetId, side } for the ultimate target.
 */
async function resolveStanceChain(
  startTargetId: string,
  startSide: 'PRO' | 'CON'
): Promise<{ targetId: string; side: 'PRO' | 'CON' }> {
  const MAX_DEPTH = 20;
  const visited = new Set<string>();
  let currentId = startTargetId;
  let effectiveSide = startSide;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const rel = await prisma.message.findUnique({
      where: { id: currentId },
      select: { kind: true, relationType: true, targetRefs: true },
    });
    if (!rel || rel.kind !== 'RELATION') break;
    const rt = rel.relationType?.toUpperCase();
    if (rt !== 'AGREE' && rt !== 'DISAGREE') break;
    if (visited.has(currentId)) break;
    visited.add(currentId);

    if (rt === 'DISAGREE') {
      effectiveSide = effectiveSide === 'PRO' ? 'CON' : 'PRO';
    }
    const refs = rel.targetRefs as Array<{ messageId?: string; relationId?: string }>;
    const nextId = refs[0]?.messageId || refs[0]?.relationId;
    if (!nextId) break;
    currentId = nextId;
  }
  return { targetId: currentId, side: effectiveSide };
}

// ── Auto Self-Stake Helper (Phase 2.5-2.6) ───────────────────

async function autoSelfStake(userId: string, topicId: string, messageId: string, overrideAmount?: number, side: 'PRO' | 'CON' = 'PRO', roundId?: string | null, settlementType: string = 'TRUTH'): Promise<number | undefined> {
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

    const result = await executeStake({
      userId,
      topicId,
      messageId,
      side,
      amount: selfStakeAmount,
      roundId: roundId ?? null,
      settlementType,
    });

    await writeAuditLog({
      actorId: userId,
      action: 'STAKE_PLACED',
      entityType: 'Stake',
      entityId: result.stakeId,
      topicId,
      summary: `${side === 'PRO' ? '支持' : '反对'}押注 ${selfStakeAmount} 点`,
      details: { messageId, side, amount: selfStakeAmount, roundId: roundId ?? null, settlementType, feeAmount: result.feeAmount },
    });

    return selfStakeAmount;
  } catch {
    return undefined;
  }
}

// ── Auto Round & Vote Helpers (Phase 3.1) ─────────────────────

/**
 * Ensure a VOTING settlement round exists for a message.
 * If none exists, creates one. Returns the round or undefined.
 * @param settlementType 'TRUTH' for AGREE/DISAGREE, 'VALUE' for RECOMMEND/ARCHIVE
 */
async function ensureVotingRound(messageId: string, actorId: string, topicId: string, settlementType: string = 'TRUTH') {
  // Check for existing active round of the same settlement type
  const existing = await prisma.settlementRound.findFirst({
    where: { messageId, settlementType, status: { in: ['OPEN', 'VOTING'] } },
    select: { id: true },
  });
  if (existing) {
    return existing;
  }

  debugLog('ensureVotingRound', `创建新轮次 msg=${messageId?.slice(-6) ?? '?'} type=${settlementType}`);

  // Link to latest settled round of the same settlement type for overturn chain
  const latestSettled = await prisma.settlementRound.findFirst({
    where: { messageId, settlementType, status: 'SETTLED' },
    orderBy: { closedAt: 'desc' },
    select: { id: true },
  });

  const [round] = await prisma.$transaction([
    prisma.settlementRound.create({
      data: {
        messageId,
        createdByUserId: actorId,
        status: 'VOTING',
        settlementType,
        previousRoundId: latestSettled?.id ?? null,
        note: null,
      },
    }),
  ]);

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
  ]);

  await writeAuditLog({
    actorId,
    action: 'POINT_MINTED',
    entityType: 'PointTransaction',
    entityId: actorId,
    summary: `铸造 ${payload.amount} 点`,
    details: { amount: payload.amount, reason: payload.reason, note: payload.note },
  });

  return { available: newAvailable, balance: newBalance };
}

async function applyRevenueInjected(event: RevenueInjectedEvent) {
  const { actorId, topicId, payload, signature } = event;
  if (!Number.isInteger(payload.amount) || payload.amount <= 0) {
    throw new Error('收入注入金额必须是正整数');
  }
  const source = payload.source.trim();
  if (!source) throw new Error('收入来源不能为空');

  const pool = await prisma.revenuePool.findFirst();
  const poolRecord = pool
    ? await prisma.revenuePool.update({ where: { id: pool.id }, data: { totalReceived: { increment: payload.amount }, balance: { increment: payload.amount } } })
    : await prisma.revenuePool.create({ data: { totalReceived: payload.amount, balance: payload.amount } });

  await writeAuditLog({
    actorId, action: 'REVENUE_RECEIVED', entityType: 'RevenuePool', entityId: poolRecord.id, topicId,
    summary: `运营收入入池 ${payload.amount} 点`,
    details: { amount: payload.amount, source: 'PROPOSAL', sourceLabel: source, note: payload.note ?? null }, signature,
  });
  return { pool: poolRecord };
}

async function applyPointsRecharged(event: PointsRechargedEvent) {
  const { actorId, topicId, payload, signature } = event;
  if (!Number.isInteger(payload.amount) || payload.amount <= 0) {
    throw new Error('充值金额必须是正整数');
  }
  if (!Number.isInteger(payload.revenuePoolShare) || payload.revenuePoolShare < 0 || payload.revenuePoolShare > payload.amount) {
    throw new Error('收入池分成必须在 0 和充值金额之间');
  }
  const userAmount = payload.amount - payload.revenuePoolShare;
  const account = await prisma.pointAccount.findUnique({ where: { userId: actorId } });
  const currentBalance = await prisma.balance.findUnique({ where: { userId: actorId } });
  if (!account || !currentBalance) throw new Error('账户不存在');

  const pool = await prisma.revenuePool.findFirst();

  const newAvailable = account.available + userAmount;
  await prisma.$transaction([
    prisma.pointAccount.update({ where: { userId: actorId }, data: { available: newAvailable } }),
    prisma.balance.update({ where: { userId: actorId }, data: { balance: { increment: userAmount } } }),
    prisma.pointTransaction.create({ data: { userId: actorId, type: 'MINT', amount: userAmount, balanceAfter: newAvailable, data: { reason: 'RECHARGE', totalAmount: payload.amount, revenuePoolShare: payload.revenuePoolShare } } }),
    prisma.ledgerEntry.create({ data: { userId: actorId, entryType: 'MINT_DAILY', amount: userAmount, balanceAfter: currentBalance.balance + userAmount, data: { reason: 'RECHARGE', totalAmount: payload.amount, revenuePoolShare: payload.revenuePoolShare } } }),
    ...(payload.revenuePoolShare > 0
      ? [pool
        ? prisma.revenuePool.update({ where: { id: pool.id }, data: { totalReceived: { increment: payload.revenuePoolShare }, balance: { increment: payload.revenuePoolShare } } })
        : prisma.revenuePool.create({ data: { totalReceived: payload.revenuePoolShare, balance: payload.revenuePoolShare } })]
      : []),
  ]);

  const poolAfter = payload.revenuePoolShare > 0 ? await prisma.revenuePool.findFirst() : pool;
  await writeAuditLog({
    actorId, action: 'POINT_MINTED', entityType: 'PointTransaction', entityId: actorId,
    summary: `充值铸造 ${payload.amount} 点`,
    details: { amount: userAmount, creditedAmount: userAmount, reason: 'RECHARGE', totalAmount: payload.amount, revenuePoolShare: payload.revenuePoolShare }, signature,
  });
  if (payload.revenuePoolShare > 0) {
    await writeAuditLog({
      actorId, action: 'REVENUE_RECEIVED', entityType: 'RevenuePool', entityId: poolAfter?.id ?? 'revenue-pool', topicId,
      summary: `充值分成入池 ${payload.revenuePoolShare} 点`,
      details: { amount: payload.revenuePoolShare, source: 'RECHARGE', totalAmount: payload.amount, userAmount }, signature,
    });
  }
  return { userAmount, revenuePoolShare: payload.revenuePoolShare };
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
  ]);

  await writeAuditLog({
    actorId,
    action: 'POINT_TRANSFERRED',
    entityType: 'PointTransaction',
    entityId: payload.fromUserId,
    summary: `转移 ${payload.amount} 点给用户`,
    details: { from: payload.fromUserId, to: payload.toUserId, amount: payload.amount, note: payload.note },
  });

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
  settlementType?: string;
}) {
  const { userId, topicId, messageId, side, amount, roundId, settlementType = 'TRUTH' } = params;

  // Validate user state
  const [userBalance, pointAccount] = await Promise.all([
    prisma.balance.findUnique({ where: { userId } }),
    prisma.pointAccount.findUnique({ where: { userId } }),
  ]);

  if (!userBalance || !pointAccount) {
    throw new Error('Account not found');
  }
  if (userBalance.debtFrozen) {
    throw new Error('账户负债冻结，无法执行此操作。当前余额为负，还清负债后将自动解冻。');
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

  // Atomic write: account + stake + betPool + ledger + fee + auditLog
  const [stake] = await prisma.$transaction([
    prisma.stake.create({
      data: { userId, topicId, messageId, side, amount, roundId: roundId ?? null, settlementType },
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
        data: { side, messageId, topicId, staked: amount, fee: feeAmount },
      },
    }),
    // Upsert BetPool by (messageId, settlementType) — separate pools for TRUTH/VALUE
    prisma.betPool.upsert({
      where: { messageId_settlementType: { messageId, settlementType } },
      create: {
        messageId,
        settlementType,
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
    // Protocol fee: deducted from user, collected into RevenuePool
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
  ]);

  // ── Collect protocol fee into RevenuePool ──
  if (feeAmount > 0) {
    const pool = await prisma.revenuePool.findFirst();
    let poolId = pool?.id;
    if (pool) {
      await prisma.revenuePool.update({
        where: { id: pool.id },
        data: { totalReceived: { increment: feeAmount }, balance: { increment: feeAmount } },
      });
    } else {
      await prisma.revenuePool.create({ data: { totalReceived: feeAmount, balance: feeAmount } });
    }
    await writeAuditLog({
      actorId: userId,
      action: 'REVENUE_RECEIVED',
      entityType: 'RevenuePool',
      entityId: pool?.id ?? 'revenue-pool',
      topicId,
      summary: `协议手续费入池 ${feeAmount} 点`,
      details: { amount: feeAmount, source: 'STAKE', messageId },
    });
  }

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
    feeAmount,
    newAvailable,
    newLocked,
    newBalance,
  };
}

async function applyStakePlaced(event: StakePlacedEvent) {
  const { actorId, topicId, payload } = event;
  const result = await executeStake({
    userId: actorId,
    topicId,
    messageId: payload.messageId,
    side: payload.side,
    amount: payload.amount,
    roundId: payload.roundId ?? null,
  });

  await writeAuditLog({
    actorId,
    action: 'STAKE_PLACED',
    entityType: 'Stake',
    entityId: result.stakeId,
    topicId,
    summary: `${payload.side === 'PRO' ? '支持' : '反对'}押注 ${payload.amount} 点`,
    details: { messageId: payload.messageId, side: payload.side, amount: payload.amount, roundId: payload.roundId ?? null, feeAmount: result.feeAmount },
  });

  return result;
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
  ]);

  await writeAuditLog({
    actorId,
    action: 'ROUND_CREATED',
    entityType: 'SettlementRound',
    entityId: round.id,
    topicId,
    summary: `发起结算轮次`,
    details: { messageId: payload.messageId, previousRoundId: latestSettled?.id ?? null, note: payload.note ?? null },
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
        data: { vote: payload.vote, roundId: payload.roundId, messageId: round.messageId, topicId, staked: payload.amount, fee: feeAmount },
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
    // Protocol fee: deducted from user, collected into RevenuePool
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
  ]);

  await writeAuditLog({
    actorId,
    action: 'VOTE_CAST',
    entityType: 'VoteStake',
    entityId: vote.id,
    topicId,
    summary: `投票 ${payload.vote === 'TRUE' ? '赞成' : '反对'} ${payload.amount} 点`,
    details: { messageId: round.messageId, roundId: payload.roundId, vote: payload.vote, amount: payload.amount, feeAmount },
  });

  // ── Collect protocol fee into RevenuePool ──
  if (feeAmount > 0) {
    const pool = await prisma.revenuePool.findFirst();
    let poolId = pool?.id;
    if (pool) {
      await prisma.revenuePool.update({
        where: { id: pool.id },
        data: { totalReceived: { increment: feeAmount }, balance: { increment: feeAmount } },
      });
    } else {
      const createdPool = await prisma.revenuePool.create({ data: { totalReceived: feeAmount, balance: feeAmount } });
      poolId = createdPool.id;
    }
    await writeAuditLog({
      actorId,
      action: 'REVENUE_RECEIVED',
      entityType: 'RevenuePool',
      entityId: poolId ?? 'revenue-pool',
      topicId,
      summary: `协议投票费入池 ${feeAmount} 点`,
      details: { amount: feeAmount, source: 'VOTE', roundId: payload.roundId, messageId: round.messageId },
    });
  }

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
      settlementType: true,
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
    const permission = (rule?.parameters as Record<string, unknown> | null)?.settlementPermission ?? 'anyone';

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

  // ── Compute total weights from BetPool by settlementType ──
  const stype = round.settlementType ?? 'TRUTH';
  const betPool = await prisma.betPool.findUnique({
    where: { messageId_settlementType: { messageId, settlementType: stype } },
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

  // ── Fetch message creator, kind & rule params for creator reward & governance ──
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { createdById: true, kind: true, content: true, relationPayload: true },
  });
  const creatorId = message?.createdById ?? '';
  const settlementRule = await prisma.ruleVersion.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { version: 'desc' },
    select: { parameters: true },
  });
  const ruleParams = settlementRule?.parameters as Record<string, unknown> | null;

  // Get all stakes for this message filtered by settlementType
  const allStakes = await prisma.stake.findMany({
    where: { messageId, settlementType: stype },
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

  // Build per-user contribution totals from all stakes of this settlement type.
  // allStakes already includes stakes from every round (query is by messageId +
  // settlementType, not roundId), so there is no need to add prevRoundStakes again.
  const userContributionMap = new Map<string, number>();
  for (const s of allStakes) {
    userContributionMap.set(s.userId, (userContributionMap.get(s.userId) ?? 0) + s.amount);
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
      data: { status: 'SETTLED', result, closedAt: now, settlementPro: totalPro, settlementCon: totalCon },
    }),
  );

  // ── Reset BetPool by settlementType: funds have been distributed ──
  ledgerOps.push(
    prisma.betPool.upsert({
      where: { messageId_settlementType: { messageId, settlementType: stype } },
      create: { messageId, settlementType: stype, lockedPro: 0, lockedCon: 0 },
      update: { lockedPro: 0, lockedCon: 0 },
    }),
  );

  // Audit log — written after transaction for consistency
  const resultLabel = result === 'TRUE' ? '赞成胜出' : result === 'FALSE' ? '反对胜出' : '平局';
  const settlementLabel = stype === 'VALUE' ? '价值仲裁' : '真假仲裁';
  const targetPreview = (message?.content ?? '').trim().replace(/\s+/g, ' ').slice(0, 120) || `消息 ${messageId.slice(-8)}`;
  const resultContent = `${settlementLabel}完成：目标消息「${targetPreview}」；结果：${resultLabel}（${result}）；TRUE 权重 ${totalPro}，FALSE 权重 ${totalCon}，总押注 ${totalPool}`;

  await prisma.$transaction(ledgerOps);

  await writeAuditLog({
    actorId,
    action: 'ROUND_SETTLED',
    entityType: 'SettlementRound',
    entityId: payload.roundId,
    topicId,
    summary: `结算完成：${resultLabel}`,
    details: { messageId, roundId: payload.roundId, result, weights, totalPro, totalCon, dust, affectedUsers: affectedUsers.length },
  });

  // ── Phase 6: Create ROUND_RESULT message ──
  await prisma.message.create({
    data: {
      topicId,
      createdById: actorId,
      kind: 'ROUND_RESULT',
      contentType: 'TEXT',
      content: resultContent,
      targetRefs: [{ messageId }],
      relationPayload: { roundId: payload.roundId, result, weights, totalPro, totalCon, settlementType: stype },
    },
  });

  // ── Governance carryOut: execute proposal action when TRUE ──
  if (result === 'TRUE' && message?.kind === 'GOVERNANCE') {
    const opType = (message.relationPayload as Record<string, unknown> | null)?.operationType as string | undefined;
    await carryOutProposal(actorId, topicId, messageId, payload.roundId, message.relationPayload as Record<string, unknown> | null, opType);
  }

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
    select: { result: true, closedAt: true, settlementType: true, terminatedByRoundId: true },
  });

  if (!prevRound || !prevRound.result || prevRound.result === 'UNKNOWN') {
    return;
  }

  // ── Terminated round: clawback is permanently blocked ──
  if (prevRound.terminatedByRoundId) {
    log('Clawback', `SKIPPED round=${previousRoundId.slice(-6)} — terminated`);
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

  const prevStype = prevRound.settlementType ?? 'TRUTH';

  // ── Look up original stakes (only those from before previous round ended) ──
  // Filter by settlementType to match the previous round's type
  const payoutUserIds = [...new Set(payouts.map(p => p.userId))];
  const [userStakes] = await Promise.all([
    prisma.stake.findMany({
      where: {
        messageId,
        settlementType: prevStype,
        userId: { in: payoutUserIds },
        createdAt: prevRound.closedAt ? { lte: prevRound.closedAt } : undefined,
      },
      select: { userId: true, amount: true },
    }),
  ]);
  const userStakeTotal = new Map<string, number>();
  for (const s of userStakes) {
    userStakeTotal.set(s.userId, (userStakeTotal.get(s.userId) ?? 0) + s.amount);
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

  // ── Restore BetPool from original stakes for the same settlement type ──
  const restoreType = prevRound?.settlementType ?? 'TRUTH';

  const stakes = await prisma.stake.findMany({
    where: { messageId, settlementType: restoreType },
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
      where: { messageId_settlementType: { messageId, settlementType: restoreType } },
      create: { messageId, settlementType: restoreType, lockedPro: restoredPro, lockedCon: restoredCon },
      update: { lockedPro: restoredPro, lockedCon: restoredCon },
    }),
  );

  // ── Audit log for clawback (actorId=null since it's system-triggered) ──
  // Written after transaction for consistency

  if (clawbackOps.length > 0) {
    await prisma.$transaction(clawbackOps);
  }

  await writeAuditLog({
    actorId: null,
    action: 'SETTLEMENT_CLAWBACK',
    entityType: 'SettlementRound',
    entityId: previousRoundId,
    topicId,
    summary: `结算回滚，恢复 PRO=${restoredPro} CON=${restoredCon}`,
    details: { messageId, previousRoundId, restoredPro, restoredCon, affectedUsers: payouts.length },
  });
}

// ── RelationTargetsUpdated Handler ──────────────────────────

async function applyRelationTargetsUpdated(event: RelationTargetsUpdatedEvent) {
  const { actorId, topicId, payload } = event;

  const updated = await prisma.message.update({
    where: { id: payload.relationId },
    data: { targetRefs: payload.targetRefs as Prisma.InputJsonValue },
    include: { createdBy: { select: { id: true, username: true } } },
  });

  await writeAuditLog({
    actorId,
    action: 'RELATION_TARGETS_UPDATED',
    entityType: 'Relation',
    entityId: payload.relationId,
    topicId,
    summary: `更新关系目标`,
    details: { targetRefs: payload.targetRefs, previousTargetRefs: payload.previousTargetRefs },
  });

  return updated;
}
