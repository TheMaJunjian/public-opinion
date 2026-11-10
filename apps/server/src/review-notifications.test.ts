import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {afterEach,expect,it} from 'vitest';
import {createTestApp,cleanupTestDatabases,testInvitation} from './test-database.js';
import {Mutation} from './db.js';
import {assignmentRecord,processReviewAssignments} from './review-assignments.js';
import {recordNotifications} from './notifications.js';
import {enrollModeration,moderationCase} from './moderation.js';

afterEach(cleanupTestDatabases);
async function setup(){
  const app=await createTestApp({moderation:true});
  const users=[];
  for(const name of ['author','first','second','observer']){
    const agent=request.agent(app),response=await agent.post('/api/register').send({name,password:'password',inviteCode:await testInvitation(app)});
    expect(response.status,response.text).toBe(201);users.push({agent,id:response.body.user.id,csrf:response.body.csrf});
  }
  const [author,first,second,observer]=users as [typeof users[number],typeof users[number],typeof users[number],typeof users[number]];
  await observer.agent.put('/api/moderation/availability').set('x-csrf-token',observer.csrf).send({enabled:false});
  const send=(actor:typeof author,parts:unknown[],extra:Record<string,unknown>={})=>actor.agent.post('/api/messages').set('x-csrf-token',actor.csrf).send({requestId:randomUUID(),parts,...extra});
  const publish=await send(author,[{id:'body',type:'text',text:'可见性测试正文'}],{recommendation:1});expect(publish.status,publish.text).toBe(201);
  const target=publish.body.message;
  const action=(actor:typeof author,relation:string,verdict?:string,amount=2)=>send(actor,[
    {id:'body',type:'text',text:'审核理由'},
    {id:'relation',type:'relation',relation,roles:{target:[{id:'t',reference:{messageId:target.id,revision:1}}]}},
    {id:'data',type:'data',value:verdict?{verdict}:{}}],relation==='review'?{reviewWager:amount}:{});
  const inbox=async(actor:typeof author,query:Record<string,unknown>={})=>{const res=await actor.agent.get('/api/ui/notifications').query({category:'review',...query});expect(res.status,res.text).toBe(200);return res.body;};
  return {app,author,first,second,observer,target,action,inbox};
}
it('delivers task assignment and withdrawal privately and never delivers migration history',async()=>{
  const t=await setup();
  for(const actor of [t.first,t.second]){
    const page=await t.inbox(actor);expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({category:'review',kind:'review-assigned',reviewTarget:{messageId:t.target.id,revision:1},reviewTaskStatus:'pending'});
    expect(page.unseenByCategory.review).toBe(1);
    expect(page.pendingReviewCount).toBe(1);
  }
  expect((await t.inbox(t.author)).items).toHaveLength(0);expect((await t.inbox(t.observer)).items).toHaveLength(0);
  await t.app.store.db.prepare('UPDATE moderation_assignments SET "expiresAt"=$2 WHERE "userId"=$1').run(t.first.id,'2000-01-01T00:00:00Z');
  await t.app.store.db.exec('UPDATE moderation_cases SET "assignmentCheckAt"=0');await processReviewAssignments(t.app.store);
  const ended=await t.inbox(t.first),withdrawn=await t.inbox(t.first,{category:'review-revoked'});
  expect(ended.items).toEqual([]);
  expect(withdrawn.items.map((item:any)=>item.kind)).toEqual(['review-revoked','review-assigned']);
  expect(withdrawn.items[1].reviewTaskStatus).toBe('revoked');
  expect(ended).toMatchObject({pendingReviewCount:0,unseenByCategory:{review:0,'review-revoked':2}});
  expect((await t.inbox(t.second)).items.map((item:any)=>item.kind)).toEqual(['review-assigned']);
  const before=await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get();
  await t.app.store.transaction(async()=>{
    const tx=new Mutation(t.app.store);
    await tx.create('system',[{id:'body',type:'text',text:'旧迁移说明'},
      {id:'relation',type:'relation',relation:'review-enrollment',roles:{target:[{id:'t',reference:{messageId:t.target.id,revision:1}}]}},
      {id:'data',type:'data',value:{migration:'content-moderation'}}]);await tx.commit();
  });
  expect(await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual(before);
  const discussion=await t.first.agent.get(`/api/moderation/messages/${t.target.id}`);
  expect(discussion.body.records).toEqual([]);
});

it('keeps a viewed assignment unhandled until submission and preserves it when clearing viewed notices',async()=>{
  const t=await setup(),initial=await t.inbox(t.first),notice=initial.items[0];
  const seen=await t.first.agent.post('/api/ui/notifications/seen').set('x-csrf-token',t.first.csrf).send({through:initial.through,category:'review'});
  expect(seen.status,seen.text).toBe(200);
  const pending=await t.inbox(t.first,{pending:true});
  expect(pending).toMatchObject({unseenCount:initial.unseenCount-1,unseenByCategory:{review:0},pendingReviewCount:1});
  expect(pending.items).toMatchObject([{id:notice.id,seenAt:expect.any(String),reviewTaskStatus:'pending'}]);
  expect((await t.inbox(t.first,{pending:true,unread:true})).items).toEqual([]);
  const clear=()=>t.first.agent.post('/api/ui/notifications/delete').set('x-csrf-token',t.first.csrf).send({through:initial.through,category:'review',seenOnly:true});
  expect((await clear()).status).toBe(200);
  expect((await t.inbox(t.first,{pending:true})).items).toHaveLength(1);
  const vote=await t.action(t.first,'review','pass');expect(vote.status,vote.text).toBe(201);
  expect((await t.inbox(t.first)).items[0]).toMatchObject({reviewTaskStatus:'submitted',seenAt:expect.any(String)});
  expect(await t.inbox(t.first,{pending:true})).toMatchObject({items:[],pendingReviewCount:0,unseenByCategory:{review:0}});
  expect((await clear()).status).toBe(200);
  expect((await t.inbox(t.first)).items).toEqual([]);
  expect((await t.inbox(t.second)).pendingReviewCount).toBe(1);
});

it('scopes unseen counts, bulk acknowledgement and clearing to the withdrawal section',async()=>{
  const t=await setup();
  await t.app.store.db.prepare('UPDATE moderation_assignments SET "expiresAt"=$2 WHERE "userId"=$1').run(t.first.id,'2000-01-01T00:00:00Z');
  const expired=await t.inbox(t.first,{pending:true});
  expect(expired).toMatchObject({items:[],pendingReviewCount:0});
  expect((await t.inbox(t.first,{category:'review-revoked'})).items[0].reviewTaskStatus).toBe('expired');
  await t.app.store.db.exec('UPDATE moderation_cases SET "assignmentCheckAt"=0');await processReviewAssignments(t.app.store);
  const another=await t.author.agent.post('/api/messages').set('x-csrf-token',t.author.csrf).send({requestId:randomUUID(),parts:[{id:'body',type:'text',text:'仍然需要处理的另一条消息'}],recommendation:1});
  expect(another.status,another.text).toBe(201);
  const withdrawn=await t.inbox(t.first,{category:'review-revoked',unread:true,limit:1});
  expect(withdrawn.items).toHaveLength(1);expect(withdrawn.nextCursor).not.toBeNull();
  const next=await t.inbox(t.first,{category:'review-revoked',unread:true,limit:1,through:withdrawn.through,cursor:withdrawn.nextCursor});
  expect(next.items).toMatchObject([{kind:'review-assigned',reviewTaskStatus:'revoked'}]);expect(next.nextCursor).toBeNull();
  expect((await t.inbox(t.first,{category:'review-revoked',pending:true})).items).toEqual([]);
  const seen=await t.first.agent.post('/api/ui/notifications/seen').set('x-csrf-token',t.first.csrf).send({through:withdrawn.through,category:'review-revoked'});
  expect(seen.status,seen.text).toBe(200);
  expect((await t.inbox(t.first,{unread:true})).items).toHaveLength(1);
  expect((await t.inbox(t.first,{category:'review-revoked',unread:true})).items).toHaveLength(0);
  const cleared=await t.first.agent.post('/api/ui/notifications/delete').set('x-csrf-token',t.first.csrf).send({through:withdrawn.through,category:'review-revoked',seenOnly:true});
  expect(cleared.status,cleared.text).toBe(200);
  expect((await t.inbox(t.first,{category:'review-revoked'})).items).toHaveLength(0);
  expect((await t.inbox(t.first)).items).toHaveLength(1);
});

it('does not turn an old assignment notice into a new-round task, including legacy notices without a saved round',async()=>{
  const t=await setup(),old=(await t.inbox(t.first)).items[0];
  await t.app.store.db.prepare(`UPDATE notifications SET body=body-'reviewRound' WHERE id=$1`).run(old.id);
  await t.app.store.transaction(async()=>{
    const c=(await moderationCase(t.app.store,t.target.id))!;
    await t.app.store.db.prepare('UPDATE moderation_cases SET round=2 WHERE id=$1').run(c.id);
    const expiresAt=new Date(Date.now()+30*60_000).toISOString();
    await t.app.store.db.prepare('INSERT INTO moderation_assignments("caseId",round,"userId",stage,"assignedAt","expiresAt") VALUES($1,2,$2,0,$3,$4)')
      .run(c.id,t.first.id,new Date().toISOString(),expiresAt);
    const tx=new Mutation(t.app.store);await assignmentRecord(tx,{...c,round:2},'新一轮任务',{assigned:[t.first.id],expiresAt});await tx.commit();
  });
  const current=await t.inbox(t.first);
  expect(current.pendingReviewCount).toBe(1);
  expect((await t.inbox(t.first,{category:'review-revoked'})).items.find((item:any)=>item.id===old.id).reviewTaskStatus).toBe('closed');
  const pending=await t.inbox(t.first,{pending:true,limit:1});
  expect(pending.items).toHaveLength(1);expect(pending.items[0]).toMatchObject({reviewRound:2,reviewTaskStatus:'pending'});expect(pending.nextCursor).toBeNull();
  const seen=await t.first.agent.post('/api/ui/notifications/seen').set('x-csrf-token',t.first.csrf).send({through:current.through,category:'review',pending:true});
  expect(seen.status,seen.text).toBe(200);
  expect((await t.inbox(t.first,{category:'review-revoked',unread:true})).items.map((item:any)=>item.id)).toEqual([old.id]);
  expect((await t.inbox(t.first,{unread:true})).items).toEqual([]);
  expect((await t.inbox(t.first,{pending:true})).items).toMatchObject([{seenAt:expect.any(String)}]);
});

it.each([false,true])('keeps actual appeal assignments pending, including legacy JSON null settlements (%s)',async legacyJsonNull=>{
  const t=await setup();
  expect((await t.action(t.first,'review','pass')).status).toBe(201);
  expect((await t.action(t.first,'review-settle')).status).toBe(201);
  expect((await t.action(t.author,'review-appeal')).status).toBe(201);
  if(legacyJsonNull)await t.app.store.db.prepare(`UPDATE moderation_cases SET settlement='null'::jsonb WHERE "messageId"=$1`).run(t.target.id);
  for(const actor of [t.first,t.second]){
    const pending=await t.inbox(actor,{pending:true});
    expect(pending.pendingReviewCount).toBe(1);
    expect(pending.items).toMatchObject([{kind:'review-assigned',reviewRound:2,reviewTaskStatus:'pending'}]);
    const seen=await actor.agent.post('/api/ui/notifications/seen').set('x-csrf-token',actor.csrf).send({through:pending.through,category:'review',pending:true});
    expect(seen.status,seen.text).toBe(200);
    const cleared=await actor.agent.post('/api/ui/notifications/delete').set('x-csrf-token',actor.csrf).send({through:pending.through,category:'review',seenOnly:true});
    expect(cleared.status,cleared.text).toBe(200);
    expect((await t.inbox(actor,{pending:true})).items).toMatchObject([{reviewRound:2,reviewTaskStatus:'pending',seenAt:expect.any(String)}]);
  }
});

it('describes existing review targets by their type and pinned classification title instead of generated endpoint IDs',async()=>{
  const t=await setup();
  const target=await t.app.store.transaction(async()=>{
    const tx=new Mutation(t.app.store);
    const message=await tx.create(t.author.id,[
      {id:'body',type:'text',text:`建立关系：CLASSIFY；目标：${t.target.id}`},
      {id:'relation',type:'relation',relation:'classify',roles:{members:[{id:'member',reference:{messageId:t.target.id}}]}},
      {id:'data',type:'data',value:{title:'原分类标题',uiType:'CLASSIFY'}},
    ]);
    await enrollModeration(tx,message);await tx.commit();return message;
  });
  expect((await t.inbox(t.first)).items.find((item:any)=>item.targetId===target.id))
    .toMatchObject({targetMessageType:'分类',targetExcerpt:'原分类标题',reviewTarget:{messageId:target.id,revision:1}});
  // Existing inbox rows keep their original event; reading repairs their presentation.
  await t.app.store.db.prepare(`UPDATE notifications SET body=(body-'targetMessageType')||jsonb_build_object('targetExcerpt',$2::text)
    WHERE "targetId"=$1`).run(target.id,`建立关系：CLASSIFY；目标：${t.target.id}`);
  await t.app.store.transaction(async()=>{
    const tx=new Mutation(t.app.store);
    await tx.put({...target,revision:2,parts:target.parts.map(part=>part.id==='data'?{id:'data',type:'data',value:{title:'另一版分类标题',uiType:'CLASSIFY'}}:part)});
    await tx.commit();
  });
  const before=await t.app.store.db.prepare('SELECT body,"seenAt" FROM notifications WHERE "targetId"=$1 ORDER BY id').all(target.id);
  const notice=(await t.inbox(t.first)).items.find((item:any)=>item.targetId===target.id);
  expect(notice).toMatchObject({targetMessageType:'分类',targetExcerpt:'原分类标题',targetExcerptReference:{messageId:target.id,revision:1}});
  expect(notice.targetExcerpt).not.toContain(t.target.id);
  expect(await t.app.store.db.prepare('SELECT body,"seenAt" FROM notifications WHERE "targetId"=$1 ORDER BY id').all(target.id)).toEqual(before);
});
it('summarizes the selected correction against its pinned target, including for old notifications',async()=>{
  const t=await setup();
  const correction=await t.app.store.transaction(async()=>{
    const tx=new Mutation(t.app.store);
    const message=await tx.create(t.author.id,[
      {id:'corrected-body',type:'text',text:'可见性测试文字'},
      {id:'body',type:'text',text:`建立关系：CORRECT；目标：${t.target.id}`},
      {id:'relation',type:'relation',relation:'correct',roles:{target:[{id:'target',reference:{messageId:t.target.id,revision:1,partId:'body',range:{start:5,end:7}}}]}},
      {id:'data',type:'data',value:{value:'文字',correctionBeforeContent:'可见性测试正文',correctionKind:'TEXT'}},
    ]);
    await enrollModeration(tx,message);await tx.commit();return message;
  });
  const find=async()=>(await t.inbox(t.first)).items.find((item:any)=>item.targetId===correction.id);
  expect(await find()).toMatchObject({targetMessageType:'更正',targetExcerpt:'将「正文」修改为「文字」'});
  await t.app.store.db.prepare(`UPDATE notifications SET body=body||jsonb_build_object('targetExcerpt',$2::text) WHERE "targetId"=$1`)
    .run(correction.id,`可见性测试文字\n建立关系：CORRECT；目标：${t.target.id}`);
  await t.app.store.transaction(async()=>{
    const tx=new Mutation(t.app.store);
    await tx.put({...t.target,revision:2,parts:[{id:'body',type:'text',text:'与旧正文完全不同的新版本'}]});await tx.commit();
  });
  expect(await find()).toMatchObject({targetExcerpt:'将「正文」修改为「文字」',seenAt:null,
    targetExcerptReference:{messageId:correction.id,revision:1}});
});

it.each(['pass','reject','unknown'])('notifies only affected users of a %s result and their own settlement amounts',async verdict=>{
  const t=await setup();
  for(const actor of [t.first,t.second]){const res=await t.action(actor,'review',verdict==='unknown'?'reject':verdict,verdict==='unknown'?5:verdict==='reject'?8:2);expect(res.status,res.text).toBe(201);}
  const settled=await t.action(t.first,'review-settle');expect(settled.status,settled.text).toBe(201);
  for(const actor of [t.author,t.first,t.second]){
    const result=(await t.inbox(actor)).items.find((item:any)=>item.kind==='review-result');
    expect(result).toMatchObject({category:'review',action:verdict==='pass'?'审核通过，允许传播':verdict==='reject'?'审核不通过，限制传播':'审核平局，结论未定，退还押注本金',reviewTarget:{messageId:t.target.id,revision:1}});
  }
  expect((await t.inbox(t.observer)).items).toHaveLength(0);
  for(const actor of [t.author,t.first,t.second]){
    const page=await t.inbox(actor),financial=page.items.filter((item:any)=>item.kind==='review-financial');
    expect(financial.length).toBeGreaterThan(0);
    for(const notice of financial){
      const entries=await t.app.store.db.prepare('SELECT amount,"lockedDelta" FROM ledger WHERE "messageId"=$1 AND "userId"=$2').all<{amount:number;lockedDelta:number}>(notice.sourceId,actor.id);
      expect(notice.availableDelta).toBe(entries.reduce((sum,entry)=>sum+entry.amount,0));
      expect(notice.lockedDelta).toBe(entries.reduce((sum,entry)=>sum+entry.lockedDelta,0));
      expect(notice.reviewTarget).toEqual({messageId:t.target.id,revision:1});
    }
    if(verdict==='reject'&&actor!==t.author){
      expect(JSON.stringify(page.items)).not.toContain('可见性测试正文');
      expect(page.items.every((item:any)=>item.targetMessageType==='文本'&&item.targetExcerpt==='')).toBe(true);
      expect(page.items.some((item:any)=>item.action==='审核不通过，限制传播')).toBe(true);
    }
  }
  const detail=await t.author.agent.get(`/api/moderation/messages/${t.target.id}`);
  expect(detail.body.records).toHaveLength(2);
  const change=await t.app.store.db.prepare('SELECT body FROM changes ORDER BY sequence DESC LIMIT 1').get<{body:string}>();
  const before=await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get();
  await t.app.store.transaction(()=>recordNotifications(t.app.store,JSON.parse(change!.body)));
  expect(await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual(before);
});
