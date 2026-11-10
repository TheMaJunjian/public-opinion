import {randomUUID} from 'node:crypto';
import type {Response} from 'express';
import request from 'supertest';
import {afterEach,expect,it} from 'vitest';
import {register} from './auth.js';
import {createTestApp,cleanupTestDatabases,testInvitation} from './test-database.js';
import {moderationCase,reviewVotes,summarizeReview} from './moderation.js';
import {reviewDeposits} from './review-finances.js';
import {assignmentCounts,processReviewAssignments,REVIEW_ONLINE_WINDOW_MS,type ReviewAssignment} from './review-assignments.js';

afterEach(cleanupTestDatabases);
async function setup(count:number){
  const app=await createTestApp({moderation:true});
  const users:Array<{id:string;csrf:string;cookie:string}>=[];
  for(let i=0;i<count;i++){
    let cookie='';
    const res={req:{secure:false},cookie:(name:string,value:string)=>{cookie=`${name}=${value}`;}} as unknown as Response;
    // Use the actual invitation/session path without the HTTP auth rate limit on a large jury fixture.
    const {session}=await register(app.store,{name:`juror-${i}`,password:'test-password',inviteCode:await testInvitation(app)},res);
    users.push({id:session.user.id,csrf:session.csrf,cookie});
  }
  type Actor=typeof users[number];
  const get=(actor:Actor,path:string)=>request(app).get(path).set('Cookie',actor.cookie);
  const send=(actor:Actor,parts:unknown[],extra:Record<string,unknown>={})=>request(app).post('/api/messages').set('Cookie',actor.cookie).set('x-csrf-token',actor.csrf)
    .send({requestId:randomUUID(),parts,...extra});
  const author=users[0]!;
  const publish=async(text='RANDOM-REVIEW-PRIVATE')=>{
    const response=await send(author,[{id:'body',type:'text',text}],{recommendation:1});
    expect(response.status,response.text).toBe(201);return response.body.message;
  };
  const action=async(actor:Actor,id:string,kind:string,verdict?:string,amount=2,round?:number)=>{
    const c=(await moderationCase(app.store,id))!;
    return send(actor,[{id:'reason',type:'text',text:'本次审核理由'},
      {id:'action',type:'relation',relation:kind,roles:{target:[{id:'target',reference:{messageId:id,revision:c.revision}}]}},
      {id:'data',type:'data',value:{caseId:c.id,reviewRound:round??c.round,...(verdict?{verdict}:{})}}],kind==='review'?{reviewWager:amount}:{});
  };
  const assignments=async(id:string)=>{const c=(await moderationCase(app.store,id))!;return app.store.db.prepare('SELECT * FROM moderation_assignments WHERE "caseId"=$1 AND round=$2 ORDER BY "userId"').all<ReviewAssignment>(c.id,c.round);};
  const actor=(id:string)=>users.find(user=>user.id===id)!;
  return {app,users,author,get,send,publish,action,assignments,actor};
}

it('allows an assigned reviewer to settle the existing self stake without first submitting a review',async()=>{
  const t=await setup(4),m=await t.publish(),assigned=await t.assignments(m.id);
  expect(assigned).toHaveLength(3);
  const reviewer=t.actor(assigned[0]!.userId);
  expect((await t.get(reviewer,`/api/moderation/messages/${m.id}`)).body).toMatchObject({canReview:true,canSettle:true,summary:{reviewerCount:0,pass:10,reject:0}});
  const account=await t.app.store.account(reviewer.id);
  expect((await t.action(reviewer,m.id,'review-settle')).status).toBe(201);
  const review=(await moderationCase(t.app.store,m.id))!;
  expect(review).toMatchObject({status:'approved',settlement:{finalized:true}});
  expect(await reviewVotes(t.app.store,review.id)).toEqual([]);
  expect((await t.app.store.account(reviewer.id)).available).toBe(account.available-1);
  expect(await t.app.store.db.prepare("SELECT 1 FROM ledger WHERE reason='审核参与报酬'").get()).toBeUndefined();
});

