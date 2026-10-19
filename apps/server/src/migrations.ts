import type { Postgres } from './postgres.js';
import type { Store } from './db.js';
import { randomUUID } from 'node:crypto';
import { DEFAULT_RULES } from '@gonglun/core';
import { schemaSql } from './schema.js';
import { initializeProjections } from './projections.js';
import { initializePersonal } from './personal-actions.js';
import { initializeOrganizationMemberships } from './organizations.js';

export interface Migration { version: number; name: string; up(): Promise<void> }

export function migrationsFor(store: Store): Migration[] {
  return [{ version: 1, name: 'native-message-schema', up: async () => {
    await store.db.exec(schemaSql);
    for (const [key, value] of Object.entries({ rules: DEFAULT_RULES, operating: 0, region: randomUUID(), minted: 0 }))
      await store.db.prepare('INSERT INTO settings VALUES ($1,$2) ON CONFLICT(key) DO NOTHING').run(key, JSON.stringify(value));
    await store.db.prepare('INSERT INTO rule_versions VALUES ($1,$2,NULL,$3) ON CONFLICT(version) DO NOTHING')
      .run(DEFAULT_RULES.version, JSON.stringify(DEFAULT_RULES), new Date().toISOString());
    await initializeProjections(store);
    await initializePersonal(store);
    await initializeOrganizationMemberships(store);
  } }, { version: 2, name: 'committed-change-predecessors', up: () => linkExistingChanges(store.db) }];
}

/** Runs under the cross-process write lock. Failed upgrades roll back together. */
export async function runMigrations(db: Postgres, migrations: Migration[]): Promise<void> {
  await db.transaction(async () => {
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const applied = await db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all<{ version: number; name: string }>();
    if (migrations.some((migration, index) => migration.version !== index + 1)
      || applied.some((migration, index) => migration.version !== index + 1
        || migrations[index]?.name !== migration.name)) throw new Error('数据库迁移版本与当前程序不兼容');
    for (const migration of migrations.slice(applied.length)) {
      await migration.up();
      await db.prepare('INSERT INTO schema_migrations(version,name) VALUES ($1,$2)').run(migration.version, migration.name);
    }
  });
}

/** Add metadata to old journals without renumbering public cursors. */
export async function linkExistingChanges(db: Postgres): Promise<void> {
  await db.exec(`WITH ordered AS (
    SELECT sequence, LAG(sequence,1,0::bigint) OVER (ORDER BY sequence) AS previous FROM changes
  ) UPDATE changes c SET body=(c.body::jsonb || jsonb_build_object('previousSequence',o.previous))::text
    FROM ordered o WHERE c.sequence=o.sequence AND NOT (c.body::jsonb ? 'previousSequence')`);
}
