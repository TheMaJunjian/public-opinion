import { AsyncLocalStorage } from 'node:async_hooks';
import { RESTRICTED_CONTENT_PLACEHOLDER, REVIEW_RECORD_RELATIONS, requiresModeration, type Message, type MessageView, type ModerationSummary, type Part, type ReviewContext, type UserView } from '@gonglun/core';
import { DomainError, type Store } from './db.js';
import { moderationPolicy, summarizeReview, type ModerationCase } from './moderation.js';
import { hasModerationTables } from './moderation-schema.js';
import { rebindLegacyReviewFragments } from './legacy-review-fragments.js';
import type { ReviewDeposit } from './review-finances.js';
import { publicReviewDecisions } from './review-decision-views.js';

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
// Migration-time projections also read schemas that predate the appealFrom column.
const restrictedCaseSql=(alias:string)=>`(${alias}.status='rejected' OR (${alias}.status='appeal'
  AND COALESCE(to_jsonb(${alias})->>'appealFrom','reject')='reject'))`;
export const restrictedCurrentCasesSql=`SELECT "messageId" FROM (
  SELECT DISTINCT ON ("messageId") "messageId",${restrictedCaseSql('c')} AS restricted
  FROM moderation_cases c ORDER BY "messageId",revision DESC
) latest WHERE restricted`;
const unreadableCase=(alias:string,viewer:string)=>`(${restrictedCaseSql(alias)}
  AND (${viewer}::text IS NULL OR ${alias}."authorId"<>${viewer}))`;
const referenceDependencies=`WITH RECURSIVE inputs AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(key text,id text,revision integer)
  ), dependencies(root,id,revision) AS (
    SELECT i.key,i.id,COALESCE(i.revision,(m.body::jsonb->>'revision')::integer) FROM inputs i JOIN messages m ON m.id=i.id
    UNION ${dependencyStep}
  )`;
/** Used before text matching, so search cannot probe the contents of restricted records. */
export async function moderationReadSql(store:Store,alias:string,userId=moderationViewer(),source:'message'|'case'='message'):Promise<string>{
  if(!/^[a-z_]+$/.test(alias))throw new Error('无效的查询别名');
  if(!await hasModerationTables(store)||!(await moderationPolicy(store)).enabled)return 'TRUE';
  const viewer=userId?`'${userId.replaceAll("'","''")}'`:'NULL';
  const messageId=source==='case'?`${alias}."messageId"`:`${alias}.id`;
  const revision=source==='case'?`${alias}.revision`:`(${alias}.body::jsonb->>'revision')::integer`;
  return `NOT EXISTS(WITH RECURSIVE dependencies(root,id,revision) AS (SELECT ${messageId},${messageId},${revision} UNION ${dependencyStep})
    SELECT 1 FROM dependencies d ${restrictedCase} WHERE ${unreadableCase('c',viewer)} OR ${unreadableCase('historical',viewer)})`;
}
export async function inaccessibleMessages(store:Store,ids:string[],userId=moderationViewer()):Promise<Set<string>> {
  const blocked=await inaccessibleReferences(store,ids.map(id=>({id})),userId);
  return new Set(ids.filter(id=>blocked.has(referenceKey(id))));
}
export async function inaccessibleReferences(store:Store,refs:Array<{id:string;revision?:number}>,userId?:string):Promise<Set<string>>{
  if(!refs.length||!await hasModerationTables(store)||!(await moderationPolicy(store)).enabled)return new Set();
  const rows=await store.db.prepare(`${referenceDependencies} SELECT DISTINCT d.root FROM dependencies d ${restrictedCase}
    WHERE ${unreadableCase('c','$2')} OR ${unreadableCase('historical','$2')}`)
    .all<{root:string}>(JSON.stringify(refs.map(r=>({...r,key:referenceKey(r.id,r.revision)}))),userId??null);
  return new Set(rows.map(r=>r.root));
}

/** Return exactly the case addresses responsible for each mask, including a later
 * rejected revision when it also restricts the historical revision being read. */
