import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {afterEach,expect,it} from 'vitest';
import {createTestApp,cleanupTestDatabases,testDatabaseUrl,testInvitation} from '../../server/src/test-database.js';
import {Store} from '../../server/src/db.js';
import {moderationCase} from '../../server/src/moderation.js';
import {financialFingerprint} from './financial-fingerprint.js';
import {migrateParticipationReview} from './participation-review.js';

afterEach(cleanupTestDatabases);
it('opens old pending content and restores unused draws without changing balances, wagers, or the old funded fee budget',async()=>{
  const app=await createTestApp({moderation:true});
  await app.store.transaction(async()=>{
    const rules=await app.store.rules();
    await app.store.set('rules',{...rules,moderation:{enabled:true,fee:3,deposit:10,minReviewers:2,appealDelayMs:86400000,stages:[3,9,27]}});
  });
  const people:Array<{agent:ReturnType<typeof request.agent>;csrf:string;id:string}>=[];
  for(const name of ['migration-author','first-reviewer','second-reviewer','third-reviewer']){
    const agent=request.agent(app),res=await agent.post('/api/register').send({name,password:'password',inviteCode:await testInvitation(app)});
    expect(res.status,res.text).toBe(201);people.push({agent,csrf:res.body.csrf,id:res.body.user.id});
  }
  const [author,one,two]=people;
  async function publish(text:string){
    const res=await author!.agent.post('/api/messages').set('x-csrf-token',author!.csrf)
      .send({requestId:randomUUID(),recommendation:1,parts:[{id:'body',type:'text',text}]});
    expect(res.status,res.text).toBe(201);return (await moderationCase(app.store,res.body.message.id))!;
  }
  async function action(actor:typeof people[number],messageId:string,relation:string){
    const res=await actor.agent.post('/api/messages').set('x-csrf-token',actor.csrf).send({requestId:randomUUID(),reviewWager:relation==='review'?2:undefined,parts:[
      {id:'action',type:'relation',relation,roles:{target:[{id:'target',reference:{messageId}}]}},
      {id:'data',type:'data',value:{verdict:'pass'}}]});
    expect(res.status,res.text).toBe(201);
  }
  const empty=await publish('旧待审正文可以公开'),voted=await publish('旧押注保持原样');
  await action(one!,voted.messageId,'review');
  const votes=await app.store.db.prepare('SELECT * FROM moderation_votes ORDER BY position').all();
  const assignments=await app.store.db.prepare('SELECT * FROM moderation_assignments ORDER BY "caseId",round,"userId"').all();
  await app.store.transaction(()=>app.store.db.exec(`DROP TABLE moderation_round_fees; DROP TABLE moderation_deposits;
    DELETE FROM settings WHERE key='participation-review-version'; DELETE FROM schema_migrations WHERE version>=40`));
  const before=await financialFingerprint(app.store.db);
  const migrated=await Store.open(testDatabaseUrl(),{schema:app.store.db.schema});
  try{
    expect(await financialFingerprint(migrated.db)).toBe(before);
    expect(await migrated.db.prepare('SELECT * FROM moderation_votes ORDER BY position').all()).toEqual(votes);
    expect(await migrated.db.prepare('SELECT * FROM moderation_assignments ORDER BY "caseId",round,"userId"').all()).toEqual(assignments);
    expect(await moderationCase(migrated,empty.messageId)).toMatchObject({round:2,stage:0,status:'pending',fee:3,deposit:10});
    expect(await moderationCase(migrated,voted.messageId)).toMatchObject({round:1,status:'pending',fee:3,deposit:10});
    expect(await migrated.db.prepare('SELECT round,amount,paid FROM moderation_round_fees WHERE "caseId"=$1').get(empty.id)).toEqual({round:2,amount:3,paid:false});
    expect((await migrated.rules()).moderation).toMatchObject({fee:6,rewardSlots:3,rewardAmount:2,minWager:2,appealFee:6,appealDeposit:10});
    expect((await request(app).get(`/api/messages/${empty.messageId}`)).text).toContain('旧待审正文可以公开');
    const sequence=(await migrated.db.prepare('SELECT MAX(sequence) AS n FROM changes').get())?.n;
    await migrated.transaction(()=>migrateParticipationReview(migrated));
    expect(await financialFingerprint(migrated.db)).toBe(before);
    expect((await migrated.db.prepare('SELECT MAX(sequence) AS n FROM changes').get())?.n).toBe(sequence);
    expect((await moderationCase(migrated,empty.messageId))?.round).toBe(2);
    await action(two!,voted.messageId,'review');await action(one!,voted.messageId,'review-settle');
    expect((await moderationCase(migrated,voted.messageId))?.settlement?.finalized).toBe(true);
    expect(await migrated.db.prepare("SELECT \"userId\",amount FROM ledger WHERE reason='审核参与报酬'").all()).toEqual([{userId:one!.id,amount:2}]);
    expect(await migrated.db.prepare("SELECT \"userId\",amount FROM ledger WHERE reason='未使用审核费退还'").all()).toEqual([{userId:author!.id,amount:1}]);
  }finally{await migrated.close();}
});
