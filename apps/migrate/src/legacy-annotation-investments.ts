import {referenceKey,relations,type Message,type RelationPart} from '@gonglun/core';
import {Mutation,type Store} from '../../server/src/db.js';
import {dataOf,placeValueWager} from '../../server/src/economy.js';
import {legacyTimestamp} from './legacy-time.js';
import {financialFingerprint} from './financial-fingerprint.js';

const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const singleTarget=(record:any)=>Array.isArray(record?.targetRefs)&&record.targetRefs.length===1?record.targetRefs[0]:undefined;
const targetId=(ref:any)=>ref?.kind==='relation'?ref.relationId:ref?.kind==='message'?ref.messageId:undefined;
const whole=(ref:any)=>ref&&!ref.partId&&!ref.memberId&&!ref.range&&!ref.path?.length;
const clock=(value:unknown)=>Date.parse(legacyTimestamp(value));

/** Recover the automatic stake using original relation, stake, ledger, round and audit records together. */
async function candidates(store:Pick<Store,'db'>){
  const db=store.db,tables=await db.prepare(`SELECT to_regclass('legacy_records') AS records,to_regclass('legacy_stakes') AS stakes,
    to_regclass('target_investment_migrations') AS investments,to_regclass('legacy_annotation_investment_repairs') AS repairs,
    to_regclass('minimum_contribution_backups') AS minimum,to_regclass('minimum_contribution_reapplications') AS reapplied`).get();
  const rows:any[]=[],unresolved:Array<{betId:string;reason:string}>=[];
  if(!tables?.records||!tables.stakes||!tables.investments)return {rows,unresolved};
  const retainedAudits=await db.prepare("SELECT * FROM target_investment_migrations WHERE status='partially-moved' ORDER BY \"messageId\"").all();
  if(!retainedAudits.length)return {rows,unresolved};
  const done=new Set(tables.repairs?(await db.prepare('SELECT "betId" FROM legacy_annotation_investment_repairs').all()).map(row=>String(row.betId)):[]);
  const originalRecords=(await db.prepare(`SELECT "tableName",body FROM legacy_records WHERE "tableName" IN ('Message','Stake','SettlementRound','LedgerEntry','AuditLog')`).all());
  const records=(table:string)=>originalRecords.filter(row=>row.tableName===table).map(row=>row.body);
  const originals=new Map(records('Message').map(record=>[record.id,record]));
  const logs=records('AuditLog'),ledgers=records('LedgerEntry'),oldRounds=new Map(records('SettlementRound').map(record=>[record.id,record]));
  const nativeMessage=async(id:string)=>{
    const row=await db.prepare('SELECT body FROM messages WHERE id=$1').get(id);return row?JSON.parse(String(row.body)) as Message:undefined;
  };
  for(const audit of retainedAudits){
    const annotation=await nativeMessage(String(audit.messageId)),originalAnnotation=originals.get(audit.messageId);
    if(!annotation||annotation.revision!==1||originalAnnotation?.relationType!=='ARCHIVE'||originalAnnotation.createdById!==annotation.authorId)continue;
    const annotations=relations(annotation).filter(part=>part.relation==='archive'&&part.roles.target?.length===1);
    if(annotations.length!==1)continue;
    const annotationPart=annotations[0]!,subject=annotationPart.roles.target![0]!.reference;
    if(!whole(subject)||targetId(singleTarget(originalAnnotation))!==subject.messageId)continue;
    const retained=(audit.body.minimumRepair?.retainedBets??[]) as any[];
    for(const saved of retained){
      if(done.has(saved.id))continue;
      const bet=await db.prepare('SELECT * FROM bets WHERE id=$1').get(saved.id);
      const position=await db.prepare('SELECT * FROM stake_positions WHERE id=$1').get(saved.id);
      if(!bet||position?.settlementType!=='TRUTH')continue; // A recommendation of the annotation itself remains its VALUE contract.
      const reject=(reason:string)=>unresolved.push({betId:String(bet.id),reason});
      const oldStake=(await db.prepare('SELECT body FROM legacy_stakes WHERE id=$1').get(bet.id))?.body;
      const archivedStakes=records('Stake').filter(stake=>stake.id===bet.id);
      const key=referenceKey({messageId:annotation.id,revision:1});
      if(!oldStake||archivedStakes.length!==1||stable(archivedStakes[0])!==stable(oldStake)||oldStake.settlementType!=='TRUTH'||oldStake.side!=='PRO'||oldStake.messageId!==annotation.id
        ||oldStake.userId!==bet.userId||oldStake.roundId!==bet.roundId||oldStake.amount!==bet.amount||bet.amount<=0||bet.side!=='pro'||bet.messageId!==annotation.id||bet.targetKey!==key
        ||position.userId!==bet.userId||position.subjectId!==annotation.id||position.roundId!==bet.roundId||position.amount!==bet.amount||position.side!=='pro'||referenceKey(position.reference)!==key){reject('原押注与当前本金不一致');continue;}
      const sources=records('Message').filter(message=>message.kind==='RELATION'&&message.relationType==='AGREE'&&message.createdById===bet.userId
        &&message.topicId===oldStake.topicId&&targetId(singleTarget(message))===annotation.id
        &&[undefined,'whole'].includes(singleTarget(message)?.part)&&clock(message.createdAt)<=clock(oldStake.createdAt)
        &&clock(oldStake.createdAt)-clock(message.createdAt)<=1000);
      if(sources.length!==1){reject('缺少唯一对应的原始赞同消息');continue;}
      const originalSource=sources[0]!,originalRound=oldRounds.get(bet.roundId);
      const relationLogs=logs.filter(log=>log.action==='RELATION_CREATED'&&log.entityId===originalSource.id&&log.actorId===bet.userId);
      const stakeLogs=logs.filter(log=>log.action==='STAKE_PLACED'&&log.entityId===bet.id&&log.actorId===bet.userId);
      const locks=ledgers.filter(entry=>entry.entryType==='STAKE_LOCK'&&entry.userId===bet.userId&&entry.messageId===annotation.id
        &&entry.roundId===bet.roundId&&entry.amount===-bet.amount&&clock(entry.createdAt)===clock(oldStake.createdAt));
      const relationLog=relationLogs[0],stakeLog=stakeLogs[0],relationDetails=relationLog?.data?.details,stakeDetails=stakeLog?.data?.details;
      // The old automatic stake logger included settlementType; a separate manual stake did not.
      if(relationLogs.length!==1||stakeLogs.length!==1||locks.length!==1||relationDetails?.relationType!=='AGREE'||relationDetails.transformed!==false
        ||relationDetails.settlementType!=='TRUTH'||targetId(singleTarget(relationDetails))!==annotation.id||stakeDetails?.settlementType!=='TRUTH'
        ||stakeDetails.roundId!==bet.roundId||stakeDetails.messageId!==annotation.id||stakeDetails.amount!==bet.amount||stakeDetails.side!=='PRO'
        ||originalRound?.messageId!==annotation.id||originalRound.settlementType!=='TRUTH'||originalRound.createdByUserId!==bet.userId
        ||!['OPEN','VOTING'].includes(originalRound.status)||originalRound.previousRoundId||originalRound.closedAt
        ||clock(originalSource.createdAt)>clock(relationLog.createdAt)||clock(relationLog.createdAt)>clock(originalRound.openedAt)
        ||clock(originalRound.openedAt)>clock(oldStake.createdAt)||clock(oldStake.createdAt)>clock(stakeLog.createdAt)
        ||clock(stakeLog.createdAt)-clock(originalSource.createdAt)>1000){reject('原始审计、锁定流水或自动押注时间链不完整');continue;}
      const sender=await nativeMessage(originalSource.id),stance=sender&&dataOf(sender).annotationStance as any;
      const actions=sender?relations(sender).filter(part=>part.relation==='archive'&&part.roles.target?.length===1):[];
      const action=actions[0];
      if(!sender||sender.revision!==1||sender.authorId!==bet.userId||sender.createdAt!==legacyTimestamp(originalSource.createdAt)
        ||sender.spending.wager!==0||sender.spending.recommendation<=0||stance?.side!=='pro'||stance.target?.messageId!==annotation.id
        ||actions.length!==1||referenceKey(action!.roles.target![0]!.reference)!==referenceKey(subject)){
        reject('赞同消息尚未归一为同一目标的冷藏');continue;
      }
      const oldRoundRow=await db.prepare('SELECT body FROM rounds WHERE id=$1').get(bet.roundId),oldRound=oldRoundRow&&JSON.parse(String(oldRoundRow.body));
      const execution=await db.prepare('SELECT * FROM execution_stances WHERE "sourceId"=$1 AND revision=1 AND "partId"=$2').get(sender.id,action!.id);
      const senderBets=await db.prepare('SELECT b.*,p."subjectId",p."settlementType" FROM bets b JOIN stake_positions p ON p.id=b.id WHERE b."messageId"=$1').all(sender.id);
      const valueRoundRow=senderBets.length?await db.prepare('SELECT body FROM rounds WHERE id=$1').get(senderBets[0]!.roundId):undefined;
      const valueRound=valueRoundRow&&JSON.parse(String(valueRoundRow.body));
      if(!oldRound||oldRound.status!=='open'||oldRound.previousRoundId||oldRound.distributionId||oldRound.payouts?.length||oldRound.settlementType!=='TRUTH'
        ||oldRound.targetKey!==key||oldRound.pro<bet.amount||!valueRound||valueRound.status!=='open'||valueRound.settlementType!=='VALUE'||valueRound.subjectId!==subject.messageId
        ||!execution||execution.side!=='con'||referenceKey(JSON.parse(String(execution.target)))!==valueRound.targetKey
        ||senderBets.some(saved=>saved.userId!==sender.authorId||saved.settlementType!=='VALUE'||saved.subjectId!==subject.messageId||saved.side!=='con'||saved.roundId!==valueRound.id)
        ||senderBets.reduce((sum,saved)=>sum+Number(saved.amount),0)!==sender.spending.recommendation){reject('当前旧轮次或目标价值合同已改变');continue;}
      let duplicateMinimum:any;
      if(tables.minimum&&senderBets.length===1&&senderBets[0]!.amount===1&&sender.spending.recommendation===1){
        const originalMinimum=await db.prepare('SELECT * FROM minimum_contribution_backups WHERE "messageId"=$1').get(sender.id);
        const reapplied=tables.reapplied?await db.prepare('SELECT * FROM minimum_contribution_reapplications WHERE "messageId"=$1').get(sender.id):undefined;
        const minimum=reapplied??originalMinimum;
        const senderAudit=await db.prepare('SELECT body FROM target_investment_migrations WHERE "messageId"=$1 AND status=$2').get(sender.id,'moved');
        const original=minimum&&JSON.parse(String(minimum.body)) as Message|undefined;
        const minimumLedger=minimum&&await db.prepare('SELECT * FROM ledger WHERE id=$1').get(minimum.ledgerId);
        const previous=senderAudit?.body.message as Message|undefined,previousBets=senderAudit?.body.bets;
        if(original&&previous&&original.revision===1&&original.authorId===sender.authorId&&original.spending.wager===0&&original.spending.recommendation===0
          &&previous.spending.wager===1&&previous.spending.recommendation===0&&previousBets?.length===1
          &&previousBets[0].amount===1&&previousBets[0].userId===sender.authorId&&previousBets[0].targetKey===referenceKey({messageId:sender.id,revision:1})
          &&stable(previous.parts.filter(part=>!(part.type==='relation'&&part.relation==='agree'&&part.roles.target?.[0]?.reference.messageId===sender.id)))===stable(original.parts)
          &&minimumLedger?.messageId===sender.id&&minimumLedger.userId===sender.authorId&&minimumLedger.amount===-1&&minimumLedger.lockedDelta===1&&minimumLedger.reason==='历史消息真假补扣'){
          const minimumPosition=await db.prepare('SELECT * FROM stake_positions WHERE id=$1').get(senderBets[0]!.id);
          duplicateMinimum={minimum,minimumLedger,bet:senderBets[0],position:minimumPosition,round:valueRound};
        }
      }
      rows.push({annotation,sender,action:action as RelationPart,bet,position,oldRound,valueRound,execution,senderBets,duplicateMinimum,
        evidence:{originalAnnotation,originalSource,oldStake,originalRound,relationLog,stakeLog,lock:locks[0],elapsedMs:clock(oldStake.createdAt)-clock(originalSource.createdAt)}});
    }
  }
  return {rows,unresolved};
}

