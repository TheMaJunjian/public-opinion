import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { replayArchive, messageDisplayDependency, reviewContextPart, type Part, type ReviewStakeItem } from '@gonglun/core';
import { cleanupTestDatabases, createTestApp, testInvitation } from './test-database.js';
import { migrateModeration } from '../../migrate/src/moderation.js';
import { Mutation } from './db.js';
import { enrollModeration } from './moderation.js';
import { moderationCase } from './moderation.js';

afterEach(cleanupTestDatabases);

it('confirms an already committed review discussion after its reading permission changes without charging again',async()=>{
  const t=await setup(),target=await t.publish();
  const body={requestId:randomUUID(),parts:[{id:'body',type:'text',text:'已发送的讨论'},reviewContextPart({messageId:target.id,revision:1})],recommendation:1};
  const send=()=>t.one.agent.post('/api/messages').set('x-csrf-token',t.one.csrf).send(body);
  const first=await send();expect(first.status,first.text).toBe(201);
  const account=await t.app.store.account(t.one.user.id),sequence=await t.app.store.latestSequence();
  await t.app.store.db.prepare("UPDATE moderation_cases SET status='rejected' WHERE \"messageId\"=$1").run(target.id);
  const repeated=await send();expect(repeated.status,repeated.text).toBe(201);
  expect(repeated.body.message.id).toBe(first.body.message.id);
  expect(await t.app.store.account(t.one.user.id)).toEqual(account);
  expect(await t.app.store.latestSequence()).toBe(sequence);
});

it('keeps corrected review reasons, replies, citations and organizations in the same review discussion without changing the vote',async()=>{
  const t=await setup(),target=await t.publish('被审核正文');
  const response=await t.action(t.one,'review',target.id,{verdict:'pass'},2,'审核理有');
  expect(response.status,response.text).toBe(201);
  const review=response.body.message,original=await t.app.store.message(review.id);
  const scope={messageId:target.id,revision:1};
  const command=async(body:Record<string,unknown>,path='/relations')=>{
    const result=await t.one.agent.post(`/api/ui${path}`).set('x-csrf-token',t.one.csrf).set('x-request-id',randomUUID())
      .send({recommendation:1,reviewContext:scope,...body});
    expect(result.status,result.text).toBe(201);return result.body;
  };
  const correction=await command({relationType:'CORRECT',targetRefs:[{kind:'text-fragment',messageId:review.id,
    reference:{messageId:review.id,revision:1,partId:'reason',path:['text']}}],payload:{correctionContent:'审核理由',correctionKind:'TEXT'}});
  const reply=await command({content:'对审核理由的回复'},'/messages');
  const relation=await command({relationType:'REPLY',sourceMessageId:reply.id,targetRefs:[{kind:'message',messageId:review.id}]});
  const citation=await command({relationType:'REFERENCE',sourceMessageId:reply.id,targetRefs:[{kind:'text-fragment',messageId:review.id,
    reference:{messageId:review.id,revision:1,partId:'reason',range:{start:0,end:2}}}]});
  const group=await command({relationType:'CLASSIFY',targetRefs:[review,reply].map(message=>({kind:'message',messageId:message.id})),payload:{title:'审核理由整理'}});
  const detail=await t.one.agent.get(`/api/moderation/messages/${target.id}`);
  expect(detail.status,detail.text).toBe(200);
  const ids=detail.body.records.map((record:any)=>record.id);
  expect(ids).toEqual(expect.arrayContaining([review.id,correction.id,reply.id,relation.id,citation.id,group.id]));
  expect(new Set(ids).size).toBe(ids.length);
  expect(detail.body.stakes).toEqual([
    expect.objectContaining({sourceMessageId:review.id,side:'PRO',amount:2,kind:'wager',round:1,user:expect.objectContaining({id:t.one.user.id})}),
    expect.objectContaining({sourceMessageId:target.id,side:'PRO',amount:10,kind:'self',round:1,user:expect.objectContaining({id:t.author.user.id})}),
  ]);
  expect(detail.body.summary).toMatchObject({pass:12,reject:0,reviewerCount:1,passReviewers:1});
  expect(await t.app.store.message(review.id)).toEqual(original);
  expect((await t.app.store.db.prepare('SELECT "parentId" FROM memberships WHERE "memberId"=$1').get(review.id))?.parentId).toBe(group.id);
  expect((await t.app.store.db.prepare('SELECT "parentId" FROM memberships WHERE "memberId"=$1').get(reply.id))?.parentId).toBe(group.id);
  const wrong=await t.send(t.one,[{id:'relation',type:'relation',relation:'correct',roles:{target:[{id:'target',reference:{messageId:review.id,revision:1,partId:'data'}}]}},
    {id:'body',type:'text',text:'修改审核判断'}],{recommendation:1});
  expect(wrong.status).toBe(409);expect(wrong.text).toContain('只能更正理由文字');
  const unrelated=await t.publish('另一条被审核消息');
  const move=await t.one.agent.post('/api/ui/relations').set('x-csrf-token',t.one.csrf).set('x-request-id',randomUUID())
    .send({relationType:'CLASSIFY',reviewContext:{messageId:unrelated.id,revision:1},recommendation:1,
      targetRefs:[{kind:'message',messageId:review.id}],payload:{title:'跨审核分类'}});
  expect(move.status).toBe(400);expect(move.text).toContain('同一消息版本');
  await t.app.store.db.prepare("UPDATE moderation_cases SET status='rejected' WHERE \"messageId\"=$1").run(reply.id);
  const restricted=await t.observer.agent.get(`/api/moderation/messages/${target.id}`);
  const hidden=restricted.body.records.find((record:any)=>record.id===reply.id);
  expect(hidden).toMatchObject({restricted:true});
  expect(hidden.parts).toEqual(expect.arrayContaining([expect.objectContaining({relation:'review-context'})]));
  expect(JSON.stringify(restricted.body.records)).not.toContain('对审核理由的回复');
  await conserve(t.app);
});

