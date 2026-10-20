import type { User } from '../types';
import type { buildLeaderboardMetrics } from './leaderboardMetrics';
import { isTextMessage } from './leaderboardMetrics';
export interface StakeCountItem { truth: { pro: number; con: number }; value: { pro: number; con: number } }

export interface UserRow {
  userId: string;
  username: string;
  rechargeIncome: number;
  messageCount: number;
  textMessageCount: number;
  relationMessageCount: number;
  totalIncome: number;
  receivedTruthStake: number;
  receivedStanceStake: number;
  receivedTruthPro: number;
  receivedTruthCon: number;
  netSupportRate: number;
  referenceHeat: number;
  settlementActivity: number;
}

export interface MessageRow {
  messageId: string;
  userId: string;
  username: string;
  preview: string;
  stakeTotal: number;
  truthStake: number;
  stanceStake: number;
  truthPro: number;
  truthCon: number;
  netSupportRate: number;
  referenceHeat: number;
  settlementActivity: number;
  sideGap: number;
  bettors: number;
  intensity: number;
}

function getStakeTotal(stake: StakeCountItem | undefined): number {
  if (!stake) return 0;
  return stake.truth.pro + stake.truth.con + stake.value.pro + stake.value.con;
}

export function buildLeaderboardRows(metrics: ReturnType<typeof buildLeaderboardMetrics>, users: User[], stakeCounts: Record<string, StakeCountItem>, messageBettorCounts: Record<string, number>) {
  const nameToId = new Map([...metrics.idToName].map(([id, name]) => [name, id]));
  const userRows = (() => {
    const byUser = new Map<string, UserRow>();
    for (const user of users) {
      byUser.set(user.username, {
        userId: user.id,
        username: user.username,
        rechargeIncome: 0,
        messageCount: 0,
        textMessageCount: 0,
        relationMessageCount: 0,
        totalIncome: 0,
        receivedTruthStake: 0,
        receivedStanceStake: 0,
        receivedTruthPro: 0,
        receivedTruthCon: 0,
        netSupportRate: 0,
        referenceHeat: 0,
        settlementActivity: 0,
      });
    }
    const ensure = (username: string): UserRow => {
      const prev = byUser.get(username);
      if (prev) return prev;
      const knownId = nameToId.get(username) ?? '';
      const next: UserRow = {
        userId: knownId,
        username,
        rechargeIncome: 0,
        messageCount: 0,
        textMessageCount: 0,
        relationMessageCount: 0,
        totalIncome: 0,
        receivedTruthStake: 0,
        receivedStanceStake: 0,
        receivedTruthPro: 0,
        receivedTruthCon: 0,
        netSupportRate: 0,
        referenceHeat: 0,
        settlementActivity: 0,
      };
      byUser.set(username, next);
      return next;
    };

    // Every unique record belongs to exactly one category, including JOIN and settlements.
    for (const message of metrics.rankedMessages) {
      const row = ensure(metrics.sendAuthors.get(message.id) ?? message.author);
      if (isTextMessage(message)) row.textMessageCount += 1;
      else row.relationMessageCount += 1;
      row.messageCount = row.textMessageCount + row.relationMessageCount;
    }

    for (const [username, amount] of metrics.rechargeIncome) {
      ensure(username).rechargeIncome += amount;
    }

    // This is received stake volume, not an account payout.
    for (const message of metrics.rankedMessages) {
      const totalStake = getStakeTotal(stakeCounts[message.id]);
      const truthPro = stakeCounts[message.id]?.truth.pro ?? 0;
      const truthCon = stakeCounts[message.id]?.truth.con ?? 0;
      const truthStake = truthPro + truthCon;
      const row = ensure(metrics.sendAuthors.get(message.id) ?? message.author);
      row.totalIncome += totalStake;
      row.receivedTruthStake += truthStake;
      row.receivedTruthPro += truthPro;
      row.receivedTruthCon += truthCon;
      row.receivedStanceStake += metrics.stanceStakes.get(message.id) ?? 0;
      row.referenceHeat += metrics.incomingReferences.get(message.id)?.size ?? 0;
      row.settlementActivity += metrics.settlements.get(message.id)?.size ?? 0;
    }

    for (const row of byUser.values()) {
      row.totalIncome += row.rechargeIncome;
      const denom = row.receivedTruthPro + row.receivedTruthCon;
      row.netSupportRate = denom > 0 ? Number((((row.receivedTruthPro - row.receivedTruthCon) / denom) * 100).toFixed(2)) : 0;
    }

    return Array.from(byUser.values());
  })();
  const messageRows = (() => {
    const rows: MessageRow[] = metrics.rankedMessages
      .map(message => {
        const stake = stakeCounts[message.id];
        const pro = (stake?.truth.pro ?? 0) + (stake?.value.pro ?? 0);
        const con = (stake?.truth.con ?? 0) + (stake?.value.con ?? 0);
        const truthPro = stake?.truth.pro ?? 0;
        const truthCon = stake?.truth.con ?? 0;
        const truthStake = truthPro + truthCon;
        const stakeTotal = pro + con;
        const sideGap = Math.abs(pro - con);
        const bettors = messageBettorCounts[message.id] ?? 0;
        const balanceFactor = stakeTotal > 0 ? (1 - sideGap / stakeTotal) : 0;
        const intensity = Number((stakeTotal * balanceFactor + bettors * 3).toFixed(2));
        const incomingRefs = metrics.incomingReferences.get(message.id)?.size ?? 0;
        const outgoingRefs = metrics.outgoingReferences.get(message.id)?.size ?? 0;
        const stanceStake = metrics.stanceStakes.get(message.id) ?? 0;
        const netSupportRate = truthStake > 0 ? Number((((truthPro - truthCon) / truthStake) * 100).toFixed(2)) : 0;
        const username = metrics.sendAuthors.get(message.id) ?? message.author;

        return {
          messageId: message.id,
          userId: (username === message.author ? message.authorId : undefined) ?? nameToId.get(username) ?? '',
          username,
          preview: (message.content || '').replace(/\s+/g, ' ').slice(0, 60) || '(无内容)',
          stakeTotal,
          truthStake,
          stanceStake,
          truthPro,
          truthCon,
          netSupportRate,
          referenceHeat: incomingRefs,
          settlementActivity: metrics.settlements.get(message.id)?.size ?? 0,
          sideGap,
          bettors,
          intensity: intensity + incomingRefs + outgoingRefs * 0.5,
        };
      });

    return rows;
  })();
  return { userRows, messageRows };
}
