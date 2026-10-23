import { afterEach, expect, it } from 'vitest';
import { hash } from 'bcryptjs';
import { Pool } from 'pg';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { replayArchive, decodeWorkbenchSnapshot } from '@gonglun/core';
import { WorkbenchStore, type WorkbenchSnapshot } from '../../../frontend/src/data/workbench.js';
import { migrateLegacy } from './migrate-legacy.js';
import {prepareStartupDatabase} from './startup.js';
import { executeBatch } from '../../server/src/ui-commands.js';
import { stakesFor } from '../../server/src/ui-projections.js';
import { collectContainerVisibleIds } from '../../../frontend/src/pages/workbench/model/ownership.js';
import { computeCorrectionVersions, convertMessagesToDemoModel } from '../../../frontend/src/utils/modelBridge.js';
import { deriveContainerEffect } from '../../../frontend/src/pages/workbench/model/containerEffect.js';
import { projectContainerCanvas } from '../../../frontend/src/pages/workbench/projections/containerCanvas.js';
import { cleanupTestDatabases, createTestApp, newTestSchema, testDatabaseUrl } from '../../server/src/test-database.js';

afterEach(cleanupTestDatabases);
const time='2026-01-01T00:00:00.000Z';
const tables=['User','Topic','Message','Balance','PointAccount','SettlementRound','Stake','VoteStake','BetPool','RevenuePool','LedgerEntry','RuleVersion','UserSigningKey','AuditLog'];
type Data=Record<string,Record<string,any>[]>;
async function fixture(overrides:Data={}) {
  const schema=newTestSchema(),pool=new Pool({connectionString:testDatabaseUrl()});
  const data:Data={
    User:[{id:'old-user',username:'旧用户',password:await hash('short',4),publicKey:null,createdAt:time,updatedAt:time}],
    Topic:[{id:'old-topic',title:'旧话题',body:'说明',status:'OPEN',createdById:'old-user',createdAt:time,updatedAt:time}],
    Message:[{id:'old-message',topicId:'old-topic',createdById:'old-user',kind:'TEXT',content:'旧正文',contentType:'TEXT',relationType:null,targetRefs:null,relationPayload:null,relSourceId:null,supersededBy:null,createdAt:time,updatedAt:time}],
    Balance:[{userId:'old-user',balance:500,debtFrozen:false,totalLost:15,totalEarned:20}],
    PointAccount:[{userId:'old-user',available:500,locked:0}],
    RevenuePool:[{id:'old-revenue',balance:12,totalReceived:20,totalDistributed:8}],
    RuleVersion:[{id:'old-rules',version:3,status:'ACTIVE',parameters:{stakeFeeAmount:1},createdAt:time}],
    AuditLog:[{id:'old-audit',action:'MESSAGE_CREATED',data:{messageId:'old-message'},signature:'unchanged-signature',createdAt:time}],
    ...overrides,
  };
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    for(const table of tables) {
      const rows=data[table]??[],fields=rows.length?[...new Set(rows.flatMap(row=>Object.keys(row)))]:['id'];
      const types=fields.map(field=>{
        const value=rows.find(row=>row[field]!==null&&row[field]!==undefined)?.[field];
        return `"${field}" ${typeof value==='number'?'integer':typeof value==='boolean'?'boolean':value&&typeof value==='object'?'jsonb':'text'}`;
      });
      await pool.query(`CREATE TABLE "${schema}"."${table}" (${types.join(',')})`);
      for(const row of rows) await pool.query(`INSERT INTO "${schema}"."${table}" VALUES (${fields.map((_,i)=>`$${i+1}`).join(',')})`,fields.map(field=>typeof row[field]==='object'&&row[field]!==null?JSON.stringify(row[field]):row[field]));
    }
  } finally {await pool.end();}
  return {sourceUrl:testDatabaseUrl(),sourceSchema:schema,founderId:'old-user'};
}

it('migrates an immutable source snapshot, preserves bcrypt login and reconciles checkpoint replay',async()=>{
  const source=await fixture(),targetSchema=newTestSchema();
  const dry=await migrateLegacy(source);
  expect(dry.blockers).toEqual([]);expect(dry.applied).toBe(false);
  const report=await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema,apply:true});
  expect(report).toMatchObject({applied:true,sourceDigest:dry.sourceDigest,available:500,operating:12});
  const app=await createTestApp({databaseSchema:targetSchema});
  const agent=request.agent(app);
  const login=await agent.post('/api/login').send({name:'旧用户',password:'short'});
  expect(login.status,login.text).toBe(200);expect(login.body.user).toMatchObject({id:'old-user',founder:true});
  expect(login.body.account).toMatchObject({available:500,locked:0});
  const view=await agent.get('/api/ui/snapshot?parent=old-topic');
  expect(view.status,view.text).toBe(200);expect(view.body.messages.some((m:any)=>m.id==='old-message'&&m.content==='旧正文')).toBe(true);
  const archived=await app.store.db.prepare(`SELECT body FROM legacy_records WHERE "tableName"='AuditLog'`).get();
  expect(archived!.body.signature).toBe('unchanged-signature');
  const exported=await agent.get('/api/ui/export');
  expect(exported.status,exported.text).toBe(200);expect(JSON.stringify(exported.body)).not.toContain('$2');
  expect(replayArchive(exported.body).accounts.get('old-user')?.available).toBe(500);
  const written=await agent.post('/api/messages').set('x-csrf-token',login.body.csrf).send({requestId:randomUUID(),parts:[{id:'body',type:'text',text:'新版正常写入'}]});
  expect(written.status,written.text).toBe(201);expect(written.body.account.available).toBe(499);
  expect(await migrateLegacy(source)).toMatchObject({sourceDigest:dry.sourceDigest});
  await expect(migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema,apply:true})).rejects.toThrow('目标 schema 必须为空');
});

