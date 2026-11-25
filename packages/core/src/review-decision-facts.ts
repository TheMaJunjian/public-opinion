import type {Part,Reference} from './types.js';
import type {RelationPayload,TargetRef} from './workbench.js';
import type {ReviewContext} from './review-context.js';
import type {ReviewVerdict} from './moderation.js';

type DecisionView={
  relationType?:string|null;parts?:Part[];targetRefs?:TargetRef[];
  payload?:RelationPayload;relationPayload?:RelationPayload|null;
};

/** Project only the recorded judgment and one whole-message address, even from an old signed vote. */
export function reviewDecisionFacts(record:DecisionView,scope?:ReviewContext){
  const part=record.parts?.find(part=>part.type==='relation'&&['review','review-appeal'].includes(part.relation));
  const action=part?.type==='relation'?part.relation:record.relationType?.toLowerCase();
  if(action!=='review'&&action!=='review-appeal')return;
  const legacy=record.targetRefs?.length===1?record.targetRefs[0]:undefined;
  const target=scope??(part?.type==='relation'&&part.roles.target?.length===1?part.roles.target[0]!.reference:
    legacy?.reference??(legacy&&{messageId:legacy.kind==='relation'?legacy.relationId:legacy.messageId}));
  const reference:Reference|undefined=target?.messageId?{messageId:target.messageId,...('revision' in target&&target.revision&&{revision:target.revision})}:undefined;
  const data:Record<string,unknown>=Object.assign({},...(record.parts??[]).flatMap(part=>part.type==='data'&&typeof part.value==='object'&&part.value&&!Array.isArray(part.value)?[part.value]:[]),
    record.relationPayload,record.payload);
  const verdict:ReviewVerdict|undefined=data.verdict==='pass'||data.verdict==='reject'?data.verdict:undefined;
  const selfStake:ReviewVerdict|undefined=data.selfStakeVerdict==='pass'||data.selfStakeVerdict==='reject'?data.selfStakeVerdict:verdict;
  const payload:{caseId?:string;reviewRound?:number;verdict?:ReviewVerdict;selfStakeVerdict?:ReviewVerdict}={...(typeof data.caseId==='string'&&{caseId:data.caseId}),...(Number.isSafeInteger(data.reviewRound)&&{reviewRound:Number(data.reviewRound)}),
    ...(verdict&&{verdict}),...(action==='review-appeal'&&selfStake&&{selfStakeVerdict:selfStake})};
  const parts:Part[]=[{id:part?.id??'review',type:'relation',relation:action,roles:{target:reference?[{id:'target',reference}]:[]}},
    {id:part?.id==='review-data'?'data':'review-data',type:'data',value:payload}];
  const targetRefs:TargetRef[]=reference?[{kind:'message',messageId:reference.messageId,reference}]:[];
  return {parts,targetRefs,content:'',sourceMessageId:null,relSourceId:null,sourceRefs:[],declaredTargetRefs:undefined,executedStance:undefined,payload,relationPayload:payload};
}
