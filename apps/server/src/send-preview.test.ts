import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { cleanupTestDatabases, createTestApp, withTestCommandContributions } from './test-database.js';
import { sceneComputationKey } from '../../../frontend/src/utils/sceneComputationKey.js';
import { projectWorkbenchSnapshot } from '../../../frontend/src/utils/workbenchProjection.js';

afterEach(cleanupTestDatabases);
function layoutKey(page: Parameters<typeof projectWorkbenchSnapshot>[0]) {
  const { messages, edges } = projectWorkbenchSnapshot(page);
  return sceneComputationKey({input:{messages,edges}});
}
async function setup() {
  const app = await createTestApp(), agent = request.agent(app);
  const registration = await agent.post('/api/register').send({ name:'preview-user', password:'preview-password' });
  expect(registration.status,registration.text).toBe(201);
  const session = registration.body;
  const post = (path:string, body:Record<string,unknown>) => agent.post(`/api/ui${path}`).set('x-csrf-token',session.csrf).send(body);
  const create = async (path:string,body:Record<string,unknown>) => {
    const result=await post(path,withTestCommandContributions(path,body)); expect(result.status,result.text).toBe(201); return result.body;
  };
  const batch = (path:string,body:Record<string,unknown>) => withTestCommandContributions('/commands',{
    requestId:randomUUID(),commands:[{id:randomUUID(),method:'POST',path,body}],
  });
  return {app,agent,session,post,create,batch};
}

