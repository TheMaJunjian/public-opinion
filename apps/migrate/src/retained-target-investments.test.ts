import {afterEach,expect,it,vi} from 'vitest';
import request from 'supertest';
import {bindRoles,referenceKey,replayArchive,type Message,type Part} from '@gonglun/core';
import {Mutation,type Store} from '../../server/src/db.js';
import {placeHistoricalSelfWager,placeValueWager,placeWager} from '../../server/src/economy.js';
import {applyOrganization,reconcileOrganizationEffects,validateJoinApproval} from '../../server/src/organizations.js';
import {cleanupTestDatabases,createTestApp} from '../../server/src/test-database.js';
import {retainedTargetInvestmentPlan,repairRetainedTargetInvestments} from './retained-target-investments.js';
import {migrateTargetInvestments} from './target-investments.js';
import {financialFingerprint} from './financial-fingerprint.js';
import {stakesFor} from '../../server/src/ui-projections.js';

afterEach(cleanupTestDatabases);
async function setup(){
  const app=await createTestApp(),agent=request.agent(app);
  const session=(await agent.post('/api/register').send({name:'保留合同核对',password:'test-password'})).body;
  return {store:app.store,userId:session.user.id};
}
const relation=(name:string,target:string):Part=>({id:'relation',type:'relation',relation:name,roles:bindRoles({target:[{messageId:target}]})});
async function backfill(store:Store,original:Message){
  await store.transaction(async()=>{
    await store.db.exec('CREATE TABLE IF NOT EXISTS minimum_contribution_backups("messageId" TEXT PRIMARY KEY,body TEXT NOT NULL,"ledgerId" TEXT NOT NULL UNIQUE)');
    const tx=new Mutation(store),message=structuredClone(original);
    message.parts.push({id:'self-stance',type:'relation',relation:'agree',roles:bindRoles({target:[{messageId:message.id,revision:1}]})});
    message.spending.wager=1;await tx.put(message);
    const start=store.db.ledger.length;await placeHistoricalSelfWager(tx,message,'self-stance');
    await store.db.prepare('INSERT INTO minimum_contribution_backups VALUES($1,$2,$3)').run(message.id,JSON.stringify(original),store.db.ledger[start]!.id);
    await tx.commit();
  });
}
async function replayCheck(store:Store,userId:string){
  const changes=(await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)));
  const replay=replayArchive({format:'gonglun-2',changes});
  expect(replay.accounts.get(userId)).toEqual(await store.account(userId));
  for(const message of replay.messages)expect(await store.message(message.id)).toEqual(message);
  expect(replay.memberships).toEqual(await store.db.prepare('SELECT "memberId","parentId","sourceId","sourcePartId","bindingId","sourceRevision" FROM memberships ORDER BY "memberId"').all());
}

