import {afterEach,expect,it} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {replayArchive,type Part} from '@gonglun/core';
import {cleanupTestDatabases,createTestApp} from './test-database.js';

afterEach(cleanupTestDatabases);
it('拒绝文本和关系的零投入，接受真假、价值或同时投入，失败不扣费且重试不重复扣费',async()=>{
  const app=await createTestApp(),agent=request.agent(app);
  const {body:session}=await agent.post('/api/register').send({name:'投入测试',password:'password'});
  const post=(path:string,body:object)=>agent.post(path==='/native/messages'?'/api/messages':'/api/ui'+path).set('x-csrf-token',session.csrf).set('x-request-id',('requestId' in body?String(body.requestId):randomUUID())).send(body);
  const initial=await app.store.account(session.user.id),sequence=await app.store.latestSequence();
  expect((await post('/messages',{content:'不允许零投入',wager:0,recommendation:0})).status).toBe(400);
  expect((await post('/native/messages',{parts:[{id:'body',type:'text',text:'原生接口零投入'}],requestId:randomUUID()})).status).toBe(400);
  expect(await app.store.account(session.user.id)).toEqual(initial);
  expect(await app.store.latestSequence()).toBe(sequence);
  const value=await post('/messages',{content:'仅价值',recommendation:1});
  expect(value.status,value.text).toBe(201);
  for(const wager of [0,1]){
    const response=await post('/relations',{relationType:'RECOMMEND',targetRefs:[{kind:'message',messageId:value.body.id}],wager:0,recommendation:wager});
    expect(response.status,response.text).toBe(wager?201:400);
  }
  const parts:Part[]=[{id:'body',type:'text',text:'两项同时投入'}];
  const input={requestId:randomUUID(),parts,wager:2,recommendation:3,selfStance:'pro'};
  const both=await post('/native/messages',input);
  expect(both.status,both.text).toBe(201);
  expect(both.body.message.spending).toEqual({protocol:1,wager:2,recommendation:3});
  const after=await app.store.account(session.user.id);
  expect(after).toMatchObject({available:initial.available-10,locked:3});
  expect((await post('/native/messages',input)).body).toEqual(both.body);
  expect(await app.store.account(session.user.id)).toEqual(after);
  const changes=(await app.store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)));
  expect(replayArchive({format:'gonglun-2',changes}).accounts.get(session.user.id)).toEqual(after);
});

it('一条批量命令零投入时整批回滚，新建分类的加入消息也分别收费',async()=>{
  const app=await createTestApp(),agent=request.agent(app);
  const {body:session}=await agent.post('/api/register').send({name:'批量投入',password:'password'});
  const post=(path:string,body:object)=>agent.post(path==='/native/messages'?'/api/messages':'/api/ui'+path).set('x-csrf-token',session.csrf).set('x-request-id',('requestId' in body?String(body.requestId):randomUUID())).send(body);
  const before=await app.store.account(session.user.id),sequence=await app.store.latestSequence();
  const failed=await post('/commands',{requestId:randomUUID(),commands:[
    {id:randomUUID(),method:'POST',path:'/messages',body:{content:'第一条',recommendation:1}},
    {id:randomUUID(),method:'POST',path:'/messages',body:{content:'第二条',recommendation:0,wager:0}},
  ]});
  expect(failed.status,failed.text).toBe(400);
  expect(await app.store.account(session.user.id)).toEqual(before);
  expect(await app.store.latestSequence()).toBe(sequence);
  const member=await post('/messages',{content:'成员',recommendation:1});
  const container=await post('/relations',{relationType:'CLASSIFY',payload:{content:'分类'},targetRefs:[{kind:'message',messageId:member.body.id}],recommendation:1});
  expect(container.status,container.text).toBe(201);
  const generated=(await app.store.db.prepare('SELECT body FROM messages').all()).map(row=>JSON.parse(String(row.body)))
    .filter(message=>message.parts.some((part:any)=>part.type==='data'&&part.value?.generatedBy===container.body.id));
  expect(generated).toHaveLength(1);
  expect(generated[0].spending).toEqual({protocol:1,wager:0,recommendation:1});
  expect(await app.store.account(session.user.id)).toMatchObject({available:before.available-6,locked:0});
});

