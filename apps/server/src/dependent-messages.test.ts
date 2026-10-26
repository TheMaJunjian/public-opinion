import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { cleanupTestDatabases, createTestApp, withTestCommandContributions } from './test-database.js';
import { parentOf } from './ui-projections.js';
import { bindRoles } from '@gonglun/core';

afterEach(cleanupTestDatabases);
it('附属消息不生成加入记录，引用随来源、更正随目标，所有组织均拒绝附属成员', async () => {
  const app = await createTestApp(), agent = request.agent(app);
  const session = (await agent.post('/api/register').send({name:'附属关系测试',password:'test-password-123'})).body;
  const post = async (path:string,body:Record<string,unknown>) => agent.post(`/api/ui${path}`)
    .set('x-csrf-token',session.csrf).set('x-request-id',randomUUID()).send(withTestCommandContributions(path,body));
  const group = await post('/relations',{relationType:'CLASSIFY',targetRefs:[],payload:{title:'分类'}});
  expect(group.status,group.text).toBe(201);
  const source = await post('/messages',{content:'分类中的来源',parentMessageId:group.body.id});
  const target = await post('/messages',{content:'分类外目标'});
  const reference = await post('/relations',{relationType:'REFERENCE',sourceMessageId:source.body.id,targetRefs:[{kind:'message',messageId:target.body.id}],parentMessageId:group.body.id});
  const correction = await post('/relations',{relationType:'CORRECT',targetRefs:[{kind:'message',messageId:source.body.id}],payload:{correctionKind:'WIDTH',correctionWidth:640},parentMessageId:group.body.id});
  for (const result of [reference,correction]) {
    expect(result.status,result.text).toBe(201);
    expect(await parentOf(app.store,result.body.id)).toBe(group.body.id);
    expect(await app.store.db.prepare('SELECT 1 FROM memberships WHERE "memberId"=$1').get(result.body.id)).toBeUndefined();
    expect(await app.store.db.prepare("SELECT 1 FROM membership_actions WHERE body->>'memberId'=$1").get(result.body.id)).toBeUndefined();
    const join = await post('/relations',{relationType:'JOIN',sourceMessageId:group.body.id,targetRefs:[{kind:'message',messageId:result.body.id}]});
    expect(join.status,join.text).toBe(400);
    const native = await agent.post('/api/messages').set('x-csrf-token',session.csrf).send({requestId:randomUUID(),recommendation:1,parts:[
      {id:'relation',type:'relation',relation:'member-of',roles:bindRoles({parent:[{messageId:group.body.id}],member:[{messageId:result.body.id}]})},
    ]});
    expect(native.status,native.text).toBe(400);
    for (const relationType of ['CLASSIFY','SUMMARY','MERGE','ARRANGE']) {
      const response = await post('/relations',{relationType,targetRefs:[{kind:'message',messageId:result.body.id}],payload:{title:'组织'}});
      expect(response.status,response.text).toBe(400);
      expect(response.body.error).toContain('附属关系消息');
    }
  }
  const chain=await post('/relations',{relationType:'CORRECT',targetRefs:[{kind:'message',messageId:reference.body.id}],payload:{correctionKind:'WIDTH',correctionWidth:700}});
  expect(chain.status,chain.text).toBe(201);
  expect(await parentOf(app.store,chain.body.id)).toBe(group.body.id);
  for(const url of [`/api/ui/snapshot?parent=${group.body.id}`,`/api/ui/snapshot?mode=window&parent=${group.body.id}`]){
    const response=await agent.get(url);expect(response.status,response.text).toBe(200);
    expect(response.body.messages.map((message:{id:string})=>message.id)).toEqual(expect.arrayContaining([source.body.id,reference.body.id,correction.body.id,chain.body.id]));
  }
});
