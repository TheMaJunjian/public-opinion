import { reviewEconomy, type Message, type ReviewVerdict, type ReviewStakeItem } from '@gonglun/core';
import { integer, type Mutation, type Store } from './db.js';
import type { ModerationCase } from './moderation.js';
import { assignmentRecord } from './review-assignments.js';

export type ReviewPayment={userId:string;amount:number;kind:'wager'|'fee'|'fee-refund'|'deposit'|'penalty'};
type FeeRound={caseId:string;round:number;payerId:string;amount:number;rewardSlots:number;rewardAmount:number;paid:boolean};
/** The historical deposit table now stores self stakes; it never grants a reviewer vote. */
export type ReviewDeposit={caseId:string;round:number;payerId:string;amount:number;messageId:string;verdict:ReviewVerdict};

export async function addReviewFunding(tx:Mutation,c:ModerationCase,source:Message,fee:number,deposit:number,allowDebt=false,verdict:ReviewVerdict='pass'){
  const {rewardSlots,rewardAmount}=reviewEconomy(c.policy);
  await tx.store.db.prepare('INSERT INTO moderation_round_fees("caseId",round,"payerId",amount,"rewardSlots","rewardAmount") VALUES($1,$2,$3,$4,$5,$6)')
    .run(c.id,c.round,source.authorId,fee,rewardSlots,rewardAmount);
  await tx.store.db.prepare('INSERT INTO moderation_deposits("caseId",round,"payerId",amount,"messageId",verdict) VALUES($1,$2,$3,$4,$5,$6)')
    .run(c.id,c.round,source.authorId,deposit,source.id,verdict);
  if(fee)await tx.store.ledger(source.authorId,source.id,-fee,fee,'审核费冻结',allowDebt);
  if(deposit)await tx.store.ledger(source.authorId,source.id,-deposit,deposit,'审核自押冻结',allowDebt);
}

export async function reviewDeposits(store:Store,caseId:string){
  return store.db.prepare('SELECT * FROM moderation_deposits WHERE "caseId"=$1 ORDER BY round').all<ReviewDeposit>(caseId);
}

/** Use funded entries, not discussion or process messages. Earlier rounds remain in the same pool. */
export async function reviewStakes(store:Store,review:ModerationCase):Promise<ReviewStakeItem[]>{
  return store.db.prepare(`WITH stakes AS (
    SELECT 'wager' AS kind,"messageId","userId",round,verdict,amount,"createdAt" FROM moderation_votes WHERE "caseId"=$1
    UNION ALL
    SELECT 'self',d."messageId",d."payerId",d.round,d.verdict,d.amount,m.body::jsonb->>'createdAt'
      FROM moderation_deposits d JOIN messages m ON m.id=d."messageId" WHERE d."caseId"=$1 AND d.amount>0
  ) SELECT 'review-'||s.kind||':'||s."messageId" AS id,s."messageId" AS "sourceMessageId",
      CASE WHEN s."messageId"=$2 THEN $3 ELSE (m.body::jsonb->>'revision')::integer END AS revision,
      s.kind,s.round,CASE WHEN s.verdict='pass' THEN 'PRO' ELSE 'CON' END AS side,s.amount,s."createdAt",
      jsonb_build_object('id',u.id,'username',u.name,'createdAt',COALESCE(u."createdAt",'')) AS "user"
    FROM stakes s JOIN messages m ON m.id=s."messageId" JOIN users u ON u.id=s."userId"
    ORDER BY s."createdAt" DESC,m.sequence DESC,s.kind`).all<ReviewStakeItem>(review.id,review.messageId,review.revision);
}

/** Participation rewards never depend on the verdict and are never reclaimed by a later appeal. */
export async function payReviewFees(tx:Mutation,c:ModerationCase):Promise<ReviewPayment[]>{
  const rounds=await tx.store.db.prepare('SELECT * FROM moderation_round_fees WHERE "caseId"=$1 AND NOT paid ORDER BY round').all<FeeRound>(c.id);
  const all:ReviewPayment[]=[];
  for(const round of rounds){
    const slots=Math.min(round.rewardSlots,Math.floor(round.amount/round.rewardAmount));
    const first=await tx.store.db.prepare('SELECT "userId",MIN(position) AS first FROM moderation_votes WHERE "caseId"=$1 AND round=$2 GROUP BY "userId" ORDER BY first,"userId" LIMIT $3')
      .all<{userId:string}>(c.id,round.round,slots);
    const refund=integer(round.amount-first.length*round.rewardAmount);
    const payouts:ReviewPayment[]=[...first.map(v=>({userId:v.userId,amount:round.rewardAmount,kind:'fee' as const})),
      ...(refund?[{userId:round.payerId,amount:refund,kind:'fee-refund' as const}]:[])];
    const record=await assignmentRecord(tx,c,'本轮审核参与报酬与剩余预算结算',{feeRound:round.round,fee:round.amount,payerId:round.payerId,payouts});
    if(round.amount)await tx.store.ledger(round.payerId,record.id,0,-round.amount,'审核费支付',true);
    for(const p of payouts)await tx.store.ledger(p.userId,record.id,p.amount,0,p.kind==='fee'?'审核参与报酬':'未使用审核费退还',true);
    await tx.store.db.prepare('UPDATE moderation_round_fees SET paid=TRUE WHERE "caseId"=$1 AND round=$2').run(c.id,round.round);
    all.push(...payouts);
  }
  return all;
}
