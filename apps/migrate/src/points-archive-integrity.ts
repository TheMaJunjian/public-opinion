import { createHash } from 'node:crypto';
import type { Store } from '../../server/src/db.js';

export type ArchiveManifest = Record<string, { count: number; sha256: string }>;
export async function archivedTableFingerprint(store: Store, archiveId: string, table: string) {
  const hash = createHash('sha256');
  let position = 0, count = 0;
  for (;;) {
    const rows = await store.db.prepare(`SELECT position,body FROM points_archive_rows
      WHERE "archiveId"=$1 AND "tableName"=$2 AND position>$3 ORDER BY position LIMIT 500`).all(archiveId, table, position);
    if (!rows.length) break;
    for (const row of rows) { hash.update(JSON.stringify(row.body) + '\n'); position = Number(row.position); count++; }
  }
  return { count, sha256: hash.digest('hex') };
}
