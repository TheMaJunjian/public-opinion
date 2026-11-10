import { createHash } from 'node:crypto';
import { DEFAULT_MODERATION_POLICY, REVIEW_RELATIONS, requiresModeration, relations, reviewResult, reviewEconomy, type Message, type ModerationPolicy, type ModerationSummary, type Part, type ReviewVerdict, type ReviewResult, type SendInput } from '@gonglun/core';
import { DomainError, id, integer, Mutation, now, type Store } from './db.js';
import { hasModerationTables } from './moderation-schema.js';
import { assignmentIsValid, refreshCaseAssignments, reviewAssignment, reviewWindowOpen } from './review-assignments.js';
import { addReviewFunding, payReviewFees, reviewDeposits, type ReviewDeposit, type ReviewPayment } from './review-finances.js';
import { assertMessageReadable } from './moderation-visibility.js';
import { retiredOrganizationIds } from './retired-organizations.js';

const dataOf = (m: Pick<Message,'parts'>): Record<string,any> => Object.assign({}, ...m.parts.flatMap(p => p.type === 'data' && p.value && typeof p.value === 'object' && !Array.isArray(p.value) ? [p.value] : []));
type Settlement = {verdict:ReviewResult;payouts:ReviewPayment[];fund:number;finalized:boolean;voteIds:string[];messageId:string};
export interface ModerationCase {id:string;messageId:string;revision:number;authorId:string;snapshot:Message;ruleVersion:number;policy:ModerationPolicy;status:ModerationSummary['status'];fee:number;deposit:number;releaseAt:string|null;settlement:Settlement|null;createdAt:string;position:number;round:number;stage:number;assignmentCheckAt:number}
type Vote = {messageId:string;caseId:string;userId:string;verdict:ReviewVerdict;amount:number;createdAt:string;position:number;round:number};
export async function moderationPolicy(store:Store):Promise<ModerationPolicy> {return {...DEFAULT_MODERATION_POLICY,...(await store.rules()).moderation};}
/** Active assignees may settle without casting a vote; voluntary participants also qualify. */
export async function isReviewer(store:Store,userId:string|undefined,c:ModerationCase):Promise<boolean> {
  return !!userId&&(assignmentIsValid(await reviewAssignment(store,c,userId))||!!await store.db.prepare('SELECT 1 FROM moderation_votes WHERE "caseId"=$1 AND round=$2 AND "userId"=$3 LIMIT 1').get(c.id,c.round,userId));
}
export async function moderationCase(store:Store,messageId:string,revision?:number):Promise<ModerationCase|undefined> {
  return store.db.prepare(`SELECT * FROM moderation_cases WHERE "messageId"=$1 ${revision===undefined?'':'AND revision=$2'} ORDER BY revision DESC LIMIT 1`).get<ModerationCase>(...revision===undefined?[messageId]:[messageId,revision]);
}
export async function reviewVotes(store:Store,caseId:string):Promise<Vote[]> {return store.db.prepare('SELECT * FROM moderation_votes WHERE "caseId"=$1 ORDER BY position').all<Vote>(caseId);}
export function summarizeReview(c:ModerationCase,votes:Vote[],deposits:ReviewDeposit[],viewerId?:string):ModerationSummary {
  const latest=new Map<string,Vote>();for(const vote of votes)if(vote.round===c.round)latest.set(vote.userId,vote);
  const decisions=[...latest.values()];
  const viewerVote=viewerId?latest.get(viewerId):undefined;
  const economy=reviewEconomy(c.policy),rewardSlots=Math.min(economy.rewardSlots,Math.floor(c.fee/economy.rewardAmount)),rewardCount=Math.min(rewardSlots,decisions.length);
  const selfPass=integer(deposits.filter(d=>d.verdict==='pass').reduce((sum,d)=>sum+d.amount,0)),selfReject=integer(deposits.filter(d=>d.verdict==='reject').reduce((sum,d)=>sum+d.amount,0));
  return {caseId:c.id,messageId:c.messageId,revision:c.revision,status:c.status,fee:c.fee,deposit:c.deposit,
    pass:integer(selfPass+votes.filter(v=>v.verdict==='pass').reduce((s,v)=>s+v.amount,0)),reject:integer(selfReject+votes.filter(v=>v.verdict==='reject').reduce((s,v)=>s+v.amount,0)),selfPass,selfReject,
    reviewerCount:decisions.length,releaseAt:c.releaseAt,finalized:!!c.settlement?.finalized,
    round:c.round,...(viewerVote?{viewerVote:{messageId:viewerVote.messageId,verdict:viewerVote.verdict}}:{}),
    provisional:!!c.settlement&&!c.settlement.finalized,rewardSlots,rewardAmount:economy.rewardAmount,rewardCount,feeRefund:c.fee-rewardCount*economy.rewardAmount,
    passReviewers:decisions.filter(v=>v.verdict==='pass').length,rejectReviewers:decisions.filter(v=>v.verdict==='reject').length};
}
export async function enrollModeration(tx:Mutation,message:Message,allowDebt=false):Promise<ModerationCase|undefined> {
  if(!await hasModerationTables(tx.store))return;
  const policy=await moderationPolicy(tx.store);
  if(!policy.enabled||!requiresModeration(message))return;
  if((await retiredOrganizationIds(tx.store)).has(message.id))return;
  const caseId=id(),createdAt=now();
  const created=await tx.store.db.prepare(`INSERT INTO moderation_cases(id,"messageId",revision,"authorId",snapshot,"ruleVersion",policy,fee,deposit,"createdAt")
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10) ON CONFLICT("messageId",revision) DO NOTHING RETURNING id`)
    .get(caseId,message.id,message.revision,message.authorId,JSON.stringify(message),(await tx.store.rules()).version,JSON.stringify(policy),policy.fee,policy.deposit,createdAt);
  if(!created)return;
  const c=(await moderationCase(tx.store,message.id,message.revision))!;
  await addReviewFunding(tx,c,message,policy.fee,policy.deposit,allowDebt);
  if(!allowDebt){message.spending={...message.spending,reviewFee:policy.fee,reviewDeposit:policy.deposit};await tx.put(message);}
  tx.affected.add(message.id);
  if(c&&c.round!==undefined&&!allowDebt)await refreshCaseAssignments(tx,c);
  return c;
}
function reviewPart(message:Pick<Message,'parts'>){return relations(message as Message).find(p=>p.relation==='review');}
/** Only a stance on the complete decision becomes a review. Reason/body fragments stay ordinary discussion. */
export async function normalizeReviewStance(store:Store,input:SendInput):Promise<SendInput> {
  const stance=input.parts.find(p=>p.type==='relation'&&['agree','disagree'].includes(p.relation));
  if(stance?.type!=='relation'||stance.roles.target?.length!==1)return input;
  const reference=stance.roles.target[0]!.reference;
  if(reference.memberId||reference.range||reference.path?.length)return input;
  const original=await store.message(reference.messageId,reference.revision),review=reviewPart(original);
  if(!review||reference.partId&&reference.partId!==review.id)return input;
  if(input.recommendation||input.selfStance)throw new DomainError('对审核判断的表态只能投入审核押注');
  const originalData=dataOf(original),verdict=originalData.verdict as ReviewVerdict;
  if(!['pass','reject'].includes(verdict)||review.roles.target?.length!==1)throw new DomainError('审核记录无效');
  const chosen=stance.relation==='agree'?verdict:verdict==='pass'?'reject':'pass';
  const parts:Part[]=input.parts.filter(p=>p!==stance&&p.type!=='data');
  parts.push({...stance,relation:'review',roles:{...stance.roles,target:review.roles.target}});
  parts.push({id:'review-data',type:'data',value:{uiType:'REVIEW',verdict:chosen,caseId:originalData.caseId,reviewRound:originalData.reviewRound,convertedFrom:reference.messageId,convertedSide:stance.relation}});
  return {...input,parts,wager:0,recommendation:0,selfStance:undefined,reviewWager:input.reviewWager??input.wager??0};
}
async function selectedCase(store:Store,message:Message,part:Extract<Part,{type:'relation'}>):Promise<ModerationCase> {
  const targets=part.roles.target??[];
  if(targets.length!==1||targets[0]!.reference.partId||targets[0]!.reference.memberId||targets[0]!.reference.range||targets[0]!.reference.path?.length)throw new DomainError('审核需要一个完整消息版本');
  const ref=targets[0]!.reference, c=await moderationCase(store,ref.messageId,ref.revision);
  if(!c)throw new DomainError('目标没有需要审核的内容',404);
  // Pinned historical cases remain settleable; editing never strands an older escrow.
  if(dataOf(message).caseId&&dataOf(message).caseId!==c.id)throw new DomainError('审核版本已变化，请刷新',409);
  return c;
}
async function saveCase(store:Store,c:ModerationCase){await store.db.prepare('UPDATE moderation_cases SET status=$2,"releaseAt"=$3,settlement=$4::jsonb,round=$5,stage=$6,fee=$7,deposit=$8 WHERE id=$1').run(c.id,c.status,c.releaseAt,c.settlement===null?null:JSON.stringify(c.settlement),c.round,c.stage,c.fee,c.deposit);}
function reopenConclusion(c:ModerationCase){
  if(c.status==='rejected')c.status='appeal';
  else c.status='pending';
  c.settlement=null;c.releaseAt=null;
}
async function note(tx:Mutation,c:ModerationCase,source:Message,action:string,value:Record<string,any>){
  const record=await tx.create('system',[{id:'body',type:'text',text:action},{id:'review-record',type:'relation',relation:'review-record',roles:{target:[{id:'target',reference:{messageId:c.messageId,revision:c.revision}}],trigger:[{id:'trigger',reference:{messageId:source.id}}]}},{id:'data',type:'data',value:{uiType:'REVIEW_RECORD',caseId:c.id,...value}}]);
  tx.affected.add(c.messageId);return record;
}
function split(total:number,weights:Array<{userId:string;weight:number}>):Array<{userId:string;amount:number}>{
  const combined=new Map<string,number>();for(const item of weights)combined.set(item.userId,integer((combined.get(item.userId)??0)+item.weight));
  const entries=[...combined].sort(([a],[b])=>a.localeCompare(b)),sum=entries.reduce((n,[,w])=>n+BigInt(w),0n);
  if(!sum)return [];
  let used=0;const payments=entries.map(([userId,w])=>{const amount=Number(BigInt(total)*BigInt(w)/sum);used+=amount;return {userId,amount};});
  for(let i=0;i<total-used;i++)payments[i%payments.length]!.amount++;
  return payments.filter(p=>p.amount);
}
async function reverseSettlement(tx:Mutation,c:ModerationCase,trigger:Message){
  const before=c.settlement;if(!before?.finalized)return;
  const reversible=before.payouts.filter(p=>p.kind!=='fee'&&p.kind!=='fee-refund');
  const record=await note(tx,c,trigger,'审核复核：冲正押注与自押分配，已完成参与报酬保留',{previousSettlementId:before.messageId,payouts:reversible.map(p=>({...p,amount:-p.amount}))});
  for(const p of reversible)await tx.store.ledger(p.userId,record.id,-p.amount,0,`审核${p.kind==='wager'?'押注':'保证金'}冲正`,true);
  if(before.fund){await tx.store.operating(-before.fund,true);await tx.store.set('moderation-fund',integer(await tx.store.setting<number>('moderation-fund')-before.fund));}
  for(const vote of await reviewVotes(tx.store,c.id))if(before.voteIds.includes(vote.messageId))await tx.store.ledger(vote.userId,record.id,0,vote.amount,'恢复审核押注锁定',true);
  for(const deposit of await reviewDeposits(tx.store,c.id))if(deposit.amount)await tx.store.ledger(deposit.payerId,record.id,0,deposit.amount,'恢复审核自押锁定',true);
  c.settlement=null;c.releaseAt=null;
}
export async function processModerationAction(tx:Mutation,message:Message,reviewWager=0):Promise<boolean>{
  const parts=relations(message).filter(p=>REVIEW_RELATIONS.has(p.relation));
  if(!parts.length){if(reviewWager)throw new DomainError('审核押注只能用于审核关系');return false;}
  if(parts.length!==1)throw new DomainError('一条消息只能执行一个审核操作');
  const part=parts[0]!,store=tx.store,data=dataOf(message);
  if(part.relation!=='review'&&reviewWager)throw new DomainError('只有审核意见可以投入审核押注');
  if(part.relation==='reviewer-authorize'){
    throw new DomainError('能阅读对应消息版本的登录用户即可审核，无需固定授权',409);
  }
  const c=await selectedCase(store,message,part),reviewer=await isReviewer(store,message.authorId,c);
  if(data.reviewRound!==undefined&&data.reviewRound!==c.round)throw new DomainError('审核轮次已变化，请重新打开审核入口',409,'REVIEW_ROUND_CHANGED');
  const dataId=message.parts.find(p=>p.type==='data')?.id??['review-data',...Array.from({length:message.parts.length+1},(_,i)=>`review-data-${i}`)].find(candidate=>!message.parts.some(p=>p.id===candidate))!;
  // Canonical metadata must not be overridden by a later user-supplied data part.
  message.parts=message.parts.filter(p=>p.type!=='data');
  message.parts.push({id:dataId,type:'data',value:{...data,uiType:part.relation.toUpperCase(),caseId:c.id,targetRevision:c.revision,
    snapshotHash:createHash('sha256').update(JSON.stringify(c.snapshot)).digest('hex'),reviewRuleVersion:c.ruleVersion,reviewRound:c.round,reviewStage:c.stage}});
  await tx.put(message);
  if(part.relation==='review-appeal'){
    if(c.status==='rejected'&&c.authorId!==message.authorId)throw new DomainError('审核不通过后仅作者可以申请复核',403);
    if(!message.parts.some(p=>p.type==='text'&&p.text.trim()))throw new DomainError('复核需要填写理由');
    if(c.status==='pending'||c.status==='appeal')throw new DomainError('该内容正在审核或复核',409);
    const verdict:ReviewVerdict=c.status==='unknown'?(data.verdict??'pass'):c.status==='approved'?'reject':'pass';
    if(!['pass','reject'].includes(verdict))throw new DomainError('请选择复核自押方向');
    if(data.verdict!==undefined&&data.verdict!==verdict)throw new DomainError('复核自押须支持原结论的相反立场，请刷新审核入口',409);
    const metadata=message.parts.find(p=>p.type==='data')! as Extract<Part,{type:'data'}>;
    metadata.value={...(metadata.value as Record<string,import('@gonglun/core').Json>),verdict,selfStakeVerdict:verdict};
    await reverseSettlement(tx,c,message);
    await payReviewFees(tx,c);
    const economy=reviewEconomy(c.policy);
    c.status='appeal';c.releaseAt=null;c.settlement=null;c.round++;c.stage=0;c.fee=economy.appealFee;c.deposit=integer(c.deposit+economy.appealDeposit);
    await addReviewFunding(tx,c,message,economy.appealFee,economy.appealDeposit,false,verdict);
    message.spending.reviewFee=economy.appealFee;message.spending.reviewDeposit=economy.appealDeposit;await tx.put(message);
    await saveCase(store,c);await note(tx,c,message,'已发起审核复核，重新随机分配审核任务和受限正文临时阅读权限',{status:c.status,round:c.round});await refreshCaseAssignments(tx,c);return true;
  }
  await assertMessageReadable(store,c.messageId,message.authorId,c.revision);
  if(part.relation==='review'){
    if(!reviewWindowOpen(c))throw new DomainError('本轮审核或反驳窗口已结束，请先完成结算或申请复核',409);
    const minimum=reviewEconomy(c.policy).minWager;
    if(!['pass','reject'].includes(data.verdict)||!Number.isSafeInteger(reviewWager)||reviewWager<minimum)throw new DomainError(`请选择通过或不通过，审核押注至少 ${minimum} 点`);
    await store.ledger(message.authorId,message.id,-reviewWager,reviewWager,'审核押注冻结');
    await store.db.prepare('INSERT INTO moderation_votes("messageId","caseId","userId",verdict,amount,"createdAt",round) VALUES($1,$2,$3,$4,$5,$6,$7)').run(message.id,c.id,message.authorId,data.verdict,reviewWager,message.createdAt,c.round);
    await store.db.prepare('UPDATE moderation_assignments SET "submittedAt"=COALESCE("submittedAt",$4) WHERE "caseId"=$1 AND round=$2 AND "userId"=$3').run(c.id,c.round,message.authorId,now());
    message.spending.reviewWager=reviewWager;await tx.put(message);
    tx.affected.add(c.messageId);
    if(c.settlement){
      const summary=summarizeReview(c,await reviewVotes(store,c.id),await reviewDeposits(store,c.id));
      if(reviewResult(summary)!==c.settlement.verdict){
        reopenConclusion(c);await saveCase(store,c);
        await note(tx,c,message,'累计押注改变审核结果，等待重新结算',{status:c.status});
      }
    }
    return true;
  }
  if(c.authorId===message.authorId)throw new DomainError('作者不能结算自己的内容',403);
  if(!reviewer)throw new DomainError('仅本轮审核参与者或有效任务接收者可以结算',403,'REVIEW_NOT_PARTICIPATED');
  const votes=await reviewVotes(store,c.id),deposits=await reviewDeposits(store,c.id),summary=summarizeReview(c,votes,deposits);
  if(part.relation==='review-settle'){
    if(c.settlement)throw new DomainError('本轮已结算；需要改变结论时请发起复核',409);
    if(summary.pass+summary.reject===0)throw new DomainError('暂无审核押注，无法结算');
    const verdict=reviewResult(summary);
    c.status=verdict==='pass'?'approved':verdict==='reject'?'rejected':'unknown';c.releaseAt=now();
    c.settlement={verdict,payouts:[],fund:0,finalized:false,voteIds:votes.map(v=>v.messageId),messageId:message.id};
    await saveCase(store,c);await note(tx,c,message,verdict==='pass'?'审核通过，允许传播':verdict==='reject'?'审核不通过，限制传播':'审核平局，结论未定，退还押注本金',{verdict,pass:summary.pass,reject:summary.reject,releaseAt:c.releaseAt});
  }
  // New settlements pay atomically. The legacy finalize action can also release
  // an already-pending settlement immediately, regardless of its old deadline.
  if(part.relation==='review-finalize'||part.relation==='review-settle'){
    const settlement=c.settlement;
    if(!settlement||settlement.finalized||!c.releaseAt)throw new DomainError('没有待划转的审核资金',409);
    if(reviewResult(summary)!==settlement.verdict)throw new DomainError('累计押注已改变审核结果，请重新结算',409);
    const winners=votes.filter(v=>settlement.verdict==='unknown'||v.verdict===settlement.verdict),weights=[...winners.map(v=>({userId:v.userId,weight:v.amount})),
      ...deposits.filter(d=>d.amount>0&&(settlement.verdict==='unknown'||d.verdict===settlement.verdict)).map(d=>({userId:d.payerId,weight:d.amount}))];
    const payouts:ReviewPayment[]=[...split(integer(summary.pass+summary.reject),weights).map(p=>({...p,kind:'wager' as const})),
      ...await payReviewFees(tx,c)];
    const fund=0;
    const record=await note(tx,c,message,'审核资金划转',{verdict:settlement.verdict,payouts,fund,fee:c.fee,deposit:c.deposit});
    for(const v of votes)await store.ledger(v.userId,record.id,0,-v.amount,'审核押注解除锁定',true);
    for(const d of deposits)if(d.amount)await store.ledger(d.payerId,record.id,0,-d.amount,'审核自押解除锁定',true);
    for(const p of payouts)if(p.kind==='wager'&&p.amount)await store.ledger(p.userId,record.id,p.amount,0,'审核押注结算',true);
    c.releaseAt=now();c.settlement={...settlement,payouts,fund,finalized:true,voteIds:votes.map(v=>v.messageId),messageId:record.id};await saveCase(store,c);return true;
  }
  return false;
}