it('imports previous follow and block actions before validating the current message format',async()=>{
  const annotations=[
    {id:'follow',relationType:'ATTENTION',relationPayload:{},relation:'follow',reason:'YES'},
    {id:'unfollow',relationType:'ATTENTION',relationPayload:{action:'unfollow'},relation:'follow',reason:'NO'},
    {id:'block',relationType:'BLOCK',relationPayload:{},relation:'block',reason:'YES'},
    {id:'unblock',relationType:'UNBLOCK',relationPayload:{},relation:'block',reason:'NO'},
  ];
  const message={id:'old-message',topicId:'old-topic',createdById:'old-user',kind:'TEXT',content:'旧正文',createdAt:time,updatedAt:time};
  const source=await fixture({Message:[message,...annotations.map((annotation,index)=>({...message,id:annotation.id,kind:'RELATION',
    relationType:annotation.relationType,relationPayload:annotation.relationPayload,targetRefs:[{kind:'message',messageId:message.id}],
    createdAt:`2026-01-01T00:00:0${index+1}.000Z`}))]}),targetSchema=newTestSchema();
  expect((await migrateLegacy(source)).blockers).toEqual([]);
  expect((await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema,apply:true})).applied).toBe(true);
  const app=await createTestApp({databaseSchema:targetSchema});
  for(const annotation of annotations)expect((await app.store.message(annotation.id)).parts).toContainEqual(expect.objectContaining({
    type:'relation',relation:annotation.relation,reason:annotation.reason,
  }));
  expect(await app.store.db.prepare('SELECT family,action FROM personal_marks ORDER BY family').all()).toEqual([
    {family:'block',action:'unblock'},{family:'follow',action:'unfollow'},
  ]);
});

it('automatically imports a Prisma database once under concurrent startups and retains the immutable source',async()=>{
  const source=await fixture(),targetSchema=newTestSchema();
  const before=await migrateLegacy(source);
  const options={targetSchema};
  const [left,right]=await Promise.all([prepareStartupDatabase(source.sourceUrl,source.sourceSchema,options),prepareStartupDatabase(source.sourceUrl,source.sourceSchema,options)]);
  expect(left.schema).toBe(targetSchema);expect(right.schema).toBe(targetSchema);
  expect((await migrateLegacy(source)).sourceDigest).toBe(before.sourceDigest);
  const app=await createTestApp({databaseSchema:targetSchema}),agent=request.agent(app);
  expect(await app.store.setting('automatic-import-source')).toBe(source.sourceSchema);
  expect(await app.store.account('old-user')).toMatchObject({available:500,locked:0});
  const login=await agent.post('/api/login').send({name:'旧用户',password:'short'});
  expect(login.status,login.text).toBe(200);
  const cursor=await app.store.latestSequence();
  await prepareStartupDatabase(source.sourceUrl,source.sourceSchema,options);
  expect(await app.store.latestSequence()).toBe(cursor);
},30_000);

it('refuses to change mismatched legacy funds during automatic import',async()=>{
  const source=await fixture({PointAccount:[{userId:'old-user',available:500,locked:10}]}),targetSchema=newTestSchema();
  const before=await migrateLegacy(source);
  await expect(prepareStartupDatabase(source.sourceUrl,source.sourceSchema,{targetSchema})).rejects.toThrow('不能可靠转换');
  expect((await migrateLegacy(source)).sourceDigest).toBe(before.sourceDigest);
});

it('automatically retains exactly funded active principal without starting a settlement countdown',async()=>{
  const source=await fixture({PointAccount:[{userId:'old-user',available:500,locked:10}],
    Stake:[{id:'active-stake',userId:'old-user',messageId:'old-message',roundId:'pending',side:'PRO',amount:10,settlementType:'TRUTH',createdAt:time}],
    BetPool:[{messageId:'old-message',settlementType:'TRUTH',lockedPro:10,lockedCon:0}],
    SettlementRound:[{id:'pending',messageId:'old-message',createdByUserId:'old-user',status:'VOTING',settlementType:'TRUTH',openedAt:time,closedAt:null}],
  }),targetSchema=newTestSchema();
  const before=await migrateLegacy({...source,preserveActiveState:true,readOnlyRehearsal:true});
  await prepareStartupDatabase(source.sourceUrl,source.sourceSchema,{targetSchema});
  const app=await createTestApp({databaseSchema:targetSchema});
  expect(await app.store.account('old-user')).toMatchObject({available:500,locked:10});
  expect(await app.store.setting('access-mode')).toBe('read-write');
  const round=await app.store.db.prepare('SELECT body FROM rounds WHERE id=$1').get('pending');
  expect(JSON.parse(String(round!.body))).toMatchObject({status:'open',endsAt:null});
  expect((await stakesFor(app.store,['old-message']))['old-message'].pool).toEqual({lockedPro:10,lockedCon:0});
  expect((await migrateLegacy({...source,preserveActiveState:true,readOnlyRehearsal:true})).sourceDigest).toBe(before.sourceDigest);
});

