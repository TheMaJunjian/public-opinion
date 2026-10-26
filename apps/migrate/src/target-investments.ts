import {referenceKey,relations,targetInvestmentDimension,type Reference,type Message,type RelationPart,type LedgerEntry} from '@gonglun/core';
import {DomainError,Mutation,type Store} from '../../server/src/db.js';
import {placeValueWager,relocateHistoricalTargetWager,resolveExecutedStance} from '../../server/src/economy.js';
import {financialFingerprint} from './financial-fingerprint.js';
import {reconcileOrganizationEffects,validateJoinApproval} from '../../server/src/organizations.js';

function actionOf(message:Message):RelationPart|undefined{
  const parts=relations(message).filter(part=>part.roles.target?.length===1&&part.roles.target[0]!.reference.messageId!==message.id);
  return parts.find(part=>targetInvestmentDimension(part.relation)==='VALUE')??parts.find(part=>targetInvestmentDimension(part.relation)==='TRUTH');
}
type SavedBet={id:string;roundId:string;targetKey:string;userId:string;messageId:string;side:'pro'|'con';amount:number};
type Candidate={message:Message;action:RelationPart;target:Reference;bets:SavedBet[];rounds:Map<string,any>;retained:boolean;retainedReason?:string};

/** Historical completed contracts are retained explicitly; open principal can be moved without another debit. */
async function candidates(store:Pick<Store,'db'>){
  const db=store.db;
  const audited=!!(await db.prepare("SELECT to_regclass('target_investment_migrations') AS name").get())?.name;
  const done=new Set(audited?(await db.prepare('SELECT "messageId" FROM target_investment_migrations').all()).map(row=>String(row.messageId)):[]);
  const rounds=new Map((await db.prepare('SELECT id,body FROM rounds').all()).map(row=>[String(row.id),JSON.parse(String(row.body))]));
  const bySource=new Map<string,SavedBet[]>();
  for(const row of await db.prepare('SELECT * FROM bets ORDER BY position').all<SavedBet>()){
    const list=bySource.get(row.messageId)??[];list.push(row);bySource.set(row.messageId,list);
  }
  const executions=new Map<string,Array<{partId:string;side:string}>>();
  for(const row of await db.prepare('SELECT "sourceId","partId",side FROM execution_stances WHERE revision=1').all()){
    const list=executions.get(String(row.sourceId))??[];list.push({partId:String(row.partId),side:String(row.side)});executions.set(String(row.sourceId),list);
  }
  const result:Candidate[]=[];
  const messages=(await db.prepare('SELECT body FROM messages ORDER BY sequence,id').all()).map(row=>JSON.parse(String(row.body)) as Message);
  const byId=new Map(messages.map(message=>[message.id,message]));
  const lookup:Pick<Store,'db'|'message'>={db,message:async(id,revision)=>{
    const current=byId.get(id);if(current&&(revision===undefined||revision===current.revision))return current;
    const row=await db.prepare('SELECT body FROM revisions WHERE "messageId"=$1 AND revision=$2').get(id,revision);
    if(!row)throw new DomainError('历史目标不存在',404);return JSON.parse(String(row.body)) as Message;
  }};
  const hasPolicies=!!(await db.prepare("SELECT to_regclass('settlement_access') AS name").get())?.name;
  const policies=new Map((hasPolicies?await db.prepare('SELECT "messageId",allowed_keys FROM settlement_access').all():[]).map(row=>[String(row.messageId),row.allowed_keys as string[]]));
  for(const message of messages){
    if(message.authorId==='system'||done.has(message.id))continue;
    const action=actionOf(message);if(!action)continue;
    const kind=targetInvestmentDimension(action.relation),bets=bySource.get(message.id)??[];
    const own=relations(message).some(part=>['agree','disagree'].includes(part.relation)&&part.roles.target?.[0]?.reference.messageId===message.id);
    const flipped=kind==='TRUTH'&&(executions.get(message.id)??[]).some(execution=>execution.partId===action.id&&execution.side!==(action.relation==='agree'?'pro':'con'));
    const wrongDimension=kind==='VALUE'?message.spending.wager>0||bets.reduce((sum,bet)=>sum+Number(bet.amount),0)!==message.spending.recommendation:message.spending.recommendation>0;
    if(!own&&!flipped&&!wrongDimension)continue;
    // A modified source or a closed/cutoff contract keeps its original financial basis.
    const target=kind==='TRUTH'?(await resolveExecutedStance(lookup,{messageId:message.id,revision:message.revision,partId:action.id},action.relation==='agree'?'pro':'con')).target:action.roles.target![0]!.reference;
    const policy=kind==='TRUTH'?policies.get(target.messageId):undefined;
    const blocked=policy&&!policy.includes(referenceKey({...target,revision:target.revision??byId.get(target.messageId)?.revision}));
    let inactive=false;
    if(kind==='TRUTH')try{await validateJoinApproval(lookup,target,action.relation==='agree'?'pro':'con',message.authorId);}
      catch(error){if(!(error instanceof DomainError))throw error;inactive=true;}
    const retainedReason=inactive?'inactive-placement':blocked?'frozen-target':message.revision!==1?'modified-source':bets.some(bet=>rounds.get(bet.roundId)?.status!=='open')?'closed-contract'
      :bets.some(bet=>bet.userId!==message.authorId)||bets.reduce((sum,bet)=>sum+Number(bet.amount),0)!==message.spending.wager?'unmatched-principal':undefined;
    result.push({message,action,target,bets,rounds,retained:!!retainedReason,retainedReason});
  }
  return result;
}
export async function targetInvestmentPlan(store:Pick<Store,'db'>){
  const rows=await candidates(store);
  return {pending:rows.length,movable:rows.filter(row=>!row.retained).length,retained:rows.filter(row=>row.retained).length,
    retainedReasons:Object.fromEntries([...new Set(rows.flatMap(row=>row.retainedReason?[row.retainedReason]:[]))].map(reason=>[reason,rows.filter(row=>row.retainedReason===reason).length])),
    sampleIds:rows.slice(0,10).map(row=>row.message.id)};
}