it('draws and replaces only recently online users, while retaining their existing message assignments after going offline',async()=>{
  const t=await setup(7),[one,two,three,returning,offline,expired]=t.users.slice(1);
  const presence=(actor:typeof t.author,csrf=actor.csrf)=>request(t.app).post('/api/moderation/presence').set('Cookie',actor.cookie).set('x-csrf-token',csrf);
  const process=async()=>{
    await t.app.store.db.exec('UPDATE moderation_cases SET "assignmentCheckAt"=0');
    await processReviewAssignments(t.app.store);
  };
  // Valid login cookies, automatic account reads and background polling are not proof of presence.
  await t.app.store.db.prepare('UPDATE sessions SET "lastActiveAt"=$1').run(Date.now()-REVIEW_ONLINE_WINDOW_MS-1000);
  await t.get(offline!,'/api/session');await t.get(offline!,'/api/moderation/queue');
  expect((await request(t.app).post('/api/moderation/presence')).status).toBe(401);
  expect((await presence(offline!,'wrong-csrf')).status).toBe(403);
  const m=await t.publish();expect(await t.assignments(m.id)).toHaveLength(0);
  for(const actor of [one!,two!,three!])expect((await presence(actor)).status).toBe(200);
  // An expired session cannot renew presence or enter the draw, even with a recent timestamp.
  await t.app.store.db.prepare('UPDATE sessions SET expires=0,"lastActiveAt"=$2 WHERE "userId"=$1').run(expired!.id,Date.now());
  expect((await presence(expired!)).status).toBe(401);
  await process();
  expect((await t.assignments(m.id)).map(row=>row.userId).sort()).toEqual([one!.id,two!.id,three!.id].sort());

  await t.app.store.db.exec('UPDATE sessions SET "lastActiveAt"=0');
  await process();
  expect((await t.assignments(m.id)).filter(row=>!row.revokedAt)).toHaveLength(3);
  expect((await t.action(one!,m.id,'review','pass')).status).toBe(201);
  const c=(await moderationCase(t.app.store,m.id))!;
  await t.app.store.db.prepare('UPDATE moderation_assignments SET "expiresAt"=$3 WHERE "caseId"=$1 AND "userId"=$2')
    .run(c.id,two!.id,'2000-01-01T00:00:00.000Z');
  await process();
  expect((await t.assignments(m.id)).filter(row=>!row.revokedAt)).toHaveLength(2);
  expect((await presence(returning!)).status).toBe(200);
  await process();
  const replaced=await t.assignments(m.id);
  expect(replaced).toHaveLength(4);
  expect(replaced.find(row=>row.userId===returning!.id)?.revokedAt).toBeNull();
  expect(replaced.find(row=>row.userId===two!.id)?.revokedAt).toBeTruthy();
  expect(replaced.find(row=>row.userId===one!.id)?.submittedAt).toBeTruthy();
  const other=await t.publish('NEXT-ONLINE-DRAW');
  expect((await t.assignments(other.id)).map(row=>row.userId)).toEqual([returning!.id]);
},30000);

