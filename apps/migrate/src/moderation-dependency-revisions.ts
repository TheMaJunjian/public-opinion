import type { Message } from '@gonglun/core';
import type { Store } from '../../server/src/db.js';
import { indexModerationDependencies } from '../../server/src/moderation-visibility.js';

/** Rebuild this derived index from immutable revisions; never re-enroll or charge content. */
export async function migrateModerationDependencyRevisions(store: Store): Promise<void> {
  await store.db.exec(`
    TRUNCATE TABLE moderation_dependencies;
    ALTER TABLE moderation_dependencies DROP CONSTRAINT moderation_dependencies_pkey;
    ALTER TABLE moderation_dependencies ADD COLUMN IF NOT EXISTS "sourceRevision" INTEGER NOT NULL;
    ALTER TABLE moderation_dependencies ADD COLUMN IF NOT EXISTS "targetRevision" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE moderation_dependencies ADD PRIMARY KEY("sourceId","sourceRevision","targetId","targetRevision");
  `);
  let after = 0;
  for (;;) {
    const rows = await store.db.prepare('SELECT position,body FROM revisions WHERE position>$1 ORDER BY position LIMIT 200')
      .all<{position:number;body:string}>(after);
    if (!rows.length) return;
    for (const row of rows) await indexModerationDependencies(store, JSON.parse(row.body) as Message);
    after = rows.at(-1)!.position;
  }
}
