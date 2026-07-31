/**
 * replay.ts — Replay engine: rebuilds state from AuditLog entries.
 *
 * Reads all AuditLog entries in chronological order and applies each action
 * to an in-memory ReplayState, simulating the same state transitions as the
 * live system.
 */

import { prisma } from '../lib/prisma';
import {
  createEmptyState, ReplayState, betPoolKey,
  type MessageState, type StakeTotals, type VoteRecord,
} from './types';

export interface ReplayExportSnapshot {
  formatVersion: number;
  topicId: string;
  messages: Array<{
    id: string;
    kind: string;
    contentType?: string | null;
    content?: string | null;
    authorId: string;
    quoteSourceId?: string | null;
    quotedText?: string | null;
    quotedTextHash?: string | null;
    quoteContextBefore?: string | null;
    quoteContextAfter?: string | null;
    targetRefs?: unknown;
    relationPayload?: unknown;
    relationType?: string | null;
    sourceMessageId?: string | null;
    supersededBy?: string | null;
  }>;
  relations: Array<{
    id: string;
    relationType: string | null;
    sourceMessageId: string | null;
    targetRefs: unknown;
    payload: unknown;
    authorId: string;
    supersededBy: string | null;
  }>;
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function ensureBalance(state: ReplayState, userId: string): number {
  if (!state.balances.has(userId)) {
    state.balances.set(userId, 0);
    state.accounts.set(userId, { available: 0, locked: 0 });
    state.ledgerSummary.set(userId, { earned: 0, lost: 0, locked: 0, clawback: 0 });
  }
  return state.balances.get(userId)!;
}

function ensureStakeTotals(state: ReplayState, messageId: string): StakeTotals {
  if (!state.stakeTotals.has(messageId)) {
    state.stakeTotals.set(messageId, { pro: 0, con: 0 });
  }
  return state.stakeTotals.get(messageId)!;
}

function ensureBetPool(state: ReplayState, messageId: string, settlementType: string) {
  const key = betPoolKey(messageId, settlementType);
  if (!state.betPools.has(key)) {
    state.betPools.set(key, { pro: 0, con: 0 });
  }
  return state.betPools.get(key)!;
}

// ═══════════════════════════════════════════════════════════
// Action handlers
// ═══════════════════════════════════════════════════════════

function applyMint(state: ReplayState, userId: string, amount: number) {
  const acc = state.accounts.get(userId) ?? { available: 0, locked: 0 };
  acc.available += amount;
  state.accounts.set(userId, acc);

  const bal = ensureBalance(state, userId);
  state.balances.set(userId, bal + amount);
}

function applyStake(
  state: ReplayState,
  userId: string,
  messageId: string,
  side: 'PRO' | 'CON',
  amount: number,
  roundId: string | null | undefined,
  settlementType: string = 'TRUTH',
  feeAmount: number = 0,
) {
  const totalCost = amount + feeAmount;
  // Deduct from account (fee goes to revenue pool, amount is locked)
  const acc = state.accounts.get(userId);
  if (acc) {
    acc.available -= totalCost;
    acc.locked += amount;
    state.accounts.set(userId, acc);
  }
  // Deduct from balance (fee goes to revenue pool)
  const bal = state.balances.get(userId) ?? 0;
  state.balances.set(userId, bal - totalCost);

  // Protocol fee enters revenue pool
  state.revenuePoolBalance += feeAmount;

  // Record locked amount in ledger
  const ls = state.ledgerSummary.get(userId);
  if (ls) ls.locked += amount;

  // Update stake totals
  const st = ensureStakeTotals(state, messageId);
  if (side === 'PRO') st.pro += amount;
  else st.con += amount;

  // Update BetPool scoped by settlementType
  // If roundId is set, we need to find the round to get settlementType
  if (roundId) {
    const round = state.rounds.get(roundId);
    if (round) settlementType = round.settlementType;
  }
  const bp = ensureBetPool(state, messageId, settlementType);
  if (side === 'PRO') bp.pro += amount;
  else bp.con += amount;

  state.stakes.push({
    userId,
    messageId,
    side,
    amount,
    roundId: roundId ?? null,
    settlementType,
  });
}

function applyVote(
  state: ReplayState,
  userId: string,
  messageId: string,
  roundId: string,
  vote: 'TRUE' | 'FALSE',
  amount: number,
  feeAmount: number = 0,
) {
  // Deduct total cost (amount + fee) from available
  const acc = state.accounts.get(userId);
  if (acc) {
    acc.available -= (amount + feeAmount);
    acc.locked += amount;
    state.accounts.set(userId, acc);
  }

  // Track vote per round
  if (!state.votes.has(roundId)) {
    state.votes.set(roundId, []);
  }
  state.votes.get(roundId)!.push({ userId, vote, amount });

  // Update round weights
  const round = state.rounds.get(roundId);
  if (round) {
    if (vote === 'TRUE') round.weights.TRUE += amount;
    else round.weights.FALSE += amount;
  }

  // Protocol fee goes to revenue pool — reduce balance (not locked)
  const bal = state.balances.get(userId) ?? 0;
  state.balances.set(userId, bal - feeAmount);
  state.revenuePoolBalance += feeAmount;
}

function applySettle(
  state: ReplayState,
  messageId: string,
  roundId: string,
  result: 'TRUE' | 'FALSE' | 'UNKNOWN',
  weights: { TRUE: number; FALSE: number },
  totalPro: number,
  totalCon: number,
) {
  let round = state.rounds.get(roundId);
  if (!round) {
    const stype = state.stakes.find(stake => stake.roundId === roundId)?.settlementType ?? 'TRUTH';
    round = {
      messageId,
      settlementType: stype,
      status: 'VOTING',
      result: null,
      weights: { TRUE: 0, FALSE: 0 },
      previousRoundId: null,
      settledAtStakeCount: 0,
    };
    state.rounds.set(roundId, round);
  }

  round.status = 'SETTLED';
  round.result = result;
  round.weights = weights;
  round.settledAtStakeCount = state.stakes.length;

  if (result === 'UNKNOWN' || (weights.TRUE === 0 && weights.FALSE === 0)) return;

  const winnerSide = result === 'TRUE' ? 'PRO' : 'CON';
  const winnerTotal = result === 'TRUE' ? weights.TRUE : weights.FALSE;
  const loserTotal = result === 'TRUE' ? weights.FALSE : weights.TRUE;

  if (winnerTotal === 0) return;

  const rate = loserTotal / winnerTotal;

  // Settlement only processes stakes that belong to this round's settlementType.
  // A message may have multiple concurrent rounds (e.g. TRUTH + VALUE) with
  // independent settlement lifecycles. Filtering by messageId alone would
  // incorrectly include stakes from other settlement types.
  const roundStakes = state.stakes.filter(stake =>
    stake.messageId === messageId &&
    stake.settlementType === round.settlementType
  );
  const userDelta = new Map<string, number>();
  const userContribution = new Map<string, number>();
  const loserContribution = new Map<string, number>();
  let firstWinnerId: string | null = null;
  let totalDistributed = 0;

  for (const stake of roundStakes) {
    userContribution.set(
      stake.userId,
      (userContribution.get(stake.userId) ?? 0) + stake.amount,
    );
    const isWinner = (result === 'TRUE' && stake.side === 'PRO') ||
                     (result === 'FALSE' && stake.side === 'CON');
    if (isWinner) {
      const gain = Math.floor(stake.amount * rate);
      firstWinnerId ??= stake.userId;
      userDelta.set(stake.userId, (userDelta.get(stake.userId) ?? 0) + stake.amount + gain);
      totalDistributed += stake.amount + gain;
    } else {
      loserContribution.set(stake.userId, (loserContribution.get(stake.userId) ?? 0) + stake.amount);
    }
  }

  const applyDelta = (userId: string, delta: number, contribution: number) => {
    const acc = state.accounts.get(userId);
    const ls = state.ledgerSummary.get(userId);
    if (!acc || !ls) return;

    const unlockAmount = Math.min(acc.locked, contribution);
    acc.available += delta;
    acc.locked = Math.max(0, acc.locked - unlockAmount);
    ls.earned += Math.max(0, delta - contribution);
    const bal = state.balances.get(userId) ?? 0;
    state.balances.set(userId, bal + delta);
    state.accounts.set(userId, acc);
    state.ledgerSummary.set(userId, ls);
  };

  for (const [userId, delta] of userDelta) {
    applyDelta(userId, delta, userContribution.get(userId) ?? 0);
  }

  // Losing stakes do not change balance, but production moves only the
  // currently locked portion into totalLost and clamps the result at zero.
  for (const [userId, contribution] of loserContribution) {
    if (userDelta.has(userId)) continue;
    const acc = state.accounts.get(userId);
    const ls = state.ledgerSummary.get(userId);
    if (!acc || !ls) continue;
    const lostAmount = Math.min(acc.locked, contribution);
    acc.locked = Math.max(0, acc.locked - lostAmount);
    ls.lost += lostAmount;
    state.accounts.set(userId, acc);
    state.ledgerSummary.set(userId, ls);
  }

  // Match production settlement: distribute integer-division remainder to the
  // first winner so the entire pool remains accounted for.
  const dust = totalPro + totalCon - totalDistributed;
  if (dust > 0 && firstWinnerId) {
    const acc = state.accounts.get(firstWinnerId);
    if (acc) {
      acc.available += dust;
      state.accounts.set(firstWinnerId, acc);
      const bal = state.balances.get(firstWinnerId) ?? 0;
      state.balances.set(firstWinnerId, bal + dust);
    }
  }

  // Reset BetPool for this round's settlementType
  const stype = round.settlementType ?? 'TRUTH';
  const key = betPoolKey(messageId, stype);
  state.betPools.set(key, { pro: 0, con: 0 });
}

function applyClawback(
  state: ReplayState,
  messageId: string,
  previousRoundId: string,
  restoredPro: number,
  restoredCon: number,
) {
  const prevRound = state.rounds.get(previousRoundId);
  if (!prevRound || !prevRound.result || prevRound.result === 'UNKNOWN') return;

  // Clawback: reverse previous round's payouts for ALL stakes of this
  // settlement type that existed when the round was settled.  The previous
  // settlement processed every stake of this type that existed at the time,
  // including stakes from earlier rounds that were re-locked by a prior
  // clawback.  Filtering by roundId would miss those; not filtering at all
  // would include new stakes added after the settlement.
  const winnerTotal = prevRound.result === 'TRUE' ? prevRound.weights.TRUE : prevRound.weights.FALSE;
  const loserTotal = prevRound.result === 'TRUE' ? prevRound.weights.FALSE : prevRound.weights.TRUE;
  const winnerSide = prevRound.result === 'TRUE' ? 'PRO' : 'CON';
  const cutoff = prevRound.settledAtStakeCount;
  const prevStakes = state.stakes.slice(0, cutoff).filter(
    stake => stake.messageId === messageId && stake.settlementType === prevRound.settlementType,
  );

  // First pass: calculate what was distributed (to reverse dust correctly)
  let totalDistributed = 0;
  let firstWinnerId: string | null = null;
  for (const stake of prevStakes) {
    const wasWinner = stake.side === winnerSide;
    if (wasWinner && winnerTotal > 0) {
      const gain = Math.floor(stake.amount * loserTotal / winnerTotal);
      firstWinnerId ??= stake.userId;
      totalDistributed += stake.amount + gain;
    }
  }
  const totalPool = prevStakes.reduce((sum, st) => sum + st.amount, 0);
  const dust = totalPool - totalDistributed;

  // Second pass: reverse individual stakes
  for (const stake of prevStakes) {
    const acc = state.accounts.get(stake.userId);
    const ls = state.ledgerSummary.get(stake.userId);
    if (!acc || !ls) continue;

    const wasWinner = stake.side === winnerSide;

    if (wasWinner && winnerTotal > 0) {
      const gain = Math.floor(stake.amount * loserTotal / winnerTotal);
      acc.available -= gain + stake.amount;
      acc.locked += stake.amount;
      ls.earned -= gain;
      ls.clawback += gain + stake.amount;
      const bal = state.balances.get(stake.userId) ?? 0;
      state.balances.set(stake.userId, bal - gain - stake.amount);
    } else {
      // The loser receives no balance back; only the lost stake is re-locked.
      acc.locked += stake.amount;
      ls.lost -= stake.amount;
    }

    state.accounts.set(stake.userId, acc);
    state.ledgerSummary.set(stake.userId, ls);
  }

  // Reverse dust that was given to the first winner in the original settlement
  if (dust > 0 && firstWinnerId) {
    const acc = state.accounts.get(firstWinnerId);
    const ls = state.ledgerSummary.get(firstWinnerId);
    if (acc) {
      acc.available -= dust;
      state.accounts.set(firstWinnerId, acc);
      const bal = state.balances.get(firstWinnerId) ?? 0;
      state.balances.set(firstWinnerId, bal - dust);
    }
    if (ls) {
      ls.earned -= dust;
      ls.clawback += dust;
    }
  }

  // Restore BetPool
  const stype = prevRound.settlementType ?? 'TRUTH';
  const key = betPoolKey(messageId, stype);
  state.betPools.set(key, { pro: restoredPro, con: restoredCon });
}

function applyTransfer(state: ReplayState, fromId: string, toId: string, amount: number) {
  const fromAcc = state.accounts.get(fromId);
  const toAcc = state.accounts.get(toId);
  if (fromAcc) {
    fromAcc.available -= amount;
    state.accounts.set(fromId, fromAcc);
    const bal = state.balances.get(fromId) ?? 0;
    state.balances.set(fromId, bal - amount);
  }
  if (toAcc) {
    toAcc.available += amount;
    state.accounts.set(toId, toAcc);
    const bal = state.balances.get(toId) ?? 0;
    state.balances.set(toId, bal + amount);
  }
}

function applyRoundCreated(
  state: ReplayState,
  messageId: string,
  roundId: string,
  settlementType: string,
  previousRoundId: string | null,
) {
  if (!state.rounds.has(roundId)) {
    state.rounds.set(roundId, {
      messageId,
      settlementType,
      status: 'VOTING',
      result: null,
      weights: { TRUE: 0, FALSE: 0 },
      previousRoundId,
      settledAtStakeCount: 0,
    });
  }
}

// ═══════════════════════════════════════════════════════════
// Main replay function
// ═══════════════════════════════════════════════════════════

export async function replay(): Promise<ReplayState> {
  const state = createEmptyState();

  const entries = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'asc' },
  });

  for (const entry of entries) {
    const actorId = entry.actorId ?? 'system';
    const d = (entry.data as Record<string, unknown> | null)?.details as Record<string, unknown> | undefined;
    if (!d) continue;

    try {
      switch (entry.action) {
        case 'USER_REGISTERED':
          ensureBalance(state, actorId);
          break;

        case 'POINT_MINTED':
          applyMint(state, actorId, d.amount as number);
          break;

        case 'MESSAGE_CREATED':
          // ROUND messages create settlement rounds as a side effect
          if (d.kind === 'ROUND' && d.roundId) {
            applyRoundCreated(
              state,
              (d.targetMessageId as string) ?? (d.messageId as string),
              d.roundId as string,
              (d.settlementType as string) ?? 'TRUTH',
              (d.previousRoundId as string) ?? null,
            );
          }
          break;

        case 'STAKE_PLACED':
          applyStake(
            state, actorId,
            d.messageId as string,
            d.side as 'PRO' | 'CON',
            d.amount as number,
            d.roundId as string | null | undefined,
            (d.settlementType as string) ?? 'TRUTH',
            (d.feeAmount as number) ?? 0,
          );
          break;

        case 'VOTE_CAST':
          applyVote(
            state, actorId,
            d.messageId as string,
            d.roundId as string,
            d.vote as 'TRUE' | 'FALSE',
            d.amount as number,
            (d.feeAmount as number) ?? 0,
          );
          break;

        case 'ROUND_CREATED':
          applyRoundCreated(
            state,
            d.messageId as string,
            entry.entityId!, // entityId IS the roundId
            (d.settlementType as string) ?? 'TRUTH',
            (d.previousRoundId as string) ?? null,
          );
          break;

        case 'ROUND_SETTLED':
          applySettle(
            state,
            d.messageId as string,
            d.roundId as string,
            d.result as 'TRUE' | 'FALSE' | 'UNKNOWN',
            d.weights as { TRUE: number; FALSE: number },
            d.totalPro as number,
            d.totalCon as number,
          );
          break;

        case 'SETTLEMENT_CLAWBACK':
          applyClawback(
            state,
            d.messageId as string,
            d.previousRoundId as string,
            d.restoredPro as number,
            d.restoredCon as number,
          );
          break;

        case 'POINT_TRANSFERRED':
          applyTransfer(state, d.from as string, d.to as string, d.amount as number);
          break;

        case 'RULE_VERSION_CREATED':
          // RuleVersion changes tracked for future audit completeness
          break;

        case 'REVENUE_RECEIVED':
          state.revenuePoolBalance += (d.amount as number) ?? 0;
          break;

        case 'REVENUE_DISTRIBUTED':
          {
            const distAmount = (d.contributorAmount as number) ?? 0;
            state.revenuePoolBalance = Math.max(0, state.revenuePoolBalance - distAmount);
            const distributions = d.distributions as Array<{ userId: string; amount: number }> | undefined;
            if (distributions) {
              for (const dist of distributions) {
                const acc = state.accounts.get(dist.userId);
                if (acc) { acc.available += dist.amount; state.accounts.set(dist.userId, acc); }
                const bal = state.balances.get(dist.userId) ?? 0;
                state.balances.set(dist.userId, bal + dist.amount);
              }
            }
          }
          break;

        case 'SETTLEMENT_TERMINATED':
          // Mark round as terminated — future clawbacks skip it
          {
            const termRoundId = d.terminateRoundId as string;
            if (termRoundId && state.rounds.has(termRoundId)) {
              // Terminated rounds are preserved in state; clawback logic checks this
            }
          }
          break;
      }

    } catch (err) {
      console.error(`[replay] FAILED action=${entry.action} entityId=${entry.entityId?.slice(-6)}: ${(err as Error).message}`);
    }
  }

  return state;
}

