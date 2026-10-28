import {afterEach,it,expect} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {bodyVersion,messageReadingKey,originalReadingKey,relations,replayArchive,type BodyVersion,type Reference,type LedgerEntry} from '@gonglun/core';
import {readReference} from './validation.js';
import {createTestApp,cleanupTestDatabases,withTestCommandContributions,testDatabaseUrl} from './test-database.js';
import {migrationPlan} from '../../migrate/src/preflight.js';
import {migrateSimplifiedCorrections} from '../../migrate/src/simplified-corrections.js';
import {financialFingerprint} from '../../migrate/src/financial-fingerprint.js';
import {readingStorageKey} from './reading-state.js';
import {statesFor} from './projections.js';
import {Mutation} from './db.js';
const apps:Awaited<ReturnType<typeof createTestApp>>[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();await cleanupTestDatabases();});
async function setup(receivedOriginal=false){
  const app=await createTestApp();apps.push(app);const agent=request.agent(app);
  const session=(await agent.post('/api/register').send({username:'版本测试',password:'test-password-123'})).body;
  const raw=(path:string,body:object)=>agent.post('/api/ui'+path).set('x-csrf-token',session.csrf).set('x-request-id',randomUUID()).send(body);
  const post=async(path:string,body:Record<string,unknown>)=>{const result=await raw(path,withTestCommandContributions(path,body));expect(result.status,result.text).toBe(201);return result.body;};
  let m;
  if(receivedOriginal){
    const publisher=request.agent(app),owner=(await publisher.post('/api/register').send({username:'原文发布者',password:'test-password-123'})).body;
    const sent=await publisher.post('/api/ui/messages').set('x-csrf-token',owner.csrf).set('x-request-id',randomUUID()).send(withTestCommandContributions('/messages',{content:'甲乙'}));
    expect(sent.status,sent.text).toBe(201);m=sent.body;
  }else m=await post('/messages',{content:'甲乙'});
  const correction=(start:number,replacement:string)=>post('/relations',{relationType:'CORRECT',targetRefs:[{kind:'message',messageId:m.id,reference:{messageId:m.id,revision:1,partId:'body',range:{start,end:start+1}}}],payload:{correctionKind:'TEXT',correctionContent:replacement}});
  const t=await correction(0,'丙'),a=await correction(1,'丁');
  const version=(ids:string[])=>bodyVersion(m.id,1,ids.map(messageId=>({messageId,revision:1,kind:'TEXT'})));
  const ref=(v:BodyVersion):Reference=>({messageId:m.id,revision:1,context:{kind:'MESSAGE',version:v}});
  const vote=(v:BodyVersion,amount:number)=>post('/relations',{relationType:'AGREE',targetRefs:[{kind:'message',messageId:m.id,reference:ref(v)}],stakeAmount:amount});
  const mark=(id:string,v=bodyVersion(id),scope='message',state='READ')=>{const key=scope==='original'?originalReadingKey(id):messageReadingKey(id);return {format:3,version:v,messageId:id,scope,key,bodySignature:key,signature:'display-test',state,confirmation:{kind:'direct',messageId:id}};};
  const save=async(marks:unknown[])=>{const result=await raw('/reading-state',{marks});expect(result.status,result.text).toBe(200);return result.body.marks;};
  return {app,agent,session,post,raw,m,t,a,correction,version,ref,vote,mark,save};
}
it('shares truth and value targets across all TEXT displays and gives correction messages ordinary independent targets',async()=>{
  const {app,post,m,t,a,version,vote,ref}=await setup();
  const votes=[];for(const ids of [[],[t.id],[a.id],[t.id,a.id]])votes.push(await vote(version(ids),3));
  const bets=await app.store.db.prepare('SELECT "targetKey","roundId" FROM bets WHERE "messageId"=ANY($1::text[])').all(votes.map(v=>v.id));
  expect(new Set(bets.map(b=>b.targetKey)).size).toBe(1);expect(new Set(bets.map(b=>b.roundId)).size).toBe(1);
  const values=[];for(const ids of [[],[t.id],[a.id],[t.id,a.id]])values.push(await post('/relations',{relationType:'RECOMMEND',targetRefs:[{kind:'message',messageId:m.id,reference:ref(version(ids))}],recommendation:2}));
  const positions=await app.store.db.prepare('SELECT "roundId" FROM stake_positions WHERE "subjectId"=$1 AND "settlementType"=$2').all(m.id,'VALUE');
  expect(positions.length).toBeGreaterThan(0);expect(new Set(positions.map(p=>p.roundId)).size).toBe(1);
  const c=await post('/relations',{relationType:'DISAGREE',targetRefs:[{kind:'message',messageId:t.id}],stakeAmount:1});
  const separate=await app.store.db.prepare('SELECT "targetKey" FROM bets WHERE "messageId"=$1').get(c.id);
  expect(separate!.targetKey).not.toBe(bets[0]!.targetKey);expect(String(separate!.targetKey)).not.toContain('CORRECTION');
  expect((await app.store.message(m.id)).revision).toBe(1);
});
it('quotes corrected fragments with exact evidence, rejecting forged versions without charging',async()=>{
  const {app,post,raw,session,m,t,a,version,ref}=await setup();
  const quoted=await post('/relations',{relationType:'REFERENCE',targetRefs:[{kind:'message',messageId:m.id,reference:{...ref(version([t.id,a.id])),partId:'body',range:{start:0,end:2}}}]});
  expect(quoted.targetRefs[0].text).toBe('丙丁');expect(quoted.targetRefs[0].reference.context.kind).toBe('MESSAGE');
  const before=await app.store.account(session.user.id),sequence=await app.store.latestSequence();
  const invalid=await raw('/relations',withTestCommandContributions('/relations',{relationType:'AGREE',targetRefs:[{kind:'message',messageId:m.id,reference:ref(bodyVersion(m.id,2))}],stakeAmount:8}));
  expect(invalid.status).toBe(400);expect(await app.store.account(session.user.id)).toEqual(before);expect(await app.store.latestSequence()).toBe(sequence);
});
it('requires original and every correction, including rejected candidates, only before the first shared read',async()=>{
  const {app,agent,post,raw,session,m,t,a,correction,version,mark,save}=await setup(true);
  await post('/relations',{relationType:'DISAGREE',targetRefs:[{kind:'message',messageId:a.id}],stakeAmount:1});
  expect((await raw('/reading-state',{marks:[mark(m.id,version([t.id]))]})).status).toBe(400);
  await save([mark(m.id,version([]),'original'),mark(t.id)]);
  expect((await raw('/reading-state',{marks:[mark(m.id,version([t.id]))]})).body.error).toContain(a.id);
  await save([mark(a.id),mark(m.id,version([t.id]))]);
  const initial=(await agent.get('/api/ui/reading-state')).body.marks.find((item:any)=>item.messageId===m.id&&item.scope==='message');expect(initial.firstConfirmedAt).toBeTruthy();
  const newer=await correction(0,'戊');
  await save([mark(m.id,version([]),'message','UNREAD')]);await save([mark(m.id,version([t.id]))]);
  const saved=(await agent.get('/api/ui/reading-state')).body.marks;
  expect(saved.filter((item:any)=>item.messageId===m.id&&item.scope==='message')).toHaveLength(1);
  expect(saved.find((item:any)=>item.messageId===m.id&&item.scope==='message')).toMatchObject({state:'READ',firstConfirmedAt:initial.firstConfirmedAt});
  expect(saved.some((item:any)=>item.messageId===newer.id)).toBe(false);
  const history=await app.store.db.prepare('SELECT body FROM reading_confirmation_events WHERE "userId"=$1 ORDER BY position').all(session.user.id);expect(history.some(row=>row.body.state==='UNREAD')).toBe(true);
  expect((await raw('/reading-state',{marks:[{...mark(m.id),format:2}]})).status).toBe(400);
});
it('retains finite event acknowledgments and keeps later rounds independently confirmable',async()=>{
  const {agent,m,version,vote,save}=await setup();
  const first=await vote(version([]),2),second=await vote(version([]),2);
  for(const event of [first,second])await save([{format:3,messageId:m.id,scope:'influence',key:'agree:',eventId:JSON.stringify([event.id,event.revision,event.sequence])}]);
  expect((await agent.get('/api/ui/reading-state')).body.marks.filter((mark:any)=>mark.scope==='influence')).toHaveLength(2);
});
it('also requires WIDTH corrections and rejects native meaning corrections without money changes',async()=>{
  const {app,agent,post,raw,session,m,t,a,mark,save}=await setup(true);
  const width=await post('/relations',{relationType:'CORRECT',targetRefs:[{kind:'message',messageId:m.id}],payload:{correctionKind:'WIDTH',correctionWidth:640}});
  await save([mark(m.id,bodyVersion(m.id),'original'),mark(t.id),mark(a.id)]);
  expect((await raw('/reading-state',{marks:[mark(m.id)]})).body.error).toContain(width.id);
  await save([mark(width.id),mark(m.id)]);
  const before=await financialFingerprint(app.store.db),sequence=await app.store.latestSequence();
  const native=await agent.post('/api/messages').set('x-csrf-token',session.csrf).send({requestId:randomUUID(),recommendation:1,parts:[{id:'r',type:'relation',relation:'correct',roles:{target:[{id:'t',reference:{messageId:m.id,revision:1,partId:'body'}}]}},{id:'data',type:'data',value:{correctionKind:'MEANING'}}]});
  expect(native.status).toBe(400);expect(native.body.error).toContain('新消息');expect(await financialFingerprint(app.store.db)).toBe(before);expect(await app.store.latestSequence()).toBe(sequence);
});
it('converts the existing ID without a revision, creates and charges a separate reference, and retains fixed financial evidence',async()=>{
  const {app,agent,post,m,t,a,session,version}=await setup();
  await app.store.transaction(async()=>{
    const legacy=await app.store.message(a.id);for(const part of legacy.parts)if(part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value))part.value.correctionKind='MEANING';
    const tx=new Mutation(app.store);await tx.put(legacy);await tx.commit();
    const v=version([t.id]),old={format:2 as const,messageId:m.id,scope:'message' as const,key:'old-version',version:v,state:'READ' as const,updatedAt:'2026-01-01T00:00:00.000Z'};
    await app.store.db.prepare('INSERT INTO reading_marks VALUES($1,$2,$3,$4,$5::jsonb)').run(session.user.id,m.id,'message',readingStorageKey(old),JSON.stringify(old));
  });
  const basis:Reference={messageId:m.id,revision:1,context:{kind:'MESSAGE',version:bodyVersion(m.id,1,[{messageId:a.id,revision:1,kind:'MEANING'}])}};
  await post('/relations',{relationType:'AGREE',targetRefs:[{kind:'message',messageId:m.id,reference:basis}],stakeAmount:4});
  const plan=await migrationPlan(testDatabaseUrl(),app.store.db.schema);expect(plan).toMatchObject({simplifiedCorrections:1,referenceConsumption:{messages:1,protocolFee:1,valueContribution:1,total:2}});
  const before=await financialFingerprint(app.store.db),tables=['bets','rounds','execution_stances','stake_positions','signatures','command_requests'],records=await Promise.all(tables.map(table=>app.store.db.prepare(`SELECT * FROM ${table}`).all()));
  await app.store.transaction(()=>migrateSimplifiedCorrections(app.store));
  const current=await app.store.message(a.id),reference=await app.store.message(`reference:${a.id}`);
  expect(current.revision).toBe(1);expect(relations(current)).toEqual([]);expect(await app.store.message(a.id,1)).toEqual(current);
  expect((await app.store.db.prepare('SELECT COUNT(*) AS count FROM revisions WHERE "messageId"=$1').get(a.id))!.count).toBe(1);
  expect(reference.parts).toContainEqual(expect.objectContaining({type:'data',value:expect.objectContaining({label:'修正原意'})}));
  expect(relations(reference)[0]).toMatchObject({relation:'reference',roles:{source:[{reference:{messageId:a.id}}],target:[{reference:{messageId:m.id}}]}});
  const additions=await app.store.db.prepare('SELECT * FROM ledger WHERE "messageId"=$1').all<LedgerEntry>(reference.id);
  expect(reference.spending).toEqual({protocol:1,recommendation:1,wager:0});expect(await financialFingerprint(app.store.db,additions,2)).toBe(before);
  expect((await readReference(app.store,basis) as any).parts).toContainEqual({id:'body',type:'text',text:'甲丁'});
  for(let index=0;index<tables.length;index++)expect(await app.store.db.prepare(`SELECT * FROM ${tables[index]}`).all()).toEqual(records[index]);
  const read=await app.store.db.prepare('SELECT body FROM reading_marks WHERE "userId"=$1 AND "messageId"=$2').get(session.user.id,m.id);expect(read!.body).toMatchObject({format:3,key:messageReadingKey(m.id),state:'READ',firstConfirmedAt:'2026-01-01T00:00:00.000Z'});
  const sequence=await app.store.latestSequence();await app.store.transaction(()=>migrateSimplifiedCorrections(app.store));expect(await app.store.latestSequence()).toBe(sequence);
  const round=(await agent.get(`/api/ui/messages/${m.id}/rounds`)).body.data.find((round:any)=>round.status!=='SETTLED');expect((await post(`/rounds/${round.id}/close-and-settle`,{})).result).toBe('TRUE');
});
it('reconstructs rejected historical combinations after a base revision change without executing funds',async()=>{
  const {app,raw,post,m,t,a,version}=await setup(),selected=version([t.id,a.id]);
  await post('/relations',{relationType:'DISAGREE',targetRefs:[{kind:'message',messageId:a.id}],stakeAmount:1});
  await app.store.transaction(async()=>{const tx=new Mutation(app.store),message=await app.store.message(m.id);await tx.put({...message,revision:2,parts:[{id:'body',type:'text',text:'后来正文'}]});await tx.commit();});
  const before=await financialFingerprint(app.store.db),sequence=await app.store.latestSequence(),resolved=await raw('/body-versions/resolve',selected);
  expect(resolved.status,resolved.text).toBe(200);expect(resolved.body.message.parts).toContainEqual({id:'body',type:'text',text:'丙丁'});expect(await app.store.latestSequence()).toBe(sequence);expect(await financialFingerprint(app.store.db)).toBe(before);
});
it('treats a whole correction as an ordinary adoption vote, while reason fragments remain separate',async()=>{
  const {app,post,t}=await setup();
  await post('/relations',{relationType:'DISAGREE',targetRefs:[{kind:'message',messageId:t.id,reference:{messageId:t.id,revision:1,context:{kind:'MESSAGE',version:bodyVersion(t.id)}}}],stakeAmount:1});
  expect((await statesFor(app.store,[t.id]))[0]).toMatchObject({oppositionCount:1,suppressed:true});
});
it('keeps a historical viewed quote pinned even when its outer reference omitted the base revision',async()=>{
  const {app,post,m,t,version}=await setup(),viewed=version([t.id]);
  await app.store.transaction(async()=>{const tx=new Mutation(app.store),current=await app.store.message(m.id);await tx.put({...current,revision:2,parts:[{id:'body',type:'text',text:'后文'}]});await tx.commit();});
  const quote=await post('/relations',{relationType:'REFERENCE',targetRefs:[{kind:'message',messageId:m.id,reference:{messageId:m.id,partId:'body',range:{start:0,end:2},context:{kind:'MESSAGE',version:viewed}}}]});
  expect(quote.targetRefs[0]).toMatchObject({text:'丙乙',reference:{revision:1,context:{kind:'MESSAGE',version:viewed}}});
});
it('supports different votes in consecutive ordinary correction rounds without resetting reads or touching the original contract',async()=>{
  const {app,agent,post,m,t,a,mark,save,version,vote}=await setup();
  await save([mark(m.id,version([]),'original'),mark(t.id),mark(a.id),mark(m.id,version([t.id,a.id]))]);
  const rootVote=await vote(version([]),5),rootContract=await app.store.db.prepare('SELECT * FROM bets WHERE "messageId"=$1').all(rootVote.id);
  const stance=(side:string,amount:number)=>post('/relations',{relationType:side,targetRefs:[{kind:'message',messageId:t.id}],stakeAmount:amount});
  const active=async()=>(await agent.get(`/api/ui/messages/${t.id}/rounds`)).body.data.find((round:any)=>round.status!=='SETTLED');
  await stance('AGREE',2);await stance('DISAGREE',4);expect((await statesFor(app.store,[t.id]))[0]).toMatchObject({suppressed:true,oppositionCount:1});
  const first=await active();expect((await post(`/rounds/${first.id}/close-and-settle`,{})).result).toBe('FALSE');
  await stance('AGREE',10);expect((await statesFor(app.store,[t.id]))[0]).toMatchObject({suppressed:false,supportCount:1,oppositionCount:0});
  const second=await active();expect(second.id).not.toBe(first.id);expect((await post(`/rounds/${second.id}/close-and-settle`,{})).result).toBe('TRUE');
  expect(await app.store.db.prepare('SELECT * FROM bets WHERE "messageId"=$1').all(rootVote.id)).toEqual(rootContract);
  expect((await agent.get('/api/ui/reading-state')).body.marks.find((mark:any)=>mark.messageId===m.id&&mark.scope==='message')).toMatchObject({state:'READ',key:messageReadingKey(m.id)});
});
it('checks the first-read boundary against a concurrently committing correction',async()=>{
  const {app,session,raw,m,t,a,mark,save,version}=await setup(true);
  await save([mark(m.id,version([]),'original'),mark(t.id),mark(a.id)]);
  let release!:()=>void,entered!:(id:string)=>void;
  const released=new Promise<void>(resolve=>release=resolve),ready=new Promise<string>(resolve=>entered=resolve);
  const writer=app.store.transaction(async()=>{
    const tx=new Mutation(app.store),newer=await tx.create(session.user.id,[{id:'r',type:'relation',relation:'correct',roles:{target:[{id:'t',reference:{messageId:m.id,revision:1,partId:'body'}}]}},{id:'corrected-body',type:'text',text:'新甲乙'},{id:'data',type:'data',value:{correctionKind:'TEXT',correctionBeforeContent:'甲乙'}}]);
    await tx.commit();entered(newer.id);await released;
  });
  const id=await ready,attempt=raw('/reading-state',{marks:[mark(m.id,version([]))]}).then(response=>response);
  try{expect(await Promise.race([attempt.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),80))])).toBe(false);}
  finally{release();await writer;}
  const response=await attempt;expect(response.status,response.text).toBe(400);expect(response.body.error).toContain(id);
  const main=await app.store.db.prepare("SELECT 1 FROM reading_marks WHERE \"userId\"=$1 AND \"messageId\"=$2 AND scope='message'").get(session.user.id,m.id);expect(main).toBeUndefined();
});
it('migrates the latest explicit unread while preserving earlier read evidence and unknown history',async()=>{
  const {app,session,m,t,version}=await setup();
  const rows=[{format:2 as const,messageId:m.id,scope:'message' as const,key:'older',version:version([]),state:'READ' as const,position:1,updatedAt:'2026-01-01',selection:{versionKey:'old',outcomes:{},signature:'old-display'}},
    {format:2 as const,messageId:m.id,scope:'message' as const,key:'newer',version:version([t.id]),state:'UNREAD' as const,position:2,updatedAt:'2026-01-02'},
    {messageId:m.id,scope:'message' as const,key:'unknown',updatedAt:'2026-01-03'}];
  for(const row of rows)await app.store.db.prepare('INSERT INTO reading_marks VALUES($1,$2,$3,$4,$5::jsonb)').run(session.user.id,m.id,'message',readingStorageKey(row),JSON.stringify(row));
  await app.store.transaction(()=>migrateSimplifiedCorrections(app.store));
  const converted=(await app.store.db.prepare('SELECT body FROM reading_marks WHERE "userId"=$1 AND "messageId"=$2').all(session.user.id,m.id)).map(row=>row.body);
  expect(converted.find(mark=>mark.key===messageReadingKey(m.id))).toMatchObject({format:3,state:'UNREAD',firstConfirmedAt:'2026-01-01',originalSeen:true});
  expect(converted.find(mark=>mark.key===messageReadingKey(m.id)).selection).toBeUndefined();
  expect(converted.find(mark=>mark.unknownContext)).toMatchObject({key:'historical:3:unknown',unknownContext:true});
  expect((await app.store.db.prepare("SELECT COUNT(*) AS count FROM simplified_correction_backups WHERE table_name='reading_marks'").get())!.count).toBe(3);
});
it.each([{oldProtocol:0,netDeduction:3},{oldProtocol:1,netDeduction:2},{oldProtocol:5,netDeduction:-2}])('reconciles old protocol fee $oldProtocol, charges the reference and permits migration debt without repeating deductions',async({oldProtocol,netDeduction})=>{
  const {app,a,session,raw}=await setup();
  await app.store.transaction(async()=>{
    const message=await app.store.message(a.id);for(const part of message.parts)if(part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value))part.value.correctionKind='MEANING';
    const tx=new Mutation(app.store),difference=message.spending.protocol-oldProtocol;message.spending.protocol=oldProtocol;await tx.put(message);
    if(difference){await app.store.ledger(session.user.id,a.id,difference,0,'旧协议费测试依据',true);await app.store.operating(-difference,true);}
    const {available}=await app.store.account(session.user.id);await app.store.ledger(session.user.id,a.id,-available,0,'测试预留贡献点',true);await app.store.operating(available,true);await tx.commit();
  });
  const original=await app.store.message(a.id),before=await financialFingerprint(app.store.db),oldLedger=await app.store.db.prepare('SELECT * FROM ledger ORDER BY id').all<LedgerEntry>();
  expect(await migrationPlan(testDatabaseUrl(),app.store.db.schema)).toMatchObject({referenceConsumption:{total:2,bodyProtocolAdjustment:1-oldProtocol,netDeduction,debtAllowed:true,authors:[{userId:session.user.id,available:0,netDeduction,balanceAfter:-netDeduction}]}});
  await app.store.transaction(()=>migrateSimplifiedCorrections(app.store));
  const current=await app.store.message(a.id),reference=await app.store.message(`reference:${a.id}`);
  expect(current).toMatchObject({id:a.id,revision:original.revision,spending:{...original.spending,protocol:1}});expect(relations(current)).toEqual([]);
  expect(reference.spending).toEqual({protocol:1,recommendation:1,wager:0});expect((await app.store.account(session.user.id)).available).toBe(-netDeduction);
  const ledger=await app.store.db.prepare('SELECT * FROM ledger ORDER BY id').all<LedgerEntry>(),previousIds=new Set(oldLedger.map(entry=>entry.id)),additions=ledger.filter(entry=>!previousIds.has(entry.id));
  expect(ledger.filter(entry=>previousIds.has(entry.id))).toEqual(oldLedger);expect(additions.reduce((total,entry)=>total+entry.amount,0)).toBe(-netDeduction);
  expect(additions.filter(entry=>entry.messageId===a.id).map(entry=>({amount:entry.amount,reason:entry.reason}))).toEqual(oldProtocol===1?[]:[{amount:oldProtocol-1,reason:'普通消息转换费用差额'}]);
  expect(await financialFingerprint(app.store.db,additions,netDeduction)).toBe(before);
  const replay=replayArchive({format:'gonglun-2',changes:(await app.store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)))});
  expect(replay.accounts.get(session.user.id)).toEqual(await app.store.account(session.user.id));expect(replay.messages.find(message=>message.id===a.id)).toEqual(current);
  expect(replay.messages.find(message=>message.id===reference.id)).toEqual(reference);
  const migrated=await financialFingerprint(app.store.db),sequence=await app.store.latestSequence();await app.store.transaction(()=>migrateSimplifiedCorrections(app.store));
  expect(await financialFingerprint(app.store.db)).toBe(migrated);expect(await app.store.latestSequence()).toBe(sequence);
  if(netDeduction>0){
    const publication=await raw('/messages',withTestCommandContributions('/messages',{content:'余额不足时的新消息'}));expect(publication.status,publication.text).toBe(400);expect(publication.body.error).toContain('不足');
    expect(await financialFingerprint(app.store.db)).toBe(migrated);expect(await app.store.latestSequence()).toBe(sequence);
  }
});