it('keeps Topic IDs as classification content and preserves separate topics and original classifications',async()=>{
  const topic=(id:string,title:string)=>({id,title,body:'原话题说明',status:'OPEN',createdById:'old-user',createdAt:time,updatedAt:time});
  const message=(id:string,topicId:string,type:string|null=null,refs:any[]=[])=>({id,topicId,createdById:'old-user',kind:type?'RELATION':'TEXT',content:'原正文 '+id,relationType:type,targetRefs:refs,relationPayload:type?{title:'原分类标题'}:null,createdAt:time,updatedAt:time});
  const source=await fixture({Topic:[topic('topic-a','同名标题'),topic('topic-b','同名标题')],Message:[message('member-a','topic-a'),message('member-b','topic-b'),message('old-class','topic-a','CLASSIFY',[{kind:'message',messageId:'member-a'}])]});
  const targetSchema=newTestSchema();
  expect((await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema,apply:true})).blockers).toEqual([]);
  const app=await createTestApp({databaseSchema:targetSchema}),agent=request.agent(app);
  const root=(await agent.get('/api/ui/snapshot')).body;
  for(const id of ['topic-a','topic-b']){
    const migrated=root.messages.find((m:any)=>m.id===id);
    expect(migrated).toMatchObject({relationType:'CLASSIFY',content:id,relationPayload:{title:id}});
    expect(migrated.relationPayload).not.toHaveProperty('legacyTitle');
  }
  expect(root.messages.find((m:any)=>m.id==='old-class')).toMatchObject({relationType:'CLASSIFY',content:'原正文 old-class',relationPayload:{title:'原分类标题'},targetRefs:[{kind:'message',messageId:'member-a'}]});
  expect((await agent.get('/api/ui/snapshot?parent=old-class')).body.scope.title).toBe('原分类标题');
  const a=(await agent.get('/api/ui/snapshot?parent=topic-a')).body,b=(await agent.get('/api/ui/snapshot?parent=topic-b')).body;
  expect(a.messages.map((m:any)=>m.id)).toEqual(expect.arrayContaining(['member-a','old-class']));
  expect(a.messages.map((m:any)=>m.id)).not.toContain('member-b');
  expect(b.messages.map((m:any)=>m.id)).not.toContain('member-a');
});

it('preserves original JOIN target kinds and container declarations through independent ownership projection',async()=>{
  const make=(id:string,type:string|null,refs:any[]=[],source:string|null=null,at=time)=>({id,topicId:'old-topic',createdById:'old-user',kind:type?'RELATION':'TEXT',content:id,relationType:type,targetRefs:refs,relSourceId:source,createdAt:at,updatedAt:at});
  const source=await fixture({Message:[make('leaf',null),make('other',null),make('frame','ARRANGE',[{kind:'message',messageId:'leaf'}]),make('class-a','CLASSIFY',[{kind:'message',messageId:'other'}]),make('class-b','CLASSIFY'),make('join-a','JOIN',[{kind:'message',messageId:'frame'}],'class-a'),make('join-b','JOIN',[{kind:'relation',relationId:'frame'}],'class-b','2026-01-01T00:01:00.000Z'),make('join-other-a','JOIN',[{kind:'message',messageId:'other'}],'class-a'),make('join-other-b','JOIN',[{kind:'message',messageId:'other'}],'class-b','2026-01-01T00:01:00.000Z')]});
  const targetSchema=newTestSchema();
  expect((await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema,apply:true,preserveActiveState:true,readOnlyRehearsal:true})).blockers).toEqual([]);
  const app=await createTestApp({databaseSchema:targetSchema}),agent=request.agent(app);
  const view=(await agent.get('/api/ui/snapshot')).body;
  expect(view.relations.find((r:any)=>r.id==='join-a').targetRefs).toMatchObject([{kind:'relation',relationId:'frame',reference:{messageId:'frame'}}]);
  expect(view.relations.find((r:any)=>r.id==='join-b').targetRefs).toMatchObject([{kind:'relation',relationId:'frame'}]);
  // Reference shape does not give the same message a second effective owner.
  expect(collectContainerVisibleIds('class-a',view.relations).relationIds.has('frame')).toBe(false);
  expect(collectContainerVisibleIds('class-b',view.relations).relationIds.has('frame')).toBe(true);
  expect(view.relations.find((r:any)=>r.id==='class-b').targetRefs.map((ref:any)=>ref.messageId??ref.relationId).sort()).toEqual(['frame','other']);
  // A personal rejection can restore the other historical placement; physical
  // single-parent membership must not erase the older declaration.
  expect(collectContainerVisibleIds('class-a',view.relations,new Set(),new Set(['join-b'])).relationIds.has('frame')).toBe(true);
  expect(view.relations.find((r:any)=>r.id==='class-a').declaredTargetRefs).toMatchObject([{kind:'message',messageId:'other'}]);
  expect(collectContainerVisibleIds('class-a',view.relations).textIds.has('other')).toBe(false);
  expect(collectContainerVisibleIds('class-a',view.relations,new Set(),new Set(['join-other-b'])).textIds.has('other')).toBe(true);
  expect(view.relations.find((r:any)=>r.id==='frame').declaredTargetRefs).toMatchObject([{kind:'message',messageId:'leaf'}]);
});

