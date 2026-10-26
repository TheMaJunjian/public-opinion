import {afterEach,expect,it,vi} from 'vitest';
import {replayArchive,referenceKey} from '@gonglun/core';
import {Mutation} from '../../server/src/db.js';
import {placeWager,placeHistoricalSelfWager,refundHistoricalSelfWager} from '../../server/src/economy.js';
import {cleanupTestDatabases,createTestStore,newTestSchema} from '../../server/src/test-database.js';
import {migrationsFor,runMigrations} from './migrations.js';
import {minimumContributionCandidates,backfillMinimumContributions,refundGeneratedContributions} from './backfill-minimum-contributions.js';

afterEach(async()=>{vi.restoreAllMocks();await cleanupTestDatabases();});
async function fixture(){
  const schema=newTestSchema(),store=await createTestStore(schema);
  await store.transaction(async()=>{
    await store.db.prepare('INSERT INTO users(id,name,password,founder) VALUES($1,$2,$3,1)').run('author','原作者','hash');
    await store.db.prepare('INSERT INTO accounts VALUES($1,0,0,0,0)').run('author');
    const tx=new Mutation(store);
    const genesis=await tx.create('system',[{id:'body',type:'text',text:'初始余额'}]);
    await store.ledger('author',genesis.id,0,0,'初始发放');
    await tx.create('author',[{id:'body',type:'text',text:'历史正文'}],undefined,'unpaid');
    const old=await tx.create('author',[{id:'body',type:'text',text:'历史零自赞'},
      {id:'self-stance',type:'relation',relation:'agree',roles:{target:[{id:'self',reference:{messageId:'old-self'}}]}}],undefined,'old-self');
    await placeWager(tx,old,0);
    await tx.create('author',[{id:'relation',type:'relation',relation:'credit',roles:{}},{id:'data',type:'data',value:{amount:100}}],undefined,'old-credit');
    await tx.create('author',[{id:'body',type:'text',text:'已有价值'}],{protocol:0,recommendation:1,wager:0},'paid');
    await tx.create('author',[{id:'relation',type:'relation',relation:'member-of',roles:{parent:[{id:'parent',reference:{messageId:'paid'}}],member:[{id:'member',reference:{messageId:'unpaid'}}]}},
      {id:'data',type:'data',value:{uiType:'JOIN',generatedBy:'paid'}}],undefined,'generated');
    await tx.commit();
    await store.db.prepare('INSERT INTO settlement_access VALUES($1,$2)').run('unpaid',[]);
    await store.db.prepare('INSERT INTO signatures VALUES($1,$2,$3,$4,$5,$6,$7)').run('unpaid','author','device','key','原签名原文','签名','2026-01-01');
    await store.db.exec('DELETE FROM schema_migrations WHERE version>=11');
  });
  return {schema,store};
}

it('并发升级只补扣一次，允许负余额，保留签名与旧流水，导出重放一致',async()=>{
  const {schema,store}=await fixture();
  const before=(await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>row.body);
  const [first,second]=await Promise.all([createTestStore(schema),createTestStore(schema)]);
  expect(await first.account('author')).toEqual({available:-3,locked:3,earned:0,spent:0});
  expect(await minimumContributionCandidates(first.db)).toEqual([]);
  expect((await first.message('unpaid')).spending.wager).toBe(1);
  expect((await first.db.prepare('SELECT allowed_keys FROM settlement_access WHERE "messageId"=$1').get('unpaid'))!.allowed_keys).toEqual([referenceKey({messageId:'unpaid',revision:1})]);
  expect((await first.message('old-credit')).parts.some(part=>part.id==='self-stance')).toBe(true);
  expect((await first.message('generated')).spending.wager).toBe(0);
  expect((await first.db.prepare('SELECT COUNT(*) AS n FROM bets WHERE amount=1').get())!.n).toBe(3);
  expect((await first.db.prepare('SELECT COUNT(*) AS n FROM minimum_contribution_backups').get())!.n).toBe(3);
  expect((await first.db.prepare('SELECT payload,signature FROM signatures').get())).toEqual({payload:'原签名原文',signature:'签名'});
  const rows=await first.db.prepare('SELECT body FROM changes ORDER BY sequence').all();
  for(let index=0;index<before.length;index++){
    const saved=await first.db.prepare("SELECT body FROM version_context_backups WHERE table_name='changes' AND row_key=$1").get(String(index+1));
    expect(saved?.body??rows[index].body).toBe(before[index]);
  }
  const replay=replayArchive({format:'gonglun-2',changes:rows.map(row=>JSON.parse(String(row.body)))});
  expect(replay.accounts.get('author')).toEqual(await second.account('author'));
  expect(new Map(replay.messages.map(message=>[message.id,message])).get('unpaid')).toEqual(await first.message('unpaid'));
  const sequence=await first.latestSequence();
  await createTestStore(schema);
  expect(await first.latestSequence()).toBe(sequence);
});

