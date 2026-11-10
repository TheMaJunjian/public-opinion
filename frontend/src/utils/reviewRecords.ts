import type {ModerationSummary,NativeMessageView,Part,Reference,ReviewStakeItem,ReviewVerdict,TargetRef,WorkbenchSnapshot} from '@gonglun/core';
import {isRelationView,RESTRICTED_CONTENT_PLACEHOLDER,selectReviewDiscussion} from '@gonglun/core';
import {convertMessagesToDemoModel,type DemoEdge} from './modelBridge';
import type {ReviewDetail} from '../api/client';

/** Keep the pinned review body, records and totals in the same snapshot as the
 * canvas. Preview pages are temporary; committed pages also bridge the API refresh. */
export function applyReviewSnapshots(detail:ReviewDetail,pages:WorkbenchSnapshot[]):ReviewDetail{
  const updates=new Map<string,NativeMessageView>();
  for(const page of pages){
    const relations=new Map(page.relations.map(relation=>[relation.id,relation]));
    for(const message of page.messages)if(message.parts&&message.revision){
      updates.set(message.id,{...message,...relations.get(message.id)} as NativeMessageView);
    }
  }
  if(!updates.size)return detail;
  const candidate=updates.get(detail.summary.messageId);
  const target=candidate?.revision===detail.summary.revision?candidate:detail.target;
  const summary=target?.moderation?.caseId===detail.summary.caseId?{...detail.summary,...target.moderation,viewerVote:target.moderation.viewerVote}:detail.summary;
  const records=recordsForReview([...new Map([...detail.records,...updates.values()].map(record=>[record.id,record])).values()],summary);
  const stakes=new Map((detail.stakes??[]).filter(stake=>{
    const source=updates.get(stake.sourceMessageId);
    return !source?.restricted||source.revision!==stake.revision;
  }).map(stake=>[stake.id,stake]));
  for(const record of records){
    if(!updates.has(record.id)||record.restricted)continue;
    const data=reviewRecordData(record),verdict=reviewRecordVerdict(record);
    const appeal=record.parts.some(part=>part.type==='relation'&&part.relation==='review-appeal');
    const side=verdict??(appeal?data.selfStakeVerdict:undefined);
    const kind=verdict?'wager':'self',amount=verdict?record.spending?.reviewWager:appeal?record.spending?.reviewDeposit:0;
    const id=`review-${kind}:${record.id}`;
    if(!stakes.has(id)&&(side==='pass'||side==='reject')&&amount&&amount>0){
      stakes.set(id,{id,sourceMessageId:record.id,revision:record.revision,kind,side:side==='pass'?'PRO':'CON',amount,
        round:Number(data.reviewRound??1)+(appeal?1:0),createdAt:record.createdAt,user:record.createdBy});
    }
  }
  const orderedStakes:ReviewStakeItem[]=target?.restricted?[]:[...stakes.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)
    ||(updates.get(b.sourceMessageId)?.sequence??0)-(updates.get(a.sourceMessageId)?.sequence??0));
  return {...detail,target,summary,records,stakes:orderedStakes};
}

export function reviewTargetMessage(target:NativeMessageView){
  return convertMessagesToDemoModel([target],isRelationView(target)?[target]:[]).messages[0];
}

export function reviewRecordTarget(record:{parts?:Part[];targetRefs?:TargetRef[]}):Reference|undefined{
  const part=record.parts?.find(part=>part.type==='relation'&&part.relation.startsWith('review'));
  const reference=part?.type==='relation'?part.roles.target?.[0]?.reference:undefined;
  if(reference)return reference;
  const target=record.targetRefs?.[0];
  return target?.reference??(target?{messageId:target.kind==='relation'?target.relationId:target.messageId}:undefined);
}

export type ReviewRecord=NativeMessageView;
type ReviewRecordContent=Partial<Pick<ReviewRecord,'parts'|'payload'|'restricted'>>;
/** Drop cached private content immediately when a reviewer's assignment expires. */
export function reviewTargetPlaceholder(target:NativeMessageView):NativeMessageView{
  const content=RESTRICTED_CONTENT_PLACEHOLDER;
  return {id:target.id,revision:target.revision,sequence:target.sequence,kind:'TEXT',contentType:'TEXT',content,
    parts:[{id:'restricted-body',type:'text',text:content}],createdBy:target.createdBy,createdAt:target.createdAt,
    updatedAt:target.updatedAt,spending:target.spending,moderation:target.moderation,restricted:true,
    state:{messageId:target.id,revision:target.revision,suppressed:false,supportCount:0,oppositionCount:0,recommendationTotal:0},
    relationType:null,sourceMessageId:null,sourceRefs:[],targetRefs:[],payload:{}};
}
export function reviewRecordData(record:ReviewRecordContent):Record<string,unknown>{
  return Object.assign({},record.payload,...(record.parts??[]).flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)?[part.value]:[]));
}
export function reviewRecordVerdict(record:ReviewRecordContent):ReviewVerdict|undefined{
  if(record.restricted||!record.parts?.some(part=>part.type==='relation'&&part.relation==='review'))return;
  const verdict=reviewRecordData(record).verdict;return verdict==='pass'||verdict==='reject'?verdict:undefined;
}
export function recordsForReview(records:ReviewRecord[],summary:ModerationSummary):ReviewRecord[]{
  return selectReviewDiscussion(records,{messageId:summary.messageId,revision:summary.revision},summary.caseId);
}
/** Use the normal discussion regions inside the review category. This is a
 * drawing projection only: original review records, addresses and votes remain intact. */
export function projectReviewDiscussionEdges(edges:DemoEdge[],records:(ReviewRecordContent&{id:string})[]):DemoEdge[]{
  const verdicts=new Map(records.map(record=>[record.id,reviewRecordVerdict(record)]));
  return edges.map(edge=>{
    const verdict=verdicts.get(edge.relationMessageId);
    return edge.relationType==='review'&&verdict
      ?{...edge,relationType:verdict==='pass'?'review-pass':'review-reject',relationLabel:verdict==='pass'?'审核通过':'审核不通过',
        from:edge.from.messageId.startsWith('anon:')?{messageId:edge.relationMessageId,selection:{kind:'whole'}}:edge.from}
      :edge;
  });
}
