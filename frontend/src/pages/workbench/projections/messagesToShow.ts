import type {
  DemoEdge,
  DemoMessage
} from "../../../utils/modelBridge";
import { applyTraceFrameVisibility, buildTraceProjection, type TraceContainerMembership } from "../../../utils/traceProjection";
import type { TraceEntry } from "../types";

interface DeriveMessagesToShowInput {
  traceEntries: TraceEntry[];
  messages: DemoMessage[];
  edges: DemoEdge[];
  traceContainerMemberships: TraceContainerMembership[];
  effectiveSuppressedRelIdsForLayout: Set<string>;
  traceDistance: number;
  traceExpandedFrameIds: Set<string>;
}

export function deriveMessagesToShow(input: DeriveMessagesToShowInput): { messagesToShow: DemoMessage[]; edgesToShow: DemoEdge[]; traceExpandableContainerIds: ReadonlySet<string>; } {
  const { traceEntries, messages, edges, traceContainerMemberships, effectiveSuppressedRelIdsForLayout, traceDistance, traceExpandedFrameIds } = input;
  if (traceEntries.length === 0) {
    return {
      messagesToShow: messages,
      edgesToShow: edges,
      traceExpandableContainerIds: new Set<string>(),
    };
  }
  const startIds = traceEntries[traceEntries.length - 1].ids.filter(Boolean);
  if (startIds.length === 0) {
    return {
      messagesToShow: messages,
      edgesToShow: edges,
      traceExpandableContainerIds: new Set<string>(),
    };
  }
  const traceProjection = buildTraceProjection({
    messages,
    edges,
    containerMemberships: traceContainerMemberships,
    excludedRelationIds: effectiveSuppressedRelIdsForLayout,
    startIds,
    distance: traceDistance,
  });
  const projection = applyTraceFrameVisibility(traceProjection, traceExpandedFrameIds);
  return {
    messagesToShow: projection.messages,
    edgesToShow: projection.edges,
    traceExpandableContainerIds: projection.expandableContainerIds,
  };
}
