import type { Store } from '../../server/src/db.js';

export async function migrateUsageRewardStorage(store: Store) {
  await store.db.exec(`ALTER TABLE ledger ADD COLUMN IF NOT EXISTS "balanceAfter" BIGINT;
    CREATE TABLE IF NOT EXISTS usage_reward_days (
      "userId" TEXT NOT NULL,day TEXT NOT NULL,"messageId" TEXT NOT NULL UNIQUE,"ledgerId" TEXT NOT NULL UNIQUE,
      total BIGINT NOT NULL CHECK(total>0),PRIMARY KEY("userId",day)
    );`);
  const start = await store.setting<{ledgerPosition:number}>('usage-points-start');
  await store.db.prepare(`WITH balances AS (
    SELECT id,(SUM(amount) OVER(PARTITION BY "userId" ORDER BY position))::bigint AS amount
    FROM ledger WHERE position>$1
  ) UPDATE ledger l SET "balanceAfter"=b.amount FROM balances b WHERE l.id=b.id AND l."balanceAfter" IS NULL`).run(start.ledgerPosition);
}
