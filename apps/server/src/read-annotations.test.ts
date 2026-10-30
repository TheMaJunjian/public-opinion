import {afterEach,expect,it} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createTestApp,cleanupTestDatabases,withTestCommandContributions} from './test-database.js';
import {bodyVersion,messageReadingKey,type ReadingMark} from '@gonglun/core';
import {authoredReadingMark} from '../../../frontend/src/pages/workbench/model/readingProgress.js';
import {comparisonReadingMark} from '../../../frontend/src/pages/workbench/model/comparisonReading.js';

const apps:Awaited<ReturnType<typeof createTestApp>>[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();await cleanupTestDatabases();});

it('persists a comparison separately without acknowledging the message, correction or influences',async()=>{
  const app=await createTestApp();apps.push(app);const agent=request.agent(app);
  const session=(await agent.post('/api/register').send({username:'对比阅读者',password:'test-password-123'})).body;
  const original=await agent.post('/api/ui/messages').set('x-csrf-token',session.csrf).set('x-request-id',randomUUID())
    .send(withTestCommandContributions('/messages',{content:'原文'}));
  expect(original.status,original.text).toBe(201);
  const correction=await agent.post('/api/ui/relations').set('x-csrf-token',session.csrf).set('x-request-id',randomUUID())
    .send(withTestCommandContributions('/relations',{relationType:'CORRECT',sourceMessageId:null,targetRefs:[{kind:'message',messageId:original.body.id,reference:{messageId:original.body.id,revision:1,partId:'body'}}],payload:{correctionContent:'更正正文',correctionKind:'TEXT'}}));
  expect(correction.status,correction.text).toBe(201);
  const version=bodyVersion(original.body.id,1,[{messageId:correction.body.id,revision:1,kind:'TEXT'}]);
  const mark=comparisonReadingMark(version,'原文','更正正文'),sequence=await app.store.latestSequence(),account=await app.store.account(session.user.id);
  const response=await agent.post('/api/ui/reading-state').set('x-csrf-token',session.csrf).send({marks:[mark]});
  expect(response.status,response.text).toBe(200);expect(response.body.marks[0]).toMatchObject(mark);
  expect(response.body.marks[0].firstConfirmedAt).toBeUndefined();expect(response.body.marks[0].directConfirmedAt).toBeUndefined();
  const stored=(await agent.get('/api/ui/reading-state')).body.marks;
  expect(stored).toEqual([expect.objectContaining({scope:'comparison',version})]);
  for(const invalid of [{...mark,scope:'message'},{...mark,key:'comparison:invalid'},{...mark,confirmation:{kind:'direct',messageId:mark.messageId}}])
    expect((await agent.post('/api/ui/reading-state').set('x-csrf-token',session.csrf).send({marks:[invalid]})).status).toBe(400);
  const outcomes=['effective','ineffective'].map(resultKey=>({format:3,messageId:correction.body.id,scope:'influence',key:`correct:${correction.body.id}`,
    eventId:JSON.stringify([correction.body.id,1,correction.body.sequence]),resultKey}));
  const confirmed=await agent.post('/api/ui/reading-state').set('x-csrf-token',session.csrf).send({marks:outcomes});
  expect(confirmed.status,confirmed.text).toBe(200);
  const relationMarks=(await agent.get('/api/ui/reading-state')).body.marks.filter((mark:ReadingMark)=>mark.messageId===correction.body.id);
  expect(relationMarks).toHaveLength(2);expect(new Set(relationMarks.map((mark:ReadingMark)=>mark.resultKey))).toEqual(new Set(['effective','ineffective']));
  expect(relationMarks.every((mark:ReadingMark)=>mark.scope==='influence')).toBe(true);
  expect(await app.store.latestSequence()).toBe(sequence);expect(await app.store.account(session.user.id)).toEqual(account);
});

it('accepts the workbench author confirmation after sending and leaves targets unread',async()=>{
  const app=await createTestApp();apps.push(app);const agent=request.agent(app);
  const registration=await agent.post('/api/register').send({username:'发送后阅读',password:'test-password-123'});
  const create=async(content:string)=>{
    const response=await agent.post('/api/ui/messages').set('x-csrf-token',registration.body.csrf).set('x-request-id',randomUUID())
      .send(withTestCommandContributions('/messages',{content}));
    expect(response.status,response.text).toBe(201);return response.body;
  };
  const target=await create('引用目标'),sent=await create('刚发送的正文');
  const citation=await agent.post('/api/ui/relations').set('x-csrf-token',registration.body.csrf).set('x-request-id',randomUUID())
    .send(withTestCommandContributions('/relations',{relationType:'REFERENCE',sourceMessageId:sent.id,targetRefs:[{kind:'message',messageId:target.id}]}));
  expect(citation.status,citation.text).toBe(201);
  const saved=await agent.post('/api/ui/reading-state').set('x-csrf-token',registration.body.csrf)
    .send({marks:[authoredReadingMark(sent,'display:author')]});
  expect(saved.status,saved.text).toBe(200);
  expect(saved.body.marks).toEqual([expect.objectContaining({messageId:sent.id,state:'READ',directConfirmedAt:expect.any(String)})]);
  const state=(await agent.get('/api/ui/reading-state')).body.marks;
  expect(state.some((mark:ReadingMark)=>mark.messageId===target.id)).toBe(false);
});

