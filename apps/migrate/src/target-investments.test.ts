import {afterEach,expect,it,vi} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {bindRoles,replayArchive,type Part} from '@gonglun/core';
import {Mutation} from '../../server/src/db.js';
import {openSettlement,placeWager,placeValueWager,placeHistoricalSelfWager} from '../../server/src/economy.js';
import {chargeMessage} from '../../server/src/message-spending.js';
import {cleanupTestDatabases,createTestApp} from '../../server/src/test-database.js';
import {migrateTargetInvestments,targetInvestmentPlan} from './target-investments.js';
import {stakesFor} from '../../server/src/ui-projections.js';
import {normalizeTargetValueFields} from './target-value-fields.js';
import {financialFingerprint} from './financial-fingerprint.js';
afterEach(cleanupTestDatabases);
async function setup(){
  const app=await createTestApp(),agent=request.agent(app);
  const {body:session}=await agent.post('/api/register').send({name:'历史投入',password:'test-password'});
  const response=await agent.post('/api/messages').set('x-csrf-token',session.csrf).send({requestId:randomUUID(),recommendation:1,parts:[{id:'body',type:'text',text:'原目标'}]});
  return {app,session,target:response.body.message};
}
it('旧价值费用转成目标本金，同轮次多条记录不丢金额，不再自押，重复运行和重放均一致',async()=>{
  const {app,session,target}=await setup(),store=app.store,ids:string[]=[];
  await store.transaction(async()=>{
    for(const amount of [3,4]){
      const tx=new Mutation(store),part:Extract<Part,{type:'relation'}>={id:'relation',type:'relation',relation:'recommend',roles:bindRoles({target:[{messageId:target.id}]})};
      const message=await tx.create(session.user.id,[part],{protocol:1,wager:amount,recommendation:2});ids.push(message.id);
      await chargeMessage(store,message);await placeValueWager(tx,message,part,amount);await tx.commit();
    }
  });
  const before=await store.account(session.user.id),operating=await store.setting<number>('operating');
  expect(await targetInvestmentPlan(store)).toMatchObject({pending:2,movable:2,retained:0});
  const ledger=store.ledger.bind(store),failure=vi.spyOn(store,'ledger').mockImplementation(async(...args)=>{
    if(args[4]==='对赌锁定')throw new Error('模拟迁移中断');return ledger(...args);
  });
  await expect(store.transaction(()=>migrateTargetInvestments(store))).rejects.toThrow('模拟迁移中断');failure.mockRestore();
  expect(await store.account(session.user.id)).toEqual(before);expect(await store.setting('operating')).toBe(operating);
  expect(await targetInvestmentPlan(store)).toMatchObject({pending:2});
  await store.transaction(()=>migrateTargetInvestments(store));
  expect(await store.account(session.user.id)).toMatchObject({available:before.available,locked:before.locked+4});
  expect(await store.setting('operating')).toBe(operating-4);
  for(const id of ids)expect((await store.message(id)).spending).toMatchObject({wager:0,recommendation:id===ids[0]?5:6});
  const stake=(await stakesFor(store,[target.id]))[target.id]!;
  expect(stake.countsByType.VALUE).toEqual({pro:11,con:0});expect(stake.pools.VALUE.lockedPro).toBe(11);
  const account=await store.account(session.user.id);
  expect(await store.transaction(()=>migrateTargetInvestments(store))).toBe(0);expect(await store.account(session.user.id)).toEqual(account);
  const changes=(await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)));
  const replay=replayArchive({format:'gonglun-2',changes});
  expect(replay.accounts.get(session.user.id)).toEqual(account);
  for(const id of ids)expect(replay.messages.find(message=>message.id===id)).toEqual(await store.message(id));
});
it('历史关系自身的最低真假自押转到其目标，已结算或截止中的合同原样保留',async()=>{
  const {app,session,target}=await setup(),store=app.store,ids:string[]=[];
  await store.transaction(async()=>{
    for(const closed of [false,true]){
      const tx=new Mutation(store),id=randomUUID(),part:Part={id:'relation',type:'relation',relation:'disagree',roles:bindRoles({target:[{messageId:target.id}]})};
      const message=await tx.create(session.user.id,[part,{id:'self-stance',type:'relation',relation:'agree',roles:bindRoles({target:[{messageId:id}]})}],{protocol:1,wager:1,recommendation:0},id);ids.push(id);
      await chargeMessage(store,message);
      // Simulate the old minimum-contribution self wager without replaying the actual relation.
      await placeHistoricalSelfWager(tx,message,'self-stance');await tx.commit();
      if(closed){const row=await store.db.prepare('SELECT r.id,r.body FROM rounds r JOIN bets b ON b."roundId"=r.id WHERE b."messageId"=$1').get(id);
        const round=JSON.parse(String(row!.body));round.status='waiting';await store.db.prepare('UPDATE rounds SET body=$1 WHERE id=$2').run(JSON.stringify(round),row!.id);}
    }
  });
  const before=await store.account(session.user.id),frozen=await store.message(ids[1]!);
  await store.transaction(()=>migrateTargetInvestments(store));
  expect(await store.account(session.user.id)).toEqual(before);
  expect((await store.message(ids[0]!)).parts.some(part=>part.id==='self-stance')).toBe(false);
  expect(await store.message(ids[1]!)).toEqual(frozen);
  expect((await stakesFor(store,[target.id]))[target.id]!.countsByType.TRUTH).toEqual({pro:0,con:1});
  expect(await targetInvestmentPlan(store)).toMatchObject({pending:0});
  expect((await store.db.prepare('SELECT status FROM target_investment_migrations WHERE "messageId"=$1').get(ids[1]))!.status).toBe('retained-contract');
});

