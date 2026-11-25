import { PARTICIPATION_AGREEMENT_VERSION } from '@gonglun/core';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {afterEach,expect,it} from 'vitest';
import {createTestApp,cleanupTestDatabases,testDatabaseUrl} from '../../server/src/test-database.js';
import {Store} from '../../server/src/db.js';
import {moderationCase} from '../../server/src/moderation.js';
import {financialFingerprint} from './financial-fingerprint.js';
import {reviewAssignmentSchema} from './random-review-assignments.js';
import {DATABASE_MIGRATIONS} from '../../server/src/database-version.js';

afterEach(cleanupTestDatabases);
it('migrates old sessions through activity tracking and its retirement, preserving credentials and finances',async()=>{
  const app=await createTestApp({moderation:true}),agent=request.agent(app);
  const registration=await agent.post('/api/register').send({acceptedAgreementVersion: PARTICIPATION_AGREEMENT_VERSION, name:'presence-migration',password:'password'});
  expect(registration.status).toBe(201);
  expect((await request(app).post('/api/login').send({name:'presence-migration',password:'password'})).status).toBe(200);
  await app.store.transaction(()=>app.store.db.exec(`${reviewAssignmentSchema}
    DELETE FROM schema_migrations WHERE version>=39`));
  const before=await financialFingerprint(app.store.db);
  const sessions=await app.store.db.prepare('SELECT token,"userId",csrf,expires,"deviceId" FROM sessions ORDER BY token').all();
  const migrated=await Store.open(testDatabaseUrl(),{schema:app.store.db.schema});
  try{
    expect((await migrated.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())?.version).toBe(DATABASE_MIGRATIONS.length);
    expect(await migrated.db.prepare('SELECT token,"userId",csrf,expires,"deviceId" FROM sessions ORDER BY token').all()).toEqual(sessions);
    expect(await migrated.db.prepare(`SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='sessions' AND column_name='lastActiveAt'`).get()).toBeUndefined();
    expect((await agent.get('/api/session')).body.user.id).toBe(registration.body.user.id);
    expect(await financialFingerprint(migrated.db)).toBe(before);
    expect((await agent.post('/api/logout').set('x-csrf-token',registration.body.csrf)).status).toBe(200);
    expect(await migrated.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({n:1});
  }finally{await migrated.close();}
});

it('upgrades the fixed-role review schema without charging, clearing stakes, or publishing pending content',async()=>{
  const app=await createTestApp({moderation:true}),agent=request.agent(app);
  const registration=await agent.post('/api/register').send({acceptedAgreementVersion: PARTICIPATION_AGREEMENT_VERSION, name:'migration-author',password:'password'});
  expect(registration.status).toBe(201);
  const reviewers=[];
  for(let i=0;i<3;i++){
    const actor=request.agent(app),res=await actor.post('/api/register').send({acceptedAgreementVersion: PARTICIPATION_AGREEMENT_VERSION, name:`migration-reviewer-${i}`,password:'password'});
    expect(res.status,res.text).toBe(201);reviewers.push({agent:actor,csrf:res.body.csrf});
  }
  const sent=await agent.post('/api/messages').set('x-csrf-token',registration.body.csrf)
    .send({requestId:randomUUID(),recommendation:1,parts:[{id:'body',type:'text',text:'MIGRATION-PRIVATE'}]});
  expect(sent.status,sent.text).toBe(201);
  const c=(await moderationCase(app.store,sent.body.message.id))!;
  const vote=await reviewers[0]!.agent.post('/api/messages').set('x-csrf-token',reviewers[0]!.csrf).send({requestId:randomUUID(),reviewWager:2,parts:[
    {id:'review',type:'relation',relation:'review',roles:{target:[{id:'target',reference:{messageId:c.messageId}}]}},
    {id:'data',type:'data',value:{verdict:'pass',reviewRound:1}}]});
  expect(vote.status,vote.text).toBe(201);
  await app.store.transaction(async()=>{
    // An old vote keeps its money and audit identity, but cannot open a new random round.
    await app.store.db.exec(`ALTER TABLE moderation_cases DROP COLUMN round;
      ALTER TABLE moderation_votes DROP COLUMN round;
      UPDATE moderation_cases SET policy=policy-'stages'-'assignmentTtlMs'-'exposureMultiplier';
      DELETE FROM schema_migrations WHERE version>=38`);
  });
  const before=await financialFingerprint(app.store.db);
  const migrated=await Store.open(testDatabaseUrl(),{schema:app.store.db.schema});await migrated.close();
  expect(await financialFingerprint(app.store.db)).toBe(before);
  const updated=(await moderationCase(app.store,c.messageId))!;
  expect(updated).toMatchObject({round:2,status:'pending'});
  expect(updated.policy).not.toHaveProperty('stages');
  expect((await request(app).get(`/api/messages/${c.messageId}`)).text).toContain('MIGRATION-PRIVATE');
  const votes=await app.store.db.prepare('SELECT * FROM moderation_votes WHERE "caseId"=$1').all(c.id);
  expect(votes).toHaveLength(1);expect(votes[0]).toMatchObject({round:1,amount:2});
});
