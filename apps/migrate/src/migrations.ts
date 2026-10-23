import type { Postgres } from '../../server/src/postgres.js';
import { Store } from '../../server/src/db.js';
import { randomUUID } from 'node:crypto';
import { DEFAULT_RULES } from '@gonglun/core';
import { schemaSql } from '../../server/src/schema.js';
import { initializeProjections } from '../../server/src/projections.js';
import { initializePersonal } from '../../server/src/personal-actions.js';
import { retireLegacyTopics } from './retire-legacy-topics.js';
import { migrateAnnotationReasons } from './migrate-annotation-reasons.js';
import { initializeMigrationArchive } from './migration-schema.js';
import { migrateQueryRecords } from './migrate-query-records.js';
import {querySchema} from '../../server/src/query-schema.js';
import {financialFingerprint} from './financial-fingerprint.js';

export interface Migration { version: number; name: string; up(): Promise<void> }

export async function openMigratingStore(databaseUrl:string, options:{schema?:string} = {}):Promise<Store> {
  const store = Store.maintenance(databaseUrl,options);
  try {
    await store.transaction(async () => {
      await store.db.exec(`CREATE SCHEMA IF NOT EXISTS "${store.db.schema}"`);
      const legacy = await store.db.prepare(`SELECT to_regclass('"User"') AS users,to_regclass('"Message"') AS messages`).get();
      if (legacy?.users || legacy?.messages) throw new Error('请使用旧版迁移命令将数据迁入新版数据库');
      const before=await financialFingerprint(store.db);
      await runMigrations(store.db,migrationsFor(store));
      if(before!==null&&before!==await financialFingerprint(store.db))throw new Error('迁移前后余额或账本不一致，已回滚');
    });
    return store;
  } catch (error) {await store.close();throw error;}
}

export function migrationsFor(store: Store): Migration[] {
  return [{ version: 1, name: 'native-message-schema', up: async () => {
    await store.db.exec(schemaSql);
    await initializeMigrationArchive(store);
    for (const [key, value] of Object.entries({ rules: DEFAULT_RULES, operating: 0, region: randomUUID(), minted: 0 }))
      await store.db.prepare('INSERT INTO settings VALUES ($1,$2) ON CONFLICT(key) DO NOTHING').run(key, JSON.stringify(value));
    await store.db.prepare('INSERT INTO rule_versions VALUES ($1,$2,NULL,$3) ON CONFLICT(version) DO NOTHING')
      .run(DEFAULT_RULES.version, JSON.stringify(DEFAULT_RULES), new Date().toISOString());
    await initializeProjections(store);
    await initializePersonal(store);
  } }, { version: 2, name: 'committed-change-predecessors', up: () => linkExistingChanges(store.db) },
  { version: 3, name: 'retire-converted-topic-containers', up: async () => { await retireLegacyTopics(store); } },
  { version: 4, name: 'explicit-personal-annotation-reasons', up: async () => {await store.db.exec(querySchema);await migrateAnnotationReasons(store);} },
  { version: 5, name: 'canonical-query-records', up: () => migrateQueryRecords(store) },
  { version: 6, name: 'explicit-access-policy', up: async()=>{
    await store.db.prepare('INSERT INTO settings VALUES($1,$2) ON CONFLICT(key) DO NOTHING').run('access-mode',JSON.stringify('read-write'));
    await store.db.prepare('INSERT INTO settings VALUES($1,$2) ON CONFLICT(key) DO NOTHING').run('retired-organizations','[]');
  }}];
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
