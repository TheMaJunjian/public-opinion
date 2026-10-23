import {afterEach,expect,it,vi} from 'vitest';
import {replayArchive,relations,type Message} from '@gonglun/core';
import {Mutation} from '../../server/src/db.js';
import {cleanupTestDatabases,createTestStore,testDatabaseUrl} from '../../server/src/test-database.js';
import {viewsFor} from '../../server/src/ui-projections.js';
import {financialFingerprint} from './financial-fingerprint.js';
import {migrationsFor,runMigrations} from './migrations.js';
import {restoreArchivedSettlementTargets,settlementTargetRepairPlan} from './restore-settlement-targets.js';
import {createMessageFormatTransform} from './message-format.js';
import {migrateViewFile} from './migrate-view-file.js';

afterEach(async()=>{vi.unstubAllEnvs();await cleanupTestDatabases();});

async function fixture(){
  const store=await createTestStore();
  await store.transaction(async()=>{
    const tx=new Mutation(store);
    await tx.create('system',[{id:'body',type:'text',text:'目标原文'}],undefined,'target');
    for(const [id,kind] of [['old-round','ROUND'],['old-result','ROUND_RESULT']] as const){
      await tx.create('system',[{id:'body',type:'text',text:'原结算说明'},
        {id:'data',type:'data',value:{kind,settlementType:'TRUTH'}}],undefined,id);
    }
    await tx.commit();
    await store.db.exec('CREATE TABLE legacy_records("tableName" TEXT,position INTEGER,digest TEXT,body JSONB)');
    let position=0;
    for(const [id,kind] of [['old-round','ROUND'],['old-result','ROUND_RESULT']] as const)
      await store.db.prepare('INSERT INTO legacy_records VALUES($1,$2,$3,$4::jsonb)').run('Message',position++,'original',JSON.stringify({id,kind,relationType:null,targetRefs:[{messageId:'target'}]}));
    await store.db.exec('DELETE FROM schema_migrations WHERE version>=8');
  });
  return store;
}

it('restores version-7 settlement targets from the archive once, including revisions, replay, indexes and API projection',async()=>{
  const store=await fixture(),before=await financialFingerprint(store.db),cursor=await store.latestSequence();
  const untouched=await store.db.prepare('SELECT * FROM rounds').all();
  const originals=await store.db.prepare('SELECT * FROM legacy_records ORDER BY position').all();
  expect(await store.read(()=>settlementTargetRepairPlan(store.db))).toMatchObject({archivedRecords:2,pending:2,rounds:1,results:1});
  expect(await store.latestSequence()).toBe(cursor);
  await runMigrations(store.db,migrationsFor(store));
  expect(await financialFingerprint(store.db)).toBe(before);
  expect(await store.db.prepare('SELECT * FROM rounds').all()).toEqual(untouched);
  expect(await store.db.prepare('SELECT * FROM legacy_records ORDER BY position').all()).toEqual(originals);
  expect(await store.latestSequence()).toBe(cursor+1);
  for(const [id,relation] of [['old-round','settlement'],['old-result','distribution']]){
    const message=await store.message(id),original=await store.message(id,1);
    expect(message.revision).toBe(1);
    expect(relations(message).find(part=>part.relation===relation)?.roles.target).toEqual([{id:'target-0',reference:{messageId:'target'}}]);
    expect(original.parts).toEqual(message.parts);
    expect(await store.db.prepare('SELECT "targetId" FROM refs WHERE "sourceId"=$1').all(id)).toEqual([{targetId:'target'}]);
  }
  const view=await viewsFor(store,[await store.message('old-result')]);
  expect(view[0].targetRefs).toMatchObject([{reference:{messageId:'target'}}]);
  const changes=(await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)));
  const replay=replayArchive({format:'gonglun-2',changes});
  expect(replay.messages.find(message=>message.id==='old-result')?.parts).toEqual((await store.message('old-result')).parts);
  expect(await store.read(()=>settlementTargetRepairPlan(store.db))).toMatchObject({pending:0});
  await runMigrations(store.db,migrationsFor(store));
  expect(await store.transaction(()=>restoreArchivedSettlementTargets(store))).toBe(0);
  expect(await store.latestSequence()).toBe(cursor+1);
});

