/**
 * verify.ts — Compare replay state with actual database state.
 *
 * Verifies aggregate consistency:
 *   1. Per-message stake totals (AuditLog STAKE_PLACED === Stake table)
 *   2. BetPool per message+settlementType
 *   3. SettlementRound results
 *   4. AuditLog mint total and current balance total
 */

import { prisma } from '../lib/prisma';
import type { ReplayState } from './types';

interface DiffItem {
  type: string;
  id: string;
  field: string;
  replayValue: number | string;
  dbValue: number | string;
}

interface VerifyReport {
  passed: boolean;
  diffs: DiffItem[];
  summary: Record<string, { matched: number; mismatched: number }>;
  aggregate: {
    totalMintedReplay: number;
    totalBalanceReplay: number;
    totalBalanceDb: number;
    totalLockedReplay: number;
    totalLockedDb: number;
    pendingStakeReplay: number;
    pendingStakeDb: number;
    pendingVoteReplay: number;
    pendingVoteDb: number;
    otherLockedReplay: number;
    otherLockedDb: number;
    revenuePoolBalance: number;
    revenuePoolDb: number;
    totalLostDb: number;
    totalEarnedDb: number;
    supplyCheckDifference: number;
    supplyConservation: boolean;
    conservation: boolean;
  };
}