it('keeps random invitations bounded while settlement follows cumulative stakes instead of reviewer counts',async()=>{
  const t=await setup(7),m=await t.publish(),first=await t.assignments(m.id);
  expect(first).toHaveLength(3);expect(first.some(row=>row.userId===t.author.id)).toBe(false);
  const [a,b,c]=first.map(row=>t.actor(row.userId));
  expect((await t.action(a!,m.id,'review','pass',20)).status).toBe(201);
  expect((await t.action(a!,m.id,'review','pass',2)).status).toBe(201);
  expect((await t.get(a!,`/api/moderation/messages/${m.id}`)).body).toMatchObject({canSettle:true,summary:{pass:32,reject:0,passReviewers:1}});
  for(const actor of [b!,c!])expect((await t.action(actor,m.id,'review','reject',2)).status).toBe(201);
  expect((await t.action(a!,m.id,'review-settle')).status).toBe(201);
  const current=(await moderationCase(t.app.store,m.id))!;
  expect(current).toMatchObject({stage:0,status:'approved',settlement:{finalized:true}});
  expect(summarizeReview(current,await reviewVotes(t.app.store,current.id),await reviewDeposits(t.app.store,current.id)))
    .toMatchObject({pass:32,reject:4,passReviewers:1,rejectReviewers:2});
  expect(await t.assignments(m.id)).toHaveLength(3);
  expect((await request(t.app).get(`/api/messages/${m.id}`)).text).toContain('RANDOM-REVIEW-PRIVATE');
},30000);

it('revokes only the timed-out message assignment, replaces randomly and respects the cumulative exposure cap',async()=>{
  const t=await setup(10),m=await t.publish(),first=await t.assignments(m.id),victim=t.actor(first[0]!.userId);
  await t.app.store.transaction(async()=>t.app.store.set('rules',{...await t.app.store.rules(),moderation:{...(await t.app.store.rules()).moderation!,stages:[9]}}));
  const other=await t.publish('OTHER-MESSAGE-PRIVATE');
  const current=(await moderationCase(t.app.store,m.id))!;
  await t.app.store.db.prepare('UPDATE moderation_assignments SET "expiresAt"=$3 WHERE "caseId"=$1 AND "userId"=$2').run(current.id,victim.id,'2000-01-01T00:00:00.000Z');
  expect((await t.get(victim,`/api/messages/${m.id}`)).text).toContain('RANDOM-REVIEW-PRIVATE');
  expect((await t.get(victim,`/api/moderation/messages/${m.id}`)).body).toMatchObject({canReview:true,reviewEligibility:'eligible',readableWithoutAssignment:true});
  expect((await t.get(victim,'/api/moderation/queue')).body.items.some((item:{messageId:string})=>item.messageId===m.id)).toBe(false);
  expect((await t.get(victim,`/api/moderation/messages/${other.id}`)).text).toContain('OTHER-MESSAGE-PRIVATE');
  expect((await t.action(victim,other.id,'review','pass')).status).toBe(201);
  const process=async()=>{await t.app.store.db.prepare('UPDATE moderation_cases SET "assignmentCheckAt"=0 WHERE id=$1').run(current.id);await processReviewAssignments(t.app.store);};
  await t.app.store.db.prepare('UPDATE moderation_cases SET "assignmentCheckAt"=0 WHERE id=$1').run(current.id);
  await Promise.all([processReviewAssignments(t.app.store),processReviewAssignments(t.app.store)]);
  let rows=await t.assignments(m.id);
  expect(rows).toHaveLength(4);expect(rows.find(row=>row.userId===victim.id)?.revokedAt).toBeTruthy();
  expect(rows.filter(row=>!row.revokedAt)).toHaveLength(3);
  for(let i=0;i<3;i++){
    await t.app.store.db.prepare('UPDATE moderation_assignments SET "expiresAt"=$2 WHERE "caseId"=$1 AND "submittedAt" IS NULL').run(current.id,'2000-01-01T00:00:00.000Z');
    await process();
  }
  rows=await t.assignments(m.id);expect(rows).toHaveLength(6);expect(new Set(rows.map(row=>row.userId)).size).toBe(6);
  expect(await assignmentCounts(t.app.store,current)).toEqual({assignedCount:0,exposedCount:6,exposureLimit:6});
  expect((await t.action(victim,m.id,'review','pass')).status).toBe(201);
  expect((await t.get(victim,`/api/moderation/messages/${m.id}`)).body).toMatchObject({canReview:true,readableWithoutAssignment:true});
  expect((await moderationCase(t.app.store,m.id))!.status).toBe('pending');
  expect((await t.action(t.author,m.id,'reviewer-authorize')).status).toBe(409);
},30000);

