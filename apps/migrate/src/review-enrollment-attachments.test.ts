import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { messageDisplayDependency, type Message } from '@gonglun/core';
import { Mutation, Store } from '../../server/src/db.js';
import { enrollModeration } from '../../server/src/moderation.js';
import { isDependentMessageSql } from '../../server/src/display-dependencies.js';
import { cleanupTestDatabases, createTestApp, testDatabaseUrl } from '../../server/src/test-database.js';
import { financialFingerprint } from './financial-fingerprint.js';
import { migrateModeration } from './moderation.js';
import { migrateReviewEnrollmentAttachments } from './review-enrollment-attachments.js';

afterEach(cleanupTestDatabases);

async function fixture() {
  const app = await createTestApp(), agent = request.agent(app);
  const registration = await agent.post('/api/register').send({name:'enrollment-author',password:'test-password'});
  expect(registration.status,registration.text).toBe(201);
  const targets: Message[] = [];
  for (const text of ['第一个被审核正文', '第二个被审核正文']) {
    const response = await agent.post('/api/messages').set('x-csrf-token',registration.body.csrf).send({
      requestId:randomUUID(), recommendation:1, parts:[{id:'body',type:'text',text}],
    });
    expect(response.status,response.text).toBe(201);
    targets.push(await app.store.message(response.body.message.id));
  }
  await app.store.transaction(async () => {
    const rules = await app.store.rules();
    await app.store.set('rules',{...rules,moderation:{...rules.moderation!,enabled:true}});
  });
  return {app,targets};
}

it('new historical enrollment records attach only to the enrolled versions and do not charge twice',async () => {
  const {app,targets} = await fixture();
  await app.store.transaction(() => migrateModeration(app.store));
  const rows = await app.store.db.prepare(`SELECT body FROM messages WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(body::jsonb->'parts') part WHERE part->>'relation'='review-enrollment'
  )`).all<{body:string}>();
  expect(rows).toHaveLength(1);
  const enrollment = JSON.parse(rows[0]!.body) as Message;
  expect(messageDisplayDependency(enrollment)).toEqual(targets.map(target => ({messageId:target.id,revision:target.revision})));
  for (const target of targets) {
    const response = await request(app).get(`/api/moderation/messages/${target.id}`);
    expect(response.status,response.text).toBe(200);
    expect(response.body.records.map((record:Message) => record.id)).not.toContain(enrollment.id);
  }
  expect((await request(app).get(`/api/messages/${enrollment.id}`)).body.parts).toEqual(enrollment.parts);
  const sequence = await app.store.latestSequence(), finances = await financialFingerprint(app.store.db);
  await app.store.transaction(() => migrateModeration(app.store));
  expect(await app.store.latestSequence()).toBe(sequence);
  expect(await financialFingerprint(app.store.db)).toBe(finances);
});

async function oldEnrollment() {
  const result = await fixture(), {app,targets} = result;
  let enrollment!: Message;
  await app.store.transaction(async () => {
    const tx = new Mutation(app.store);
    for (const target of targets) await enrollModeration(tx,target,true);
    // Old tx.affected also contained generated assignment messages.
    const assignment = await tx.create('system',[
      {id:'record',type:'relation',relation:'review-record',roles:{target:[{id:'target',reference:{messageId:targets[0]!.id,revision:1}}]}},
    ]);
    enrollment = await tx.create('system',[
      {id:'body',type:'text',text:'历史内容纳入审核：审核费与保证金分别冻结，余额不足记入欠额。'},
      {id:'record',type:'relation',relation:'review-enrollment',roles:{}},
      {id:'data',type:'data',value:{migration:'content-moderation',messageIds:[...targets.map(target => target.id),assignment.id],entries:[]}},
    ]);
    await tx.commit();
    await app.store.db.exec('DELETE FROM schema_migrations WHERE version>=41');
  });
  return {...result,enrollment};
}

