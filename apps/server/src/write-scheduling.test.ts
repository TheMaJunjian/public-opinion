import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Mutation } from './db.js';
import { processDue } from './messages.js';
import { executeBatch } from './ui-commands.js';
import { randomUUID } from 'node:crypto';
import { cleanupTestDatabases, createTestApp, createTestStore, newTestSchema } from './test-database.js';

afterEach(async()=>{vi.restoreAllMocks();await cleanupTestDatabases();});
function deferred() { let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve}; }
const settlesSoon = async (work: Promise<unknown>) => {
  let timer: NodeJS.Timeout;
  try { return await Promise.race([work.then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),400);})]); }
  finally {clearTimeout(timer!);}
};

it('queued ledger writers leave connections available for readers',async()=>{
  const store=await createTestStore(),entered=deferred(),release=deferred();
  const held=store.transaction(async()=>{entered.resolve();await release.promise;});
  await entered.promise;
  const queued=Array.from({length:16},()=>store.transaction(()=>store.latestSequence()));
  const read=store.read(()=>store.latestSequence());
  try { expect(await settlesSoon(read)).toBe(true); }
  finally {release.resolve();await Promise.all([held,read,...queued]);}
});

it('login and an idle settlement tick do not wait for another process ledger writer',async()=>{
  const schema=newTestSchema(),app=await createTestApp({databaseSchema:schema}),other=await createTestStore(schema);
  expect((await request(app).post('/api/register').send({name:'independent-session',password:'test-password'})).status).toBe(201);
  const entered=deferred(),release=deferred();
  const held=other.transaction(async()=>{entered.resolve();await release.promise;});await entered.promise;
  const login=request(app).post('/api/login').send({name:'independent-session',password:'test-password'}).then(result=>{expect(result.status).toBe(200);});
  const tick=processDue(app.store);
  try { expect(await settlesSoon(Promise.all([login,tick]))).toBe(true); }
  finally {release.resolve();await Promise.all([held,login,tick]);}
});

it('publishing a cursor updates persisted bodies without rebuilding reference indexes',async()=>{
  const store=await createTestStore();
  await store.transaction(async()=>{
    const tx=new Mutation(store),source=await tx.create('system',[{id:'text',type:'text',text:'source'}]);
    const message=await tx.create('system',[{id:'relation',type:'relation',relation:'reference',roles:{target:[{id:'target',reference:{messageId:source.id}}]}}]);
    const spy=vi.spyOn(store.db,'prepare');const change=await tx.commit();
    expect(spy.mock.calls.filter(([sql])=>sql.startsWith('DELETE FROM refs'))).toHaveLength(0);
    expect(await store.message(message.id)).toEqual(change.messages.find(m=>m.id===message.id));
    expect(await store.message(message.id,1)).toEqual(await store.message(message.id));
    expect(await store.db.prepare('SELECT "targetId" FROM refs WHERE "sourceId"=$1').all(message.id)).toEqual([{targetId:source.id}]);
  });
});

it('session transactions cannot create ledger mutations and failed writers release the queue',async()=>{
  const store=await createTestStore();
  await store.sessionTransaction(async()=>{
    expect(()=>new Mutation(store)).toThrow('串行写事务');
    await expect(store.transaction(()=>store.latestSequence())).rejects.toThrow('不能升级');
  });
  const failed=store.transaction(async()=>{throw new Error('synthetic failure');});
  const next=store.transaction(()=>store.latestSequence());
  await expect(failed).rejects.toThrow('synthetic failure');
  await expect(next).resolves.toBe(0);
});

it('reads stable settings once per transaction and restores its cache after a savepoint rollback',async()=>{
  const store=await createTestStore();
  await store.transaction(async()=>{
    const spy=vi.spyOn(store.db,'prepare');
    const original=await store.rules(); await store.rules(); await store.rules();
    expect(spy.mock.calls.filter(([sql])=>sql==='SELECT value FROM settings WHERE key=$1')).toHaveLength(1);
    await expect(store.transaction(async()=>{
      await store.set('rules',{...original,protocolFee:9});
      expect((await store.rules()).protocolFee).toBe(9);
      throw new Error('rollback setting');
    })).rejects.toThrow('rollback setting');
    expect(await store.rules()).toEqual(original);
    await store.set('rules',{...original,protocolFee:2});
    expect((await store.rules()).protocolFee).toBe(2);
  });
  expect((await store.rules()).protocolFee).toBe(2);
});

it('reuses committed message state and avoids a redundant batch savepoint',async()=>{
  const app=await createTestApp();
  const registered=await request(app).post('/api/register').send({name:'projection-work',password:'test-password'});
  expect(registered.status).toBe(201);
  const queries=vi.spyOn(app.store.db,'prepare'),commands=vi.spyOn(app.store.db,'exec');
  await executeBatch(app.store,registered.body.user,{requestId:randomUUID(),commands:[{id:randomUUID(),method:'POST',path:'/messages',body:{content:'only compute once'}}]});
  // One state calculation for the durable change, one for its post-commit snapshot.
  expect(queries.mock.calls.filter(([sql])=>sql.startsWith('SELECT body FROM messages WHERE id IN'))).toHaveLength(2);
  expect(commands.mock.calls.filter(([sql])=>sql.startsWith('SAVEPOINT'))).toHaveLength(1);
});
