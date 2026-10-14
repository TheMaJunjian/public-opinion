import { relations, replaceReference, type Change, type Membership, type Message, type Part, type SendResult, type User } from '@gonglun/core';
import { DomainError, Mutation, now, Store } from './db.js';
import { applyOrganization } from './organizations.js';
import { dataOf, distributeOperations, grant, hasEffect, lockDelegation, markEffect, oneTarget, placeWager, relationTarget, settleDue, terminate } from './economy.js';
import { parseSend, partsSchema, readReference, rulesSchema, validateReferences } from './validation.js';
import { recordPersonal } from './personal-actions.js';

const actions=new Set(['agree','disagree','terminate','authorize','delegate','distribute','credit']);
function authorize(tx:Mutation,message:Message,user:User) {
  if(!user.founder)throw new DomainError('当前版本需要项目发起人授权',403);
  const ref=oneTarget(message,'authorize');
    if(ref.partId||ref.memberId||ref.path?.length||ref.range)throw new DomainError('授权须指向完整提案');
  const proposal=tx.store.message(ref.messageId,ref.revision),key=`authorized:${proposal.id}:${proposal.revision}`;
  if(hasEffect(tx.store,key))throw new DomainError('提案已生效',409);
  const kinds=relations(proposal).filter(r=>['amend','rule-change','recharge'].includes(r.relation));
  if(kinds.length!==1)throw new DomainError('目标不是可授权提案');
  const data=dataOf(proposal);
  if(kinds[0]!.relation==='amend') {
    const target=oneTarget(proposal,'amend');
    const current=tx.store.message(target.messageId);
    if(data.expectedRevision!==current.revision||(target.revision!==undefined&&target.revision!==current.revision))throw new DomainError('目标内容已变更，请重新提交修改',409);
    const replacement=data.parts??data.value;
    if(replacement===undefined)throw new DomainError('缺少修改内容');
    let parts:Part[];
    try {parts=partsSchema.parse(replaceReference(current,target,replacement)) as Part[];}catch(error){throw new DomainError(error instanceof Error?error.message:'修改内容无效');}
    validateReferences(tx.store,parts);
    const updated={...current,parts,revision:current.revision+1,updatedAt:now(),ruleVersion:tx.store.rules().version};
    tx.put(updated);
    // Only organization structure changes are executed when an edit becomes effective.
    // A historical wager, credit, or authorization is never replayed by editing its content.
    reconcileMemberships(tx,current,updated);
  } else if(kinds[0]!.relation==='rule-change') {
    const proposed=data.rules??data;
    if(!proposed||typeof proposed!=='object'||Array.isArray(proposed))throw new DomainError('规则提案内容无效');
    const currentRules=tx.store.rules();
    const proposedWeights=proposed.contributionWeights;
    if(proposedWeights!==undefined&&(!proposedWeights||typeof proposedWeights!=='object'||Array.isArray(proposedWeights)))throw new DomainError('贡献权重规则无效');
    const next=rulesSchema.parse({...currentRules,...proposed,contributionWeights:{...currentRules.contributionWeights,...(proposedWeights??{})},version:currentRules.version+1});
    tx.store.set('rules',next);
    tx.store.db.prepare('INSERT INTO rule_versions VALUES (?,?,?,?)').run(next.version,JSON.stringify(next),message.id,now());
  } else grant(tx,proposal,{messageId:message.id});
  markEffect(tx.store,key,{authorizationId:message.id,at:now()});
}
function reconcileMemberships(tx:Mutation,before:Message,after:Message) {
  const previous=relations(before).filter(p=>['classify','merge','summary','arrange','members','member-of'].includes(p.relation));
  const next=relations(after).filter(p=>['classify','merge','summary','arrange','members','member-of'].includes(p.relation));
  if(JSON.stringify(previous)===JSON.stringify(next))return;
  const ownMembership=tx.store.db.prepare('SELECT * FROM memberships WHERE memberId=?').get(before.id) as unknown as Membership|undefined;
  const oldMembers=tx.store.db.prepare('SELECT * FROM memberships WHERE sourceId=?').all(before.id) as unknown as Membership[];
  for(const row of oldMembers) {
    const memberOfOwned=previous.some(part=>part.relation==='member-of'&&part.id===row.sourcePartId);
    if(row.parentId!==before.id&&row.memberId!==before.id&&!memberOfOwned)continue;
    const memberId=row.memberId;
    // Editing an organization's member list releases old children into its containing
    // organization before regrouping. The organization itself keeps its placement.
    if(memberId===before.id&&row.bindingId==='inherited-parent')continue;
    tx.store.db.prepare('DELETE FROM memberships WHERE memberId=?').run(memberId);tx.removed.add(memberId);tx.memberships.delete(memberId);
    if(row.parentId===before.id&&ownMembership) {
      const released:Membership={memberId,parentId:ownMembership.parentId,sourceId:after.id,sourcePartId:row.sourcePartId,bindingId:row.bindingId,sourceRevision:after.revision};
      tx.store.db.prepare('INSERT INTO memberships VALUES (?,?,?,?,?,?)').run(memberId,released.parentId,released.sourceId,released.sourcePartId??null,released.bindingId??null,released.sourceRevision??null);
      tx.memberships.set(memberId,released);tx.removed.delete(memberId);
    }
  }
  applyOrganization(tx,after);
}
export function send(store:Store,user:User,raw:unknown):SendResult {
  const input=parseSend(raw),serialized=JSON.stringify(input);
  return store.transaction(()=>{
    const previous=store.db.prepare('SELECT input,result FROM requests WHERE userId=? AND requestId=?').get(user.id,input.requestId) as {input:string;result:string}|undefined;
    if(previous){if(previous.input!==serialized)throw new DomainError('相同请求编号不能用于不同内容',409);return JSON.parse(previous.result) as SendResult;}
    validateReferences(store,input.parts);
    const actionParts=input.parts.filter(p=>p.type==='relation'&&actions.has(p.relation));
    if(actionParts.length>1)throw new DomainError('一条消息只能执行一个资金或授权操作');
    const wager=input.wager??0,recommendation=input.recommendation??0;
    if(wager>0&&!actionParts.some(p=>p.type==='relation'&&['agree','disagree'].includes(p.relation)))throw new DomainError('押注须选择赞同或反对');
    const tx=new Mutation(store);
    // Finish elapsed rounds before accepting an incoming wager at the new cutoff.
    settleDue(tx);
    const protocol=store.rules().protocolFee;
    const message=tx.create(user.id,input.parts,{protocol,recommendation,wager});
    store.ledger(user.id,message.id,-protocol,0,'协议费');store.operating(protocol,true);
    if(recommendation){store.ledger(user.id,message.id,-recommendation,0,'推荐投入');store.operating(recommendation,true);}
    applyOrganization(tx,message);
    for(const part of relations(message)) {
      if(part.relation==='agree'||part.relation==='disagree')placeWager(tx,message,wager);
      if(part.relation==='terminate')terminate(tx,message);
      if(part.relation==='delegate')lockDelegation(tx,message);
      if(part.relation==='fulfill') {
        const ref=relationTarget(part);
        if(!store.db.prepare('SELECT 1 FROM escrows WHERE messageId=?').get(ref.messageId))throw new DomainError('目标不是委托');
      }
      if(part.relation==='low-quality'||part.relation==='amend'){const ref=relationTarget(part);readReference(store,ref);}
      if(part.relation==='authorize')authorize(tx,message,user);
      if(part.relation==='distribute')distributeOperations(tx,message);
      if(part.relation==='credit'){if(!user.founder)throw new DomainError('仅项目发起人可以公开发放',403);grant(tx,message,undefined);}
    }
    const change=tx.commit();
    recordPersonal(store,message);
    const result:SendResult={message:store.message(message.id),change,account:store.account(user.id)};
    store.db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(user.id,input.requestId,serialized,JSON.stringify(result));
    return result;
  });
}
export function processDue(store:Store):Change|null {
  return store.transaction(()=>{const tx=new Mutation(store);if(!settleDue(tx))return null;return tx.commit();});
}
