import {referenceKey,relations, type LedgerEntry, type Message} from '@gonglun/core';
import {Mutation, type Store} from '../../server/src/db.js';
import type {Postgres} from '../../server/src/postgres.js';
import {placeHistoricalSelfWager,refundHistoricalSelfWager} from '../../server/src/economy.js';
import {financialFingerprint} from './financial-fingerprint.js';

/** Generated membership records are covered by the originating user's paid message. */
export async function isGeneratedContributionRecord(db:Postgres,message:Message):Promise<boolean>{
  if(message.authorId==='system')return true;
  if(message.spending.protocol!==0)return false;
  if(relations(message).some(part=>['settlement','distribution'].includes(part.relation)))return true;
  const data=message.parts.find(part=>part.id==='data'&&part.type==='data');
  const generatedBy=data?.type==='data'&&data.value&&typeof data.value==='object'&&!Array.isArray(data.value)?data.value.generatedBy:undefined;
  if(typeof generatedBy==='string'&&relations(message).some(part=>part.relation==='member-of'&&part.roles.member?.length)){
    const origin=await db.prepare('SELECT "authorId" FROM messages WHERE id=$1').get(generatedBy);
    return origin?.authorId===message.authorId;
  }
  return false;
}
export async function minimumContributionCandidates(db:Postgres):Promise<Message[]> {
  const rows=await db.prepare(`SELECT m.body FROM messages m JOIN accounts a ON a."userId"=m."authorId"
    WHERE COALESCE((m.body::jsonb #>> '{spending,recommendation}')::bigint,0)=0
      AND COALESCE((m.body::jsonb #>> '{spending,wager}')::bigint,0)=0
    ORDER BY m.sequence,m.id`).all();
  const candidates:Message[]=[];
  for(const row of rows){
    const message=JSON.parse(String(row.body)) as Message;
    if(await isGeneratedContributionRecord(db,message))continue;
    candidates.push(message);
  }
  return candidates;
}

/** One versioned transaction adds one real truth stake per previously unpaid user message. */
export async function backfillMinimumContributions(store:Store):Promise<number>{
  const candidates=await minimumContributionCandidates(store.db);
  if(!candidates.length)return 0;
  const before=await financialFingerprint(store.db), added:LedgerEntry[]=[];
  await store.db.exec(`CREATE TABLE IF NOT EXISTS minimum_contribution_backups(
    "messageId" TEXT PRIMARY KEY,body TEXT NOT NULL,"ledgerId" TEXT NOT NULL UNIQUE)`);
  for(const original of candidates){
    const tx=new Mutation(store), message=structuredClone(original);
    let partId='self-stance';
    for(let index=1;message.parts.some(part=>part.id===partId);index++)partId=`minimum-self-stance-${index}`;
    message.parts.push({id:partId,type:'relation',relation:'agree',roles:{target:[{id:'self',reference:{messageId:message.id,revision:message.revision}}]}});
    message.spending.wager=1;
    await tx.put(message);
    const ledgerStart=store.db.ledger.length;
    await placeHistoricalSelfWager(tx,message,partId);
    const entries=store.db.ledger.slice(ledgerStart);
    if(entries.length!==1||entries[0]!.amount!==-1||entries[0]!.lockedDelta!==1)throw new Error('历史消息真假补扣金额不一致');
    added.push(...entries);
    const backup=await store.db.prepare('SELECT 1 FROM minimum_contribution_backups WHERE "messageId"=$1').get(original.id);
    if(backup){
      const refunded=(await store.db.prepare("SELECT to_regclass('minimum_contribution_refunds') AS name").get())?.name
        &&await store.db.prepare('SELECT 1 FROM minimum_contribution_refunds WHERE "messageId"=$1').get(original.id);
      if(!refunded)throw new Error('历史消息补扣状态不一致');
      await store.db.exec('CREATE TABLE IF NOT EXISTS minimum_contribution_reapplications("messageId" TEXT PRIMARY KEY,body TEXT NOT NULL,"ledgerId" TEXT NOT NULL UNIQUE)');
      await store.db.prepare('INSERT INTO minimum_contribution_reapplications VALUES($1,$2,$3)').run(original.id,JSON.stringify(original),entries[0]!.id);
    }else await store.db.prepare('INSERT INTO minimum_contribution_backups VALUES($1,$2,$3)').run(original.id,JSON.stringify(original),entries[0]!.id);
    await tx.commit();
  }
  // Discount only the exact newly appended stakes; all prior accounts, ledger rows and treasury must match.
  if(before!==await financialFingerprint(store.db,added))throw new Error('历史消息补扣改变了预期之外的账户或账本');
  if((await minimumContributionCandidates(store.db)).length)throw new Error('历史消息真假补扣后仍有遗漏');
  await enableMinimumContributionAccess(store);
  return candidates.length;
}