it('loads legacy discussion of review reasons without including ordinary discussion of the reviewed original',async()=>{
  const t=await setup(),target=await t.publish();
  const vote=await t.action(t.one,'review',target.id,{verdict:'pass'},2,'审核意见');
  let sourceId='',relationId='';
  await t.app.store.transaction(async()=>{
    const tx=new Mutation(t.app.store);
    const source=await tx.create(t.one.user.id,[{id:'body',type:'text',text:'历史回复'}]);sourceId=source.id;
    const relation=await tx.create(t.one.user.id,[{id:'relation',type:'relation',relation:'reply',roles:{source:[{id:'s',reference:{messageId:source.id}}],target:[{id:'t',reference:{messageId:vote.body.message.id}}]}}]);relationId=relation.id;
    await tx.create(t.one.user.id,[{id:'body',type:'text',text:'原消息的普通讨论不属于审核理由'},
      {id:'relation',type:'relation',relation:'reply',roles:{target:[{id:'t',reference:{messageId:target.id}}]}}]);
    await tx.commit();
  });
  const detail=await t.one.agent.get(`/api/moderation/messages/${target.id}`);
  expect(detail.status,detail.text).toBe(200);
  expect(detail.body.records.map((record:any)=>record.id)).toEqual(expect.arrayContaining([sourceId,relationId]));
  expect(JSON.stringify(detail.body.records)).not.toContain('原消息的普通讨论不属于审核理由');
});
it('uses ordinary text operations on review messages as both source and target without changing the review vote',async()=>{
  const t=await setup(),target=await t.publish();
  const response=await t.action(t.one,'review',target.id,{verdict:'pass'},2,'审核消息正文');
  expect(response.status,response.text).toBe(201);
  const review=response.body.message,scope={messageId:target.id,revision:1},created:string[]=[];
  const command=async(body:Record<string,unknown>,path='/relations')=>{
    const result=await t.two.agent.post(`/api/ui${path}`).set('x-csrf-token',t.two.csrf).set('x-request-id',randomUUID())
      .send({recommendation:1,reviewContext:scope,...body});
    expect(result.status,`${JSON.stringify(body)}: ${result.text}`).toBe(201);
    created.push(result.body.id);return result.body;
  };
  const discussion=await command({content:'审核临时分类中的普通文本'},'/messages');
  for(const relationType of ['REPLY','REFERENCE','ANNOTATION'])for(const [source,subject] of [[review,discussion],[discussion,review]]){
    await command({relationType,sourceMessageId:source.id,targetRefs:[{kind:'message',messageId:subject.id}]});
  }
  for(const [relationType,payload] of [
    ['TAG',{label:'需要核实'}],['RECOMMEND',{subType:'IMPORTANT'}],['ARCHIVE',{subType:'LOWVALUE'}],
    ['ATTENTION',{subType:'YES'}],['ATTENTION',{subType:'NO'}],['BLOCK',{subType:'YES'}],['BLOCK',{subType:'NO'}],
    ['NOTIFY',{}],['CORRECT',{correctionKind:'WIDTH',correctionWidth:640}],
  ] as const)await command({relationType,targetRefs:[{kind:'message',messageId:review.id}],payload});
  const detail=await t.two.agent.get(`/api/moderation/messages/${target.id}`);
  expect(detail.status,detail.text).toBe(200);
  expect(detail.body.records.map((record:any)=>record.id)).toEqual(expect.arrayContaining(created));
  expect(detail.body.summary).toMatchObject({pass:12,reject:0,reviewerCount:1,passReviewers:1});
  expect(await t.app.store.message(review.id)).toEqual(review);
  await conserve(t.app);
});
it.each(['CLASSIFY','SUMMARY','MERGE','ARRANGE'])('organizes review messages with the ordinary %s operation',async relationType=>{
  const t=await setup(),target=await t.publish();
  const vote=await t.action(t.one,'review',target.id,{verdict:'pass'},2,'可以整理的审核消息');
  expect(vote.status,vote.text).toBe(201);
  const review=vote.body.message,scope={messageId:target.id,revision:1};
  const response=await t.one.agent.post('/api/ui/relations').set('x-csrf-token',t.one.csrf).set('x-request-id',randomUUID())
    .send({relationType,targetRefs:[{kind:'message',messageId:review.id}],payload:{title:'审核消息整理'},recommendation:1,reviewContext:scope});
  expect(response.status,response.text).toBe(201);
  expect((await t.app.store.db.prepare('SELECT "parentId" FROM memberships WHERE "memberId"=$1').get(review.id))?.parentId).toBe(response.body.id);
  const detail=await t.one.agent.get(`/api/moderation/messages/${target.id}`);
  expect(detail.body.records.map((record:any)=>record.id)).toEqual(expect.arrayContaining([review.id,response.body.id]));
  expect(detail.body.summary).toMatchObject({pass:12,reject:0,reviewerCount:1});
  expect(await t.app.store.message(review.id)).toEqual(review);
  await conserve(t.app);
});
async function setup(stageSize=3){
  const app=await createTestApp({moderation:true});
  // Invitation sizes do not impose settlement thresholds.
  await app.store.transaction(async()=>app.store.set('rules',{...await app.store.rules(),moderation:{...(await app.store.rules()).moderation!,stages:[stageSize]}}));
  const users=[];
  for(const name of ['author','reviewer-one','reviewer-two','observer','reviewer-three']){
    const agent=request.agent(app),res=await agent.post('/api/register').send({name,password:'password',inviteCode:await testInvitation(app)});
    expect(res.status,res.text).toBe(201);users.push({agent,user:res.body.user,csrf:res.body.csrf});
  }
  const [author,one,two,observer,three]=users as [typeof users[number],typeof users[number],typeof users[number],typeof users[number],typeof users[number]];
  const send=async(actor:typeof author,parts:Part[],amounts:Record<string,unknown>={})=>actor.agent.post('/api/messages').set('x-csrf-token',actor.csrf).send({requestId:randomUUID(),parts,...amounts});
  const action=async(actor:typeof author,name:string,target?:string,data:Record<string,any>={},reviewWager?:number,reason='')=>send(actor,[
    ...(reason?[{id:'reason',type:'text' as const,text:reason}]:[]),
    {id:'relation',type:'relation',relation:name,roles:target?{target:[{id:'target',reference:{messageId:target}}]}:{}},
    {id:'data',type:'data',value:data}],{reviewWager});
  expect((await observer.agent.put('/api/moderation/availability').set('x-csrf-token',observer.csrf).send({enabled:false})).status).toBe(200);
  const publish=async(secret='待审正文 SECRET-CONTENT')=>{
    const res=await send(author,[{id:'body',type:'text',text:secret}],{recommendation:1});expect(res.status,res.text).toBe(201);return res.body.message;
  };
  return {app,author,one,two,observer,three,send,action,publish};
}
async function assertFinalized(t:Awaited<ReturnType<typeof setup>>,messageId:string){
  expect((await moderationCase(t.app.store,messageId))?.settlement?.finalized).toBe(true);
}
it('returns only the current viewer latest vote and resets it for a new review round',async()=>{
  const t=await setup(),m=await t.publish();
  const first=await t.action(t.one,'review',m.id,{verdict:'reject'},2);
  const other=await t.action(t.two,'review',m.id,{verdict:'pass'},2);
  const detail=async(actor:typeof t.one)=>(await actor.agent.get(`/api/moderation/messages/${m.id}`)).body;
  expect((await detail(t.one)).target.moderation.viewerVote).toEqual({messageId:first.body.message.id,verdict:'reject'});
  expect((await detail(t.two)).summary.viewerVote).toEqual({messageId:other.body.message.id,verdict:'pass'});
  expect((await detail(t.observer)).target.moderation.viewerVote).toBeUndefined();
  const latest=await t.action(t.one,'review',m.id,{verdict:'pass'},2);
  expect((await detail(t.one)).summary.viewerVote).toEqual({messageId:latest.body.message.id,verdict:'pass'});
  expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);
  expect((await t.action(t.two,'review-appeal',m.id,{},undefined,'新一轮审核')).status).toBe(201);
  expect((await detail(t.one)).target.moderation.viewerVote).toBeUndefined();
});
it('releases a legacy pending settlement immediately and never pays it twice',async()=>{
  const t=await setup(),m=await t.publish();
  const vote=await t.action(t.one,'review',m.id,{verdict:'pass'},2);
  const pending={verdict:'pass',payouts:[],fund:0,finalized:false,voteIds:[vote.body.message.id],messageId:vote.body.message.id};
  await t.app.store.db.prepare(`UPDATE moderation_cases SET status='approved',"releaseAt"=$2,settlement=$3::jsonb WHERE "messageId"=$1`)
    .run(m.id,new Date(Date.now()+86_400_000).toISOString(),JSON.stringify(pending));
  expect((await t.action(t.one,'review-finalize',m.id)).status).toBe(201);
  await assertFinalized(t,m.id);
  expect((await t.app.store.db.prepare(`SELECT amount FROM ledger WHERE "userId"=$1 AND reason='审核押注结算'`).get(t.one.user.id))?.amount).toBe(2);
  const account=await t.app.store.account(t.one.user.id);
  expect((await t.action(t.one,'review-finalize',m.id)).status).toBe(409);
  expect(await t.app.store.account(t.one.user.id)).toEqual(account);
  await conserve(t.app);
});
async function conserve(app:Awaited<ReturnType<typeof createTestApp>>){
  const {n}=await app.store.db.prepare('SELECT SUM(available+locked) AS n FROM accounts').get() as {n:number};
  expect(Number(n)+await app.store.setting<number>('operating')).toBe(await app.store.setting('minted'));
  const changes=(await app.store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(r=>JSON.parse(String(r.body)));
  expect(()=>replayArchive({format:'gonglun-2',changes} as any)).not.toThrow();
}
it('settles with one reviewer and lets a funded minority overturn a larger number of reviewers',async()=>{
  const t=await setup(),m=await t.publish();
  expect((await t.action(t.one,'review',m.id,{verdict:'pass'},2)).status).toBe(201);
  expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);
  expect((await moderationCase(t.app.store,m.id))?.status).toBe('approved');
  expect((await t.action(t.two,'review',m.id,{verdict:'pass'},2)).status).toBe(409);
  expect((await t.action(t.three,'review-appeal',m.id,{},undefined,'重新审核')).status).toBe(201);
  expect((await t.action(t.two,'review',m.id,{verdict:'pass'},2)).status).toBe(201);
  expect((await t.action(t.three,'review',m.id,{verdict:'reject'},20)).status).toBe(201);
  const detail=(await t.three.agent.get(`/api/moderation/messages/${m.id}`)).body;
  expect(detail).toMatchObject({canSettle:true,summary:{pass:14,reject:30,passReviewers:1,rejectReviewers:1,releaseAt:null}});
  expect((await moderationCase(t.app.store,m.id))?.stage).toBe(0);
  expect((await t.action(t.three,'review-settle',m.id)).status).toBe(201);
  expect((await moderationCase(t.app.store,m.id))?.status).toBe('rejected');
  await assertFinalized(t,m.id);await conserve(t.app);
});

