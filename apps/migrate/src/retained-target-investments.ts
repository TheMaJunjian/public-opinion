import {referenceKey,relations,targetInvestmentDimension,type Message,type Reference} from '@gonglun/core';
import {Mutation,type Store} from '../../server/src/db.js';
import {placeValueWager,refundHistoricalSelfWager,relocateRecordedTargetWager,resolveExecutedStance} from '../../server/src/economy.js';
import {financialFingerprint} from './financial-fingerprint.js';

const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);

/** Only the exact, still-open one-point minimum backfill is eligible; imported stakes are separate contracts. */
async function candidates(input:Pick<Store,'db'>){
  const store:Pick<Store,'db'|'message'>={db:input.db,message:async(id,revision)=>{
    const row=revision===undefined?await input.db.prepare('SELECT body FROM messages WHERE id=$1').get(id)
      :await input.db.prepare('SELECT body FROM revisions WHERE "messageId"=$1 AND revision=$2').get(id,revision);
    if(!row)throw new Error('保留合同的原始消息不存在');return JSON.parse(String(row.body)) as Message;
  }};
  const tables=await store.db.prepare("SELECT to_regclass('target_investment_migrations') AS audit,to_regclass('minimum_contribution_backups') AS minimum").get();
  if(!tables?.audit||!tables.minimum)return [];
  const rows=await store.db.prepare("SELECT * FROM target_investment_migrations WHERE status='retained-contract' ORDER BY \"messageId\"").all();
  const result=[];
  for(const row of rows){
    const message=await store.message(String(row.messageId)),audit=row.body;
    if(!['inactive-placement','unmatched-principal'].includes(audit.retainedReason)||audit.minimumRepair)continue;
    const backup=await store.db.prepare('SELECT * FROM minimum_contribution_backups WHERE "messageId"=$1').get(message.id);
    if(!backup)continue;
    const reapplied=(await store.db.prepare("SELECT to_regclass('minimum_contribution_reapplications') AS name").get())?.name
      ?await store.db.prepare('SELECT * FROM minimum_contribution_reapplications WHERE "messageId"=$1').get(message.id):undefined;
    const minimum=reapplied??backup,original=JSON.parse(String(minimum.body)) as Message;
    if(message.revision!==1||original.revision!==message.revision||original.authorId!==message.authorId
      ||original.spending.wager!==0||original.spending.recommendation!==0||message.spending.wager!==1||message.spending.recommendation!==0)continue;
    const own=relations(message).filter(part=>part.relation==='agree'&&part.roles.target?.length===1&&part.roles.target[0]!.reference.messageId===message.id
      &&!original.parts.some(old=>old.id===part.id));
    if(own.length!==1||stable(message.parts.filter(part=>part.id!==own[0]!.id))!==stable(original.parts))continue;
    const key=referenceKey({messageId:message.id,revision:message.revision});
    const bets=await store.db.prepare('SELECT * FROM bets WHERE "messageId"=$1 ORDER BY position').all(message.id);
    const matched=bets.filter(bet=>bet.targetKey===key&&bet.userId===message.authorId&&bet.side==='pro'&&Number(bet.amount)===1);
    if(matched.length!==1)continue;
    const bet=matched[0]!,roundRow=await store.db.prepare('SELECT body FROM rounds WHERE id=$1').get(bet.roundId);
    const round=roundRow&&JSON.parse(String(roundRow.body));
    const ledger=await store.db.prepare('SELECT * FROM ledger WHERE id=$1').get(minimum.ledgerId);
    const position=await store.db.prepare('SELECT * FROM stake_positions WHERE id=$1').get(bet.id);
    if(!round||round.status!=='open'||round.settlementType!=='TRUTH'||round.pro<1||round.targetKey!==key||referenceKey(round.target)!==key
      ||!ledger||ledger.userId!==message.authorId||ledger.messageId!==message.id||ledger.amount!==-1||ledger.lockedDelta!==1||ledger.reason!=='历史消息真假补扣'
      ||!position||position.userId!==message.authorId||position.subjectId!==message.id||position.roundId!==bet.roundId||position.settlementType!=='TRUTH'||position.side!=='pro'||position.amount!==1||referenceKey(position.reference)!==key)continue;
    const actions=relations(original).filter(part=>targetInvestmentDimension(part.relation)&&part.roles.target?.length===1);
    if(actions.length!==1)continue;
    const action=actions[0]!,kind=targetInvestmentDimension(action.relation)!;
    const target:Reference=kind==='TRUTH'?(await resolveExecutedStance(store,{messageId:message.id,revision:message.revision,partId:action.id},action.relation==='agree'?'pro':'con')).target:action.roles.target![0]!.reference;
    if(kind==='TRUTH'){
      const policy=await store.db.prepare('SELECT allowed_keys FROM settlement_access WHERE "messageId"=$1').get(target.messageId);
      if(policy&&!policy.allowed_keys.includes(referenceKey(target)))continue;
      const execution=await store.db.prepare('SELECT target,side FROM execution_stances WHERE "sourceId"=$1 AND revision=$2 AND "partId"=$3').get(message.id,message.revision,action.id);
      const display=await store.db.prepare('SELECT "targetKey",side FROM display_stances WHERE "sourceId"=$1').get(message.id);
      if(!execution||referenceKey(JSON.parse(String(execution.target)))!==referenceKey(target)||execution.side!==(action.relation==='agree'?'pro':'con')
        ||display?.targetKey!==referenceKey(target)||display.side!==execution.side)continue;
    }
    result.push({message,original,audit,minimum,action,target,kind,ownPartId:own[0]!.id,bet,round,position,
      retainedBets:bets.filter(saved=>saved.id!==bet.id)});
  }
  return result;
}
export async function retainedTargetInvestmentPlan(store:Pick<Store,'db'>){
  const rows=await candidates(store);
  return {pending:rows.length,points:rows.length,items:rows.map(row=>({messageId:row.message.id,dimension:row.kind,target:row.target,
    retainedContracts:row.retainedBets.length,retainedPoints:row.retainedBets.reduce((sum,bet)=>sum+Number(bet.amount),0)}))};
}

