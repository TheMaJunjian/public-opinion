import request from 'supertest';
import {afterEach,expect,it} from 'vitest';
import {messageDisplayDependency,type Message} from '@gonglun/core';
import {Mutation,Store} from '../../server/src/db.js';
import {enrollModeration,moderationCase} from '../../server/src/moderation.js';
import {addReviewFunding} from '../../server/src/review-finances.js';
import {assignmentRecord} from '../../server/src/review-assignments.js';
import {cleanupTestDatabases,createTestApp,testDatabaseUrl,testInvitation} from '../../server/src/test-database.js';
import {financialFingerprint} from './financial-fingerprint.js';
import {migrateReviewSelfStakes} from './review-self-stakes.js';

afterEach(cleanupTestDatabases);

async function historicalDeposits(){
  const app=await createTestApp({moderation:true}),people=[];
  for(const name of ['old-author','old-challenger']){
    const response=await request(app).post('/api/register').send({name,password:'password',inviteCode:await testInvitation(app)});
    expect(response.status,response.text).toBe(201);people.push(response.body.user.id as string);
  }
  const [author,challenger]=people as [string,string],targets:Message[]=[],appeals:Message[]=[];
  for(const verdict of ['pass','reject'] as const){
    const target=await app.store.transaction(async()=>{
      const tx=new Mutation(app.store),m=await tx.create(author,[{id:'body',type:'text',text:`旧内容 ${verdict}`}]);
      await enrollModeration(tx,m);await tx.commit();return m;
    });
    const c=(await moderationCase(app.store,target.id))!;
    await app.store.transaction(async()=>{
      const tx=new Mutation(app.store);
      await assignmentRecord(tx,c,'原审核结论',{verdict});await tx.commit();
    });
    await app.store.transaction(async()=>{
      const tx=new Mutation(app.store),payer=verdict==='pass'?challenger:author;
      const appeal=await tx.create(payer,[{id:'body',type:'text',text:'旧复核申请'},
        {id:'appeal',type:'relation',relation:'review-appeal',roles:{target:[{id:'target',reference:{messageId:target.id,revision:1}}]}},
        // Before validation existed, user-supplied verdict metadata could be false.
        {id:'data',type:'data',value:{caseId:c.id,verdict,reviewRound:1}},
      ]);
      c.round=2;c.deposit=20;
      await addReviewFunding(tx,c,appeal,6,10,false,verdict==='pass'?'reject':'pass');
      await app.store.db.prepare('UPDATE moderation_cases SET round=2,deposit=20,status=$2 WHERE id=$1').run(c.id,'appeal');
      await tx.commit();appeals.push(appeal);
    });
    targets.push(target);
  }
  await app.store.db.exec('ALTER TABLE moderation_deposits DROP COLUMN verdict; DELETE FROM schema_migrations WHERE version>=42');
  return {app,author,challenger,targets,appeals};
}

it('converts existing guarantees without charging, derives both appeal sides from history, and publishes attached audit records once',async()=>{
  const {app,author,challenger,targets}=await historicalDeposits();
  const finances=await financialFingerprint(app.store.db),sequence=await app.store.latestSequence();
  const originalCases=await app.store.db.prepare('SELECT * FROM moderation_cases ORDER BY position').all();
  const originalJournal=await app.store.db.prepare('SELECT body FROM changes ORDER BY sequence').all();
  // Exercise the versioned startup path as well as direct migration idempotence.
  const upgraded=await Store.open(testDatabaseUrl(),{schema:app.store.db.schema});
  try{
    const deposits=await upgraded.db.prepare('SELECT "payerId",verdict,amount FROM moderation_deposits ORDER BY "caseId",round').all();
    expect(deposits).toEqual(expect.arrayContaining([
      {payerId:author,verdict:'pass',amount:10},{payerId:challenger,verdict:'reject',amount:10},
    ]));
    expect(deposits.filter(d=>d.verdict==='pass')).toHaveLength(3);
    expect(deposits.filter(d=>d.verdict==='reject')).toHaveLength(1);
    expect(await financialFingerprint(upgraded.db)).toBe(finances);
    expect(await upgraded.db.prepare('SELECT * FROM moderation_cases ORDER BY position').all()).toEqual(originalCases);
    expect(await upgraded.db.prepare('SELECT body FROM changes WHERE sequence<=$1 ORDER BY sequence').all(sequence)).toEqual(originalJournal);
    const changes=await upgraded.db.prepare('SELECT body FROM changes WHERE sequence>$1 ORDER BY sequence').all<{body:string}>(sequence);
    expect(changes).toHaveLength(1);
    const change=JSON.parse(changes[0]!.body);
    expect(change.ledger).toEqual([]);
    expect(messageDisplayDependency(change.messages[0])).toEqual(targets.map(target=>({messageId:target.id,revision:1})));
    const after=await upgraded.latestSequence();
    expect(await upgraded.transaction(()=>migrateReviewSelfStakes(upgraded))).toBe(0);
    expect(await upgraded.latestSequence()).toBe(after);
    expect(await financialFingerprint(upgraded.db)).toBe(finances);
  }finally{await upgraded.close();}
});

it('preserves finalized historical payouts instead of settling old funds again',async()=>{
  const {app,targets}=await historicalDeposits();
  const settlement={verdict:'pass',finalized:true,payouts:[{userId:'original-payee',amount:10,kind:'deposit'}],fund:0,voteIds:[],messageId:'original-settlement'};
  await app.store.db.prepare(`UPDATE moderation_cases SET status='approved',settlement=$2::jsonb WHERE "messageId"=$1`).run(targets[0]!.id,JSON.stringify(settlement));
  const before=await financialFingerprint(app.store.db);
  await app.store.transaction(()=>migrateReviewSelfStakes(app.store));
  expect((await moderationCase(app.store,targets[0]!.id))!.settlement).toEqual(settlement);
  expect(await financialFingerprint(app.store.db)).toBe(before);
});

it('rolls back the entire upgrade when a historical appeal has no recoverable conclusion',async()=>{
  const {app,targets}=await historicalDeposits();
  const c=(await moderationCase(app.store,targets[1]!.id))!;
  await app.store.db.prepare(`DELETE FROM messages WHERE "authorId"='system' AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(body::jsonb->'parts') p WHERE p->'value'->>'caseId'=$1 AND p->'value' ? 'verdict'
  )`).run(c.id);
  const sequence=await app.store.latestSequence(),before=await financialFingerprint(app.store.db);
  await expect(Store.open(testDatabaseUrl(),{schema:app.store.db.schema})).rejects.toThrow('审核自押迁移缺少复核前结论');
  expect(await app.store.latestSequence()).toBe(sequence);
  expect(await financialFingerprint(app.store.db)).toBe(before);
  expect((await app.store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())?.version).toBe(41);
  expect(await app.store.db.prepare(`SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='moderation_deposits' AND column_name='verdict'`).get(app.store.db.schema)).toBeUndefined();
});
