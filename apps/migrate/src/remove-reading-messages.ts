import {relations,type Message,type LedgerEntry,type Round} from '@gonglun/core';
import {Mutation,type Store} from '../../server/src/db.js';
import {financialFingerprint} from './financial-fingerprint.js';

type SavedRound=Round&{subjectId?:string;targetKey:string};
type Bet={id:string;messageId:string;roundId:string;targetKey:string;userId:string;amount:number;side:'pro'|'con'};
const retired=new Set(['read','unread']);
const primary=(message:Message)=>relations(message).filter(part=>part.relation!=='member-of'&&part.id!=='self-stance');
const metadata=(message:Message)=>Object.assign({},...message.parts.flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)?[part.value]:[]));

/** Plan from current records and actual ledger entries, never from declared spending. */
async function candidates(store:Pick<Store,'db'>){
  const db=store.db,messages=(await db.prepare('SELECT body FROM messages ORDER BY id').all()).map(row=>JSON.parse(String(row.body)) as Message);
  const obsolete=messages.filter(message=>primary(message).some(part=>retired.has(part.relation))
    ||['READ','UNREAD'].includes(String(metadata(message).uiType))&&primary(message).some(part=>part.relation==='annotation'));
  const deleted=new Set(obsolete.map(message=>message.id)),blocked:string[]=[];
  for(const message of obsolete)if(primary(message).some(part=>!retired.has(part.relation)&&part.relation!=='annotation'))blocked.push(`已读消息含其他操作：${message.id}`);
  // Delete obsolete action records and their generated declarations, leaving
  // independent discussion bodies and their historical references available.
  let changed=true;
  while(changed){
    changed=false;
    for(const message of messages){
      if(deleted.has(message.id))continue;
      const parts=primary(message),data=metadata(message);
      const dependent=parts.some(part=>['agree','disagree','recommend','archive','follow','block','tag','open-value-settlement','settlement'].includes(part.relation)
        &&(part.roles.target??[]).some(binding=>deleted.has(binding.reference.messageId)))
        ||message.authorId==='system'&&parts.some(part=>part.relation==='distribution')&&['wager','reversal'].includes(String(data.source))
          &&parts.some(part=>(part.roles.target??[]).some(binding=>deleted.has(binding.reference.messageId)))
        ||relations(message).some(part=>part.relation==='member-of'&&(part.roles.member??[]).some(binding=>deleted.has(binding.reference.messageId)));
      if(!dependent)continue;
      const independent=parts.some(part=>!['distribution','settlement'].includes(part.relation)&&(part.roles.target??[]).some(binding=>binding.reference.messageId!==message.id&&!deleted.has(binding.reference.messageId)))
        ||relations(message).some(part=>part.relation==='member-of'&&(part.roles.member??[]).some(binding=>!deleted.has(binding.reference.messageId)));
      if(independent){blocked.push(`关联操作同时涉及保留消息：${message.id}`);continue;}
      deleted.add(message.id);changed=true;
    }
  }
  const ids=[...deleted],rounds=(await db.prepare('SELECT body FROM rounds ORDER BY position').all()).map(row=>JSON.parse(String(row.body)) as SavedRound);
  const removedRounds=rounds.filter(round=>deleted.has(round.subjectId??round.target.messageId)||deleted.has(round.target.messageId));
  const removedKeys=new Set(removedRounds.map(round=>round.targetKey));
  const bets=await db.prepare('SELECT * FROM bets WHERE "messageId"=ANY($1::text[]) OR "targetKey"=ANY($2::text[]) ORDER BY position').all<Bet>(ids,[...removedKeys]);
  const sharedKeys=new Set(bets.filter(bet=>!removedKeys.has(bet.targetKey)).map(bet=>bet.targetKey));
  for(const key of sharedKeys)if(rounds.some(round=>round.targetKey===key&&round.status==='settled'))blocked.push(`已结算的共用资金池需先核对：${key}`);
  const externalIds=[...new Set(bets.filter(bet=>removedKeys.has(bet.targetKey)&&!deleted.has(bet.messageId)).map(bet=>bet.messageId))];
  for(const bet of await db.prepare('SELECT "messageId","targetKey" FROM bets WHERE "messageId"=ANY($1::text[])').all(externalIds))
    if(!removedKeys.has(String(bet.targetKey)))blocked.push(`同一出资消息涉及其他资金池：${bet.messageId}`);
  const ledger=await db.prepare(`SELECT * FROM ledger WHERE "messageId"=ANY($1::text[])
    OR ("messageId"=ANY($2::text[]) AND reason IN ('对赌锁定','历史消息真假补扣')) ORDER BY position`)
    .all<LedgerEntry>(ids,externalIds);
  const refunds=new Map<string,{amount:number;locked:number}>();
  for(const entry of ledger){const refund=refunds.get(entry.userId)??{amount:0,locked:0};refund.amount-=entry.amount;refund.locked-=entry.lockedDelta;refunds.set(entry.userId,refund);}
  return {obsolete,ids,rounds,removedRounds,removedKeys,sharedKeys,bets,ledger,refunds,blocked:[...new Set(blocked)]};
}