/** Never replay membership actions, rewrite unrelated stakes, or charge a second contribution. */
export async function repairRetainedTargetInvestments(store:Store){
  const rows=await candidates(store);if(!rows.length)return 0;
  const before=await financialFingerprint(store.db),start=store.db.ledger.length;
  const placements=stable(await store.db.prepare('SELECT * FROM memberships ORDER BY "memberId"').all());
  const actions=stable(await store.db.prepare('SELECT * FROM membership_actions ORDER BY id').all());
  for(const row of rows){
    const tx=new Mutation(store),message=structuredClone(row.message),ledgerStart=store.db.ledger.length;
    message.parts=message.parts.filter(part=>part.id!==row.ownPartId);
    message.spending={...message.spending,wager:row.kind==='TRUTH'?1:0,recommendation:row.kind==='VALUE'?1:0};
    await tx.put(message);
    await refundHistoricalSelfWager(tx,message,row.ownPartId,'历史关系最低投入转目标解锁');
    if(row.kind==='VALUE')await placeValueWager(tx,message,row.action,1,true);
    else await relocateRecordedTargetWager(tx,message,1,row.action.id,row.target,row.action.relation==='agree'?'pro':'con');
    const change=await tx.commit();
    const minimumRepair={sequence:change.sequence,minimum:row.minimum,bet:row.bet,round:row.round,position:row.position,
      target:row.target,dimension:row.kind,retainedBets:row.retainedBets,ledgerIds:store.db.ledger.slice(ledgerStart).map(entry=>entry.id)};
    await store.db.prepare('UPDATE target_investment_migrations SET status=$1,body=body||jsonb_build_object(\'minimumRepair\',$2::jsonb) WHERE "messageId"=$3')
      .run(row.retainedBets.length?'partially-moved':'moved',JSON.stringify(minimumRepair),message.id);
  }
  const additions=store.db.ledger.slice(start);
  if(additions.length!==rows.length*2||additions.some(entry=>entry.amount+entry.lockedDelta!==0)
    ||additions.reduce((sum,entry)=>sum+entry.amount,0)!==0||additions.reduce((sum,entry)=>sum+entry.lockedDelta,0)!==0
    ||before!==await financialFingerprint(store.db,additions))throw new Error('保留合同修复改变了预期之外的余额或账本');
  if(placements!==stable(await store.db.prepare('SELECT * FROM memberships ORDER BY "memberId"').all())
    ||actions!==stable(await store.db.prepare('SELECT * FROM membership_actions ORDER BY id').all()))throw new Error('保留合同修复改变了组织执行或归属');
  return rows.length;
}
