import { getPresentationSpec } from "../../../types";
import type {
  DemoEdge,
  DemoMessage
} from "../../../utils/modelBridge";
import { type TraceContainerMembership } from "../../../utils/traceProjection";
import type { TraceEntry } from "../types";

interface DeriveTraceFrameIdsInput {
  traceRelationMsgIds: Set<string>;
  traceEntries: TraceEntry[];
  edges: DemoEdge[];
  traceContainerMemberships: TraceContainerMembership[];
  traceExpandableContainerIds: ReadonlySet<string>;
  msgMap: Map<string, DemoMessage>;
}

export function deriveTraceFrameIds(input: DeriveTraceFrameIdsInput): Set<string> {
  const { traceRelationMsgIds, traceEntries, edges, traceContainerMemberships, traceExpandableContainerIds, msgMap } = input; return new Set(
    [
      ...Array.from(traceRelationMsgIds),
      ...((traceEntries.length > 0
        ? edges
          .filter(edge => {
            if (!['classify', 'summary'].includes(edge.relationType.toLowerCase())) return false;
            const traceStartIds = traceEntries[traceEntries.length - 1].ids;
            return traceStartIds.includes(edge.from.messageId) || traceStartIds.includes(edge.to.messageId);
          })
          .map(edge => edge.relationMessageId)
        : [])),
      ...((traceEntries.length > 0
        ? traceContainerMemberships
          .filter(membership => traceEntries[traceEntries.length - 1].ids.some(id => membership.targetIds.includes(id)))
          .map(membership => membership.containerId)
        : [])),
      ...traceExpandableContainerIds,
    ].filter(id => {
      const relationType = msgMap.get(id)?.relationType;
      return relationType ? getPresentationSpec(relationType).isContainer : false;
    }),
  );
}
