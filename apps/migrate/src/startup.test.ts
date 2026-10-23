import {afterEach,expect,it} from 'vitest';
import request from 'supertest';
import {DEFAULT_RULES,replayArchive,archiveChangeFingerprint,type Message,type Change} from '@gonglun/core';
import {Store,Mutation} from '../../server/src/db.js';
import {initializePersonal,recordPersonal} from '../../server/src/personal-actions.js';
import {initializeProjections} from '../../server/src/projections.js';
import {cleanupTestDatabases,createTestApp,createTestStore,newTestSchema,testDatabaseUrl} from '../../server/src/test-database.js';
import {DATABASE_MIGRATIONS} from '../../server/src/database-version.js';
import {schemaSql} from './fixtures/native-v3-schema.js';
import {migrateViewFile} from './migrate-view-file.js';
import {validateExportForViewing} from '../../../frontend/src/utils/exportArchive.js';

afterEach(cleanupTestDatabases);
const time='2026-01-01T00:00:00.000Z';

async function previousDatabase(version:number){
  const schema=newTestSchema(),store=Store.maintenance(testDatabaseUrl(),{schema});
  await store.transaction(async()=>{
    await store.db.exec(`CREATE SCHEMA "${schema}"`);
    await store.db.exec(schemaSql);await initializePersonal(store);await initializeProjections(store);
    for(const [key,value] of Object.entries({rules:DEFAULT_RULES,region:'old-region',operating:20,minted:520,'retired-legacy-topics':[]}))await store.set(key,value);
    await store.db.prepare('INSERT INTO users(id,name,password,founder) VALUES($1,$2,$3,$4)').run('actor','原用户','retained-password-hash',1);
    await store.db.prepare('INSERT INTO accounts VALUES($1,$2,$3,$4,$5)').run('actor',500,0,500,0);
    const base:Message={id:'body',revision:1,authorId:'actor',createdAt:time,updatedAt:time,sequence:1,regionId:'old-region',ledgerId:'local',programVersion:'2.0.0',ruleVersion:1,
      parts:[{id:'body',type:'text',text:'保留正文'}],spending:{protocol:0,recommendation:0,wager:0}};
    const follow:Message={...base,id:'old-follow',parts:[{id:'relation',type:'relation',relation:'unfollow',roles:{target:[{id:'target',reference:{messageId:base.id}}]}},
      {id:'data',type:'data',value:{uiType:'UNFOLLOW'}}]};
    const recommendation:Message={...base,id:'recommendation',sequence:2,parts:[{id:'relation',type:'relation',relation:'recommend',roles:{target:[{id:'target',reference:{messageId:base.id}}]}}]};
    for(const message of [base,follow,recommendation]){
      await store.db.prepare('INSERT INTO messages VALUES($1,$2,$3,$4,$5)').run(message.id,message.authorId,time,message.sequence,JSON.stringify(message));
      await store.db.prepare('INSERT INTO revisions("messageId",revision,body) VALUES($1,1,$2)').run(message.id,JSON.stringify(message));
      for(const part of message.parts)if(part.type==='relation')for(const binding of Object.values(part.roles).flat())await store.db.prepare('INSERT INTO refs VALUES($1,$2)').run(message.id,binding.reference.messageId);
    }
    await recordPersonal(store,follow);
    const ledger={id:'grant',userId:'actor',messageId:base.id,amount:500,lockedDelta:0,reason:'原余额',createdAt:time,ruleVersion:1,messageRevision:1};
    await store.db.prepare('INSERT INTO ledger(id,"userId","messageId",amount,"lockedDelta",reason,"createdAt","ruleVersion","messageRevision") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)').run(...Object.values(ledger));
    const changes:Change[]=[{sequence:1,previousSequence:0,messages:[base,follow],memberships:[],removedMemberships:[],states:[],ledger:[ledger],treasury:{operating:20,issued:520}},
      {sequence:2,previousSequence:1,messages:[recommendation],memberships:[],removedMemberships:[],states:[],ledger:[],treasury:{operating:20,issued:520}}];
    for(const change of changes){
      const body:any={...change};if(version<2)delete body.previousSequence;
      await store.db.prepare('INSERT INTO changes(body) VALUES($1)').run(JSON.stringify(body));
    }
    await store.db.prepare('INSERT INTO signatures VALUES($1,$2,$3,$4,$5,$6,$7)').run(base.id,'actor','device','public-key','unchanged signed input','original-signature',time);
    if(version){
      await store.db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)');
      for(let index=0;index<version;index++)await store.db.prepare('INSERT INTO schema_migrations(version,name) VALUES($1,$2)').run(index+1,DATABASE_MIGRATIONS[index]);
    }
  });
  await store.close();return schema;
}