it('upgrades old batches using their original target versions, preserving history, funds, and idempotence',async () => {
  const {app,targets,enrollment} = await oldEnrollment();
  const original = await app.store.message(enrollment.id);
  const journal = await app.store.db.prepare('SELECT body FROM changes WHERE sequence=$1').get(enrollment.sequence);
  // A later body version must not steal the original enrollment record.
  await app.store.transaction(async () => {
    const tx = new Mutation(app.store), next = {...targets[0]!,revision:2};
    await tx.put(next);await enrollModeration(tx,next,true);await tx.commit();
  });
  const before = await financialFingerprint(app.store.db);
  const cases = await app.store.db.prepare('SELECT * FROM moderation_cases ORDER BY position').all();
  const upgraded = await Store.open(testDatabaseUrl(),{schema:app.store.db.schema});
  try {
    const repaired = await upgraded.message(enrollment.id);
    expect(repaired.revision).toBe(2);
    expect(messageDisplayDependency(repaired)).toEqual(targets.map(target => ({messageId:target.id,revision:1})));
    expect(await upgraded.message(enrollment.id,1)).toEqual(original);
    expect(await upgraded.db.prepare('SELECT body FROM changes WHERE sequence=$1').get(enrollment.sequence)).toEqual(journal);
    expect(await upgraded.db.prepare('SELECT * FROM moderation_cases ORDER BY position').all()).toEqual(cases);
    expect(await financialFingerprint(upgraded.db)).toBe(before);
    expect(await upgraded.db.prepare(`SELECT id FROM messages m WHERE m.id=$1 AND NOT ${isDependentMessageSql('m')}`).get(enrollment.id)).toBeUndefined();
    expect(await upgraded.db.prepare('SELECT "targetId" FROM refs WHERE "sourceId"=$1 ORDER BY "targetId"').all(enrollment.id))
      .toEqual(targets.map(target => ({targetId:target.id})).sort((a,b) => a.targetId.localeCompare(b.targetId)));
    const response = await request(app).get(`/api/moderation/messages/${targets[0]!.id}?revision=1`);
    expect(response.status,response.text).toBe(200);
    expect(response.body.records.some((record:Message) => record.id === enrollment.id)).toBe(false);
    expect((await request(app).get(`/api/messages/${enrollment.id}`)).body.parts).toEqual(repaired.parts);
    // Even a restricted placeholder retains review identity and its attachment.
    await upgraded.db.prepare("UPDATE moderation_cases SET status='rejected' WHERE \"messageId\"=$1").run(targets[1]!.id);
    const restricted = await request(app).get(`/api/moderation/messages/${targets[1]!.id}`);
    expect(restricted.status,restricted.text).toBe(200);
    expect(restricted.body.records.some((record:Message) => record.id === enrollment.id)).toBe(false);
    const hidden = (await request(app).get(`/api/messages/${enrollment.id}`)).body;
    expect(hidden).toMatchObject({restricted:true,relationType:'REVIEW-ENROLLMENT'});
    expect(messageDisplayDependency(hidden)).toEqual(messageDisplayDependency(repaired));
    const sequence = await upgraded.latestSequence();
    expect(await upgraded.transaction(() => migrateReviewEnrollmentAttachments(upgraded))).toBe(0);
    expect(await upgraded.latestSequence()).toBe(sequence);
    expect(await financialFingerprint(upgraded.db)).toBe(before);
  } finally {await upgraded.close();}
});

it('rolls back the upgrade when the original target version cannot be recovered',async () => {
  const {app,enrollment} = await oldEnrollment();
  await app.store.db.prepare("UPDATE changes SET body=jsonb_set(body::jsonb,'{states}','[]'::jsonb)::text WHERE sequence=$1").run(enrollment.sequence);
  const original = await app.store.message(enrollment.id), before = await financialFingerprint(app.store.db);
  await expect(Store.open(testDatabaseUrl(),{schema:app.store.db.schema})).rejects.toThrow('审核迁移记录无法确认原始目标版本');
  expect(await app.store.message(enrollment.id)).toEqual(original);
  expect((await app.store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())?.version).toBe(40);
  expect(await financialFingerprint(app.store.db)).toBe(before);
});
