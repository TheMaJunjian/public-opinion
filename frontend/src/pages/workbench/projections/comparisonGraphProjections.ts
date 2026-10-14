import type { Relation } from "../../../types";
import type {
  DemoEdge,
  DemoMessage
} from "../../../utils/modelBridge";
import { isContentKind } from "../../../utils/modelBridge";
import { applyTraceFrameVisibility, buildTraceProjection, type TraceContainerMembership } from "../../../utils/traceProjection";
import { expandTextIdsWithCorrections } from '../model/correction';
import { expandTextIdsWithSettlementResults } from '../model/navigation';
import { collectOwnedByRelation } from '../model/ownership';
import type { TraceEntry } from "../types";

interface DeriveComparisonGraphProjectionsInput {
  comparisonReviewed: boolean;
  comparisonTargetId: string | null;
  traceEntries: TraceEntry[];
  rejectedContainerIds: Set<string>;
  relations: Relation[];
  relationById: Map<string, Relation>;
  rejectedJoinRelationIds: Set<string>;
  edges: DemoEdge[];
  msgMap: Map<string, DemoMessage>;
  messages: DemoMessage[];
  mergeOwnership: { textIds: Set<string>; relationIds: Set<string>; };
  collectExclusiveRelationMsgIds: (hiddenTextIds: Set<string>, ownedRelationIds: Set<string>) => Set<string>;
  replacedRelationMsgIds: Set<string>;
  comparisonReviewBaseMessages: DemoMessage[] | null;
  isInsideClassify: boolean;
  normalGraphProjection: { messages: DemoMessage[]; scopedMessages: DemoMessage[]; edges: DemoEdge[]; };
  comparisonReviewBaseEdges: DemoEdge[] | null;
  comparisonAgreeSuppressedRelIds: Set<string>;
  comparisonDisagreeSuppressedRelIds: Set<string>;
  traceRelationMsgIds: Set<string>;
  traceContainerMemberships: TraceContainerMembership[];
  traceDistance: number;
  traceExpandedFrameIds: Set<string>;
}

