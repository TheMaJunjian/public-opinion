import {writeFile} from 'node:fs/promises';
import {replayArchive,type Message} from '@gonglun/core';
import {Store} from '../../server/src/db.js';
import {financialFingerprint} from './financial-fingerprint.js';
import {validateRetirementJournal} from './validate-retirement-journal.js';
import {settlementTargetRepairPlan} from './restore-settlement-targets.js';
import {valueVoteMessageRepairPlan} from './repair-value-vote-messages.js';
import {annotationStanceMessageRepairPlan} from './repair-annotation-stance-messages.js';
import {minimumContributionCandidates} from './backfill-minimum-contributions.js';
import {dependentMembershipRemovalPlan} from './remove-dependent-memberships.js';
import {delegationBodyRepairPlan} from './delegation-body-plan.js';
import {targetInvestmentPlan} from './target-investments.js';
import {retainedTargetInvestmentPlan} from './retained-target-investments.js';
import {legacyAnnotationInvestmentPlan} from './legacy-annotation-investments.js';
import {readingMessageRemovalPlan} from './remove-reading-messages.js';
import {containerReadingCleanupPlan} from './cleanup-container-reading-marks.js';

const stable=(value:unknown)=>JSON.stringify(value,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)
  ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
if(!process.env.DATABASE_URL)throw new Error('请配置 DATABASE_URL');
const report=await Store.inspect(process.env.DATABASE_URL,{schema:process.env.DATABASE_SCHEMA},async store=>{
  const changes=(await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)));
  validateRetirementJournal({format:'gonglun-2',changes});
  const replay=replayArchive({format:'gonglun-2',changes});
  const messages=(await store.db.prepare('SELECT body FROM messages ORDER BY id').all()).map(row=>JSON.parse(String(row.body)) as Message);
  const projected=new Map(replay.messages.map(message=>[message.id,message]));
  if(messages.length!==projected.size||messages.some(message=>stable(message)!==stable(projected.get(message.id))))throw new Error('消息与执行记录重放结果不一致');
  const accounts=await store.db.prepare('SELECT * FROM accounts ORDER BY "userId"').all();
  if(accounts.length!==replay.accounts.size||accounts.some(({userId,...account})=>stable(account)!==stable(replay.accounts.get(String(userId)))))throw new Error('账户与账本重放结果不一致');
  const memberships=await store.db.prepare('SELECT "memberId","parentId","sourceId","sourcePartId","bindingId","sourceRevision" FROM memberships ORDER BY "memberId"').all();
  const dependentMemberships=await dependentMembershipRemovalPlan(store);
  if(dependentMemberships.joinIds.length||dependentMemberships.releasedMemberships.length)throw new Error('仍有附属消息的旧加入记录需要迁移');
  const membership=(row:any)=>[row.memberId,row.parentId,row.sourceId,row.sourcePartId??null,row.bindingId??null,row.sourceRevision??null];
  const actualMemberships=new Map(memberships.map(row=>[String(row.memberId),stable(membership(row))]));
  if(actualMemberships.size!==replay.memberships.length||replay.memberships.some(row=>actualMemberships.get(row.memberId)!==stable(membership(row))))throw new Error('组织归属与执行记录重放结果不一致');
  const indexed=new Map<string,Set<string>>();
  for(const row of await store.db.prepare('SELECT * FROM refs').all()){
    const targets=indexed.get(String(row.sourceId))??new Set<string>();targets.add(String(row.targetId));indexed.set(String(row.sourceId),targets);
  }
  for(const message of messages){
    const targets=new Set(message.parts.flatMap(part=>part.type==='relation'?Object.values(part.roles).flat().map(binding=>binding.reference.messageId)
      :part.type==='display'&&part.target?[part.target.messageId]:[]));
    if(stable([...targets].sort())!==stable([...(indexed.get(message.id)??[])].sort()))throw new Error(`引用索引不一致：${message.id}`);
    if(message.parts.some(part=>part.type==='relation'&&(['unfollow','unblock','legacy-join'].includes(part.relation)
      ||['follow','block'].includes(part.relation)&&!['YES','NO'].includes(part.reason??''))))throw new Error(`仍存在旧格式消息：${message.id}`);
  }
  const settlementTargets=await settlementTargetRepairPlan(store.db);
  if(settlementTargets.pending||settlementTargets.unresolved)throw new Error(`仍有 ${settlementTargets.pending+settlementTargets.unresolved} 条旧结算消息缺少原始目标引用`);
  const valueVoteMessages=await valueVoteMessageRepairPlan(store.db);
  if(valueVoteMessages.pending||valueVoteMessages.unresolved)throw new Error(`仍有 ${valueVoteMessages.pending+valueVoteMessages.unresolved} 条历史价值投票消息需要转换`);
  const annotationStanceMessages=await annotationStanceMessageRepairPlan(store.db);
  const minimumContributions=(await minimumContributionCandidates(store.db)).length;
  if(minimumContributions)throw new Error(`仍有 ${minimumContributions} 条用户消息未投入真假或价值`);
  if(annotationStanceMessages.pending||annotationStanceMessages.unresolved)throw new Error(`仍有 ${annotationStanceMessages.pending+annotationStanceMessages.unresolved} 条历史标注表态需要转换`);
  const delegationBodies=await delegationBodyRepairPlan(store.db);
  if(delegationBodies.pending)throw new Error(`仍有 ${delegationBodies.pending} 条历史委托消息需要恢复正文`);
  const targetInvestments=await targetInvestmentPlan(store);
  if(targetInvestments.pending)throw new Error(`仍有 ${targetInvestments.pending} 条历史关系投入需要迁移`);
  const retainedTargetInvestments=await retainedTargetInvestmentPlan(store);
  if(retainedTargetInvestments.pending)throw new Error(`仍有 ${retainedTargetInvestments.pending} 条已确认的历史最低投入需要修复`);
  const legacyAnnotationInvestments=await legacyAnnotationInvestmentPlan(store);
  if(legacyAnnotationInvestments.pending)throw new Error(`仍有 ${legacyAnnotationInvestments.pending} 条原始标注赞同投入需要修复`);
  const readingMessages=await readingMessageRemovalPlan(store);
  if(readingMessages.readingMessages||readingMessages.blocked.length)throw new Error('仍有公开已读未读消息需要删除退款');
  const containerReadingMarks=await containerReadingCleanupPlan(store);
  if(containerReadingMarks.pending)throw new Error('仍有可确认的冗余容器阅读记录需要清理');
  return {verified:true,messages:messages.length,accounts:accounts.length,memberships:memberships.length,changes:changes.length,sequence:replay.sequence,
    settlementTargets,valueVoteMessages,annotationStanceMessages,delegationBodies,targetInvestments,retainedTargetInvestments,legacyAnnotationInvestments,readingMessages,containerReadingMarks,
    financialFingerprint:await financialFingerprint(store.db),replayMessagesMatch:true,replayAccountsMatch:true,replayMembershipsMatch:true,referenceIndexesMatch:true};
});
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report));
