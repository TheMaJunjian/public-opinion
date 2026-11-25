import type {ModerationSummary,NativeMessageView,Part,Reference,ReviewStakeItem,ReviewVerdict,TargetRef,WorkbenchSnapshot} from '@gonglun/core';
import {isRelationView,isReviewProcessRecord,RESTRICTED_CONTENT_PLACEHOLDER,reviewContextOf,reviewDecisionFacts,selectReviewDiscussion} from '@gonglun/core';
import {convertMessagesToDemoModel,isReviewBallot,type DemoEdge,type DemoMessage} from './modelBridge';
import type {ReviewDetail} from '../api/client';

/** Keep the pinned review body, records and totals in the same snapshot as the
 * canvas. Preview pages are temporary; committed pages also bridge the API refresh. */
export function applyReviewSnapshots(detail:ReviewDetail,pages:WorkbenchSnapshot[]):ReviewDetail{
  const updates=new Map<string,NativeMessageView>();
  for(const page of pages){
    const relations=new Map(page.relations.map(relation=>[relation.id,relation]));
    for(const message of page.messages)if((message.parts||message.restricted)&&message.revision){
      // The row itself supplies the authoritative visibility, even when a stale
      // relation with the same identity was still present in another projection.
      updates.set(message.id,{...(!message.restricted&&relations.get(message.id)),...message,parts:message.parts??[]} as NativeMessageView);
    }
  }
  if(!updates.size)return detail;
  const candidate=updates.get(detail.summary.messageId);
  let target=candidate?.revision===detail.summary.revision?candidate:detail.target;
  if(candidate?.restricted&&candidate.revision>detail.summary.revision&&target&&!target.restricted){
    // A newer rejection can hide an older revision too. Keep the original
    // revision pinned while its own visibility is fetched again.
    const restrictedReviewTargets=candidate.restrictedReviewTargets?.filter(address=>address.messageId===candidate.id&&address.revision===candidate.revision);
    const newerCase=candidate.moderation;
    target={...reviewIdentity(target),kind:'TEXT',contentType:'TEXT',content:RESTRICTED_CONTENT_PLACEHOLDER,parts:[],
      sourceMessageId:null,sourceRefs:[],targetRefs:[],payload:{},restricted:true,moderation:detail.summary,
      restrictedReviewTargets,...(restrictedReviewTargets?.length&&newerCase?.messageId===candidate.id&&newerCase.revision===candidate.revision
        ?{restrictedReviewSummaries:[newerCase]}:{})};
  }
  const targetBlocked=target?.restricted||!!candidate?.restricted&&candidate.revision>=detail.summary.revision;
  const summary=target?.moderation?.caseId===detail.summary.caseId?{...detail.summary,...target.moderation,viewerVote:target.moderation.viewerVote}:detail.summary;
  const previous=new Map(detail.records.map(record=>[record.id,record]));
  if(detail.target)previous.set(detail.target.id,detail.target);
  const visibilityChanged=[...updates.values()].some(record=>record.restricted&&!previous.get(record.id)?.restricted);
  // A snapshot can contain just the newly hidden target. Drop earlier quotes and
  // relation bodies until their individually projected replacements arrive.
  const retained=visibilityChanged?detail.records.flatMap<NativeMessageView>(record=>{
    if(updates.has(record.id))return [];
    const facts=reviewDecisionFacts(record,summary);
    if(facts)return [{...reviewIdentity(record),kind:'RELATION',contentType:'TEXT' as const,relationType:record.relationType,
      restricted:record.restricted,...facts}];
    const content=independentDiscussionBody(record);
    return content===undefined?[]:[{...record,content}];
  }):detail.records;
  const records=recordsForReview([...new Map([...retained,...updates.values()].map(record=>[record.id,record])).values()],summary,new Set(detail.records.map(record=>record.id)));
  const stakes=new Map((detail.stakes??[]).filter(stake=>{
    const source=updates.get(stake.sourceMessageId);
    return detail.target?.restricted||!source?.restricted||source.revision!==stake.revision;
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
  // Drop a readable response's details at the transition. A subsequent
  // restricted response contains the public financial entries for this case.
  const orderedStakes:ReviewStakeItem[]=targetBlocked&&!detail.target?.restricted?[]:[...stakes.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)
    ||(updates.get(b.sourceMessageId)?.sequence??0)-(updates.get(a.sourceMessageId)?.sequence??0));
  return {...detail,target,summary,records,stakes:orderedStakes,...(targetBlocked?{snapshot:undefined,canReview:false,canSettle:false}:{})};
}

function reviewIdentity(record:NativeMessageView){
  return {id:record.id,revision:record.revision,sequence:record.sequence,createdAt:record.createdAt,updatedAt:record.updatedAt,
    createdBy:record.createdBy,spending:record.spending,state:{messageId:record.id,revision:record.revision,suppressed:record.state?.suppressed??false,
      supportCount:record.state?.supportCount??0,oppositionCount:record.state?.oppositionCount??0,recommendationTotal:record.state?.recommendationTotal??0}};
}

/** Only an independently authored body with bare discussion addresses can survive
 * a partial visibility change without fetching its content dependencies again. */
function independentDiscussionBody(record:NativeMessageView):string|undefined{
  if(record.sourceMessageId||record.relSourceId||record.sourceRefs?.length||record.targetRefs?.length||record.declaredTargetRefs?.length
    ||record.executedStance||record.relationType||Object.keys(record.payload??{}).length||Object.keys(record.relationPayload??{}).length)return;
  const independent=record.parts.every(part=>{
    if(part.type==='text'||part.type==='web'||part.type==='code')return true;
    if(part.type==='data')return !!part.value&&typeof part.value==='object'&&!Array.isArray(part.value)&&
      Object.entries(part.value).every(([key,value])=>['kind','uiType','contentType'].includes(key)&&['TEXT','MARKDOWN'].includes(String(value)));
    if(part.type!=='relation'||!['review-context','review-reason'].includes(part.relation)||Object.keys(part.roles).length!==1||part.roles.target?.length!==1)return false;
    const ref=part.roles.target[0]!.reference;
    return !!ref.messageId&&!!ref.revision&&Object.keys(ref).every(key=>['messageId','revision','context'].includes(key))&&
      (!ref.context||ref.context.kind==='MESSAGE'&&Object.keys(ref.context).length===1);
  });
  if(!independent)return;
  const body=record.parts.flatMap(part=>part.type==='text'?[part.text]:part.type==='web'?[part.excerpt||part.url]:part.type==='code'?[part.source]:[]);
  if(body.length)return body.join('\n');
}

export function reviewTargetMessage(target:NativeMessageView){
  return convertMessagesToDemoModel([target],isRelationView(target)?[target]:[]).messages[0];
}

export function reviewRecordTarget(record:{parts?:Part[];targetRefs?:TargetRef[]}):Reference|undefined{
  const context=reviewContextOf(record);
  if(context)return context;
  const part=record.parts?.find(part=>part.type==='relation'&&part.relation!=='review-reason'&&part.relation.startsWith('review'));
  const reference=part?.type==='relation'?part.roles.target?.[0]?.reference:undefined;
  if(reference)return reference;
  const target=record.targetRefs?.[0];
  return target?.reference??(target?{messageId:target.kind==='relation'?target.relationId:target.messageId}:undefined);
}

export type ReviewRecord=NativeMessageView;
type ReviewRecordContent=Partial<Pick<ReviewRecord,'parts'|'payload'|'relationType'|'relationPayload'|'restricted'>>;
export function reviewRecordData(record:ReviewRecordContent):Record<string,unknown>{
  return Object.assign({},record.relationPayload,record.payload,...(record.parts??[]).flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)?[part.value]:[]));
}
export function reviewRecordVerdict(record:ReviewRecordContent):ReviewVerdict|undefined{
  if(record.restricted||!isReviewBallot(record))return;
  const verdict=reviewRecordData(record).verdict;return verdict==='pass'||verdict==='reject'?verdict:undefined;
}

