import {afterEach,expect,it} from 'vitest';
import {bindRoles,type ReadingMark} from '@gonglun/core';
import {Mutation} from '../../server/src/db.js';
import {cleanupTestDatabases,createTestStore} from '../../server/src/test-database.js';
import {financialFingerprint} from './financial-fingerprint.js';
import {cleanupContainerReadingMarks,containerReadingCleanupPlan} from './cleanup-container-reading-marks.js';
import {migrationsFor,runMigrations} from './migrations.js';

afterEach(cleanupTestDatabases);
it('removes proven included container reads and duplicate placement keys, preserving standalone and ambiguous history',async()=>{
  const store=await createTestStore(),db=store.db,time='2026-10-24T12:00:00.000Z';
  await store.transaction(async()=>{
    const tx=new Mutation(store);
    await tx.create('user',[{id:'body',type:'text',text:'成员'}],undefined,'member');
    for(const [id,type] of [['container','classify'],['summary','summary'],['disabled-container','classify']] as const)
      await tx.create('user',[{id:'relation',type:'relation',relation:type,roles:bindRoles({members:[{messageId:'member'}]})}],undefined,id);
    for(const [id,parent] of [['join','container'],['disabled-join','disabled-container']])
      await tx.create('user',[{id:'relation',type:'relation',relation:'member-of',roles:bindRoles({parent:[{messageId:parent!}],member:[{messageId:'member'}]})}],undefined,id);
    await db.prepare('INSERT INTO membership_actions(id,body,disabled) VALUES($1,$2,TRUE)').run('disabled-join','{}');
    await tx.commit();
  });
  const rows:Array<{userId:string;mark:ReadingMark}>=[];
  const add=(messageId:string,key:string,extra:Partial<ReadingMark>={},userId='user')=>rows.push({userId,mark:{messageId,scope:'message',key,bodySignature:key,signature:'display',updatedAt:time,...extra}});
  const included={confirmation:{kind:'included' as const,messageId:'member'}};
  add('container','included',included);add('summary','included-summary',included);add('container','included-correction',{...included,scope:'corrections'});
  add('container','direct-then-included',{...included,directConfirmedAt:time});
  add('container','direct',{confirmation:{kind:'direct',messageId:'container'}});
  add('container','unknown');add('container','legacy-then-included',{...included,legacyConfirmation:true});
  add('container','direct-other-user',{confirmation:{kind:'direct',messageId:'container'}},'other-user');
  add('member','member-read');add('member','classify:container',{scope:'influence'});
  add('member','summary:summary',{scope:'influence'});add('member','classify:disabled-container',{scope:'influence'});
  add('member','agree:',{scope:'influence'});
  await store.transaction(async()=>{for(const {userId,mark} of rows)
    await db.prepare('INSERT INTO reading_marks VALUES($1,$2,$3,$4,$5)').run(userId,mark.messageId,mark.scope,mark.key,JSON.stringify(mark));});
  expect(await containerReadingCleanupPlan(store)).toEqual({pending:4,duplicateInfluences:1,includedBodies:3,preservedDirect:3,preservedUnknown:2});
  const before=await financialFingerprint(db),sequence=await store.latestSequence();
  await expect(store.transaction(async()=>{await cleanupContainerReadingMarks(store);throw new Error('rollback');})).rejects.toThrow('rollback');
  expect((await db.prepare('SELECT COUNT(*) AS count FROM reading_marks').get())!.count).toBe(rows.length);
  await store.transaction(async()=>{
    await db.prepare('DELETE FROM schema_migrations WHERE version>=24').run();
    await runMigrations(db,migrationsFor(store));
  });
  const actual=await db.prepare('SELECT "userId",body FROM reading_marks ORDER BY key').all();
  const expected=rows.filter(row=>!['included','included-summary','included-correction','classify:container'].includes(row.mark.key));
  expect(actual).toHaveLength(expected.length);
  for(const row of expected){
    const archived=await db.prepare('SELECT body FROM reading_migration_archive WHERE "userId"=$1 AND "messageId"=$2 AND scope=$3 AND key=$4').get(row.userId,row.mark.messageId,row.mark.scope,row.mark.key);
    expect(archived?.body).toEqual(row.mark);
    expect(actual.find(item=>item.userId===row.userId&&item.body.key===`historical:3:unknown:2:${row.mark.scope}:${row.mark.key}`)?.body).toEqual({...row.mark,format:3,unknownContext:true,key:`historical:3:unknown:2:${row.mark.scope}:${row.mark.key}`});
  }
  expect(await financialFingerprint(db)).toBe(before);expect(await store.latestSequence()).toBe(sequence+1);
  const audit=(await db.prepare('SELECT body FROM container_reading_cleanup_archive').get())!.body;
  expect(audit.records).toHaveLength(4);expect(audit.records.map((row:{key:string})=>row.key)).toContain('classify:container');
  await store.transaction(async()=>expect(await cleanupContainerReadingMarks(store)).toBe(0));
  expect((await db.prepare('SELECT COUNT(*) AS count FROM container_reading_cleanup_archive').get())!.count).toBe(1);
});
