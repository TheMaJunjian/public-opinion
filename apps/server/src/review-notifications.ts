import { relations, textOf, RELATION_LABELS, REVIEW_RECORD_RELATIONS, correctionTargetReference, messageCorrectionSummary, type Change, type Message, type NotificationContent, type NotificationItem } from '@gonglun/core';
import type { Store } from './db.js';
import { primaryRelation } from './ui-projections.js';

const dataOf=(message:Message):Record<string,unknown>=>Object.assign({},...message.parts.flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)?[part.value]:[]));
const ids=(value:unknown)=>Array.isArray(value)?value.filter((id):id is string=>typeof id==='string'):[];

function describeTarget(message:Message,correctionTarget?:Message):Pick<NotificationContent,'targetMessageType'|'targetExcerpt'> {
  const relation=primaryRelation(message)?.relation,data=dataOf(message);
  const types:Record<string,string>={operations:'运营',review:'运营',correct:'更正',amend:'更正','rule-change':'提案',
    'code-change':'代码',tag:'标注',recommend:'标注',archive:'标注','low-quality':'标注',follow:'标注',block:'标注'};
  const targetMessageType=relation?types[relation]??RELATION_LABELS[relation]??'消息'
    :message.parts.some(part=>part.type==='code')?'代码':message.parts.some(part=>part.type==='web')?'网页':'文本';
  const title=['classify','summary','merge','arrange'].includes(relation??'')&&typeof data.title==='string'?data.title.trim():'';
  const summary=messageCorrectionSummary(message,correctionTarget)||title||textOf(message)||[data.content,data.customLabel,data.label].find(value=>typeof value==='string'&&value.trim())||'';
  return {targetMessageType,targetExcerpt:String(summary).slice(0,180)};
}

const referenceKey=(reference:{messageId:string;revision?:number})=>JSON.stringify([reference.messageId,reference.revision]);
async function targetRevisions(store:Store,references:Array<{messageId:string;revision?:number}>){
  if(!references.length)return new Map<string,Message>();
  const requested=[...new Map(references.map(reference=>[referenceKey(reference),reference])).values()];
  const rows=await store.db.prepare(`SELECT r.body FROM revisions r JOIN jsonb_to_recordset($1::jsonb)
    AS requested("messageId" text,revision integer) ON r."messageId"=requested."messageId" AND r.revision=requested.revision`)
    .all<{body:string}>(JSON.stringify(requested));
  return new Map(rows.map(row=>{const message=JSON.parse(row.body) as Message;return [referenceKey({messageId:message.id,revision:message.revision}),message];}));
}

/** Refresh cached previews in bounded batches, always using immutable reviewed/corrected revisions. */
export async function describeReviewNotificationTargets(store:Store,items:NotificationItem[]) {
  const references=items.flatMap(item=>item.category==='review'&&item.reviewTarget?[item.reviewTarget]:[]);
  const targets=await targetRevisions(store,references);
  const corrections=await targetRevisions(store,[...targets.values()].flatMap(target=>{const ref=correctionTargetReference(target);return ref?[ref]:[];}));
  for(const item of items)if(item.category==='review'&&item.reviewTarget){
    const reference=item.reviewTarget,target=targets.get(referenceKey(reference)),corrected=target&&correctionTargetReference(target);
    Object.assign(item,target?describeTarget(target,corrected?corrections.get(referenceKey(corrected)):undefined):{targetMessageType:'消息',targetExcerpt:''});
    item.targetExcerptReference=reference;
  }
}