it('creates visible JOIN history when grouping an imported classification inside its converted topic', async () => {
  const legacy = (id: string, relationType: string | null, refs: any[] = []) => ({ id, topicId: 'old-topic', createdById: 'old-user',
    kind: relationType ? 'RELATION' : 'TEXT', content: id, relationType, targetRefs: refs, relationPayload: relationType ? { title: id } : null,
    relSourceId: null, supersededBy: null, createdAt: time, updatedAt: time });
  const source = await fixture({ Message: [legacy('leaf', null), legacy('inner-class', 'CLASSIFY', [{ kind: 'message', messageId: 'leaf' }])] });
  const targetSchema = newTestSchema();
  expect((await migrateLegacy({ ...source, targetUrl: testDatabaseUrl(), targetSchema, apply: true })).blockers).toEqual([]);
  const app = await createTestApp({ databaseSchema: targetSchema }), agent = request.agent(app);
  const session = (await agent.post('/api/login').send({ name: '旧用户', password: 'short' })).body;
  const outerId = randomUUID(), requestId = randomUUID();
  const response = await agent.post('/api/ui/commands').set('x-csrf-token', session.csrf).set('x-request-id', requestId).send({ requestId, commands: [
    { id: outerId, method: 'POST', path: '/relations', body: { parentMessageId: 'old-topic', relationType: 'CLASSIFY', payload: { title: '新外层分类' },
      targetRefs: [{ kind: 'relation', relationId: 'inner-class', reference: { messageId: 'inner-class' } }] } },
  ] });
  expect(response.status, response.text).toBe(201);
  for (const view of [response.body.snapshots[0], (await agent.get('/api/ui/snapshot?parent=old-topic')).body]) {
    const joins = view.relations.filter((relation: any) => relation.relationType === 'JOIN' && relation.sourceMessageId === outerId);
    expect(joins).toHaveLength(1);
    expect(joins[0].targetRefs).toEqual([expect.objectContaining({ kind: 'relation', relationId: 'inner-class' })]);
    expect(joins[0].state.membershipActive).toBe(true);
    expect(view.messages.map((message: any) => message.id)).toContain(joins[0].id);
  }
  expect((await app.store.db.prepare('SELECT "parentId" FROM memberships WHERE "memberId"=$1').get('leaf'))?.parentId).toBe('inner-class');
});

it('preserves one parent through nested legacy JOINs while keeping the existing correction effective', async () => {
  const make=(id:string,type:string|null,refs:any[]=[],source:string|null=null,at=time,payload:any=null)=>({id,topicId:'old-topic',createdById:'old-user',kind:type?'RELATION':'TEXT',content:id==='target'?'好玩吗？':id,relationType:type,targetRefs:refs,relSourceId:source,relationPayload:payload,createdAt:at,updatedAt:at});
  const ref=(id:string,kind='message')=>kind==='relation'?{kind,relationId:id}:{kind,messageId:id};
  const source=await fixture({Message:[make('source',null),make('target',null),make('outer','CLASSIFY'),make('frame','ARRANGE',[ref('target')]),make('inner','CLASSIFY',[ref('frame','relation')]),
    make('target-outer','JOIN',[ref('target')],'outer'),make('frame-outer','JOIN',[ref('frame')],'outer'),
    make('target-frame','JOIN',[ref('target')],'frame','2026-01-01T00:01:00Z'),make('inner-outer','JOIN',[ref('inner','relation')],'outer'),
    make('frame-inner','JOIN',[ref('frame','relation')],'inner','2026-01-01T00:02:00Z'),make('source-outer','JOIN',[ref('source')],'outer'),
    make('correction','CORRECT',[{kind:'text-fragment',messageId:'target',text:'吗？',hash:'old'}],null,'2026-01-01T00:03:00Z',{correctionContent:'好玩1111'})]});
  const targetSchema=newTestSchema();
  expect((await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema,apply:true,preserveActiveState:true,readOnlyRehearsal:true})).blockers).toEqual([]);
  const app=await createTestApp({databaseSchema:targetSchema}),view=(await request(app).get('/api/ui/snapshot')).body;
  const model=convertMessagesToDemoModel(view.messages,view.relations),effect=deriveContainerEffect({...model,relations:view.relations,username:null});
  for(const [memberId,parentId] of [['source','outer'],['target','frame'],['frame','inner'],['inner','outer']]){
    expect((await app.store.db.prepare('SELECT "parentId" FROM memberships WHERE "memberId"=$1').get(memberId))?.parentId).toBe(parentId);
    const owners=view.relations.filter((relation:any)=>['CLASSIFY','ARRANGE'].includes(relation.relationType)).filter((relation:any)=>{
      const direct=effect.ownership.direct(relation.id);return direct.textIds.has(memberId)||direct.relationIds.has(memberId);
    });
    expect(owners.map((relation:any)=>relation.id)).toEqual([parentId]);
  }
  expect(effect.effectiveJoinIds.has('frame-outer')).toBe(false);
  const outer=projectContainerCanvas(effect,{kind:'inside',id:'outer'}),inner=projectContainerCanvas(effect,{kind:'inside',id:'inner'});
  expect(outer.messages.map(message=>message.id)).toEqual(expect.arrayContaining(['source','inner']));
  expect(outer.messages.map(message=>message.id)).not.toContain('target');
  expect(inner.messages.map(message=>message.id)).toContain('target');
  const versions=computeCorrectionVersions(model.messages,model.edges,effect.suppressed).get('target');
  expect(versions?.current?.content).toBe('好玩1111');
  expect(versions?.versions[0].valid).toBe(true);
  expect(view.messages.find((message:any)=>message.id==='target').content).toBe('好玩吗？');
});

it('reports locked funds, active rounds and mismatched balances without touching the target',async()=>{
  const source=await fixture({PointAccount:[{userId:'old-user',available:499,locked:10}],SettlementRound:[{id:'active-round',messageId:'old-message',createdByUserId:'old-user',status:'VOTING'}]});
  const targetSchema=newTestSchema();
  const report=await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema,apply:true});
  expect(report.applied).toBe(false);expect(report.blockers.join('\n')).toMatch(/对账失败/);expect(report.blockers.join('\n')).toMatch(/锁定资金/);expect(report.blockers.join('\n')).toMatch(/active-round/);
  const pool=new Pool({connectionString:testDatabaseUrl()});
  try {expect((await pool.query('SELECT to_regnamespace($1) AS schema',[targetSchema])).rows[0].schema).toBeNull();} finally {await pool.end();}
});