it('records an author or another reader without requiring separate correction-body confirmations',async()=>{
  const app=await createTestApp();apps.push(app);const author=request.agent(app),other=request.agent(app),reader=request.agent(app);
  const own=(await author.post('/api/register').send({username:'正文作者',password:'test-password-123'})).body;
  const peer=(await other.post('/api/register').send({username:'更正读者',password:'test-password-123'})).body;
  const viewer=(await reader.post('/api/register').send({username:'未阅读者',password:'test-password-123'})).body;
  const sent=await author.post('/api/ui/messages').set('x-csrf-token',own.csrf).set('x-request-id',randomUUID())
    .send(withTestCommandContributions('/messages',{content:'作者已读原文'}));
  expect(sent.status,sent.text).toBe(201);
  const correction=await other.post('/api/ui/relations').set('x-csrf-token',peer.csrf).set('x-request-id',randomUUID())
    .send(withTestCommandContributions('/relations',{relationType:'CORRECT',sourceMessageId:null,targetRefs:[{kind:'message',messageId:sent.body.id,reference:{messageId:sent.body.id,revision:1,partId:'body'}}],payload:{correctionContent:'更正正文',correctionKind:'TEXT'}}));
  expect(correction.status,correction.text).toBe(201);
  const mark=authoredReadingMark(sent.body,'display:original'),sequence=await app.store.latestSequence();
  const confirmed=await author.post('/api/ui/reading-state').set('x-csrf-token',own.csrf).send({marks:[mark]});
  expect(confirmed.status,confirmed.text).toBe(200);
  expect(confirmed.body.marks[0]).toMatchObject({messageId:sent.body.id,state:'READ',originalSeen:true});
  const unknown=await reader.post('/api/ui/reading-state').set('x-csrf-token',viewer.csrf).send({marks:[mark]});
  expect(unknown.status,unknown.text).toBe(200);
  expect((await reader.get('/api/ui/reading-state')).body.marks.some((mark:ReadingMark)=>mark.messageId===correction.body.id)).toBe(false);
  expect(await app.store.latestSequence()).toBe(sequence);
});

it('stores viewing confirmations privately and durably without creating messages, fees, journal changes or notifications',async()=>{
  const app=await createTestApp();apps.push(app);
  const alice=request.agent(app),bob=request.agent(app);
  const first=await alice.post('/api/register').send({username:'阅读者甲',password:'test-password-123'});
  const second=await bob.post('/api/register').send({username:'阅读者乙',password:'test-password-123'});
  expect(first.status,first.text).toBe(201);expect(second.status,second.text).toBe(201);
  const original=await alice.post('/api/ui/messages').set('x-csrf-token',first.body.csrf).set('x-request-id',randomUUID())
    .send(withTestCommandContributions('/messages',{content:'待阅读消息'}));
  expect(original.status,original.text).toBe(201);
  const before=await app.store.account(first.body.user.id),sequence=await app.store.latestSequence();
  const counts=()=>app.store.db.prepare('SELECT (SELECT COUNT(*) FROM ledger) AS ledger,(SELECT COUNT(*) FROM messages) AS messages,(SELECT COUNT(*) FROM notification_receipts) AS notifications').get();
  const previous=await counts();
  const version=bodyVersion(original.body.id),key=messageReadingKey(version.messageId);
  const marks=[{format:3,version,messageId:original.body.id,scope:'message',key,signature:'display-v2',bodySignature:key},
    {format:3,messageId:original.body.id,scope:'influence',key:'recommend:',eventId:JSON.stringify([original.body.id,1,original.body.sequence])}];
  for(let index=0;index<2;index++){
    const saved=await alice.post('/api/ui/reading-state').set('x-csrf-token',first.body.csrf).send({marks});
    expect(saved.status,saved.text).toBe(200);expect(saved.body.marks).toMatchObject(marks.map(mark=>({...mark,state:'READ',position:expect.any(Number),updatedAt:expect.any(String)})));expect(saved.body.marks[0]).toMatchObject({firstConfirmedAt:expect.any(String),originalSeen:true,baselineSequence:sequence});
  }
  const reading=await alice.get('/api/ui/reading-state');
  expect(reading.status,reading.text).toBe(200);expect(reading.body.marks).toHaveLength(2);
  expect(reading.headers['cache-control']).toBe('private, no-store');
  expect((await bob.get('/api/ui/reading-state')).body.marks).toEqual([]);
  expect((await request(app).get('/api/ui/reading-state')).status).toBe(401);
  expect(await app.store.account(first.body.user.id)).toEqual(before);
  expect(await app.store.latestSequence()).toBe(sequence);expect(await counts()).toEqual(previous);
  const publicView=(await bob.get('/api/ui/snapshot')).body;
  expect(JSON.stringify(publicView)).not.toContain('body-v2');
  // Session storage survives reopening the application on the same database.
  await app.close();apps.splice(apps.indexOf(app),1);
  const reopened=await createTestApp({databaseSchema:app.store.db.schema});apps.push(reopened);
  const logged=await request.agent(reopened).post('/api/login').send({username:'阅读者甲',password:'test-password-123'});
  expect(logged.status,logged.text).toBe(200);
  const rows=await reopened.store.db.prepare('SELECT body FROM reading_marks WHERE "userId"=$1').all(first.body.user.id);
  expect(rows).toHaveLength(2);
});