export function deriveComparisonGraphProjections(input: DeriveComparisonGraphProjectionsInput): { agree: { messages: DemoMessage[]; edges: DemoEdge[]; hideMessageIds: undefined; }; disagree: { messages: DemoMessage[]; edges: DemoEdge[]; hideMessageIds: undefined; }; } | null {
  const { comparisonReviewed, comparisonTargetId, traceEntries, rejectedContainerIds, relations, relationById, rejectedJoinRelationIds, edges, msgMap, messages, mergeOwnership, collectExclusiveRelationMsgIds, replacedRelationMsgIds, comparisonReviewBaseMessages, isInsideClassify, normalGraphProjection, comparisonReviewBaseEdges, comparisonAgreeSuppressedRelIds, comparisonDisagreeSuppressedRelIds, traceRelationMsgIds, traceContainerMemberships, traceDistance, traceExpandedFrameIds } = input;
  if (!comparisonReviewed || !comparisonTargetId) return null;
  const traceStartIds = traceEntries.length > 0
    ? traceEntries[traceEntries.length - 1].ids.filter(Boolean)
    : [];
  const traceStartIdSet = new Set(traceStartIds);

  const buildProjection = (side: 'agree' | 'disagree') => {
    const sideRejectedContainerIds = new Set(rejectedContainerIds);
    if (side === 'agree') sideRejectedContainerIds.delete(comparisonTargetId);
    else sideRejectedContainerIds.add(comparisonTargetId);

    const sideClassifyOwnership = { textIds: new Set<string>(), relationIds: new Set<string>() };
    for (const relation of relations) {
      if (relation.relationType !== 'CLASSIFY' || sideRejectedContainerIds.has(relation.id)) continue;
      const owned = collectOwnedByRelation(relation.id, relationById, new Set(), sideRejectedContainerIds, rejectedJoinRelationIds);
      owned.textIds.forEach(id => sideClassifyOwnership.textIds.add(id));
      owned.relationIds.forEach(id => sideClassifyOwnership.relationIds.add(id));
    }
    const sideSummaryOwnership = { textIds: new Set<string>(), relationIds: new Set<string>() };
    for (const relation of relations) {
      if (relation.relationType !== 'SUMMARY' || sideRejectedContainerIds.has(relation.id)) continue;
      const owned = collectOwnedByRelation(relation.id, relationById, new Set(), sideRejectedContainerIds, rejectedJoinRelationIds);
      owned.textIds.forEach(id => sideSummaryOwnership.textIds.add(id));
      owned.relationIds.forEach(id => sideSummaryOwnership.relationIds.add(id));
    }
    const sideClassifyTextIds = expandTextIdsWithSettlementResults(
      expandTextIdsWithCorrections(sideClassifyOwnership.textIds, edges, msgMap),
      messages,
    );
    const sideSummaryTextIds = expandTextIdsWithCorrections(sideSummaryOwnership.textIds, edges, msgMap);
    const sideHiddenTextIds = new Set(sideClassifyTextIds);
    sideSummaryTextIds.forEach(id => sideHiddenTextIds.add(id));
    const sideOwnedRelationIds = new Set(sideClassifyOwnership.relationIds);
    mergeOwnership.relationIds.forEach(id => sideOwnedRelationIds.add(id));
    sideSummaryOwnership.relationIds.forEach(id => sideOwnedRelationIds.add(id));
    const sideExclusiveRelMsgIds = collectExclusiveRelationMsgIds(sideHiddenTextIds, sideOwnedRelationIds);
    const sideClassifyRelationIdsByType = (type: string) => new Set(
      [...sideClassifyOwnership.relationIds].filter(id => relationById.get(id)?.relationType.toUpperCase() === type),
    );
    const sideHiddenRelationIds = new Set<string>([
      ...sideClassifyRelationIdsByType('CLASSIFY'),
      ...sideClassifyRelationIdsByType('MERGE'),
      ...sideClassifyRelationIdsByType('ARRANGE'),
      ...sideClassifyRelationIdsByType('SUMMARY'),
      ...sideSummaryOwnership.relationIds,
      ...sideExclusiveRelMsgIds,
      ...replacedRelationMsgIds,
    ]);
    const projectionBaseMessages = comparisonReviewBaseMessages
      ?? (isInsideClassify ? normalGraphProjection.scopedMessages : normalGraphProjection.messages);
    const projectionBaseEdges = comparisonReviewBaseEdges ?? normalGraphProjection.edges;
    const targetMessageIds = new Set([comparisonTargetId]);
    const comparisonTargetEdges = edges.filter(edge => edge.relationMessageId === comparisonTargetId);
    const targetRelationType = relationById.get(comparisonTargetId)?.relationType.toUpperCase();
    const targetIsContainer = targetRelationType && ['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'].includes(targetRelationType);
    if (!targetIsContainer) {
      for (const edge of comparisonTargetEdges) {
        if (!edge.from.messageId.startsWith('anon:')) targetMessageIds.add(edge.from.messageId);
        if (!edge.to.messageId.startsWith('anon:')) targetMessageIds.add(edge.to.messageId);
      }
    }
    const releasedTarget = side === 'disagree' && targetIsContainer
      ? collectOwnedByRelation(
        comparisonTargetId,
        relationById,
        new Set(),
        new Set(),
        rejectedJoinRelationIds,
      )
      : null;
    if (releasedTarget) {
      const targetRelation = relationById.get(comparisonTargetId);
      for (const ref of targetRelation?.targetRefs ?? []) {
        if (ref.kind === 'relation') releasedTarget.relationIds.add(ref.relationId);
        else releasedTarget.textIds.add(ref.messageId);
      }
    }
    releasedTarget?.textIds.forEach(id => targetMessageIds.add(id));
    releasedTarget?.relationIds.forEach(id => targetMessageIds.add(id));
    const baseMessagesWithTarget = [...projectionBaseMessages];
    const baseMessageIds = new Set(baseMessagesWithTarget.map(message => message.id));
    for (const targetId of targetMessageIds) {
      if (baseMessageIds.has(targetId)) continue;
      const targetMessage = msgMap.get(targetId);
      if (targetMessage) {
        baseMessagesWithTarget.push(targetMessage);
        baseMessageIds.add(targetId);
      }
    }
    const baseEdgesWithTarget = [
      ...projectionBaseEdges,
      ...(side === 'agree' || traceStartIdSet.has(comparisonTargetId)
        ? comparisonTargetEdges.filter(edge => !projectionBaseEdges.some(existing => existing.id === edge.id))
        : []),
    ];
    const sideSuppressedRelIds = side === 'agree'
      ? comparisonAgreeSuppressedRelIds
      : comparisonDisagreeSuppressedRelIds;
    const forcedVisibleIds = side === 'agree' ? targetMessageIds : new Set<string>();
    releasedTarget?.textIds.forEach(id => forcedVisibleIds.add(id));
    releasedTarget?.relationIds.forEach(id => forcedVisibleIds.add(id));
    const scopedBaseMessageIds = new Set(projectionBaseMessages.map(message => message.id));
    const graphMessages = (side === 'agree' || releasedTarget || traceStartIdSet.has(comparisonTargetId) ? baseMessagesWithTarget : projectionBaseMessages).filter(message => {
      if (forcedVisibleIds.has(message.id)) return true;
      if (sideSuppressedRelIds.has(message.id)) return false;
      if (isInsideClassify && scopedBaseMessageIds.has(message.id)) return true;
      if (isContentKind(message.kind) && sideHiddenTextIds.has(message.id)) return false;
      if (message.kind === 'relation' && sideHiddenRelationIds.has(message.id)) return false;
      if (isContentKind(message.kind) && sideOwnedRelationIds.has(message.id)) return false;
      return true;
    });
    const graphVisibleIds = new Set(graphMessages.map(message => message.id));
    const graphEdges = baseEdgesWithTarget.filter(edge => {
      if (sideSuppressedRelIds.has(edge.relationMessageId) && !traceStartIdSet.has(edge.relationMessageId)) return false;
      if (!graphVisibleIds.has(edge.relationMessageId)
        && !traceRelationMsgIds.has(edge.relationMessageId)
        && !traceStartIdSet.has(edge.relationMessageId)) return false;
      if (traceRelationMsgIds.has(edge.relationMessageId)) return true;
      if (edge.relationType === 'classify' || edge.relationType === 'summary') return true;
      const fromOk = edge.from.messageId.startsWith('anon:') || graphVisibleIds.has(edge.from.messageId);
      const toOk = graphVisibleIds.has(edge.to.messageId);
      return fromOk && toOk;
    });
    if (traceEntries.length === 0) {
      return { messages: graphMessages, edges: graphEdges, hideMessageIds: undefined };
    }
    const traceProjection = applyTraceFrameVisibility(buildTraceProjection({
      messages: [
        ...graphMessages,
        ...traceStartIds
          .filter(id => !graphVisibleIds.has(id))
          .map(id => msgMap.get(id))
          .filter((message): message is DemoMessage => Boolean(message)),
      ],
      edges: graphEdges,
      containerMemberships: traceContainerMemberships,
      excludedRelationIds: sideSuppressedRelIds,
      startIds: traceStartIds,
      distance: traceDistance,
    }), traceExpandedFrameIds);
    const visibleMessages = traceProjection.messages.filter(message => graphVisibleIds.has(message.id));
    const visibleIds = new Set(visibleMessages.map(message => message.id));
    const visibleEdges = traceProjection.edges.filter(edge => {
      if (!visibleIds.has(edge.relationMessageId)) return false;
      return (edge.from.messageId.startsWith('anon:') || visibleIds.has(edge.from.messageId))
        && visibleIds.has(edge.to.messageId);
    });
    return { messages: visibleMessages, edges: visibleEdges, hideMessageIds: undefined };
  };

  return { agree: buildProjection('agree'), disagree: buildProjection('disagree') };
}
