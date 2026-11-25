import { PARTICIPATION_AGREEMENT_VERSION } from '@gonglun/core';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {afterEach,expect,it} from 'vitest';
import {createTestApp,cleanupTestDatabases} from './test-database.js';
import {Mutation} from './db.js';
import {recordNotifications} from './notifications.js';
import {enrollModeration} from './moderation.js';

afterEach(cleanupTestDatabases);
async function setup(){
  const app=await createTestApp({moderation:true});
  const users=[];
  for(const name of ['author','first','second','observer']){
    const agent=request.agent(app),response=await agent.post('/api/register').send({acceptedAgreementVersion: PARTICIPATION_AGREEMENT_VERSION, name,password:'password'});
    expect(response.status,response.text).toBe(201);users.push({agent,id:response.body.user.id,csrf:response.body.csrf});
  }
  const [author,first,second,observer]=users as [typeof users[number],typeof users[number],typeof users[number],typeof users[number]];
  const send=(actor:typeof author,parts:unknown[],extra:Record<string,unknown>={})=>actor.agent.post('/api/messages').set('x-csrf-token',actor.csrf).send({requestId:randomUUID(),parts,...extra});
  const publish=await send(author,[{id:'body',type:'text',text:'可见性测试正文'}],{recommendation:1});expect(publish.status,publish.text).toBe(201);
  const target=publish.body.message;
  const action=(actor:typeof author,relation:string,verdict?:string,amount=2,messageId=target.id)=>send(actor,[
    {id:'body',type:'text',text:'审核理由'},
    {id:'relation',type:'relation',relation,roles:{target:[{id:'t',reference:{messageId,revision:1}}]}},
    {id:'data',type:'data',value:verdict?{verdict}:{}}],relation==='review'?{reviewWager:amount}:{});
  const inbox=async(actor:typeof author,query:Record<string,unknown>={})=>{const res=await actor.agent.get('/api/ui/notifications').query({category:'review',...query});expect(res.status,res.text).toBe(200);return res.body;};
  return {app,author,first,second,observer,target,action,inbox};
}
it('publishing an item opens it for review without sending permissions, and migration history stays out of the inbox',async()=>{
  const t=await setup();
  for(const actor of [t.author,t.first,t.second,t.observer]){
    expect((await t.inbox(actor)).items).toEqual([]);
    const detail=await actor.agent.get(`/api/moderation/messages/${t.target.id}`);
    expect(detail.body.canReview).toBe(true);
  }
  expect(await t.app.store.db.prepare(`SELECT 1 FROM messages WHERE body::jsonb->>'authorId'='system'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(body::jsonb->'parts') p WHERE p->>'relation'='review-record')`).get()).toBeUndefined();
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
  expect((await t.action(t.first,'review','pass',2,target.id)).status).toBe(201);
  expect((await t.inbox(t.author)).items.find((item:any)=>item.targetId===target.id))
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
  const notice=(await t.inbox(t.author)).items.find((item:any)=>item.targetId===target.id);
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
  expect((await t.action(t.first,'review','pass',2,correction.id)).status).toBe(201);
  const find=async()=>(await t.inbox(t.author)).items.find((item:any)=>item.targetId===correction.id);
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
  expect(detail.body.records.filter((record:any)=>record.parts.some((part:any)=>part.relation==='review'))).toHaveLength(2);
  expect(detail.body.records.filter((record:any)=>record.parts.some((part:any)=>part.relation==='review-reason'))).toHaveLength(2);
  const change=await t.app.store.db.prepare('SELECT body FROM changes ORDER BY sequence DESC LIMIT 1').get<{body:string}>();
  const before=await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get();
  await t.app.store.transaction(()=>recordNotifications(t.app.store,JSON.parse(change!.body)));
  expect(await t.app.store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual(before);
});
