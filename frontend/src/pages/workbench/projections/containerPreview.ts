import type { Relation } from '../../../types';
import type { DemoMessage, DemoEdge } from '../../../utils/modelBridge';
import { deriveContainerEffect, isContainerType } from '../model/containerEffect';
import { findContainingClassification } from '../model/ownership';
import { collectExclusiveRelationMsgIds } from '../actions/targetResolution';
import { projectContainerCanvas } from './containerCanvas';
import { projectComparisonSide, type DeriveComparisonGraphProjectionsInput } from './comparisonGraphProjections';

/** The existing comparison's agree side, presented alone with reversible navigation. */
export function projectContainerPreview(messages:DemoMessage[],relations:Relation[],edges:DemoEdge[],id:string,username:string|null,scopeId:string|null=null,comparisonInput?:DeriveComparisonGraphProjectionsInput,scopeOverride?:{id:string|null}){
  if(!isContainerType(messages.find(message=>message.id===id)?.relationType)||!relations.some(relation=>relation.id===id))return null;
  const source=comparisonInput?.sourceEffect??deriveContainerEffect({messages,relations,edges,username});
  // Match the original comparison review's containing-classification selection.
  const containingScope=findContainingClassification(source,id);
  // An explicit null means the root. Omitting the override infers the same
  // containing classification as comparison review.
  const requestedScope=scopeOverride?scopeOverride.id:scopeId??containingScope??comparisonInput?.scopeId??null;
  const base= comparisonInput ? null : projectContainerCanvas(source,requestedScope?{kind:'inside',id:requestedScope}:{kind:'root'});
  const input:DeriveComparisonGraphProjectionsInput=comparisonInput??{
    comparisonReviewed:true,comparisonTargetId:id,username,scopeId:requestedScope,
    messages,relations,edges,traceEntries:[],traceDistance:1,traceExpandedFrameIds:new Set(),traceRelationMsgIds:new Set(),traceContainerMemberships:source.memberships,
    collectExclusiveRelationMsgIds:(hidden,owned)=>collectExclusiveRelationMsgIds({edges,msgMap:source.msgMap},hidden,owned),
    replacedRelationMsgIds:new Set(),comparisonReviewBaseMessages:null,comparisonReviewBaseEdges:null,
    isInsideClassify:requestedScope!==null,normalGraphProjection:{...base!,scopedMessages:base!.messages},
  };
  const projection=projectComparisonSide({
    ...input,comparisonReviewed:true,comparisonTargetId:id,scopeId:requestedScope,baseScopeId:input.scopeId,
    isInsideClassify:requestedScope!==null,
    ...((scopeId||scopeOverride)?{traceEntries:[]}:{}),
  },'agree')!;
  const {effect}=projection;
  return {
    ...projection,allMessages:effect.messages,relations:effect.relations,target:effect.msgMap.get(id)!,
    scopeId:requestedScope,scopeTarget:requestedScope?effect.msgMap.get(requestedScope):null,
    rejectedContainerIds:effect.rejectedContainerIds,effectiveJoinIds:effect.effectiveJoinIds,suppressed:effect.suppressed,
  };
}
