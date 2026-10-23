import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ANNOTATION_OPPOSITES, bindRoles, type Message, type Part, type Reference, type Session } from '@gonglun/core';
import { createTestApp, cleanupTestDatabases } from './test-database.js';
import { personalMarks } from './personal.js';

const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];
const relation = (name: string, target: Reference): Extract<Part,{type:'relation'}> => ({id:'relation',type:'relation',relation:name,roles:bindRoles({target:[target]})});
const data = (value: Record<string,string>): Part => ({id:'data',type:'data',value});
async function setup() {
  const app = await createTestApp(); apps.push(app);
  const agent = request.agent(app);
  const registered = await agent.post('/api/register').send({name:'annotation-tester',password:'a-good-password'});
  expect(registered.status,registered.text).toBe(201);
  const session = registered.body as Session;
  const post = (parts: Part[], spending = {}) => agent.post('/api/messages').set('x-csrf-token',session.csrf)
    .send({requestId:randomUUID(),parts,...spending});
  const send = async (parts: Part[], spending = {}): Promise<Message> => {
    const result = await post(parts,spending); expect(result.status,result.text).toBe(201); return result.body.message;
  };
  const target = await send([{id:'body',type:'text',text:'重复的目标，重复的目标'}]);
  return {app,agent,session,post,send,target};
}
afterEach(async () => {for (const app of apps.splice(0)) await app.close();await cleanupTestDatabases();});

it.each(['follow','block'] as const)('%s 可以直接发送是和否，互斥表态也使用同一标注及其理由',async name=>{
  const {app,send,target,session,post}=await setup();
  for(const reason of ['YES','NO'] as const){
    const original=await send([{...relation(name,{messageId:target.id}),reason}]);
    expect((await personalMarks(app.store,session.user.id,[target.id]))[0]?.[name==='follow'?'followed':'blocked']).toBe(reason==='YES');
    for(const stance of ['agree','disagree']){
      const result=await send([relation(stance,{messageId:original.id})]);
      expect(result.parts.find(part=>part.type==='relation')).toMatchObject({relation:name,reason:stance==='agree'?reason:reason==='YES'?'NO':'YES'});
    }
  }
  expect((await post([relation(name,{messageId:target.id})])).status).toBe(400);
  expect((await post([relation(`un${name}`,{messageId:target.id})])).status).toBe(400);
});

it('内置标注赞同复制原标注，反对生成明确的互斥项', async () => {
  const {send,target,app,session} = await setup();
  for (const [name,opposite] of Object.entries(ANNOTATION_OPPOSITES)) {
    const original = await send([relation(name,{messageId:target.id}),data({uiType:name.toUpperCase()})]);
    for (const [stance,expected] of [['agree',name],['disagree',opposite]]) {
      const result = await send([relation(stance!,{messageId:original.id})]);
      expect(result.parts.find(part => part.type === 'relation')).toMatchObject({relation:expected,
        roles:{target:[{reference:{messageId:target.id}}]}});
      expect(result.authorId).toBe(original.authorId);
      expect(result.id).not.toBe(original.id);
      if (expected === 'recommend' || expected === 'archive')
        expect((await personalMarks(app.store,session.user.id,[target.id]))[0]?.archived).toBe(expected === 'archive');
    }
  }
});

it.each([false,true])('自定义标注禁止反对，不创建消息、不收费，赞同仍可发送（含旧互斥字段：%s）', async legacyOpposite => {
  const {app,post,send,target,session} = await setup();
  const original = await send([relation('tag',{messageId:target.id}),data({label:'可靠',...(legacyOpposite?{oppositeLabel:'存疑'}:{})})]);
  const account = await app.store.account(session.user.id), sequence = await app.store.latestSequence();
  const rejected = await post([relation('disagree',{messageId:original.id})],{wager:7,recommendation:2});
  expect(rejected.status,rejected.text).toBe(400);
  expect(rejected.text).toContain('该标注没有互斥项，不能发送反对');
  expect(await app.store.account(session.user.id)).toEqual(account);
  expect(await app.store.latestSequence()).toBe(sequence);
  const agreed = await send([relation('agree',{messageId:original.id})]);
  expect(agreed.parts.find(part => part.type === 'relation')).toMatchObject({relation:'tag'});
  expect(agreed.parts.find(part => part.type === 'data')).toMatchObject({value:{label:'可靠'}});
});

it('内置互斥项双向转换，保留目标版本和重复文本位置，重试不重复执行', async () => {
  const {app,post,send,target,session} = await setup();
  const exact = {messageId:target.id,revision:1,partId:'body',range:{start:6,end:11}};
  const original = await send([relation('recommend',exact)],{wager:5,selfStance:'pro'});
  const input = [relation('disagree',{messageId:original.id,partId:'relation',path:['relation']})];
  const spending = {requestId:randomUUID(),wager:3,recommendation:2};
  const before = await app.store.account(session.user.id);
  const first = await post(input,spending);expect(first.status,first.text).toBe(201);
  const inverse = first.body.message as Message;
  expect(inverse.parts.find(part => part.id === 'relation')).toMatchObject({relation:'archive',roles:{target:[{reference:exact}]}});
  expect(inverse.spending).toEqual({protocol:1,recommendation:2,wager:3});
  expect(await app.store.account(session.user.id)).toMatchObject({available:before.available-6,locked:before.locked+3});
  const retry = await post(input,spending);expect(retry.body).toEqual(first.body);
  const again = await send([relation('disagree',{messageId:inverse.id})]);
  expect(again.parts.find(part => part.id === 'relation')).toMatchObject({relation:'recommend',roles:{target:[{reference:exact}]}});
  expect((await app.store.message(original.id)).parts).toEqual(original.parts);
});

it('标注正文和理由仍可普通反对，不误转标注，也不绕过具体地址', async () => {
  const {send,target} = await setup();
  const original = await send([relation('tag',{messageId:target.id}),{id:'reason',type:'text',text:'这里是理由'},data({label:'可靠'})]);
  const address = {messageId:original.id,revision:1,partId:'reason',range:{start:0,end:2}};
  const result = await send([relation('disagree',address)],{wager:1});
  expect(result.parts.find(part => part.type === 'relation')).toEqual(relation('disagree',address));
});

it('工作台命令返回转换后的类型和目标', async () => {
  const {agent,session,send,target} = await setup();
  const original = await send([relation('recommend',{messageId:target.id})]);
  const requestId = randomUUID();
  const response = await agent.post('/api/ui/commands').set('x-csrf-token',session.csrf).set('x-request-id',requestId)
    .send({requestId,commands:[{id:randomUUID(),method:'POST',path:'/relations',body:{relationType:'DISAGREE',targetRefs:[{kind:'relation',relationId:original.id}]}}]});
  expect(response.status,response.text).toBe(201);
  expect(response.body.results[0]).toMatchObject({relationType:'ARCHIVE',targetRefs:[{kind:'message',messageId:target.id}]});
});
