import type {
  DemoEdge,
  DemoMessage,
  MessageKind
} from "../../../utils/modelBridge";
import { isContentKind } from "../../../utils/modelBridge";

interface DeriveCrossClassifyRefsInput {
  edges: DemoEdge[];
  msgMap: Map<string, DemoMessage>;
  graphVisibleTextIds: Set<string>;
}

export function deriveCrossClassifyRefs(input: DeriveCrossClassifyRefsInput): Map<string, { outgoing: Record<string, string[]>; incoming: Record<string, string[]>; }> {
  const { edges, msgMap, graphVisibleTextIds } = input;
  const raw = new Map<string, { outgoing: Record<string, Set<string>>; incoming: Record<string, Set<string>> }>();
  const labelOf = (raw: string): string => {
    const n = raw.trim().toLowerCase();
    if (n === "evidence" || n === "证据") return "证据";
    if (n === "ref" || n === "reference" || !n) return "引用";
    return raw; // custom label
  };
  for (const e of edges) {
    if (e.relationType !== 'reference') continue;
    const fromKind = msgMap.get(e.from.messageId)?.kind;
    const toKind = msgMap.get(e.to.messageId)?.kind;
    if (!isContentKind(fromKind as MessageKind) || !isContentKind(toKind as MessageKind)) continue;
    const fromVisible = graphVisibleTextIds.has(e.from.messageId);
    const toVisible = graphVisibleTextIds.has(e.to.messageId);
    if (fromVisible === toVisible) continue;
    const lbl = labelOf(e.relationLabel);
    if (fromVisible && !toVisible) {
      let entry = raw.get(e.from.messageId);
      if (!entry) { entry = { outgoing: {}, incoming: {} }; raw.set(e.from.messageId, entry); }
      (entry.outgoing[lbl] ??= new Set()).add(e.relationMessageId);
    } else if (!fromVisible && toVisible) {
      let entry = raw.get(e.to.messageId);
      if (!entry) { entry = { outgoing: {}, incoming: {} }; raw.set(e.to.messageId, entry); }
      (entry.incoming[lbl] ??= new Set()).add(e.relationMessageId);
    }
  }
  // 转换 Set → array 用于 props 传递
  const result = new Map<string, { outgoing: Record<string, string[]>; incoming: Record<string, string[]> }>();
  for (const [msgId, entry] of raw) {
    const out: Record<string, string[]> = {};
    for (const [lbl, ids] of Object.entries(entry.outgoing)) out[lbl] = Array.from(ids);
    const inc: Record<string, string[]> = {};
    for (const [lbl, ids] of Object.entries(entry.incoming)) inc[lbl] = Array.from(ids);
    result.set(msgId, { outgoing: out, incoming: inc });
  }
  return result;
}