/** Process events notify only the people affected. Migration records are never delivered. */
export async function recordReviewNotifications(store:Store,change:Change){
  for(const message of change.messages){
    const part=relations(message).find(part=>REVIEW_RECORD_RELATIONS.has(part.relation));
    if(!part||message.revision!==1)continue;
    const data=dataOf(message),reference=part.roles.target?.[0]?.reference;
    if(data.migration||!reference||part.roles.target?.length!==1)continue;
    const system=message.authorId==='system'&&part.relation==='review-record';
    if(!system&&part.relation!=='review')continue;
    const target=await store.message(reference.messageId,reference.revision);
    const corrected=correctionTargetReference(target),correctionTargets=await targetRevisions(store,corrected?[corrected]:[]);
    const reviewTarget={messageId:target.id,revision:target.revision};
    const audience=new Map<string,{kind:string;action:string;reason:string}>();
    const add=(userId:string,kind:string,action:string,reason:string)=>{if(userId!=='system')audience.set(userId,{kind,action,reason});};
    const financial=system?change.ledger.filter(entry=>entry.messageId===message.id):[];
    if(financial.length){
      for(const entry of financial)add(entry.userId,'review-financial','审核资金已结算或调整','本次审核影响了你的贡献点');
    }else if(system&&('assigned' in data||'revoked' in data)){
      for(const userId of ids(data.assigned))add(userId,'review-assigned','收到审核任务','你被分配了这条消息的审核任务');
      for(const userId of ids(data.revoked))add(userId,'review-revoked','审核任务已撤回','你的审核任务已结束或超时');
    }else if(system&&('status' in data||'releaseAt' in data||'stageSize' in data)){
      const kind='stageSize' in data?'review-expanded':'releaseAt' in data?'review-result':'review-reopened';
      const users=await store.db.prepare(`SELECT DISTINCT "userId" FROM moderation_votes WHERE "caseId"=$1
        UNION SELECT "userId" FROM moderation_assignments WHERE "caseId"=$1 AND "revokedAt" IS NULL`).all<{userId:string}>(data.caseId);
      for(const userId of [target.authorId,...users.map(user=>user.userId)])add(userId,kind,textOf(message),'你是消息作者或参与了本次审核');
    }else if(!system&&target.authorId!==message.authorId){
      add(target.authorId,'review-vote',data.verdict==='pass'?'提交了审核通过判断':'提交了审核不通过判断','你的消息收到了审核判断');
    }
    if(!audience.size)continue;
    const users=await store.db.prepare('SELECT id,name FROM users WHERE id=ANY($1::text[])').all<{id:string;name:string}>([...audience.keys(),message.authorId]);
    const names=new Map(users.map(user=>[user.id,user.name]));
    for(const [userId,event] of audience){
      if(!names.has(userId))continue;
      if(!financial.length&&await store.db.prepare('SELECT 1 FROM notification_preferences WHERE "userId"=$1 AND "targetId"=$2 AND muted').get(userId,target.id))continue;
      const entries=financial.filter(entry=>entry.userId===userId);
      const body:NotificationContent={actorName:system?'公论审核':names.get(message.authorId)??message.authorId,
        action:event.action,excerpt:system?'':textOf(message).slice(0,180),...describeTarget(target,corrected?correctionTargets.get(referenceKey(corrected)):undefined),
        sourceRevision:message.revision,excerptReference:{messageId:message.id,revision:message.revision},
        targetExcerptReference:reviewTarget,references:[reviewTarget],reviewTarget,navigationId:target.id,
        ...(typeof data.reviewRound==='number'?{reviewRound:data.reviewRound}:{}),
        reasons:[event.reason],watchedIds:[],...(entries.length?{availableDelta:entries.reduce((sum,entry)=>sum+entry.amount,0),lockedDelta:entries.reduce((sum,entry)=>sum+entry.lockedDelta,0)}:{})};
      const eventId=JSON.stringify([message.id,message.revision,'review',event.kind]);
      await store.db.prepare(`INSERT INTO notifications("userId","eventId","sourceId","targetId","actorId",category,kind,"groupKey","createdAt","changeSequence",body)
        VALUES($1,$2,$3,$4,$5,'review',$6,$2,$7,$8,$9::jsonb) ON CONFLICT("userId","eventId") DO NOTHING`)
        .run(userId,eventId,message.id,target.id,message.authorId,event.kind,message.createdAt,change.sequence,JSON.stringify(body));
    }
  }
}
