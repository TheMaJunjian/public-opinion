import {afterEach,expect,it,vi} from 'vitest';
import request from 'supertest';
import {bindRoles,replayArchive,type Message,type RelationPart} from '@gonglun/core';
import {Mutation} from '../../server/src/db.js';
import {placeWager,placeValueWager,placeHistoricalSelfWager,refundHistoricalSelfWager,terminate} from '../../server/src/economy.js';
import {cleanupTestDatabases,createTestApp} from '../../server/src/test-database.js';
import {initializeMigrationArchive} from './migration-schema.js';
import {financialFingerprint} from './financial-fingerprint.js';
import {legacyAnnotationInvestmentPlan,repairLegacyAnnotationInvestments} from './legacy-annotation-investments.js';
import {stakesFor} from '../../server/src/ui-projections.js';

afterEach(cleanupTestDatabases);
const relation=(name:string,target:string):RelationPart=>({id:'relation',type:'relation',relation:name,roles:bindRoles({target:[{messageId:target}]})});
async function setup(minimumProof=true){
  const app=await createTestApp(),store=app.store;
  const actor=(await request.agent(app).post('/api/register').send({name:'赞同冷藏',password:'test-password'})).body.user;
  const other=(await request.agent(app).post('/api/register').send({name:'推荐冷藏本身',password:'test-password'})).body.user;
  const result=await store.transaction(async()=>{
    await initializeMigrationArchive(store);
    await store.db.exec('CREATE TABLE legacy_records("tableName" TEXT NOT NULL,position INTEGER NOT NULL,digest TEXT NOT NULL,body JSONB NOT NULL,PRIMARY KEY("tableName",position))');
    await store.db.exec('CREATE TABLE target_investment_migrations("messageId" TEXT PRIMARY KEY,status TEXT NOT NULL,body JSONB NOT NULL)');
    const tx=new Mutation(store),subject=await tx.create(actor.id,[{id:'body',type:'text',text:'原目标'}]);
    const annotation=await tx.create(actor.id,[relation('archive',subject.id)]);
    const sender=await tx.create(actor.id,[relation('agree',annotation.id)]);
    sender.createdAt='2026-08-18T08:39:05.375Z';await tx.put(sender);
    await placeWager(tx,sender,10);
    const oldBet=(await store.db.prepare('SELECT * FROM bets WHERE "messageId"=$1').get(sender.id))!;
    await store.db.prepare('UPDATE bets SET "messageId"=$1 WHERE id=$2').run(annotation.id,oldBet.id);oldBet.messageId=annotation.id;
    const rawRound={id:oldBet.roundId,messageId:annotation.id,settlementType:'TRUTH',status:'VOTING',createdByUserId:actor.id,
      openedAt:'2026-08-18T08:39:05.390',closedAt:null,previousRoundId:null};
    const rawStake={id:oldBet.id,userId:actor.id,messageId:annotation.id,roundId:oldBet.roundId,settlementType:'TRUTH',side:'PRO',amount:10,
      topicId:'original-topic',createdAt:'2026-08-18T08:39:05.398'};
    const targetRefs=[{kind:'relation',relationId:annotation.id}];
    const originals:Array<{table:string;body:any}>=[
      {table:'Message',body:{id:annotation.id,kind:'RELATION',relationType:'ARCHIVE',createdById:actor.id,topicId:'original-topic',
        targetRefs:[{kind:'relation',relationId:subject.id}],createdAt:annotation.createdAt}},
      {table:'Message',body:{id:sender.id,kind:'RELATION',relationType:'AGREE',createdById:actor.id,topicId:'original-topic',targetRefs,createdAt:'2026-08-18T08:39:05.375'}},
      {table:'Stake',body:rawStake},{table:'SettlementRound',body:rawRound},
      {table:'LedgerEntry',body:{id:'original-lock',entryType:'STAKE_LOCK',userId:actor.id,messageId:annotation.id,roundId:oldBet.roundId,amount:-10,createdAt:rawStake.createdAt}},
      {table:'AuditLog',body:{id:'relation-audit',action:'RELATION_CREATED',entityId:sender.id,actorId:actor.id,createdAt:'2026-08-18T08:39:05.382',
        data:{details:{relationType:'AGREE',transformed:false,settlementType:'TRUTH',targetRefs}}}},
      {table:'AuditLog',body:{id:'stake-audit',action:'STAKE_PLACED',entityId:oldBet.id,actorId:actor.id,createdAt:'2026-08-18T08:39:05.411',
        data:{details:{side:'PRO',amount:10,roundId:oldBet.roundId,messageId:annotation.id,settlementType:'TRUTH'}}}},
    ];
    for(const [position,row] of originals.entries())await store.db.prepare('INSERT INTO legacy_records VALUES($1,$2,$3,$4)').run(row.table,position,'original-fixture',JSON.stringify(row.body));
    await store.db.prepare('INSERT INTO legacy_stakes VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)').run(rawStake.id,actor.id,annotation.id,oldBet.roundId,'TRUTH','PRO',10,rawStake.createdAt,JSON.stringify(rawStake));
    // Reproduce v18's already corrected one-point minimum, while the old stake still lacks its sending source.
    const action=relation('archive',subject.id);
    sender.parts=[action,{id:'data',type:'data',value:{annotationStance:{target:{messageId:annotation.id},side:'pro'}}}];
    sender.spending={protocol:0,wager:0,recommendation:0};await tx.put(sender);
    if(minimumProof){
      const originalMinimum=structuredClone(sender);
      sender.parts.push({id:'self-stance',type:'relation',relation:'agree',roles:bindRoles({target:[{messageId:sender.id,revision:1}]})});
      sender.spending.wager=1;await tx.put(sender);
      const start=store.db.ledger.length;await placeHistoricalSelfWager(tx,sender,'self-stance');
      const minimumLedger=store.db.ledger[start]!,minimumBet=(await store.db.prepare('SELECT * FROM bets WHERE "messageId"=$1').get(sender.id))!;
      await store.db.exec('CREATE TABLE minimum_contribution_backups("messageId" TEXT PRIMARY KEY,body TEXT NOT NULL,"ledgerId" TEXT NOT NULL UNIQUE)');
      await store.db.prepare('INSERT INTO minimum_contribution_backups VALUES($1,$2,$3)').run(sender.id,JSON.stringify(originalMinimum),minimumLedger.id);
      await store.db.prepare('INSERT INTO target_investment_migrations VALUES($1,$2,$3)').run(sender.id,'moved',JSON.stringify({message:structuredClone(sender),bets:[minimumBet]}));
      sender.parts=sender.parts.filter(part=>part.id!=='self-stance');
      sender.spending={protocol:0,wager:0,recommendation:1};await tx.put(sender);
      await refundHistoricalSelfWager(tx,sender,'self-stance','历史目标投入解锁');
    }else{sender.spending.recommendation=1;await tx.put(sender);}
    await store.db.prepare('DELETE FROM execution_stances WHERE "sourceId"=$1').run(sender.id);
    await store.db.prepare('DELETE FROM display_stances WHERE "sourceId"=$1').run(sender.id);
    await placeValueWager(tx,sender,action,1);
    const otherPart=relation('recommend',annotation.id),otherSource=await tx.create(other.id,[otherPart],{protocol:0,wager:0,recommendation:10});
    await placeValueWager(tx,otherSource,otherPart,10);
    const otherBet=(await store.db.prepare('SELECT * FROM bets WHERE "messageId"=$1').get(otherSource.id))!;
    await store.db.prepare('UPDATE bets SET "messageId"=$1 WHERE id=$2').run(annotation.id,otherBet.id);otherBet.messageId=annotation.id;
    await store.db.prepare('INSERT INTO target_investment_migrations VALUES($1,$2,$3)').run(annotation.id,'partially-moved',JSON.stringify({minimumRepair:{retainedBets:[oldBet,otherBet]}}));
    await tx.commit();return {subject,annotation,sender,otherBet,oldBet,originals};
  });
  return {store,actor,other,...result};
}

