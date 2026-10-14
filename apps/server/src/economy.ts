import { bindRoles, referenceKey, relations, resolveStance, textOf, type Allocation, type Distribution, type Json, type Message, type Reference, type RelationPart, type Round } from '@gonglun/core';
import { DomainError, id, integer, Mutation, now, Store } from './db.js';
import { recordStance } from './projections.js';

type Bet={id:string;roundId:string;targetKey:string;userId:string;messageId:string;side:'pro'|'con';amount:number};
type SavedRound=Round&{targetKey:string;payouts:Allocation[];betIds:string[];createdAt:string;settlementType?:'TRUTH'|'VALUE';subjectId?:string};
type QualityEffect={userId:string;messageId:string;amount:number;active:boolean};
type Escrow={messageId:string;ownerId:string;amount:number;recipientId:string|null;fulfillmentId:string|null};
export function dataOf(message:Message):Record<string,Json> {
  const value=message.parts.find(p=>p.type==='data');
  return value?.type==='data'&&value.value&&typeof value.value==='object'&&!Array.isArray(value.value)?value.value:{};
}
export function oneTarget(message:Message,name:string,role='target'):Reference {
  const relation=relations(message).find(r=>r.relation===name);
  if(!relation)throw new DomainError(`${name} 关系不存在`);
  return relationTarget(relation,role);
}
export function relationTarget(relation:RelationPart,role='target'):Reference {
  if(relation.roles[role]?.length!==1) throw new DomainError(`${relation.relation} 必须指定唯一 ${role}`);
  return relation.roles[role]![0]!.reference;
}
export function distribution(tx:Mutation,target:Reference|undefined,value:Omit<Distribution,'ledgerId'|'programVersion'>):Message {
  integer(value.total);
  const labels:Record<Distribution['source'],string>={wager:'对赌分配',operations:'运营收入分配',delegation:'委托报酬',penalty:'低质量处罚',reversal:'分配调整',grant:'贡献点发放'};
  const recipients=value.allocations.map(a=>`${tx.store.user(a.userId).name} ${a.amount>0?'+':''}${a.amount}`).join('，');
  return tx.create('system',[
    {id:'body',type:'text',text:`${labels[value.source]}：${value.total} 贡献点${recipients?`；${recipients}`:''}。`},
    {id:'distribution',type:'relation',relation:'distribution',roles:bindRoles(target?{target:[target]}:{})},
    {id:'allocation',type:'data',value:{...value,ledgerId:'local',programVersion:'2.0.0'} as unknown as Json},
  ]);
}
const getEffect=<T>(store:Store,key:string):T|undefined=>{
  const row=store.db.prepare('SELECT body FROM effects WHERE key=?').get(key); return row?JSON.parse(row.body as string) as T:undefined;
};
export function markEffect(store:Store,key:string,value:unknown){store.db.prepare('INSERT INTO effects VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key,JSON.stringify(value));}
export function hasEffect(store:Store,key:string){return !!store.db.prepare('SELECT 1 FROM effects WHERE key=?').get(key);}
function savedRounds(store:Store,key:string):SavedRound[]{return store.db.prepare('SELECT body FROM rounds WHERE targetKey=? ORDER BY createdAt,rowid').all(key).map(r=>JSON.parse(r.body as string) as SavedRound);}
function saveRound(store:Store,round:SavedRound){store.db.prepare('INSERT INTO rounds VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(round.id,round.targetKey,JSON.stringify(round),round.createdAt);}
function newRound(tx:Mutation,selected:{key:string;target:Reference;revision:number},trigger:Message,previous?:SavedRound):SavedRound {
  const evaluated=tx.store.message(selected.target.messageId,selected.target.revision),valueRelation=relations(evaluated).find(part=>part.relation==='open-value-settlement'),subjectId=valueRelation?.roles.target?.[0]?.reference.messageId;
  const declaration=tx.create('system',[
    {id:'body',type:'text',text:`发起结算：${textOf(evaluated).slice(0,160)||'所选消息部件'}。发起人：${tx.store.user(trigger.authorId).name}。`},
    {id:'settlement',type:'relation',relation:'settlement',roles:bindRoles({target:[selected.target],trigger:[{messageId:trigger.id}]})},
    {id:'basis',type:'data',value:{openedBy:trigger.authorId,triggerId:trigger.id,previousRoundId:previous?.id??null,settlementType:subjectId?'VALUE':'TRUTH',subjectId:subjectId??selected.target.messageId}},
  ]);
  return {id:declaration.id,target:selected.target,targetRevision:selected.revision,status:'open',pro:previous?.pro??0,con:previous?.con??0,result:null,previousRoundId:previous?.id??null,distributionId:null,endsAt:null,targetKey:selected.key,payouts:[],betIds:[],createdAt:now(),settlementType:subjectId?'VALUE':'TRUTH',subjectId:subjectId??selected.target.messageId};
}
export function openSettlement(tx:Mutation,message:Message) {
  const valueRelation=relations(message).find(part=>part.relation==='open-value-settlement');
  const selected=targetKey(tx.store,valueRelation?{messageId:message.id,partId:valueRelation.id}:oneTarget(message,'open-settlement'));
  const history=savedRounds(tx.store,selected.key);
  if(history.some(round=>round.status!=='settled'))throw new DomainError('目标已有进行中的结算',409);
  saveRound(tx.store,newRound(tx,selected,message,history.at(-1)));
}
function targetKey(store:Store,target:Reference):{key:string;target:Reference;revision:number} {
  const revision=store.message(target.messageId,target.revision).revision;
  const pinned={...target,revision}; return {key:referenceKey(pinned),target:pinned,revision};
}
export function roundsFor(store:Store,messageId:string):Round[] {
  return store.db.prepare('SELECT body FROM rounds WHERE json_extract(body,\'$.target.messageId\')=? ORDER BY createdAt DESC LIMIT 100').all(messageId).map(r=>{
    const {targetKey:_key,payouts:_payouts,betIds:_ids,createdAt:_at,...round}=JSON.parse(r.body as string) as SavedRound; return round;
  });
}
/** Interpret an existing stance using the content and direction it actually executed. */
function executionResolver(store:Store,messageId:string,revision?:number):Message {
  const message=store.message(messageId,revision);
  const executed=store.db.prepare('SELECT partId,target,side FROM execution_stances WHERE sourceId=? AND revision=?').all(message.id,message.revision);
  if(executed.length===0)return message;
  return {...message,parts:message.parts.map(part=>{
    const basis=executed.find(row=>row.partId===part.id);
    if(!basis||part.type!=='relation')return part;
    return {...part,relation:basis.side==='pro'?'agree':'disagree',roles:{...part.roles,target:[{id:part.roles.target?.[0]?.id??'target',reference:JSON.parse(basis.target as string) as Reference}]}};
  })};
}
export function placeWager(tx:Mutation,message:Message,amount:number) {
  const stance=relations(message).filter(r=>r.relation==='agree'||r.relation==='disagree');
  if(stance.length!==1||stance[0]!.roles.target?.length!==1) throw new DomainError('押注必须对应一项明确的赞同或反对');
  const resolved=resolveStance(stance[0]!.roles.target![0]!.reference,stance[0]!.relation==='agree'?'pro':'con',(mid,rev)=>executionResolver(tx.store,mid,rev));
  const selected=targetKey(tx.store,resolved.target);
  tx.store.db.prepare('INSERT INTO execution_stances VALUES (?,?,?,?,?)').run(message.id,message.revision,stance[0]!.id,JSON.stringify(selected.target),resolved.side);
  tx.affected.add(recordStance(tx.store,message,{target:selected.target,side:resolved.side}));
  const history=savedRounds(tx.store,selected.key);
  let round=history.find(r=>r.status!=='settled');
  if(round?.status==='waiting'&&Date.parse(round.endsAt!)<=Date.now()) throw new DomainError('结算截止，请刷新后参与下一轮',409);
  if(!round) {
    const previous=history.at(-1);
    round=newRound(tx,selected,message,previous);
  }
  round[resolved.side]=integer(round[resolved.side]+amount);
  if(amount>0) {
    tx.store.ledger(message.authorId,message.id,-amount,amount,'对赌锁定');
    const betId=id();
    tx.store.db.prepare('INSERT INTO bets VALUES (?,?,?,?,?,?,?)').run(betId,round.id,selected.key,message.authorId,message.id,resolved.side,amount);
  }
  saveRound(tx.store,round);
}
function allocate(total:number,weights:Array<{userId:string;weight:number;messageId:string}>,reason:string):Allocation[] {
  if(total<=0||weights.length===0)return [];
  const weightSum=weights.reduce((sum,w)=>sum+BigInt(w.weight),0n);
  if(weightSum===0n)return [];
  const allocations=weights.map(w=>({userId:w.userId,amount:Number(BigInt(total)*BigInt(w.weight)/weightSum),reason,messageIds:[w.messageId]}));
  let remaining=total-allocations.reduce((sum,a)=>sum+a.amount,0);
  // Stable largest-remainder allocation; message identity breaks ties deterministically.
  const order=weights.map((w,i)=>({i,remainder:BigInt(total)*BigInt(w.weight)%weightSum,id:w.messageId})).sort((a,b)=>a.remainder===b.remainder?a.id.localeCompare(b.id):a.remainder>b.remainder?-1:1);
  for(const item of order) {if(!remaining)break;allocations[item.i]!.amount++;remaining--;}
  return allocations.filter(a=>a.amount>0);
}
export function terminate(tx:Mutation,message:Message) {
  const targets=relations(message).find(part=>part.relation==='terminate')?.roles.target?.map(binding=>binding.reference)??[];
  if(!targets.length)throw new DomainError('终止结算必须指定目标');
  const seen=new Set<string>();
  for(const target of targets) {
  const selected=targetKey(tx.store,target);
  if(seen.has(selected.key))continue;seen.add(selected.key);
  const round=savedRounds(tx.store,selected.key).find(r=>r.status!=='settled');
  if(!round) throw new DomainError('目标没有进行中的结算');
  const requested=dataOf(message).roundId;
  if(requested!==undefined&&requested!==round.id)throw new DomainError('终止目标与轮次不一致',409);
  if(round.status==='waiting') continue;
  const delay=tx.store.rules().settlementDelayMs;
  if(delay>0) {round.status='waiting';round.endsAt=new Date(Date.now()+delay).toISOString();saveRound(tx.store,round);}
  else settle(tx,round,message.id);
  }
}
export function settleDue(tx:Mutation):number {
  const rounds=tx.store.db.prepare('SELECT body FROM rounds WHERE json_extract(body,\'$.status\')=\'waiting\' AND json_extract(body,\'$.endsAt\')<=?').all(now());
  for(const row of rounds) {const round=JSON.parse(row.body as string) as SavedRound;settle(tx,round,round.target.messageId);}
  return rounds.length;
}
function settle(tx:Mutation,round:SavedRound,triggerId:string) {
  const store=tx.store;
  if(round.status==='settled')return;
  const bets=store.db.prepare('SELECT * FROM bets WHERE targetKey=? ORDER BY rowid').all(round.targetKey) as unknown as Bet[];
  if(round.previousRoundId) {
    const previous=savedRounds(store,round.targetKey).find(r=>r.id===round.previousRoundId)!;
    const reverse=distribution(tx,round.target,{source:'reversal',total:-previous.payouts.reduce((s,a)=>s+a.amount,0),ruleVersion:store.rules().version,inputs:{roundId:previous.id,distributionId:previous.distributionId},allocations:previous.payouts.map(a=>({...a,amount:-a.amount,reason:'后续结算撤回先前分配'}))});
    for(const allocation of previous.payouts)store.ledger(allocation.userId,reverse.id,-allocation.amount,0,'撤回先前对赌分配',true);
    const previousIds=new Set(previous.betIds);
    for(const bet of bets)if(previousIds.has(bet.id))store.ledger(bet.userId,reverse.id,0,bet.amount,'恢复先前对赌本金',true);
  }
  const pro=integer(bets.filter(b=>b.side==='pro').reduce((s,b)=>integer(s+b.amount),0));
  const con=integer(bets.filter(b=>b.side==='con').reduce((s,b)=>integer(s+b.amount),0));
  const result=pro===con?'tie':pro>con?'pro':'con';
  const winners=result==='tie'?bets:bets.filter(b=>b.side===result);
  const payouts=allocate(integer(pro+con),winners.map(b=>({userId:b.userId,weight:b.amount,messageId:b.messageId})),result==='tie'?'平局退还本金':pro===0||con===0?'单边胜出退还本金':'胜方按出资比例分配');
  const output=distribution(tx,round.target,{source:'wager',total:integer(pro+con),ruleVersion:store.rules().version,inputs:{roundId:round.id,previousRoundId:round.previousRoundId,triggerId,pro,con,result,betIds:bets.map(b=>b.id)},allocations:payouts});
  for(const bet of bets) store.ledger(bet.userId,output.id,0,-bet.amount,'结束对赌锁定',true);
  for(const allocation of payouts)store.ledger(allocation.userId,output.id,allocation.amount,0,allocation.reason,true);
  Object.assign(round,{pro,con,result,status:'settled',endsAt:now(),distributionId:output.id,payouts,betIds:bets.map(b=>b.id)});
  saveRound(store,round);
  applyResultEffects(tx,round,output.id);
}
function applyResultEffects(tx:Mutation,round:SavedRound,distributionId:string) {
  // An assertion about a reason fragment is not a verdict on the full quality/completion claim.
  if(round.target.memberId||round.target.path?.length||round.target.range)return;
  const evaluated=tx.store.message(round.target.messageId,round.targetRevision);
  const evaluatedRelations=relations(evaluated).filter(part=>!round.target.partId||part.id===round.target.partId);
  for(const lowQuality of evaluatedRelations.filter(r=>r.relation==='low-quality'||r.relation==='open-value-settlement')) {
    const target=relationTarget(lowQuality);
    const original=tx.store.message(target.messageId,target.revision);
    const settlementInitiator=relations(original).some(part=>part.relation==='settlement')?dataOf(original).openedBy:undefined;
    const responsibleUser=original.authorId==='system'&&typeof settlementInitiator==='string'?settlementInitiator:original.authorId;
    if(responsibleUser==='system')continue;
    const key=`quality:${evaluated.id}:${lowQuality.id}`;
    const before=getEffect<QualityEffect>(tx.store,key);
    const active=round.result===(lowQuality.relation==='open-value-settlement'?'con':'pro');
    if(active&&!before?.active) {
      const amount=tx.store.rules().lowQualityPenalty;
      const output=distribution(tx,target,{source:'penalty',total:amount,ruleVersion:tx.store.rules().version,inputs:{evaluationId:evaluated.id,distributionId},allocations:[{userId:responsibleUser,amount:-amount,reason:'低质量评价成立',messageIds:[original.id,evaluated.id]}]});
      tx.store.ledger(responsibleUser,output.id,-amount,0,'低质量处罚',true);tx.store.operating(amount,true);
      markEffect(tx.store,key,{userId:responsibleUser,messageId:original.id,amount,active:true});
    } else if(!active&&before?.active) {
      const output=distribution(tx,target,{source:'reversal',total:before.amount,ruleVersion:tx.store.rules().version,inputs:{evaluationId:evaluated.id,distributionId},allocations:[{userId:before.userId,amount:before.amount,reason:'低质量评价平反',messageIds:[original.id,evaluated.id]}]});
      tx.store.operating(-before.amount,true);tx.store.ledger(before.userId,output.id,before.amount,0,'低质量处罚平反',true);
      markEffect(tx.store,key,{...before,active:false});
    }
  }
  for(const fulfillment of evaluatedRelations.filter(r=>r.relation==='fulfill')) {
    const task=relationTarget(fulfillment);
    const fulfillmentKey=`${evaluated.id}:${fulfillment.id}`;
    const escrow=tx.store.db.prepare('SELECT * FROM escrows WHERE messageId=?').get(task.messageId) as Escrow|undefined;
    if(!escrow)throw new DomainError('委托资金不存在');
    if(round.result==='pro'&&!escrow.recipientId) {
      const output=distribution(tx,task,{source:'delegation',total:escrow.amount,ruleVersion:tx.store.rules().version,inputs:{fulfillmentId:evaluated.id,fulfillmentPartId:fulfillment.id,distributionId},allocations:[{userId:evaluated.authorId,amount:escrow.amount,reason:'委托完成报酬',messageIds:[task.messageId,evaluated.id]}]});
      tx.store.ledger(escrow.ownerId,output.id,0,-escrow.amount,'委托报酬支付',true);
      tx.store.ledger(evaluated.authorId,output.id,escrow.amount,0,'委托完成报酬',true);
      tx.store.db.prepare('UPDATE escrows SET recipientId=?,fulfillmentId=? WHERE messageId=?').run(evaluated.authorId,fulfillmentKey,task.messageId);
    } else if(round.result!=='pro'&&escrow.fulfillmentId===fulfillmentKey&&escrow.recipientId) {
      const output=distribution(tx,task,{source:'reversal',total:-escrow.amount,ruleVersion:tx.store.rules().version,inputs:{fulfillmentId:evaluated.id,distributionId},allocations:[{userId:escrow.recipientId,amount:-escrow.amount,reason:'撤回委托完成认定',messageIds:[task.messageId,evaluated.id]}]});
      tx.store.ledger(escrow.recipientId,output.id,-escrow.amount,0,'追回委托报酬',true);
      tx.store.ledger(escrow.ownerId,output.id,0,escrow.amount,'恢复委托锁定报酬',true);
      tx.store.db.prepare('UPDATE escrows SET recipientId=NULL,fulfillmentId=NULL WHERE messageId=?').run(task.messageId);
    }
  }
}
export function lockDelegation(tx:Mutation,message:Message) {
  const reward=dataOf(message).reward;
  if(typeof reward!=='number'||!Number.isSafeInteger(reward)||reward<=0)throw new DomainError('委托报酬须为正整数');
  tx.store.ledger(message.authorId,message.id,-reward,reward,'委托报酬锁定');
  tx.store.db.prepare('INSERT INTO escrows VALUES (?,?,?,NULL,NULL)').run(message.id,message.authorId,reward);
}
export function distributeOperations(tx:Mutation,message:Message) {
  const rules=tx.store.rules();
  const available=Math.max(0,tx.store.setting<number>('operating')-rules.operatingReserve);
  const requested=dataOf(message).amount;
  const total=requested===undefined?available:requested;
  if(typeof total!=='number'||!Number.isSafeInteger(total)||total<0||total>available)throw new DomainError('分配金额超过可用运营收入');
  const previous=getEffect<{sequence:number}>(tx.store,'operations:last');
  const contributions=tx.store.db.prepare('SELECT body FROM messages WHERE authorId<>\'system\' AND id<>? ORDER BY createdAt,id').all(message.id).map(r=>JSON.parse(r.body as string) as Message);
  const qualityEffects=tx.store.db.prepare("SELECT body FROM effects WHERE key LIKE 'quality:%'").all().map(row=>JSON.parse(row.body as string) as QualityEffect);
  const excluded=new Set(qualityEffects.filter(e=>e.active).map(e=>e.messageId));
  const byId=new Map(contributions.map(m=>[m.id,m]));
  const latestStances=new Map<string,{targetId:string;side:'pro'|'con'}>();
  const executedStances=tx.store.db.prepare('SELECT * FROM display_stances WHERE wholeComponent=1 ORDER BY sequence,sourceId').all();
  for(const executed of executedStances) {
    const sourceId=String(executed.sourceId),targetId=String(executed.targetId),authorId=String(executed.authorId),target=byId.get(targetId);
    if(excluded.has(sourceId)||!target||target.revision!==executed.targetRevision||target.authorId===authorId)continue;
    latestStances.set(`${targetId}:${authorId}`,{targetId,side:executed.side as 'pro'|'con'});
  }
  const recognition=new Map<string,number>();
  for(const stance of latestStances.values())if(stance.side==='pro')recognition.set(stance.targetId,(recognition.get(stance.targetId)??0)+1);
  const parents=new Map(tx.store.db.prepare('SELECT memberId,parentId FROM memberships').all().map(row=>[String(row.memberId),String(row.parentId)]));
  const scopePositions=new Map<string,number>(),firstContent=new Map<string,string>(),unrecognizedTotals=new Map<string,number>();
  const passive=new Set(['follow','unfollow','block','unblock','read','unread','notify','terminate','authorize','credit','recharge','distribute','distribution']);
  const attribution=contributions.filter(m=>!excluded.has(m.id)).map(m=>{
    const rel=relations(m);
    const recognized=recognition.get(m.id)??0;
    const normalized=textOf(m).normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
    const referenceTarget=rel.flatMap(p=>p.roles.target??[]).find(b=>parents.has(b.reference.messageId))?.reference.messageId;
    const scope=parents.get(m.id)??(referenceTarget?parents.get(referenceTarget):undefined)??'root';
    const contentKey=`${scope}:${normalized}`,duplicateOf=normalized?firstContent.get(contentKey):undefined;
    if(normalized&&!duplicateOf)firstContent.set(contentKey,m.id);
    const passiveOnly=!normalized&&rel.length>0&&rel.every(r=>passive.has(r.relation)||r.relation==='member-of');
    const base=passiveOnly?0:rel.some(r=>r.relation==='evidence')&&recognized>0?rules.contributionWeights.evidence:normalized?rules.contributionWeights.content:rel.some(r=>['agree','disagree'].includes(r.relation))?rules.contributionWeights.agreement:rules.contributionWeights.relation;
    const position=(scopePositions.get(scope)??0)+(base>0?1:0);scopePositions.set(scope,position);
    const earlyBonus=base>0&&position<=rules.contributionWeights.earlyWindow?rules.contributionWeights.earlyBonus:0;
    const rawWeight=integer(duplicateOf&&recognized===0?rules.contributionWeights.duplicate:base+earlyBonus+recognized);
    const capKey=`${scope}:${m.authorId}`,used=unrecognizedTotals.get(capKey)??0;
    const weight=recognized>0?rawWeight:Math.min(rawWeight,Math.max(0,rules.contributionWeights.unrecognizedAuthorCap-used));
    if(recognized===0)unrecognizedTotals.set(capKey,integer(used+weight));
    const reasons=[`基础 ${base}`,`早期 ${duplicateOf&&recognized===0?0:earlyBonus}`,`他人认可 ${recognized}`];
    if(duplicateOf)reasons.push(`重复来源 ${duplicateOf}${recognized===0?'，按重复权重':'，已有他人认可'}`);
    if(weight<rawWeight)reasons.push('同作者同讨论未获认可贡献达到上限');
    return {userId:m.authorId,weight,messageId:m.id,scope,position,base,earlyBonus,recognized,duplicateOf:duplicateOf??null,rawWeight,reason:reasons.join('；')};
  });
  const weights=attribution.filter(w=>w.weight>0);
  const byContribution=new Map(attribution.map(item=>[item.messageId,item]));
  const allocations=allocate(total,weights,'按消息贡献权重分配').map(allocation=>({...allocation,reason:byContribution.get(allocation.messageIds[0]!)?.reason??allocation.reason}));
  const distributed=allocations.reduce((sum,a)=>sum+a.amount,0);
  const output=distribution(tx,{messageId:message.id},{source:'operations',total:distributed,ruleVersion:rules.version,inputs:{available,requested:total,previousDistributionSequence:previous?.sequence??0,toSequence:tx.store.latestSequence(),parameters:rules.contributionWeights,attribution:attribution as unknown as Json,recognition:Object.fromEntries(recognition),excludedMessageIds:[...excluded]},allocations});
  tx.store.operating(-distributed);
  for(const allocation of allocations)tx.store.ledger(allocation.userId,output.id,allocation.amount,0,allocation.reason,true);
  if(distributed>0)markEffect(tx.store,'operations:last',{sequence:tx.store.latestSequence()});
}
export function grant(tx:Mutation,proposal:Message,target:Reference|undefined) {
  const data=dataOf(proposal),amount=data.amount,userId=data.userId??data.recipientId??proposal.authorId;
  if(typeof amount!=='number'||!Number.isSafeInteger(amount)||amount<=0||typeof userId!=='string')throw new DomainError('发放金额和接收者无效');
  tx.store.user(userId);
  const share=data.revenuePoolShare??0;
  if(typeof share!=='number'||!Number.isSafeInteger(share)||share<0||share>amount)throw new DomainError('运营分账数量无效');
  const credited=amount-share;
  const output=distribution(tx,target??{messageId:proposal.id},{source:'grant',total:amount,ruleVersion:tx.store.rules().version,inputs:{proposalId:proposal.id,revenuePoolShare:share,creditedAmount:credited},allocations:[{userId,amount:credited,reason:'公开发放贡献点',messageIds:[proposal.id]}]});
  tx.store.ledger(userId,output.id,credited,0,'公开发放贡献点',true);
  if(share)tx.store.operating(share);
  tx.store.set('minted',integer(tx.store.setting<number>('minted')+amount));
}
export function injectRevenue(tx:Mutation,proposal:Message) {
  const data=dataOf(proposal),amount=data.amount;
  if(typeof amount!=='number'||!Number.isSafeInteger(amount)||amount<=0||typeof data.source!=='string'||!data.source.trim())throw new DomainError('收入数量和来源无效');
  distribution(tx,{messageId:proposal.id},{source:'grant',total:amount,ruleVersion:tx.store.rules().version,inputs:{proposalId:proposal.id,operatingIncome:true,source:data.source},allocations:[]});
  tx.store.operating(amount);tx.store.set('minted',integer(tx.store.setting<number>('minted')+amount));
}