describe('unified send rehearsal',()=>{
  it.each(['TEXT','CODE','GOVERNANCE','OPERATIONS'])('previews %s without storing messages, charges, receipts or publishing changes',async kind=>{
    const {app,session,post,batch}=await setup();
    const body=batch('/messages',{kind,content:'发送前可见的内容'}),before=await app.store.latestSequence(),balance=await app.store.account(session.user.id);
    const preview=await post('/commands/preview',{batch:body}); expect(preview.status,preview.text).toBe(200);
    expect(preview.body.snapshots[0].messages.some((message:{content:string})=>message.content==='发送前可见的内容')).toBe(true);
    expect(await app.store.latestSequence()).toBe(before);
    expect(await app.store.account(session.user.id)).toEqual(balance);
    expect(Number((await app.store.db.prepare('SELECT COUNT(*) AS n FROM command_requests').get())!.n)).toBe(0);
    const committed=await post('/commands',body); expect(committed.status,committed.text).toBe(201);
    expect(committed.body.results[0].id).toBe(preview.body.messageIds[0]);
    expect(layoutKey(committed.body.snapshots[0])).toBe(layoutKey(preview.body.snapshots[0]));
  });

  it.each(['AGREE','DISAGREE','REFERENCE','REPLY','ANNOTATION','TAG','RECOMMEND','ARCHIVE','ATTENTION','BLOCK','NOTIFY'])('previews %s through its real rules and preserves the same generated identities',async relationType=>{
    const {app,session,post,batch,create}=await setup();
    const target=await create('/messages',{content:'预览的目标'});
    const body=batch('/relations',{relationType,targetRefs:[{kind:'message',messageId:target.id}],payload:{content:'预览关系',label:'标记',subType:'YES'}});
    const before=await app.store.latestSequence(),balance=await app.store.account(session.user.id);
    const preview=await post('/commands/preview',{batch:body}); expect(preview.status,preview.text).toBe(200);
    expect(await app.store.latestSequence()).toBe(before);expect(await app.store.account(session.user.id)).toEqual(balance);
    const actual=await post('/commands',body);expect(actual.status,actual.text).toBe(201);
    expect(layoutKey(actual.body.snapshots[0])).toBe(layoutKey(preview.body.snapshots[0]));
    expect(actual.body.snapshots.flatMap((page:{messages:Array<{id:string}>})=>page.messages.map(message=>message.id))).toEqual(
      preview.body.snapshots.flatMap((page:{messages:Array<{id:string}>})=>page.messages.map(message=>message.id)));
  });

  it.each(['CLASSIFY','MERGE','SUMMARY','ARRANGE'])('reuses %s generated JOIN IDs and the computed geometry after confirmation',async relationType=>{
    const {app,post,batch,create}=await setup();
    const first=await create('/messages',{content:'第一个成员'}),second=await create('/messages',{content:'第二个成员'});
    const body=batch('/relations',{relationType,targetRefs:[first,second].map(message=>({kind:'message',messageId:message.id})),payload:{title:'预览组织'}});
    const before=await app.store.latestSequence();
    const preview=await post('/commands/preview',{batch:body});expect(preview.status,preview.text).toBe(200);
    expect(await app.store.latestSequence()).toBe(before);
    expect(Number((await app.store.db.prepare('SELECT COUNT(*) AS n FROM memberships').get())!.n)).toBe(0);
    const actual=await post('/commands',body);expect(actual.status,actual.text).toBe(201);
    const projected=(response:typeof preview)=>projectWorkbenchSnapshot(response.body.snapshots[0]);
    const planned=projected(preview),confirmed=projected(actual);
    expect(confirmed.messages.map(message=>message.id)).toEqual(planned.messages.map(message=>message.id));
    expect(layoutKey(preview.body.snapshots[0])).toBe(layoutKey(actual.body.snapshots[0]));
  });

  it('rolls back an earlier command when a later preview command fails',async()=>{
    const {app,session,post,batch}=await setup();
    const body=batch('/messages',{content:'整个预览失败'}) as {requestId:string;commands:unknown[]};
    body.commands.push({id:randomUUID(),method:'POST',path:'/relations',body:{relationType:'REFERENCE',targetRefs:[{kind:'message',messageId:randomUUID()}],wager:1}});
    const before=await app.store.latestSequence(),balance=await app.store.account(session.user.id);
    const failed=await post('/commands/preview',{batch:body});expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(await app.store.latestSequence()).toBe(before);expect(await app.store.account(session.user.id)).toEqual(balance);
    expect(Number((await app.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE "authorId"=$1').get(session.user.id))!.n)).toBe(0);
  });

  it.each(['JOIN','CORRECT','DELEGATION','PROPOSAL','OPERATIONS','CODE_CHANGE'])('rehearses %s and confirms it exactly once',async relationType=>{
    const {app,session,post,batch,create}=await setup();
    const target=await create('/messages',{content:'可更正的原文字'});
    let body:Record<string,unknown>={relationType,targetRefs:[],payload:{content:'待发送操作'}};
    if(relationType==='JOIN'){
      const group=await create('/relations',{relationType:'CLASSIFY',targetRefs:[],payload:{title:'加入目标'}});
      body={relationType,sourceMessageId:group.id,targetRefs:[{kind:'message',messageId:target.id}]};
    }
    if(relationType==='CORRECT')body={relationType,targetRefs:[{kind:'text-fragment',messageId:target.id,text:'原文字',hash:'x',reference:{messageId:target.id,revision:1,partId:'body',range:{start:4,end:7}}}],payload:{correctionContent:'新文字'}};
    if(relationType==='DELEGATION')body={relationType,targetRefs:[],payload:{delegationKind:'CREATE',rewardAmount:5,content:'完成一项测试任务'}};
    if(relationType==='PROPOSAL'||relationType==='OPERATIONS')body={relationType,targetRefs:[],payload:{operationType:'REVENUE_INJECTION',content:'测试注入提案',amount:5,source:'测试'}};
    const envelope=batch('/relations',body),before=await app.store.latestSequence(),balance=await app.store.account(session.user.id);
    const preview=await post('/commands/preview',{batch:envelope});expect(preview.status,preview.text).toBe(200);
    expect(await app.store.latestSequence()).toBe(before);expect(await app.store.account(session.user.id)).toEqual(balance);
    const actual=await post('/commands',envelope);expect(actual.status,actual.text).toBe(201);
    expect(layoutKey(actual.body.snapshots[0])).toBe(layoutKey(preview.body.snapshots[0]));
    const after=await app.store.account(session.user.id),sequence=await app.store.latestSequence();
    expect((await post('/commands',envelope)).status).toBe(201);
    expect(await app.store.account(session.user.id)).toEqual(after);expect(await app.store.latestSequence()).toBe(sequence);
    expect(actual.body.results[0].id).toBe(preview.body.messageIds[0]);
  });

  it('previews opening, voting and closing a settlement without applying any of them',async()=>{
    const {app,session,post,batch,create}=await setup(),target=await create('/messages',{content:'仲裁测试目标'});
    const verify=async(path:string,body:Record<string,unknown>)=>{
      const input=batch(path,body),before=await app.store.latestSequence(),balance=await app.store.account(session.user.id);
      const preview=await post('/commands/preview',{batch:input});expect(preview.status,preview.text).toBe(200);
      expect(await app.store.latestSequence()).toBe(before);expect(await app.store.account(session.user.id)).toEqual(balance);
      const result=await post('/commands',input);expect(result.status,result.text).toBe(201);
      expect(layoutKey(result.body.snapshots[0])).toBe(layoutKey(preview.body.snapshots[0]));
      return result.body.results[0];
    };
    const round=await verify(`/messages/${target.id}/rounds`,{settlementType:'TRUTH'});
    await verify(`/rounds/${round.id}/votes`,{vote:'TRUE',amount:2});
    await verify(`/rounds/${round.id}/close-and-settle`,{});
  });
});
