import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createApp } from './app.js';
import { createTestApp, cleanupTestDatabases, newTestSchema } from './test-database.js';
import { replayArchive, decodeWorkbenchSnapshot } from '@gonglun/core';

const apps:Awaited<ReturnType<typeof createApp>>[]=[];
const make=async ()=>{const app=(await createTestApp());apps.push(app);return app;};
afterEach(async ()=>{vi.restoreAllMocks();for(const app of apps.splice(0))(await app.close());await cleanupTestDatabases();});
async function actor(app:Awaited<ReturnType<typeof make>>,username:string,extra:Record<string,unknown>={}) {const agent=request.agent(app);const response=await agent.post('/api/register').send({username,password:'a-test-password',...extra});expect(response.status,response.text).toBe(201);return {agent,session:response.body};}
const post=(user:Awaited<ReturnType<typeof actor>>,path:string,body:Record<string,unknown>={})=>user.agent.post(`/api/ui${path}`).set('x-csrf-token',user.session.csrf).set('x-request-id',(body as {requestId?:string}).requestId??randomUUID()).send(body);
const good=async(response:PromiseLike<request.Response>)=>{const value=await response;expect(value.status,value.text).toBe(201);return value.body;};

describe('保留操作方式的消息 API',()=>{
  it('工作台没有独立议题实体，查询上下文只引用真实消息',async()=>{
    const app=(await make()),user=await actor(app,'发起人');
    const root=(await user.agent.get('/api/ui/snapshot')).body;
    expect(root.scope).toEqual({messageId:null,title:'公论'});
    expect(root).not.toHaveProperty('topic');
    const group=await good(post(user,'/relations',{relationType:'CLASSIFY',targetRefs:[],payload:{title:'公交分类'}}));
    const content=await good(post(user,'/messages',{parentMessageId:group.id,content:'延长末班车'}));
    expect(content).not.toHaveProperty('topicId');
    expect((await user.agent.get(`/api/ui/snapshot?parent=${group.id}`)).body.scope).toEqual({messageId:group.id,title:'公交分类'});
    const exported=(await user.agent.get(`/api/ui/export?parent=${group.id}`)).body;
    expect(exported.scope.messageId).toBe(group.id);
    expect(exported).not.toHaveProperty('topic');
    expect(exported.messages.map((message:any)=>message.id)).toContain(content.id);
    expect((await user.agent.get('/api/ui/topics')).status).toBe(404);
    expect((await post(user,'/topics',{title:'旧入口'})).status).toBe(404);
  });
  it('分类是普通消息；复合发送原子提交，重试不重复收费，失败没有半条消息',async()=>{
    const app=(await make()),user=await actor(app,'发起人'),classification=await good(post(user,'/relations',{relationType:'CLASSIFY',targetRefs:[],payload:{title:'公共交通'}}));
    expect((await app.store.message(classification.id)).parts.some(p=>p.type==='relation'&&p.relation==='classify')).toBe(true);
    expect((await app.store.db.prepare("SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE '%topic%'").all())).toEqual([]);
    const firstId=randomUUID(),secondId=randomUUID(),batch={requestId:randomUUID(),commands:[{id:firstId,method:'POST',path:'/messages',body:{parentMessageId:classification.id,content:'延长夜间服务'}},{id:secondId,method:'POST',path:'/relations',body:{parentMessageId:classification.id,relationType:'AGREE',targetRefs:[{kind:'message',messageId:firstId}],wager:8}}]};
    const result=await good(post(user,'/commands',batch));expect(result.results.map((r:any)=>r.id)).toEqual([firstId,secondId]);
    const account=(await app.store.account(user.session.user.id)),seq=(await app.store.latestSequence());
    const again=await good(post(user,'/commands',batch));expect(again).toEqual(result);expect((await app.store.account(user.session.user.id))).toEqual(account);expect((await app.store.latestSequence())).toBe(seq);
    const failedId=randomUUID(),failed={requestId:randomUUID(),commands:[{id:failedId,method:'POST',path:'/messages',body:{parentMessageId:classification.id,content:'不应留下'}},{id:randomUUID(),method:'POST',path:'/relations',body:{parentMessageId:classification.id,relationType:'AGREE',targetRefs:[{kind:'message',messageId:'missing'}]}}]};
    expect((await post(user,'/commands',failed)).status).toBe(404);await expect(app.store.message(failedId)).rejects.toThrow();expect((await app.store.account(user.session.user.id))).toEqual(account);expect((await app.store.latestSequence())).toBe(seq);
    const view=await user.agent.get(`/api/ui/snapshot?parent=${classification.id}`);expect(view.status,view.text).toBe(200);expect(view.body.messages.some((m:any)=>m.id===firstId)).toBe(true);expect(view.body.stakes[firstId].counts.pro).toBe(8);
  });
  it('文本片段、分类标题和历史版本可引用；修改提案授权后生效',async()=>{
    const app=(await make()),founder=await actor(app,'发起人'),other=await actor(app,'参与者');
    const classification=await good(post(founder,'/relations',{relationType:'CLASSIFY',targetRefs:[],payload:{title:'是否应该试点'}}));
    const fragment={messageId:classification.id,revision:1,partId:'body',range:{start:0,end:2}};
    const correction=await good(post(other,'/relations',{relationType:'CORRECT',targetRefs:[{kind:'text-fragment',messageId:classification.id,text:'是否',hash:'x',reference:fragment}],payload:{correctionContent:'为何'}}));
    expect((await app.store.message(classification.id)).revision).toBe(1);
    expect((await post(other,'/relations',{relationType:'AUTHORIZE',targetRefs:[{kind:'relation',relationId:correction.id}]})).status).toBe(403);
    await good(post(founder,'/relations',{relationType:'AUTHORIZE',targetRefs:[{kind:'relation',relationId:correction.id}]}));
    expect((await app.store.message(classification.id)).revision).toBe(2);expect((await app.store.message(classification.id,1)).parts[0]).toMatchObject({text:'是否应该试点'});
    const reply=await good(post(other,'/relations',{relationType:'REPLY',targetRefs:[{kind:'text-fragment',messageId:classification.id,text:'是否',hash:'x',reference:fragment}],payload:{content:'讨论原来的用词'}}));expect(reply.targetRefs[0].reference).toEqual(fragment);
  });
  it('单边结算保持操作、结算消息可评价，账本与导出可追溯',async()=>{
    const app=(await make()),user=await actor(app,'发起人'),message=await good(post(user,'/messages',{content:'一个提议'}));
    expect((await app.store.db.prepare('SELECT COUNT(*) AS n FROM rounds').get())!.n).toBe(0);
    await good(post(user,'/relations',{relationType:'AGREE',targetRefs:[{kind:'message',messageId:message.id}],wager:20}));
    const rounds=(await user.agent.get(`/api/ui/messages/${message.id}/rounds`)).body.data;expect(rounds).toHaveLength(1);expect((await app.store.message(rounds[0].id)).parts.some(p=>p.type==='relation'&&p.relation==='settlement')).toBe(true);
    const settled=await good(post(user,`/rounds/${rounds[0].id}/close-and-settle`));expect(settled.result).toBe('TRUE');expect((await app.store.account(user.session.user.id)).locked).toBe(0);
    const evaluation=await good(post(user,'/relations',{relationType:'ARCHIVE',targetRefs:[{kind:'relation',relationId:rounds[0].id}],payload:{subType:'LOWVALUE'}}));expect((await app.store.message(evaluation.id)).parts.some(p=>p.type==='relation'&&p.relation==='low-quality')).toBe(true);
    for(const path of ['/points/balance','/points/transactions','/revenue/pool','/revenue/distributions','/audit-logs',`/users/${user.session.user.id}/stances`,'/export']){const response=await user.agent.get(`/api/ui${path}`);expect(response.status,response.text).toBe(200);}
    const exported=(await user.agent.get('/api/ui/export')).body;expect(exported.messages.some((m:any)=>m.id===rounds[0].id)).toBe(true);expect(replayArchive(exported).accounts.get(user.session.user.id)).toEqual((await app.store.account(user.session.user.id)));expect(exported.ruleHistory).toHaveLength(1);expect(JSON.stringify(exported)).not.toContain('a-test-password');
  });
  it('充值分账及收入注入须授权且资金守恒',async()=>{
    const app=(await make()),founder=await actor(app,'发起人'),other=await actor(app,'参与者');
    const recharge=await good(post(other,'/relations',{relationType:'PROPOSAL',targetRefs:[],payload:{operationType:'RECHARGE',content:'已确认的付款',amount:100,revenuePoolShare:20,recipientUserId:other.session.user.id}}));
    const before=(await app.store.account(other.session.user.id)).available;
    await good(post(founder,'/relations',{relationType:'AUTHORIZE',targetRefs:[{kind:'relation',relationId:recharge.id}]}));expect((await app.store.account(other.session.user.id)).available).toBe(before+80);
    const injection=await good(post(other,'/relations',{relationType:'PROPOSAL',targetRefs:[],payload:{operationType:'REVENUE_INJECTION',content:'会议赞助',amount:25,source:'赞助'}}));
    await good(post(founder,'/relations',{relationType:'AUTHORIZE',targetRefs:[{kind:'relation',relationId:injection.id}]}));
    const balances=Number((await app.store.db.prepare('SELECT SUM(available+locked) AS total FROM accounts').get())!.total);expect(balances+(await app.store.setting<number>('operating'))).toBe((await app.store.setting('minted')));
  });
  it('签名绑定到设备、请求路径和幂等编号，历史保留签名',async()=>{
    const app=(await make()),keys=generateKeyPairSync('ed25519'),deviceId='test-device',publicKey=JSON.stringify(keys.publicKey.export({format:'jwk'})),user=await actor(app,'签名用户',{deviceId,publicKey});
    const path='/api/ui/messages',body={content:'签名发言'},requestId=randomUUID(),payload=JSON.stringify({method:'POST',path,bodyHash:createHash('sha256').update(JSON.stringify(body)).digest('hex'),requestId}),signature=sign(null,Buffer.from(payload),keys.privateKey).toString('base64');
    const send=(changedBody=body,changedPath=path)=>user.agent.post(changedPath).set('x-csrf-token',user.session.csrf).set('x-device-id',deviceId).set('x-request-id',requestId).set('x-signed-payload',Buffer.from(payload).toString('base64')).set('x-signature',signature).send(changedBody);
    expect((await post(user,'/messages',body)).status).toBe(401);
    const response=await send();expect(response.status,response.text).toBe(201);expect((await app.store.db.prepare("SELECT signature FROM signatures WHERE \"messageId\"=$1").get(response.body.id))?.signature).toBe(signature);
    expect((await send({content:'被替换的内容'})).status).toBe(401);expect((await send(body,'/api/ui/relations')).status).toBe(401);
  });
  it('通知收件人随发送固定，取消关注后旧通知仍可查看',async()=>{
    const app=(await make()),author=await actor(app,'发起人'),follower=await actor(app,'关注者'),message=await good(post(author,'/messages',{content:'通知讨论'}));
    await good(post(follower,'/relations',{relationType:'ATTENTION',targetRefs:[{kind:'message',messageId:message.id}]}));
    const notice=await good(post(author,'/relations',{relationType:'NOTIFY',targetRefs:[{kind:'message',messageId:message.id}],payload:{content:'有新证据'}}));
    expect(notice.payload.notifyUserIds).toContain(follower.session.user.id);
    await good(post(follower,'/relations',{relationType:'UNFOLLOW',targetRefs:[{kind:'message',messageId:message.id}]}));
    expect((await follower.agent.get('/api/me/notifications')).body.messages.some((m:any)=>m.id===notice.id)).toBe(true);
  });
  it('价值讨论是独立评价消息，推荐不押注，评价反转平反且不触碰原真假赌池',async()=>{
    const app=(await make()),author=await actor(app,'发起人'),critic=await actor(app,'评价者'),message=await good(post(author,'/messages',{content:'待评价的消息'}));
    await good(post(author,'/relations',{relationType:'RECOMMEND',targetRefs:[{kind:'message',messageId:message.id}],recommendation:3}));expect((await app.store.db.prepare('SELECT COUNT(*) AS n FROM bets').get())!.n).toBe(0);
    const round=await good(post(critic,`/messages/${message.id}/rounds`,{settlementType:'VALUE'}));expect(round.settlementType).toBe('VALUE');expect(round.reference.messageId).not.toBe(message.id);
    await good(post(critic,`/rounds/${round.id}/votes`,{vote:'FALSE',amount:4}));const before=(await app.store.account(author.session.user.id)).available;await good(post(critic,`/rounds/${round.id}/close-and-settle`));expect((await app.store.account(author.session.user.id)).available).toBe(before-5);
    const stakes=(await author.agent.get(`/api/ui/messages/${message.id}/stakes`)).body;expect(stakes.countsByType.VALUE.con).toBe(4);expect(stakes.countsByType.TRUTH.con).toBe(0);
    const next=await good(post(author,`/messages/${message.id}/rounds`,{settlementType:'VALUE'}));expect(next.previousRoundId).toBe(round.id);expect(next.reference).toEqual(round.reference);
    await good(post(author,`/rounds/${next.id}/votes`,{vote:'TRUE',amount:6}));await good(post(author,`/rounds/${next.id}/close-and-settle`));expect((await app.store.db.prepare("SELECT amount FROM ledger WHERE \"userId\"=$1 AND reason LIKE '低质量%'").all(author.session.user.id)).map(r=>r.amount)).toEqual([-5,5]);
  });
  it('原提案终止入口可在一个消息中原子终止多个选中对象',async()=>{
    const app=(await make()),user=await actor(app,'发起人'),ids:string[]=[];
    for(const content of ['规则一','规则二']){const message=await good(post(user,'/messages',{content,selfAgree:true,wager:2}));ids.push(message.id);}
    await good(post(user,'/relations',{relationType:'PROPOSAL',targetRefs:[],payload:{operationType:'TERMINATE_SETTLEMENT',targetMessageIds:ids,content:'终止这些结算'}}));
    expect((await app.store.db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE body::jsonb->>'status'='settled'").get())!.n).toBe(2);expect((await app.store.account(user.session.user.id)).locked).toBe(0);
  });
  it('移动嵌套组织后，旧分类增量移除整个子树，原发送位置不会将成员重新拉回',async()=>{
    const app=(await make()),user=await actor(app,'发起人'),left=await good(post(user,'/relations',{relationType:'CLASSIFY',targetRefs:[],payload:{title:'分类甲'}})),right=await good(post(user,'/relations',{relationType:'CLASSIFY',targetRefs:[],payload:{title:'分类乙'}}));
    const children=[];for(const content of ['第一条','第二条'])children.push(await good(post(user,'/messages',{parentMessageId:left.id,content})));
    const group=await good(post(user,'/relations',{parentMessageId:left.id,relationType:'CLASSIFY',targetRefs:children.map(m=>({kind:'message',messageId:m.id})),payload:{title:'嵌套组织'}}));
    const before=(await user.agent.get(`/api/ui/snapshot?parent=${left.id}`)).body;
    await good(post(user,'/relations',{relationType:'JOIN',sourceMessageId:right.id,targetRefs:[{kind:'relation',relationId:group.id}]}));
    const after=(await user.agent.get(`/api/ui/snapshot?parent=${left.id}&after=${before.sequence}`)).body;
    for(const id of [group.id,...children.map(m=>m.id)])expect(after.removedMessageIds).toContain(id);
    expect((await user.agent.get(`/api/ui/snapshot?parent=${right.id}`)).body.messages.map((m:any)=>m.id)).toEqual(expect.arrayContaining([group.id,...children.map(m=>m.id)]));
  });
  it('自赞是显式选择，片段来源保留，快照投影按批读取并连续追赶变更',async()=>{
    const app=(await make()),user=await actor(app,'发起人'),commands=Array.from({length:45},(_,i)=>({id:randomUUID(),method:'POST',path:'/messages',body:{content:`发言 ${i}`}}));
    await good(post(user,'/commands',{requestId:randomUUID(),commands}));
    const spy=vi.spyOn(app.store.db,'prepare');const response=await user.agent.get('/api/ui/snapshot?parent=root&limit=50');expect(response.status,response.text).toBe(200);expect(spy.mock.calls.length).toBeLessThan(35);spy.mockRestore();
    const compact=await user.agent.get('/api/ui/snapshot?parent=root&limit=50&format=compact-v1').set('Accept-Encoding','gzip');
    expect(compact.status,compact.text).toBe(200);expect(compact.headers['content-encoding']).toBe('gzip');
    expect(compact.headers.vary).toContain('Accept-Encoding');expect(compact.headers['cache-control']).toBe('private, no-store');
    expect(decodeWorkbenchSnapshot(compact.body)).toEqual(response.body);
    expect(Number(compact.headers['content-length'])).toBeLessThan(Buffer.byteLength(response.text));
    const identity=await user.agent.get('/api/ui/snapshot?parent=root&limit=50&format=compact-v1').set('Accept-Encoding','gzip;q=0, identity');
    expect(identity.headers['content-encoding']).toBeUndefined();expect(decodeWorkbenchSnapshot(identity.body)).toEqual(response.body);
    for(const batch of ['0','5','1.5','invalid']) expect((await user.agent.get(`/api/ui/snapshot?batch=${batch}`)).status).toBe(400);
    const sequence=response.body.sequence,source=commands[0]!.id;
    const before=(await app.store.account(user.session.user.id));
    const own=await good(post(user,'/messages',{content:'显式自赞',selfAgree:true,wager:7,recommendation:2}));expect((await app.store.account(user.session.user.id))).toMatchObject({available:before.available-10,locked:before.locked+7});
    const relation=await good(post(user,'/relations',{relationType:'REFERENCE',sourceRefs:[{messageId:source,revision:1,partId:'body',range:{start:0,end:2}}],targetRefs:[{kind:'message',messageId:own.id}]}));expect(relation.sourceRefs[0].partId).toBe('body');expect(relation.sourceRefs[0].range).toEqual({start:0,end:2});
    const delta=await user.agent.get(`/api/ui/snapshot?parent=root&after=${sequence}`);expect(delta.status,delta.text).toBe(200);expect(delta.body.sequence).toBe((await app.store.latestSequence()));expect(delta.body.messages.some((m:any)=>m.id===own.id)).toBe(true);expect(delta.body.messages.length).toBeLessThan(15);
  });
});

it('preserves native JOIN source/member addresses and includes the record in a bounded scope',async()=>{
 const app=await make(),user=await actor(app,'成员用户');
 const group=await good(post(user,'/relations',{relationType:'CLASSIFY',targetRefs:[],payload:{title:'分类'}}));
 const member=await good(post(user,'/messages',{content:'成员'}));
 const joined=await good(post(user,'/relations',{relationType:'JOIN',sourceMessageId:group.id,targetRefs:[{kind:'message',messageId:member.id}]}));
 expect(joined).toMatchObject({relationType:'JOIN',sourceMessageId:group.id,targetRefs:[{reference:{messageId:member.id}}]});
 const scoped=await user.agent.get(`/api/ui/snapshot?parent=${group.id}`);
 expect(scoped.status,scoped.text).toBe(200);expect(scoped.body.relations.some((record:any)=>record.id===joined.id&&record.sourceMessageId===group.id)).toBe(true);
});