export async function verify(state: ReplayState): Promise<VerifyReport> {
  const diffs: DiffItem[] = [];
  const summary: Record<string, { matched: number; mismatched: number }> = {};

  // ═══ 1. Stake totals per message ═══
  summary['Stake'] = { matched: 0, mismatched: 0 };
  const dbStakes = await prisma.stake.groupBy({
    by: ['messageId', 'side'],
    _sum: { amount: true },
  });
  const dbStakeMap = new Map<string, { pro: number; con: number }>();
  for (const s of dbStakes) {
    const e = dbStakeMap.get(s.messageId) ?? { pro: 0, con: 0 };
    if (s.side === 'PRO') e.pro = s._sum.amount ?? 0;
    else e.con = s._sum.amount ?? 0;
    dbStakeMap.set(s.messageId, e);
  }
  const allMsgIds = new Set([...state.stakeTotals.keys(), ...dbStakeMap.keys()]);
  for (const msgId of allMsgIds) {
    const r = state.stakeTotals.get(msgId) ?? { pro: 0, con: 0 };
    const d = dbStakeMap.get(msgId) ?? { pro: 0, con: 0 };
    if (r.pro === d.pro && r.con === d.con) {
      summary['Stake'].matched++;
    } else {
      summary['Stake'].mismatched++;
      if (r.pro !== d.pro) diffs.push({ type: 'Stake', id: msgId, field: 'PRO', replayValue: r.pro, dbValue: d.pro });
      if (r.con !== d.con) diffs.push({ type: 'Stake', id: msgId, field: 'CON', replayValue: r.con, dbValue: d.con });
    }
  }

  // ═══ 2. BetPool ═══
  summary['BetPool'] = { matched: 0, mismatched: 0 };
  const dbPools = await prisma.betPool.findMany();
  for (const db of dbPools) {
    const key = `${db.messageId}:${db.settlementType}`;
    const r = state.betPools.get(key);
    if (r && r.pro === db.lockedPro && r.con === db.lockedCon) {
      summary['BetPool'].matched++;
    } else if (db.lockedPro === 0 && db.lockedCon === 0 && (!r || (r.pro === 0 && r.con === 0))) {
      // Empty BetPool — skip (can be stale entries from settled rounds)
      summary['BetPool'].matched++;
    } else {
      summary['BetPool'].mismatched++;
      diffs.push({ type: 'BetPool', id: key, field: 'pro', replayValue: r?.pro ?? 0, dbValue: db.lockedPro });
      diffs.push({ type: 'BetPool', id: key, field: 'con', replayValue: r?.con ?? 0, dbValue: db.lockedCon });
    }
  }

  // ═══ 3. SettlementRound ═══
  summary['SettlementRound'] = { matched: 0, mismatched: 0 };
  const dbRounds = await prisma.settlementRound.findMany({ where: { status: 'SETTLED' } });
  for (const db of dbRounds) {
    const r = state.rounds.get(db.id);
    if (r && r.result === db.result) {
      summary['SettlementRound'].matched++;
    } else {
      summary['SettlementRound'].mismatched++;
      diffs.push({ type: 'SettlementRound', id: db.id, field: 'result', replayValue: r?.result ?? '(none)', dbValue: db.result ?? '(none)' });
    }
  }

  // ═══ 4. Total conservation ═══
  const mintEntries = await prisma.auditLog.findMany({
    where: { action: 'POINT_MINTED' },
    select: { data: true },
  });
  const totalMintedReplay = mintEntries.reduce((sum, entry) => {
    const details = (entry.data as { details?: { amount?: unknown } } | null)?.details;
    return sum + (typeof details?.amount === 'number' ? details.amount : 0);
  }, 0);
  // RevenuePool replaces burned fees — fees are collected, not destroyed
  const pool = await prisma.revenuePool.findFirst({ select: { balance: true } });
  const revenuePoolDb = pool?.balance ?? 0;
  const dbBalances = await prisma.balance.findMany();
  const totalBalanceDb = dbBalances.reduce((s, b) => s + b.balance, 0);
  const totalLostDb = dbBalances.reduce((s, b) => s + b.totalLost, 0);
  const totalEarnedDb = dbBalances.reduce((s, b) => s + b.totalEarned, 0);
  const dbAccounts = await prisma.pointAccount.findMany({ select: { locked: true } });
  const totalLockedDb = dbAccounts.reduce((s, account) => s + account.locked, 0);
  const totalBalanceReplay = [...state.balances.values()].reduce((s, v) => s + v, 0);
  const totalLockedReplay = [...state.accounts.values()].reduce((s, account) => s + account.locked, 0);
  const dbRoundsForLocks = await prisma.settlementRound.findMany({
    select: { id: true, status: true },
  });
  const dbRoundStatus = new Map(dbRoundsForLocks.map(round => [round.id, round.status]));
  const isPendingRound = (roundId: string | null) => {
    if (!roundId) return true;
    const status = dbRoundStatus.get(roundId);
    return status === 'OPEN' || status === 'VOTING';
  };
  const dbStakesForLocks = await prisma.stake.findMany({ select: { amount: true, roundId: true } });
  const dbVotesForLocks = await prisma.voteStake.findMany({ select: { amount: true, roundId: true } });
  const pendingStakeDb = dbStakesForLocks
    .filter(stake => isPendingRound(stake.roundId))
    .reduce((sum, stake) => sum + stake.amount, 0);
  const pendingVoteDb = dbVotesForLocks
    .filter(vote => isPendingRound(vote.roundId))
    .reduce((sum, vote) => sum + vote.amount, 0);
  const pendingStakeReplay = state.stakes
    .filter(stake => !stake.roundId || state.rounds.get(stake.roundId)?.status !== 'SETTLED')
    .reduce((sum, stake) => sum + stake.amount, 0);
  const pendingVoteReplay = [...state.votes.entries()]
    .filter(([roundId]) => state.rounds.get(roundId)?.status !== 'SETTLED')
    .reduce((sum, [, votes]) => sum + votes.reduce((voteSum, vote) => voteSum + vote.amount, 0), 0);
  const otherLockedDb = totalLockedDb - pendingStakeDb - pendingVoteDb;
  const otherLockedReplay = totalLockedReplay - pendingStakeReplay - pendingVoteReplay;
  // Protocol fees go to RevenuePool, not burned.
  // totalMinted = totalBalance + totalLocked + revenuePool.balance
  const supplyCheckDifference = totalMintedReplay - totalBalanceDb - totalLockedDb - revenuePoolDb;
  const supplyConservation = supplyCheckDifference === 0;
  const conservation = totalBalanceReplay === totalBalanceDb;
  const aggregate = {
    totalMintedReplay,
    totalBalanceReplay,
    totalBalanceDb,
    totalLockedReplay,
    totalLockedDb,
    pendingStakeReplay,
    pendingStakeDb,
    pendingVoteReplay,
    pendingVoteDb,
    otherLockedReplay,
    otherLockedDb,
    revenuePoolBalance: state.revenuePoolBalance,
    revenuePoolDb,
    totalLostDb,
    totalEarnedDb,
    supplyCheckDifference,
    supplyConservation,
    conservation,
  };
  if (!conservation) {
    diffs.push({ type: 'Aggregate', id: 'total', field: 'balance-replay-db', replayValue: totalBalanceReplay, dbValue: totalBalanceDb });
  }
  if (!supplyConservation) {
    diffs.push({
      type: 'Aggregate',
      id: 'total',
      field: 'supply-formula',
      replayValue: totalMintedReplay,
      dbValue: totalBalanceDb + totalLockedDb + revenuePoolDb,
    });
  }

  const passed = diffs.length === 0;
  return { passed, diffs, summary, aggregate };
}