it('settles equal weighted stakes as UNKNOWN, refunds both principals and allows an appeal on either side',async()=>{
  const t=await setup(),m=await t.publish();
  expect((await t.action(t.one,'review',m.id,{verdict:'reject'},10)).status).toBe(201);
  expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);
  expect((await moderationCase(t.app.store,m.id))).toMatchObject({status:'unknown',settlement:{verdict:'unknown',finalized:true}});
  expect((await request(t.app).get(`/api/messages/${m.id}`)).text).toContain('SECRET-CONTENT');
  await assertFinalized(t,m.id);
  const payouts=(await moderationCase(t.app.store,m.id))!.settlement!.payouts.filter(p=>p.kind==='wager');
  expect(new Map(payouts.map(p=>[p.userId,p.amount]))).toEqual(new Map([[t.author.user.id,10],[t.one.user.id,10]]));
  const detail=(await t.observer.agent.get(`/api/moderation/messages/${m.id}`)).body;
  expect(detail).toMatchObject({canReview:false,canAppeal:true,canSettle:false,summary:{status:'unknown',finalized:true}});
  expect(detail.appealVerdict).toBeUndefined();
  expect((await t.action(t.observer,'review-appeal',m.id,{verdict:'reject'},undefined,'重新审核未定结论')).status).toBe(201);
  expect((await t.author.agent.get(`/api/moderation/messages/${m.id}`)).body.summary).toMatchObject({round:2,pass:10,reject:20,selfReject:10});
  await conserve(t.app);
});

it('lets the author settle their own publication self stake without an assignment or extra review',async()=>{
  const t=await setup(),m=await t.publish();
  expect((await t.author.agent.get(`/api/moderation/messages/${m.id}`)).body).toMatchObject({canSettle:true,summary:{pass:10,reviewerCount:0}});
  expect((await t.observer.agent.get(`/api/moderation/messages/${m.id}`)).body.canSettle).toBe(false);
  expect((await t.action(t.observer,'review-settle',m.id)).status).toBe(403);
  const before=await t.app.store.account(t.author.user.id);
  const settled=await t.action(t.author,'review-settle',m.id);
  expect(settled.status,settled.text).toBe(201);
  await assertFinalized(t,m.id);
  expect((await t.author.agent.get(`/api/moderation/messages/${m.id}`)).body).toMatchObject({canSettle:false,summary:{status:'approved',finalized:true,reviewerCount:0}});
  const after=await t.app.store.account(t.author.user.id);
  expect(after.locked-before.locked).toBe(-16);
  expect(after.available-before.available).toBe(15); // 16 returned, minus the settlement protocol fee.
  expect((await t.action(t.author,'review-settle',m.id)).status).toBe(409);
  expect(await t.app.store.account(t.author.user.id)).toEqual(after);
  await conserve(t.app);
});

it('counts publication self stakes as pass capital without a reviewer vote or reward and shares winning proceeds',async()=>{
  const t=await setup(),m=await t.publish();
  const initial=await t.author.agent.get(`/api/moderation/messages/${m.id}`);
  expect(initial.body.summary).toMatchObject({pass:10,reject:0,selfPass:10,selfReject:0,reviewerCount:0,passReviewers:0,rejectReviewers:0,rewardCount:0});
  expect(initial.body.canReview).toBe(true);expect(initial.body.canSettle).toBe(true);expect(initial.body.reviewEligibility).toBe('eligible');
  expect(initial.body.target).toMatchObject({id:m.id,revision:1,content:expect.stringContaining('SECRET-CONTENT'),moderation:{selfPass:10}});
  expect(initial.body.stakes).toEqual([expect.objectContaining({sourceMessageId:m.id,revision:1,kind:'self',side:'PRO',amount:10,round:1,
    user:expect.objectContaining({id:t.author.user.id,username:'author'})})]);
  const observer=await t.observer.agent.get(`/api/moderation/messages/${m.id}`);
  expect(observer.body).toMatchObject({canReview:true,reviewEligibility:'eligible',readableWithoutAssignment:true,target:{id:m.id,content:expect.stringContaining('SECRET-CONTENT')}});
  expect((await request(t.app).get(`/api/moderation/messages/${m.id}`)).body).toMatchObject({canReview:false,reviewEligibility:'login-required',target:{id:m.id,content:expect.stringContaining('SECRET-CONTENT')}});
  expect((await t.one.agent.get(`/api/moderation/messages/${m.id}`)).body).toMatchObject({canReview:true,reviewEligibility:'eligible'});
  expect((await t.action(t.one,'review',m.id,{verdict:'pass'},2)).status).toBe(201);
  expect((await t.one.agent.get(`/api/moderation/messages/${m.id}`)).body.canSettle).toBe(true);
  expect((await t.action(t.two,'review',m.id,{verdict:'pass'},2)).status).toBe(201);
  expect((await t.action(t.three,'review',m.id,{verdict:'reject'},7)).status).toBe(201);
  const funded=(await t.author.agent.get(`/api/moderation/messages/${m.id}`)).body,summary=funded.summary;
  expect(summary).toMatchObject({pass:14,reject:7,selfPass:10,selfReject:0,reviewerCount:3,passReviewers:2,rejectReviewers:1});
  expect(funded.stakes).toHaveLength(4);
  expect(funded.stakes.map((stake:ReviewStakeItem)=>[stake.side,stake.amount,stake.user.id])).toEqual([
    ['CON',7,t.three.user.id],['PRO',2,t.two.user.id],['PRO',2,t.one.user.id],['PRO',10,t.author.user.id],
  ]);
  const before=await t.app.store.account(t.author.user.id);
  expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);
  await assertFinalized(t,m.id);
  expect((await t.author.agent.get(`/api/moderation/messages/${m.id}`)).body.stakes).toEqual(funded.stakes);
  expect((await t.one.agent.get(`/api/moderation/messages/${m.id}`)).body).toMatchObject({canReview:false,reviewEligibility:'closed'});
  expect((await t.app.store.account(t.author.user.id)).available-before.available).toBe(15);
  const payouts=await t.app.store.db.prepare(`SELECT "userId",amount FROM ledger WHERE reason='审核押注结算'`).all<{userId:string;amount:number}>();
  expect(new Map(payouts.map(p=>[p.userId,p.amount]))).toEqual(new Map([[t.author.user.id,15],[t.one.user.id,3],[t.two.user.id,3]]));
  expect(await t.app.store.db.prepare(`SELECT 1 FROM ledger WHERE "userId"=$1 AND reason='审核参与报酬'`).get(t.author.user.id)).toBeUndefined();
  expect((await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM moderation_votes').get())?.n).toBe(3);
  await conserve(t.app);
});

it('lets any reader including the author submit an explicit review, while self stakes alone still cast no vote',async()=>{
  const t=await setup(),m=await t.publish();
  for(const actor of [t.observer,t.author]){
    const access=await actor.agent.get(`/api/moderation/messages/${m.id}`);
    expect(access.body).toMatchObject({canReview:true,reviewEligibility:'eligible',assignment:null});
    expect((await t.action(actor,'review',m.id,{verdict:'pass'},2)).status).toBe(201);
  }
  for(const actor of [t.one,t.two])expect((await t.action(actor,'review',m.id,{verdict:'reject'},2)).status).toBe(201);
  const tied=(await t.observer.agent.get(`/api/moderation/messages/${m.id}`)).body;
  expect(tied.summary).toMatchObject({passReviewers:2,rejectReviewers:2,selfPass:10,pass:14,reject:4});
  expect(tied.summary.requiredMajority).toBeUndefined();
  expect(tied.canSettle).toBe(true);
  expect((await t.action(t.three,'review',m.id,{verdict:'pass'},2)).status).toBe(201);
  expect((await t.action(t.observer,'review-settle',m.id)).status).toBe(201);
  expect((await t.observer.agent.get('/api/moderation/queue')).body.items.some((item:{messageId:string})=>item.messageId===m.id)).toBe(false);
  await conserve(t.app);
});

it('ends voluntary reviewer access immediately after rejection settlement',async()=>{
  const t=await setup(),m=await t.publish();
  for(const actor of [t.observer,t.one])expect((await t.action(actor,'review',m.id,{verdict:'reject'},8)).status).toBe(201);
  expect((await t.action(t.observer,'review-settle',m.id)).status).toBe(201);
  const access=await t.observer.agent.get(`/api/moderation/messages/${m.id}`);
  expect(access.body).toMatchObject({canReview:false,assignment:null,restricted:true,readableWithoutAssignment:false,target:{content:'',restricted:true}});
  const hidden=await request(t.app).get(`/api/moderation/messages/${m.id}`);
  expect(hidden.text).not.toContain('SECRET-CONTENT');expect(hidden.body.stakes).toEqual([]);
  expect((await t.action(t.observer,'review',m.id,{verdict:'pass'},8)).status).toBe(403);
  expect((await t.author.agent.get(`/api/moderation/messages/${m.id}`)).body.target.content).toContain('SECRET-CONTENT');
  await conserve(t.app);
});

it('does not give a zero self stake any winning proceeds or rounding remainder',async()=>{
  const t=await setup();
  await t.app.store.transaction(async()=>{
    const rules=await t.app.store.rules();await t.app.store.set('rules',{...rules,moderation:{...rules.moderation!,deposit:0}});
  });
  const m=await t.publish();
  expect((await t.author.agent.get(`/api/moderation/messages/${m.id}`)).body.stakes).toEqual([]);
  for(const actor of [t.one,t.two])expect((await t.action(actor,'review',m.id,{verdict:'pass'},2)).status).toBe(201);
  expect((await t.action(t.three,'review',m.id,{verdict:'reject'},3)).status).toBe(201);
  expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);await assertFinalized(t,m.id);
  const payouts=(await moderationCase(t.app.store,m.id))!.settlement!.payouts.filter(p=>p.kind==='wager');
  expect(payouts.map(p=>p.userId).sort()).toEqual([t.one.user.id,t.two.user.id].sort());
  expect(payouts.reduce((sum,p)=>sum+p.amount,0)).toBe(7);
  expect(payouts.map(p=>p.amount).sort()).toEqual([3,4]);
  await conserve(t.app);
});

