import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { updateUsageRewardMessage } from '@gonglun/core';
import { DomainError, id, integer, Mutation, Store } from './db.js';
import { distribution } from './economy.js';
import { assertActiveAccount } from './account-access.js';

export const usagePointsSchema = `
CREATE TABLE IF NOT EXISTS usage_points (
  "userId" TEXT PRIMARY KEY, earned BIGINT NOT NULL DEFAULT 0 CHECK(earned >= 0),
  "roundId" TEXT NOT NULL, "readyAt" BIGINT, day TEXT NOT NULL,
  "totalEarned" BIGINT NOT NULL DEFAULT 0 CHECK("totalEarned" >= 0)
);
CREATE INDEX IF NOT EXISTS usage_points_pending_day ON usage_points(day) WHERE "readyAt" IS NOT NULL;
CREATE TABLE IF NOT EXISTS usage_reward_days (
  "userId" TEXT NOT NULL,day TEXT NOT NULL,"messageId" TEXT NOT NULL UNIQUE,"ledgerId" TEXT NOT NULL UNIQUE,
  total BIGINT NOT NULL CHECK(total>0),PRIMARY KEY("userId",day)
);
CREATE TABLE IF NOT EXISTS points_archives (
  id TEXT PRIMARY KEY, "createdAt" TEXT NOT NULL, "previousSequence" BIGINT NOT NULL,
  manifest JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS points_archive_rows (
  position BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "archiveId" TEXT NOT NULL REFERENCES points_archives(id), "tableName" TEXT NOT NULL, body JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS points_archive_source ON points_archive_rows("archiveId", "tableName", position);
CREATE INDEX IF NOT EXISTS points_archive_message ON points_archive_rows("archiveId", (body->>'id')) WHERE "tableName"='messages';
`;

export const activitySchema = z.object({
  action: z.enum(['start', 'tick', 'input']),
  roundId: z.string().max(100).optional(),
}).strict();
export type ActivityInput = z.infer<typeof activitySchema>;
export interface UsagePoints {
  earned: number; roundId: string; waitSeconds: number; remainingMs: number;
  totalEarned: number; refreshInMs: number; awarded: boolean;
}
type Progress = { userId: string; earned: number; roundId: string; readyAt: number | null; day: string; totalEarned: number };
const DAY_MS = 86_400_000;
export const usageDay = (at: number) => new Date(at + 8 * 3600_000).toISOString().slice(0, 10);
export const nextUsageRefresh = (at: number) => Date.parse(`${usageDay(at)}T00:00:00+08:00`) + DAY_MS;

async function award(store: Store, row: Progress, reason: 'usage-time' | 'usage-daily-refresh', at: number) {
  const tx = new Mutation(store), label = reason === 'usage-time' ? '使用公论计时贡献' : '每日刷新等待补发';
  const day = usageDay(at), timestamp = new Date(at).toISOString();
  let daily = await store.db.prepare('SELECT * FROM usage_reward_days WHERE "userId"=$1 AND day=$2').get<{messageId:string;ledgerId:string;total:number}>(row.userId, day);
  if (!daily) {
    const message = await distribution(tx, undefined, {
      source: 'grant', total: 1, ruleVersion: (await store.rules()).version,
      inputs: { reason: 'usage-daily-summary', day, terminology: 'contribution' },
      allocations: [{ userId: row.userId, amount: 1, reason: '使用贡献汇总', messageIds: [] }],
    });
    await tx.put(updateUsageRewardMessage(message, 1, message.sequence, timestamp));
    daily = { messageId: message.id, ledgerId: id(), total: 1 };
    await store.db.prepare('INSERT INTO usage_reward_days VALUES($1,$2,$3,$4,1)').run(row.userId, day, daily.messageId, daily.ledgerId);
  } else {
    daily.total = integer(daily.total + 1);
    await store.db.prepare('UPDATE usage_reward_days SET total=$3 WHERE "userId"=$1 AND day=$2').run(row.userId, day, daily.total);
    tx.usageRewardTotals = [{ messageId: daily.messageId, total: daily.total, updatedAt: timestamp }];
  }
  if (tx.usageRewardTotals) tx.affected.add(daily.messageId);
  await store.ledger(row.userId, daily.messageId, 1, 0, label, true, { aggregateId: daily.ledgerId, createdAt: timestamp, total: daily.total });
  await store.set('minted', integer(await store.setting<number>('minted') + 1));
  row.totalEarned = integer(row.totalEarned + 1);
  await tx.commit();
}
async function refresh(store: Store, row: Progress, at: number): Promise<boolean> {
  if (row.day >= usageDay(at)) return false;
  const awarded = row.readyAt !== null;
  if (awarded) await award(store, row, 'usage-daily-refresh', at);
  row.day = usageDay(at);
  row.earned = 0;
  row.roundId = randomUUID();
  row.readyAt = null;
  return awarded;
}
async function save(store: Store, row: Progress) {
  await store.db.prepare('UPDATE usage_points SET earned=$2,"roundId"=$3,"readyAt"=$4,day=$5,"totalEarned"=$6 WHERE "userId"=$1')
    .run(row.userId, row.earned, row.roundId, row.readyAt, row.day, row.totalEarned);
}

/** Only server time accrues. A single row serializes every tab/device of an account. */
export async function updateUsagePoints(store: Store, userId: string, input: ActivityInput, time?: number): Promise<UsagePoints> {
  return store.transaction(async () => {
    await assertActiveAccount(store,userId);
    const at = time ?? Date.now();
    await store.db.prepare(`INSERT INTO usage_points("userId",earned,"roundId","readyAt",day,"totalEarned")
      VALUES($1,0,$2,$3,$4,0) ON CONFLICT("userId") DO NOTHING`).run(userId, randomUUID(), at + 1000, usageDay(at));
    const row = await store.db.prepare('SELECT * FROM usage_points WHERE "userId"=$1 FOR UPDATE').get<Progress>(userId);
    if (!row) throw new DomainError('计时记录不存在');
    let awarded = await refresh(store, row, at);
    if ((input.action === 'tick' || input.action === 'input') && input.roundId === row.roundId && row.readyAt !== null && at >= row.readyAt) {
      await award(store, row, 'usage-time', at);
      row.earned = integer(row.earned + 1);
      row.roundId = randomUUID();
      row.readyAt = integer(at + (row.earned + 1) * 1000, '等待时间');
      awarded = true;
    }
    if (row.readyAt === null) {
      row.roundId = randomUUID();
      row.readyAt = integer(at + (row.earned + 1) * 1000, '等待时间');
    }
    await save(store, row);
    return { earned: row.earned, roundId: row.roundId, waitSeconds: row.earned + 1,
      remainingMs: Math.max(0, row.readyAt - at), totalEarned: row.totalEarned,
      refreshInMs: nextUsageRefresh(at) - at, awarded };
  });
}

/** Midnight pays only an existing waiting round. Offline days never create new waiting rounds. */
export async function refreshUsagePoints(store: Store, at = Date.now()): Promise<void> {
  const day = usageDay(at);
  if (!await store.db.prepare('SELECT 1 FROM usage_points WHERE day<$1 AND "readyAt" IS NOT NULL LIMIT 1').get(day)) return;
  await store.transaction(async () => {
    const rows = await store.db.prepare('SELECT * FROM usage_points WHERE day<$1 AND "readyAt" IS NOT NULL FOR UPDATE').all<Progress>(day);
    for (const row of rows) { await refresh(store, row, at); await save(store, row); }
  });
}
