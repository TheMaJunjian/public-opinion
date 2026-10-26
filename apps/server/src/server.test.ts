import {withTestContribution} from './test-database.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { bodyVersion, bindRoles, replayArchive, type Change, type Message, type Part, type Reference, type Session } from '@gonglun/core';
import { createApp } from './app.js';
import { createTestApp, cleanupTestDatabases, newTestSchema } from './test-database.js';
import { processDue } from './messages.js';

type App=Awaited<ReturnType<typeof createApp>>;
type Actor={agent:ReturnType<typeof request.agent>;session:Session};
const apps:App[]=[];

const app=async ()=>{const value=(await createTestApp());apps.push(value);return value;};
const text=(value:string):Part=>({id:'text',type:'text',text:value});
const rel=(name:string,target?:Reference,role='target'):Part=>({id:'relation',type:'relation',relation:name,roles:bindRoles(target?{[role]:[target]}:{})});
const data=(value:Record<string,any>):Part=>({id:'data',type:'data',value});
async function actor(app:App,name:string):Promise<Actor>{const agent=request.agent(app);const response=await agent.post('/api/register').send({name,password:'a-good-password'});expect(response.status,response.text).toBe(201);return {agent,session:response.body};}
async function post(user:Actor,parts:Part[],spending:{wager?:number;recommendation?:number;requestId?:string}={}){
  return user.agent.post('/api/messages').set('x-csrf-token',user.session.csrf).send(withTestContribution({requestId:randomUUID(),parts,...spending}));
}
async function message(user:Actor,parts:Part[],spending:{wager?:number;recommendation?:number}={}):Promise<Message>{const response=await post(user,parts,spending);expect(response.status,response.text).toBe(201);return response.body.message;}
async function terminate(user:Actor,target:Message){return message(user,[rel('terminate',{messageId:target.id})]);}
async function conserved(app:App){const balances=(await app.store.db.prepare('SELECT SUM(available+locked) AS total FROM accounts').get())!;expect(Number(balances.total)+(await app.store.setting<number>('operating'))).toBe((await app.store.setting<number>('minted')));}
afterEach(async ()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const app of apps.splice(0))(await app.close());await cleanupTestDatabases();});

