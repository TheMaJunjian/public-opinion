import { AsyncLocalStorage } from 'node:async_hooks';
import { RESTRICTED_CONTENT_PLACEHOLDER, REVIEW_RECORD_RELATIONS, type Message } from '@gonglun/core';
import { DomainError, type Store } from './db.js';
import { moderationPolicy, summarizeReview, type ModerationCase } from './moderation.js';
import { assignmentValidSql } from './review-assignments.js';
import { hasModerationTables } from './moderation-schema.js';
import type { ReviewDeposit } from './review-finances.js';

const viewers=new AsyncLocalStorage<{userId?:string}>();
export const withModerationViewer=<T>(userId:string|undefined,run:()=>T):T=>viewers.run({userId},run);
export const moderationViewer=()=>viewers.getStore()?.userId;
const referenceKey=(id:string,revision?:number)=>JSON.stringify([id,revision??0]);
const metadataRevision=(value:unknown):number|undefined=>typeof value==='number'&&Number.isInteger(value)&&value>0&&value<=2147483647?value:undefined;
const identityRevision=(item:any,key:string)=>metadataRevision(key==='sourceId'?item.sourceRevision??item.revision:key==='messageId'?item.messageRevision??item.revision:item.revision);
const safeCounts=(value:any,keys:string[])=>Object.fromEntries(keys.map(key=>[key,Number.isSafeInteger(value?.[key])&&value[key]>=0?value[key]:0]));
const dependencyStep=`SELECT d.root,r."targetId",COALESCE(NULLIF(r."targetRevision",0),(m.body::jsonb->>'revision')::integer)
  FROM dependencies d JOIN moderation_dependencies r ON r."sourceId"=d.id AND r."sourceRevision"=d.revision JOIN messages m ON m.id=r."targetId"`;
const restrictedCase=`JOIN LATERAL (SELECT * FROM moderation_cases WHERE "messageId"=d.id ORDER BY revision DESC LIMIT 1) c ON TRUE
  LEFT JOIN moderation_cases historical ON historical."messageId"=d.id AND historical.revision=d.revision`;
const needsReview=(alias:string)=>`(${alias}.status='appeal' OR ${alias}.status='rejected')`;
const finalRejection=(alias:string)=>`(${alias}.status='rejected' AND COALESCE(${alias}.settlement->>'finalized','true')='true')`;
const unapproved=`(${needsReview('c')} OR ${needsReview('historical')})`;
const assignedReviewer=(viewer:string,ignoreAssignments=false)=>`(NOT EXISTS(SELECT 1 FROM disabled_accounts disabled WHERE disabled."userId"=${viewer}) AND (
  EXISTS(SELECT 1 FROM moderation_votes v WHERE v."caseId"=COALESCE(historical.id,c.id) AND v.round=COALESCE(historical.round,c.round) AND v."userId"=${viewer})
  OR ${ignoreAssignments?'FALSE':`EXISTS(SELECT 1 FROM moderation_assignments a WHERE a."caseId"=COALESCE(historical.id,c.id)
  AND a.round=COALESCE(historical.round,c.round) AND a."userId"=${viewer}
  AND ${assignmentValidSql('a',`'${new Date().toISOString()}'`)})`}))`;