it('stakes an appeal against an approved conclusion on reject, reverses old payments, and preserves separate participation rewards',async()=>{
  const t=await setup(),m=await t.publish();
  for(const actor of [t.one,t.two])expect((await t.action(actor,'review',m.id,{verdict:'pass'},2)).status).toBe(201);
  expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);await assertFinalized(t,m.id);
  const c=(await moderationCase(t.app.store,m.id))!,before=await t.app.store.account(t.observer.user.id);
  expect((await t.observer.agent.get(`/api/moderation/messages/${m.id}`)).body.appealVerdict).toBe('reject');
  expect((await t.action(t.observer,'review-appeal',m.id,{verdict:'pass'},undefined,'错误立场')).status).toBe(409);
  expect(await t.app.store.account(t.observer.user.id)).toEqual(before);
  expect(await moderationCase(t.app.store,m.id)).toEqual(c);
  const appeal=await t.action(t.observer,'review-appeal',m.id,{verdict:'reject'},undefined,'此内容不应通过');
  expect(appeal.status,appeal.text).toBe(201);
  expect((await t.app.store.message(appeal.body.message.id)).parts.find(p=>p.type==='data')?.value).toMatchObject({selfStakeVerdict:'reject',verdict:'reject'});
  expect(await t.app.store.db.prepare('SELECT "payerId",verdict,amount FROM moderation_deposits WHERE "caseId"=$1 ORDER BY round').all(c.id))
    .toEqual([{payerId:t.author.user.id,verdict:'pass',amount:10},{payerId:t.observer.user.id,verdict:'reject',amount:10}]);
  const reopened=(await t.author.agent.get(`/api/moderation/messages/${m.id}`)).body;
  expect(reopened.summary).toMatchObject({pass:14,reject:10,selfPass:10,selfReject:10,reviewerCount:0,passReviewers:0,rejectReviewers:0,rewardCount:0});
  expect(reopened.stakes).toHaveLength(4);
  expect(reopened.stakes[0]).toMatchObject({sourceMessageId:appeal.body.message.id,kind:'self',round:2,side:'CON',amount:10});
  for(const [side,total] of [['PRO',reopened.summary.pass],['CON',reopened.summary.reject]]){
    expect(reopened.stakes.filter((stake:ReviewStakeItem)=>stake.side===side).reduce((sum:number,stake:ReviewStakeItem)=>sum+stake.amount,0)).toBe(total);
  }
  for(const actor of [t.one,t.two])expect((await t.action(actor,'review',m.id,{verdict:'reject'},8)).status).toBe(201);
  expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);await assertFinalized(t,m.id);
  const final=(await moderationCase(t.app.store,m.id))!.settlement!;
  const winningPayments=final.payouts.filter(p=>p.kind==='wager');
  expect(winningPayments.map(p=>p.userId).sort()).toEqual([t.observer.user.id,t.one.user.id,t.two.user.id].sort());
  expect(winningPayments.reduce((sum,p)=>sum+p.amount,0)).toBe(40);
  const appealPayout=winningPayments.find(p=>p.userId===t.observer.user.id)!.amount;
  expect(appealPayout).toBeGreaterThan(10);
  expect((await t.app.store.account(t.observer.user.id)).available).toBe(before.available-17+appealPayout+2);
  expect(await t.app.store.db.prepare(`SELECT 1 FROM ledger WHERE "userId"=$1 AND reason='审核参与报酬'`).get(t.observer.user.id)).toBeUndefined();
  await conserve(t.app);
});

it('pays only the first three distinct participants, including a losing reviewer, while later reviewers earn wrong-side wagers',async()=>{
  const t=await setup(5);
  await t.observer.agent.put('/api/moderation/availability').set('x-csrf-token',t.observer.csrf).send({enabled:true});
  const m=await t.publish(),before=await t.app.store.account(t.one.user.id);
  for(const actor of [t.one,t.one])expect((await t.action(actor,'review',m.id,{verdict:'reject'},8)).status).toBe(201);
  const repeated=(await t.author.agent.get(`/api/moderation/messages/${m.id}`)).body.stakes as ReviewStakeItem[];
  expect(repeated).toHaveLength(3);
  expect(repeated.filter(stake=>stake.user.id===t.one.user.id)).toEqual([
    expect.objectContaining({side:'CON',amount:8}),expect.objectContaining({side:'CON',amount:8}),
  ]);
  expect(new Set(repeated.map(stake=>stake.id)).size).toBe(3);
  for(const actor of [t.two,t.three,t.observer])expect((await t.action(actor,'review',m.id,{verdict:'pass'},3)).status).toBe(201);
  expect((await t.action(t.two,'review-settle',m.id)).status).toBe(201);await assertFinalized(t,m.id);
  const rewards=await t.app.store.db.prepare(`SELECT "userId",SUM(amount) AS amount FROM ledger WHERE reason='审核参与报酬' GROUP BY "userId"`).all<{userId:string;amount:number}>();
  expect(new Map(rewards.map(r=>[r.userId,Number(r.amount)]))).toEqual(new Map([t.one,t.two,t.three].map(actor=>[actor.user.id,2])));
  expect((await t.app.store.account(t.one.user.id)).available).toBe(before.available-16);
  expect(Number((await t.app.store.db.prepare(`SELECT SUM(amount) AS amount FROM ledger WHERE "userId"=$1 AND reason='审核押注结算'`).get(t.observer.user.id))?.amount)).toBeGreaterThan(3);
  await conserve(t.app);
});

