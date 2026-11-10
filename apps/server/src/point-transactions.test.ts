import { testInvitation } from './test-database.js';
import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { Mutation } from './db.js';
import { cleanupTestDatabases, createTestApp } from './test-database.js';
import { updateUsagePoints } from './usage-points.js';
import { distribution } from './economy.js';
import { bindRoles } from '@gonglun/core';
import {enrollModeration} from './moderation.js';
import {randomUUID} from 'node:crypto';

afterEach(cleanupTestDatabases);
it('keeps the reviewed version for native reviews of a category',async()=>{
  const app=await createTestApp({moderation:true}),agent=request.agent(app),store=app.store;
  const {body:owner}=await agent.post('/api/register').send({name:'分类审核者',password:'password'});
  const post=(path:string,body:Record<string,unknown>)=>agent.post(`/api${path}`).set('x-csrf-token',owner.csrf)
    .set('x-request-id',randomUUID()).send(body);
  const child=await post('/ui/messages',{content:'分类成员',recommendation:1});
  expect(child.status,child.text).toBe(201);
  const target=await post('/ui/relations',{relationType:'CLASSIFY',targetRefs:[{kind:'message',messageId:child.body.id}],
    payload:{title:'REVIEWED-CATEGORY-ORIGINAL'},recommendation:1});
  expect(target.status,target.text).toBe(201);
  const review=await post('/messages',{requestId:randomUUID(),reviewWager:2,parts:[
    {id:'relation',type:'relation',relation:'review',roles:bindRoles({target:[{messageId:target.body.id}]})},
    {id:'data',type:'data',value:{verdict:'pass'}},
  ]});
  expect(review.status,review.text).toBe(201);
  await store.transaction(async()=>{
    const tx=new Mutation(store),original=await store.message(target.body.id);
    await tx.put({...original,revision:2,parts:[{id:'body',type:'text',text:'REVIEWED-CATEGORY-NEW-VERSION'}]});
    await tx.commit();
  });
  const response=await agent.get('/api/ui/points/transactions').query({mode:'summary',messageId:review.body.message.id});
  expect(response.status,response.text).toBe(200);
  expect(response.body.data[0].messages).toContainEqual(expect.objectContaining({messageId:target.body.id,messageRevision:1,
    messageType:'分类',summary:'REVIEWED-CATEGORY-ORIGINAL'}));
});

it.each([false,true])('includes reviewed message identities and Chinese audit types without exposing restricted content (%s)',async restricted=>{
  const app=await createTestApp({moderation:true}),agent=request.agent(app),store=app.store;
  const {body:owner}=await agent.post('/api/register').send({name:'审核收支查看者',password:'password'});
  const {body:author}=await request(app).post('/api/register').send({inviteCode:await testInvitation(app),name:'被审核作者',password:'password'});
  const kinds=[['review','审核'],['review-appeal','复核申请'],['review-settle','审核结算'],['review-finalize','审核资金划转'],
    ['review-record','审核记录'],['review-enrollment','纳入审核'],['reviewer-authorize','审核资格授权']];
  let targetId='';
  const records:Array<{id:string;label:string}>=[];
  await store.transaction(async()=>{
    const tx=new Mutation(store),target=await tx.create(author.user.id,[{id:'body',type:'text',text:'REVIEW-TARGET-ORIGINAL'}]);
    targetId=target.id;await enrollModeration(tx,target);
    for(const [relation,label] of kinds){
      const record=await tx.create('system',[{id:'body',type:'text',text:'REVIEW-AUDIT-CONTENT'},
        {id:'relation',type:'relation',relation:relation!,roles:bindRoles({target:[{messageId:target.id,revision:1}]})}]);
      records.push({id:record.id,label:label!});
      await store.ledger(owner.user.id,record.id,-1,0,'协议费');await store.operating(1);
    }
    await tx.put({...target,revision:2,parts:[{id:'body',type:'text',text:'REVIEW-TARGET-NEW-VERSION'}]});
    await tx.commit();
    if(restricted)await store.db.prepare("UPDATE moderation_cases SET status='rejected' WHERE \"messageId\"=$1").run(target.id);
  });
  const before=await store.account(owner.user.id),history=await agent.get('/api/ui/points/transactions');
  expect(history.status,history.text).toBe(200);
  const operation=history.body.data.find((row:{entryCount:number})=>row.entryCount===kinds.length);
  expect(operation).toBeDefined();
  const detail=await agent.get('/api/ui/points/transactions').query({mode:'summary',operationId:operation.operationId});
  expect(detail.status,detail.text).toBe(200);
  for(const response of [history,detail]){
    const row=response.body.data.find((entry:{operationId:string})=>entry.operationId===operation.operationId);
    expect(row.messages.filter((message:{messageId:string})=>message.messageId===targetId)).toEqual([
      expect.objectContaining({messageId:targetId,messageRevision:1,...restricted?{restricted:true}:{messageType:'文本',summary:'REVIEW-TARGET-ORIGINAL'}}),
    ]);
    for(const record of records)expect(row.messages).toContainEqual(expect.objectContaining({messageId:record.id,...restricted?{}:{messageType:record.label}}));
    expect(response.text).not.toContain('REVIEW-TARGET-NEW-VERSION');
    if(restricted){expect(response.text).not.toContain('REVIEW-TARGET-ORIGINAL');expect(response.text).not.toContain('REVIEW-AUDIT-CONTENT');}
  }
  expect(await store.account(owner.user.id)).toEqual(before);
});