export async function migrateTargetInvestments(store:Store):Promise<number>{
  const rows=await candidates(store);if(!rows.length)return 0;
  const before=await financialFingerprint(store.db),ledgerStart=store.db.ledger.length;
  let operatingDelta=0;
  await store.db.exec(`CREATE TABLE IF NOT EXISTS target_investment_migrations(
    "messageId" TEXT PRIMARY KEY,status TEXT NOT NULL,body JSONB NOT NULL)`);
  for(const candidate of rows){
    const {message:original,action,bets,rounds}=candidate;
    let retained=candidate.retained,retainedReason=candidate.retainedReason;
    if(!retained&&targetInvestmentDimension(action.relation)==='TRUTH')try{await validateJoinApproval(store,candidate.target,action.relation==='agree'?'pro':'con',original.authorId);}
      catch(error){if(!(error instanceof DomainError))throw error;retained=true;retainedReason='inactive-placement';}
    const backup={message:original,bets,retainedReason,rounds:[...new Set(bets.map(bet=>bet.roundId))].map(id=>rounds.get(id)),
      executions:await store.db.prepare('SELECT * FROM execution_stances WHERE "sourceId"=$1').all(original.id),
      positions:await store.db.prepare('SELECT * FROM stake_positions WHERE id=ANY($1::text[])').all(bets.map(bet=>bet.id)),
      display:await store.db.prepare('SELECT * FROM display_stances WHERE "sourceId"=$1').all(original.id)};
    if(retained){
      await store.db.prepare('INSERT INTO target_investment_migrations VALUES($1,$2,$3)').run(original.id,'retained-contract',JSON.stringify(backup));
      continue;
    }
    const tx=new Mutation(store),message=structuredClone(original),added:LedgerEntry[]=[];
    for(const bet of bets){
      const round=JSON.parse(String((await store.db.prepare('SELECT body FROM rounds WHERE id=$1').get(bet.roundId))!.body));
      round[bet.side]-=Number(bet.amount);
      if(round[bet.side]<0)throw new Error('历史轮次本金不足，停止迁移');
      await store.db.prepare('DELETE FROM bets WHERE id=$1').run(bet.id);
      await store.db.prepare('DELETE FROM stake_positions WHERE id=$1').run(bet.id);
      const remaining=await store.db.prepare('SELECT 1 FROM bets WHERE "roundId"=$1').get(bet.roundId);
      if(!remaining&&round.pro===0&&round.con===0){round.status='settled';round.result='tie';}
      await store.db.prepare('UPDATE rounds SET body=$1 WHERE id=$2').run(JSON.stringify(round),round.id);
      added.push(await store.ledger(bet.userId,original.id,Number(bet.amount),-Number(bet.amount),'历史目标投入解锁',true));
    }
    if(original.spending.recommendation){
      added.push(await store.ledger(original.authorId,original.id,original.spending.recommendation,0,'历史价值费用转目标押注返还',true));
      await store.operating(-original.spending.recommendation,true);
      operatingDelta-=original.spending.recommendation;
    }
    await store.db.prepare('DELETE FROM execution_stances WHERE "sourceId"=$1').run(original.id);
    for(const row of backup.display)tx.affected.add(String(row.targetId));
    await store.db.prepare('DELETE FROM display_stances WHERE "sourceId"=$1').run(original.id);
    message.parts=message.parts.filter(part=>!(part.type==='relation'&&['agree','disagree'].includes(part.relation)&&part.roles.target?.[0]?.reference.messageId===message.id));
    const total=original.spending.wager+original.spending.recommendation,kind=targetInvestmentDimension(action.relation);
    message.spending={...message.spending,wager:kind==='TRUTH'?total:0,recommendation:kind==='VALUE'?total:0};
    // A later minimum self wager was not part of an imported annotation's original round.
    // Keep that original requested round in the audit backup, not on the reassigned principal.
    if(kind==='VALUE')for(const part of message.parts)if(part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value))delete part.value.roundId;
    await tx.put(message);
    if(kind==='VALUE')await placeValueWager(tx,message,action,total,true);else await relocateHistoricalTargetWager(tx,message,total,action.id,candidate.target,action.relation==='agree'?'pro':'con');
    await store.db.prepare('DELETE FROM message_state_checkpoints WHERE "messageId"=ANY($1::text[])').run([...tx.affected]);
    const change=await tx.commit();
    await store.db.prepare('INSERT INTO target_investment_migrations VALUES($1,$2,$3)').run(original.id,'moved',JSON.stringify({...backup,sequence:change.sequence,ledgerIds:[...added,...change.ledger.filter(entry=>!added.some(old=>old.id===entry.id))].map(entry=>entry.id)}));
  }
  await reconcileTargetInvestmentMemberships(store);
  if(before!==await financialFingerprint(store.db,store.db.ledger.slice(ledgerStart),operatingDelta))throw new Error('关系投入迁移改变了预期之外的账户、旧账本或资金池');
  return rows.length;
}

/** Rebuild only the placement projection; never execute old messages or create paid actions. */
export async function reconcileTargetInvestmentMemberships(store:Store){
  const rows=await store.db.prepare("SELECT \"messageId\" FROM target_investment_migrations WHERE status='moved'").all();
  if(!rows.length)return 0;
  const tx=new Mutation(store),ids=rows.map(row=>String(row.messageId));
  for(const id of ids)tx.affected.add(id);
  for(const row of await store.db.prepare('SELECT "targetId" FROM refs WHERE "sourceId"=ANY($1::text[])').all(ids))tx.affected.add(String(row.targetId));
  const before=await store.db.prepare('SELECT * FROM memberships ORDER BY "memberId"').all();
  await reconcileOrganizationEffects(tx);
  if(!tx.memberships.size&&!tx.removed.size)return 0;
  const change=await tx.commit();
  await store.db.prepare(`UPDATE target_investment_migrations SET body=body||jsonb_build_object('placementBefore',$1::jsonb,'placementSequence',$2::bigint) WHERE "messageId"=$3`)
    .run(JSON.stringify(before),change.sequence,ids[0]);
  return tx.memberships.size+tx.removed.size;
}
