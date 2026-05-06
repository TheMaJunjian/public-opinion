import type { Message as BackendMessage, Relation as BackendRelation, TargetRef } from '../types';
import { getPresentationSpec } from '../types';

export type MessageKind = "normal" | "relation";
export type RelationType =
  | "annotation"
  | "reference"
  | "reply"
  | "agree"
  | "disagree"
  | "tag"
  | "correct"
  | "supplement"
  | "classify"
  | "merge"
  | "summary"
  | "recommend"
  | "archive";
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

function targetRefsSummary(targetRefs: TargetRef[]): string {
  if (targetRefs.length === 0) return '（无目标）';
  return targetRefs.map(ref => {
    if (ref.kind === 'message') return `消息 ${ref.messageId}`;
    if (ref.kind === 'text-fragment') {
      const preview = ref.text.slice(0, 20) + (ref.text.length > 20 ? '…' : '');
      return `消息 ${ref.messageId} 的文本片段「${preview}」`;
    }
    const partStr = ref.part ? `（${ref.part}）` : '';
    return `关系 ${ref.relationId}${partStr}`;
  }).join('；');
}

function hashText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(31, h) + text.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}

function relationTypeName(t: string): string {
  return getPresentationSpec(t).label;
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

    // Resolve the effective tag label for TAG relations.
    // Prefer the dedicated tagLabel field (new-style); fall back to the source message's content
    // (legacy TAG relations that used a source text message to carry the label).
    let tagLabel: string | undefined;
    if (relType === 'tag') {
      tagLabel = rel.tagLabel ?? msgContentMap.get(rel.sourceMessageId ?? '') ?? undefined;
    }

    if (!seenRelMsgIds.has(relMsgId)) {
      seenRelMsgIds.add(relMsgId);
      const typeName = relationTypeName(rel.relationType);
      let content: string;
      if (relType === 'tag' && tagLabel) {
        content = `建立${typeName}关系「${tagLabel}」\n目标：${targetRefsSummary(rel.targetRefs)}`;
      } else if (rel.sourceMessageId) {
        content = `建立${typeName}关系\n来源：${rel.sourceMessageId}\n目标：${targetRefsSummary(rel.targetRefs)}`;
      } else {
        content = `建立${typeName}关系（无来源消息）\n目标：${targetRefsSummary(rel.targetRefs)}`;
      }
      demoMessages.push({
        id: relMsgId,
        author: rel.createdBy.username,
        createdAt: rel.createdAt,
        content,
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

    // For TAG relations, relationLabel carries the human-readable tag label text
    // rather than the bare type string, so all consumers can use it directly.
    const relationLabel: string =
      relType === 'tag' ? (tagLabel ?? getPresentationSpec('tag').label) : relType;

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
        relationLabel,
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

/**
 * Build a map from old relation-message ID → set of edge IDs that have been
 * corrected by a replacement relation (CORRECT with a non-anon source).
 *
 * Each CORRECT edge whose source is a real relation message (not anon:…) represents
 * a fragment-level or whole-relation correction.  The function matches each edge of
 * the new (replacement) relation to the corresponding edge of the old relation by
 * comparing their `to.messageId`, then records the old edge's ID as corrected.
 *
 * Used to hide only the corrected fragments while leaving uncorrected fragments of
 * the same relation message visible in the graph view.
 */
export function computeCorrectedEdgeMap(edges: DemoEdge[]): Map<string, Set<string>> {
  const edgesByRelMsg = new Map<string, DemoEdge[]>();
  for (const e of edges) {
    let arr = edgesByRelMsg.get(e.relationMessageId);
    if (!arr) { arr = []; edgesByRelMsg.set(e.relationMessageId, arr); }
    arr.push(e);
  }

  const result = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.relationType !== 'correct') continue;
    if (e.from.messageId.startsWith('anon:')) continue;
    // e.from.messageId = new (replacement) relation message
    // e.to.messageId   = old (corrected) relation message
    const newRelMsgId = e.from.messageId;
    const oldRelMsgId = e.to.messageId;
    const newEdges = edgesByRelMsg.get(newRelMsgId) ?? [];
    const oldEdges = edgesByRelMsg.get(oldRelMsgId) ?? [];
    // Index old edges by their target message ID for O(1) lookup.
    const oldEdgesByTarget = new Map<string, string[]>();
    for (const oe of oldEdges) {
      let arr = oldEdgesByTarget.get(oe.to.messageId);
      if (!arr) { arr = []; oldEdgesByTarget.set(oe.to.messageId, arr); }
      arr.push(oe.id);
    }
    // For each new (replacement) edge, mark the matching old edge(s) as corrected.
    for (const ne of newEdges) {
      const matchingOldIds = oldEdgesByTarget.get(ne.to.messageId) ?? [];
      for (const oldId of matchingOldIds) {
        let set = result.get(oldRelMsgId);
        if (!set) { set = new Set<string>(); result.set(oldRelMsgId, set); }
        set.add(oldId);
      }
    }
  }
  return result;
}

