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
import {completeMessageFormats} from './complete-message-formats.js';
import {restoreArchivedSettlementTargets} from './restore-settlement-targets.js';
import {repairValueVoteMessages} from './repair-value-vote-messages.js';
import {repairAnnotationStanceMessages} from './repair-annotation-stance-messages.js';
import {conversionFailure} from '@gonglun/core';
import {RollbackUnconfirmedError} from '../../server/src/postgres.js';
import {backfillMinimumContributions,refundGeneratedContributions,enableMinimumContributionAccess} from './backfill-minimum-contributions.js';
import { removeDependentMemberships } from './remove-dependent-memberships.js';
import {removeReadingMessages} from './remove-reading-messages.js';
import {migrateTargetInvestments} from './target-investments.js';
import {normalizeTargetValueFields} from './target-value-fields.js';
import {repairRetainedTargetInvestments} from './retained-target-investments.js';
import {repairLegacyAnnotationInvestments} from './legacy-annotation-investments.js';
import {readingStateSchema} from '../../server/src/reading-state.js';
import {cleanupContainerReadingMarks} from './cleanup-container-reading-marks.js';
import {migrateVersionContexts} from './version-contexts.js';
import {migrateSimplifiedCorrections} from './simplified-corrections.js';

export interface Migration { version: number; name: string; changesFinances?: boolean; up(): Promise<void> }

export async function openMigratingStore(databaseUrl:string, options:{schema?:string} = {}):Promise<Store> {
  const store = Store.maintenance(databaseUrl,options);
  let started = false;
  try {
    await store.transaction(async () => {
      started = true;
      await store.db.exec(`CREATE SCHEMA IF NOT EXISTS "${store.db.schema}"`);
      const legacy = await store.db.prepare(`SELECT to_regclass('"User"') AS users,to_regclass('"Message"') AS messages`).get();
      if (legacy?.users || legacy?.messages) throw new Error('请使用旧版迁移命令将数据迁入新版数据库');
      await runMigrations(store.db,migrationsFor(store));
    });
    return store;
  } catch (error) {
    const uncertain = error instanceof RollbackUnconfirmedError;
    const failure = conversionFailure(error, uncertain ? 'unconfirmed' : started ? 'completed' : 'unchanged',
      uncertain ? '已尝试回滚，但数据库未确认结果；服务已停止业务访问，请检查数据库。'
        : started ? '本次数据库转换已回滚，原有数据及迁移版本保持不变。' : '尚未执行转换，原数据库未修改。');
    await store.close();
    throw failure;
  }
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
  }},{version:7,name:'complete-historical-message-formats',up:()=>completeMessageFormats(store)},
  {version:8,name:'restore-historical-settlement-targets',up:()=>restoreArchivedSettlementTargets(store).then(()=>{})},
  {version:9,name:'correct-historical-value-vote-messages',up:()=>repairValueVoteMessages(store).then(()=>{})},
  {version:10,name:'normalize-historical-annotation-stances',up:()=>repairAnnotationStanceMessages(store).then(()=>{})},
  {version:11,name:'require-message-contributions',changesFinances:true,up:()=>backfillMinimumContributions(store).then(()=>{})},
  {version:12,name:'exclude-generated-message-contributions',changesFinances:true,up:()=>refundGeneratedContributions(store).then(()=>{})},
  // Superseded by v15: later stakes do not satisfy the send-time contribution requirement.
  {version:13,name:'preserve-previous-message-contributions',up:async()=>{}},
  {version:14,name:'enable-backfilled-truth-settlements',up:()=>enableMinimumContributionAccess(store)},
  {version:15,name:'enforce-send-time-message-contributions',changesFinances:true,up:()=>backfillMinimumContributions(store).then(()=>{})},
  {version:16,name:'remove-dependent-memberships-and-refund',changesFinances:true,up:()=>removeDependentMemberships(store).then(()=>{})},
  {version:17,name:'restore-historical-delegation-bodies',up:()=>completeMessageFormats(store)},
  {version:18,name:'route-relationship-investments-to-targets',changesFinances:true,up:()=>migrateTargetInvestments(store).then(()=>{})},
  {version:19,name:'normalize-target-value-claim-investments',up:()=>normalizeTargetValueFields(store).then(()=>{})},
  {version:20,name:'repair-retained-minimum-target-investments',changesFinances:true,up:()=>repairRetainedTargetInvestments(store).then(()=>{})},
  {version:21,name:'recover-original-annotation-agreement-investments',changesFinances:true,up:()=>repairLegacyAnnotationInvestments(store).then(()=>{})},
  {version:22,name:'private-reading-state',up:()=>store.db.exec(readingStateSchema)},
  {version:23,name:'remove-public-reading-messages-and-refund',changesFinances:true,up:()=>removeReadingMessages(store).then(()=>{})},
  {version:24,name:'cleanup-redundant-container-reading-marks',up:()=>cleanupContainerReadingMarks(store).then(()=>{})},
  {version:25,name:'explicit-body-versions-and-influence-contexts',up:()=>migrateVersionContexts(store)},
  {version:26,name:'shared-message-reading-and-text-corrections',changesFinances:true,up:()=>migrateSimplifiedCorrections(store)}];
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
    if(migrations.length>applied.length)await db.exec(`DO $$ BEGIN IF to_regclass('display_stances') IS NOT NULL THEN ALTER TABLE display_stances ADD COLUMN IF NOT EXISTS context JSONB; END IF; END $$`);
    for (const migration of migrations.slice(applied.length)) {
      const before=migration.changesFinances?null:await financialFingerprint(db);
      await migration.up();
      if(before!==null&&before!==await financialFingerprint(db))throw new Error('迁移前后余额或账本不一致');
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