it('keeps closed historical rounds visible and rejects cross-boundary wagers',async()=>{
  const source=await fixture({SettlementRound:[{id:'old-round',messageId:'old-message',createdByUserId:'old-user',status:'SETTLED',result:'TRUE',settlementType:'TRUTH',openedAt:time,closedAt:time,settlementPro:10,settlementCon:5,previousRoundId:null}]});
  const targetSchema=newTestSchema();
  expect((await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema,apply:true})).applied).toBe(true);
  const app=await createTestApp({databaseSchema:targetSchema}),agent=request.agent(app);
  const login=await agent.post('/api/login').send({name:'旧用户',password:'short'});
  const history=await agent.get('/api/messages/old-message/context');
  expect(history.body.rounds).toHaveLength(1);expect(history.body.rounds[0]).toMatchObject({id:'old-round',status:'settled',pro:10,con:5});
  const wager=await agent.post('/api/messages').set('x-csrf-token',login.body.csrf).send({requestId:randomUUID(),wager:1,parts:[{id:'stance',type:'relation',relation:'agree',roles:{target:[{id:'target',reference:{messageId:'old-message'}}]}}]});
  expect(wager.status,wager.text).toBe(409);expect(await app.store.account('old-user')).toMatchObject({available:500,locked:0});
});

it('rejects invalid references atomically and leaves no imported users after a failure',async()=>{
  const source=await fixture({Message:[{id:'broken',topicId:'old-topic',createdById:'old-user',kind:'RELATION',content:'bad',relationType:'REFERENCE',targetRefs:[{kind:'message',messageId:'absent'}],createdAt:time,updatedAt:time}]});
  const report=await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema:newTestSchema(),apply:true});
  expect(report.applied).toBe(false);expect(report.blockers.join('\n')).toContain('旧引用目标不存在');
});

it('converts unambiguous container and JOIN ownership, with live personal marks superseding imported marks',async()=>{
  const message=(id:string,type:string|null,refs:any[],source:string|null=null,at=time)=>({id,topicId:'old-topic',createdById:'old-user',kind:type?'RELATION':'TEXT',content:id,contentType:'TEXT',relationType:type,targetRefs:refs,relationPayload:type==='CLASSIFY'?{title:'旧分类'}:{},relSourceId:source,supersededBy:null,createdAt:at,updatedAt:at});
  const source=await fixture({Message:[
    message('original',null,[]),
    message('old-group','CLASSIFY',[{kind:'message',messageId:'original'}],null,'2026-01-01T00:01:00.000Z'),
    message('old-read','READ',[{kind:'message',messageId:'original'}],null,'2026-01-01T00:02:00.000Z'),
    message('joined',null,[],null,'2026-01-01T00:03:00.000Z'),
    message('old-join','JOIN',[{kind:'message',messageId:'joined'}],'old-group','2026-01-01T00:04:00.000Z'),
  ]});
  const targetSchema=newTestSchema();
  const report=await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema,apply:true});
  expect(report.blockers).toEqual([]);expect(report.applied).toBe(true);
  const app=await createTestApp({databaseSchema:targetSchema}),agent=request.agent(app);
  const group=await agent.get('/api/ui/snapshot?parent=old-group');
  expect(group.status,group.text).toBe(200);
  expect(group.body.messages.map((row:any)=>row.id)).toEqual(expect.arrayContaining(['original','joined']));
  const login=await agent.post('/api/login').send({name:'旧用户',password:'short'});
  const unread=await agent.post('/api/messages').set('x-csrf-token',login.body.csrf).send({requestId:randomUUID(),parts:[{id:'mark',type:'relation',relation:'unread',roles:{target:[{id:'target',reference:{messageId:'original'}}]}}]});
  expect(unread.status,unread.text).toBe(201);
  const mark=await app.store.db.prepare(`SELECT action FROM personal_marks WHERE "targetId"='original'`).get();
  expect(mark?.action).toBe('unread');
});

it('refuses ambiguous container ownership during preflight',async()=>{
  const source=await fixture({Message:[
    {id:'original',topicId:'old-topic',createdById:'old-user',kind:'TEXT',content:'old',createdAt:time,updatedAt:time},
    ...['group-one','group-two'].map(id=>({id,topicId:'old-topic',createdById:'old-user',kind:'RELATION',content:id,relationType:'CLASSIFY',targetRefs:[{kind:'message',messageId:'original'}],createdAt:time,updatedAt:time})),
  ]});
  expect((await migrateLegacy(source)).blockers.join('\n')).toContain('同时属于多个组织');
});

it('creates an explicitly read-only rehearsal preserving locked funds and pending rounds',async()=>{
  const source=await fixture({PointAccount:[{userId:'old-user',available:500,locked:10}],SettlementRound:[{id:'pending',messageId:'old-message',createdByUserId:'old-user',status:'VOTING',settlementType:'TRUTH',openedAt:time,closedAt:null}]});
  const targetSchema=newTestSchema();
  const report=await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema,apply:true,readOnlyRehearsal:true});
  expect(report.applied).toBe(true);expect(report.mode).toBe('read-only-rehearsal');expect(report.blockers.length).toBeGreaterThan(0);
  const app=await createTestApp({databaseSchema:targetSchema,settlementTickMs:1}),agent=request.agent(app);
  expect(await app.store.account('old-user')).toMatchObject({available:500,locked:10});
  expect((await agent.get('/api/messages/old-message/context')).body.rounds[0]).toMatchObject({status:'frozen'});
  const before=await app.store.latestSequence();
  expect((await agent.post('/api/login').send({name:'旧用户',password:'short'})).status).toBe(200);
  expect((await agent.post('/api/messages').send({requestId:randomUUID(),parts:[{id:'body',type:'text',text:'blocked'}]})).status).toBe(503);
  expect((await agent.post('/api/register').send({name:'blocked-user',password:'long-password'})).status).toBe(503);
  await new Promise(resolve=>setTimeout(resolve,25));
  expect(await app.store.latestSequence()).toBe(before);
});

