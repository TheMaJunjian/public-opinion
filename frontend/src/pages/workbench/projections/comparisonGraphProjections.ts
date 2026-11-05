import type { Relation } from '../../../types';
import { annotationAtReference, oppositeAnnotation } from '@gonglun/core';
import { computeCorrectionVersions, isContentKind, withCorrectionContent, type DemoEdge, type DemoMessage } from '../../../utils/modelBridge';
import { applyTraceFrameVisibility, buildTraceProjection, type TraceContainerMembership } from '../../../utils/traceProjection';
import { expandTextIdsWithCorrections } from '../model/correction';
import { expandTextIdsWithSettlementResults } from '../model/navigation';
import { deriveContainerEffect, isContainerType, type ContainerEffect } from '../model/containerEffect';
import { projectContainerCanvas } from './containerCanvas';
import type { TraceEntry } from '../types';
import { deriveCrossCanvasRelations } from '../../../utils/crossCanvasRelations';
import { projectGraphScene } from '../../../utils/graphProjection';
import {isRejectedRelation,hiddenInactiveRelationIds} from '../../../utils/relatedMessages';
import { effectiveCardWidths } from '../../../utils/cardWidth';
import { comparisonMembershipFrames } from './comparisonMembershipFrames';

export interface DeriveComparisonGraphProjectionsInput {
  comparisonReviewed: boolean;
  comparisonTargetId: string | null;
  username: string | null;
  scopeId: string | null;
  baseScopeId?: string | null;
  sourceEffect?: ContainerEffect;
  traceEntries: TraceEntry[];
  relations: Relation[];
  edges: DemoEdge[];
  messages: DemoMessage[];
  collectExclusiveRelationMsgIds: (hiddenTextIds: Set<string>, ownedRelationIds: Set<string>) => Set<string>;
  replacedRelationMsgIds: Set<string>;
  comparisonReviewBaseMessages: DemoMessage[] | null;
  isInsideClassify: boolean;
  normalGraphProjection: { messages: DemoMessage[]; scopedMessages: DemoMessage[]; edges: DemoEdge[] };
  comparisonReviewBaseEdges: DemoEdge[] | null;
  traceRelationMsgIds: Set<string>;
  traceContainerMemberships: TraceContainerMembership[];
  traceDistance: number;
  traceDepths?: import('../../../utils/traceRange').TraceDepths;
  traceDirection?: import('../../../utils/traceRange').TraceDirection;
  traceExpandedFrameIds: Set<string>;
  filterMessages?: (messages: DemoMessage[]) => DemoMessage[];
  displayedCorrections?: ReturnType<typeof computeCorrectionVersions>;
  /** Paired review reveals the affected membership paths; previews retain their ordinary scope. */
  showMembershipFrames?: boolean;
  annotationResolved?: boolean;
}

export function projectComparisonSide(input: DeriveComparisonGraphProjectionsInput, side: 'agree' | 'disagree') {
  const annotated = input.messages.find(message=>message.id===input.comparisonTargetId);
  const action = annotated && annotationAtReference(annotated,{messageId:annotated.id});
  const opposite = action && oppositeAnnotation(action);
  if (!input.annotationResolved && annotated && action && opposite) {
    const chosen = side === 'agree' ? action : opposite;
    const type = (chosen.relation === 'follow' ? 'attention' : chosen.relation) as DemoEdge['relationType'];
    const competitors = new Set(input.messages.filter(message=>{
      if(message.id===annotated.id)return false;
      const other=annotationAtReference(message,{messageId:message.id});
      return other && [action.relation,opposite.relation].includes(other.relation)
        && JSON.stringify(other.targets)===JSON.stringify(action.targets);
    }).map(message=>message.id));
    const messages = input.messages.filter(message=>!competitors.has(message.id)).map(message=>message.id!==annotated.id?message:{...message,
      relationType:type,relationPayload:chosen.payload,
      parts:message.parts?.map(part=>part.type==='relation'&&part.relation===action.relation?{...part,relation:chosen.relation,reason:chosen.payload.subType==='YES'||chosen.payload.subType==='NO'?chosen.payload.subType:undefined}:part)});
    return projectComparisonSideResolved({...input,annotationResolved:true,messages,
      relations:input.relations.filter(relation=>!competitors.has(relation.id)).map(relation=>relation.id===annotated.id?{...relation,relationType:type.toUpperCase(),payload:chosen.payload}:relation),
      edges:input.edges.filter(edge=>!competitors.has(edge.relationMessageId)).map(edge=>edge.relationMessageId===annotated.id?{...edge,relationType:type,relationLabel:type}:edge)},'agree');
  }
  return projectComparisonSideResolved(input, side);
}