it('rejects public READ / UNREAD and validates private updates atomically with session and CSRF protection',async()=>{
  const app=await createTestApp();apps.push(app);const agent=request.agent(app);
  const registration=await agent.post('/api/register').send({username:'阅读状态校验',password:'test-password-123'});
  const before=await app.store.account(registration.body.user.id),sequence=await app.store.latestSequence();
  for(const type of ['READ','UNREAD']){
    const legacy=await agent.post('/api/ui/relations').set('x-csrf-token',registration.body.csrf).send({relationType:type,targetRefs:[],recommendation:1});
    expect(legacy.status,legacy.text).toBe(400);expect(legacy.text).toContain('个人查看状态');
    const native=await agent.post('/api/messages').set('x-csrf-token',registration.body.csrf).send({requestId:randomUUID(),recommendation:1,parts:[{id:'relation',type:'relation',relation:type.toLowerCase(),roles:{}}]});
    expect(native.status,native.text).toBe(400);expect(native.text).toContain('个人查看状态');
  }
  expect((await agent.post('/api/ui/reading-state').send({marks:[]})).status).toBe(403);
  const invalid=await agent.post('/api/ui/reading-state').set('x-csrf-token',registration.body.csrf).send({marks:[{format:3,messageId:'missing',scope:'influence',key:'agree:',eventId:'selection:missing'}]});
  expect(invalid.status,invalid.text).toBe(404);
  expect((await agent.get('/api/ui/reading-state')).body.marks).toEqual([]);
  expect(await app.store.account(registration.body.user.id)).toEqual(before);expect(await app.store.latestSequence()).toBe(sequence);
});

it('keeps standalone and unknown historical body reads when a later included confirmation overwrites the same version',async()=>{
  const app=await createTestApp();apps.push(app);const agent=request.agent(app);
  const session=(await agent.post('/api/register').send({name:'确认来源',password:'test-password-123'})).body;
  const post=async(path:string,body:Record<string,unknown>)=>{
    const response=await agent.post('/api/ui'+path).set('x-csrf-token',session.csrf).set('x-request-id',randomUUID()).send(withTestCommandContributions(path,body));
    expect(response.status,response.text).toBe(201);return response.body;
  };
  const member=await post('/messages',{content:'来源'}),targets=new Map<string,string>();
  for(const key of ['direct-version','legacy-version','included-version','concurrent-version'])targets.set(key,(await post('/relations',{relationType:'CLASSIFY',targetRefs:[],payload:{title:key}})).id);
  const save=async(key:string,kind?:'direct'|'included')=>{
    const messageId=targets.get(key)!,version=bodyVersion(messageId),signature=messageReadingKey(version.messageId);
    const mark:ReadingMark={format:3,version,messageId,scope:'message',key:signature,bodySignature:signature,signature:'display',
      ...(kind?{confirmation:{kind,messageId:kind==='direct'?messageId:member.id}}:{})};
    const response=await agent.post('/api/ui/reading-state').set('x-csrf-token',session.csrf).send({marks:[mark]});
    expect(response.status,response.text).toBe(200);return response.body.marks[0] as ReadingMark;
  };
  const before=await app.store.account(session.user.id),sequence=await app.store.latestSequence();
  const standalone=await save('direct-version','direct'),later=await save('direct-version','included');
  expect(later.confirmation?.kind).toBe('included');expect(later.directConfirmedAt).toBe(standalone.directConfirmedAt);
  expect(later.directConfirmedAt).toEqual(expect.any(String));
  await save('legacy-version');expect((await save('legacy-version','included')).legacyConfirmation).toBe(true);
  const included=await save('included-version','included');expect(included.directConfirmedAt).toBeUndefined();expect(included.legacyConfirmation).toBeUndefined();
  await Promise.all([save('concurrent-version','direct'),save('concurrent-version','included')]);
  const concurrent=await app.store.db.prepare('SELECT body FROM reading_marks WHERE "userId"=$1 AND body->>\'key\'=$2').get(session.user.id,messageReadingKey(targets.get('concurrent-version')!));
  expect(concurrent!.body.directConfirmedAt).toEqual(expect.any(String));
  const forged=await agent.post('/api/ui/reading-state').set('x-csrf-token',session.csrf).send({marks:[{...included,directConfirmedAt:'forged'}]});
  expect(forged.status,forged.text).toBe(400);
  expect(await app.store.account(session.user.id)).toEqual(before);expect(await app.store.latestSequence()).toBe(sequence);
});
