import { applyMessageFilter, type MessageFilterSettings } from "../../../components/MessageFilterPanel";
import type { CleanVisibleIds } from '../../../hooks/useCleanView';
import type { Relation, User } from "../../../types";
import {getPresentationSpec} from '../../../types';
import type {
  DemoEdge,
  DemoMessage
} from "../../../utils/modelBridge";
import { computeEffectiveSuppressedRelIds } from "../../../utils/modelBridge";
import { filterContainerEdgesByEffectiveJoins,projectJoinMembershipEdges } from '../model/membership';

interface DeriveNormalGraphProjectionInput {
  graphMessagesToRender: DemoMessage[];
  correctionVersions: Map<string, { current?: import("../../../utils/modelBridge").CorrectionVersion; versions: import("../../../utils/modelBridge").CorrectionVersion[]; }>;
  cleanVisibleIds: CleanVisibleIds | null;
  homeFilterResult: { matchIds: Set<string>; displayIds: Set<string>; } | null;
  msgFilter: MessageFilterSettings;
  edges: DemoEdge[];
  messages: DemoMessage[];
  displayUser: User | null;
  graphEdgesToRender: DemoEdge[];
  relations: Relation[];
  effectiveJoinRelationIds: Set<string>;
}

export function deriveNormalGraphProjection(input: DeriveNormalGraphProjectionInput): { messages: DemoMessage[]; scopedMessages: DemoMessage[]; edges: DemoEdge[]; } {
  const { graphMessagesToRender, correctionVersions, cleanVisibleIds, homeFilterResult, msgFilter, edges, messages, displayUser, graphEdgesToRender, relations, effectiveJoinRelationIds } = input;
  const scopedCorrectedMessages = graphMessagesToRender.map(message => {
    const correction = correctionVersions.get(message.id)?.current;
    return correction ? { ...message, content: correction.content } : message;
  });
  const scopedCleanMessages = cleanVisibleIds
    ? scopedCorrectedMessages.filter(message =>
      cleanVisibleIds.visibleTextIds.has(message.id) || cleanVisibleIds.visibleRelIds.has(message.id))
    : scopedCorrectedMessages;
  const homeScopedMessages = homeFilterResult
    ? scopedCleanMessages.filter(message => homeFilterResult.displayIds.has(message.id))
    : scopedCleanMessages;
  const scopedMessages = applyMessageFilter(homeScopedMessages, msgFilter);
  const filteredMessages = applyMessageFilter(homeScopedMessages, msgFilter);
  const suppressedRelIds = computeEffectiveSuppressedRelIds(edges, messages, displayUser?.username ?? null);
  const declaredEdges = filterContainerEdgesByEffectiveJoins(
    graphEdgesToRender,
    relations,
    effectiveJoinRelationIds,
  );
  const rawEdges=projectJoinMembershipEdges(declaredEdges,relations,effectiveJoinRelationIds,new Set(graphMessagesToRender.map(message=>message.id)));
  const visibleContainerIds=new Set(scopedMessages.map(message=>message.id));
  const cleanEdges = cleanVisibleIds
    ? rawEdges.filter(edge => cleanVisibleIds.visibleRelIds.has(edge.relationMessageId)||(getPresentationSpec(edge.relationType).isContainer&&visibleContainerIds.has(edge.relationMessageId)))
    : rawEdges;
  const homeEdges = homeFilterResult
    ? cleanEdges.filter(edge =>
      homeFilterResult.displayIds.has(edge.relationMessageId)
      && (edge.from.messageId.startsWith('anon:')
        || homeFilterResult.displayIds.has(edge.from.messageId)
        || homeFilterResult.matchIds.has(edge.to.messageId))
      && homeFilterResult.displayIds.has(edge.to.messageId),
    )
    : cleanEdges;

  return {
    messages: filteredMessages,
    scopedMessages,
    edges: homeEdges.filter(edge => !suppressedRelIds.has(edge.relationMessageId)),
  };
}
