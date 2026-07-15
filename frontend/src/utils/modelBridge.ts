import type { Message as BackendMessage, Relation as BackendRelation, RelationPayload, TargetRef } from '../types';
import { getPresentationSpec, getRelationLabel, getRelationTitle } from '../types';

export type MessageKind = "normal" | "join" | "relation" | "round" | "round_result" | "governance" | "code" | "operations";

/** All content-like kinds (display as cards, participate in graph layout) */
export const CONTENT_KINDS: MessageKind[] = ["normal", "join", "round", "round_result", "governance", "code", "operations"];

export function isContentKind(k: MessageKind): boolean {
  return CONTENT_KINDS.includes(k as MessageKind);
}
export type RelationType =
  | "annotation"
  | "reference"
  | "reply"
  | "agree"
  | "disagree"
  | "tag"
  | "correct"
  | "arrange"
  | "classify"
  | "merge"
  | "summary"
  | "recommend"
  | "archive"
  | "proposal"
  | "code_change"
  | "operations";
export type SecondaryRelationType = "none" | "question" | "answer";

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
  backendKind?: string;
  settlementTargetId?: string;   // Phase 6: target message for ROUND/ROUND_RESULT
  roundPayload?: Record<string,unknown>;  // Phase 6: roundId/result for settlement highlight
  relationType?: RelationType;
  relationPayload?: RelationPayload;
  /** Join info for container-add records (加入容器消息) */
  joinInfo?: {
    containerId: string;
    containerType: string;  // CLASSIFY | SUMMARY | ARRANGE | MERGE
    targetIds: string[];
  };
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
    if (ref.kind === 'message') return ref.messageId;
    if (ref.kind === 'text-fragment') {
      const preview = ref.text.slice(0, 20) + (ref.text.length > 20 ? '…' : '');
      return `${ref.messageId}「${preview}」`;
    }
    const partStr = ref.part ? `（${ref.part}）` : '';
    return `${ref.relationId}${partStr}`;
  }).join(', ');
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

function mapBackendKind(backendKind: string): MessageKind {
  switch (backendKind) {
    case 'TEXT': return 'normal';
    case 'ROUND': return 'round';
    case 'ROUND_RESULT': return 'round_result';
    case 'GOVERNANCE': return 'governance';
    case 'CODE': return 'code';
    case 'OPERATIONS': return 'operations';
    case 'RELATION': return 'relation';
    default: return 'normal';
  }
}

export function kindLabel(backendKind: string, _targetRefs?: any, settlementType?: string): string {
  const isValue = settlementType === 'VALUE';
  const labels: Record<string, string> = {
    TEXT: '[文本消息]',
    GOVERNANCE: '🏛️ 治理提案\n—— 可投票/讨论/结算',
    CODE: '💻 代码\n—— 结算通过后将自动部署',
    OPERATIONS: '📊 运营\n—— 收入、统计等程序运营信息',
    ROUND: isValue
      ? '💎 发起价值仲裁\n—— 推荐/冷藏标注进入投票\n双击卡片查看结算详情'
      : '⚖️ 发起真假仲裁\n—— 目标消息进入投票阶段\n双击卡片查看结算详情',
    ROUND_RESULT: isValue
      ? '💎 价值仲裁结算完成\n—— 资金池已按投票结果分配\n双击卡片查看分账明细'
      : '⚖️ 真假仲裁结算完成\n—— 资金池已按投票结果分配\n双击卡片查看分账明细',
    RELATION: '[关系消息]',
  };
  return labels[backendKind] ?? `[${backendKind}]`;
}