it('preserves separate truth/value/delegation pools, active principal and source account statistics',async()=>{
  const stakes=['TRUTH','VALUE','DELEGATION'].map((settlementType,index)=>({id:`stake-${index}`,userId:'old-user',messageId:'old-message',roundId:settlementType==='DELEGATION'?null:'pending',side:'PRO',amount:index+1,settlementType,createdAt:time}));
  const source=await fixture({PointAccount:[{userId:'old-user',available:500,locked:6}],Stake:stakes,BetPool:stakes.map(row=>({messageId:row.messageId,settlementType:row.settlementType,lockedPro:row.amount,lockedCon:0})),SettlementRound:[{id:'pending',messageId:'old-message',createdByUserId:'old-user',status:'VOTING',settlementType:'TRUTH',openedAt:time,closedAt:null}]});
  const targetSchema=newTestSchema();
  const report=await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema,apply:true,readOnlyRehearsal:true,preserveActiveState:true});
  expect(report.applied).toBe(true);expect(report.blockers).toEqual([]);expect(report.financialAudit).toMatchObject({accountLocked:6,poolExposure:6,activePrincipal:6,fundingGap:0});
  const app=await createTestApp({databaseSchema:targetSchema}),agent=request.agent(app);
  const view=await agent.get('/api/ui/snapshot');
  expect(view.status,view.text).toBe(200);
  expect(view.body.stakes['old-message'].pools).toMatchObject({TRUTH:{lockedPro:1,lockedCon:0},VALUE:{lockedPro:2,lockedCon:0},DELEGATION:{lockedPro:3,lockedCon:0}});
  expect(view.body.stakes['old-message'].stakes).toHaveLength(3);
  const compact=await agent.get('/api/ui/snapshot?format=compact-v1&batch=4').set('Accept-Encoding','gzip');
  expect(compact.headers['content-encoding']).toBe('gzip');
  expect(decodeWorkbenchSnapshot<WorkbenchSnapshot>(compact.body)).toEqual(view.body);
  const login=await agent.post('/api/login').send({name:'旧用户',password:'short'});
  expect(login.status,login.text).toBe(200);
  const balance=await agent.get('/api/ui/points/balance');
  expect(balance.body.breakdown).toMatchObject({totalLost:15,totalEarned:20});
  expect(await app.store.account('old-user')).toMatchObject({available:500,locked:6});
});

it('loads every migrated message, JOIN, reference and legacy field with fewer round trips and bytes',async()=>{
  const originals=Array.from({length:420},(_,index)=>({
    id:`old-${String(index).padStart(4,'0')}`,topicId:'old-topic',createdById:'old-user',
    kind:'TEXT',content:`原消息 ${index}：`+'完整历史正文。'.repeat(12),contentType:'TEXT',relationType:null,
    targetRefs:null,relationPayload:null,relSourceId:null,supersededBy:null,createdAt:time,updatedAt:time,
  }));
  const legacyRelations=[
    {id:'old-group',kind:'RELATION',relationType:'CLASSIFY',relSourceId:null,targetRefs:[{kind:'message',messageId:'old-0000'},{kind:'message',messageId:'old-0419'}],relationPayload:{title:'保留原分类声明'}},
    {id:'join-first',kind:'RELATION',relationType:'JOIN',relSourceId:'old-group',targetRefs:[{kind:'message',messageId:'old-0000'}]},
    {id:'join-last',kind:'RELATION',relationType:'JOIN',relSourceId:'old-group',targetRefs:[{kind:'message',messageId:'old-0419'}]},
    {id:'cross-reference',kind:'RELATION',relationType:'REFERENCE',relSourceId:'old-0419',targetRefs:[{kind:'message',messageId:'old-0000'}]},
  ].map(row=>({...row,topicId:'old-topic',createdById:'old-user',content:`原关系 ${row.id}`,createdAt:time,updatedAt:time}));
  const source=await fixture({Message:[...originals,...legacyRelations]}),targetSchema=newTestSchema();
  expect((await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema,apply:true,readOnlyRehearsal:true,preserveActiveState:true})).applied).toBe(true);
  const app=await createTestApp({databaseSchema:targetSchema});
  async function loadAll(compact:boolean,parent='root') {
    const store=new WorkbenchStore();let cursor:string|null= null,requests=0,bytes=0;
    do {
      const response:request.Response=await request(app).get('/api/ui/snapshot').query({parent,limit:100,...(cursor?{cursor}:{}),...(compact?{batch:4,format:'compact-v1'}:{})}).set('Accept-Encoding',compact?'gzip':'identity');
      expect(response.status,response.text).toBe(200);
      if(compact) expect(response.headers['content-encoding']).toBe('gzip');
      const data:WorkbenchSnapshot=decodeWorkbenchSnapshot<WorkbenchSnapshot>(response.body);
      store.apply(data,requests===0);cursor=data.nextCursor??null;
      requests++;bytes+=Number(response.headers['content-length']);
      expect(requests).toBeLessThan(20);
    } while(cursor);
    return {view:store.snapshot(),requests,bytes};
  }
  const original=await loadAll(false),optimized=await loadAll(true);
  expect(optimized.view).toEqual(original.view);
  expect(collectContainerVisibleIds('old-group',optimized.view.relations)).toEqual(collectContainerVisibleIds('old-group',original.view.relations));
  expect(optimized.view.relations.map(row=>row.id)).toEqual(expect.arrayContaining(['old-group','join-first','join-last','cross-reference']));
  for(const message of originals) expect(optimized.view.messages.find(row=>row.id===message.id)?.content).toBe(message.content);
  expect(optimized.requests).toBe(Math.ceil(original.view.messages.length/400));
  expect(optimized.requests).toBeLessThan(original.requests);
  expect(optimized.bytes).toBeLessThan(original.bytes/3);
  expect((await loadAll(true,'old-topic')).view).toEqual((await loadAll(false,'old-topic')).view);
  console.info('Legacy snapshot transport:',JSON.stringify({messages:original.view.messages.length,relations:original.view.relations.length,before:{requests:original.requests,bytes:original.bytes},after:{requests:optimized.requests,bytes:optimized.bytes}}));
},60_000);