it('orders message groups and their details by latest record time before pagination',async()=>{
  const app=await createTestApp(),agent=request.agent(app),store=app.store;
  const {body:owner}=await agent.post('/api/register').send({name:'倒序记录用户',password:'password'});
  let messageId='',otherId='';
  await store.transaction(async()=>{
    await store.db.prepare('UPDATE ledger SET "createdAt"=$2 WHERE "userId"=$1').run(owner.user.id,'2026-11-08T00:00:00Z');
    const tx=new Mutation(store),message=await tx.create('system',[{id:'body',type:'text',text:'合并消息'}]);messageId=message.id;
    const other=await tx.create('system',[{id:'body',type:'text',text:'另一消息'}]);otherId=other.id;
    for(const [id,at,reason] of [[messageId,'2026-11-09T03:00:00Z','最新'],[otherId,'2026-11-09T02:00:00Z','中间'],[messageId,'2026-11-09T01:00:00Z','较早']]){
      const entry=await store.ledger(owner.user.id,id,-1,0,reason);
      await store.db.prepare('UPDATE ledger SET "createdAt"=$2 WHERE id=$1').run(entry.id,at);await store.operating(1);
    }
    await tx.commit();
  });
  const first=await agent.get('/api/ui/points/transactions?mode=summary&limit=1');
  expect(first.status,first.text).toBe(200);
  expect(first.body.data).toEqual([expect.objectContaining({messageId,createdAt:'2026-11-09T03:00:00Z',amount:-2,entries:[
    expect.objectContaining({reason:'最新'}),expect.objectContaining({reason:'较早'}),
  ]})]);
  const second=await agent.get('/api/ui/points/transactions?mode=summary&page=2&limit=1');
  expect(second.body.data).toEqual([expect.objectContaining({messageId:otherId,createdAt:'2026-11-09T02:00:00Z'})]);
});
it.each([false,true])('groups the same message before pagination and retains every ledger entry when restricted=%s',async restricted=>{
  const app=await createTestApp({moderation:true}),agent=request.agent(app),store=app.store;
  const {body:owner}=await agent.post('/api/register').send({name:'资金记录用户',password:'password'});
  const {body:author}=await request(app).post('/api/register').send({inviteCode:await testInvitation(app),name:'正文作者',password:'password'});
  let messageId='',otherId='';
  await store.transaction(async()=>{
    const tx=new Mutation(store),message=await tx.create(author.user.id,[{id:'body',type:'text',text:'PRIVATE-LEDGER-CONTENT'}]);
    messageId=message.id;await enrollModeration(tx,message);
    const other=await tx.create('system',[{id:'body',type:'text',text:'另一条消息'}]);otherId=other.id;
    await store.ledger(owner.user.id,message.id,-2,2,'审核押注冻结');
    await store.ledger(owner.user.id,other.id,-1,0,'协议费');await store.operating(1);
    await tx.put({...message,revision:2,parts:[{id:'body',type:'text',text:'PRIVATE-LEDGER-NEW-REVISION'}]});
    await store.ledger(owner.user.id,message.id,0,-2,'审核押注解除锁定');
    await store.ledger(owner.user.id,message.id,2,0,restricted?'PRIVATE-LEDGER-REASON':'审核押注结算');
    await tx.commit();
    if(restricted)await store.db.prepare("UPDATE moderation_cases SET status='rejected' WHERE \"messageId\"=$1").run(messageId);
  });
  const before=await store.account(owner.user.id),count=(await store.db.prepare('SELECT COUNT(*) AS n FROM ledger').get())!.n;
  const history=await agent.get('/api/ui/points/transactions?limit=2');
  expect(history.status,history.text).toBe(200);
  expect(history.body.pagination).toEqual({page:1,limit:2,total:2,totalPages:1});
  expect(history.body.data[0]).toMatchObject({type:'OPERATION_GROUP',amount:-1,entryCount:4,balanceAfter:before.available});
  expect(history.body.data.every((row:{entries?:unknown})=>!row.entries)).toBe(true);
  expect(history.body.data[0].reasonDetails).toHaveLength(4);
  if(restricted){
    expect(history.text).not.toContain('PRIVATE-LEDGER');
    expect(history.body.data[0].reasonDetails[0]).toMatchObject({reason:'受限内容相关记录',amount:2,lockedDelta:0});
  }
  const operation=await agent.get('/api/ui/points/transactions').query({mode:'summary',operationId:history.body.data[0].operationId});
  expect(operation.body.data[0]).toMatchObject({type:'OPERATION_GROUP',amount:-1,entryCount:4});
  expect(operation.body.data[0].entries.map((row:{messageId:string})=>row.messageId)).toEqual([messageId,messageId,otherId,messageId]);
  expect(operation.body.data[0].messages).toEqual(expect.arrayContaining([expect.objectContaining({messageId}),expect.objectContaining({messageId:otherId,messageType:'文本'})]));
  if(restricted){expect(operation.text).not.toContain('PRIVATE-LEDGER');expect(operation.body.data[0].entries[0].restricted).toBe(true);}
  const filtered=await agent.get('/api/ui/points/transactions').query({mode:'summary',messageId});
  expect(filtered.body.pagination.total).toBe(1);expect(filtered.body.data[0]).toMatchObject({messageId,entryCount:3,amount:0});
  const first=await agent.get('/api/ui/points/transactions?mode=summary&limit=1');
  expect(first.status,first.text).toBe(200);expect(first.body.pagination).toEqual({page:1,limit:1,total:3,totalPages:3});
  expect(first.body.data).toEqual([expect.objectContaining({messageId,type:'MESSAGE_GROUP',amount:0,lockedDelta:0,entryCount:3,entries:[
    expect.objectContaining({messageId,messageRevision:2,amount:2,lockedDelta:0,reason:restricted?'受限内容相关记录':'审核押注结算'}),
    expect.objectContaining({messageId,messageRevision:2,amount:0,lockedDelta:-2,reason:'审核押注解除锁定'}),
    expect.objectContaining({messageId,messageRevision:1,amount:-2,lockedDelta:2,reason:'审核押注冻结'}),
  ]})]);
  expect(first.body.data[0].balanceAfter).toBe(before.available);
  if(restricted){expect(first.text).not.toContain('PRIVATE-LEDGER');expect(first.body.data[0].restricted).toBe(true);}
  else expect(first.body.data[0].messages).toEqual([expect.objectContaining({messageId,messageRevision:2})]);
  const second=await agent.get('/api/ui/points/transactions?mode=summary&page=2&limit=1');
  expect(second.body.data).toEqual([expect.objectContaining({messageId:otherId,amount:-1,type:'SPEND'})]);
  expect(await store.account(owner.user.id)).toEqual(before);
  expect((await store.db.prepare('SELECT COUNT(*) AS n FROM ledger').get())!.n).toBe(count);
});
it('既有逐点奖励与新的累计奖励按北京时间归并，在合并后分页，保留普通收支余额和账户隔离', async () => {
  const app = await createTestApp({ initialGrant: 0 }), agent = request.agent(app), store = app.store;
  const { body: session } = await agent.post('/api/register').send({ name: '奖励汇总', password: 'password' });
  await request(app).post('/api/register').send({inviteCode:await testInvitation(app), name: '另一用户', password: 'password' });
  const sourceIds: string[] = [];
  await store.transaction(async () => {
    const tx = new Mutation(store), message = await tx.create('system', [{ id: 'body', type: 'text', text: '历史奖励' }]);
    const secondMessage = await tx.create('system', [{ id: 'body', type: 'text', text: '另一历史奖励' }]);
    sourceIds.push(message.id, secondMessage.id);
    for (let i = 0; i < 120; i++) {
      const entry = await store.ledger(session.user.id, sourceIds[i % 2], 1, 0, '使用公论计时奖励');
      await store.db.prepare('UPDATE ledger SET "createdAt"=$2 WHERE id=$1').run(entry.id, '2026-10-31T15:59:59.000Z');
    }
    const spend = await store.ledger(session.user.id, message.id, -10, 0, '协议费');
    await store.db.prepare('UPDATE ledger SET "createdAt"=$2 WHERE id=$1').run(spend.id, '2026-10-31T15:59:59.500Z');
    await tx.put({ ...message, revision: 2, parts: [{ id: 'body', type: 'text', text: '后来修改的正文' }] });
    await store.operating(10);await store.set('minted', 120);await tx.commit();
  });
  const time = Date.parse('2026-11-01T00:00:00+08:00');
  const first = await updateUsagePoints(store, session.user.id, { action: 'start' }, time);
  const second = await updateUsagePoints(store, session.user.id, { action: 'tick', roundId: first.roundId }, time + 1000);
  await updateUsagePoints(store, session.user.id, { action: 'tick', roundId: second.roundId }, time + 3000);
  const before = await store.account(session.user.id), ledgerCount = (await store.db.prepare('SELECT COUNT(*) AS n FROM ledger').get())!.n;
  const response = await agent.get('/api/ui/points/transactions?limit=2');
  expect(response.status, response.text).toBe(200);
  expect(response.body.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
  expect(response.body.data[0]).toMatchObject({ type: 'USAGE_REWARD', amount: 2, data: { day: '2026-11-01', count: 2 } });
  expect(response.body.data[1]).toMatchObject({ type: 'OPERATION_GROUP', amount: -10, balanceAfter: 110, entryCount:1 });
  expect(response.body.data[1].messages).toEqual([{ messageId: sourceIds[0], messageRevision: 1, messageType: '文本', summary: '历史奖励', scopeMessageId: 'root' }]);
  expect(response.body.data[0].messages).toHaveLength(1);
  const detail=await agent.get('/api/ui/points/transactions?mode=summary&day=2026-11-01');
  expect(detail.body.pagination.total).toBe(1);
  expect(detail.body.data[0]).toMatchObject({type:'USAGE_REWARD',amount:2,data:{day:'2026-11-01',count:2}});
  expect(detail.body.data[0].entries).toBeUndefined();
  const older = await agent.get('/api/ui/points/transactions?page=2&limit=2');
  expect(older.body.data).toHaveLength(1);
  expect(older.body.data[0]).toMatchObject({ type: 'USAGE_REWARD', amount: 120, data: { day: '2026-10-31', count: 120 } });
  expect(older.body.data[0].messages).toHaveLength(2);
  expect(older.body.data[0].messages.map((message: { messageId: string }) => message.messageId).sort()).toEqual([...sourceIds].sort());
  const empty = await agent.get('/api/ui/points/transactions?page=3&limit=2');
  expect(empty.body.data).toEqual([]);expect(empty.body.pagination.total).toBe(3);
  expect(await store.account(session.user.id)).toEqual(before);
  expect((await store.db.prepare('SELECT COUNT(*) AS n FROM ledger').get())!.n).toBe(ledgerCount);
  const other = request.agent(app);await other.post('/api/login').send({ name: '另一用户', password: 'password' });
  expect((await other.get('/api/ui/points/transactions')).body.data).toEqual([]);
});

it('关系消息摘要沿用正文投影，结算流水包含结算记录和原版本目标', async () => {
  const app = await createTestApp(), agent = request.agent(app), store = app.store;
  const { body: session } = await agent.post('/api/register').send({ name: '消息入口', password: 'password' });
  let relationId = '', resultId = '', targetId = '';
  await store.transaction(async () => {
    const tx = new Mutation(store);
    const target = await tx.create('system', [{ id: 'body', type: 'text', text: '支持公开讨论' }]);
    targetId = target.id;
    const relation = await tx.create(session.user.id, [{ id: 'relation', type: 'relation', relation: 'agree', roles: bindRoles({ target: [{ messageId: target.id, revision: 1 }] }) }]);
    relationId = relation.id;
    await store.ledger(session.user.id, relation.id, -1, 0, '协议费');
    await store.operating(1);
    const result = await distribution(tx, { messageId: target.id, revision: target.revision }, { source: 'wager', total: 0, ruleVersion: 1, inputs: { roundId: 'fixture-round' }, allocations: [] });
    resultId = result.id;
    await store.ledger(session.user.id, result.id, 0, 0, '结算记录');
    await tx.put({ ...target, revision: 2, parts: [{ id: 'body', type: 'code', language: 'text', source: '后来修改的内容' }] });
    await tx.commit();
  });
  const response = await agent.get('/api/ui/points/transactions?mode=summary');
  expect(response.status, response.text).toBe(200);
  const relation = response.body.data.find((row: { messageId: string }) => row.messageId === relationId);
  expect(relation.messages).toEqual([expect.objectContaining({ messageId: relationId, messageType: '赞同', summary: '赞同：「支持公开讨论」' })]);
  const result = response.body.data.find((row: { messageId: string }) => row.messageId === resultId);
  expect(result.data.roundId).toBe('fixture-round');
  expect(result.messages).toEqual([
    expect.objectContaining({ messageId: resultId, messageType: '结算', summary: '对赌分配：0 贡献点。', roundId: 'fixture-round' }),
    { messageId: targetId, messageRevision: 1, messageType: '文本', summary: '支持公开讨论', scopeMessageId: 'root' },
  ]);
});

it('groups one text-and-reference send with its protocol, stakes and review funding, retaining retries and account isolation',async()=>{
  const app=await createTestApp({moderation:true}),agent=request.agent(app),store=app.store;
  const {body:session}=await agent.post('/api/register').send({name:'操作汇总用户',password:'password'});
  const post=(path:string,body:{requestId?:string;[key:string]:unknown})=>agent.post(`/api/ui${path}`).set('x-csrf-token',session.csrf).set('x-request-id',body.requestId??randomUUID()).send(body);
  const target=await post('/messages',{content:'引用目标',wager:1,selfAgree:true});expect(target.status,target.text).toBe(201);
  const fullText='一键发送正文，详情应完整展示。'.repeat(20)+'完整末尾。';
  const batch=()=>{const textId=randomUUID(),referenceId=randomUUID();return {requestId:randomUUID(),commands:[
    {id:textId,method:'POST',path:'/messages',body:{content:fullText,wager:2,selfAgree:true}},
    {id:referenceId,method:'POST',path:'/relations',body:{relationType:'REFERENCE',sourceMessageId:textId,targetRefs:[{kind:'message',messageId:target.body.id}],wager:3,selfAgree:true}},
  ]};};
  const input=batch(),before=await store.account(session.user.id);
  const mappings=()=>store.db.prepare('SELECT COUNT(*) AS n FROM ledger_operations').get<{n:number}>();
  const beforePreview=await mappings();
  const preview=await post('/commands/preview',{batch:input});expect(preview.status,preview.text).toBe(200);
  expect(await mappings()).toEqual(beforePreview);expect(await store.account(session.user.id)).toEqual(before);
  const sent=await post('/commands',input);expect(sent.status,sent.text).toBe(201);
  const after=await store.account(session.user.id);
  const list=await agent.get('/api/ui/points/transactions?limit=1');expect(list.status,list.text).toBe(200);
  const operation=list.body.data[0];
  expect(operation).toMatchObject({type:'OPERATION_GROUP',amount:after.available-before.available,lockedDelta:after.locked-before.locked,entryCount:6,balanceAfter:after.available});
  expect(operation.messages.map((m:{messageId:string})=>m.messageId)).toEqual(input.commands.map(c=>c.id));
  expect(operation.messages[0].summary).toBe(fullText.slice(0,240));
  expect(operation.reasonDetails).toHaveLength(6);
  expect(operation.reasonDetails).toEqual(expect.arrayContaining([
    expect.objectContaining({reason:'审核费冻结',amount:-6,lockedDelta:6,messageId:input.commands[0].id}),
    expect.objectContaining({reason:'审核自押冻结',amount:-10,lockedDelta:10,messageId:input.commands[0].id}),
  ]));
  expect(operation.reasonDetails.reduce((sum:number,row:{amount:number})=>sum+row.amount,0)).toBe(operation.amount);
  expect(operation.reasonDetails.reduce((sum:number,row:{lockedDelta:number})=>sum+row.lockedDelta,0)).toBe(operation.lockedDelta);
  const details=await agent.get('/api/ui/points/transactions').query({mode:'summary',operationId:operation.operationId,limit:1});
  expect(details.body.pagination.total).toBe(1);
  expect(details.body.data[0].messages.find((message:{messageId:string})=>message.messageId===input.commands[0].id).summary).toBe(fullText);
  const items=details.body.data[0].entries;
  expect(items.map((e:{reason:string})=>e.reason)).toEqual(expect.arrayContaining(['协议费','对赌锁定','审核费冻结','审核自押冻结']));
  for(const command of input.commands)expect(items.filter((e:{messageId:string})=>e.messageId===command.id).map((e:{reason:string})=>e.reason))
    .toEqual(expect.arrayContaining(['协议费','对赌锁定']));
  const count=list.body.pagination.total;
  const retry=await post('/commands',input);expect(retry.status,retry.text).toBe(201);
  expect(await store.account(session.user.id)).toEqual(after);
  expect((await agent.get('/api/ui/points/transactions?limit=1')).body.data[0].operationId).toBe(operation.operationId);
  const next=await post('/commands',batch());expect(next.status,next.text).toBe(201);
  const updated=await agent.get('/api/ui/points/transactions?limit=1');
  expect(updated.body.pagination.total).toBe(count+1);expect(updated.body.data[0].operationId).not.toBe(operation.operationId);
  expect((await agent.get('/api/ui/points/transactions?page=2&limit=1')).body.data[0].operationId).toBe(operation.operationId);
  const beforeFailure=await mappings(),balanceBeforeFailure=await store.account(session.user.id),broken=batch();
  broken.commands[1].body.targetRefs=[{kind:'message',messageId:'missing-target'}];
  expect((await post('/commands',broken)).status).toBeGreaterThanOrEqual(400);
  expect(await mappings()).toEqual(beforeFailure);expect(await store.account(session.user.id)).toEqual(balanceBeforeFailure);
  const other=request.agent(app);await other.post('/api/register').send({inviteCode:await testInvitation(app),name:'其他操作用户',password:'password'});
  expect((await other.get('/api/ui/points/transactions').query({mode:'summary',operationId:operation.operationId})).body.data).toEqual([]);
});
