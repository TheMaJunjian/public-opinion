import request from 'supertest';
import {afterEach,expect,it} from 'vitest';
import {Mutation,Store} from '../../server/src/db.js';
import {enrollModeration,moderationCase} from '../../server/src/moderation.js';
import {cleanupTestDatabases,createTestApp,testDatabaseUrl} from '../../server/src/test-database.js';
import {financialFingerprint} from './financial-fingerprint.js';
import {migrateStakeWeightedReview} from './stake-weighted-review.js';
import {DATABASE_MIGRATIONS} from '../../server/src/database-version.js';

afterEach(cleanupTestDatabases);

it('reopens provisional head-count conclusions through v43 without changing money, review rounds, paid outcomes or notifications',async()=>{
  const app=await createTestApp({moderation:true});
  const registered=await request(app).post('/api/register').send({name:'review-author',password:'password'});
  expect(registered.status,registered.text).toBe(201);
  const cases=[];
  for(const state of ['approved','rejected','finalized','pending'] as const){
    const message=await app.store.transaction(async()=>{
      const tx=new Mutation(app.store),message=await tx.create(registered.body.user.id,[{id:'body',type:'text',text:state}]);
      await enrollModeration(tx,message);await tx.commit();return message;
    });
    const review=(await moderationCase(app.store,message.id))!;
    const settlement=state==='pending'?null:{verdict:state==='rejected'?'reject':'pass',payouts:[],fund:0,finalized:state==='finalized',voteIds:[],messageId:message.id};
    await app.store.db.prepare('UPDATE moderation_cases SET status=$2,stage=2,settlement=$3::jsonb,"releaseAt"=$4 WHERE id=$1')
      .run(review.id,state==='finalized'?'approved':state,JSON.stringify(settlement),settlement?'2099-01-01T00:00:00Z':null);
    cases.push((await moderationCase(app.store,message.id))!);
  }
  const finances=await financialFingerprint(app.store.db),notifications=await app.store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get();
  await app.store.db.exec('DELETE FROM schema_migrations WHERE version>=43');
  const upgraded=await Store.open(testDatabaseUrl(),{schema:app.store.db.schema});
  try{
    for(const [index,review] of cases.entries()){
      const current=await moderationCase(upgraded,review.messageId);
      if(index===2)expect(current).toEqual(review);
      else expect(current).toMatchObject({status:index===1?'appeal':'pending',stage:0,round:review.round,fee:review.fee,deposit:review.deposit,settlement:null,releaseAt:null});
    }
    expect(await financialFingerprint(upgraded.db)).toBe(finances);
    expect(await upgraded.db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual(notifications);
    expect((await upgraded.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())?.version).toBe(DATABASE_MIGRATIONS.length);
    const sequence=await upgraded.latestSequence();
    await upgraded.transaction(()=>migrateStakeWeightedReview(upgraded));
    expect(await upgraded.latestSequence()).toBe(sequence);
    expect(await financialFingerprint(upgraded.db)).toBe(finances);
  }finally{await upgraded.close();}
});
