import { testInvitation } from './test-database.js';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { cleanupTestDatabases, createTestApp, withTestCommandContributions } from './test-database.js';
import { sceneComputationKey } from '../../../frontend/src/utils/sceneComputationKey.js';
import { projectWorkbenchSnapshot } from '../../../frontend/src/utils/workbenchProjection.js';
import { projectGraphScene } from '../../../frontend/src/utils/graphProjection.js';
import { projectDiscussionBranches } from '../../../frontend/src/pages/workbench/model/discussionBranches.js';

afterEach(cleanupTestDatabases);
function layoutKey(page: Parameters<typeof projectWorkbenchSnapshot>[0]) {
  const { messages, edges } = projectWorkbenchSnapshot(page);
  return sceneComputationKey({input:{messages,edges}});
}
function presentation(page: Parameters<typeof projectWorkbenchSnapshot>[0]) {
  // Rehearsal and commit have different event sequences and wall-clock times.
  // Everything used to render the body, type, endpoints, votes and costs must match.
  const projected=projectWorkbenchSnapshot(page);
  const orders=[...new Set(projected.relations.flatMap(relation=>relation.payload?.membershipHistory?[relation.payload.membershipHistory.order]:[]))].sort((a,b)=>a-b);
  projected.relations.sort((a,b)=>a.id.localeCompare(b.id));
  return JSON.parse(JSON.stringify(projected, (key, value) => key === 'sequence' ? undefined
    : key === 'membershipHistory' && value ? {...value,order:orders.indexOf(value.order)}
    : key === 'assigned' && Array.isArray(value) ? [...value].sort()
    : typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value) ? '<time>' : value));
}
function expectSamePresentation(preview: Parameters<typeof projectWorkbenchSnapshot>[0], actual: Parameters<typeof projectWorkbenchSnapshot>[0]) {
  expect(layoutKey(actual)).toBe(layoutKey(preview));
  expect(presentation(actual)).toEqual(presentation(preview));
}
async function setup() {
  const app = await createTestApp({ moderation: true }), agent = request.agent(app);
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
  it.each(['question','answer'])('previews a %s reply as its source card and directed edge, with the same result after sending',async label=>{
    const {post,create}=await setup();
    const target=await create('/messages',{content:'讨论目标'}),sourceId=randomUUID(),relationId=randomUUID();
    const input=withTestCommandContributions('/commands',{requestId:randomUUID(),commands:[
      {id:sourceId,method:'POST',path:'/messages',body:{content:'疑问或回答的正文'}},
      {id:relationId,method:'POST',path:'/relations',body:{relationType:'REPLY',sourceMessageId:sourceId,
        targetRefs:[{kind:'message',messageId:target.id}],payload:{label}}},
    ]});
    const preview=await post('/commands/preview',{batch:input});expect(preview.status,preview.text).toBe(200);
    const projected=projectWorkbenchSnapshot(preview.body.snapshots[0]);
    const branches=projectDiscussionBranches({...projected,collapsed:[]});
    const scene=projectGraphScene({...projected,isTraceWindow:false,traceExpandedFrameIds:new Set(),discussionTargetIds:branches.textTargetIds});
    expect(scene.normalIds).toEqual(expect.arrayContaining([sourceId,target.id]));
    expect(scene.normalIds).not.toContain(relationId);
    expect(projected.edges).toContainEqual(expect.objectContaining({relationMessageId:relationId,relationType:'reply',relationLabel:label,
      from:expect.objectContaining({messageId:sourceId}),to:expect.objectContaining({messageId:target.id})}));
    const actual=await post('/commands',input);expect(actual.status,actual.text).toBe(201);
    expectSamePresentation(preview.body.snapshots[0],actual.body.snapshots[0]);
  });

  it.each(['REVIEW','OPERATIONS'].flatMap(relationType=>['pass','reject'].map(verdict=>({relationType,verdict}))))(
    'previews $relationType $verdict with the simulated review totals and no stored vote',async({relationType,verdict})=>{
    const {app,agent,session,post,create}=await setup();
    const target=await create('/messages',{content:'审核预览的目标'});
    const before=(await agent.get(`/api/moderation/messages/${target.id}`)).body;
    const input={requestId:randomUUID(),commands:[{id:randomUUID(),method:'POST',path:'/relations',body:{
      relationType,targetRefs:[{kind:'message',messageId:target.id,reference:{messageId:target.id,revision:1}}],
      reviewContext:{messageId:target.id,revision:1},reviewWager:2,wager:0,recommendation:0,
      payload:{caseId:before.summary.caseId,reviewRound:before.summary.round,verdict,content:verdict==='pass'?'可以核实的审核理由':'',
        ...(relationType==='OPERATIONS'?{operationType:'REVIEW'}:{})},
    }}]};
    const balance=await app.store.account(session.user.id),sequence=await app.store.latestSequence();
    const preview=await post('/commands/preview',{batch:input});expect(preview.status,preview.text).toBe(200);
    const projected=preview.body.snapshots[0].messages.find((message:{id:string})=>message.id===target.id);
    expect(projected.moderation).toMatchObject({pass:verdict==='pass'?12:10,reject:verdict==='reject'?2:0,reviewerCount:1});
    expect((await agent.get(`/api/moderation/messages/${target.id}`)).body.summary).toEqual(before.summary);
    expect(await app.store.account(session.user.id)).toEqual(balance);expect(await app.store.latestSequence()).toBe(sequence);
    expect(await app.store.db.prepare('SELECT id FROM messages WHERE id=$1').get(input.commands[0]!.id)).toBeUndefined();
    const actual=await post('/commands',input);expect(actual.status,actual.text).toBe(201);
    expectSamePresentation(preview.body.snapshots[0],actual.body.snapshots[0]);
    const detail=(await agent.get(`/api/moderation/messages/${target.id}`)).body;
    expect(detail.summary).toMatchObject(projected.moderation);
    expect(detail.records.find((record:{id:string})=>record.id===input.commands[0]!.id).payload.verdict).toBe(verdict);
  });

  it.each([
    {name:'Markdown',body:{contentType:'MARKDOWN',content:'# 标题\n\n**内容**'}},
    {name:'web excerpt',body:{parts:[{id:'web',type:'web',url:'https://example.com/source',excerpt:'网页摘录'}]}},
    {name:'mixed parts',body:{parts:[{id:'body',type:'text',text:'代码说明'},{id:'code',type:'code',language:'js',source:'const value = 1;'}]}},
  ])('keeps $name content and moderation metadata identical after confirmation',async({body})=>{
    const {post,batch}=await setup(),input=batch('/messages',body);
    const preview=await post('/commands/preview',{batch:input});expect(preview.status,preview.text).toBe(200);
    const actual=await post('/commands',input);expect(actual.status,actual.text).toBe(201);
    expectSamePresentation(preview.body.snapshots[0],actual.body.snapshots[0]);
  });

  it.each([
    {relationType:'REFERENCE',payload:{label:'证据'}}, {relationType:'REFERENCE',payload:{label:'自定义关系'}},
    {relationType:'REPLY',payload:{label:'question'}}, {relationType:'REPLY',payload:{label:'answer'}},
    {relationType:'TAG',payload:{label:'自定义标签'}}, {relationType:'RECOMMEND',payload:{subType:'IMPORTANT'}},
    ...['SPAM','OFFTOPIC','LOWVALUE'].map(subType=>({relationType:'ARCHIVE',payload:{subType}})),
    ...['ATTENTION','BLOCK'].flatMap(relationType=>['YES','NO'].map(subType=>({relationType,payload:{subType}}))),
    {relationType:'CORRECT',payload:{correctionKind:'WIDTH',correctionWidth:800}},
  ])('preserves the $relationType subtype $payload in the preview and the stored message',async({relationType,payload})=>{
    const {post,batch,create}=await setup(),target=await create('/messages',{content:'子类型目标'});
    const input=batch('/relations',{relationType,targetRefs:[{kind:'message',messageId:target.id}],payload});
    const preview=await post('/commands/preview',{batch:input});expect(preview.status,preview.text).toBe(200);
    const actual=await post('/commands',input);expect(actual.status,actual.text).toBe(201);
    expectSamePresentation(preview.body.snapshots[0],actual.body.snapshots[0]);
  });

  it.each(['REFERENCE','REPLY','ANNOTATION'])('keeps a composed text and %s batch consistent',async relationType=>{
    const {post,create}=await setup(),target=await create('/messages',{content:'被讨论的目标'}),sourceId=randomUUID();
    const input=withTestCommandContributions('/commands',{requestId:randomUUID(),commands:[
      {id:sourceId,method:'POST',path:'/messages',body:{content:'新建的来源正文'}},
      {id:randomUUID(),method:'POST',path:'/relations',body:{relationType,sourceMessageId:sourceId,targetRefs:[{kind:'message',messageId:target.id}]}},
    ]});
    const preview=await post('/commands/preview',{batch:input});expect(preview.status,preview.text).toBe(200);
    const actual=await post('/commands',input);expect(actual.status,actual.text).toBe(201);
    expectSamePresentation(preview.body.snapshots[0],actual.body.snapshots[0]);
  });

  it.each(['AUTHORIZE','FULFILL'])('previews the %s execution and generated result records',async type=>{
    const {app,post,batch,create}=await setup();
    const target=type==='AUTHORIZE'
      ?await create('/relations',{relationType:'PROPOSAL',targetRefs:[],payload:{operationType:'REVENUE_INJECTION',amount:5,source:'测试',content:'注入提案'}})
      :await create('/relations',{relationType:'DELEGATION',targetRefs:[],payload:{delegationKind:'CREATE',rewardAmount:5,content:'测试委托'}});
    if(type==='AUTHORIZE')await app.store.db.prepare('UPDATE moderation_cases SET status=$1 WHERE "messageId"=$2').run('approved',target.id);
    const input=batch('/relations',{relationType:type==='FULFILL'?'DELEGATION':type,targetRefs:[{kind:'message',messageId:target.id}],
      ...(type==='FULFILL'?{payload:{delegationKind:'FULFILL',content:'完成说明'}}:{})});
    const preview=await post('/commands/preview',{batch:input});expect(preview.status,preview.text).toBe(200);
    const actual=await post('/commands',input);expect(actual.status,actual.text).toBe(201);
    expectSamePresentation(preview.body.snapshots[0],actual.body.snapshots[0]);
  });

  it.each(['settlement','legacy finalization'])('previews review %s and appeal using the simulated visibility rules',async mode=>{
    const {app,agent,session,create}=await setup(),secret='仅供审核的原文 PREVIEW-SECRET';
    const target=await create('/messages',{content:secret});
    const reviewers:Array<{agent:ReturnType<typeof request.agent>;session:{csrf:string;user:{id:string}}}>=[];
    for(const name of ['preview-reviewer-one','preview-reviewer-two']){
      const reviewer=request.agent(app);
      const registration=await reviewer.post('/api/register').send({name,password:'preview-password',inviteCode:await testInvitation(app)});
      expect(registration.status,registration.text).toBe(201);
      const review=await reviewer.post('/api/ui/relations').set('x-csrf-token',registration.body.csrf).send({
        relationType:'REVIEW',targetRefs:[{kind:'message',messageId:target.id,reference:{messageId:target.id,revision:1}}],
        reviewWager:8,payload:{verdict:'reject',content:'审核理由 PREVIEW-REASON'},
      });
      expect(review.status,review.text).toBe(201);reviewers.push({agent:reviewer,session:registration.body});
    }
    const verify=async(actor:typeof reviewers[number],relationType:string,restricted=false)=>{
      const before=await app.store.latestSequence(),balance=await app.store.account(actor.session.user.id);
      const input={requestId:randomUUID(),commands:[{id:randomUUID(),method:'POST',path:'/relations',body:{
        relationType,targetRefs:[{kind:'message',messageId:target.id,reference:{messageId:target.id,revision:1}}],
        payload:relationType==='REVIEW-APPEAL'?{content:'请求复核'}:{},
      }}]};
      const post=(path:string,body:object)=>actor.agent.post(`/api/ui${path}`).set('x-csrf-token',actor.session.csrf).send(body);
      const preview=await post('/commands/preview',{batch:input});expect(preview.status,preview.text).toBe(200);
      expect(await app.store.latestSequence()).toBe(before);expect(await app.store.account(actor.session.user.id)).toEqual(balance);
      if(restricted){
        expect(preview.text).not.toContain(secret);expect(preview.text).not.toContain('PREVIEW-REASON');
        expect(preview.body.snapshots[0].messages.find((message:{id:string})=>message.id===target.id)).toMatchObject({restricted:true,moderation:{status:'rejected',finalized:true}});
      }
      const actual=await post('/commands',input);expect(actual.status,actual.text).toBe(201);
      expectSamePresentation(preview.body.snapshots[0],actual.body.snapshots[0]);
    };
    if(mode==='legacy finalization'){
      await app.store.db.prepare(`UPDATE moderation_cases SET status='rejected',"releaseAt"=$1,settlement=$2::jsonb WHERE "messageId"=$3`)
        .run('2099-01-01T00:00:00.000Z',JSON.stringify({verdict:'reject',payouts:[],fund:0,finalized:false,voteIds:[],messageId:target.id}),target.id);
      await verify(reviewers[0]!,'REVIEW-FINALIZE',true);
    }else await verify(reviewers[0]!,'REVIEW-SETTLE',true);
    await verify({agent,session},'REVIEW-APPEAL');
  });

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
    expectSamePresentation(preview.body.snapshots[0],committed.body.snapshots[0]);
  });

  it.each(['AGREE','DISAGREE','REFERENCE','REPLY','ANNOTATION','TAG','RECOMMEND','ARCHIVE','ATTENTION','BLOCK','NOTIFY'])('previews %s through its real rules and preserves the same generated identities',async relationType=>{
    const {app,session,post,batch,create}=await setup();
    const target=await create('/messages',{content:'预览的目标'});
    if(relationType==='NOTIFY'){
      const follower=request.agent(app),registration=await follower.post('/api/register').send({inviteCode:await testInvitation(app),name:'通知预览接收者',password:'preview-password'});
      const follow=await follower.post('/api/ui/relations').set('x-csrf-token',registration.body.csrf)
        .send({relationType:'ATTENTION',recommendation:1,targetRefs:[{kind:'message',messageId:target.id}],payload:{subType:'YES'}});
      expect(follow.status,follow.text).toBe(201);
    }
    const body=batch('/relations',{relationType,targetRefs:[{kind:'message',messageId:target.id}],payload:{content:'预览关系',label:'标记',subType:'YES'}});
    const before=await app.store.latestSequence(),balance=await app.store.account(session.user.id);
    const preview=await post('/commands/preview',{batch:body}); expect(preview.status,preview.text).toBe(200);
    expect(await app.store.latestSequence()).toBe(before);expect(await app.store.account(session.user.id)).toEqual(balance);
    const actual=await post('/commands',body);expect(actual.status,actual.text).toBe(201);
    expectSamePresentation(preview.body.snapshots[0],actual.body.snapshots[0]);
    expect(actual.body.snapshots.flatMap((page:{messages:Array<{id:string}>})=>page.messages.map(message=>message.id)).sort()).toEqual(
      preview.body.snapshots.flatMap((page:{messages:Array<{id:string}>})=>page.messages.map(message=>message.id)).sort());
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
    expectSamePresentation(preview.body.snapshots[0],actual.body.snapshots[0]);
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
    expectSamePresentation(preview.body.snapshots[0],actual.body.snapshots[0]);
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
      expectSamePresentation(preview.body.snapshots[0],result.body.snapshots[0]);
      return result.body.results[0];
    };
    const round=await verify(`/messages/${target.id}/rounds`,{settlementType:'TRUTH'});
    await verify(`/rounds/${round.id}/votes`,{vote:'TRUE',amount:2});
    await verify(`/rounds/${round.id}/close-and-settle`,{});
  });
});
