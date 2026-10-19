import { afterEach, expect, it } from 'vitest';
import { Mutation } from './db.js';
import { migrationsFor, runMigrations } from './migrations.js';
import { cleanupTestDatabases, createTestStore, newTestSchema } from './test-database.js';
import { replayArchive } from '@gonglun/core';

afterEach(cleanupTestDatabases);

it('upgrades an unversioned journal with rollback gaps once, preserving public cursors and history', async () => {
  const schema = newTestSchema(), store = await createTestStore(schema);
  await store.transaction(async () => { const tx = new Mutation(store); await tx.create('system', [{id:'body',type:'text',text:'旧记录'}]); await tx.commit(); });
  await expect(store.transaction(async () => { await new Mutation(store).commit(); throw new Error('rollback'); })).rejects.toThrow('rollback');
  await store.transaction(() => new Mutation(store).commit());
  const original = await store.db.prepare('SELECT sequence,body FROM changes ORDER BY sequence').all();
  // Recreate the pre-versioned database boundary, only inside this isolated test schema.
  await store.transaction(async () => {
    await store.db.exec("UPDATE changes SET body=(body::jsonb - 'previousSequence')::text");
    await store.db.exec('DROP TABLE schema_migrations');
  });
  const [first, second] = await Promise.all([createTestStore(schema), createTestStore(schema)]);
  const upgraded = await first.db.prepare('SELECT sequence,body FROM changes ORDER BY sequence').all();
  const decoded = (rows: typeof original) => rows.map(row => ({ sequence: row.sequence, body: JSON.parse(row.body) }));
  expect(decoded(upgraded)).toEqual(decoded(original));
  expect(replayArchive({format:'gonglun-2',changes:upgraded.map(row=>JSON.parse(row.body))}).changeCount).toBe(2);
  expect(await second.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{version:1},{version:2}]);
  expect(await first.setting('region')).toBe(await store.setting('region'));
});

it('rolls back failed migrations and rejects an application older than the database', async () => {
  const store = await createTestStore(), migrations = migrationsFor(store);
  await expect(runMigrations(store.db, [...migrations, {version:3,name:'fails',up:async()=>{
    await store.db.exec('CREATE TABLE failed_upgrade(id INTEGER)');
    throw new Error('migration failed');
  }}])).rejects.toThrow('migration failed');
  expect((await store.db.prepare("SELECT to_regclass('failed_upgrade') AS table_name").get())!.table_name).toBeNull();
  expect((await store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())!.version).toBe(2);
  await expect(runMigrations(store.db, migrations.slice(0,1))).rejects.toThrow('不兼容');
});
