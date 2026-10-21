import { afterEach, expect, it } from 'vitest';
import { Mutation, Store } from './db.js';
import { migrationsFor, runMigrations } from './migrations.js';
import { cleanupTestDatabases, createTestStore, newTestSchema, testDatabaseUrl } from './test-database.js';
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
  expect(await second.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual(migrationsFor(second).map(({version})=>({version})));
  expect(await first.setting('region')).toBe(await store.setting('region'));
});

it('rolls back failed migrations and rejects an application older than the database', async () => {
  const store = await createTestStore(), migrations = migrationsFor(store);
  await expect(runMigrations(store.db, [...migrations, {version:migrations.length+1,name:'fails',up:async()=>{
    await store.db.exec('CREATE TABLE failed_upgrade(id INTEGER)');
    throw new Error('migration failed');
  }}])).rejects.toThrow('migration failed');
  expect((await store.db.prepare("SELECT to_regclass('failed_upgrade') AS table_name").get())!.table_name).toBeNull();
  expect((await store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())!.version).toBe(migrations.length);
  await expect(runMigrations(store.db, migrations.slice(0,1))).rejects.toThrow('不兼容');
});

it('upgrades an existing converted Topic once across concurrent startups and preserves its message history', async () => {
  const schema = newTestSchema(), store = await createTestStore(schema);
  await store.transaction(async () => {
    const tx = new Mutation(store);
    await tx.create('system', [{id:'relation',type:'relation',relation:'classify',roles:{}},
      {id:'data',type:'data',value:{legacyTopicId:'old-topic',uiType:'CLASSIFY'}}], undefined, 'old-topic');
    await tx.create('system', [{id:'body',type:'text',text:'保留正文'}], undefined, 'member');
    await store.db.prepare('INSERT INTO memberships("memberId","parentId","sourceId") VALUES ($1,$2,$3)').run('member','old-topic','member');
    tx.memberships.set('member',{memberId:'member',parentId:'old-topic',sourceId:'member'});
    await tx.commit();
    await store.db.exec('DELETE FROM schema_migrations WHERE version=3');
  });
  const before = await store.db.prepare('SELECT * FROM messages ORDER BY id').all();
  const sequence = await store.latestSequence();
  const inspection = await Store.inspect(testDatabaseUrl(), {schema}, async existing => ({
    sequence: await existing.latestSequence(), version: (await existing.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())!.version,
  }));
  expect(inspection).toEqual({sequence, version:2});
  await expect(Store.inspect(testDatabaseUrl(), {schema}, existing => existing.set('forbidden',true))).rejects.toThrow('read-only');
  const [first,second] = await Promise.all([createTestStore(schema),createTestStore(schema)]);
  expect(await first.latestSequence()).toBe(sequence+1);
  expect(await second.db.prepare('SELECT * FROM memberships').all()).toEqual([]);
  expect(await first.db.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(before);
  expect(await second.setting('retired-legacy-topics')).toEqual(['old-topic']);
  expect(await second.db.prepare('SELECT name FROM schema_migrations WHERE version=3').get()).toEqual({name:'retire-converted-topic-containers'});
});