describe('公论事务与经济',()=>{
  it('发言必须投入，价值单独入运营池；幂等重试不重复收费，失败完全回滚',async()=>{
    const server=(await app()),user=await actor(server,'founder'),other=await actor(server,'other');
    const requestId=randomUUID(),input=[text('一个问题')];
    const first=await post(user,input,{requestId,recommendation:7});expect(first.status).toBe(201);
    const sequence=(await server.store.latestSequence());
    const duplicate=await post(user,input,{requestId,recommendation:7});expect(duplicate.body).toEqual(first.body);
    expect((await server.store.latestSequence())).toBe(sequence);
    expect((await server.store.account(user.session.user.id))).toMatchObject({available:992,locked:0});
    expect((await server.store.db.prepare('SELECT COUNT(*) AS n FROM rounds').get())!.n).toBe(0);
    expect((await server.store.setting('operating'))).toBe(8);
    expect((await post(user,[text('不同内容')],{requestId})).status).toBe(409);
    const before=(await server.store.account(other.session.user.id)),beforeSeq=(await server.store.latestSequence());
    expect((await post(other,[rel('credit'),data({amount:100})])).status).toBe(403);
    expect((await server.store.account(other.session.user.id))).toEqual(before);expect((await server.store.latestSequence())).toBe(beforeSeq);
    expect((await post(other,[text('耗尽')],{recommendation:Number.MAX_SAFE_INTEGER})).status).toBe(400);
    expect((await server.store.account(other.session.user.id))).toEqual(before);(await conserved(server));
  });
  it('两方结算和后续翻案保持本金、分配与运营池守恒',async()=>{
    const server=(await app()),a=await actor(server,'alice'),b=await actor(server,'bob');
    const claim=await message(a,[text('命题')]);
    await message(a,[rel('agree',{messageId:claim.id})],{wager:10});
    await message(b,[rel('disagree',{messageId:claim.id})],{wager:5});
    await terminate(a,claim);
    expect((await server.store.account(a.session.user.id)).available).toBe(1000);
    expect((await server.store.account(b.session.user.id)).available).toBe(994);
    let view=(await a.agent.get(`/api/messages/${claim.id}/context`)).body;
    expect(view.rounds[0]).toMatchObject({status:'settled',result:'pro',pro:10,con:5});
    await message(b,[rel('disagree',{messageId:claim.id})],{wager:20});
    await terminate(b,claim);
    view=(await a.agent.get(`/api/messages/${claim.id}/context`)).body;
    expect(view.rounds[0]).toMatchObject({status:'settled',result:'con',pro:10,con:25});
    expect(view.rounds[0].previousRoundId).toBe(view.rounds[1].id);
    expect((await server.store.account(a.session.user.id))).toMatchObject({available:985,locked:0});
    expect((await server.store.account(b.session.user.id))).toMatchObject({available:1006,locked:0});
    const reversals=(await server.store.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE reason='撤回先前对赌分配'").get())!;
    expect(reversals.n).toBeGreaterThan(0);(await conserved(server));
  });
  it('单边胜出返还本金，平局双方返还，费用不返还',async()=>{
    const server=(await app()),a=await actor(server,'alice'),b=await actor(server,'bob');
    const solo=await message(a,[text('只有一方')]);
    await message(a,[rel('agree',{messageId:solo.id})],{wager:17});await terminate(a,solo);
    expect((await server.store.account(a.session.user.id))).toMatchObject({available:995,locked:0});
    expect((await a.agent.get(`/api/messages/${solo.id}/context`)).body.rounds[0].result).toBe('pro');
    const tie=await message(a,[text('平局')]);
    await message(a,[rel('agree',{messageId:tie.id})],{wager:8});await message(b,[rel('disagree',{messageId:tie.id})],{wager:8});await terminate(a,tie);
    expect((await a.agent.get(`/api/messages/${tie.id}/context`)).body.rounds[0].result).toBe('tie');
    expect((await server.store.account(a.session.user.id))).toMatchObject({available:990,locked:0});
    expect((await server.store.account(b.session.user.id))).toMatchObject({available:999,locked:0});(await conserved(server));
  });
  it('低质量处罚单独入运营池，评价翻案平反，不改原消息对赌资金',async()=>{
    const server=(await app()),a=await actor(server,'alice'),b=await actor(server,'bob');
    const claim=await message(a,[text('被评价的内容')]);
    const evaluation=await message(b,[rel('low-quality',{messageId:claim.id}),text('缺少依据')]);
    await message(b,[rel('agree',{messageId:evaluation.id})],{wager:2});
    const before=(await server.store.account(a.session.user.id)).available;
    await terminate(b,evaluation);
    expect((await server.store.account(a.session.user.id)).available).toBe(before-5);
    expect((await a.agent.get(`/api/messages/${claim.id}/context`)).body.rounds).toHaveLength(0);
    await message(a,[rel('disagree',{messageId:evaluation.id})],{wager:3});await terminate(b,evaluation);
    const penalties=(await server.store.db.prepare("SELECT amount FROM ledger WHERE \"userId\"=$1 AND reason LIKE '低质量%'").all(a.session.user.id));
    expect(penalties.map(p=>p.amount)).toEqual([-5,5]);(await conserved(server));
  });
  it('评价第二个低质量部件只影响该部件所指发送者',async()=>{
    const server=(await app()),a=await actor(server,'alice'),b=await actor(server,'bob');
    const first=await message(a,[text('第一条')]),second=await message(b,[text('第二条')]);
    const evaluation=await message(a,[{...rel('low-quality',{messageId:first.id}),id:'quality-a'},{...rel('low-quality',{messageId:second.id}),id:'quality-b'}]);
    const target={messageId:evaluation.id,partId:'quality-b'};
    await message(a,[rel('agree',target)],{wager:1});await message(a,[rel('terminate',target)]);
    expect((await server.store.db.prepare("SELECT \"userId\" FROM ledger WHERE reason='低质量处罚'").all()).map(row=>row.userId)).toEqual([b.session.user.id]);(await conserved(server));
  });
  it('委托报酬独立锁定，完成后支付，翻案追回并恢复锁定',async()=>{
    const server=(await app()),a=await actor(server,'alice'),b=await actor(server,'bob');
    const task=await message(a,[rel('delegate'),text('完成工作'),data({reward:20})]);
    expect((await server.store.account(a.session.user.id)).locked).toBe(20);
    const work=await message(b,[rel('fulfill',{messageId:task.id}),text('工作成果')]);
    await message(a,[rel('agree',{messageId:work.id})],{wager:1});await terminate(a,work);
    expect((await server.store.account(a.session.user.id)).locked).toBe(0);
    expect((await server.store.account(b.session.user.id)).available).toBe(1018);
    await message(a,[rel('disagree',{messageId:work.id})],{wager:2});await terminate(a,work);
    expect((await server.store.account(a.session.user.id)).locked).toBe(20);
    expect((await server.store.account(b.session.user.id)).available).toBe(998);(await conserved(server));
  });
  it('运营收入只分实际可用部分，分配消息留下权重和每笔归因',async()=>{
    const server=(await app()),a=await actor(server,'alice'),b=await actor(server,'bob');
    await message(a,[text('值得讨论')],{recommendation:130});
    await message(b,[text('补充证据')]);
    const proposal=await message(a,[rel('distribute')]);
    const related=(await a.agent.get(`/api/messages/${proposal.id}/context`)).body.messages as Message[];
    const payout=related.find(m=>m.authorId==='system')!;
    const value=payout.parts.find(p=>p.type==='data');
    expect(value?.type==='data'&&value.value).toMatchObject({source:'operations',total:35,ruleVersion:1,ledgerId:'local'});
    expect((await server.store.setting('operating'))).toBe(100);(await conserved(server));
  });
  it('早期表态高于未认可的重复内容，同作者拆分封顶且不同组织独立',async()=>{
    const server=(await app()),a=await actor(server,'alice'),b=await actor(server,'bob'),c=await actor(server,'carol');
    const original=await message(a,[text('初始内容')],{recommendation:180});
    const early=await message(b,[rel('agree',{messageId:original.id})]);
    const duplicate=await message(c,[text('  初始内容  ')]);
    const first=await message(a,[{id:'group',type:'relation',relation:'classify',roles:{}}]);
    const second=await message(a,[{id:'group',type:'relation',relation:'classify',roles:{}}]);
    for(const group of [first,second])for(let i=0;i<6;i++)await message(a,[text(`独立分组内容 ${i}`),rel('member-of',{messageId:group.id},'parent')]);
    const operation=await message(a,[rel('distribute')]);
    const related=(await a.agent.get(`/api/messages/${operation.id}/context`)).body.messages as Message[];
    const output=related.find(m=>m.authorId==='system')!.parts.find(p=>p.type==='data') as {value:any};
    const attribution=output.value.inputs.attribution as Array<{messageId:string;userId:string;scope:string;weight:number}>;
    expect(attribution.find(item=>item.messageId===early.id)!.weight).toBeGreaterThan(attribution.find(item=>item.messageId===duplicate.id)!.weight);
    expect(attribution.find(item=>item.messageId===duplicate.id)!.weight).toBe(0);
    for(const group of [first,second])expect(attribution.filter(item=>item.scope===group.id&&item.userId===a.session.user.id).reduce((sum,item)=>sum+item.weight,0)).toBe(8);
    expect(output.value.inputs.parameters).toMatchObject({duplicate:0,earlyBonus:1,earlyWindow:20,unrecognizedAuthorCap:8});
    const update=await message(a,[rel('rule-change'),data({rules:{contributionWeights:{unrecognizedAuthorCap:4}}})]);await message(a,[rel('authorize',{messageId:update.id})]);
    expect((await server.store.rules()).contributionWeights).toMatchObject({content:3,agreement:1,unrecognizedAuthorCap:4});
    expect((await a.agent.get('/api/rules?version=1')).body.contributionWeights.unrecognizedAuthorCap).toBe(8);(await conserved(server));
  });
});

describe('身份、组织和消息版本',()=>{
  it('保护会话写入和发起人初始化，导出不包含认证资料',async()=>{
    const server=(await app()),a=await actor(server,'alice');
    expect(a.session.user.founder).toBe(true);
    expect((await a.agent.post('/api/messages').send({requestId:randomUUID(),parts:[text('无CSRF')]})).status).toBe(403);
    expect((await a.agent.post('/api/messages').set('Origin','https://evil.example').set('x-csrf-token',a.session.csrf).send({requestId:randomUUID(),parts:[text('跨站')]})).status).toBe(403);
    const exported=(await a.agent.get('/api/export')).body;
    expect(exported).toMatchObject({format:'gonglun-2',ledgerId:'local'});expect(exported).not.toHaveProperty('sessions');expect(exported).not.toHaveProperty('users');
    const cookie=(await a.agent.get('/api/session')).body;expect(cookie.user.id).toBe(a.session.user.id);
    vi.stubEnv('NODE_ENV','production');vi.stubEnv('GONGLUN_FOUNDER_KEY','secret-bootstrap');
    const production=(await app());expect((await request(production).get('/api/setup')).body).toEqual({initialized:false,founderKeyRequired:true});
    expect((await request(production).post('/api/register').send({name:'attacker',password:'long-password'})).status).toBe(403);
    const first=await request(production).post('/api/register').send({name:'founder',password:'long-password',founderKey:'secret-bootstrap'});
    expect(first.status).toBe(201);expect(first.body.user.founder).toBe(true);
    expect((await request(production).post('/api/register').send({name:'member',password:'long-password'})).body.user.founder).toBe(false);
  });
  it('组织保持单父树，拒绝循环，分组继承父，修改需要授权和正确版本',async()=>{
    const server=(await app()),a=await actor(server,'alice'),b=await actor(server,'bob');
    const first=await message(a,[text('第一条')]),second=await message(a,[text('第二条')]);
    const group=await message(a,[{id:'group',type:'relation',relation:'classify',roles:bindRoles({members:[{messageId:first.id},{messageId:second.id}]})}]);
    const sub=await message(a,[{id:'group',type:'relation',relation:'arrange',roles:bindRoles({members:[{messageId:first.id},{messageId:second.id}]})}]);
    const view=(await a.agent.get(`/api/messages/${group.id}/context`)).body;
    expect(view.memberships).toContainEqual(expect.objectContaining({memberId:sub.id,parentId:group.id}));
    const cycle=await post(a,[{id:'join',type:'relation',relation:'member-of',roles:bindRoles({member:[{messageId:group.id}],parent:[{messageId:sub.id}]})}]);
    expect(cycle.status).toBe(400);
    const amendment=await message(b,[rel('amend',{messageId:first.id,partId:'text'}),data({expectedRevision:1,value:text('修订内容')})]);
    expect((await post(b,[rel('authorize',{messageId:amendment.id})])).status).toBe(403);
    await message(a,[rel('authorize',{messageId:amendment.id})]);
    expect((await server.store.message(first.id))).toMatchObject({revision:2,parts:[text('修订内容')]});
    expect((await server.store.message(first.id,1)).parts).toEqual([text('第一条')]);
    const stale=await message(b,[rel('amend',{messageId:first.id}),data({expectedRevision:1,parts:[text('覆盖') ]})]);
    expect((await post(a,[rel('authorize',{messageId:stale.id})])).status).toBe(409);(await conserved(server));
  });
  it('反对表态归入原立场，反对理由保留为独立对象',async()=>{
    const server=(await app()),a=await actor(server,'alice');
    const original=await message(a,[text('原命题')]);
    const objection=await message(a,[rel('disagree',{messageId:original.id}),text('反对理由')],{wager:2});
    await message(a,[rel('disagree',{messageId:objection.id,partId:'relation'})],{wager:3});
    await message(a,[rel('disagree',{messageId:objection.id,partId:'text'})],{wager:4});
    const rounds=(await a.agent.get(`/api/messages/${original.id}/context`)).body.rounds;
    expect(rounds[0]).toMatchObject({pro:0,con:5});
    const reasons=(await a.agent.get(`/api/messages/${objection.id}/context`)).body.rounds;
    expect(reasons[0]).toMatchObject({target:{messageId:objection.id,partId:'text'},pro:0,con:4});(await conserved(server));
  });
  it('沿旧表态反对时保留其实际执行版本，不漂移到后来修改的原消息',async()=>{
    const server=(await app()),a=await actor(server,'alice'),b=await actor(server,'bob');
    const original=await message(a,[text('命题第一版')]);
    const statement=await message(b,[rel('agree',{messageId:original.id})],{wager:2});
    const amendment=await message(a,[rel('amend',{messageId:original.id}),data({expectedRevision:1,parts:[text('命题第二版')]})]);
    await message(a,[rel('authorize',{messageId:amendment.id})]);
    await message(a,[rel('disagree',{messageId:statement.id,revision:1,partId:'relation'})],{wager:4});
    const view=(await a.agent.get(`/api/messages/${original.id}/context`)).body;
    expect(view.rounds).toHaveLength(1);expect(view.rounds[0]).toMatchObject({targetRevision:1,target:{messageId:original.id,revision:1},pro:2,con:4});
    expect(statement.parts).toEqual([rel('agree',{messageId:original.id,revision:1,context:{kind:'MESSAGE'}})]);
    await message(a,[rel('terminate',{messageId:original.id,revision:1})]);(await conserved(server));
  });
  it('页面及增量返回每条表态的执行依据，编辑后仍区分原立场与反对理由',async()=>{
    const server=(await app()),a=await actor(server,'alice'),b=await actor(server,'bob');
    const original=await message(a,[text('原命题')]);
    const objection=await message(b,[rel('disagree',{messageId:original.id}),text('原反对理由')]);
    const reversal=await post(a,[rel('disagree',{messageId:objection.id,partId:'relation'})]);expect(reversal.status).toBe(201);
    const reversed=reversal.body.message as Message;
    const subject={messageId:original.id,revision:1,context:{kind:'MESSAGE'}};
    expect(reversal.body.change.states.find((state:any)=>state.messageId===reversed.id)?.executedStance).toEqual({partId:'relation',sourceRevision:1,target:subject,side:'con'});
    const reasonReply=await message(a,[rel('disagree',{messageId:objection.id,partId:'text'})]);
    const amendment=await message(a,[rel('amend',{messageId:objection.id}),data({expectedRevision:1,parts:[text('修改后的理由'),{...rel('agree',{messageId:original.id}),id:'new-stance'}]})]);
    await message(a,[rel('authorize',{messageId:amendment.id})]);
    const page=(await a.agent.get('/api/messages?limit=100')).body;
    expect(page.states.find((state:any)=>state.messageId===objection.id)).toMatchObject({revision:2,executedStance:{partId:'relation',sourceRevision:1,target:{messageId:original.id,revision:1},side:'con'}});
    const context=(await a.agent.get(`/api/messages/${objection.id}/context`)).body;
    expect(context.states.find((state:any)=>state.messageId===reasonReply.id)?.executedStance).toEqual({partId:'relation',sourceRevision:1,target:{messageId:objection.id,revision:1,partId:'text',context:{kind:'MESSAGE',version:bodyVersion(objection.id)}},side:'con'});
    expect(context.states.find((state:any)=>state.messageId===reversed.id)?.executedStance).toEqual({partId:'relation',sourceRevision:1,target:subject,side:'con'});
    expect(page.states.find((state:any)=>state.messageId===original.id)?.executedStance).toBeUndefined();
  });
  it('连续编辑组织不再次移除已经释放到父级的成员',async()=>{
    const server=(await app()),a=await actor(server,'alice');
    const b=await message(a,[text('B')]),c=await message(a,[text('C')]),d=await message(a,[text('D')]);
    const grouping=(name:string,ids:string[]):Part=>({id:'group',type:'relation',relation:name,roles:bindRoles({members:ids.map(messageId=>({messageId}))})});
    const group=await message(a,[grouping('classify',[b.id,c.id])]);
    const parent=await message(a,[grouping('classify',[group.id,d.id])]);
    const amend1=await message(a,[rel('amend',{messageId:group.id}),data({expectedRevision:1,parts:[grouping('classify',[b.id])]})]);
    await message(a,[rel('authorize',{messageId:amend1.id})]);
    const amend2=await message(a,[rel('amend',{messageId:group.id}),data({expectedRevision:2,parts:[grouping('arrange',[b.id])]})]);
    await message(a,[rel('authorize',{messageId:amend2.id})]);
    expect((await server.store.db.prepare("SELECT \"parentId\" FROM memberships WHERE \"memberId\"=$1").get(c.id))?.parentId).toBe(parent.id);
    expect((await server.store.db.prepare("SELECT \"parentId\" FROM memberships WHERE \"memberId\"=$1").get(b.id))?.parentId).toBe(group.id);
    expect((await server.store.db.prepare("SELECT \"parentId\" FROM memberships WHERE \"memberId\"=$1").get(group.id))?.parentId).toBe(parent.id);
  });
  it('修改系统分配内容保留执行版本，账本与重放始终指向原始分配',async()=>{
    const server=(await app()),a=await actor(server,'alice');
    const claim=await message(a,[text('单边消息')]);await message(a,[rel('agree',{messageId:claim.id})],{wager:2});await terminate(a,claim);
    const round=(await a.agent.get(`/api/messages/${claim.id}/context`)).body.rounds[0];
    const original=(await server.store.message(round.distributionId));
    const amendment=await message(a,[rel('amend',{messageId:original.id,partId:'allocation',path:['value','allocations',0,'amount']}),data({expectedRevision:1,value:9999})]);
    await message(a,[rel('authorize',{messageId:amendment.id})]);
    expect((await server.store.message(original.id)).revision).toBe(2);
    expect((await server.store.message(original.id,1))).toEqual(original);
    const entries=(await server.store.db.prepare("SELECT * FROM ledger WHERE \"messageId\"=$1").all(original.id));
    expect(entries.every(row=>row.messageRevision===1)).toBe(true);expect(entries.reduce((sum,row)=>sum+Number(row.amount),0)).toBe(2);
    const archive=(await a.agent.get('/api/export?limit=100')).body;
    expect(replayArchive(archive).accounts.get(a.session.user.id)).toEqual((await server.store.account(a.session.user.id)));(await conserved(server));
  });
});

describe('同步和结算时间',()=>{
  it('真实数据库分页导出可以重放每笔账目，重启保存身份、幂等结果和历史规则',async()=>{
    const schema=newTestSchema(),server=(await createTestApp({databaseSchema:schema}));apps.push(server);
    const a=await actor(server,'alice'),b=await actor(server,'bob');
    const original=await message(a,[text('需要核实')],{recommendation:120});
    await message(a,[rel('agree',{messageId:original.id})],{wager:7});await message(b,[rel('disagree',{messageId:original.id})],{wager:4});await terminate(a,original);
    const quality=await message(b,[rel('low-quality',{messageId:original.id})]);await message(b,[rel('agree',{messageId:quality.id})],{wager:1});await terminate(b,quality);
    await message(a,[rel('distribute')]);
    const rule=await message(a,[rel('rule-change'),data({rules:{protocolFee:2}})]);await message(a,[rel('authorize',{messageId:rule.id})]);
    const requestId=randomUUID(),last=await post(a,[text('重试不重复')],{requestId});expect(last.status).toBe(201);
    let cursor=0;const archive:Change[]=[];
    while(true){const page=(await a.agent.get(`/api/export?after=${cursor}&limit=3`)).body;archive.push(...page.changes);cursor=page.nextCursor;if(!page.hasMore)break;}
    const replay=replayArchive({format:'gonglun-2',changes:archive});
    for(const user of [a,b])expect(replay.accounts.get(user.session.user.id)).toEqual((await server.store.account(user.session.user.id)));
    expect(replay.operating).toBe((await server.store.setting('operating')));expect(replay.issued).toBe(2000);expect(replay.sequence).toBe((await server.store.latestSequence()));
    expect((await a.agent.get('/api/rules?version=1')).body.protocolFee).toBe(1);
    expect((await a.agent.get(`/api/users/${a.session.user.id}`)).body).toEqual(a.session.user);
    const savedAccount=(await server.store.account(a.session.user.id));(await server.close());
    const reopened=(await createTestApp({databaseSchema:schema}));apps.push(reopened);const agent=request.agent(reopened);
    const logged=await agent.post('/api/login').send({name:'alice',password:'a-good-password'});expect(logged.status).toBe(200);
    const actorAgain={agent,session:logged.body};expect(logged.body.account).toEqual(savedAccount);expect(logged.body.rules.protocolFee).toBe(2);
    const duplicate=await post(actorAgain,[text('重试不重复')],{requestId});expect(duplicate.body).toEqual(last.body);(await conserved(reopened));
  });
  it('增量和消息分页不丢记录，SSE断线按Last-Event-ID恢复',async()=>{
    const server=(await app()),a=await actor(server,'alice');
    for(let i=0;i<4;i++)await message(a,[text(`消息 ${i}`)]);
    let cursor=0;const seen:number[]=[];
    for(let i=0;i<10;i++){const page=(await a.agent.get(`/api/changes?after=${cursor}&limit=2`)).body;seen.push(...page.changes.map((c:any)=>c.sequence));cursor=page.nextCursor;if(!page.hasMore)break;}
    expect(seen).toEqual([1,2,3,4,5]);
    const first=(await a.agent.get('/api/messages?limit=2')).body;
    const second=(await a.agent.get(`/api/messages?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).body;
    expect(new Set([...first.messages,...second.messages].map((m:Message)=>m.id)).size).toBe(4);
    const http=server.listen(0,'127.0.0.1');await once(http,'listening');
    const address=http.address() as {port:number},controller=new AbortController();
    try{
      const response=await fetch(`http://127.0.0.1:${address.port}/api/events`,{headers:{'Last-Event-ID':'3'},signal:controller.signal});
      const reader=response.body!.getReader();let received='';
      while(!received.includes('id: 5')){const chunk=await reader.read();received+=new TextDecoder().decode(chunk.value);}
      expect(received).toContain('id: 4');expect(received).not.toContain('id: 3\n');expect(received).toContain('data: ');expect(received).not.toContain('event: change');
      await reader.cancel();controller.abort();
    }finally{controller.abort();await new Promise<void>(resolve=>http.close(()=>resolve()));}
  });
  it('延时终止不会被重复请求重置，截止后只执行一次',async()=>{
    const server=(await app()),a=await actor(server,'alice');
    const proposal=await message(a,[rel('rule-change'),data({rules:{settlementDelayMs:200}})]);
    await message(a,[rel('authorize',{messageId:proposal.id})]);
    const claim=await message(a,[text('延时结算')]);await message(a,[rel('agree',{messageId:claim.id})],{wager:10});
    await terminate(a,claim);const before=(await a.agent.get(`/api/messages/${claim.id}/context`)).body.rounds[0];
    await terminate(a,claim);const repeated=(await a.agent.get(`/api/messages/${claim.id}/context`)).body.rounds[0];
    expect(repeated.endsAt).toBe(before.endsAt);expect(repeated.status).toBe('waiting');
    await new Promise(resolve=>setTimeout(resolve,220));expect((await processDue(server.store))).not.toBeNull();expect((await processDue(server.store))).toBeNull();
    expect((await a.agent.get(`/api/messages/${claim.id}/context`)).body.rounds[0].status).toBe('settled');(await conserved(server));
  });
});