export async function legacyAnnotationInvestmentPlan(store:Pick<Store,'db'>){
  const {rows,unresolved}=await candidates(store);
  return {pending:rows.length,points:rows.reduce((sum,row)=>sum+Number(row.bet.amount),0),refundPoints:rows.filter(row=>row.duplicateMinimum).length,unresolved,
    items:rows.map(row=>({betId:row.bet.id,sourceId:row.sender.id,annotationId:row.annotation.id,target:row.action.roles.target![0]!.reference,
      amount:row.bet.amount,dimension:'VALUE',side:'con',refundPoints:row.duplicateMinimum?1:0,elapsedMs:row.evidence.elapsedMs}))};
}

/** Move only proven automatic AGREE-on-ARCHIVE stakes, preserving unrelated contracts and original evidence. */
export async function repairLegacyAnnotationInvestments(store:Store){
  const {rows}=await candidates(store);if(!rows.length)return 0;
  const before=await financialFingerprint(store.db),start=store.db.ledger.length;
  const accounts=await store.db.prepare('SELECT * FROM accounts ORDER BY "userId"').all();
  await store.db.exec('CREATE TABLE IF NOT EXISTS legacy_annotation_investment_repairs("betId" TEXT PRIMARY KEY,body JSONB NOT NULL)');
  for(const row of rows){
    const tx=new Mutation(store),sender=await store.message(row.sender.id),originalSender=structuredClone(sender),ledgerStart=store.db.ledger.length;
    const saved=await store.db.prepare('SELECT body FROM rounds WHERE id=$1').get(row.oldRound.id),round=JSON.parse(String(saved!.body));
    round.pro-=Number(row.bet.amount);if(round.pro<0)throw new Error('历史赞同本金不足');
    await store.db.prepare('DELETE FROM bets WHERE id=$1').run(row.bet.id);
    await store.db.prepare('DELETE FROM stake_positions WHERE id=$1').run(row.bet.id);
    if(!await store.db.prepare('SELECT 1 FROM bets WHERE "roundId"=$1').get(round.id)&&round.pro===0&&round.con===0){round.status='settled';round.result='tie';}
    await store.db.prepare('UPDATE rounds SET body=$1 WHERE id=$2').run(JSON.stringify(round),round.id);
    await store.ledger(sender.authorId,sender.id,Number(row.bet.amount),-Number(row.bet.amount),'历史赞同标注本金转价值解锁',true);
    if(row.duplicateMinimum){
      const duplicate=row.duplicateMinimum;
      const savedValue=await store.db.prepare('SELECT body FROM rounds WHERE id=$1').get(duplicate.round.id),value=JSON.parse(String(savedValue!.body));
      if(value.status!=='open'||value.con<1)throw new Error('重复最低投入已进入结算');
      value.con-=1;
      await store.db.prepare('DELETE FROM bets WHERE id=$1').run(duplicate.bet.id);
      await store.db.prepare('DELETE FROM stake_positions WHERE id=$1').run(duplicate.bet.id);
      await store.db.prepare('UPDATE rounds SET body=$1 WHERE id=$2').run(JSON.stringify(value),value.id);
      await store.ledger(sender.authorId,sender.id,1,-1,'发送时已有真实投入，重复最低补扣退回',true);
    }
    sender.spending={...sender.spending,recommendation:sender.spending.recommendation+Number(row.bet.amount)-(row.duplicateMinimum?1:0)};
    await tx.put(sender);
    await store.db.prepare('DELETE FROM execution_stances WHERE "sourceId"=$1 AND revision=1 AND "partId"=$2').run(sender.id,row.action.id);
    await placeValueWager(tx,sender,row.action,Number(row.bet.amount),true);
    const execution=await store.db.prepare('SELECT * FROM execution_stances WHERE "sourceId"=$1 AND revision=1 AND "partId"=$2').get(sender.id,row.action.id);
    if(stable(execution)!==stable(row.execution))throw new Error('追加本金改变了已有价值执行地址');
    tx.affected.add(row.annotation.id);
    await store.db.prepare('DELETE FROM message_state_checkpoints WHERE "messageId"=ANY($1::text[])').run([...tx.affected]);
    const change=await tx.commit();
    const remaining=await store.db.prepare('SELECT b.*,p."settlementType" FROM bets b JOIN stake_positions p ON p.id=b.id WHERE b."messageId"=$1 ORDER BY b.position').all(row.annotation.id);
    const repaired=await store.db.prepare('SELECT * FROM bets WHERE "messageId"=$1 AND id<>ALL($2::text[]) ORDER BY position').all(sender.id,row.senderBets.map((bet:any)=>bet.id));
    await store.db.prepare('INSERT INTO legacy_annotation_investment_repairs VALUES($1,$2)').run(row.bet.id,JSON.stringify({
      evidence:row.evidence,bet:row.bet,position:row.position,round:row.oldRound,sender:originalSender,duplicateMinimum:row.duplicateMinimum,sequence:change.sequence,
      repairedBets:repaired,ledgerIds:store.db.ledger.slice(ledgerStart).map(entry=>entry.id)}));
    await store.db.prepare(`UPDATE target_investment_migrations SET status=$1,body=body||jsonb_build_object('remainingContracts',$2::jsonb,
      'legacyAnnotationRepairs',COALESCE(body->'legacyAnnotationRepairs','[]'::jsonb)||$3::jsonb) WHERE "messageId"=$4`)
      .run(remaining.some(bet=>bet.settlementType==='TRUTH')?'partially-moved':'moved',JSON.stringify(remaining),JSON.stringify([row.bet.id]),row.annotation.id);
  }
  const additions=store.db.ledger.slice(start);
  for(const row of rows)if(row.duplicateMinimum){
    const account=accounts.find(account=>account.userId===row.sender.authorId)!;account.available+=1;account.locked-=1;
  }
  if(additions.length!==rows.length*2+rows.filter(row=>row.duplicateMinimum).length||additions.some(entry=>entry.amount+entry.lockedDelta!==0)
    ||stable(accounts)!==stable(await store.db.prepare('SELECT * FROM accounts ORDER BY "userId"').all())
    ||before!==await financialFingerprint(store.db,additions))throw new Error('历史标注赞同迁移改变了余额、旧账本或资金池');
  return rows.length;
}