it('locks only available virtual points without minting or settling, and tolerates an unfunded remainder',async()=>{
  const source=await fixture({Stake:[{id:'virtual-stake',userId:'old-user',messageId:'old-message',roundId:'pending',side:'PRO',amount:700,settlementType:'TRUTH',createdAt:time}],BetPool:[{messageId:'old-message',settlementType:'TRUTH',lockedPro:700,lockedCon:0}],SettlementRound:[{id:'pending',messageId:'old-message',createdByUserId:'old-user',status:'VOTING',settlementType:'TRUTH',openedAt:time,closedAt:null}]});
  const targetSchema=newTestSchema();
  const report=await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema,apply:true,readOnlyRehearsal:true,preserveActiveState:true,lockAvailable:true});
  expect(report.fundingAdjustments).toEqual([{userId:'old-user',amount:500,remaining:200}]);
  expect(report.applied).toBe(true);
  const app=await createTestApp({databaseSchema:targetSchema});
  expect(await app.store.account('old-user')).toMatchObject({available:0,locked:500});
  expect(await app.store.setting('minted')).toBe(512);
  expect((await app.store.db.prepare(`SELECT body FROM published_round_reports WHERE id='pending'`).get())!.body.status).toBe('VOTING');
  expect((await migrateLegacy(source)).available).toBe(500);
});

it('operates funded imported truth/value rounds without reversing historical payouts or automatically settling',async()=>{
  const rounds=[{id:'historical',messageId:'old-message',createdByUserId:'old-user',status:'SETTLED',result:'TRUE',settlementType:'TRUTH',openedAt:time,closedAt:time,previousRoundId:null},...['TRUTH','VALUE'].map((type,index)=>({id:`active-${type}`,messageId:'old-message',createdByUserId:'old-user',status:'VOTING',settlementType:type,openedAt:'2026-01-02T00:00:00.000Z',closedAt:null,previousRoundId:index===0?'historical':null}))];
  const stakes=['TRUTH','VALUE'].map((type,index)=>({id:`stake-${type}`,userId:'old-user',messageId:'old-message',roundId:`active-${type}`,side:'PRO',amount:10+index,settlementType:type,createdAt:time}));
  const source=await fixture({SettlementRound:rounds,Stake:stakes,BetPool:stakes.map(row=>({messageId:'old-message',settlementType:row.settlementType,lockedPro:row.amount,lockedCon:0}))});
  const options={...source,targetUrl:testDatabaseUrl(),targetSchema:newTestSchema(),apply:true,readOnlyRehearsal:true,preserveActiveState:true,lockAvailable:true,nativeRehearsal:true};
  const report=await migrateLegacy(options);
  expect(report).toMatchObject({applied:true,mode:'native-rehearsal',blockers:[]});
  const app=await createTestApp({databaseSchema:options.targetSchema,settlementTickMs:1}),user=await app.store.user('old-user');
  const run=async(path:string,body:Record<string,unknown>={})=>executeBatch(app.store,user,{requestId:randomUUID(),commands:[{id:randomUUID(),method:'POST',path,body}]});
  await new Promise(resolve=>setTimeout(resolve,25));
  expect(await app.store.account(user.id)).toMatchObject({available:479,locked:21});
  const original=(await app.store.db.prepare(`SELECT body FROM rounds WHERE id='historical'`).get())!.body;
  await run('/rounds/active-TRUTH/votes',{vote:'TRUE',amount:3});
  expect((await stakesFor(app.store,['old-message']))['old-message'].pools).toMatchObject({TRUTH:{lockedPro:13},VALUE:{lockedPro:11}});
  await run('/rounds/active-TRUTH/close-and-settle');
  expect(await app.store.account(user.id)).toMatchObject({locked:11});
  expect((await stakesFor(app.store,['old-message']))['old-message'].pools).toMatchObject({TRUTH:{lockedPro:0},VALUE:{lockedPro:11}});
  await run('/rounds/active-VALUE/close-and-settle');
  expect(await app.store.account(user.id)).toMatchObject({locked:0});
  expect((await app.store.db.prepare(`SELECT body FROM rounds WHERE id='historical'`).get())!.body).toEqual(original);
  expect(await app.store.db.prepare(`SELECT 1 FROM ledger WHERE reason='撤回先前对赌分配'`).get()).toBeUndefined();
  await run('/relations',{relationType:'AGREE',targetRefs:[{kind:'message',messageId:'old-message'}],wager:2});
  const next=JSON.parse(String((await app.store.db.prepare(`SELECT body FROM rounds WHERE body::jsonb #>> '{target,messageId}'='old-message' AND body::jsonb ->> 'settlementType'='TRUTH' ORDER BY position DESC LIMIT 1`).get())!.body));
  expect(next).not.toHaveProperty('legacyActiveBoundary');
  expect((await stakesFor(app.store,['old-message']))['old-message'].pool.lockedPro).toBe(2);
  await run(`/rounds/${next.id}/close-and-settle`);
  expect(await app.store.account(user.id)).toMatchObject({locked:0});
  const exported=(await request(app).get('/api/ui/export')).body;
  expect(replayArchive(exported).accounts.get(user.id)).toEqual(await app.store.account(user.id));
  expect((await migrateLegacy(source)).sourceDigest).toBe(report.sourceDigest);
});