export interface ReviewVoteGroup {
  targetId: string;
  verdict: ReviewVerdict;
  votes: Array<{id:string;revision?:number;author:string;wager?:number;round?:number;targetRevision?:number;createdAt:string}>;
}
export interface ReviewVoteWindow {round:number;releaseAt:string|null}
export function reviewVoteWindow(detail?:ReviewDetail|null):ReviewVoteWindow|undefined {
  if(detail?.canReview&&!detail.target?.restricted&&!detail.summary.finalized
    &&(!detail.reviewEligibility||detail.reviewEligibility==='eligible'))return {round:detail.summary.round??1,releaseAt:detail.summary.releaseAt};
}
export interface ReviewVoteDecorationProps {
  reviewVoteGroups?: ReadonlyMap<string, ReviewVoteGroup[]>;
  reviewVoteHints?: ReadonlyMap<string,string>;
  onOpenReviewVotes?: (group: ReviewVoteGroup) => void;
  onExpandDecorations?: (targetId:string) => void;
}
export const reviewVoteLoadLabels={idle:'查看审核投票',loading:'加载审核投票中',error:'重试加载审核投票'} as const;
export function reviewVoteLabel(verdict:ReviewVerdict){
  return verdict==='pass'?'审核通过':'审核不通过';
}
export function reviewVoteBadgeWidth(count:number){
  return 74+8*(String(count).length-1);
}

