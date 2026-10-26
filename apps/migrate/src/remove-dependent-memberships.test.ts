import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { bindRoles, replayArchive } from '@gonglun/core';
import { Mutation } from '../../server/src/db.js';
import { placeWager, placeValueWager, settleDue } from '../../server/src/economy.js';
import { chargeMessage } from '../../server/src/message-spending.js';
import { setMembership } from '../../server/src/organizations.js';
import { cleanupTestDatabases, createTestApp, withTestCommandContributions } from '../../server/src/test-database.js';
import { dependentMembershipRemovalPlan, removeDependentMemberships } from './remove-dependent-memberships.js';
import { migrationsFor, runMigrations } from './migrations.js';

afterEach(cleanupTestDatabases);
it.each([false,true])('一次迁移删除旧加入并退回实际费用和本金，已结算=%s，重放及重复执行一致',async settled=>{
  const app=await createTestApp(),store=app.store,agent=request.agent(app);
  const session=(await agent.post('/api/register').send({name:'迁移退款',password:'test-password-123'})).body;
  const other=(await request.agent(app).post('/api/register').send({name:'参与旧加入的用户',password:'test-password-123'})).body;
  const post=async(path:string,body:Record<string,unknown>)=>{
    const response=await agent.post(`/api/ui${path}`).set('x-csrf-token',session.csrf).set('x-request-id',randomUUID()).send(withTestCommandContributions(path,body));
    expect(response.status,response.text).toBe(201);return response.body;
  };
  const group=await post('/relations',{relationType:'CLASSIFY',targetRefs:[],payload:{title:'组织'}});
  const original=await post('/messages',{content:'原始内容',parentMessageId:group.id});
  const correct=await post('/relations',{relationType:'CORRECT',targetRefs:[{kind:'message',messageId:original.id}],payload:{correctionKind:'WIDTH',correctionWidth:640}});
  const before=await store.account(session.user.id),operating=await store.setting<number>('operating');
  const otherBefore=await store.account(other.user.id);
  const originalJoin=(await store.db.prepare('SELECT "sourceId" FROM memberships WHERE "memberId"=$1').get(original.id))!.sourceId;
  await store.transaction(async()=>{
    const tx=new Mutation(store);
    // Reproduce the previous format, including its paid self stance, before attaching the old member role.
    const join=await tx.create(session.user.id,[{id:'body',type:'text',text:'旧加入'},
      {id:'self-stance',type:'relation',relation:'agree',roles:bindRoles({target:[{messageId:'obsolete-join'}]})}],
      {protocol:1,recommendation:2,wager:3},'obsolete-join');
    await chargeMessage(store,join);await placeWager(tx,join,3);
    join.parts=[{id:'relation',type:'relation',relation:'member-of',roles:bindRoles({parent:[{messageId:group.id}],member:[{messageId:correct.id}]})},...join.parts.filter(part=>part.id==='self-stance')];
    await tx.put(join);
    await store.db.prepare('INSERT INTO membership_actions(id,body) VALUES($1,$2)').run(join.id,JSON.stringify({id:join.id,memberId:correct.id,parentId:group.id,previousId:null,previousParentId:null,order:100}));
    await setMembership(tx,{memberId:correct.id,parentId:group.id,sourceId:join.id});
    const opposition=await tx.create(other.user.id,[{id:'relation',type:'relation',relation:'disagree',roles:bindRoles({target:[{messageId:join.id,partId:'relation'}]})}],{protocol:1,recommendation:0,wager:2});
    await chargeMessage(store,opposition);await placeWager(tx,opposition,2);
    const valuePart={id:'relation',type:'relation' as const,relation:'recommend',roles:bindRoles({target:[{messageId:join.id,revision:1}]})};
    const valueVote=await tx.create(other.user.id,[valuePart],{protocol:1,recommendation:0,wager:2});
    await chargeMessage(store,valueVote);await placeValueWager(tx,valueVote,valuePart,2);
    if(settled){
      await store.db.prepare(`UPDATE rounds SET body=(body::jsonb||jsonb_build_object('status','waiting','endsAt','2000-01-01T00:00:00Z'))::text WHERE COALESCE(body::jsonb->>'subjectId',body::jsonb #>> '{target,messageId}')=$1`).run(join.id);
      await settleDue(tx);
    }
    await tx.commit();
    await store.db.prepare('DELETE FROM schema_migrations WHERE version>=16').run();
  });
  const plan=await dependentMembershipRemovalPlan(store);
  expect(plan.joinIds).toEqual(['obsolete-join']);
  // A failed run must leave both the balance and old placement untouched.
  const preMigration=await store.account(session.user.id);
  await expect(store.transaction(async()=>{await removeDependentMemberships(store);throw new Error('rollback');})).rejects.toThrow('rollback');
  expect(await store.account(session.user.id)).toEqual(preMigration);
  expect((await dependentMembershipRemovalPlan(store)).joinIds).toEqual(plan.joinIds);
  const migrationCursor=await store.latestSequence();
  await runMigrations(store.db,migrationsFor(store));
  const after=await store.account(session.user.id);
  expect(after.available).toBe(before.available);expect(after.locked).toBe(before.locked);
  expect(await store.setting('operating')).toBe(operating+2);
  const otherAfter=await store.account(other.user.id);
  expect(otherAfter.available).toBe(otherBefore.available-2);expect(otherAfter.locked).toBe(otherBefore.locked);
  expect(await store.db.prepare('SELECT 1 FROM messages WHERE id=$1').get('obsolete-join')).toBeUndefined();
  expect(await store.db.prepare('SELECT 1 FROM membership_actions WHERE id=$1').get('obsolete-join')).toBeUndefined();
  expect(await store.db.prepare('SELECT 1 FROM memberships WHERE "memberId"=$1').get(correct.id)).toBeUndefined();
  expect((await store.db.prepare('SELECT "sourceId" FROM memberships WHERE "memberId"=$1').get(original.id))?.sourceId).toBe(originalJoin);
  expect((await store.message(correct.id)).id).toBe(correct.id);
  expect((await store.message('obsolete-join',1)).id).toBe('obsolete-join');
  const sequence=await store.latestSequence();
  await runMigrations(store.db,migrationsFor(store));
  await store.transaction(async()=>expect(await removeDependentMemberships(store)).toBe(0));
  expect(await store.latestSequence()).toBe(sequence);
  const changes=(await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)));
  const replay=replayArchive({format:'gonglun-2',changes});
  expect(replay.messages.some(message=>message.id==='obsolete-join')).toBe(false);
  expect(replay.accounts.get(session.user.id)).toEqual(after);
  const snapshot=await agent.get('/api/ui/snapshot');
  expect(snapshot.status,snapshot.text).toBe(200);
  expect(snapshot.body.messages.some((message:{id:string})=>message.id==='obsolete-join')).toBe(false);
  const delta=await agent.get(`/api/ui/snapshot?after=${migrationCursor}`);
  expect(delta.status,delta.text).toBe(200);
  expect(delta.body.removedMessageIds).toContain('obsolete-join');
  const rejected=await agent.post('/api/ui/relations').set('x-csrf-token',session.csrf).set('x-request-id',randomUUID()).send({
    relationType:'DISAGREE',targetRefs:[{kind:'message',messageId:'obsolete-join',reference:{messageId:'obsolete-join',revision:1,partId:'relation'}}],wager:1,
  });
  expect(rejected.status,rejected.text).toBe(404);
  expect(await store.account(session.user.id)).toEqual(after);
});