it.each(['root','classification'])('两条引用和一条文本只在分类中增加一条加入消息，各类按每条投入收费（%s）',async scope=>{
  const app=await createTestApp(),agent=request.agent(app);
  const {body:session}=await agent.post('/api/register').send({name:'引用计费',password:'password'});
  const post=(path:string,body:object)=>agent.post('/api/ui'+path).set('x-csrf-token',session.csrf).set('x-request-id',('requestId' in body?String(body.requestId):randomUUID())).send(body);
  const a=await post('/messages',{content:'目标甲',recommendation:1}),b=await post('/messages',{content:'目标乙',recommendation:1});
  const container=await post('/relations',{relationType:'CLASSIFY',payload:{content:'分类'},recommendation:1});
  expect(container.status,container.text).toBe(201);
  const parentMessageId=scope==='root'?'root':container.body.id;
  const before=await app.store.account(session.user.id);
  const textId=randomUUID();
  const batch={requestId:randomUUID(),commands:[
    {id:textId,method:'POST',path:'/messages',body:{parentMessageId,content:'同时引用两条',wager:2,selfAgree:true,recommendation:1,joinContribution:{wager:5,recommendation:2}}},
    ...[a.body.id,b.body.id].map(messageId=>({id:randomUUID(),method:'POST',path:'/relations',body:{parentMessageId,relationType:'REFERENCE',sourceMessageId:textId,
      targetRefs:[{kind:'message',messageId}],wager:4,selfAgree:true,recommendation:3,joinContribution:{wager:5,recommendation:2}}})),
  ]};
  const response=await post('/commands',batch);
  expect(response.status).toBe(201);
  const messages=(await app.store.db.prepare('SELECT body FROM messages WHERE "authorId"=$1').all(session.user.id)).map(row=>JSON.parse(String(row.body)))
    .filter(message=>![a.body.id,b.body.id,container.body.id].includes(message.id));
  expect(messages).toHaveLength(scope==='root'?3:4);
  const joins=messages.filter(message=>message.parts.some((part:any)=>part.type==='data'&&part.value?.uiType==='JOIN'));
  expect(joins).toHaveLength(scope==='root'?0:1);
  if(joins.length)expect(joins[0].spending).toEqual({protocol:1,wager:5,recommendation:2});
  const after=await app.store.account(session.user.id);
  expect(after).toMatchObject({available:before.available-(scope==='root'?20:28),locked:before.locked+(scope==='root'?10:15)});
  const retry=await post('/commands',batch);
  expect(retry.body.results).toEqual(response.body.results);
  expect(retry.body.sequence).toBe(response.body.sequence);
  expect(await app.store.account(session.user.id)).toEqual(after);
  const visible=new Set(response.body.snapshots.flatMap((snapshot:any)=>snapshot.messages.map((message:any)=>message.id)));
  for(const message of messages)expect(visible.has(message.id)).toBe(true);
  const changes=(await app.store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)));
  expect(replayArchive({format:'gonglun-2',changes}).accounts.get(session.user.id)).toEqual(after);
});

it('新分类的多条加入共用投入配置，但每条扣款；余额不足时全部回滚',async()=>{
  const app=await createTestApp(),agent=request.agent(app);
  const {body:session}=await agent.post('/api/register').send({name:'加入计费',password:'password'});
  const post=(path:string,body:object)=>agent.post('/api/ui'+path).set('x-csrf-token',session.csrf).set('x-request-id',randomUUID()).send(body);
  const memberIds=[];
  for(const content of ['甲','乙','丙'])memberIds.push((await post('/messages',{content,recommendation:1})).body.id);
  const before=await app.store.account(session.user.id),sequence=await app.store.latestSequence();
  const body={relationType:'CLASSIFY',payload:{content:'分类'},targetRefs:memberIds.map(messageId=>({kind:'message',messageId})),recommendation:1,joinContribution:{wager:4,recommendation:0}};
  expect((await post('/relations',{...body,joinContribution:{wager:0,recommendation:0}})).status).toBe(400);
  expect((await post('/relations',{...body,joinContribution:{wager:before.available,recommendation:0}})).status).toBe(400);
  expect(await app.store.account(session.user.id)).toEqual(before);
  expect(await app.store.latestSequence()).toBe(sequence);
  const response=await post('/relations',body);
  expect(response.status,response.text).toBe(201);
  const generated=(await app.store.db.prepare('SELECT body FROM messages').all()).map(row=>JSON.parse(String(row.body)))
    .filter(message=>message.parts.some((part:any)=>part.type==='data'&&part.value?.generatedBy===response.body.id));
  expect(generated).toHaveLength(3);
  for(const message of generated)expect(message.spending).toEqual({protocol:1,wager:4,recommendation:0});
  expect(await app.store.account(session.user.id)).toMatchObject({available:before.available-17,locked:before.locked+12});
});