it('settles the initial and all appeal self stakes after two reversals, retaining each round’s earned rewards',async()=>{
  const t=await setup(),before=await t.app.store.account(t.author.user.id),m=await t.publish();
  for(let round=1;round<=3;round++){
    for(const actor of [t.one,t.two])expect((await t.action(actor,'review',m.id,{verdict:round===3?'pass':'reject'},round===3?2:8)).status).toBe(201);
    expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);await assertFinalized(t,m.id);await conserve(t.app);
    if(round<3){
      const balance=await t.app.store.account(t.author.user.id);
      const input:Part[]=[{id:'reason',type:'text',text:'补充证据申请复核'},
        {id:'appeal',type:'relation',relation:'review-appeal',roles:{target:[{id:'target',reference:{messageId:m.id}}]}}];
      const requestId=randomUUID();
      const replies=await Promise.all([t.send(t.author,input,{requestId}),t.send(t.author,input,{requestId})]);
      for(const reply of replies)expect(reply.status,reply.text).toBe(201);
      expect(replies[0]!.body.message.id).toBe(replies[1]!.body.message.id);
      expect((await t.app.store.account(t.author.user.id)).available).toBe(balance.available-17);
      expect((await moderationCase(t.app.store,m.id))?.deposit).toBe((round+1)*10);
    }
  }
  const authorPayout=Number((await t.app.store.db.prepare(`SELECT SUM(amount) AS amount FROM ledger WHERE reason='审核押注结算' AND "userId"=$1`).get(t.author.user.id))?.amount);
  expect(authorPayout).toBeGreaterThan(30);
  expect((await t.app.store.account(t.author.user.id)).available).toBe(before.available-46+authorPayout);
  expect((await t.app.store.account(t.author.user.id)).locked).toBe(before.locked+1);
  expect((await t.app.store.db.prepare(`SELECT COUNT(*) AS n FROM moderation_deposits WHERE "payerId"=$1 AND verdict='pass'`).get(t.author.user.id))?.n).toBe(3);
  expect(Number((await t.app.store.db.prepare(`SELECT SUM(amount) AS amount FROM ledger WHERE reason='审核参与报酬'`).get())?.amount)).toBe(12);
  expect((await t.app.store.db.prepare(`SELECT COUNT(*) AS n FROM moderation_round_fees WHERE paid`).get())?.n).toBe(3);
  await conserve(t.app);
},30000);

it('distributes immediately, rejects additional votes until appeal, and keeps failed writes atomic',async()=>{
  const t=await setup(),m=await t.publish();
  const initial=await t.app.store.account(t.one.user.id);
  expect((await t.action(t.one,'review',m.id,{verdict:'pass'},1)).status).toBe(400);
  expect(await t.app.store.account(t.one.user.id)).toEqual(initial);
  for(const actor of [t.one,t.two])await t.action(actor,'review',m.id,{verdict:'pass'},2);
  await t.action(t.one,'review-settle',m.id);
  expect((await moderationCase(t.app.store,m.id))!.settlement?.finalized).toBe(true);
  const balance=await t.app.store.account(t.three.user.id);
  expect((await t.action(t.three,'review',m.id,{verdict:'reject'},2)).status).toBe(409);
  expect(await t.app.store.account(t.three.user.id)).toEqual(balance);
  expect((await t.action(t.three,'review-appeal',m.id,{},undefined,'申请重新审核')).status).toBe(201);
  expect((await t.action(t.two,'review',m.id,{verdict:'reject'},14)).status).toBe(201);
  expect((await moderationCase(t.app.store,m.id))!.settlement).toBeNull();
  await t.action(t.two,'review-settle',m.id);
  expect((await t.observer.agent.get(`/api/messages/${m.id}`)).text).not.toContain('SECRET-CONTENT');
  expect((await t.one.agent.get(`/api/moderation/messages/${m.id}`)).body.canReview).toBe(false);
  expect((await t.action(t.two,'review',m.id,{verdict:'pass'},4)).status).toBe(403);
  await assertFinalized(t,m.id);
  await conserve(t.app);
});

it('rolls back an unaffordable appeal without closing the old reward budget or adding a deposit',async()=>{
  const t=await setup(),m=await t.publish();
  for(const actor of [t.one,t.two])await t.action(actor,'review',m.id,{verdict:'reject'},8);
  await t.action(t.one,'review-settle',m.id);
  const spend=(await t.app.store.account(t.author.user.id)).available-17;
  expect((await t.send(t.author,[{id:'body',type:'text',text:'用完当前可用点'}],{recommendation:spend})).status).toBe(201);
  const before=await t.app.store.account(t.author.user.id),c=await moderationCase(t.app.store,m.id);
  expect((await t.action(t.author,'review-appeal',m.id,{},undefined,'没有可用点')).status).toBe(400);
  expect(await t.app.store.account(t.author.user.id)).toEqual(before);
  expect(await moderationCase(t.app.store,m.id)).toEqual(c);
  expect(await t.app.store.db.prepare('SELECT paid FROM moderation_round_fees WHERE "caseId"=$1').get(c!.id)).toEqual({paid:true});
  await conserve(t.app);
});