it('转移历史真假本金不复用旧请求的 roundId，原轮次依据保留且可重放',async()=>{
  const {app,session,target}=await setup(),store=app.store;
  const id=randomUUID(),oldRoundId='original-requested-round';
  await store.transaction(async()=>{
    const tx=new Mutation(store);
    const message=await tx.create(session.user.id,[
      {id:'relation',type:'relation',relation:'disagree',roles:bindRoles({target:[{messageId:target.id}]})},
      {id:'data',type:'data',value:{roundId:oldRoundId}},
      {id:'self-stance',type:'relation',relation:'agree',roles:bindRoles({target:[{messageId:id}]})},
    ],{protocol:1,wager:1,recommendation:0},id);
    await chargeMessage(store,message);
    await placeHistoricalSelfWager(tx,message,'self-stance');
    await tx.commit();
  });
  const before=await store.account(session.user.id);
  expect(await store.transaction(()=>migrateTargetInvestments(store))).toBe(1);
  expect(await store.account(session.user.id)).toEqual(before);
  const message=await store.message(id);
  expect(message.parts).toContainEqual({id:'data',type:'data',value:{roundId:oldRoundId}});
  const position=await store.db.prepare('SELECT "subjectId","roundId",side,amount FROM stake_positions WHERE "userId"=$1 AND amount=1').get(session.user.id);
  expect(position).toMatchObject({subjectId:target.id,side:'con',amount:1});
  expect(position!.roundId).not.toBe(oldRoundId);
  const backup=await store.db.prepare('SELECT body FROM target_investment_migrations WHERE "messageId"=$1').get(id);
  expect(backup!.body.message.parts).toContainEqual({id:'data',type:'data',value:{roundId:oldRoundId}});
  const replay=replayArchive({format:'gonglun-2',changes:(await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)))});
  expect(replay.accounts.get(session.user.id)).toEqual(before);
  expect(replay.messages.find(message=>message.id===id)).toEqual(message);
  expect(await store.transaction(()=>migrateTargetInvestments(store))).toBe(0);
});

it('历史价值命题上的表态恢复为推荐并校正投入字段，不改变本金、轮次、账户或旧账本',async()=>{
  const {app,session,target}=await setup(),store=app.store;
  let sourceId='';
  await store.transaction(async()=>{
    const tx=new Mutation(store),claim=await tx.create(session.user.id,[{id:'relation',type:'relation',relation:'open-value-settlement',roles:bindRoles({target:[{messageId:target.id,revision:1}]})}]);
    await openSettlement(tx,claim);
    const source=await tx.create(session.user.id,[{id:'relation',type:'relation',relation:'agree',roles:bindRoles({target:[{messageId:claim.id,partId:'relation'}]})}],{protocol:1,wager:3,recommendation:0});
    sourceId=source.id;await chargeMessage(store,source);await placeWager(tx,source,3);await tx.commit();
  });
  const before=await financialFingerprint(store.db),bets=await store.db.prepare('SELECT * FROM bets').all();
  expect(await store.transaction(()=>normalizeTargetValueFields(store))).toBe(1);
  expect((await store.message(sourceId)).spending).toMatchObject({wager:0,recommendation:3});
  expect((await store.message(sourceId)).parts).toEqual(expect.arrayContaining([expect.objectContaining({relation:'recommend',roles:{target:[expect.objectContaining({reference:{messageId:target.id,revision:1}})]}})]));
  expect(await financialFingerprint(store.db)).toBe(before);expect(await store.db.prepare('SELECT * FROM bets').all()).toEqual(bets);
  expect(await store.transaction(()=>normalizeTargetValueFields(store))).toBe(0);
});
