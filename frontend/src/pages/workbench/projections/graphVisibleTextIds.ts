import type { Relation } from "../../../types";
import type {
  DemoMessage
} from "../../../utils/modelBridge";
import { isContentKind } from "../../../utils/modelBridge";
import { getRelationTargetIds, getTextTargetIds } from '../model/relationComposition';
import type { TraceEntry } from "../types";

interface DeriveGraphVisibleTextIdsInput {
  isInsideClassify: boolean;
  currentClassifyRelMsgId: string | null;
  traceEntries: TraceEntry[];
  relationById: Map<string, Relation>;
  msgMap: Map<string, DemoMessage>;
  messages: DemoMessage[];
  graphHiddenTextIds: Set<string>;
  graphOwnedRelationIds: Set<string>;
}

export function deriveGraphVisibleTextIds(input: DeriveGraphVisibleTextIdsInput): Set<string> {
  const { isInsideClassify, currentClassifyRelMsgId, traceEntries, relationById, msgMap, messages, graphHiddenTextIds, graphOwnedRelationIds } = input;
  // Trace mode always renders from the trace window on the main canvas.
  // Do not let a stale classify state from the same React transition project
  // the selected nested message back into an empty parent frame.
  if (isInsideClassify && currentClassifyRelMsgId && traceEntries.length === 0) {
    const classificationRelation = relationById.get(currentClassifyRelMsgId);
    if (!classificationRelation) return new Set<string>();
    const ids = new Set<string>(getTextTargetIds(classificationRelation.targetRefs));
    // Also include content-kind relation targets (governance/code/ops)
    // so REFERENCE edges from them are not treated as cross-classify.
    for (const relId of getRelationTargetIds(classificationRelation.targetRefs)) {
      const m = msgMap.get(relId);
      if (m && isContentKind(m.kind)) ids.add(relId);
    }
    return ids;
  }
  // 主画布：visible = NOT in hiddenTextIds
  const visible = new Set<string>();
  for (const m of messages) {
    if (isContentKind(m.kind) && !graphHiddenTextIds.has(m.id) && !graphOwnedRelationIds.has(m.id)) visible.add(m.id);
  }
  return visible;
}
