import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { replayArchive, type Part, type Session } from '@gonglun/core';
import { Mutation } from './db.js';
import { processDue, send } from './messages.js';
import { changes, listMessages } from './queries.js';
import { cleanupTestDatabases, createTestApp, newTestSchema } from './test-database.js';
import {RollbackUnconfirmedError} from './postgres.js';

afterEach(cleanupTestDatabases);
type App = Awaited<ReturnType<typeof createTestApp>>;
async function pair(tick = 60_000) {
  const databaseSchema = newTestSchema();
  return Promise.all([createTestApp({databaseSchema,settlementTickMs:tick}), createTestApp({databaseSchema,settlementTickMs:tick})]);
}
async function register(app: App, name: string) {
  const response = await request(app).post('/api/register').send({name,password:'postgres-test-password'});
  expect(response.status,response.text).toBe(201);
  return {session: response.body as Session, cookie: (response.headers['set-cookie'] as unknown as string[]).map(value=>value.split(';')[0]).join('; ')};
}
const text = (value: string): Part => ({id:'text',type:'text',text:value});
const relation = (value: string, messageId: string): Part => ({id:'relation',type:'relation',relation:value,roles:{target:[{id:'target',reference:{messageId}}]}});

describe('PostgreSQL transactions across API instances', () => {
  it('does not report a completed rollback to the browser when a database response is ambiguous',async()=>{
    const app=await createTestApp(),actor=await register(app,'alice');
    const transaction=vi.spyOn(app.store,'transaction').mockRejectedValue(new RollbackUnconfirmedError(new Error('连接中断')));
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{
      const response=await request(app).post('/api/messages').set('Cookie',actor.cookie).set('x-csrf-token',actor.session.csrf)
        .send({requestId:randomUUID(),parts:[text('提交未确认')]});
      expect(response.status).toBe(500);
      expect(response.body.error).toContain('未确认本次操作或回滚结果');
      expect(response.body.error).not.toContain('已回滚');
    }finally{transaction.mockRestore();log.mockRestore();}
  });

  it('initializes once and charges one fee for concurrent retries of the same request', async () => {
    const [first,second] = await pair();
    expect(await first.store.setting('region')).toBe(await second.store.setting('region'));
    const identities = await Promise.all([register(first,'alice'),register(second,'bob')]);
    expect(identities.filter(actor=>actor.session.user.founder)).toHaveLength(1);
    const actor=identities[0], input={requestId:randomUUID(),parts:[text('并发重试')]};
    const responses=await Promise.all(Array.from({length:12},(_,index)=>request(index%2?first:second).post('/api/messages').set('Cookie',actor.cookie).set('x-csrf-token',actor.session.csrf).send(input)));
    for(const response of responses){expect(response.status,response.text).toBe(201);expect(response.body).toEqual(responses[0].body);}
    expect(await second.store.account(actor.session.user.id)).toMatchObject({available:999,locked:0});
    expect(await first.store.setting('operating')).toBe(1);
    expect((await first.store.db.prepare('SELECT COUNT(*) AS n FROM requests').get())!.n).toBe(1);
  });

  it('rejects concurrent overspending without losing a balance update or leaving partial messages', async () => {
    const [first,second]=await pair(), actor=await register(first,'alice');
    const attempts=await Promise.allSettled([first,second].map(app=>send(app.store,actor.session.user,{requestId:randomUUID(),parts:[text('推荐投入')],recommendation:700})));
    expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(attempts.filter(result=>result.status==='rejected')).toHaveLength(1);
    expect(await first.store.account(actor.session.user.id)).toMatchObject({available:299,locked:0});
    expect(await second.store.setting('operating')).toBe(701);
    expect((await first.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE "authorId"=$1').get(actor.session.user.id))!.n).toBe(1);
  });

  it('rolls back nested SQL and ledger effects, and allows gaps in committed change cursors', async () => {
    const app=await createTestApp(), actor=await register(app,'alice'), before=await app.store.latestSequence();
    const abandoned=randomUUID();
    await expect(app.store.transaction(async()=>{
      const tx=new Mutation(app.store);
      await tx.create(actor.session.user.id,[text('必须回滚')],undefined,abandoned);
      await app.store.ledger(actor.session.user.id,abandoned,-5,0,'回滚收费');
      await app.store.operating(5);
      await tx.commit();
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await app.store.latestSequence()).toBe(before);
    await expect(app.store.message(abandoned)).rejects.toThrow();
    const result=await app.store.transaction(async()=>{
      const tx=new Mutation(app.store), message=await tx.create(actor.session.user.id,[text('外层有效')]);
      await expect(app.store.transaction(async()=>{
        await app.store.ledger(actor.session.user.id,message.id,-7,0,'内层回滚');
        await app.store.db.prepare('SELECT definitely_missing_column FROM settings').get();
      })).rejects.toThrow();
      await app.store.ledger(actor.session.user.id,message.id,-1,0,'外层收费');
      await app.store.operating(1);
      return tx.commit();
    });
    expect(result.sequence).toBeGreaterThan(before+1);
    expect(result.ledger.map(entry=>entry.reason)).toEqual(['外层收费']);
    expect(await app.store.account(actor.session.user.id)).toMatchObject({available:999});
    const page=await changes(app.store,before);
    expect(page.changes.map(change=>change.sequence)).toEqual([result.sequence]);
    const journal=await changes(app.store,0);
    const replay=replayArchive({format:'gonglun-2',changes:journal.changes});
    expect(replay.accounts.get(actor.session.user.id)).toEqual(await app.store.account(actor.session.user.id));
  });

  it('keeps page content and its cursor on one snapshot while another instance commits', async () => {
    const [first,second]=await pair(), actor=await register(first,'alice');
    const sequence=await first.store.latestSequence();
    let sentId='';
    await first.store.read(async()=>{
      const before=await listMessages(first.store,{});
      const result=await send(second.store,actor.session.user,{requestId:randomUUID(),parts:[text('读取期间提交')]});
      sentId=result.message.id;
      const after=await listMessages(first.store,{});
      expect(after).toEqual(before);
      expect(after.sequence).toBe(sequence);
    });
    const delta=await changes(first.store,sequence);
    expect(delta.changes.flatMap(change=>change.messages.map((message:{id:string})=>message.id))).toContain(sentId);
  });

  it('settles an elapsed round once when two API instances run the settlement worker', async () => {
    const [first,second]=await pair(), alice=await register(first,'alice'), bob=await register(second,'bob');
    const publish=(app:App,actor:typeof alice,parts:Part[],wager=0)=>send(app.store,actor.session.user,{requestId:randomUUID(),parts,wager});
    await first.store.transaction(async()=>first.store.set('rules',{...await first.store.rules(),settlementDelayMs:20}));
    const claim=(await publish(first,alice,[text('结算并发')])).message;
    await publish(first,alice,[relation('agree',claim.id)],10);
    await publish(second,bob,[relation('disagree',claim.id)],5);
    await publish(first,alice,[relation('terminate',claim.id)]);
    await new Promise(resolve=>setTimeout(resolve,30));
    const settled=await Promise.all([processDue(first.store),processDue(second.store)]);
    expect(settled.filter(Boolean)).toHaveLength(1);
    expect(await first.store.account(alice.session.user.id)).toMatchObject({available:1002,locked:0});
    expect(await second.store.account(bob.session.user.id)).toMatchObject({available:994,locked:0});
  });

  it('streams a message written through another API instance', async () => {
    const [reader,writer]=await pair(50), actor=await register(writer,'alice');
    const after=await reader.store.latestSequence();
    const server=reader.listen(0,'127.0.0.1');
    await once(server,'listening');
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),5000);
    try {
      const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events?after=${after}`,{signal:controller.signal});
      expect(response.status).toBe(200);
      const stream=response.body!.getReader();
      const cursorResponse=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events?after=${after}&mode=cursor`,{signal:controller.signal});
      const cursorStream=cursorResponse.body!.getReader();
      const message=(await send(writer.store,actor.session.user,{requestId:randomUUID(),parts:[text('跨实例同步')]})).message;
      let output='';
      while(!output.includes(message.id)){
        const {value,done}=await stream.read();
        if(done)break;
        output+=new TextDecoder().decode(value);
      }
      expect(output).toContain(message.id);
      let cursorOutput='';
      while(!cursorOutput.includes('data: ')) {
        const {value,done}=await cursorStream.read();
        if(done)break;
        cursorOutput+=new TextDecoder().decode(value);
      }
      const cursorData=cursorOutput.split('\n').find(line=>line.startsWith('data: '))!;
      expect(JSON.parse(cursorData.slice(6))).toEqual({sequence:message.sequence});
      expect(cursorOutput).not.toContain(message.id);
      expect(cursorOutput).not.toContain('跨实例同步');
      await cursorStream.cancel();
      await stream.cancel();
    } finally {
      clearTimeout(timeout);controller.abort();server.closeAllConnections();
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }
  });
});
