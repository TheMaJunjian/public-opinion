import { replayArchive, type Change, type Json } from '@gonglun/core';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { Mutation } from '../../server/src/db.js';
import { cleanupTestDatabases, createTestApp, newTestSchema, testDatabaseUrl } from '../../server/src/test-database.js';
import { financialFingerprint } from './financial-fingerprint.js';
import { openMigratingStore } from './migrations.js';
import { reviewAssignmentSchema } from './random-review-assignments.js';
import { migrationPlan } from './preflight.js';
import { removeReviewPermissions } from './remove-review-permissions.js';

afterEach(cleanupTestDatabases);

it('previews zero review removals before message or inbox tables exist', async () => {
  const schema = newTestSchema();
  expect((await migrationPlan(testDatabaseUrl(), schema)).reviewPermissions).toEqual({messages:0,notifications:0});
});

it('removes permission records and inbox deliveries on upgrade while preserving review activity and replay', async () => {
  const app = await createTestApp(), { store } = app, { db } = store;
  const oldIds = ['grant','assigned','withdrawn','expanded'];
  await store.transaction(async () => {
    await db.exec(`${reviewAssignmentSchema}
      CREATE TABLE moderation_reviewers("userId" TEXT PRIMARY KEY,"authorizationId" TEXT,"createdAt" TEXT);
      INSERT INTO moderation_reviewers VALUES ('participant','grant','2026-01-01');
      ALTER TABLE sessions ADD COLUMN "lastActiveAt" BIGINT DEFAULT 0;
      ALTER TABLE moderation_cases DROP COLUMN "appealFrom";
      DELETE FROM schema_migrations WHERE version>=50;`);
    const rules = await store.rules();
    const historicalPolicy = { ...rules.moderation!, stages:[3], assignmentTtlMs:60000, exposureMultiplier:2 };
    await store.set('rules', { ...rules, moderation:historicalPolicy });
    await db.prepare('UPDATE rule_versions SET body=$1 WHERE version=$2').run(JSON.stringify(await store.rules()), rules.version);
    const tx = new Mutation(store);
    await tx.create('author', [{ id:'body', type:'text', text:'正文' }], undefined, 'target');
    const records: Array<[string,string,string,Record<string,Json>]> = [
      ['grant','moderator','reviewer-authorize',{}],
      ['assigned','system','review-record',{ assigned:['participant'] }],
      ['withdrawn','system','review-record',{ revoked:['participant'] }],
      ['expanded','system','review-record',{ stageSize:9 }],
      ['vote','participant','review',{ verdict:'pass', assigned:['participant'] }],
      ['result','system','review-record',{ verdict:'pass', stageSize:3 }],
      ['reopened','system','review-record',{ status:'appeal' }],
      ['payment','system','review-record',{ payouts:[] }],
      ['enrollment','system','review-enrollment',{ migration:'content-moderation' }],
      ['unrelated','participant','annotation',{ revoked:['participant'] }],
    ];
    for (const [id,author,relation,data] of records) {
      await tx.create(author, [
        { id:'record',type:'relation',relation,roles:{target:[{id:'target',reference:{messageId:'target'}}]} },
        { id:'data',type:'data',value:{ caseId:'case', ...data } },
      ], undefined, id);
    }
    await db.prepare("INSERT INTO accounts VALUES ('moderator',0,0,0,0)").run();
    await store.ledger('moderator','target',5,0,'原账户余额');
    await store.set('minted',5);
    await store.ledger('moderator','grant',-1,0,'协议费');
    await store.operating(1);
    const change = await tx.commit();
    const target = await store.message('target'), grant = await store.message('grant');
    await db.prepare("INSERT INTO requests VALUES ('author','existing-request','{}',$1)")
      .run(JSON.stringify({ message:target, change, account:await store.account('moderator') }));
    await db.prepare("INSERT INTO command_requests VALUES ('author','existing-batch','{}',$1)")
      .run(JSON.stringify({ results:[target,grant], sequence:change.sequence, projection:{after:0,parents:['root']} }));
    for (const [source, kind] of [['assigned','review-assigned'],['withdrawn','review-revoked'],['expanded','review-expanded'],
      ['result','review-result'],['reopened','review-reopened']]) {
      await db.prepare(`INSERT INTO notifications ("userId","eventId","sourceId","targetId","actorId",category,kind,"groupKey","createdAt","changeSequence",body)
        VALUES ('participant',$1,$1,'target','system','review',$2,$1,'2026-01-01',$3,'{}')`).run(source, kind, change.sequence);
    }
    await db.prepare(`UPDATE notifications SET body=jsonb_build_object('action',$1::text)
      WHERE kind='review-reopened'`).run('已发起审核复核，重新分配本轮审核任务');
    await db.prepare(`INSERT INTO moderation_cases(id,"messageId",revision,"authorId",snapshot,"ruleVersion",policy,fee,deposit,"createdAt")
      VALUES('case','target',1,'author','{}',1,$1,6,10,'2026-01-01')`).run(JSON.stringify(historicalPolicy));
    await db.prepare(`INSERT INTO moderation_votes("messageId","caseId","userId",verdict,amount,"createdAt")
      VALUES('vote','case','participant','pass',2,'2026-01-01')`).run();
  });
  const finances = await financialFingerprint(db), sequence = await store.latestSequence();
  expect((await migrationPlan(testDatabaseUrl(), db.schema)).reviewPermissions).toEqual({messages:4,notifications:3});
  expect(await store.latestSequence()).toBe(sequence);
  const upgraded = await openMigratingStore(testDatabaseUrl(), {schema:db.schema});
  try {
    const live = (await db.prepare('SELECT id FROM messages ORDER BY id').all<{id:string}>()).map(row => row.id);
    expect(live).toEqual(['enrollment','payment','reopened','result','target','unrelated','vote']);
    expect(await db.prepare('SELECT 1 FROM revisions WHERE "messageId"=ANY($1::text[])').get(oldIds)).toBeUndefined();
    expect(await db.prepare('SELECT 1 FROM refs WHERE "sourceId"=ANY($1::text[])').get(oldIds)).toBeUndefined();
    expect(await db.prepare("SELECT kind,body->>'action' AS action FROM notifications ORDER BY kind").all()).toEqual([
      {kind:'review-reopened',action:'已发起审核复核'}, {kind:'review-result',action:null},
    ]);
    expect((await migrationPlan(testDatabaseUrl(),db.schema)).reviewPermissions).toEqual({messages:0,notifications:0});
    expect(await db.prepare(`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()
      AND table_name IN ('moderation_reviewers','moderation_assignments','moderation_candidate_preferences')`).all()).toEqual([]);
    for (const policy of [(await upgraded.rules()).moderation, (await db.prepare('SELECT policy FROM moderation_cases').get())!.policy,
      (await db.prepare("SELECT body::jsonb->'moderation' AS policy FROM rule_versions WHERE version=$1").get((await upgraded.rules()).version))!.policy]) {
      expect(policy).toMatchObject({fee:6, deposit:10});
      for (const key of ['stages','assignmentTtlMs','exposureMultiplier']) expect(policy).not.toHaveProperty(key);
    }
    expect(await db.prepare('SELECT verdict,amount FROM moderation_votes').all()).toEqual([{verdict:'pass',amount:2}]);
    expect(await db.prepare('SELECT "appealFrom" FROM moderation_cases').get()).toEqual({appealFrom:null});
    expect(await financialFingerprint(db)).toBe(finances);
    const receipt = JSON.parse((await db.prepare("SELECT result FROM requests WHERE \"requestId\"='existing-request'").get())!.result);
    expect(receipt.message.id).toBe('target');
    expect(receipt.change.messages.map((message:{id:string}) => message.id).sort()).toEqual(live);
    const batch = JSON.parse((await db.prepare("SELECT result FROM command_requests WHERE \"requestId\"='existing-batch'").get())!.result);
    expect(batch.results).toMatchObject([{id:'target',parts:[{text:'正文'}]},{id:'grant',removed:true}]);
    const changes = (await db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row => JSON.parse(row.body));
    expect(changes.at(-1)).toMatchObject({previousSequence:sequence,removedMessageIds:[...oldIds].sort(),
      prunedMessageIds:['assigned','expanded','withdrawn']});
    expect(replayArchive({format:'gonglun-2',changes}).messages.map(message => message.id).sort()).toEqual(live);
    for (const path of ['/api/changes','/api/export']) {
      const response = await request(app).get(path).expect(200);
      const history = response.body.changes as Change[];
      expect(history.flatMap(change => change.messages).filter(message => oldIds.includes(message.id)))
        .toEqual([expect.objectContaining({id:'grant', revision:1, parts:[]})]);
      if (path === '/api/export') expect(replayArchive(response.body).accounts.get('moderator')).toEqual(await store.account('moderator'));
    }
    await upgraded.transaction(() => removeReviewPermissions(upgraded));
    expect(await upgraded.latestSequence()).toBe(changes.at(-1).sequence);
  } finally { await upgraded.close(); }
});