it('publishes pending content, then hides a final rejection across APIs, exports, history and search',async()=>{
  const t=await setup(),m=await t.publish(),secret='SECRET-CONTENT';
  for(const path of [`/api/messages/${m.id}`,'/api/ui/snapshot','/api/ui/export','/api/messages?q=SECRET'])expect((await t.observer.agent.get(path)).text,path).toContain(secret);
  expect((await t.observer.agent.get(`/api/moderation/messages/${m.id}`)).body.canReview).toBe(true);
  for(const actor of [t.one,t.two])expect((await t.action(actor,'review',m.id,{verdict:'reject'},8)).status).toBe(201);
  expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);
  expect((await t.one.agent.get(`/api/moderation/messages/${m.id}`)).text).not.toContain(secret);
  await assertFinalized(t,m.id);
  for(const path of [`/api/messages/${m.id}`,`/api/messages/${m.id}/history`,'/api/messages','/api/changes','/api/export','/api/ui/snapshot','/api/ui/snapshot?format=compact-v1','/api/ui/export',`/api/ui/message-context?id=${m.id}`]){
    const res=await t.observer.agent.get(path);expect(res.status,res.text).toBe(200);expect(res.text,path).not.toContain(secret);
  }
  expect((await t.observer.agent.get('/api/messages?q=SECRET')).body.messages).toEqual([]);
  const snapshot=(await t.observer.agent.get('/api/ui/snapshot')).body;
  const reviewRecord=snapshot.messages.find((message:any)=>message.parts.some((part:any)=>part.relation==='review-record'));
  expect(reviewRecord).toBeTruthy();expect(reviewRecord.restricted).toBe(true);
  expect(messageDisplayDependency(reviewRecord)).toEqual([{messageId:m.id,revision:1}]);
  expect(JSON.stringify(reviewRecord)).not.toContain(secret);
  const overview=(await t.observer.agent.post('/api/ui/snapshot/query').send({mode:'window',parent:'root',limit:1})).body;
  expect(overview.messages[0].id).toBe(m.id);
  expect(snapshot.stakes[m.id]).toMatchObject({messageId:m.id,restricted:true,stakes:[],counts:{pro:1,con:0},countsByType:{TRUTH:{pro:0,con:0},VALUE:{pro:1,con:0}}});
  expect((await t.observer.agent.get(`/api/ui/messages/${m.id}/stakes`)).body.stakes).toEqual([]);
  expect((await t.author.agent.get(`/api/messages/${m.id}`)).text).toContain(secret);
  expect((await t.one.agent.get(`/api/moderation/messages/${m.id}`)).text).not.toContain(secret);
  const hidden=await t.observer.agent.get(`/api/moderation/messages/${m.id}`);
  expect(hidden.text).not.toContain(secret);expect(hidden.body.target).toMatchObject({id:m.id,revision:1,restricted:true});
  expect((await t.action(t.observer,'review',m.id,{verdict:'pass'},2)).status).toBe(403);
  await conserve(t.app);
});
it('keeps fee rewards separate from the shared self-stake and review pool; repeated records do not multiply rewards',async()=>{
  const t=await setup(),before=await t.app.store.account(t.author.user.id),m=await t.publish();
  expect(m.spending).toMatchObject({reviewFee:6,reviewDeposit:10,wager:0,recommendation:1});
  const after=await t.app.store.account(t.author.user.id);expect(before.available-after.available).toBe(18);expect(after.locked-before.locked).toBe(17);
  for(const [actor,amount] of [[t.one,2],[t.one,2],[t.two,2]] as const)expect((await t.action(actor,'review',m.id,{verdict:'pass'},amount,'审核理由')).status).toBe(201);
  expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);
  expect((await t.observer.agent.get(`/api/messages/${m.id}`)).text).toContain('SECRET-CONTENT');
  expect((await t.action(t.one,'review-finalize',m.id)).status).toBe(409);
  const fees=await t.app.store.db.prepare("SELECT SUM(amount) AS total,COUNT(DISTINCT \"userId\") AS people FROM ledger WHERE reason='审核参与报酬'").get();
  expect(Number(fees!.total)).toBe(4);expect(fees!.people).toBe(2);
  expect((await t.action(t.one,'review-finalize',m.id)).status).toBe(409);
  expect((await t.app.store.account(t.author.user.id)).locked).toBe(before.locked+1);
  await conserve(t.app);
});
it('keeps public stake snapshots valid when a contribution is still awaiting review',async()=>{
  const t=await setup(),m=await t.publish();
  for(const actor of [t.one,t.two])expect((await t.action(actor,'review',m.id,{verdict:'pass'},2)).status).toBe(201);
  expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);
  const contribution=await t.send(t.one,[{id:'body',type:'text',text:'PRIVATE-CONTRIBUTION'},
    {id:'stance',type:'relation',relation:'agree',roles:{target:[{id:'target',reference:{messageId:m.id}}]}}],{wager:2});
  expect(contribution.status,contribution.text).toBe(201);
  expect((await t.observer.agent.get(`/api/ui/messages/${m.id}/stakes`)).body.stakes.some((stake:any)=>stake.sourceMessageId===contribution.body.message.id)).toBe(true);
  for(const actor of [t.author,t.two])expect((await t.action(actor,'review',contribution.body.message.id,{verdict:'reject'},8)).status).toBe(201);
  expect((await t.action(t.two,'review-settle',contribution.body.message.id)).status).toBe(201);
  await assertFinalized(t,contribution.body.message.id);
  const publicStakes=await t.observer.agent.get(`/api/ui/messages/${m.id}/stakes`);
  expect(publicStakes.status,publicStakes.text).toBe(200);
  expect(publicStakes.body.countsByType.TRUTH).toEqual({pro:2,con:0});
  expect(publicStakes.body.stakes.every((stake:any)=>typeof stake.user?.id==='string')).toBe(true);
  expect(publicStakes.body.stakes.some((stake:any)=>stake.sourceMessageId===contribution.body.message.id)).toBe(false);
  const ownStakes=await t.one.agent.get(`/api/ui/messages/${m.id}/stakes`);
  expect(ownStakes.body.stakes.some((stake:any)=>stake.sourceMessageId===contribution.body.message.id)).toBe(true);
});
it('pays rejected deposits to the rejecting side and reverses positions on appeal while keeping earned participation fees',async()=>{
  const t=await setup(),m=await t.publish();
  for(const actor of [t.one,t.two])expect((await t.action(actor,'review',m.id,{verdict:'reject'},8)).status).toBe(201);
  expect((await t.action(t.two,'review-settle',m.id)).status).toBe(201);
  expect(await t.app.store.setting('moderation-fund')).toBe(0);
  expect(Number((await t.app.store.db.prepare("SELECT SUM(amount) AS total FROM ledger WHERE reason='审核押注结算'").get())?.total)).toBe(26);
  expect((await t.observer.agent.get(`/api/messages/${m.id}`)).text).not.toContain('SECRET-CONTENT');
  expect((await t.action(t.author,'review-appeal',m.id,{},undefined,'请重新核对规则')).status).toBe(201);
  expect(await t.app.store.setting('moderation-fund')).toBe(0);
  for(const actor of [t.one,t.two])expect((await t.action(actor,'review',m.id,{verdict:'pass'},3,'复核通过')).status).toBe(201);
  expect((await t.action(t.two,'review-settle',m.id)).status).toBe(201);
  await conserve(t.app);
});
it('converts stances on review decisions while preserving discussion of the reason',async()=>{
  const t=await setup(),m=await t.publish(),first=await t.action(t.one,'review',m.id,{verdict:'reject'},2,'判断理由');
  const converted=await t.action(t.two,'disagree',first.body.message.id,{},undefined,'我认为应通过');
  expect(converted.status).toBe(400); // A review wager must be funded.
  const response=await t.send(t.two,[{id:'relation',type:'relation',relation:'disagree',roles:{target:[{id:'target',reference:{messageId:first.body.message.id}}]}}],{wager:2});
  expect(response.status,response.text).toBe(201);
  expect(response.body.message.parts).toContainEqual(expect.objectContaining({relation:'review'}));
  expect(response.body.message.parts.find((p:any)=>p.type==='data').value).toMatchObject({verdict:'pass',convertedFrom:first.body.message.id});
  expect(response.body.message.spending).toMatchObject({wager:0,reviewWager:2});
  const reason=await t.send(t.two,[{id:'relation',type:'relation',relation:'disagree',roles:{target:[{id:'target',reference:{messageId:first.body.message.id,partId:'reason'}}]}}],{wager:1});
  expect(reason.status,reason.text).toBe(201);expect(reason.body.message.parts.some((p:any)=>p.relation==='review')).toBe(false);
  const forged=await t.send(t.two,[{id:'relation',type:'relation',relation:'review',roles:{target:[{id:'target',reference:{messageId:m.id}}]}},
    {id:'data-one',type:'data',value:{verdict:'pass'}},{id:'data-two',type:'data',value:{snapshotHash:'forged',reviewRuleVersion:999}}],{reviewWager:2});
  expect(forged.status,forged.text).toBe(201);const metadata=forged.body.message.parts.filter((p:any)=>p.type==='data');expect(metadata).toHaveLength(1);
  expect(metadata[0].value.snapshotHash).not.toBe('forged');expect(metadata[0].value.reviewRuleVersion).not.toBe(999);
  const mixed=await t.send(t.two,[{id:'review',type:'relation',relation:'review',roles:{target:[{id:'target',reference:{messageId:m.id}}]}},
    {id:'classify',type:'relation',relation:'classify',roles:{}},{id:'data',type:'data',value:{verdict:'pass',title:'不得借审核发布分类'}}],{reviewWager:2});
  expect(mixed.status).toBe(400);
});
it('migrates existing content and custom labels once, retaining their original stakes and recording debt',async()=>{
  const t=await setup();
  await t.app.store.transaction(async()=>t.app.store.set('rules',{...await t.app.store.rules(),moderation:{...(await t.app.store.rules()).moderation!,enabled:false}}));
  const original=await t.send(t.author,[{id:'body',type:'text',text:'旧正文'}],{recommendation:(await t.app.store.account(t.author.user.id)).available-4});
  expect(original.status,original.text).toBe(201);const m=original.body.message;
  const tag=await t.action(t.author,'tag',m.id,{label:'自定义旧标签'});
  // The original helper uses no ordinary contribution for actions; fund this tag explicitly.
  expect(tag.status).toBe(400);
  const label=await t.send(t.author,[{id:'relation',type:'relation',relation:'tag',roles:{target:[{id:'target',reference:{messageId:m.id}}]}},{id:'data',type:'data',value:{label:'自定义旧标签'}}],{recommendation:1});
  expect(label.status,label.text).toBe(201);
  // Legacy settlement declarations/results were attributed to the initiator and
  // contain generated text. Importing them must not freeze funds or assign reviews.
  const history=await t.app.store.transaction(async()=>{
    const tx=new Mutation(t.app.store),records=[];
    for(const relation of ['settlement','distribution'])records.push(await tx.create(t.author.user.id,[
      {id:'body',type:'text',text:relation==='settlement'?'旧版结算历史':'真假仲裁完成：结果：赞成胜出'},
      {id:'relation',type:'relation',relation,roles:{target:[{id:'target',reference:{messageId:m.id}}]}},
      {id:'data',type:'data',value:{kind:relation==='settlement'?'ROUND':'ROUND_RESULT'}},
    ]));
    for(const relation of ['member-of','agree','disagree','reference','reply','annotation','recommend','archive','merge','arrange','correct']){
      const code=relation==='member-of'?'JOIN':relation.toUpperCase();
      records.push(await tx.create(t.author.user.id,[
        {id:'body',type:'text',text:`建立关系：${code}；目标：${m.id.slice(-8)}`},
        {id:'relation',type:'relation',relation,roles:{[relation==='member-of'?'member':['merge','arrange'].includes(relation)?'members':'target']:
          [{id:'target',reference:{messageId:m.id}}]}},
        {id:'data',type:'data',value:{kind:'RELATION',uiType:code,...(relation==='correct'?{correctionKind:'WIDTH',correctionWidth:480}:{})}},
      ]));
    }
    const retiredId=randomUUID();
    records.push(await tx.create(t.author.user.id,[{id:'body',type:'text',text:retiredId},
      {id:'relation',type:'relation',relation:'classify',roles:{}},
      {id:'data',type:'data',value:{title:retiredId,origin:{kind:'topic-classification',id:retiredId}}}],undefined,retiredId));
    await t.app.store.set('retired-organizations',[retiredId]);
    await tx.commit();return records;
  });
  const before=await t.app.store.account(t.author.user.id);
  await t.app.store.transaction(async()=>{await t.app.store.set('rules',{...await t.app.store.rules(),moderation:{...(await t.app.store.rules()).moderation!,enabled:true}});await migrateModeration(t.app.store);});
  const after=await t.app.store.account(t.author.user.id);expect(before.available-after.available).toBe(32);expect(after.locked-before.locked).toBe(32);
  expect(after.available).toBeLessThan(0);
  for(const record of history){
    expect(await moderationCase(t.app.store,record.id)).toBeUndefined();
    expect(await t.app.store.message(record.id)).toEqual(record);
    expect(await t.app.store.db.prepare('SELECT 1 FROM ledger WHERE "messageId"=$1').get(record.id)).toBeUndefined();
    expect(await t.app.store.db.prepare("SELECT 1 FROM notifications WHERE category='review' AND \"targetId\"=$1").get(record.id)).toBeUndefined();
  }
  await t.app.store.transaction(()=>migrateModeration(t.app.store));expect(await t.app.store.account(t.author.user.id)).toEqual(after);
  for(const actor of [t.one,t.two])expect((await t.action(actor,'review',m.id,{verdict:'reject'},8)).status).toBe(201);
  expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);
  const beforeAppeal=await t.app.store.account(t.author.user.id);
  expect((await t.action(t.author,'review-appeal',m.id,{},undefined,'余额不足不能新增复核费用')).status).toBe(400);
  expect(await t.app.store.account(t.author.user.id)).toEqual(beforeAppeal);
  await conserve(t.app);
});