/** The new principal must remain settleable while old component addresses stay frozen. */
export async function enableMinimumContributionAccess(store:Store):Promise<void>{
  if(!(await store.db.prepare("SELECT to_regclass('minimum_contribution_backups') AS name").get())?.name)return;
  const refunds=!!(await store.db.prepare("SELECT to_regclass('minimum_contribution_refunds') AS name").get())?.name;
  const reapplied=!!(await store.db.prepare("SELECT to_regclass('minimum_contribution_reapplications') AS name").get())?.name;
  const rows=await store.db.prepare(`SELECT b."messageId" FROM minimum_contribution_backups b ${refunds?'LEFT JOIN minimum_contribution_refunds r ON r."messageId"=b."messageId" WHERE r."messageId" IS NULL'+(reapplied?' OR EXISTS(SELECT 1 FROM minimum_contribution_reapplications a WHERE a."messageId"=b."messageId")':''):''}`).all();
  for(const row of rows){
    const message=await store.message(String(row.messageId)),key=referenceKey({messageId:message.id,revision:message.revision});
    const policy=await store.db.prepare('SELECT allowed_keys FROM settlement_access WHERE "messageId"=$1').get(message.id);
    if(!policy||policy.allowed_keys.includes(key))continue;
    await store.db.exec('CREATE TABLE IF NOT EXISTS minimum_contribution_access_backups("messageId" TEXT PRIMARY KEY,allowed_keys TEXT[] NOT NULL)');
    await store.db.prepare('INSERT INTO minimum_contribution_access_backups VALUES($1,$2) ON CONFLICT DO NOTHING').run(message.id,policy.allowed_keys);
    await store.db.prepare('UPDATE settlement_access SET allowed_keys=array_append(allowed_keys,$1) WHERE "messageId"=$2').run(key,message.id);
  }
}

/** Older imports attributed automatic settlement declarations to the triggering user. */
export async function refundGeneratedContributions(store:Store):Promise<number>{
  return refundContributions(store,message=>isGeneratedContributionRecord(store.db,message),'系统自动记录真假补扣退回');
}
async function refundContributions(store:Store,shouldRefund:(message:Message)=>Promise<boolean>,reason:string):Promise<number>{
  if(!(await store.db.prepare("SELECT to_regclass('minimum_contribution_backups') AS name").get())?.name)return 0;
  await store.db.exec('CREATE TABLE IF NOT EXISTS minimum_contribution_refunds("messageId" TEXT PRIMARY KEY,"ledgerId" TEXT NOT NULL UNIQUE)');
  const rows=await store.db.prepare(`SELECT b.* FROM minimum_contribution_backups b LEFT JOIN minimum_contribution_refunds r ON r."messageId"=b."messageId" WHERE r."messageId" IS NULL ORDER BY b."messageId"`).all();
  const before=await financialFingerprint(store.db),added:LedgerEntry[]=[];
  for(const row of rows){
    const original=JSON.parse(String(row.body)) as Message;
    if(!await shouldRefund(original))continue;
    const message=await store.message(original.id);
    if(message.revision!==original.revision)throw new Error('系统补扣记录已被修改，请核对后退款');
    const ownParts=new Set(original.parts.map(part=>part.id));
    const additions=relations(message).filter(part=>!ownParts.has(part.id)&&part.relation==='agree'&&part.roles.target?.[0]?.reference.messageId===message.id);
    if(additions.length!==1)throw new Error('系统补扣记录缺少唯一自赞部件');
    const partId=additions[0]!.id,tx=new Mutation(store);
    message.parts=message.parts.filter(part=>part.id!==partId);
    message.spending.wager=original.spending.wager;
    await tx.put(message);
    const start=store.db.ledger.length;
    await refundHistoricalSelfWager(tx,message,partId,reason);
    const entries=store.db.ledger.slice(start);
    if(entries.length!==1||entries[0]!.amount!==1||entries[0]!.lockedDelta!==-1)throw new Error('系统记录补扣退款金额不一致');
    added.push(...entries);
    await store.db.prepare('INSERT INTO minimum_contribution_refunds VALUES($1,$2)').run(message.id,entries[0]!.id);
    await tx.commit();
  }
  if(before!==await financialFingerprint(store.db,added))throw new Error('系统记录补扣退款改变了预期之外的账户或账本');
  return added.length;
}