it.each(['retired','opposed','restored'])('只修复已执行赞同的最低本金，组织状态 %s 不被重放或恢复',async status=>{
  const {store,userId}=await setup();
  const {group,join,source}=await store.transaction(async()=>{
    const tx=new Mutation(store),group=await tx.create(userId,[{id:'relation',type:'relation',relation:'classify',roles:{}}]);
    const member=await tx.create(userId,[{id:'body',type:'text',text:'成员'}]);
    const join=await tx.create(userId,[{id:'relation',type:'relation',relation:'member-of',roles:bindRoles({parent:[{messageId:group.id}],member:[{messageId:member.id}]})}]);
    await applyOrganization(tx,join);
    const source=await tx.create(userId,[relation('agree',join.id)]);
    await placeWager(tx,source,0);await tx.commit();return {group,join,source};
  });
  await backfill(store,source);
  await store.transaction(async()=>{
    const tx=new Mutation(store);
    if(status==='retired'){
      await store.set('retired-organizations',[group.id]);
      await store.db.prepare('UPDATE membership_actions SET disabled=TRUE WHERE id=$1').run(join.id);
    }else{
      const opposition=await tx.create(userId,[relation('disagree',group.id)],{protocol:0,wager:1,recommendation:0});
      await placeWager(tx,opposition,1);
    }
    await reconcileOrganizationEffects(tx);await tx.commit();
    await migrateTargetInvestments(store);
  });
  expect((await store.db.prepare('SELECT status FROM target_investment_migrations WHERE "messageId"=$1').get(source.id))?.status).toBe('retained-contract');
  if(status==='restored')await store.transaction(async()=>{
    const tx=new Mutation(store),approval=await tx.create(userId,[relation('agree',group.id)],{protocol:0,wager:1,recommendation:0});
    await placeWager(tx,approval,1);await reconcileOrganizationEffects(tx);await tx.commit();
  });
  const before=await store.account(userId),placements=await store.db.prepare('SELECT * FROM memberships ORDER BY "memberId"').all();
  const display=await store.db.prepare('SELECT * FROM display_stances WHERE "sourceId"=$1').get(source.id);
  expect(await retainedTargetInvestmentPlan(store)).toMatchObject({pending:1,points:1});
  const ledger=store.ledger.bind(store),failure=vi.spyOn(store,'ledger').mockImplementation(async(...args)=>{
    if(args[4]==='对赌锁定')throw new Error('修复中断');return ledger(...args);
  });
  const fingerprint=await financialFingerprint(store.db);
  await expect(store.transaction(()=>repairRetainedTargetInvestments(store))).rejects.toThrow('修复中断');failure.mockRestore();
  expect(await financialFingerprint(store.db)).toBe(fingerprint);
  expect(await retainedTargetInvestmentPlan(store)).toMatchObject({pending:1});
  expect(await store.transaction(()=>repairRetainedTargetInvestments(store))).toBe(1);
  expect(await store.account(userId)).toEqual(before);
  expect(await store.db.prepare('SELECT * FROM memberships ORDER BY "memberId"').all()).toEqual(placements);
  expect(await store.db.prepare('SELECT * FROM display_stances WHERE "sourceId"=$1').get(source.id)).toEqual(display);
  expect((await stakesFor(store,[join.id]))[join.id]!.countsByType.TRUTH).toEqual({pro:1,con:0});
  expect((await store.message(source.id)).parts.some(part=>part.id==='self-stance')).toBe(false);
  if(status!=='restored')await expect(validateJoinApproval(store,{messageId:join.id},'pro',userId)).rejects.toThrow();
  expect(await store.transaction(()=>repairRetainedTargetInvestments(store))).toBe(0);
  await replayCheck(store,userId);
});

it('混合旧合同只移走可证明的最低补扣，保留其他人的价值押注和作者后来的真假押注',async()=>{
  const {store,userId}=await setup();
  const otherId='other-investor';
  await store.transaction(async()=>{
    await store.db.prepare('INSERT INTO users(id,name,password,founder) VALUES($1,$2,$3,0)').run(otherId,'其他押注人','test-only');
    await store.db.prepare('INSERT INTO accounts VALUES($1,0,0,0,0)').run(otherId);
  });
  const {target,source,oldBetIds}=await store.transaction(async()=>{
    const tx=new Mutation(store),target=await tx.create(userId,[{id:'body',type:'text',text:'被冷藏的目标'}]);
    await store.ledger(otherId,target.id,100,0,'测试初始贡献点');
    await store.set('minted',await store.setting<number>('minted')+100);
    const source=await tx.create(userId,[relation('archive',target.id)]);
    const own=await tx.create(userId,[relation('agree',source.id)],{protocol:0,wager:10,recommendation:0});
    await placeWager(tx,own,10);
    const valuePart=relation('recommend',source.id) as Extract<Part,{type:'relation'}>;
    const other=await tx.create(otherId,[valuePart],{protocol:0,wager:0,recommendation:10});
    await placeValueWager(tx,other,valuePart,10);
    // The legacy import used the evaluated subject as messageId, rather than a sending record.
    const oldBets=await store.db.prepare('SELECT id FROM bets WHERE "messageId"=ANY($1::text[])').all([own.id,other.id]);
    await store.db.prepare('UPDATE bets SET "messageId"=$1 WHERE "messageId"=ANY($2::text[])').run(source.id,[own.id,other.id]);
    await tx.commit();return {target,source,oldBetIds:oldBets.map(row=>String(row.id))};
  });
  await backfill(store,source);
  await store.transaction(()=>migrateTargetInvestments(store));
  const account=await store.account(userId),other=await store.account(otherId);
  const oldBets=await store.db.prepare('SELECT * FROM bets WHERE id=ANY($1::text[]) ORDER BY id').all(oldBetIds);
  const oldPositions=await store.db.prepare('SELECT * FROM stake_positions WHERE id=ANY($1::text[]) ORDER BY id').all(oldBetIds);
  expect(await retainedTargetInvestmentPlan(store)).toMatchObject({pending:1,points:1,items:[{retainedContracts:2,retainedPoints:20}]});
  expect(await store.transaction(()=>repairRetainedTargetInvestments(store))).toBe(1);
  expect(await store.account(userId)).toEqual(account);expect(await store.account(otherId)).toEqual(other);
  expect(await store.db.prepare('SELECT * FROM bets WHERE id=ANY($1::text[]) ORDER BY id').all(oldBetIds)).toEqual(oldBets);
  expect(await store.db.prepare('SELECT * FROM stake_positions WHERE id=ANY($1::text[]) ORDER BY id').all(oldBetIds)).toEqual(oldPositions);
  expect((await store.message(source.id)).spending).toMatchObject({wager:0,recommendation:1});
  expect((await stakesFor(store,[target.id]))[target.id]!.countsByType.VALUE).toEqual({pro:0,con:1});
  expect((await store.db.prepare('SELECT status FROM target_investment_migrations WHERE "messageId"=$1').get(source.id))?.status).toBe('partially-moved');
  expect(await store.transaction(()=>repairRetainedTargetInvestments(store))).toBe(0);
  await replayCheck(store,userId);await replayCheck(store,otherId);
});