it('charges review funding only for authored content, not joins, fixed choices or width changes',async()=>{
  const t=await setup(),target=await t.publish();
  const command=async(body:Record<string,unknown>)=>{
    const result=await t.author.agent.post('/api/ui/relations').set('x-csrf-token',t.author.csrf)
      .set('x-request-id',randomUUID()).send({targetRefs:[{kind:'message',messageId:target.id}],recommendation:1,...body});
    expect(result.status,result.text).toBe(201);return result.body.id as string;
  };
  const container=await command({relationType:'CLASSIFY',targetRefs:[],payload:{title:'有标题的分类'}});
  const startingCases=(await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM moderation_cases').get())!.n;
  const records=[await command({relationType:'JOIN',sourceMessageId:container})];
  for(const [relationType,payload] of [
    ['REFERENCE',{label:'evidence'}],['REPLY',{label:'question'}],['RECOMMEND',{subType:'IMPORTANT'}],
    ['ARCHIVE',{subType:'SPAM'}],['ATTENTION',{subType:'YES'}],['BLOCK',{subType:'NO'}],
    ['CORRECT',{correctionKind:'WIDTH',correctionWidth:480}],
  ] as const)records.push(await command({relationType,payload}));
  for(const id of records){
    expect(await moderationCase(t.app.store,id)).toBeUndefined();
    expect(await t.app.store.db.prepare("SELECT 1 FROM ledger WHERE \"messageId\"=$1 AND reason LIKE '审核%'").get(id)).toBeUndefined();
    expect(await t.app.store.db.prepare("SELECT 1 FROM notifications WHERE category='review' AND \"targetId\"=$1").get(id)).toBeUndefined();
  }
  expect((await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM moderation_cases').get())!.n).toBe(startingCases);
  for(const payload of [{label:'自定义引用'},{label:'evidence',content:'实际的引用说明'}]){
    const id=await command({relationType:'REFERENCE',payload});
    expect(await moderationCase(t.app.store,id)).toMatchObject({fee:6,deposit:10});
  }
  await conserve(t.app);
});

it('keeps new truth and value settlement requests out of review while preserving settlement history',async()=>{
  const t=await setup(),target=await t.publish();
  for(const settlementType of ['TRUTH','VALUE']){
    const result=await t.author.agent.post(`/api/ui/messages/${target.id}/rounds`).set('x-csrf-token',t.author.csrf)
      .set('x-request-id',randomUUID()).send({settlementType});
    expect(result.status,result.text).toBe(201);
    const record=await t.app.store.message(result.body.requestMessageId);
    expect(await moderationCase(t.app.store,record.id)).toBeUndefined();
    expect(await t.app.store.db.prepare("SELECT 1 FROM ledger WHERE \"messageId\"=$1 AND reason LIKE '审核%'").get(record.id)).toBeUndefined();
  }
  expect((await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM moderation_cases').get())?.n).toBe(1);
  const rounds=await t.author.agent.get(`/api/ui/messages/${target.id}/rounds`);
  expect(rounds.status,rounds.text).toBe(200);
  expect(rounds.body.data).toHaveLength(2);
  await conserve(t.app);
});

it('replaces rejected content and dependent quotations, invalidates cached dependents and forbids all ordinary source/target reuse',async()=>{
  const t=await setup(),m=await t.publish();
  for(const actor of [t.one,t.two])expect((await t.action(actor,'review',m.id,{verdict:'pass'},2)).status).toBe(201);
  expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);
  const related=await t.send(t.one,[{id:'body',type:'text',text:'引用 SECRET-QUOTE'},{id:'reference',type:'relation',relation:'reference',roles:{target:[{id:'target',reference:{messageId:m.id}}]}}],{recommendation:1});
  expect(related.status,related.text).toBe(201);const child=related.body.message;
  const after=await t.app.store.latestSequence();
  expect((await t.action(t.author,'review-appeal',m.id,{},undefined,'重新核对')).status).toBe(201);
  for(const actor of [t.one,t.two])expect((await t.action(actor,'review',m.id,{verdict:'reject'},3)).status).toBe(201);
  expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);
  await assertFinalized(t,m.id);
  expect((await t.author.agent.get(`/api/messages/${m.id}`)).text).toContain('SECRET-CONTENT');
  for(const actor of [t.one,t.two,t.observer]){
    const hidden=await actor.agent.get(`/api/messages/${m.id}`);expect(hidden.text).not.toContain('SECRET-CONTENT');
    expect(hidden.body).toMatchObject({restricted:true,content:'',parts:[{id:'restricted-body',type:'text',text:''}]});
    expect((await actor.agent.get(`/api/messages/${child.id}`)).text).not.toContain('SECRET-QUOTE');
  }
  const delta=await t.observer.agent.post('/api/ui/snapshot/query').send({mode:'window',parent:'root',after,knownIds:[m.id,child.id]});
  expect(delta.status,delta.text).toBe(200);expect(delta.text).not.toContain('SECRET-');
  expect(delta.body.messages.find((r:any)=>r.id===child.id)).toMatchObject({restricted:true,content:'',parts:[{id:'restricted-body',type:'text',text:''}]});
  for(const actor of [t.author,t.one,t.observer])for(const role of ['source','target']){
    const denied=await t.send(actor,[{id:'relation',type:'relation',relation:'reference',roles:{[role]:[{id:'binding',reference:{messageId:m.id}}]}}],{recommendation:1});
    expect(denied.status,denied.text).toBe(409);expect(denied.body.code).toBe('REJECTED_REFERENCE');
  }
  const editable=await t.publish('独立内容');
  for(const actor of [t.one,t.two])await t.action(actor,'review',editable.id,{verdict:'pass'},2);
  await t.action(t.one,'review-settle',editable.id);
  const proposal=await t.send(t.author,[{id:'amend',type:'relation',relation:'amend',roles:{target:[{id:'target',reference:{messageId:editable.id}}]}},
    {id:'data',type:'data',value:{expectedRevision:1,parts:[{id:'reference',type:'relation',relation:'reference',roles:{target:[{id:'target',reference:{messageId:m.id}}]}}]}}],{recommendation:1});
  expect(proposal.status,proposal.text).toBe(201);
  for(const actor of [t.one,t.two])await t.action(actor,'review',proposal.body.message.id,{verdict:'pass'},2);
  await t.action(t.one,'review-settle',proposal.body.message.id);
  const bypass=await t.send(t.author,[{id:'authorize',type:'relation',relation:'authorize',roles:{target:[{id:'target',reference:{messageId:proposal.body.message.id}}]}}],{recommendation:1});
  expect(bypass.status,bypass.text).toBe(409);expect(bypass.body.code).toBe('REJECTED_REFERENCE');
  expect((await t.action(t.one,'review-appeal',m.id,{},undefined,'越权复核')).status).toBe(403);
  expect((await t.action(t.one,'review',m.id,{verdict:'pass'},5)).body.code).toBe('CONTENT_RESTRICTED');
  expect((await t.action(t.author,'review-appeal',m.id,{},undefined,'补充证据，请复核')).status).toBe(201);
  expect((await t.one.agent.get(`/api/messages/${m.id}`)).text).toContain('SECRET-CONTENT');
  await conserve(t.app);
});

it('keeps a rejected historical revision hidden when a newer revision is public',async()=>{
  const t=await setup(),m=await t.publish('OLD-PRIVATE-BODY');
  for(const actor of [t.one,t.two])await t.action(actor,'review',m.id,{verdict:'reject'},8);
  await t.action(t.one,'review-settle',m.id);await assertFinalized(t,m.id);
  await t.app.store.transaction(async()=>{const tx=new Mutation(t.app.store),updated={...m,revision:2,parts:[{id:'body',type:'text' as const,text:'NEW-PUBLIC-BODY'}]};await tx.put(updated);await enrollModeration(tx,updated);await tx.commit();});
  for(const actor of [t.one,t.two])expect((await t.action(actor,'review',m.id,{verdict:'pass'},2)).status).toBe(201);
  expect((await t.action(t.one,'review-settle',m.id)).status).toBe(201);
  const history=await t.observer.agent.get(`/api/messages/${m.id}/history`);expect(history.status).toBe(200);expect(history.text).toContain('NEW-PUBLIC-BODY');expect(history.text).not.toContain('OLD-PRIVATE-BODY');
  const oldReview=await t.author.agent.get(`/api/moderation/messages/${m.id}?revision=1`);
  expect(oldReview.body.target).toMatchObject({id:m.id,revision:1,content:'OLD-PRIVATE-BODY'});expect(JSON.stringify(oldReview.body.target)).not.toContain('NEW-PUBLIC-BODY');
  const hiddenReview=await t.observer.agent.get(`/api/moderation/messages/${m.id}?revision=1`);
  expect(hiddenReview.body.target).toMatchObject({id:m.id,revision:1,restricted:true});expect(hiddenReview.text).not.toContain('OLD-PRIVATE-BODY');expect(JSON.stringify(hiddenReview.body.target)).not.toContain('NEW-PUBLIC-BODY');
  const oldReference=await t.send(t.observer,[{id:'relation',type:'relation',relation:'reference',roles:{target:[{id:'target',reference:{messageId:m.id,revision:1}}]}}],{recommendation:1});
  expect(oldReference.status).toBe(409);
  expect((await t.observer.agent.post('/api/ui/body-versions/resolve').send({format:2,messageId:m.id,revision:1,corrections:[]})).status).toBe(403);
  const queue=await t.one.agent.get('/api/moderation/queue');expect(queue.body.items.filter((c:any)=>c.messageId===m.id)).toEqual([expect.objectContaining({revision:1,status:'rejected',finalized:true})]);
});

it('publishes custom labels immediately and removes them from aggregates after rejection',async()=>{
  const t=await setup(),m=await t.publish();
  for(const actor of [t.one,t.two])await t.action(actor,'review',m.id,{verdict:'pass'},2);
  await t.action(t.one,'review-settle',m.id);
  const tag=await t.send(t.author,[{id:'tag',type:'relation',relation:'tag',roles:{target:[{id:'target',reference:{messageId:m.id}}]}},{id:'data',type:'data',value:{label:'PRIVATE-CUSTOM-LABEL'}}],{recommendation:1});
  expect(tag.status,tag.text).toBe(201);expect(tag.body.message.spending.reviewFee).toBe(6);
  expect((await t.observer.agent.get('/api/ui/snapshot')).text).toContain('PRIVATE-CUSTOM-LABEL');
  expect((await t.observer.agent.get('/api/ui/tag-counts')).text).toContain('PRIVATE-CUSTOM-LABEL');
  for(const actor of [t.one,t.two])await t.action(actor,'review',tag.body.message.id,{verdict:'reject'},8);
  expect((await t.action(t.one,'review-settle',tag.body.message.id)).status).toBe(201);
  await assertFinalized(t,tag.body.message.id);
  expect((await t.observer.agent.get('/api/ui/snapshot')).text).not.toContain('PRIVATE-CUSTOM-LABEL');
  expect((await t.observer.agent.get('/api/ui/tag-counts')).text).not.toContain('PRIVATE-CUSTOM-LABEL');
});

it('redacts membership notification excerpts and keeps historical previews tied to their reviewed version',async()=>{
  const t=await setup(),parent=await t.send(t.author,[{id:'classify',type:'relation',relation:'classify',roles:{}},{id:'body',type:'text',text:'公开分类'}],{recommendation:1});
  expect(parent.status,parent.text).toBe(201);const parentId=parent.body.message.id;
  for(const actor of [t.one,t.two])await t.action(actor,'review',parentId,{verdict:'pass'},2);
  await t.action(t.one,'review-settle',parentId);
  const follow=await t.send(t.observer,[{id:'follow',type:'relation',relation:'follow',reason:'YES',roles:{target:[{id:'target',reference:{messageId:parentId}}]}}],{recommendation:1});
  expect(follow.status,follow.text).toBe(201);
  const child=await t.send(t.author,[{id:'body',type:'text',text:'PRIVATE-NOTIFICATION-BODY'},{id:'placement',type:'relation',relation:'member-of',roles:{parent:[{id:'parent',reference:{messageId:parentId}}]}}],{recommendation:1});
  expect(child.status,child.text).toBe(201);
  for(const actor of [t.one,t.two])await t.action(actor,'review',child.body.message.id,{verdict:'reject'},8);
  await t.action(t.one,'review-settle',child.body.message.id);await assertFinalized(t,child.body.message.id);
  const pending=await t.observer.agent.get('/api/ui/notifications');expect(pending.status,pending.text).toBe(200);
  expect(pending.body.items.length).toBeGreaterThan(0);expect(pending.text).not.toContain('PRIVATE-NOTIFICATION-BODY');
  expect(pending.body.items.some((item:any)=>item.restricted&&Array.isArray(item.references))).toBe(true);
  const m=child.body.message;
  await t.app.store.transaction(async()=>{const tx=new Mutation(t.app.store),updated={...m,revision:2,parts:[{id:'body',type:'text' as const,text:'新正文'}]};await tx.put(updated);await enrollModeration(tx,updated);await tx.commit();});
  for(const actor of [t.one,t.two])await t.action(actor,'review',m.id,{verdict:'pass'},2);
  await t.action(t.one,'review-settle',m.id);
  expect((await t.observer.agent.get('/api/ui/notifications')).text).not.toContain('PRIVATE-NOTIFICATION-BODY');
});