export async function readingMessageRemovalPlan(store:Pick<Store,'db'>){
  const plan=await candidates(store);
  return {readingMessages:plan.obsolete.length,deletedMessages:plan.ids.length,refundAvailable:[...plan.refunds.values()].reduce((sum,row)=>sum+row.amount,0),
    releasedPrincipal:-[...plan.refunds.values()].reduce((sum,row)=>sum+row.locked,0),users:plan.refunds.size,blocked:plan.blocked};
}

/** One transaction, inverse ledger entries and a removal event make retries/replay safe. */
export async function removeReadingMessages(store:Store){
  const plan=await candidates(store),db=store.db;
  if(plan.blocked.length)throw new Error(`已读消息清理未执行：${plan.blocked.join('；')}`);
  // Former per-member acknowledgements cannot override each member's current state.
  await db.prepare("DELETE FROM reading_marks WHERE scope='influence' AND key LIKE 'member:%'").run();
  if(!plan.ids.length)return 0;
  const before=await financialFingerprint(db),tx=new Mutation(store),start=db.ledger.length;
  for(const [userId,refund] of plan.refunds)if(refund.amount||refund.locked)
    await store.ledger(userId,plan.obsolete[0]!.id,refund.amount,refund.locked,'取消公开已读未读消息退款',true);
  const operatingDelta=-[...plan.refunds.values()].reduce((sum,row)=>sum+row.amount+row.locked,0);
  await store.operating(operatingDelta,true);
  const memberships=await db.prepare('SELECT * FROM memberships WHERE "sourceId"=ANY($1::text[]) OR "memberId"=ANY($1::text[]) OR "parentId"=ANY($1::text[])').all(plan.ids);
  for(const row of memberships){tx.removed.add(String(row.memberId));tx.affected.add(String(row.memberId));tx.affected.add(String(row.parentId));}
  for(const row of await db.prepare('SELECT "targetId" FROM refs WHERE "sourceId"=ANY($1::text[])').all(plan.ids))tx.affected.add(String(row.targetId));
  const removedRoundIds=plan.removedRounds.map(round=>round.id);
  const originalRounds=structuredClone(plan.rounds.filter(round=>plan.removedKeys.has(round.targetKey)||plan.sharedKeys.has(round.targetKey)));
  for(const round of plan.rounds.filter(round=>plan.sharedKeys.has(round.targetKey))){
    for(const bet of plan.bets.filter(bet=>bet.targetKey===round.targetKey))round[bet.side]-=bet.amount;
    if(round.pro<0||round.con<0)throw new Error(`资金池本金记录不一致：${round.id}`);
    await db.prepare('UPDATE rounds SET body=$1 WHERE id=$2').run(JSON.stringify(round),round.id);
    tx.affected.add(round.subjectId??round.target.messageId);
  }
  await db.prepare('DELETE FROM bets WHERE id=ANY($1::text[])').run(plan.bets.map(bet=>bet.id));
  await db.prepare('DELETE FROM stake_positions WHERE id=ANY($1::text[]) OR "subjectId"=ANY($2::text[]) OR "roundId"=ANY($3::text[])').run(plan.bets.map(bet=>bet.id),plan.ids,removedRoundIds);
  await db.prepare('DELETE FROM rounds WHERE id=ANY($1::text[])').run(removedRoundIds);
  await db.prepare('DELETE FROM memberships WHERE "sourceId"=ANY($1::text[]) OR "memberId"=ANY($1::text[]) OR "parentId"=ANY($1::text[])').run(plan.ids);
  await db.prepare('DELETE FROM membership_actions WHERE id=ANY($1::text[])').run(plan.ids);
  await db.prepare('DELETE FROM execution_stances WHERE "sourceId"=ANY($1::text[]) OR target::jsonb->>\'messageId\'=ANY($1::text[])').run(plan.ids);
  await db.prepare('DELETE FROM display_stances WHERE "sourceId"=ANY($1::text[]) OR "targetId"=ANY($1::text[])').run(plan.ids);
  await db.prepare('DELETE FROM refs WHERE "sourceId"=ANY($1::text[])').run(plan.ids);
  for(const table of ['pool_checkpoints','message_state_checkpoints','settlement_access','reading_marks'])
    await db.prepare(`DELETE FROM ${table} WHERE "messageId"=ANY($1::text[])`).run(plan.ids);
  await db.prepare('DELETE FROM message_state_checkpoints WHERE "messageId"=ANY($1::text[])').run([...tx.affected]);
  await db.prepare('DELETE FROM messages WHERE id=ANY($1::text[])').run(plan.ids);
  const additions=db.ledger.slice(start);
  if(before!==await financialFingerprint(db,additions,operatingDelta))throw new Error('已读消息退款改变了预期之外的账户或账本');
  const change=await tx.commit();change.removedMessageIds=plan.ids;
  await db.exec('CREATE TABLE IF NOT EXISTS reading_message_removals(sequence BIGINT PRIMARY KEY,body JSONB NOT NULL)');
  await db.prepare('INSERT INTO reading_message_removals VALUES($1,$2)').run(change.sequence,JSON.stringify({deletedMessageIds:plan.ids,
    reversedLedgerIds:plan.ledger.map(entry=>entry.id),refundedLedger:additions,bets:plan.bets,rounds:originalRounds,operatingDelta}));
  await db.prepare('UPDATE changes SET body=$1 WHERE sequence=$2').run(JSON.stringify(change),change.sequence);
  return plan.obsolete.length;
}