it.each([0,1,2,3])('startup automatically upgrades a real version %s schema, then exports and reopens without changing money or signatures',async version=>{
  const schema=await previousDatabase(version);
  const oldChanges=await Store.inspect(testDatabaseUrl(),{schema},async previous=>(await previous.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body))));
  const oldFile={format:'gonglun-2',formatVersion:2,scope:{messageId:null,title:'原导出'},changes:oldChanges,
    messages:oldChanges.flatMap(change=>change.messages),relations:[]};
  const store=await Store.open(testDatabaseUrl(),{schema});
  try{
    expect(await store.account('actor')).toEqual({available:500,locked:0,earned:500,spent:0});
    expect(await store.setting('region')).toBe('old-region');
    expect((await store.message('old-follow')).parts[0]).toMatchObject({relation:'follow',reason:'NO'});
    expect((await store.db.prepare('SELECT payload,signature FROM signatures').get())).toEqual({payload:'unchanged signed input',signature:'original-signature'});
    expect(await store.db.prepare('SELECT action FROM personal_marks WHERE family=$1').get('archive')).toEqual({action:'recommend'});
    expect((await store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())?.version).toBe(DATABASE_MIGRATIONS.length);
    const convertedOldFile=migrateViewFile(oldFile),databaseJournal=(await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)));
    expect(convertedOldFile.changes.map(archiveChangeFingerprint)).toEqual(databaseJournal.slice(0,oldChanges.length).map(archiveChangeFingerprint));
    const cursor=await store.latestSequence(),again=await Store.open(testDatabaseUrl(),{schema});
    try{expect(await again.latestSequence()).toBe(cursor);}finally{await again.close();}
    const app=await createTestApp({databaseSchema:schema}),response=await request(app).get('/api/ui/export');
    expect(response.status,response.text).toBe(200);
    const migrated=migrateViewFile(response.body);
    expect(validateExportForViewing(migrated).data.messages.map(message=>message.id)).toEqual(response.body.messages.map((message:any)=>message.id));
    expect(replayArchive(migrated).accounts.get('actor')).toEqual(await store.account('actor'));
    expect(migrateViewFile(migrated)).toEqual(migrated);
  }finally{await store.close();}
},30_000);

it('a new migration version repairs a previously current database automatically',async()=>{
  const schema=newTestSchema(),store=await createTestStore(schema);
  await store.transaction(async()=>{
    const tx=new Mutation(store);
    const body=await tx.create('actor',[{id:'body',type:'text',text:'旧正文'}],undefined,'body');
    await tx.create('actor',[{id:'relation',type:'relation',relation:'recommend',roles:{target:[{id:'target',reference:{messageId:body.id}}]}}]);
    await tx.commit();
  });
  await store.db.exec('DELETE FROM schema_migrations WHERE version=7');
  const current=await Store.open(testDatabaseUrl(),{schema});
  try{
    expect((await current.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())?.version).toBe(7);
    expect(await current.db.prepare("SELECT action FROM personal_marks WHERE family='archive'").get()).toEqual({action:'recommend'});
  }
  finally{await current.close();}
});