export function formatReport(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push('═══════════════════════════════════════');
  lines.push('  Replay / Verify 差异报告');
  lines.push('═══════════════════════════════════════');
  lines.push('');

  for (const [type, stats] of Object.entries(report.summary)) {
    lines.push(`  ${stats.mismatched === 0 ? '✅' : '❌'} ${type}: ${stats.matched} 一致, ${stats.mismatched} 不一致`);
  }

  lines.push('');
  lines.push('  ── 总量守恒 ──');
  lines.push(`  总铸造 (AuditLog): ${report.aggregate.totalMintedReplay.toLocaleString()}`);
  lines.push(`  当前余额 (replay): ${report.aggregate.totalBalanceReplay.toLocaleString()}`);
  lines.push(`  当前余额 (db):     ${report.aggregate.totalBalanceDb.toLocaleString()}`);
  lines.push(`  当前锁定 (replay):  ${report.aggregate.totalLockedReplay.toLocaleString()}`);
  lines.push(`  当前锁定 (db):      ${report.aggregate.totalLockedDb.toLocaleString()}`);
  lines.push(`  未结算押注锁定:     replay=${report.aggregate.pendingStakeReplay.toLocaleString()} db=${report.aggregate.pendingStakeDb.toLocaleString()}`);
  lines.push(`  未结算投票锁定:     replay=${report.aggregate.pendingVoteReplay.toLocaleString()} db=${report.aggregate.pendingVoteDb.toLocaleString()}`);
  lines.push(`  其他锁定余额:       replay=${report.aggregate.otherLockedReplay.toLocaleString()} db=${report.aggregate.otherLockedDb.toLocaleString()}`);
  lines.push(`  收入池余额 (replay): ${report.aggregate.revenuePoolBalance.toLocaleString()}`);
  lines.push(`  收入池余额 (db):     ${report.aggregate.revenuePoolDb.toLocaleString()}`);
  lines.push(`  用户结算损失记录:  ${report.aggregate.totalLostDb.toLocaleString()}`);
  lines.push(`  用户结算收益记录:  ${report.aggregate.totalEarnedDb.toLocaleString()}`);
  lines.push(`  总量公式: ${report.aggregate.totalMintedReplay.toLocaleString()} = ${report.aggregate.totalBalanceDb.toLocaleString()} + ${report.aggregate.totalLockedDb.toLocaleString()} + ${report.aggregate.revenuePoolDb.toLocaleString()}`);
  lines.push(`  总量公式校验:      ${report.aggregate.supplyConservation ? '✅' : '❌'}`);
  lines.push(`  守恒: ${report.aggregate.conservation ? '✅' : '❌'}`);

  if (!report.passed) {
    lines.push('');
    lines.push(`─── 差异 (${report.diffs.length} 处) ───`);
    for (const d of report.diffs) {
      lines.push(`  [${d.type}] ${d.id.slice(-12)} ${d.field}: replay=${d.replayValue} db=${d.dbValue}`);
    }
  }

  lines.push('');
  lines.push(report.passed ? '✅ 一致 — 状态可复算。' : '❌ 存在差异。');
  return lines.join('\n');
}