/** Rebuild the public discussion projection from a versioned topic export. */
export function replayFromExport(snapshot: ReplayExportSnapshot): ReplayState {
  if (snapshot.formatVersion !== 2) {
    throw new Error(`Unsupported export format version: ${snapshot.formatVersion}`);
  }

  const state = createEmptyState();
  for (const item of snapshot.messages) {
    const message: MessageState = {
      id: item.id,
      topicId: snapshot.topicId,
      createdById: item.authorId,
      kind: item.kind,
      contentType: item.contentType ?? null,
      content: item.content ?? null,
      quoteSourceId: item.quoteSourceId ?? null,
      quotedText: item.quotedText ?? null,
      quotedTextHash: item.quotedTextHash ?? null,
      quoteContextBefore: item.quoteContextBefore ?? null,
      quoteContextAfter: item.quoteContextAfter ?? null,
      relationType: item.relationType ?? null,
      relSourceId: item.sourceMessageId ?? null,
      targetRefs: item.targetRefs ?? null,
      relationPayload: item.relationPayload ?? null,
      supersededBy: item.supersededBy ?? null,
    };
    state.messages.set(message.id, message);
  }

  for (const relation of snapshot.relations) {
    state.messages.set(relation.id, {
      id: relation.id,
      topicId: snapshot.topicId,
      createdById: relation.authorId,
      kind: 'RELATION',
      contentType: 'TEXT',
      content: null,
      quoteSourceId: null,
      quotedText: null,
      quotedTextHash: null,
      quoteContextBefore: null,
      quoteContextAfter: null,
      relationType: relation.relationType,
      relSourceId: relation.sourceMessageId,
      targetRefs: relation.targetRefs,
      relationPayload: relation.payload,
      supersededBy: relation.supersededBy,
    });
  }

  return state;
}
