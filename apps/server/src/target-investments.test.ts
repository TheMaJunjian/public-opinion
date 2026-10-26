import {afterEach,expect,it} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {bindRoles,relations,replayArchive,type Part,type Reference} from '@gonglun/core';
import {cleanupTestDatabases,createTestApp} from './test-database.js';
import {stakesFor,roundView} from './ui-projections.js';
afterEach(cleanupTestDatabases);
const relation=(name:string,target:Reference):Part=>({id:'relation',type:'relation',relation:name,roles:bindRoles({target:[target]})});
async function setup(){
  const app=await createTestApp(),agent=request.agent(app);
  const {body:session}=await agent.post('/api/register').send({name:'目标投入',password:'test-password'});
  const post=(parts:Part[],spending:object,requestId=randomUUID())=>agent.post('/api/messages').set('x-csrf-token',session.csrf).send({requestId,parts,...spending});
  const send=async(parts:Part[],spending:object)=>{const result=await post(parts,spending);expect(result.status,result.text).toBe(201);return result.body.message;};
  const target=await send([{id:'body',type:'text',text:'被评价的消息'}],{recommendation:1});
  return {app,agent,session,post,send,target};
}
it('真假表态穿透表态链但不翻转新方向，价值标注评价所选表态自身，赞同与反对标注复制到原标注目标',async()=>{
  const {app,send,target}=await setup();
  const oppose=await send([relation('disagree',{messageId:target.id})],{wager:2});
  const agree=await send([relation('agree',{messageId:oppose.id})],{wager:3});
  const recommend=await send([relation('recommend',{messageId:oppose.id})],{recommendation:4});
  const copied=await send([relation('agree',{messageId:recommend.id})],{recommendation:5});
  const inverse=await send([relation('disagree',{messageId:recommend.id})],{recommendation:6});
  expect(relations(copied)).toMatchObject([{relation:'recommend',roles:{target:[{reference:{messageId:oppose.id}}]}}]);
  expect(relations(inverse)).toMatchObject([{relation:'archive',roles:{target:[{reference:{messageId:oppose.id}}]}}]);
  for(const message of [oppose,agree,recommend,copied,inverse])expect(relations(message).some(part=>part.roles.target?.[0]?.reference.messageId===message.id)).toBe(false);
  const stakes=await stakesFor(app.store,[target.id,oppose.id,agree.id,recommend.id,copied.id,inverse.id]);
  expect(stakes[target.id]!.countsByType).toEqual({TRUTH:{pro:3,con:2},VALUE:{pro:0,con:0}});
  expect(stakes[oppose.id]!.countsByType).toEqual({TRUTH:{pro:0,con:0},VALUE:{pro:9,con:6}});
  for(const message of [agree,recommend,copied,inverse])expect(stakes[message.id]!.counts).toEqual({pro:0,con:0});
});
it.each([['follow','YES','pro'],['follow','NO','con'],['block','YES','con'],['block','NO','pro'],['tag',undefined,'pro']] as const)('%s %s 的投入锁在所选目标的价值轮次',async(name,reason,side)=>{
  const {app,send,target,session}=await setup(),before=await app.store.account(session.user.id),operating=await app.store.setting<number>('operating');
  const part=relation(name,{messageId:target.id}) as Extract<Part,{type:'relation'}>;
  const message=await send([{...part,...(reason?{reason}:{})},...(name==='tag'?[{id:'data',type:'data',value:{label:'标签'}} as Part]:[])],{recommendation:7});
  expect(await app.store.account(session.user.id)).toMatchObject({available:before.available-8,locked:before.locked+7});
  expect(await app.store.setting('operating')).toBe(operating+1);
  const stake=(await stakesFor(app.store,[target.id,message.id]))[target.id]!;
  expect(stake.countsByType.VALUE).toEqual(side==='pro'?{pro:7,con:0}:{pro:0,con:7});
  const round=await roundView(app.store,stake.stakes[0]!.roundId!);
  expect(round.votes).toEqual([expect.objectContaining({id:message.id,amount:7,vote:side==='pro'?'TRUE':'FALSE'})]);
});
it('后端拒绝错维度和双零，失败原子回滚，重试只锁一次且重放账本一致',async()=>{
  const {app,send,post,target,session}=await setup(),before=await app.store.account(session.user.id),sequence=await app.store.latestSequence();
  for(const [name,spending] of [['agree',{wager:1,recommendation:2}],['recommend',{wager:2,recommendation:1}],['archive',{recommendation:0}],['disagree',{wager:0}]] as const)
    expect((await post([relation(name,{messageId:target.id})],spending)).status).toBe(400);
  expect(await app.store.account(session.user.id)).toEqual(before);expect(await app.store.latestSequence()).toBe(sequence);
  const original=await send([relation('recommend',{messageId:target.id})],{recommendation:2});
  const requestId=randomUUID(),parts=[relation('agree',{messageId:original.id})];
  const first=await post(parts,{recommendation:3},requestId);expect(first.status,first.text).toBe(201);
  const account=await app.store.account(session.user.id);
  expect((await post(parts,{recommendation:3},requestId)).body).toEqual(first.body);
  expect(await app.store.account(session.user.id)).toEqual(account);
  const changes=(await app.store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)));
  expect(replayArchive({format:'gonglun-2',changes}).accounts.get(session.user.id)).toEqual(account);
});

it('推荐的本金进入目标价值结算，单边结算退回本金，关系自身没有真假轮次',async()=>{
  const {app,agent,session,send,target}=await setup();
  const before=await app.store.account(session.user.id);
  const annotation=await send([relation('recommend',{messageId:target.id})],{recommendation:7});
  const value=(await stakesFor(app.store,[target.id]))[target.id]!.stakes[0]!;
  const response=await agent.post(`/api/ui/rounds/${value.roundId}/close-and-settle`).set('x-csrf-token',session.csrf).set('x-request-id',randomUUID()).send({});
  expect(response.status,response.text).toBe(201);expect(response.body).toMatchObject({status:'SETTLED',settlementType:'VALUE',totalPro:7,totalCon:0});
  expect(await app.store.account(session.user.id)).toMatchObject({available:before.available-3,locked:before.locked});
  expect((await stakesFor(app.store,[annotation.id]))[annotation.id]!.counts).toEqual({pro:0,con:0});
});