it('补扣中途失败时账户、消息、流水和版本全部回滚',async()=>{
  const {store}=await fixture(),before=await store.account('author'),sequence=await store.latestSequence();
  const ledger=store.ledger.bind(store);let calls=0;
  vi.spyOn(store,'ledger').mockImplementation(async(...args)=>{if(++calls===2)throw new Error('模拟失败');return ledger(...args);});
  await expect(runMigrations(store.db,migrationsFor(store))).rejects.toThrow('模拟失败');
  expect(await store.account('author')).toEqual(before);
  expect(await store.latestSequence()).toBe(sequence);
  expect((await store.message('unpaid')).spending.wager).toBe(0);
  expect((await store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())!.version).toBe(10);
  expect((await store.db.prepare("SELECT to_regclass('minimum_contribution_backups') AS name").get())!.name).toBeNull();
});

it('退回旧导入中记在用户名下的系统结算补扣，保留补扣与退款流水并能重放',async()=>{
  const {store}=await fixture();
  await store.transaction(async()=>{
    await backfillMinimumContributions(store);
    const tx=new Mutation(store);
    const original=await tx.create('author',[{id:'relation',type:'relation',relation:'settlement',roles:{target:[{id:'target',reference:{messageId:'unpaid'}}]}}],undefined,'automatic-settlement');
    const source=JSON.stringify(original);
    original.parts.push({id:'self-stance',type:'relation',relation:'agree',roles:{target:[{id:'self',reference:{messageId:original.id,revision:1}}]}});
    original.spending.wager=1;await tx.put(original);
    await placeHistoricalSelfWager(tx,original,'self-stance');
    const ledgerId=store.db.ledger.at(-1)!.id;
    await store.db.prepare('INSERT INTO minimum_contribution_backups VALUES($1,$2,$3)').run(original.id,source,ledgerId);
    await tx.commit();
    expect(await refundGeneratedContributions(store)).toBe(1);
  });
  expect(await store.account('author')).toEqual({available:-3,locked:3,earned:0,spent:0});
  expect((await store.message('automatic-settlement')).spending.wager).toBe(0);
  await store.transaction(async()=>expect(await refundGeneratedContributions(store)).toBe(0));
  const changes=(await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)));
  expect(replayArchive({format:'gonglun-2',changes}).accounts.get('author')).toEqual(await store.account('author'));
});

it('发送时零投入即补扣，后续旧押注不豁免，早期误退的补扣会恢复且只执行一次',async()=>{
  const {store}=await fixture();
  await store.transaction(async()=>{
    await store.db.prepare('INSERT INTO legacy_stakes VALUES($1,$2,$3,NULL,$4,$5,2,$6,$7)').run('old-funded','author','unpaid','TRUTH','PRO','2026-01-01','{}');
    expect((await minimumContributionCandidates(store.db)).map(message=>message.id)).toContain('unpaid');
    await store.db.prepare('DELETE FROM legacy_stakes WHERE id=$1').run('old-funded');
    await backfillMinimumContributions(store);
    await store.db.prepare('INSERT INTO legacy_stakes VALUES($1,$2,$3,NULL,$4,$5,2,$6,$7)').run('old-funded','author','unpaid','TRUTH','PRO','2026-01-01','{}');
    // Reproduce the superseded v13 refund without retaining its incorrect exemption rule.
    const tx=new Mutation(store),message=await store.message('unpaid');
    message.parts=message.parts.filter(part=>part.id!=='self-stance');message.spending.wager=0;
    await tx.put(message);await refundHistoricalSelfWager(tx,message,'self-stance','历史已有投入消息补扣退回');
    const entry=store.db.ledger.at(-1)!;
    await store.db.exec('CREATE TABLE minimum_contribution_refunds("messageId" TEXT PRIMARY KEY,"ledgerId" TEXT NOT NULL UNIQUE)');
    await store.db.prepare('INSERT INTO minimum_contribution_refunds VALUES($1,$2)').run('unpaid',entry.id);
    await tx.commit();
    expect(await backfillMinimumContributions(store)).toBe(1);
    expect(await backfillMinimumContributions(store)).toBe(0);
  });
  expect(await store.account('author')).toEqual({available:-3,locked:3,earned:0,spent:0});
});