function projectComparisonSideResolved(input: DeriveComparisonGraphProjectionsInput, side: 'agree' | 'disagree') {
  const { comparisonReviewed, comparisonTargetId, messages, relations, edges, username, scopeId,
    traceEntries, traceDistance, traceExpandedFrameIds, traceRelationMsgIds, collectExclusiveRelationMsgIds,
    replacedRelationMsgIds, comparisonReviewBaseMessages, comparisonReviewBaseEdges, normalGraphProjection, isInsideClassify } = input;
  if (!comparisonReviewed || !comparisonTargetId) return null;
  const traceStartIds = traceEntries.at(-1)?.ids.filter(Boolean) ?? [];
  const traceStartIdSet = new Set(traceStartIds);
  const targetType = relations.find(relation => relation.id === comparisonTargetId)?.relationType;
  const targetIsContainer = isContainerType(targetType);
  const organizationEffect = targetIsContainer || targetType?.toUpperCase() === 'JOIN';

  // The original comparison projection is the only final projection. Preview
  // calls this same function for one side, rather than constructing a category.
  const project = (effect: ContainerEffect) => {
    const { msgMap, relationById, suppressed } = effect;
    const rebased = input.baseScopeId !== undefined && scopeId !== input.baseScopeId
      ? projectContainerCanvas(effect,scopeId?{kind:'inside',id:scopeId}:{kind:'root'}) : null;
    // An assumed approval changes the container's effect, never its parent.
    // Bound forced targets and released members by the ordinary canvas for
    // this side, so inspecting C cannot lift it out of an opaque ancestor A.
    const organizationScope=organizationEffect&&traceStartIds.length===0
      ? rebased??projectContainerCanvas(effect,scopeId?{kind:'inside',id:scopeId}:{kind:'root'}) : null;
    const organizationScopeIds=organizationScope?new Set(organizationScope.messages.map(message=>message.id)):null;
    const baseMessages = rebased?.messages ?? comparisonReviewBaseMessages
      ?? (isInsideClassify ? normalGraphProjection.scopedMessages : normalGraphProjection.messages);
    const baseEdges = rebased?.edges ?? comparisonReviewBaseEdges ?? normalGraphProjection.edges;
    const scopeOwners = scopeId ? new Set([...baseMessages.map(message=>message.id),comparisonTargetId]) : undefined;
    if(scopeId)scopeOwners?.delete(scopeId);
    const classify = effect.ownership.active('CLASSIFY',scopeOwners), summary = effect.ownership.active('SUMMARY',scopeOwners);
    const hiddenTextIds = new Set([
      ...expandTextIdsWithSettlementResults(expandTextIdsWithCorrections(classify.textIds, effect.edges, msgMap), effect.messages),
      ...expandTextIdsWithCorrections(summary.textIds, effect.edges, msgMap),
    ]);
    const ownedRelationIds = new Set([...classify.relationIds,...summary.relationIds,...effect.ownership.active('MERGE',scopeOwners).relationIds]);
    const exclusive = collectExclusiveRelationMsgIds(hiddenTextIds, ownedRelationIds);
    const hiddenRelationIds = new Set([
      ...[...classify.relationIds].filter(id => isContainerType(relationById.get(id)?.relationType)),
      ...summary.relationIds,...exclusive,...replacedRelationMsgIds,
    ]);
    const targetEdges = edges.filter(edge => edge.relationMessageId === comparisonTargetId);
    const targetIds = new Set(scopeId === comparisonTargetId ? [] : [comparisonTargetId]);
    for (const edge of organizationEffect ? [] : edges.filter(edge => edge.relationMessageId === comparisonTargetId)) {
      if (!edge.from.messageId.startsWith('anon:')) targetIds.add(edge.from.messageId);
      if (!edge.to.messageId.startsWith('anon:')) targetIds.add(edge.to.messageId);
    }
    const releasedTarget = side === 'disagree' && targetIsContainer ? effect.ownership.released(comparisonTargetId) : null;
    if(releasedTarget || side === 'agree' && ['ARRANGE','MERGE'].includes(targetType?.toUpperCase()??'')){
      const members=releasedTarget??effect.ownership.released(comparisonTargetId);
      members.textIds.forEach(id=>targetIds.add(id));members.relationIds.forEach(id=>targetIds.add(id));
    }
    const withTarget = new Map<string,DemoMessage>(baseMessages.map(message => [message.id, {...message,state:msgMap.get(message.id)?.state}]));
    for (const id of targetIds) if (!withTarget.has(id) && msgMap.has(id)) withTarget.set(id,msgMap.get(id)!);
    // Releasing a container can expose an inactive connection whose source
    // was previously inside it. Its record belongs to this side's new scope.
    for(const message of organizationScope?.messages??[])if(isRejectedRelation(message,suppressed))withTarget.set(message.id,message);
    const scopedIds = new Set(baseMessages.map(message => message.id));
    const forcedVisibleIds = side==='agree'?targetIds:new Set([...(releasedTarget?.textIds??[]),...(releasedTarget?.relationIds??[])]);
    const projectedMessages = (side === 'agree' || releasedTarget || traceStartIdSet.has(comparisonTargetId)||isRejectedRelation(effect.msgMap.get(comparisonTargetId),suppressed) ? [...withTarget.values()] : baseMessages).filter(message => {
      if(organizationScopeIds&&!organizationScopeIds.has(message.id))return false;
      if (forcedVisibleIds.has(message.id)) return true;
      if (suppressed.has(message.id) && !isContentKind(message.kind)) return isRejectedRelation(message,suppressed);
      if (!organizationEffect && isInsideClassify && scopedIds.has(message.id)) return true;
      if (isContentKind(message.kind) && (hiddenTextIds.has(message.id) || ownedRelationIds.has(message.id))) return false;
      return message.kind !== 'relation' || !hiddenRelationIds.has(message.id);
    });
    const visibleIds = new Set(projectedMessages.map(message => message.id));
    // The original canvas may hide a member and its reference. Once the
    // assumed side releases both endpoints, recover their reference from the
    // shared data instead of restricting it to the old canvas's edges.
    const references=effect.messages.filter(message=>message.relationType==='reference');
    const allowedReferences=new Set((input.filterMessages?.(references)??references).map(message=>message.id));
    const referenceEdges=effect.edges.filter(edge=>edge.relationType==='reference'
      && allowedReferences.has(edge.relationMessageId)
      && (edge.from.messageId.startsWith('anon:')||visibleIds.has(edge.from.messageId))
      && visibleIds.has(edge.to.messageId));
    for(const edge of referenceEdges){
      const relation=effect.msgMap.get(edge.relationMessageId);
      if(relation&&!visibleIds.has(relation.id)){projectedMessages.push(relation);visibleIds.add(relation.id);}
    }
    const membershipEdges=effect.projectEdges([...baseEdges,...targetEdges,...referenceEdges],visibleIds);
    const projectedEdges = [...new Map([...membershipEdges,...(traceStartIdSet.has(comparisonTargetId)?targetEdges:[])].map(edge => [edge.id,edge])).values()].filter(edge => {
      if (suppressed.has(edge.relationMessageId) && !traceStartIdSet.has(edge.relationMessageId)) return false;
      if (!visibleIds.has(edge.relationMessageId) && !traceRelationMsgIds.has(edge.relationMessageId) && !traceStartIdSet.has(edge.relationMessageId)) return false;
      if (traceRelationMsgIds.has(edge.relationMessageId) || ['classify','summary'].includes(edge.relationType)) return true;
      return (edge.from.messageId.startsWith('anon:') || visibleIds.has(edge.from.messageId)) && visibleIds.has(edge.to.messageId);
    });
    return {messages:projectedMessages,edges:projectedEdges,hideMessageIds:undefined};
  };

    const effect = deriveContainerEffect({messages,relations,edges,username,stakeCounts:input.sourceEffect?.stakeCounts,assumption:{messageId:comparisonTargetId,side}});
    const assumedCorrections = computeCorrectionVersions(effect.messages, edges, effect.suppressed, username,
      targetType?.toUpperCase() === 'CORRECT' && side === 'agree' ? { previewCorrectionId: comparisonTargetId } : {});
    const corrections = new Map(input.displayedCorrections ?? assumedCorrections);
    const widths = effect.msgMap.get(comparisonTargetId)?.relationPayload?.correctionKind === 'WIDTH'
      ? effectiveCardWidths(effect.messages, edges, username, { messageId: comparisonTargetId, side }) : undefined;
    // Only this correction's original body changes its selected version. Other
    // messages retain the reading versions shown in the entering view.
    if (targetType?.toUpperCase() === 'CORRECT') for (const [id, entry] of assumedCorrections) {
      if (entry.versions.some(version => version.correctionId === comparisonTargetId)) corrections.set(id, entry);
    }
    let canvas = project(effect);
    if (traceStartIds.length) {
      const traceMessages = organizationEffect ? effect.messages : [
        ...canvas.messages,
        ...traceStartIds.filter(id => !canvas.messages.some(message => message.id === id))
          .map(id => effect.msgMap.get(id)).filter((message):message is DemoMessage => !!message),
      ];
      // A rejected trace anchor still connects to its released direct members;
      // it supplies reachability, without restoring its frame or membership.
      const memberships=[...effect.memberships];
      for(const id of traceStartIds)if(organizationEffect&&effect.rejectedContainerIds.has(id)){
        const members=effect.ownership.direct(id);
        memberships.push({containerId:id,relationType:effect.relationById.get(id)!.relationType.toLowerCase() as DemoEdge['relationType'],targetIds:[...members.textIds,...members.relationIds]});
      }
      const trace = applyTraceFrameVisibility(buildTraceProjection({
        messages:traceMessages, edges:organizationEffect?effect.edges:canvas.edges,
        containerMemberships:memberships,excludedRelationIds:effect.suppressed,startIds:traceStartIds,distance:traceDistance,depths:input.traceDepths,direction:input.traceDirection,
        expandedContainerIds:new Set([...traceExpandedFrameIds,...effect.rejectedContainerIds]),
      }),new Set([...traceExpandedFrameIds,...effect.rejectedContainerIds]));
      const allowed = organizationEffect ? null : new Set(canvas.messages.map(message => message.id));
      const visible = trace.messages.filter(message => !allowed || allowed.has(message.id));
      const visibleIds = new Set(visible.map(message => message.id));
      canvas = {...canvas,messages:visible,edges:trace.edges.filter(edge => visibleIds.has(edge.relationMessageId)
        && (edge.from.messageId.startsWith('anon:')||visibleIds.has(edge.from.messageId)) && visibleIds.has(edge.to.messageId))};
    }
    const finalMessages=(input.filterMessages?.(canvas.messages)??canvas.messages)
      .filter(message => message.relationType !== 'annotation' || !effect.suppressed.has(message.id)).map(message => {
      const entry = corrections.get(message.id);
      if (!entry) return message;
      const original = effect.msgMap.get(message.id) ?? message, current = entry.current;
      return current ? withCorrectionContent(original, current.content, current.changes, current.snapshot) : original;
    });
    const scene=projectGraphScene({messages:finalMessages,edges:canvas.edges,
      traceExpandedFrameIds,isTraceWindow:traceStartIds.length>0,
      rejectedContainerIds:effect.rejectedContainerIds,rejectedRelationIds:effect.suppressed,
      hiddenMessageIds:hiddenInactiveRelationIds(effect.messages,effect.suppressed)});
    const allowedRelations=new Set((input.filterMessages?.(effect.messages)??effect.messages).map(message=>message.id));
    const relatedEdges=effect.edges.filter(edge=>allowedRelations.has(edge.relationMessageId));
    const crossCanvasRelations=deriveCrossCanvasRelations({
      edges:relatedEdges,
      visibleMessageIds:new Set([...scene.normalIds,...scene.frameBlocks.map(frame=>frame.relMsgId)]),renderedEdges:scene.layoutEdges,
    });
    return {...canvas,messages:finalMessages,corrections,widths,suppressed:effect.suppressed,context:{...effect.context,relatedEdges,crossCanvasRelations},effect};
}

export function deriveComparisonGraphProjections(input: DeriveComparisonGraphProjectionsInput) {
  if(!input.comparisonReviewed||!input.comparisonTargetId)return null;
  const pair = {agree:projectComparisonSide(input,'agree')!,disagree:projectComparisonSide(input,'disagree')!};
  return input.showMembershipFrames ? comparisonMembershipFrames(pair, input.comparisonTargetId, input.filterMessages) : pair;
}
