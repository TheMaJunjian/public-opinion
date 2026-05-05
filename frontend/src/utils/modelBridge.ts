import type { Message as BackendMessage, Relation as BackendRelation, TargetRef } from '../types';

export type MessageKind = "normal" | "relation";
export type RelationType =
  | "annotation"
  | "reference"
  | "reply"
  | "agree"
  | "disagree"
  | "tag"
  | "correct"
  | "supplement";
export type SecondaryRelationType = "none" | "annotation" | "reference";

export type Selection =
  | { kind: "whole" }
  | { kind: "text"; start: number; len: number; text: string }
  | { kind: "edge"; edgeId: string };

export type UnitSelection = {
  messageId: string;
  selection: Selection;
};

export type DemoMessage = {
  id: string;
  author: string;
  createdAt: string;
  content: string;
  kind: MessageKind;
};

export type DemoEdge = {
  id: string;
  relationMessageId: string;
  relationType: RelationType;
  from: UnitSelection;
  to: UnitSelection;
  relationLabel: string;
};

function hashText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(31, h) + text.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}

function relationTypeName(t: string): string {
  const names: Record<string, string> = {
    annotation: "注释", reference: "引用", reply: "回复",
    agree: "赞同", disagree: "反对", tag: "标注",
    correct: "更正", supplement: "补充",
    ANNOTATION: "注释", REFERENCE: "引用", REPLY: "回复",
    AGREE: "赞同", DISAGREE: "反对", TAG: "标注",
    CORRECT: "更正", SUPPLEMENT: "补充",
  };
  return names[t] ?? t;
}

function findTextInContent(content: string, text: string): { start: number; len: number } | null {
  const idx = content.indexOf(text);
  if (idx === -1) return null;
  return { start: idx, len: text.length };
}

export function convertMessagesToDemoModel(
  messages: BackendMessage[],
  relations: BackendRelation[]
): { messages: DemoMessage[]; edges: DemoEdge[] } {
  const msgContentMap = new Map(messages.map(m => [m.id, m.content]));
  // Build a set of relation IDs to detect when sourceMessageId references a relation message.
  const relationIds = new Set(relations.map(r => r.id));

  const demoMessages: DemoMessage[] = messages.map(m => ({
    id: m.id,
    author: m.createdBy.username,
    createdAt: m.createdAt,
    content: m.content,
    kind: "normal",
  }));

  const demoEdges: DemoEdge[] = [];
  const seenRelMsgIds = new Set<string>();

  for (const rel of relations) {
    // Relation messages use their plain backend ID — no synthetic prefix needed.
    const relMsgId = rel.id;
    const relType = rel.relationType.toLowerCase() as RelationType;

    if (!seenRelMsgIds.has(relMsgId)) {
      seenRelMsgIds.add(relMsgId);
      const typeName = relationTypeName(rel.relationType);
      demoMessages.push({
        id: relMsgId,
        author: rel.createdBy.username,
        createdAt: rel.createdAt,
        content: rel.sourceMessageId
          ? `建立${typeName}关系：来自 ${rel.sourceMessageId}；类型：${typeName}`
          : `建立${typeName}关系（无来源消息）；类型：${typeName}`,
        kind: "relation",
      });
    }

    // For pure-stance relations (no source message), we still create edges
    // from a virtual "anonymous" origin that points to the target.
    // If sourceMessageId references a relation message, use its plain ID (no prefix).
    const fromMessageId = rel.sourceMessageId
      ? (relationIds.has(rel.sourceMessageId)
          ? rel.sourceMessageId
          : rel.sourceMessageId)
      : `anon:${rel.id}`;

    // Deduplicate relation-type targetRefs by relationId to prevent duplicate arrows.
    const seenRelationTargetIds = new Set<string>();

    rel.targetRefs.forEach((ref, index) => {
      const edgeId = `${rel.id}::${index}`;
      let toUnit: UnitSelection;

      if (ref.kind === 'message') {
        toUnit = { messageId: ref.messageId, selection: { kind: "whole" } };
      } else if (ref.kind === 'text-fragment') {
        const content = msgContentMap.get(ref.messageId) ?? '';
        const pos = findTextInContent(content, ref.text);
        toUnit = pos
          ? { messageId: ref.messageId, selection: { kind: "text", start: pos.start, len: pos.len, text: ref.text } }
          : { messageId: ref.messageId, selection: { kind: "whole" } };
      } else {
        // Skip duplicate relation targetRefs pointing to the same relationId.
        if (seenRelationTargetIds.has(ref.relationId)) return;
        seenRelationTargetIds.add(ref.relationId);
        // Relation messages use their plain backend ID — no synthetic prefix.
        toUnit = { messageId: ref.relationId, selection: { kind: "whole" } };
      }

      demoEdges.push({
        id: edgeId,
        relationMessageId: relMsgId,
        relationType: relType,
        from: { messageId: fromMessageId, selection: { kind: "whole" } },
        to: toUnit,
        relationLabel: relType,
      });
    });
  }

  // Sort all messages (normal + relation) by creation time so the linear view
  // shows them in send order after exit-and-reenter.
  demoMessages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return { messages: demoMessages, edges: demoEdges };
}

/**
 * Convert a UnitSelection back to a backend TargetRef.
 *
 * Requires the message map to determine whether a messageId refers to a text
 * message or a relation message — no synthetic ID prefix is used.
 */
export function unitSelectionToTargetRef(
  unit: UnitSelection,
  msgMap: Map<string, DemoMessage>
): TargetRef {
  const s = unit.selection;
  if (s.kind === 'whole') {
    if (msgMap.get(unit.messageId)?.kind === "relation") {
      return { kind: 'relation', relationId: unit.messageId };
    }
    return { kind: 'message', messageId: unit.messageId };
  }
  if (s.kind === 'text') {
    return { kind: 'text-fragment', messageId: unit.messageId, text: s.text, hash: hashText(s.text) };
  }
  // edge selection always targets a relation message's label/edge part
  return { kind: 'relation', relationId: unit.messageId, part: 'label' };
}