function normalizeReplyAdditional(label: string | undefined): "reply" | "question" | "answer" {
  if (!label) return "reply";
  const normalized = label.trim().toLowerCase();
  if (normalized === "question" || normalized === "疑问") return "question";
  if (normalized === "answer" || normalized === "回答") return "answer";
  return "reply";
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

  const demoMessages: DemoMessage[] = messages.map(m => {
    const bk = (m as any).kind ?? 'TEXT';
    // Extract settlement target from ROUND/ROUND_RESULT targetRefs
    let settlementTargetId: string | undefined;
    let roundPayload: Record<string,unknown> | undefined;
    if (bk === 'ROUND' || bk === 'ROUND_RESULT') {
      const refs = (m as any).targetRefs as Array<{ messageId?: string }> | undefined;
      settlementTargetId = refs?.[0]?.messageId;
      roundPayload = (m as any).relationPayload as Record<string,unknown> | undefined;
    }
    const stype = roundPayload?.settlementType as string | undefined;
    return {
    id: m.id,
    author: m.createdBy.username,
    createdAt: m.createdAt,
    content: m.content ?? kindLabel(bk, undefined, stype),
    kind: mapBackendKind(bk),
    backendKind: bk,
    settlementTargetId,
    roundPayload,
  }});

  const demoEdges: DemoEdge[] = [];
  const seenRelMsgIds = new Set<string>();

  for (const rel of relations) {
    // Relation messages use their plain backend ID — no synthetic prefix needed.
    const relMsgId = rel.id;
    const relType: string = rel.relationType.toLowerCase();

    // JOIN relations: internal membership records — skip edge creation.
    const isJoin = relType === 'join';

    const tagLabel = relType === 'tag'
      ? getRelationLabel(rel.payload)
      : undefined;
    const classifyTitle = relType === 'classify'
      ? (getRelationTitle(rel.payload) || `分类（${rel.targetRefs.length}）`)
      : undefined;

    if (!seenRelMsgIds.has(relMsgId)) {
      seenRelMsgIds.add(relMsgId);
      const typeName = relationTypeName(rel.relationType);
      let content: string;
      let msgKind: DemoMessage['kind'] = 'relation';
      let joinInfo: DemoMessage['joinInfo'] | undefined;
      if (relType === 'join') {
        content = '加入容器';
        msgKind = 'join';
        joinInfo = {
          containerId: rel.sourceMessageId!,
          containerType: 'JOIN',
          targetIds: rel.targetRefs
            .filter(r => r.kind === 'message' || r.kind === 'text-fragment')
            .map(r => (r as { messageId: string }).messageId),
        };
      } else if (relType === 'classify') {
        content = `分类：${classifyTitle}\n目标：${targetRefsSummary(rel.targetRefs)}`;
      } else if (relType === 'tag' && tagLabel) {
        content = `标签「${tagLabel}」\n目标：${targetRefsSummary(rel.targetRefs)}`;
      } else if (rel.sourceMessageId) {
        content = `${typeName}  ${rel.sourceMessageId} → ${targetRefsSummary(rel.targetRefs)}`;
      } else {
        content = `${typeName}（无来源）\n目标：${targetRefsSummary(rel.targetRefs)}`;
      }
      demoMessages.push({
        id: relMsgId,
        author: rel.createdBy.username,
        createdAt: rel.createdAt,
        content,
        kind: msgKind,
        relationType: relType as RelationType,
        relationPayload: rel.payload,
        joinInfo,
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
      relType === 'tag'
        ? (tagLabel ?? getPresentationSpec('tag').label)
        : relType === 'reply'
          ? normalizeReplyAdditional(getRelationLabel(rel.payload))
          : relType === 'reference'
            ? (getRelationLabel(rel.payload) ?? relType)
            : relType;

    // Deduplicate relation-type targetRefs by relationId to prevent duplicate arrows.
    const seenRelationTargetIds = new Set<string>();

    if (!isJoin) {
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
        relationType: relType as RelationType,
        from: { messageId: fromMessageId, selection: { kind: "whole" } },
        to: toUnit,
        relationLabel,
      });
    });
    } // !isJoin
  }

  // Create edges from GOVERNANCE/CODE messages that have relationType and targetRefs
  // (PROPOSAL / CODE_CHANGE sent via the relation creation path).
  for (const m of messages) {
    const bk = (m as any).kind as string | undefined;
    if (bk !== 'GOVERNANCE' && bk !== 'CODE') continue;
    const relType = (m as any).relationType as string | undefined;
    const targetRefs = (m as any).targetRefs as TargetRef[] | undefined;
    if (!relType || !targetRefs || targetRefs.length === 0) continue;

    const lowerRelType = relType.toLowerCase() as RelationType;
    const relMsgId = m.id;
    const relationLabel: string = lowerRelType;

    const seenRelationTargetIds = new Set<string>();
    targetRefs.forEach((ref, index) => {
      const edgeId = `${relMsgId}::gov::${index}`;
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
        if (seenRelationTargetIds.has(ref.relationId)) return;
        seenRelationTargetIds.add(ref.relationId);
        toUnit = { messageId: ref.relationId, selection: { kind: "whole" } };
      }
      demoEdges.push({
        id: edgeId,
        relationMessageId: relMsgId,
        relationType: lowerRelType,
        from: { messageId: relMsgId, selection: { kind: "whole" } },
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

/**
 * Build a map from stance relation message ID → { targetId, type }.
 * A relation message is a "stance" if its relationType is agree or disagree.
 * Used by computeUserSuppressedRelIds and computeTransitiveVoteStats to walk
 * stance chains to their ultimate target.
 */
function buildStanceTargetMap(
  edges: DemoEdge[],
  msgMap: Map<string, DemoMessage>
): Map<string, { targetId: string; type: 'agree' | 'disagree' }> {
  const stanceMap = new Map<string, { targetId: string; type: 'agree' | 'disagree' }>();
  for (const [id, msg] of msgMap) {
    if (msg.kind !== 'relation') continue;
    if (msg.relationType !== 'agree' && msg.relationType !== 'disagree') continue;
    for (const e of edges) {
      if (e.relationMessageId === id && e.relationType === msg.relationType) {
        stanceMap.set(id, { targetId: e.to.messageId, type: msg.relationType as 'agree' | 'disagree' });
        break;
      }
    }
  }
  return stanceMap;
}

/**
 * Walk up the stance chain to find the ultimate non-stance target and effective type.
 * Each DISAGREE hop flips the effective stance.
 * Returns null if chain is too deep or circular.
 */
function resolveUltimateStance(
  startTargetId: string,
  startType: 'agree' | 'disagree',
  stanceMap: Map<string, { targetId: string; type: 'agree' | 'disagree' }>
): { targetId: string; type: 'agree' | 'disagree' } | null {
  const MAX_DEPTH = 20;
  const visited = new Set<string>();
  let currentId = startTargetId;
  let effectiveType: 'agree' | 'disagree' = startType;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const next = stanceMap.get(currentId);
    if (!next) break;
    if (visited.has(currentId)) return null;
    visited.add(currentId);

    if (next.type === 'disagree') {
      effectiveType = effectiveType === 'agree' ? 'disagree' : 'agree';
    }
    currentId = next.targetId;
  }
  return { targetId: currentId, type: effectiveType };
}

/**
 * Compute the set of relation message IDs that are suppressed for the current user.
 *
 * Walks the user's entire stance chain transitively: for every AGREE/DISAGREE
 * the user has sent, the chain is followed to its ultimate target, flipping
 * the effective stance on each DISAGREE hop.  The latest (by time) effective
 * stance on each ultimate target determines whether it is suppressed.
 *
 * Examples:
 *   DISAGREE rel-arr                          → suppress rel-arr
 *   AGREE rel-arr                             → don't suppress
 *   DISAGREE (AGREE rel-arr)                  → suppress rel-arr (flip once)
 *   DISAGREE (DISAGREE rel-arr)               → don't suppress (flip twice)
 *   AGREE (DISAGREE rel-arr)                  → suppress rel-arr (flip once)
 *   AGREE (AGREE rel-arr)                     → don't suppress
 */
export function computeUserSuppressedRelIds(
  edges: DemoEdge[],
  messages: DemoMessage[],
  currentUsername: string | null
): Set<string> {
  const empty = new Set<string>();
  if (!currentUsername) return empty;

  const msgMap = new Map(messages.map(m => [m.id, m]));
  const stanceMap = buildStanceTargetMap(edges, msgMap);

  // For each ultimate target, track the user's latest effective stance.
  const latestEffective = new Map<string, { type: 'agree' | 'disagree'; time: number }>();

  for (const e of edges) {
    if (e.relationType !== 'agree' && e.relationType !== 'disagree') continue;

    // Determine author.
    let author: string | undefined;
    const fromMsg = msgMap.get(e.from.messageId);
    if (fromMsg) {
      author = fromMsg.author;
    } else if (e.from.messageId.startsWith('anon:')) {
      const relMsg = msgMap.get(e.relationMessageId);
      author = relMsg?.author;
    }
    if (!author || author !== currentUsername) continue;

    // Determine time.
    let time = 0;
    if (fromMsg) {
      time = new Date(fromMsg.createdAt).getTime();
    } else {
      const relMsg = msgMap.get(e.relationMessageId);
      time = relMsg ? new Date(relMsg.createdAt).getTime() : 0;
    }

    // Walk the chain to the ultimate target.
    const resolved = resolveUltimateStance(e.to.messageId, e.relationType as 'agree' | 'disagree', stanceMap);
    const ultimateTarget = resolved ? resolved.targetId : e.to.messageId;
    const effectiveType = resolved ? resolved.type : e.relationType as 'agree' | 'disagree';

    const prev = latestEffective.get(ultimateTarget);
    if (!prev || time > prev.time) {
      latestEffective.set(ultimateTarget, { type: effectiveType, time });
    }
  }

  const suppressed = new Set<string>();
  for (const [relId, stance] of latestEffective) {
    if (stance.type === 'disagree') suppressed.add(relId);
  }
  return suppressed;
}

/**
 * Compute the current user's active stance relation message for each ultimate target.
 *
 * Walks the user's stance chains transitively (same as computeUserSuppressedRelIds).
 * Returns a Map from ultimate target ID → the user's own relation message that is
 * the latest effective stance, along with the effective type.
 *
 * This enables bidirectional visual linking in the list view:
 *   - The target shows "已反对" / "已赞同"
 *   - The active stance message shows "你的反对生效中" / "你的赞同生效中"
 */
export function computeUserActiveStanceRelIds(
  edges: DemoEdge[],
  messages: DemoMessage[],
  currentUsername: string | null
): Map<string, { relMsgId: string; type: 'agree' | 'disagree' }> {
  const empty = new Map<string, { relMsgId: string; type: 'agree' | 'disagree' }>();
  if (!currentUsername) return empty;

  const msgMap = new Map(messages.map(m => [m.id, m]));
  const stanceMap = buildStanceTargetMap(edges, msgMap);

  // For each ultimate target, track the user's latest effective stance and which
  // of the user's own stance messages caused it.
  const latest = new Map<string, { relMsgId: string; type: 'agree' | 'disagree'; time: number }>();

  for (const e of edges) {
    if (e.relationType !== 'agree' && e.relationType !== 'disagree') continue;

    let author: string | undefined;
    const fromMsg = msgMap.get(e.from.messageId);
    if (fromMsg) {
      author = fromMsg.author;
    } else if (e.from.messageId.startsWith('anon:')) {
      const relMsg = msgMap.get(e.relationMessageId);
      author = relMsg?.author;
    }
    if (!author || author !== currentUsername) continue;

    let time = 0;
    if (fromMsg) {
      time = new Date(fromMsg.createdAt).getTime();
    } else {
      const relMsg = msgMap.get(e.relationMessageId);
      time = relMsg ? new Date(relMsg.createdAt).getTime() : 0;
    }

    const resolved = resolveUltimateStance(e.to.messageId, e.relationType as 'agree' | 'disagree', stanceMap);
    const ultimateTarget = resolved ? resolved.targetId : e.to.messageId;
    const effectiveType = resolved ? resolved.type : e.relationType as 'agree' | 'disagree';

    const prev = latest.get(ultimateTarget);
    if (!prev || time > prev.time) {
      latest.set(ultimateTarget, { relMsgId: e.relationMessageId, type: effectiveType, time });
    }
  }

  return latest;
}

/**
 * Compute the set of the current user's stance relation message IDs that are
 * overridden (no longer the active stance for their target).
 *
 * A stance message is "overridden" when the user has sent a later stance that
 * supersedes it — either directly on the same target or transitively through
 * the stance chain.  These messages are marked "已失效" in the list view.
 */
export function computeUserOverriddenStanceRelIds(
  edges: DemoEdge[],
  messages: DemoMessage[],
  currentUsername: string | null
): Set<string> {
  const empty = new Set<string>();
  if (!currentUsername) return empty;

  const msgMap = new Map(messages.map(m => [m.id, m]));
  const stanceMap = buildStanceTargetMap(edges, msgMap);

  // Collect ALL of the user's stance relation message IDs.
  const userStanceRelIds = new Set<string>();
  // For each, also record the ultimate target and time.
  const userStanceInfo = new Map<string, { ultimateTarget: string; time: number }>();

  for (const e of edges) {
    if (e.relationType !== 'agree' && e.relationType !== 'disagree') continue;

    let author: string | undefined;
    const fromMsg = msgMap.get(e.from.messageId);
    if (fromMsg) {
      author = fromMsg.author;
    } else if (e.from.messageId.startsWith('anon:')) {
      const relMsg = msgMap.get(e.relationMessageId);
      author = relMsg?.author;
    }
    if (!author || author !== currentUsername) continue;

    let time = 0;
    if (fromMsg) {
      time = new Date(fromMsg.createdAt).getTime();
    } else {
      const relMsg = msgMap.get(e.relationMessageId);
      time = relMsg ? new Date(relMsg.createdAt).getTime() : 0;
    }

    const resolved = resolveUltimateStance(e.to.messageId, e.relationType as 'agree' | 'disagree', stanceMap);
    const ultimateTarget = resolved ? resolved.targetId : e.to.messageId;

    userStanceRelIds.add(e.relationMessageId);
    const prev = userStanceInfo.get(e.relationMessageId);
    if (!prev || time > prev.time) {
      userStanceInfo.set(e.relationMessageId, { ultimateTarget, time });
    }
  }

  // For each ultimate target, find the latest stance (the active one).
  const activePerTarget = new Map<string, string>(); // ultimateTarget → active relMsgId
  for (const [relMsgId, info] of userStanceInfo) {
    const prev = activePerTarget.get(info.ultimateTarget);
    if (!prev) {
      activePerTarget.set(info.ultimateTarget, relMsgId);
    } else {
      const prevTime = userStanceInfo.get(prev)?.time ?? 0;
      if (info.time > prevTime) {
        activePerTarget.set(info.ultimateTarget, relMsgId);
      }
    }
  }

  const activeIds = new Set(activePerTarget.values());
  const overridden = new Set<string>();
  for (const id of userStanceRelIds) {
    if (!activeIds.has(id)) overridden.add(id);
  }
  return overridden;
}

/**
 * Filter edges based on the current user's latest stance on each relation message.
 *
 * Delegates to computeUserSuppressedRelIds for the suppression logic,
 * then filters out all edges whose relationMessageId is suppressed.
 *
 * Returns the filtered edge array.  When currentUsername is null (not logged in),
 * all edges are returned unfiltered.
 */
export function computeUserFilteredEdges(
  edges: DemoEdge[],
  messages: DemoMessage[],
  currentUsername: string | null
): DemoEdge[] {
  const suppressedRelIds = computeUserSuppressedRelIds(edges, messages, currentUsername);
  if (suppressedRelIds.size === 0) return edges;
  return edges.filter(e => !suppressedRelIds.has(e.relationMessageId));
}

/**
 * Compute transitive agree/disagree stats for relation-message decorations.
 *
 * Like computeTransitiveVoteStats, but returns a Map keyed by ultimate target
 * relation ID, with both the transitive counts AND the original (direct)
 * stance relation message IDs for use in detail popups.
 */
export function computeTransitiveRelDecStats(
  edges: DemoEdge[],
  messages: DemoMessage[]
): Map<string, { agreeCount: number; disagreeCount: number; agreeRelMsgIds: string[]; disagreeRelMsgIds: string[] }> {
  const msgMap = new Map(messages.map(m => [m.id, m]));
  const stanceMap = buildStanceTargetMap(edges, msgMap);

  const result = new Map<string, { agreeCount: number; disagreeCount: number; agreeRelMsgIds: string[]; disagreeRelMsgIds: string[] }>();
  const ensure = (mid: string) => {
    let entry = result.get(mid);
    if (!entry) { entry = { agreeCount: 0, disagreeCount: 0, agreeRelMsgIds: [], disagreeRelMsgIds: [] }; result.set(mid, entry); }
    return entry;
  };

  for (const e of edges) {
    if (e.relationType !== 'agree' && e.relationType !== 'disagree') continue;
    if (e.to.selection.kind !== 'whole') continue;
    const toMsg = msgMap.get(e.to.messageId);
    if (toMsg?.kind !== 'relation') continue;

    const resolved = resolveUltimateStance(e.to.messageId, e.relationType as 'agree' | 'disagree', stanceMap);
    const targetId = resolved ? resolved.targetId : e.to.messageId;
    const effectiveType = resolved ? resolved.type : e.relationType as 'agree' | 'disagree';

    const entry = ensure(targetId);
    if (effectiveType === 'agree') {
      entry.agreeCount++;
      entry.agreeRelMsgIds.push(e.relationMessageId);
    } else {
      entry.disagreeCount++;
      entry.disagreeRelMsgIds.push(e.relationMessageId);
    }
  }

  return result;
}

/**
 * Compute transitive agree/disagree counts for each message.
 *
 * Unlike simple voteStats (which only counts direct stances), this follows
 * chains of meta-stances and projects them onto the original target.
 *
 * Rule: for each agree/disagree edge, walk the target chain upward using
 * resolveUltimateStance.  Each DISAGREE hop flips the effective stance.
 * The final effective stance is counted against the ultimate target.
 *
 * Examples:
 *   DISAGREE on rel-arr                       → +1 disagree on rel-arr
 *   AGREE on DISAGREE on rel-arr              → +1 disagree on rel-arr
 *   DISAGREE on DISAGREE on rel-arr           → +1 agree on rel-arr
 *   DISAGREE on AGREE on rel-arr              → +1 disagree on rel-arr
 *   AGREE on AGREE on rel-arr                 → +1 agree on rel-arr
 *
 * Returns: Record<messageId, { agreeCount, disagreeCount, agreeKey, disagreeKey }>
 */
export function computeTransitiveVoteStats(
  edges: DemoEdge[],
  messages: DemoMessage[]
): Record<string, { agreeCount: number; disagreeCount: number; agreeKey: string; disagreeKey: string }> {
  const msgMap = new Map(messages.map(m => [m.id, m]));
  const stanceMap = buildStanceTargetMap(edges, msgMap);

  const res: Record<string, { agreeCount: number; disagreeCount: number; agreeKey: string; disagreeKey: string }> = {};
  const ensure = (mid: string) => {
    if (!res[mid]) res[mid] = { agreeCount: 0, disagreeCount: 0, agreeKey: `dec:agree:${mid}`, disagreeKey: `dec:disagree:${mid}` };
    return res[mid];
  };

  for (const e of edges) {
    if (e.relationType !== 'agree' && e.relationType !== 'disagree') continue;
    if (e.to.selection.kind !== 'whole') continue;

    const resolved = resolveUltimateStance(e.to.messageId, e.relationType as 'agree' | 'disagree', stanceMap);
    const targetId = resolved ? resolved.targetId : e.to.messageId;
    const effectiveType = resolved ? resolved.type : e.relationType as 'agree' | 'disagree';

    const entry = ensure(targetId);
    if (effectiveType === 'agree') entry.agreeCount++;
    else entry.disagreeCount++;
  }

  return res;
}