it.each([true,false])('从原始审计确认自动押注并转为目标负价值，仅在证明重复补扣时退款，最低投入证据=%s',async minimumProof=>{
  const {store,actor,other,subject,annotation,sender,oldBet,otherBet}=await setup(minimumProof);
  const refund=minimumProof?1:0,total=11-refund;
  expect(await legacyAnnotationInvestmentPlan(store)).toMatchObject({pending:1,points:10,refundPoints:refund,unresolved:[],items:[{sourceId:sender.id,amount:10,side:'con',elapsedMs:23}]});
  const account=await store.account(actor.id),otherAccount=await store.account(other.id);
  const oldRecords=await store.db.prepare('SELECT * FROM legacy_records ORDER BY "tableName",position').all();
  const otherPosition=await store.db.prepare('SELECT * FROM stake_positions WHERE id=$1').get(otherBet.id);
  const display=await store.db.prepare('SELECT * FROM display_stances WHERE "sourceId"=$1').get(sender.id);
  expect(await store.transaction(()=>repairLegacyAnnotationInvestments(store))).toBe(1);
  expect(await store.account(actor.id)).toEqual({...account,available:account.available+refund,locked:account.locked-refund});expect(await store.account(other.id)).toEqual(otherAccount);
  expect(await store.db.prepare('SELECT 1 FROM bets WHERE id=$1').get(oldBet.id)).toBeUndefined();
  expect(await store.db.prepare('SELECT 1 FROM stake_positions WHERE id=$1').get(oldBet.id)).toBeUndefined();
  expect(await store.db.prepare('SELECT * FROM bets WHERE id=$1').get(otherBet.id)).toEqual(otherBet);
  expect(await store.db.prepare('SELECT * FROM stake_positions WHERE id=$1').get(otherBet.id)).toEqual(otherPosition);
  expect(await store.db.prepare('SELECT * FROM legacy_records ORDER BY "tableName",position').all()).toEqual(oldRecords);
  expect(await store.db.prepare('SELECT * FROM display_stances WHERE "sourceId"=$1').get(sender.id)).toEqual(display);
  expect((await store.message(sender.id)).spending).toEqual({protocol:0,wager:0,recommendation:total});
  const stakes=await stakesFor(store,[subject.id,annotation.id]);
  expect(stakes[subject.id]!.countsByType.VALUE).toEqual({pro:0,con:total});
  expect(stakes[annotation.id]!.countsByType.TRUTH).toEqual({pro:0,con:0});
  expect(stakes[annotation.id]!.countsByType.VALUE).toEqual({pro:10,con:0});
  expect(JSON.parse(String((await store.db.prepare('SELECT body FROM rounds WHERE id=$1').get(oldBet.roundId))!.body))).toMatchObject({status:'settled',pro:0,con:0,result:'tie'});
  const sequence=await store.latestSequence(),fingerprint=await financialFingerprint(store.db);
  expect(await store.transaction(()=>repairLegacyAnnotationInvestments(store))).toBe(0);
  expect(await store.latestSequence()).toBe(sequence);expect(await financialFingerprint(store.db)).toBe(fingerprint);
  await store.transaction(async()=>{
    await store.set('rules',{...await store.rules(),settlementDelayMs:0,lowQualityPenalty:0});
    const round=JSON.parse(String((await store.db.prepare(`SELECT body FROM rounds WHERE body::jsonb->>'subjectId'=$1 AND body::jsonb->>'settlementType'='VALUE'`).get(subject.id))!.body));
    const tx=new Mutation(store),end=await tx.create(actor.id,[{id:'relation',type:'relation',relation:'terminate',roles:bindRoles({target:[round.target]})}]);
    await terminate(tx,end);await tx.commit();
  });
  expect(await store.account(actor.id)).toMatchObject({available:account.available+11,locked:account.locked-11});
  expect(await store.account(other.id)).toEqual(otherAccount);
  const changes=(await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)));
  const replay=replayArchive({format:'gonglun-2',changes});
  expect(replay.accounts.get(actor.id)).toEqual(await store.account(actor.id));expect(replay.accounts.get(other.id)).toEqual(otherAccount);
  for(const message of replay.messages)expect(await store.message(message.id)).toEqual(message);
});

