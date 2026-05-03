import type { Message as BackendMessage, Relation as BackendRelation, TargetRef } from '../types';

export type MessageKind = "normal" | "relation";
export type RelationType =
  | "annotation"
  | "reference"
  | "reply"
  | "agree"
  | "disagree"
  | "support"
  | "rebut";
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
    agree: "赞同", disagree: "反对", support: "支持", rebut: "反驳",
    ANNOTATION: "注释", REFERENCE: "引用", REPLY: "回复",
    AGREE: "赞同", DISAGREE: "反对", SUPPORT: "支持", REBUT: "反驳",
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

  const demoMessages: DemoMessage[] = messages.map(m => ({
    id: m.id,
    author: m.createdBy.username,
    createdAt: m.createdAt,
    content: m.content,
    kind: "normal",
  }));

  const demoEdges: DemoEdge[] = [];
  const relationMsgIds = new Set<string>();

  for (const rel of relations) {
    const relMsgId = `rel:${rel.id}`;
    const relType = rel.relationType.toLowerCase() as RelationType;

    if (!relationMsgIds.has(relMsgId)) {
      relationMsgIds.add(relMsgId);
      const typeName = relationTypeName(rel.relationType);
      demoMessages.push({
        id: relMsgId,
        author: rel.createdBy.username,
        createdAt: rel.createdAt,
        content: `建立${typeName}关系：来自 ${rel.sourceMessageId}；标签：${relType}`,
        kind: "relation",
      });
    }

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
        toUnit = { messageId: `rel:${ref.relationId}`, selection: { kind: "edge", edgeId: `${rel.id}::${index}` } };
      }

      demoEdges.push({
        id: edgeId,
        relationMessageId: relMsgId,
        relationType: relType,
        from: { messageId: rel.sourceMessageId, selection: { kind: "whole" } },
        to: toUnit,
        relationLabel: relType,
      });
    });
  }

  return { messages: demoMessages, edges: demoEdges };
}

export function unitSelectionToTargetRef(unit: UnitSelection): TargetRef {
  const s = unit.selection;
  if (s.kind === 'whole') {
    if (unit.messageId.startsWith('rel:')) {
      return { kind: 'relation', relationId: unit.messageId.replace('rel:', '') };
    }
    return { kind: 'message', messageId: unit.messageId };
  }
  if (s.kind === 'text') {
    return { kind: 'text-fragment', messageId: unit.messageId, text: s.text, hash: hashText(s.text) };
  }
  // edge
  const relationId = unit.messageId.startsWith('rel:') ? unit.messageId.replace('rel:', '') : unit.messageId;
  return { kind: 'relation', relationId, part: 'label' };
}