it('preserves delegation reward and extra reserve until an explicit synthetic completion verdict',async()=>{
  const task={id:'task',topicId:'old-topic',createdById:'old-user',kind:'RELATION',content:'委托',relationType:'DELEGATION',targetRefs:[],relationPayload:{delegationKind:'CREATE',rewardAmount:100},createdAt:time,updatedAt:time};
  const fulfillment={...task,id:'fulfillment',content:'完成声明',targetRefs:[{kind:'message',messageId:'task'}],relationPayload:{delegationKind:'FULFILL'}};
  const source=await fixture({Message:[task,fulfillment],Stake:[{id:'reward-stake',userId:'old-user',messageId:'task',roundId:null,side:'PRO',amount:110,settlementType:'DELEGATION',createdAt:time},{id:'vote-stake',userId:'old-user',messageId:'fulfillment',roundId:'completion-round',side:'PRO',amount:1,settlementType:'TRUTH',createdAt:time}],BetPool:[{messageId:'task',settlementType:'DELEGATION',lockedPro:110,lockedCon:0},{messageId:'fulfillment',settlementType:'TRUTH',lockedPro:1,lockedCon:0}],SettlementRound:[{id:'completion-round',messageId:'fulfillment',createdByUserId:'old-user',status:'VOTING',settlementType:'TRUTH',openedAt:time,closedAt:null}]});
  const targetSchema=newTestSchema();
  const report=await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema,apply:true,readOnlyRehearsal:true,preserveActiveState:true,lockAvailable:true,nativeRehearsal:true});
  expect(report.applied).toBe(true);
  const app=await createTestApp({databaseSchema:targetSchema}),user=await app.store.user('old-user');
  expect(await app.store.account(user.id)).toMatchObject({available:389,locked:111});
  expect(await app.store.db.prepare(`SELECT * FROM escrows WHERE "messageId"='task'`).get()).toMatchObject({amount:100,recipientId:null});
  await executeBatch(app.store,user,{requestId:randomUUID(),commands:[{id:randomUUID(),method:'POST',path:'/rounds/completion-round/close-and-settle',body:{}}]});
  expect(await app.store.account(user.id)).toMatchObject({locked:10});
  expect((await stakesFor(app.store,['task'])).task.pools.DELEGATION.lockedPro).toBe(10);
  expect(await app.store.db.prepare(`SELECT * FROM escrows WHERE "messageId"='task'`).get()).toMatchObject({amount:100,recipientId:'old-user'});
  expect((await app.store.db.prepare(`SELECT body FROM legacy_records WHERE "tableName"='BetPool' AND body->>'messageId'='task'`).get())!.body.lockedPro).toBe(110);
  expect((await migrateLegacy(source)).sourceDigest).toBe(report.sourceDigest);
});

it('refuses operable mode if available points cannot cover active principal',async()=>{
  const source=await fixture({Stake:[{id:'shortfall',userId:'old-user',messageId:'old-message',roundId:'pending',side:'PRO',amount:700,settlementType:'TRUTH',createdAt:time}],BetPool:[{messageId:'old-message',settlementType:'TRUTH',lockedPro:700,lockedCon:0}],SettlementRound:[{id:'pending',messageId:'old-message',createdByUserId:'old-user',status:'VOTING',settlementType:'TRUTH',openedAt:time}]});
  const report=await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema:newTestSchema(),apply:true,readOnlyRehearsal:true,preserveActiveState:true,lockAvailable:true,nativeRehearsal:true});
  expect(report.applied).toBe(false);expect(report.blockers.join('\n')).toContain('未覆盖本金');
});

it('projects container members in declared layout order instead of global message insertion order',async()=>{
  const base={topicId:'old-topic',createdById:'old-user',kind:'TEXT',content:'正文',createdAt:time,updatedAt:time};
  const source=await fixture({Message:[{...base,id:'a'},{...base,id:'b'},{...base,id:'frame',kind:'RELATION',relationType:'ARRANGE',targetRefs:[{kind:'message',messageId:'b'},{kind:'message',messageId:'a'}],relationPayload:{targetLayout:'single-row'}}]});
  const schema=newTestSchema();expect((await migrateLegacy({...source,targetUrl:testDatabaseUrl(),targetSchema:schema,apply:true})).applied).toBe(true);
  const app=await createTestApp({databaseSchema:schema});
  const response=await request(app).get('/api/ui/snapshot');expect(response.status,response.text).toBe(200);
  const frame=response.body.messages.find((row:any)=>row.id==='frame');
  expect(frame.targetRefs.map((ref:any)=>ref.reference.messageId)).toEqual(['b','a']);
  expect(frame.payload.targetLayout).toBe('single-row');
});