it('rolls back a missing archived target without stamping version 8 or changing records',async()=>{
  const store=await fixture();
  await store.db.prepare(`UPDATE legacy_records SET body=jsonb_set(body,'{targetRefs}','[{"messageId":"absent"}]') WHERE body->>'id'='old-result'`).run();
  const before=await store.db.prepare('SELECT * FROM messages ORDER BY id').all(),cursor=await store.latestSequence();
  await expect(runMigrations(store.db,migrationsFor(store))).rejects.toThrow('absent');
  expect(await store.db.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(before);
  expect(await store.latestSequence()).toBe(cursor);
  expect(await store.db.prepare('SELECT version FROM schema_migrations WHERE version=8').get()).toBeUndefined();
});

it('converts retained legacy settlement addresses before removing compatibility metadata and preserves existing targets',async()=>{
  const store=await fixture(),target=await store.message('target');
  const old:Message={...await store.message('old-result'),parts:[{id:'body',type:'text',text:'原结算说明'},
    {id:'data',type:'data',value:{kind:'ROUND_RESULT',legacyTargetRefs:[{messageId:'target'}]}}]};
  const latest=new Map([[old.id,old],[target.id,target]]),originals=new Map([[`${target.id}:1`,target]]);
  const transform=createMessageFormatTransform(latest,originals),converted=transform(old);
  expect(relations(converted).find(part=>part.relation==='distribution')?.roles.target[0].reference).toEqual({messageId:'target'});
  expect(JSON.stringify(converted)).not.toContain('legacyTargetRefs');
  expect(transform(converted)).toEqual(converted);
  const existing={...old,parts:[...old.parts,{id:'native',type:'relation' as const,relation:'distribution',roles:{target:[{id:'kept',reference:{messageId:'target',revision:1}}]}}]};
  expect(relations(transform(existing)).find(part=>part.id==='native')?.roles.target[0].reference).toEqual({messageId:'target',revision:1});
});

it('preserves settlement targets when converting an older exported view without relationType',()=>{
  const converted=migrateViewFile({formatVersion:2,messages:[
    {id:'target',kind:'TEXT',content:'原文',authorId:'user',createdAt:''},
    {id:'result',kind:'ROUND_RESULT',content:'结算完成',authorId:'user',createdAt:'',targetRefs:[{messageId:'target'}],relationPayload:{settlementType:'TRUTH'}},
  ],relations:[]});
  expect(relations(converted.messages.find((message:Message)=>message.id==='result')).find(part=>part.relation==='distribution')?.roles.target[0].reference).toEqual({messageId:'target'});
});

it('reads an isolated backup source when the live original archive is absent, without changing the backup database',async()=>{
  const store=await fixture(),source=await createTestStore();
  await source.db.exec('CREATE TABLE "Message"(id TEXT,kind TEXT,"targetRefs" JSONB)');
  for(const [id,kind] of [['old-round','ROUND'],['old-result','ROUND_RESULT']])
    await source.db.prepare('INSERT INTO "Message" VALUES($1,$2,$3::jsonb)').run(id,kind,JSON.stringify([{messageId:'target'}]));
  const before=await source.db.prepare('SELECT * FROM "Message" ORDER BY id').all();
  await store.db.exec('DROP TABLE legacy_records');
  vi.stubEnv('GONGLUN_SETTLEMENT_SOURCE_DATABASE_URL',testDatabaseUrl());
  vi.stubEnv('GONGLUN_SETTLEMENT_SOURCE_DATABASE_SCHEMA',source.db.schema);
  expect(await store.read(()=>settlementTargetRepairPlan(store.db))).toMatchObject({pending:2,unresolved:0});
  await runMigrations(store.db,migrationsFor(store));
  expect(relations(await store.message('old-result')).find(part=>part.relation==='distribution')?.roles.target[0].reference).toEqual({messageId:'target'});
  expect(await source.db.prepare('SELECT * FROM "Message" ORDER BY id').all()).toEqual(before);
});

it('stops an upgrade without a recoverable source instead of stamping an incomplete repair',async()=>{
  const store=await fixture();
  await store.db.exec('DROP TABLE legacy_records');
  expect(await store.read(()=>settlementTargetRepairPlan(store.db))).toMatchObject({pending:0,unresolved:2});
  await expect(runMigrations(store.db,migrationsFor(store))).rejects.toThrow('GONGLUN_SETTLEMENT_SOURCE_DATABASE_URL');
  expect(await store.db.prepare('SELECT version FROM schema_migrations WHERE version=8').get()).toBeUndefined();
});