it('concurrent automatic startups execute the same upgrade only once',async()=>{
  const schema=await previousDatabase(3);
  const [left,right]=await Promise.all([Store.open(testDatabaseUrl(),{schema}),Store.open(testDatabaseUrl(),{schema})]);
  try{
    expect(await left.latestSequence()).toBe(3);
    expect(await right.latestSequence()).toBe(3);
    expect((await left.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get())?.n).toBe(DATABASE_MIGRATIONS.length);
  }finally{await left.close();await right.close();}
},30_000);

it('repairs a version 6 cancellation from its preserved original, including its executed personal action',async()=>{
  const schema=newTestSchema(),store=await createTestStore(schema);
  await store.transaction(async()=>{
    const tx=new Mutation(store);
    const body=await tx.create('actor',[{id:'body',type:'text',text:'原正文'}]);
    const follow=await tx.create('actor',[{id:'relation',type:'relation',relation:'follow',reason:'YES',roles:{target:[{id:'target',reference:{messageId:body.id}}]}},
      {id:'data',type:'data',value:{uiType:'ATTENTION',action:'unfollow',subType:'YES'}}],undefined,'cancelled');
    await tx.commit();await recordPersonal(store,follow);
    const original=structuredClone(follow);
    const relation=original.parts[0];if(relation.type==='relation')delete relation.reason;
    const data=original.parts[1];if(data.type==='data'&&data.value&&typeof data.value==='object'&&!Array.isArray(data.value))delete data.value.subType;
    await store.db.prepare('INSERT INTO annotation_reason_backups VALUES($1,$2,$3)').run('revisions',JSON.stringify([original.id,1]),JSON.stringify(original));
    await store.db.exec('DELETE FROM schema_migrations WHERE version=7');
  });
  const upgraded=await Store.open(testDatabaseUrl(),{schema});
  try{
    expect((await upgraded.message('cancelled')).parts[0]).toMatchObject({relation:'follow',reason:'NO'});
    expect(await upgraded.db.prepare("SELECT action FROM personal_marks WHERE family='follow'").get()).toEqual({action:'unfollow'});
  }finally{await upgraded.close();}
});

it('rolls back a failed automatic upgrade, retaining old messages, financial records and version stamps',async()=>{
  const schema=await previousDatabase(3),store=Store.maintenance(testDatabaseUrl(),{schema});
  try{
    const base=await store.message('body');
    const invalid:Message={...base,id:'bad-correction',parts:[
      {id:'relation',type:'relation',relation:'amend',roles:{target:[{id:'target',reference:{messageId:'body',revision:1,partId:'body',range:{start:0,end:1}}}]}},
      {id:'data',type:'data',value:{legacyTopicId:'topic',uiType:'CORRECT',correctionContent:'无法对应旧选区'}},
    ]};
    await store.db.prepare('INSERT INTO messages VALUES($1,$2,$3,$4,$5)').run(invalid.id,invalid.authorId,invalid.createdAt,1,JSON.stringify(invalid));
    await store.db.prepare('INSERT INTO revisions("messageId",revision,body) VALUES($1,1,$2)').run(invalid.id,JSON.stringify(invalid));
    const before={messages:await store.db.prepare('SELECT * FROM messages ORDER BY id').all(),ledger:await store.db.prepare('SELECT * FROM ledger').all(),
      versions:await store.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()};
    await expect(Store.open(testDatabaseUrl(),{schema})).rejects.toThrow('自动转换失败');
    expect(await store.db.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(before.messages);
    expect(await store.db.prepare('SELECT * FROM ledger').all()).toEqual(before.ledger);
    expect(await store.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(before.versions);
    expect((await store.db.prepare("SELECT to_regclass('annotation_reason_backups') AS name").get())?.name).toBeNull();
  }finally{await store.close();}
},30_000);
