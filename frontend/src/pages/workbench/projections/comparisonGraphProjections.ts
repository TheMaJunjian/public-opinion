import type { Relation } from '../../../types';
import { isContentKind, type DemoEdge, type DemoMessage } from '../../../utils/modelBridge';
import { applyTraceFrameVisibility, buildTraceProjection, type TraceContainerMembership } from '../../../utils/traceProjection';
import { expandTextIdsWithCorrections } from '../model/correction';
import { expandTextIdsWithSettlementResults } from '../model/navigation';
import { deriveContainerEffect, isContainerType, type ContainerEffect } from '../model/containerEffect';
import { projectContainerCanvas } from './containerCanvas';
import type { TraceEntry } from '../types';
import { deriveCrossCanvasRelations } from '../../../utils/crossCanvasRelations';
import { projectGraphScene } from '../../../utils/graphProjection';

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
  traceExpandedFrameIds: Set<string>;
  filterMessages?: (messages: DemoMessage[]) => DemoMessage[];
}

export function projectComparisonSide(input: DeriveComparisonGraphProjectionsInput, side: 'agree' | 'disagree') {
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
    const scopedIds = new Set(baseMessages.map(message => message.id));
    const forcedVisibleIds = side==='agree'?targetIds:new Set([...(releasedTarget?.textIds??[]),...(releasedTarget?.relationIds??[])]);
    const projectedMessages = (side === 'agree' || releasedTarget || traceStartIdSet.has(comparisonTargetId) ? [...withTarget.values()] : baseMessages).filter(message => {
      if(organizationScopeIds&&!organizationScopeIds.has(message.id))return false;
      if (forcedVisibleIds.has(message.id)) return true;
      if (suppressed.has(message.id)) return false;
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

    const effect = deriveContainerEffect({messages,relations,edges,username,assumption:{messageId:comparisonTargetId,side}});
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
        containerMemberships:memberships,excludedRelationIds:effect.suppressed,startIds:traceStartIds,distance:traceDistance,
      }),new Set([...traceExpandedFrameIds,...effect.rejectedContainerIds]));
      const allowed = organizationEffect ? null : new Set(canvas.messages.map(message => message.id));
      const visible = trace.messages.filter(message => !allowed || allowed.has(message.id));
      const visibleIds = new Set(visible.map(message => message.id));
      canvas = {...canvas,messages:visible,edges:trace.edges.filter(edge => visibleIds.has(edge.relationMessageId)
        && (edge.from.messageId.startsWith('anon:')||visibleIds.has(edge.from.messageId)) && visibleIds.has(edge.to.messageId))};
    }
    const finalMessages=input.filterMessages?.(canvas.messages)??canvas.messages;
    const scene=projectGraphScene({messages:finalMessages,edges:canvas.edges,
      traceExpandedFrameIds,isTraceWindow:traceStartIds.length>0,
      rejectedContainerIds:effect.rejectedContainerIds,hiddenMessageIds:effect.suppressed});
    const allowedRelations=new Set((input.filterMessages?.(effect.messages)??effect.messages).map(message=>message.id));
    const relatedEdges=effect.edges.filter(edge=>allowedRelations.has(edge.relationMessageId));
    const crossCanvasRelations=deriveCrossCanvasRelations({
      edges:relatedEdges,
      visibleMessageIds:new Set([...scene.normalIds,...scene.frameBlocks.map(frame=>frame.relMsgId)]),renderedEdges:scene.layoutEdges,
    });
    return {...canvas,messages:finalMessages,suppressed:effect.suppressed,context:{...effect.context,relatedEdges,crossCanvasRelations},effect};
}

export function deriveComparisonGraphProjections(input: DeriveComparisonGraphProjectionsInput) {
  if(!input.comparisonReviewed||!input.comparisonTargetId)return null;
  return {agree:projectComparisonSide(input,'agree')!,disagree:projectComparisonSide(input,'disagree')!};
}
