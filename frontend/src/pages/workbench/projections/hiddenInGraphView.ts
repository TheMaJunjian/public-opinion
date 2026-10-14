import type {
  DemoEdge,
  DemoMessage
} from "../../../utils/modelBridge";

interface DeriveHiddenInGraphViewInput {
  messages: DemoMessage[];
  edges: DemoEdge[];
}

export function deriveHiddenInGraphView(input: DeriveHiddenInGraphViewInput): Set<string> {
  const { messages, edges } = input;
  const ids = new Set<string>();
  // 1) CORRECT relation messages are not rendered as independent cards
  for (const m of messages) {
    if (m.kind === 'relation' && m.relationType === 'correct' && !m.parts) ids.add(m.id);
  }
  // 2) Corrected text targets that are not themselves correction sources
  //    (GraphView.hiddenCorrectedTargetIds)
  const correctedTargets = new Set<string>();
  const correctionSources = new Set<string>();
  for (const e of edges) {
    if (e.relationType === 'correct' && !e.proposalOnly && !e.from.messageId.startsWith('anon:')) {
      correctedTargets.add(e.to.messageId);
      correctionSources.add(e.from.messageId);
    }
  }
  for (const id of correctedTargets) {
    if (!correctionSources.has(id)) ids.add(id);
  }
  // 3) Summary text targets that are not themselves summary sources
  //    (GraphView.hiddenSummaryTargetIds)
  const summaryRelMsgIds = new Set<string>();
  for (const e of edges) {
    if (e.relationType === 'summary') summaryRelMsgIds.add(e.relationMessageId);
  }
  for (const e of edges) {
    if (e.relationType === 'summary' && !summaryRelMsgIds.has(e.to.messageId)) {
      ids.add(e.to.messageId);
    }
  }
  return ids;
}