/** A separately addressed reason, including a hidden one, keeps its decision in the discussion. */
export function projectReviewVoteDecorations(messages:DemoMessage[],scope?:{targetId:string;revision?:number;recordIds:ReadonlySet<string>}){
  const withReason=new Set<string>();
  const revisions=new Map<string,number>();
  for(const message of messages){
    if(message.revision)revisions.set(message.id,message.revision);
    if(!scope?.recordIds.has(message.id))continue;
    for(const part of message.parts??[])if(part.type==='relation'&&part.relation==='review-reason'){
      for(const binding of part.roles.target??[])withReason.add(binding.reference.messageId);
    }
  }
  const groups=new Map<string,ReviewVoteGroup[]>(), voteIds=new Set<string>();
  for(const message of messages){
    if(scope&&(withReason.has(message.id)||!scope.recordIds.has(message.id)||message.id===scope.targetId))continue;
    // The case ledger owns these ballots even when an older snapshot omits the verdict.
    // Only an independently linked reason gives a ballot a standalone presentation.
    if(scope&&isReviewBallot(message))voteIds.add(message.id);
    const verdict=reviewRecordVerdict(message);
    if(!verdict)continue;
    const target=reviewRecordTarget(message)??(scope&&{messageId:scope.targetId,revision:scope.revision});
    if(!target)continue;
    const revision=scope?.targetId===target.messageId?scope.revision:revisions.get(target.messageId);
    if(target.revision&&revision&&target.revision!==revision)continue;
    let targetGroups=groups.get(target.messageId);
    if(!targetGroups){targetGroups=[];groups.set(target.messageId,targetGroups);}
    let group=targetGroups.find(group=>group.verdict===verdict);
    if(!group){
      group={targetId:target.messageId,verdict,votes:[]};
      if(verdict==='pass')targetGroups.unshift(group);else targetGroups.push(group);
    }
    const round=reviewRecordData(message).reviewRound;
    group.votes.push({id:message.id,revision:message.revision,author:message.author,wager:message.spending?.reviewWager,
      round:typeof round==='number'?round:undefined,targetRevision:target.revision,createdAt:message.createdAt});
    voteIds.add(message.id);
  }
  return {groups,voteIds};
}
export function recordsForReview(records:ReviewRecord[],summary:ModerationSummary,knownIds?:ReadonlySet<string>):ReviewRecord[]{
  const candidates=records.map(record=>{
    if(record.parts?.length||record.restricted||record.relationType?.toLowerCase()!=='review'||knownIds&&!knownIds.has(record.id))return record;
    const facts=reviewDecisionFacts(record);
    return facts?{...record,...facts}:record;
  });
  const selected=selectReviewDiscussion(candidates,{messageId:summary.messageId,revision:summary.revision},summary.caseId);
  // A redacted record may have no parts left to establish its own discussion membership.
  const selectedIds=new Set(selected.map(record=>record.id));
  const unique=new Map(candidates.map(record=>[record.id,record]));
  return [...unique.values()].filter(record=>selectedIds.has(record.id)||record.restricted&&knownIds?.has(record.id)&&!isReviewProcessRecord(record));
}
/** Use the normal discussion regions inside the review category. This is a
 * drawing projection only: original review records, addresses and votes remain intact. */
export function projectReviewDiscussionEdges(edges:DemoEdge[],records:(ReviewRecordContent&{id:string})[],discussion:{id:string;parts?:Part[]}[]=[]):DemoEdge[]{
  const verdicts=new Map(records.map(record=>[record.id,reviewRecordVerdict(record)]));
  const visibleIds=new Set(discussion.map(message=>message.id));
  const projected=edges.map((edge):DemoEdge=>{
    const verdict=verdicts.get(edge.relationMessageId);
    return edge.relationType==='review'&&verdict
      ?{...edge,relationType:verdict==='pass'?'review-pass':'review-reject',relationLabel:verdict==='pass'?'审核通过':'审核不通过',
        from:edge.from.messageId.startsWith('anon:')?{messageId:edge.relationMessageId,selection:{kind:'whole'}}:edge.from}
      :edge;
  });
  for(const message of discussion){
    const link=message.parts?.find(part=>part.type==='relation'&&part.relation==='review-reason');
    const voteId=link?.type==='relation'?link.roles.target?.[0]?.reference.messageId:undefined;
    if(voteId&&visibleIds.has(voteId)&&verdicts.has(voteId))projected.push({id:`review-reason:${message.id}`,relationType:'reply',relationLabel:'审核理由',
      relationMessageId:message.id,from:{messageId:message.id,selection:{kind:'whole'}},to:{messageId:voteId,selection:{kind:'whole'}}});
  }
  return projected;
}
