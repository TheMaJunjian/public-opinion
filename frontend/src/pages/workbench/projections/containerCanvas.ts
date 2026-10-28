import { isContentKind } from '../../../utils/modelBridge';
import type { ContainerEffect } from '../model/containerEffect';
import { expandTextIdsWithCorrections } from '../model/correction';
import { expandTextIdsWithSettlementResults } from '../model/navigation';
import { collectExclusiveRelationMsgIds } from '../actions/targetResolution';
import { deriveGraphMessagesToRender } from './graphMessagesToRender';
import {isRejectedRelation} from '../../../utils/relatedMessages';

export type ContainerCanvasScope = {kind:'root'} | {kind:'inside';id:string};

/** Normal canvas context for comparison navigation; never constructs a temporary category. */
export function projectContainerCanvas(effect:ContainerEffect,scope:ContainerCanvasScope){
  const {messages,edges,msgMap,rejectedContainerIds,rejectedJoinRelationIds}=effect;
  const {relations,relationById,ownership}=effect;
  const scopeId=scope.kind==='inside'?scope.id:null;
  const empty=()=>new Set<string>(),owned=()=>({textIds:empty(),relationIds:empty()});
  const classify=scopeId?owned():ownership.active('CLASSIFY'),summary=scopeId?owned():ownership.active('SUMMARY');
  const classifyText=expandTextIdsWithSettlementResults(expandTextIdsWithCorrections(classify.textIds,edges,msgMap),messages);
  const summaryText=expandTextIdsWithCorrections(summary.textIds,edges,msgMap);
  const hiddenText=new Set([...classifyText,...summaryText]);
  const hiddenRelations=new Set([...classify.relationIds,...summary.relationIds]);
  const exclusive=scopeId?empty():collectExclusiveRelationMsgIds({edges,msgMap},hiddenText,hiddenRelations);
  const scoped=deriveGraphMessagesToRender({
    messages,edges,messagesToShow:messages,edgesToShow:edges,relations,relationById,msgMap,containerOwnership:ownership,
    traceEntries:[],traceContainerMemberships:effect.memberships,traceDistance:1,traceExpandedFrameIds:empty(),
    effectiveSuppressedRelIdsForLayout:effect.suppressed,isInsideClassify:scopeId!==null,currentClassifyRelMsgId:scopeId,
    rejectedContainerIds,rejectedJoinRelationIds,activeClassifyOwnership:classify,activeSummaryOwnership:summary,
    classifiedTargetSummaryRelMsgIds:empty(),listExclusiveRelMsgIds:exclusive,replacedRelationMsgIds:empty(),
    classifiedTargetTextIds:classifyText,graphOwnedRelationIds:hiddenRelations,traceRelationMsgIds:empty(),
    classifiedTargetClassifyRelMsgIds:empty(),classifiedTargetMergeRelMsgIds:empty(),classifiedTargetARRANGERelMsgIds:empty(),
    graphExclusiveRelMsgIds:exclusive,graphHiddenTextIds:hiddenText,
  });
  const visible=scoped.graphMessagesToRender.filter(message=>!effect.suppressed.has(message.id)||isContentKind(message.kind)||isRejectedRelation(message,effect.suppressed));
  return {messages:visible,edges:effect.projectEdges(scoped.graphEdgesToRender,new Set(visible.map(message=>message.id))),hideMessageIds:scoped.hideMessageIds,rejectedRelationIds:effect.suppressed};
}
