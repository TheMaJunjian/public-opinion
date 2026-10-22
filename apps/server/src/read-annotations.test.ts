import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, cleanupTestDatabases } from './test-database.js';

const apps: Awaited<ReturnType<typeof createTestApp>>[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();await cleanupTestDatabases();});

it('charges the normal protocol fee for explicit read/unread messages and nothing for reading projections',async()=>{
  const app=await createTestApp();apps.push(app);
  const agent=request.agent(app),registration=await agent.post('/api/register').send({username:'阅读标注测试',password:'test-password-123'});
  expect(registration.status,registration.text).toBe(201);
  const post=async(body:object,path='/relations')=>{
    const response=await agent.post(`/api/ui${path}`).set('x-csrf-token',registration.body.csrf).set('x-request-id',randomUUID()).send(body);
    expect(response.status,response.text).toBe(201);return response.body;
  };
  const original=await post({content:'待阅读消息'},'/messages');
  const fee=(await app.store.rules()).protocolFee;
  for(const type of ['READ','UNREAD']){
    const before=await app.store.account(registration.body.user.id);
    const readDisplay={[original.id]:'display:1:16:abc:def'};
    const annotation=await post({relationType:type,targetRefs:[{kind:'message',messageId:original.id}],...(type==='READ'?{payload:{readDisplay}}:{})});
    expect(annotation.relationType).toBe(type);
    if(type==='READ')expect(annotation.payload.readDisplay).toEqual(readDisplay);
    const saved=await app.store.message(annotation.id);
    expect(saved.spending.protocol).toBe(fee);
    const after=await app.store.account(registration.body.user.id);
    expect(after.available).toBe(before.available-fee);expect(after.locked).toBe(before.locked);
  }
  const beforeAccount=await app.store.account(registration.body.user.id);
  const before=(await agent.get('/api/ui/snapshot')).body;
  for(let index=0;index<3;index++){
    const response=await agent.get('/api/ui/snapshot');expect(response.status,response.text).toBe(200);
    expect(response.body.sequence).toBe(before.sequence);
    expect(response.body.messages.map((record:{id:string})=>record.id)).toEqual(before.messages.map((record:{id:string})=>record.id));
  }
  expect(await app.store.account(registration.body.user.id)).toEqual(beforeAccount);
});