async function restrictedReviewCases(store:Store,refs:Map<string,{id:string;revision?:number}>,userId?:string){
  const result=new Map<string,ReviewContext[]>();
  if(!refs.size)return result;
  const rows=await store.db.prepare(`${referenceDependencies}
    SELECT DISTINCT d.root,d.id AS "messageId",hit.revision,d.id=i.id AS direct,
      d.id=i.id AND hit.revision=COALESCE(i.revision,0) AS pinned
    FROM dependencies d JOIN inputs i ON i.key=d.root ${restrictedCase}
    CROSS JOIN LATERAL (VALUES (c.revision,${unreadableCase('c','$2')}),
      (historical.revision,${unreadableCase('historical','$2')})) AS hit(revision,hidden)
    WHERE hit.hidden ORDER BY d.root,direct DESC,pinned DESC,"messageId",hit.revision DESC`)
    .all<ReviewContext&{root:string}>(JSON.stringify([...refs].map(([key,ref])=>({key,...ref}))),userId??null);
  for(const {root,messageId,revision} of rows){
    const targets=result.get(root);
    if(targets)targets.push({messageId,revision});
    else result.set(root,[{messageId,revision}]);
  }
  return result;
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
    ) SELECT 1 FROM dependencies d ${restrictedCase} WHERE ${restrictedCaseSql('c')} OR ${restrictedCaseSql('historical')} LIMIT 1`).get(ref.messageId,ref.revision??null);
    if(rejected)throw new DomainError('审核不通过的消息不能作为来源或目标，请从审核入口申请复核',409,'REJECTED_REFERENCE');
    await assertMessageReadable(store,ref.messageId,userId,ref.revision);
  }
}
export async function affectModerationDependents(store:Store,affected:Set<string>){
  if(!affected.size||!await hasModerationTables(store)||!(await moderationPolicy(store)).enabled)return;
  const rows=await store.db.prepare(`WITH RECURSIVE dependents(id) AS (SELECT unnest($1::text[]) UNION SELECT r."sourceId" FROM dependents d JOIN moderation_dependencies r ON r."targetId"=d.id) SELECT id FROM dependents`).all<{id:string}>([...affected]);
  for(const row of rows)affected.add(row.id);
}
// These two relations only place a message in a discussion or next to a vote.
// A fragment or reading context is a content dependency, even on a legacy marker.
function isDiscussionAddress(part:Part):boolean {
  if(part.type!=='relation'||!['review-context','review-reason'].includes(part.relation)
      ||Object.keys(part.roles).length!==1||part.roles.target?.length!==1)return false;
  const ref=part.roles.target[0]!.reference;
  return !!ref.revision && Object.keys(ref).every(key=>['messageId','revision','context'].includes(key))
    && (!ref.context || ref.context.kind==='MESSAGE' && Object.keys(ref.context).length===1);
}
export async function indexModerationDependencies(store:Store,message:Message){
  if(!await hasModerationTables(store))return;
  await store.db.prepare('DELETE FROM moderation_dependencies WHERE "sourceId"=$1 AND "sourceRevision"=$2').run(message.id,message.revision);
  const [resolved]=await rebindLegacyReviewFragments(store,[message]);
  const targets=resolved!.parts.filter(p=>!isDiscussionAddress(p)).flatMap(p=>p.type==='relation'?Object.entries(p.roles).filter(([role])=>!['parent','members','member'].includes(role))
    .flatMap(([,bindings])=>bindings.map(b=>b.reference)):p.type==='display'&&p.target?[p.target]:[])
    .flatMap(ref=>[ref,...(ref.context&&'version' in ref.context?ref.context.version?.corrections??[]:[])]).filter(r=>r.messageId!==message.id);
  if(targets.length)await store.db.prepare('INSERT INTO moderation_dependencies("sourceId","sourceRevision","targetId","targetRevision") SELECT $1,$2,r.id,r.revision FROM jsonb_to_recordset($3::jsonb) AS r(id text,revision integer) ON CONFLICT DO NOTHING')
    .run(message.id,message.revision,JSON.stringify(targets.map(r=>({id:r.messageId,revision:r.revision??0}))));
  // Old signed decisions contain a second copy of their reason. If that text
  // is subsequently hidden, history, search and receipts must hide it too.
  if(message.parts.some(p=>p.type==='relation'&&['review','review-appeal'].includes(p.relation))
      &&(await store.db.prepare("SELECT to_regclass('legacy_review_reason_versions') AS present").get())?.present)
    await store.db.prepare(`INSERT INTO moderation_dependencies("sourceId","sourceRevision","targetId","targetRevision")
      SELECT h."decisionId",h."decisionRevision",dest.id,dest.revision FROM legacy_review_reason_versions h
      CROSS JOIN LATERAL (VALUES(h."reasonId",h."reasonRevision"),(to_jsonb(h)->>'citationId',1)) dest(id,revision)
      WHERE h."decisionId"=$1 AND h."decisionRevision"=$2 AND dest.id IS NOT NULL ON CONFLICT DO NOTHING`).run(message.id,message.revision);
}
const identityKeys=new Set(['id','messageId','targetMessageId','sourceMessageId','sourceId','targetId','entityId','relationMessageId','relationId']);
const safeKeys=new Set(['id','messageId','targetMessageId','sourceMessageId','entityId','relationMessageId','revision','sequence','createdAt','updatedAt','authorId','userId','caseId','status','fee','deposit','pass','reject','selfPass','selfReject','reviewerCount','releaseAt','finalized','amount','lockedDelta','ruleVersion','messageRevision','balanceAfter','position','reason','spending','regionId','ledgerId','programVersion','round','passReviewers','rejectReviewers','provisional','rewardSlots','rewardAmount','rewardCount','feeRefund']);
/** Only the author's fixed choice can be shown when its target is restricted. */
function ownStance(message:Message,userId:string):'agree'|'disagree'|undefined {
  if(message.authorId!==userId||message.authorId==='system')return;
  const actions=message.parts.filter(part=>part.type==='relation');
  if(actions.length!==1)return;
  const action=actions[0]!;
  if((action.relation==='agree'||action.relation==='disagree')&&Object.keys(action.roles).length===1
    &&action.roles.target?.length===1&&action.roles.target[0]!.reference.messageId!==message.id
    &&!message.parts.some(part=>part.type==='display')&&!requiresModeration(message))return action.relation;
}
/** Structure-only and cached views may omit parts. Derive the whole card from
 * the saved revision, never from its caller-provided label, payload or author. */
export async function ownRestrictedStanceCards(store:Store,versions:{id:string;revision:number}[],userId?:string){
  const cards=new Map<string,MessageView>();
  if(!userId||!versions.length)return cards;
  const rows=await store.db.prepare(`SELECT r.body,
    jsonb_build_object('id',u.id,'username',u.name,'createdAt',COALESCE(u."createdAt",'')) AS author
    FROM jsonb_to_recordset($1::jsonb) wanted(id text,revision integer)
    JOIN messages m ON m.id=wanted.id AND m."authorId"=$2 JOIN users u ON u.id=m."authorId"
    JOIN revisions r ON r."messageId"=wanted.id AND r.revision=wanted.revision
    WHERE NOT EXISTS(SELECT 1 FROM moderation_cases c WHERE c."messageId"=wanted.id AND c.revision=wanted.revision)`)
    .all<{body:string;author:UserView}>(JSON.stringify(versions),userId);
  for(const row of rows){
    const m=JSON.parse(row.body) as Message,stance=ownStance(m,userId);
    if(!stance)continue;
    const card={
      id:m.id,revision:m.revision,sequence:m.sequence,createdAt:m.createdAt,updatedAt:m.updatedAt,
      authorId:m.authorId,regionId:m.regionId,ledgerId:m.ledgerId,programVersion:m.programVersion,ruleVersion:m.ruleVersion,spending:m.spending,
      createdBy:row.author,kind:'TEXT',contentType:'TEXT' as const,content:'',parts:[{id:'restricted-body',type:'text' as const,text:''}],
      relationType:null,targetRefs:[],payload:{},relationPayload:{},restricted:true,restrictedStance:stance,
    };
    cards.set(referenceKey(m.id,m.revision),card);
  }
  return cards;
}
/** The final HTTP boundary also covers raw history, signatures and nested command receipts. */
export async function sanitizeModeration<T>(store:Store,value:T,userId=moderationViewer()):Promise<T>{
  if(!await hasModerationTables(store)||!(await moderationPolicy(store)).enabled)return value;
  const ids=new Set<string>();
  const refs=new Map<string,{id:string;revision?:number}>();
  const messageVersions=new Map<string,{id:string;revision:number}>();
  const decisionVersions=new Map<string,{id:string;revision:number}>();
  const collected=new WeakSet<object>();
  const collect=(item:any)=>{
    if(!item||typeof item!=='object'||collected.has(item))return;
    collected.add(item);
    if(Array.isArray(item)){item.forEach(collect);return;}
    const version=metadataRevision(item.revision);
    if(userId&&version&&typeof item.id==='string'&&Array.isArray(item.parts))
      messageVersions.set(referenceKey(item.id,version),{id:item.id,revision:version});
    if(version&&typeof item.id==='string'&&Array.isArray(item.parts)
        &&item.parts.some((part:any)=>part?.type==='relation'&&['review','review-appeal'].includes(part.relation)))
      decisionVersions.set(referenceKey(item.id,version),{id:item.id,revision:version});
    for(const [key,val] of Object.entries(item)){
      if(identityKeys.has(key)&&typeof val==='string'){
        ids.add(val);const revision=identityRevision(item,key);
        refs.set(referenceKey(val,revision),{id:val,revision});
      }
      collect(val);
    }
  };
  collect(value);
  for(const id of ids)refs.set(referenceKey(id),{id});
  const blockingCases=await restrictedReviewCases(store,refs,userId);
  const blockedReference=(id:string,revision?:number)=>blockingCases.has(referenceKey(id,revision));
  const caseSubjects=new Set(ids);
  for(const targets of blockingCases.values())for(const target of targets)caseSubjects.add(target.messageId);
  const cases=caseSubjects.size?await store.db.prepare('SELECT * FROM moderation_cases WHERE "messageId"=ANY($1::text[]) ORDER BY "messageId",revision DESC').all<ModerationCase>([...caseSubjects]):[];
  const summaries=new Map<string,ModerationSummary>();
  const versions=new Map<string,ModerationSummary>();
  const stanceCards=await ownRestrictedStanceCards(store,[...messageVersions.values()].filter(ref=>blockedReference(ref.id,ref.revision)),userId);
  const decisions=await publicReviewDecisions(store,[...decisionVersions.values()].filter(ref=>blockedReference(ref.id,ref.revision)));
  if(cases.length){
    const votes=await store.db.prepare('SELECT * FROM moderation_votes WHERE "caseId"=ANY($1::text[]) ORDER BY position').all<any>(cases.map(c=>c.id));
    const deposits=await store.db.prepare('SELECT * FROM moderation_deposits WHERE "caseId"=ANY($1::text[])').all<ReviewDeposit>(cases.map(c=>c.id));
    for(const c of cases){const summary=summarizeReview(c,votes.filter(v=>v.caseId===c.id),deposits.filter(d=>d.caseId===c.id),userId);versions.set(referenceKey(c.messageId,c.revision),summary);if(!summaries.has(c.messageId))summaries.set(c.messageId,summary);}
  }
  // Snapshots share message/relation records. Keep those identities through
  // filtering so compact transport can send each sanitized record only once.
  const sanitized=new WeakMap<object,unknown>();
  const walk=(item:any):any=>{
    if(!item||typeof item!=='object')return item;
    if(sanitized.has(item))return sanitized.get(item);
    const clean=walkObject(item);sanitized.set(item,clean);return clean;
  };
  const walkObject=(item:any):any=>{
    if(!item||typeof item!=='object')return item;
    if(Array.isArray(item))return item.map(walk);
    const notification=typeof item.sourceId==='string'&&typeof item.actorId==='string'&&Array.isArray(item.references);
    const targetId=['message','text-fragment'].includes(item.kind)?item.messageId:item.kind==='relation'?item.relationId:undefined;
    const targetRevision=metadataRevision(item.reference?.revision);
    const restricted=Object.entries(item).some(([k,v])=>identityKeys.has(k)&&typeof v==='string'&&blockedReference(v,identityRevision(item,k)))
      ||typeof targetId==='string'&&blockedReference(targetId,targetRevision)
      ||notification&&[...item.references,item.excerptReference,item.targetExcerptReference].some(ref=>ref&&typeof ref.messageId==='string'&&blockedReference(ref.messageId,metadataRevision(ref.revision)));
    if(restricted){
      // A public category may still name a hidden member. Keep a whole-message
      // address, never its quoted text, part selection or reading context, even
      // when only the pinned historical revision is hidden.
      if(typeof targetId==='string'){
        return {kind:'message',messageId:targetId,restricted:true,reference:{messageId:targetId,...(targetRevision?{revision:targetRevision}:{})}};
      }
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
          reviewRound:item.reviewRound}:{}),
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
        const decision=decisions.get(referenceKey(item.id,item.revision));
        if(decision)return decision;
        const restrictedReviewTargets=blockingCases.get(referenceKey(item.id,metadataRevision(item.revision)));
        const relatedSummaries=restrictedReviewTargets?.filter(target=>target.messageId!==item.id||target.revision!==item.revision)
          .map(target=>versions.get(referenceKey(target.messageId,target.revision))).filter(Boolean);
        const sourceReviews={restrictedReviewTargets,...(relatedSummaries?.length?{restrictedReviewSummaries:relatedSummaries}:{})};
        const stanceCard=stanceCards.get(referenceKey(item.id,item.revision));
        if(stanceCard)return {...stanceCard,...sourceReviews};
        const summary=versions.get(referenceKey(item.id,item.revision))??summaries.get(item.id),content=RESTRICTED_CONTENT_PLACEHOLDER;
        // Retain only the review attachment identity, so private audit records do not become overview cards.
        const review=item.parts.find((p:any)=>p.type==='relation'&&REVIEW_RECORD_RELATIONS.has(p.relation));
        const targets=review?.roles?.target?.map((binding:any,index:number)=>({id:`target-${index}`,reference:{messageId:binding.reference.messageId,...(binding.reference.revision?{revision:binding.reference.revision}:{})}}))??[];
        const placement=item.parts.filter((p:any)=>p?.type==='relation'&&['review-context','review-reason'].includes(p.relation)).flatMap((p:any)=>{
          const ref=p.roles?.target?.[0]?.reference;
          return typeof ref?.messageId==='string'&&metadataRevision(ref.revision)
            ?[{id:p.relation,type:'relation',relation:p.relation,roles:{target:[{id:'target',reference:{messageId:ref.messageId,revision:ref.revision}}]}}]:[];
        });
        const parts=[{id:'restricted-body',type:'text',text:content},...(review?[{id:'review-attachment',type:'relation',relation:review.relation,roles:{target:targets}}]:[]),
          ...placement];
        return {...clean,kind:review?'RELATION':'TEXT',contentType:'TEXT',content,parts,createdBy:item.createdBy,relationType:review?(review.relation==='review-record'?'REVIEW_RECORD':review.relation.toUpperCase()):null,payload:{},relationPayload:{},
          targetRefs:targets.map((binding:any)=>({kind:'message',messageId:binding.reference.messageId,reference:binding.reference})),restricted:true,moderation:summary,...sourceReviews};
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
