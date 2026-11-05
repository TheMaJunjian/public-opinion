import type { Store } from '../../server/src/db.js';
import { usageDay } from '../../server/src/usage-points.js';
import { archivedTableFingerprint, type ArchiveManifest } from './points-archive-integrity.js';

/** Upgrade the first timer release without clearing balances or losing its pending round. */
export async function migrateDailyUsagePoints(store: Store): Promise<void> {
  const columns = new Set((await store.db.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='usage_points'").all()).map(row => String(row.column_name)));
  if (columns.has('elapsedMs')) {
    await store.db.exec(`CREATE TABLE IF NOT EXISTS usage_points_v27_archive("userId" TEXT PRIMARY KEY,body JSONB NOT NULL);
      INSERT INTO usage_points_v27_archive SELECT "userId",to_jsonb(source) FROM usage_points source ON CONFLICT DO NOTHING;
      ALTER TABLE usage_points ADD COLUMN IF NOT EXISTS "readyAt" BIGINT;
      ALTER TABLE usage_points ADD COLUMN IF NOT EXISTS day TEXT;
      ALTER TABLE usage_points ADD COLUMN IF NOT EXISTS "totalEarned" BIGINT NOT NULL DEFAULT 0;`);
    const at = Date.now();
    for (const row of await store.db.prepare('SELECT * FROM usage_points FOR UPDATE').all()) {
      const duration = (Number(row.earned) + 1) * 1000;
      const elapsed = Number(row.elapsedMs) + Math.max(0, Math.min(at, Number(row.activeUntil)) - Number(row.lastSeenAt));
      await store.db.prepare('UPDATE usage_points SET "readyAt"=$2,day=$3,"totalEarned"=earned WHERE "userId"=$1')
        .run(row.userId, at + Math.max(0, duration - elapsed), usageDay(Number(row.lastSeenAt)));
    }
    await store.db.exec(`ALTER TABLE usage_points ALTER COLUMN day SET NOT NULL;
      ALTER TABLE usage_points DROP COLUMN "elapsedMs",DROP COLUMN "lastSeenAt",DROP COLUMN "activeUntil",DROP COLUMN owner;`);
  }
  await store.db.exec('CREATE INDEX IF NOT EXISTS usage_points_pending_day ON usage_points(day) WHERE "readyAt" IS NOT NULL');
  await store.db.exec(`CREATE INDEX IF NOT EXISTS points_archive_message ON points_archive_rows("archiveId",(body->>'id')) WHERE "tableName"='messages'`);
  // Early v27 archives stored counts only. Validate those counts before adding durable digests.
  for (const archive of await store.db.prepare('SELECT id,manifest FROM points_archives').all()) {
    const manifest = archive.manifest as ArchiveManifest | Record<string,number>;
    if (!Object.values(manifest).some(value => typeof value === 'number')) continue;
    const next: ArchiveManifest = {};
    for (const [table, expected] of Object.entries(manifest)) {
      const actual = await archivedTableFingerprint(store, String(archive.id), table);
      if (actual.count !== (typeof expected === 'number' ? expected : expected.count)
        || typeof expected !== 'number' && actual.sha256 !== expected.sha256) throw new Error(`旧贡献点存档校验失败：${table}`);
      next[table] = actual;
    }
    await store.db.prepare('UPDATE points_archives SET manifest=$2::jsonb WHERE id=$1').run(archive.id, JSON.stringify(next));
  }
}
