import request from 'supertest';
import {afterEach,expect,it} from 'vitest';
import {bindRoles,replayArchive} from '@gonglun/core';
import {Mutation} from '../../server/src/db.js';
import {chargeMessage} from '../../server/src/message-spending.js';
import {placeWager,placeValueWager,settleDue} from '../../server/src/economy.js';
import {cleanupTestDatabases,createTestApp} from '../../server/src/test-database.js';
import {readingMessageRemovalPlan,removeReadingMessages} from './remove-reading-messages.js';
import {migrationsFor,runMigrations} from './migrations.js';

afterEach(cleanupTestDatabases);
it.each(['read','unread'].flatMap(type=>[false,true].map(settled=>({type,settled}))))('removes obsolete $type records and refunds their net ledger costs, settled=$settled',async({type,settled})=>{
  const app=await createTestApp(),store=app.store;
  const user=(await request(app).post('/api/register').send({name:'reading removal',password:'test-password-123'})).body.user;
  const before=await store.account(user.id),operating=await store.setting<number>('operating');
  await store.transaction(async()=>{
    const tx=new Mutation(store);
    await tx.create(user.id,[{id:'body',type:'text',text:'preserve'}],undefined,'original');
    const old=await tx.create(user.id,[{id:'relation',type:'relation',relation:type,roles:bindRoles({target:[{messageId:'original'}]})},
      {id:'self-stance',type:'relation',relation:'agree',roles:bindRoles({target:[{messageId:'old-read'}]})}],{protocol:1,recommendation:2,wager:3},'old-read');
    await chargeMessage(store,old);await placeWager(tx,old,3);
    if(settled){
      await store.db.prepare("UPDATE rounds SET body=(body::jsonb||jsonb_build_object('status','waiting','endsAt','2000-01-01T00:00:00Z'))::text").run();
      await settleDue(tx);
    }
    await tx.commit();
  });
  expect(await readingMessageRemovalPlan(store)).toMatchObject({readingMessages:1,blocked:[]});
  const preMigration=await store.account(user.id);
  await expect(store.transaction(async()=>{await removeReadingMessages(store);throw new Error('rollback');})).rejects.toThrow('rollback');
  expect(await store.account(user.id)).toEqual(preMigration);
  await store.transaction(async()=>{
    await store.db.prepare('DELETE FROM schema_migrations WHERE version>=23').run();
    await runMigrations(store.db,migrationsFor(store));
  });
  expect((await store.account(user.id)).available).toBe(before.available);
  expect((await store.account(user.id)).locked).toBe(before.locked);
  expect(await store.setting('operating')).toBe(operating);
  expect(await store.db.prepare('SELECT 1 FROM messages WHERE id=$1').get('old-read')).toBeUndefined();
  expect((await store.message('old-read',1)).id).toBe('old-read');
  expect((await store.message('original')).id).toBe('original');
  expect(await store.db.prepare('SELECT COUNT(*) AS count FROM bets').get()).toEqual({count:0});
  const sequence=await store.latestSequence(),ledgerCount=(await store.db.prepare('SELECT COUNT(*) AS count FROM ledger').get())!.count;
  await store.transaction(async()=>expect(await removeReadingMessages(store)).toBe(0));
  expect(await store.latestSequence()).toBe(sequence);
  expect((await store.db.prepare('SELECT COUNT(*) AS count FROM ledger').get())!.count).toBe(ledgerCount);
  const changes=(await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)));
  const replay=replayArchive({format:'gonglun-2',changes});
  const currentIds=(await store.db.prepare('SELECT id FROM messages ORDER BY id').all()).map(row=>String(row.id));
  expect(replay.messages.map(message=>message.id).sort()).toEqual(currentIds);
  expect(replay.accounts.get(user.id)).toEqual(await store.account(user.id));
});

it.each([false,true])('preserves unrelated shared value investments and refuses ambiguous settled pools, settled=%s',async settled=>{
  const app=await createTestApp(),store=app.store;
  const user=(await request(app).post('/api/register').send({name:'shared pool',password:'test-password-123'})).body.user;
  await store.transaction(async()=>{
    const tx=new Mutation(store);
    await tx.create(user.id,[{id:'body',type:'text',text:'preserve'}],undefined,'original');
    for(const [id,relation,amount] of [['old-read','read',3],['keep','recommend',5]] as const){
      const part={id:'relation',type:'relation' as const,relation,roles:bindRoles({target:[{messageId:'original'}]})};
      const message=await tx.create(user.id,[part],{protocol:1,recommendation:amount,wager:0},id);
      await chargeMessage(store,message,true);await placeValueWager(tx,message,part,amount);
    }
    if(settled){
      await store.db.prepare("UPDATE rounds SET body=(body::jsonb||jsonb_build_object('status','waiting','endsAt','2000-01-01T00:00:00Z'))::text").run();
      await settleDue(tx);
    }
    await tx.commit();
  });
  if(settled){
    const before=await store.account(user.id);
    expect((await readingMessageRemovalPlan(store)).blocked).toHaveLength(1);
    await expect(store.transaction(()=>removeReadingMessages(store))).rejects.toThrow('共用资金池');
    expect(await store.account(user.id)).toEqual(before);
    expect((await store.message('old-read')).id).toBe('old-read');
    return;
  }
  const before=await store.account(user.id);
  await store.transaction(()=>removeReadingMessages(store));
  const after=await store.account(user.id);
  expect(after.available-before.available).toBe(4);expect(after.locked-before.locked).toBe(-3);
  expect((await store.message('keep')).id).toBe('keep');
  expect(await store.db.prepare('SELECT "messageId",amount FROM bets').all()).toEqual([{messageId:'keep',amount:5}]);
  expect(JSON.parse((await store.db.prepare('SELECT body FROM rounds').get())!.body).pro).toBe(5);
});

it('removes superseded member acknowledgements without adding a public change or refund',async()=>{
  const app=await createTestApp(),store=app.store;
  await store.transaction(async()=>{
    await store.db.prepare('INSERT INTO reading_marks VALUES($1,$2,$3,$4,$5)').run('user','container','influence','member:old','{}');
    await store.db.prepare('INSERT INTO reading_marks VALUES($1,$2,$3,$4,$5)').run('user','container','influence','agree:','{}');
    const sequence=await store.latestSequence();
    expect(await removeReadingMessages(store)).toBe(0);
    expect(await store.latestSequence()).toBe(sequence);
  });
  expect(await store.db.prepare('SELECT key FROM reading_marks').all()).toEqual([{key:'agree:'}]);
});