/** Used before text matching, so search cannot probe the contents of restricted records. */
export async function moderationReadSql(store:Store,alias:string,userId=moderationViewer()):Promise<string>{
  if(!/^[a-z_]+$/.test(alias))throw new Error('无效的查询别名');
  if(!await hasModerationTables(store)||!(await moderationPolicy(store)).enabled)return 'TRUE';
  const viewer=userId?`'${userId.replaceAll("'","''")}'`:'NULL';
  return `NOT EXISTS(WITH RECURSIVE dependencies(root,id,revision) AS (SELECT ${alias}.id,${alias}.id,(${alias}.body::jsonb->>'revision')::integer UNION ${dependencyStep})
    SELECT 1 FROM dependencies d ${restrictedCase} WHERE (${finalRejection('c')} OR ${finalRejection('historical')} OR ${unapproved} AND NOT ${assignedReviewer(viewer)}) AND (${viewer}::text IS NULL OR c."authorId"<>${viewer}))`;
}
export async function inaccessibleMessages(store:Store,ids:string[],userId=moderationViewer()):Promise<Set<string>> {
  const blocked=await inaccessibleReferences(store,ids.map(id=>({id})),userId);
  return new Set(ids.filter(id=>blocked.has(referenceKey(id))));
}
export async function inaccessibleReferences(store:Store,refs:Array<{id:string;revision?:number}>,userId?:string,ignoreAssignments=false):Promise<Set<string>>{
  if(!refs.length||!await hasModerationTables(store)||!(await moderationPolicy(store)).enabled)return new Set();
  const rows=await store.db.prepare(`WITH RECURSIVE dependencies(root,id,revision) AS (
    SELECT i.key,i.id,COALESCE(i.revision,(m.body::jsonb->>'revision')::integer) FROM jsonb_to_recordset($1::jsonb) AS i(key text,id text,revision integer) JOIN messages m ON m.id=i.id
    UNION ${dependencyStep}
  ) SELECT DISTINCT d.root FROM dependencies d ${restrictedCase} WHERE (${finalRejection('c')} OR ${finalRejection('historical')} OR ${unapproved} AND NOT ${assignedReviewer('$2',ignoreAssignments)}) AND ($2::text IS NULL OR c."authorId"<>$2)`)
    .all<{root:string}>(JSON.stringify(refs.map(r=>({...r,key:referenceKey(r.id,r.revision)}))),userId??null);
  return new Set(rows.map(r=>r.root));
}
export async function assertMessageReadable(store:Store,messageId:string,userId?:string,revision?:number){
  if((await inaccessibleReferences(store,[{id:messageId,revision}],userId)).size)throw new DomainError('该内容尚未获准传播',403,'CONTENT_RESTRICTED');
}
/** Rejected originals cannot be reused by anybody, including their author. */
export async function assertReferenceAllowed(store:Store,reference:import('@gonglun/core').Reference,userId?:string){
  if(!await hasModerationTables(store)||!(await moderationPolicy(store)).enabled)return;
  const dependencies=[reference,...(reference.context&&'version' in reference.context?reference.context.version?.corrections??[]:[])];
  for(const ref of dependencies){
    const rejected=await store.db.prepare(`WITH RECURSIVE dependencies(root,id,revision) AS (
      SELECT m.id,m.id,COALESCE($2::integer,(m.body::jsonb->>'revision')::integer) FROM messages m WHERE m.id=$1 UNION ${dependencyStep}
    ) SELECT 1 FROM dependencies d ${restrictedCase} WHERE c.status IN ('rejected','appeal') OR historical.status IN ('rejected','appeal') LIMIT 1`).get(ref.messageId,ref.revision??null);
    if(rejected)throw new DomainError('审核不通过的消息不能作为来源或目标，请从审核入口申请复核',409,'REJECTED_REFERENCE');
    await assertMessageReadable(store,ref.messageId,userId,ref.revision);
  }
}
export async function affectModerationDependents(store:Store,affected:Set<string>){
  if(!affected.size||!await hasModerationTables(store)||!(await moderationPolicy(store)).enabled)return;
  const rows=await store.db.prepare(`WITH RECURSIVE dependents(id) AS (SELECT unnest($1::text[]) UNION SELECT r."sourceId" FROM dependents d JOIN moderation_dependencies r ON r."targetId"=d.id) SELECT id FROM dependents`).all<{id:string}>([...affected]);
  for(const row of rows)affected.add(row.id);
}
export async function indexModerationDependencies(store:Store,message:Message){
  if(!await hasModerationTables(store))return;
  await store.db.prepare('DELETE FROM moderation_dependencies WHERE "sourceId"=$1 AND "sourceRevision"=$2').run(message.id,message.revision);
  const targets=message.parts.flatMap(p=>p.type==='relation'?Object.entries(p.roles).filter(([role])=>!['parent','members','member'].includes(role))
    .flatMap(([,bindings])=>bindings.map(b=>b.reference)):p.type==='display'&&p.target?[p.target]:[])
    .flatMap(ref=>[ref,...(ref.context&&'version' in ref.context?ref.context.version?.corrections??[]:[])]).filter(r=>r.messageId!==message.id);
  if(targets.length)await store.db.prepare('INSERT INTO moderation_dependencies("sourceId","sourceRevision","targetId","targetRevision") SELECT $1,$2,r.id,r.revision FROM jsonb_to_recordset($3::jsonb) AS r(id text,revision integer) ON CONFLICT DO NOTHING')
    .run(message.id,message.revision,JSON.stringify(targets.map(r=>({id:r.messageId,revision:r.revision??0}))));
}
const identityKeys=new Set(['id','messageId','targetMessageId','sourceMessageId','sourceId','targetId','entityId','relationMessageId','relationId']);
const safeKeys=new Set(['id','messageId','targetMessageId','sourceMessageId','entityId','relationMessageId','revision','sequence','createdAt','updatedAt','authorId','userId','caseId','status','fee','deposit','pass','reject','selfPass','selfReject','reviewerCount','releaseAt','finalized','amount','lockedDelta','ruleVersion','messageRevision','balanceAfter','position','reason','spending','regionId','ledgerId','programVersion','round','stage','stageSize','stageCount','requiredMajority','passReviewers','rejectReviewers','assignedCount','exposedCount','exposureLimit','provisional','rewardSlots','rewardAmount','rewardCount','feeRefund']);
/** The final HTTP boundary also covers raw history, signatures and nested command receipts. */
export async function sanitizeModeration<T>(store:Store,value:T,userId=moderationViewer()):Promise<T>{
  if(!await hasModerationTables(store)||!(await moderationPolicy(store)).enabled)return value;
  const ids=new Set<string>();
  const refs=new Map<string,{id:string;revision?:number}>();
  const collect=(item:any)=>{if(!item||typeof item!=='object')return;if(Array.isArray(item)){item.forEach(collect);return;}for(const [key,val] of Object.entries(item)){if(identityKeys.has(key)&&typeof val==='string'){ids.add(val);const revision=identityRevision(item,key);refs.set(referenceKey(val,revision),{id:val,revision});}collect(val);}};
  collect(value);
  const blocked=await inaccessibleMessages(store,[...ids],userId);
  const blockedVersions=await inaccessibleReferences(store,[...refs.values()],userId);
  const blockedReference=(id:string,revision?:number)=>revision===undefined?blocked.has(id):blockedVersions.has(referenceKey(id,revision));
  const cases=ids.size?await store.db.prepare('SELECT * FROM moderation_cases WHERE "messageId"=ANY($1::text[]) ORDER BY "messageId",revision DESC').all<ModerationCase>([...ids]):[];
  const summaries=new Map<string,any>();
  const versions=new Map<string,any>();
  if(cases.length){
    const votes=await store.db.prepare('SELECT * FROM moderation_votes WHERE "caseId"=ANY($1::text[]) ORDER BY position').all<any>(cases.map(c=>c.id));
    const deposits=await store.db.prepare('SELECT * FROM moderation_deposits WHERE "caseId"=ANY($1::text[])').all<ReviewDeposit>(cases.map(c=>c.id));
    for(const c of cases){const summary=summarizeReview(c,votes.filter(v=>v.caseId===c.id),deposits.filter(d=>d.caseId===c.id),userId);versions.set(referenceKey(c.messageId,c.revision),summary);if(!summaries.has(c.messageId))summaries.set(c.messageId,summary);}
  }
  const walk=(item:any):any=>{
    if(!item||typeof item!=='object')return item;
    if(Array.isArray(item))return item.map(walk);
    const notification=typeof item.sourceId==='string'&&typeof item.actorId==='string'&&Array.isArray(item.references);
    const restricted=Object.entries(item).some(([k,v])=>identityKeys.has(k)&&typeof v==='string'&&blockedReference(v,identityRevision(item,k)))
      ||notification&&[...item.references,item.excerptReference,item.targetExcerptReference].some(ref=>ref&&typeof ref.messageId==='string'&&blockedReference(ref.messageId,metadataRevision(ref.revision)));
    if(restricted){
      const clean=Object.fromEntries(Object.entries(item).filter(([k,v])=>safeKeys.has(k)&&(typeof v!=='object'||v===null||k==='spending')));
      // Preserve the statistics contract while hiding individual stakes and reference contexts.
      if(Array.isArray(item.stakes)&&item.pool&&item.counts)return {...clean,restricted:true,stakes:[],contexts:{},
        pool:safeCounts(item.pool,['lockedPro','lockedCon']),counts:safeCounts(item.counts,['pro','con']),
        pools:Object.fromEntries(['TRUTH','VALUE','DELEGATION'].filter(key=>item.pools?.[key]).map(key=>[key,safeCounts(item.pools[key],['lockedPro','lockedCon'])])),
        countsByType:Object.fromEntries(['TRUTH','VALUE'].map(key=>[key,safeCounts(item.countsByType?.[key],['pro','con'])]))};
      if(notification)return {...clean,sourceId:item.sourceId,targetId:item.targetId,actorId:item.actorId,actorName:item.actorName,
        category:item.category,kind:item.kind,groupKey:item.groupKey,seenAt:item.seenAt,muted:item.muted,sourceRevision:item.sourceRevision,
        action:item.category==='review'?item.action:'相关内容暂未公开',excerpt:'',targetExcerpt:'',references:[],reasons:[],watchedIds:[],restricted:true,
        ...(item.category==='review'&&item.reviewTarget?{reviewTarget:item.reviewTarget,navigationId:item.reviewTarget.messageId,targetMessageType:item.targetMessageType,
          reviewRound:item.reviewRound,reviewTaskStatus:item.reviewTaskStatus,reviewTaskExpiresAt:item.reviewTaskExpiresAt}:{}),
        ...(typeof item.availableDelta==='number'?{availableDelta:item.availableDelta}:{}),...(typeof item.lockedDelta==='number'?{lockedDelta:item.lockedDelta}:{})};
      if(typeof clean.reason==='string')clean.reason='受限内容相关记录';
      if(typeof item.amount==='number'&&typeof item.lockedDelta==='number'){
        if(['审核自押冻结','审核自押解除锁定','恢复审核自押锁定'].includes(item.reason))clean.reason=item.reason;
        if(['LOCK','UNLOCK','SPEND','TRANSFER','MESSAGE_GROUP'].includes(item.type))clean.type=item.type;
        if(['协议费','审核费冻结','审核保证金冻结','审核押注冻结','审核押注解除锁定','审核费支付','审核保证金解锁','审核保证金扣减','审核押注结算','审核报酬','审核保证金退还','审核押注冲正','审核报酬冲正','审核保证金冲正','恢复审核押注锁定','恢复审核费锁定','恢复审核保证金锁定'].includes(item.reason))clean.reason=item.reason;
        if(item.type==='MESSAGE_GROUP'&&Array.isArray(item.entries)){
          // Grouped ledger entries retain only their economic fields and source
          // identities. Restricted excerpts and arbitrary nested data stay out.
          const fields=new Set(['id','type','messageId','messageRevision','createdAt','amount','lockedDelta','balanceAfter','reason']);
          const entries=item.entries.filter((entry:any)=>entry?.messageId===item.messageId).map((entry:any)=>walk(
            Object.fromEntries(Object.entries(entry).filter(([key,value])=>fields.has(key)&&(typeof value==='string'||typeof value==='number')))));
          clean.entries=entries;clean.entryCount=entries.length;
        }
      }
      if(Array.isArray(item.parts)){
        const summary=versions.get(referenceKey(item.id,item.revision))??summaries.get(item.id),content=RESTRICTED_CONTENT_PLACEHOLDER;
        // Retain only the review attachment identity, so private audit records do not become overview cards.
        const review=item.parts.find((p:any)=>p.type==='relation'&&REVIEW_RECORD_RELATIONS.has(p.relation));
        const targets=review?.roles?.target?.map((binding:any,index:number)=>({id:`target-${index}`,reference:{messageId:binding.reference.messageId,...(binding.reference.revision?{revision:binding.reference.revision}:{})}}))??[];
        const discussion=item.parts.find((p:any)=>p.type==='relation'&&p.relation==='review-context');
        const discussionTarget=discussion?.roles?.target?.[0]?.reference;
        const parts=[{id:'restricted-body',type:'text',text:content},...(review?[{id:'review-attachment',type:'relation',relation:review.relation,roles:{target:targets}}]:[]),
          ...(discussionTarget?[{id:'review-context',type:'relation',relation:'review-context',roles:{target:[{id:'target',reference:{messageId:discussionTarget.messageId,revision:discussionTarget.revision}}]}}]:[])];
        return {...clean,kind:review?'RELATION':'TEXT',contentType:'TEXT',content,parts,createdBy:item.createdBy,relationType:review?(review.relation==='review-record'?'REVIEW_RECORD':review.relation.toUpperCase()):null,payload:{},relationPayload:{},
          targetRefs:targets.map((binding:any)=>({kind:'message',messageId:binding.reference.messageId,reference:binding.reference})),restricted:true,moderation:summary};
      }
      if('title' in item)clean.title=RESTRICTED_CONTENT_PLACEHOLDER;
      if('quote' in item)clean.quote='';
      if('label' in item)clean.label=RESTRICTED_CONTENT_PLACEHOLDER;
      return {...clean,restricted:true};
    }
    const result=Object.fromEntries(Object.entries(item).map(([k,v])=>[k,walk(v)]));
    // A public message can still have a contribution whose source is awaiting review.
    if(Array.isArray(item.stakes)&&item.pool&&item.counts)result.stakes=result.stakes.filter((stake:any)=>stake.user&&typeof stake.user.id==='string');
    if(notification){
      // Old cached excerpts lack a verifiable content version; retain the notice without its preview.
      if(!item.excerptReference)result.excerpt='';
      if(!item.targetExcerptReference)result.targetExcerpt='';
    }
    if(Array.isArray(result.relations))result.relations=result.relations.filter((r:any)=>r.relationType);
    if(Array.isArray(item.parts)&&summaries.has(item.id))result.moderation=versions.get(referenceKey(item.id,item.revision))??summaries.get(item.id);
    // A signature payload can contain an entire batch, including another private message.
    if(typeof result.signature==='string'&&typeof result.publicKey==='string')delete result.payload;
    return result;
  };
  return walk(value) as T;
}