it.each(['waiting','missing-proof','frozen-target'])('截止中、证据不完整或资金已冻结的最低补扣不自动改写：%s',async mode=>{
  const {store,userId}=await setup();
  const source=await store.transaction(async()=>{
    const tx=new Mutation(store),target=await tx.create(userId,[{id:'body',type:'text',text:'原目标'}]);
    const source=await tx.create(userId,[relation('agree',target.id)]);await placeWager(tx,source,0);await tx.commit();return source;
  });
  await backfill(store,source);
  await store.transaction(async()=>{
    const key=referenceKey({messageId:source.id,revision:1});
    await store.db.prepare(`UPDATE rounds SET body=(body::jsonb||'{"status":"waiting"}')::text WHERE "targetKey"=$1`).run(key);
    await migrateTargetInvestments(store);
    if(mode!=='waiting'){
      await store.db.prepare(`UPDATE rounds SET body=(body::jsonb||'{"status":"open"}')::text WHERE "targetKey"=$1`).run(key);
      if(mode==='missing-proof')await store.db.prepare('DELETE FROM execution_stances WHERE "sourceId"=$1 AND "partId"=$2').run(source.id,'relation');
      else{
        const basis=await store.db.prepare('SELECT target FROM execution_stances WHERE "sourceId"=$1 AND "partId"=$2').get(source.id,'relation');
        await store.db.prepare('INSERT INTO settlement_access VALUES($1,$2) ON CONFLICT("messageId") DO UPDATE SET allowed_keys=excluded.allowed_keys').run(JSON.parse(String(basis!.target)).messageId,[]);
      }
    }
    // Keep this fixture explicitly in the retained-contract retry set.
    await store.db.prepare(`UPDATE target_investment_migrations SET body=body||'{"retainedReason":"inactive-placement"}' WHERE "messageId"=$1`).run(source.id);
  });
  expect((await store.db.prepare('SELECT status FROM target_investment_migrations WHERE "messageId"=$1').get(source.id))?.status).toBe('retained-contract');
  const before=await financialFingerprint(store.db),message=await store.message(source.id);
  expect(await retainedTargetInvestmentPlan(store)).toMatchObject({pending:0});
  expect(await store.transaction(()=>repairRetainedTargetInvestments(store))).toBe(0);
  expect(await financialFingerprint(store.db)).toBe(before);expect(await store.message(source.id)).toEqual(message);
});