it('does not give an administrator or a historical reviewer privileged access after content is hidden',async()=>{
  const t=await setup(6),creator=t.users[1]!;
  expect((await request(t.app).put('/api/moderation/availability').set('Cookie',t.author.cookie).set('x-csrf-token',t.author.csrf).send({enabled:false})).status).toBe(200);
  await t.app.store.db.prepare('INSERT INTO moderation_reviewers VALUES($1,$2,$3)').run(t.author.id,'old-authorization',new Date().toISOString());
  const res=await t.send(creator,[{id:'body',type:'text',text:'PRIVATE-FROM-ADMIN'}],{recommendation:1});
  expect(res.status,res.text).toBe(201);
  expect((await t.get(t.author,`/api/messages/${res.body.message.id}`)).text).toContain('PRIVATE-FROM-ADMIN');
  const assigned=(await t.assignments(res.body.message.id)).slice(0,2).map(row=>t.actor(row.userId));
  for(const actor of assigned)expect((await t.action(actor,res.body.message.id,'review','reject',8)).status).toBe(201);
  expect((await t.action(assigned[0]!,res.body.message.id,'review-settle')).status).toBe(201);
  expect((await t.get(t.author,`/api/messages/${res.body.message.id}`)).text).not.toContain('PRIVATE-FROM-ADMIN');
  expect((await t.action(t.author,res.body.message.id,'review','pass')).status).toBe(403);
});

it('keeps submitted reviews, restricts rejected bodies to the author, and starts appeal with a fresh round',async()=>{
  const t=await setup(4),m=await t.publish(),rows=await t.assignments(m.id),voters=rows.slice(0,2).map(row=>t.actor(row.userId));
  for(const actor of voters)expect((await t.action(actor,m.id,'review','reject',8)).status).toBe(201);
  const c=(await moderationCase(t.app.store,m.id))!;
  await t.app.store.db.prepare('UPDATE moderation_assignments SET "expiresAt"=$2 WHERE "caseId"=$1').run(c.id,'2000-01-01T00:00:00.000Z');
  await t.app.store.db.prepare('UPDATE moderation_cases SET "assignmentCheckAt"=0 WHERE id=$1').run(c.id);await processReviewAssignments(t.app.store);
  expect((await t.assignments(m.id)).filter(row=>row.submittedAt).every(row=>!row.revokedAt)).toBe(true);
  expect((await t.action(voters[0]!,m.id,'review-settle')).status).toBe(201);
  expect((await moderationCase(t.app.store,m.id))?.settlement?.finalized).toBe(true);
  for(const actor of voters)expect((await t.get(actor,`/api/moderation/messages/${m.id}`)).body.snapshot).toBeUndefined();
  expect((await t.get(t.author,`/api/moderation/messages/${m.id}`)).text).toContain('RANDOM-REVIEW-PRIVATE');
  expect((await t.action(voters[0]!,m.id,'review-appeal')).status).toBe(403);
  const before=await t.app.store.account(t.author.id);
  expect((await t.action(t.author,m.id,'review-appeal')).status).toBe(201);
  expect((await t.app.store.account(t.author.id)).available).toBe(before.available-17);
  const appealed=(await moderationCase(t.app.store,m.id))!;
  expect(summarizeReview(appealed,await reviewVotes(t.app.store,c.id),await reviewDeposits(t.app.store,c.id))).toMatchObject({round:2,passReviewers:0,rejectReviewers:0});
  expect((await t.action(voters[0]!,m.id,'review','pass',2,1)).body.code).toBe('REVIEW_ROUND_CHANGED');
  expect((await t.get(voters[0]!,`/api/moderation/messages/${m.id}`)).body.canReview).toBe(true);
  expect((await t.action(voters[0]!,m.id,'review','pass')).status).toBe(201);
},30000);