it('转移中断时回滚本金、发送费用、轮次和审计，重试只处理一次',async()=>{
  const {store,oldBet,sender}=await setup(),before=await financialFingerprint(store.db),message=await store.message(sender.id);
  const ledger=store.ledger.bind(store),failure=vi.spyOn(store,'ledger').mockImplementation(async(...args)=>{
    if(args[4]==='对赌锁定')throw new Error('模拟价值池失败');return ledger(...args);
  });
  await expect(store.transaction(()=>repairLegacyAnnotationInvestments(store))).rejects.toThrow('模拟价值池失败');failure.mockRestore();
  expect(await financialFingerprint(store.db)).toBe(before);expect(await store.message(sender.id)).toEqual(message);
  expect(await store.db.prepare('SELECT * FROM bets WHERE id=$1').get(oldBet.id)).toEqual(oldBet);
  expect(await legacyAnnotationInvestmentPlan(store)).toMatchObject({pending:1,points:10});
  expect(await store.transaction(()=>repairLegacyAnnotationInvestments(store))).toBe(1);
  expect(await store.transaction(()=>repairLegacyAnnotationInvestments(store))).toBe(0);
});

it.each(['manual','ambiguous','waiting','ledger-mismatch'])('原记录无法证明自动押注或合同已截止时保留原状：%s',async mode=>{
  const {store,oldBet,originals}=await setup();
  await store.transaction(async()=>{
    if(mode==='manual')await store.db.prepare(`UPDATE legacy_records SET body=body#-'{data,details,settlementType}' WHERE "tableName"='AuditLog' AND body->>'id'='stake-audit'`).run();
    if(mode==='ambiguous'){
      const source=originals.find(row=>row.table==='Message'&&row.body.relationType==='AGREE')!.body;
      await store.db.prepare('INSERT INTO legacy_records VALUES($1,999,$2,$3)').run('Message','extra-source',JSON.stringify({...source,id:'ambiguous-source'}));
    }
    if(mode==='waiting')await store.db.prepare(`UPDATE rounds SET body=(body::jsonb||'{"status":"waiting"}')::text WHERE id=$1`).run(oldBet.roundId);
    if(mode==='ledger-mismatch')await store.db.prepare(`UPDATE legacy_records SET body=body||'{"amount":-9}' WHERE "tableName"='LedgerEntry'`).run();
  });
  const before=await financialFingerprint(store.db),plan=await legacyAnnotationInvestmentPlan(store);
  expect(plan.pending).toBe(0);expect(plan.unresolved).toHaveLength(1);
  expect(await store.transaction(()=>repairLegacyAnnotationInvestments(store))).toBe(0);
  expect(await financialFingerprint(store.db)).toBe(before);
  expect(await store.db.prepare('SELECT * FROM bets WHERE id=$1').get(oldBet.id)).toEqual(oldBet);
});
