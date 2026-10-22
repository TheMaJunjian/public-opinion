import type { Message as BackendMessage, Relation as BackendRelation, RelationPayload, TargetRef } from '../types';
import { resolveStance, type Message as CoreMessage, type Part, type Reference, type ExecutedStance, type MessageState } from '@gonglun/core';
import { getPresentationSpec, getRelationLabel, getRelationTitle } from '../types';

export type MessageKind = "normal" | "join" | "relation" | "round" | "round_result" | "governance" | "code" | "operations";

/** All content-like kinds (display as cards, participate in graph layout) */
export const CONTENT_KINDS: MessageKind[] = ["normal", "join", "round", "round_result", "governance", "code", "operations"];
export const READABLE_RELATION_TYPES = new Set([
  'summary', 'classify', 'proposal', 'delegation', 'code_change', 'operations',
]);

/** Imported CORRECT records already used legacy voting; they are not new authorization proposals. */
export function isCorrectionProposal(message: { parts?: Part[]; relationPayload?: RelationPayload | null; payload?: RelationPayload }): boolean {
  const imported = message.parts?.some(part => part.type === 'data' && part.value && typeof part.value === 'object'
    && !Array.isArray(part.value) && typeof part.value.legacyTopicId === 'string' && part.value.uiType === 'CORRECT');
  const payload = message.relationPayload ?? message.payload;
  const nativeText = message.parts?.some(part => part.type === 'data' && part.value && typeof part.value === 'object' && !Array.isArray(part.value)
    && part.value.uiType === 'CORRECT' && typeof part.value.value === 'string');
  // Previously sent text amendments also get the lightweight display behavior
  // once the server projects their full original/replacement bodies.
  const textCorrection = nativeText || typeof payload?.correctionBeforeContent === 'string' && typeof payload.correctionAfterContent === 'string';
  return !imported && !textCorrection && !!message.parts?.some(part => part.type === 'relation' && part.relation === 'amend');
}

/** Project readable text for this viewer without changing the stored message or its identity. */
export function withCorrectionContent(message: DemoMessage, content: string, changes?: CorrectionVersion['changes']): DemoMessage {
  if (message.content === content) return message;
  const readable = message.parts?.filter(part => ['text', 'code', 'web'].includes(part.type));
  let offset = 0;
  return { ...message, content,
    ...(['classify', 'summary'].includes(message.relationType ?? '') ? { relationPayload: { ...message.relationPayload, title: content } } : {}),
    ...(readable?.length ? { parts: message.parts!.map(part => {
      if (part.type !== 'text' && part.type !== 'code' && part.type !== 'web') return part;
      const original = part.type === 'text' ? part.text : part.type === 'code' ? part.source : part.excerpt || part.url;
      let value = readable.length === 1 ? content : original;
      if (readable.length > 1) for (const change of [...(changes ?? [])].sort((a,b) => b.start-a.start || b.end-a.end)) {
        if (change.start >= offset && change.end <= offset + original.length) {
          value = value.slice(0, change.start-offset) + change.replacement + value.slice(change.end-offset);
        }
      }
      offset += original.length + 1;
      return part.type === 'text' ? { ...part, text: value } : part.type === 'code' ? { ...part, source: value } : { ...part, excerpt: value };
    }) } : {}) };
}


/** Message kinds that are rendered as readable cards in the graph. */
export function hasReadableMessageContent(message: {relationType?:string;parts?:Part[]}) {
  const type=message.relationType?.toLowerCase()??'';
  // Organization bodies belong to their scope card or frame header.
  if(type==='merge'||type==='arrange'||type==='correct')return false;
  const metadata=message.parts?.some(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)&&'legacyTopicId' in part.value&&part.value.kind==='RELATION');
  if(metadata&&!READABLE_RELATION_TYPES.has(type)&&type!=='correct')return false;
  return !!message.parts?.some(part => part.type === 'text' && part.text.trim().length > 0 || part.type === 'code' || part.type === 'web' || part.type === 'relation' && part.relation === 'amend');
}
export function isCardMessage(message: { kind: MessageKind; relationType?: string; parts?: Part[] } | undefined): boolean {
  return !!message && (isContentKind(message.kind)
    || hasReadableMessageContent(message)
    || (message.kind === 'relation' && READABLE_RELATION_TYPES.has((message.relationType ?? '').toLowerCase())));
}

export function isContentKind(k: MessageKind): boolean {
  return CONTENT_KINDS.includes(k as MessageKind);
}

/** Messages with readable content that should consume one trace-distance hop. */
export function isTraceTextLikeMessage(message: { kind: MessageKind; relationType?: string } | undefined): boolean {
  if (!message) return false;
  return isCardMessage(message);
}
export type RelationType =
  | "annotation"
  | "reference"
  | "reply"
  | "notify"
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
  | "attention"
  | "block"
  | "proposal"
  | "delegation"
  | "code_change"
  | "operations"
  | "authorize";
export type SecondaryRelationType = "none" | "question" | "answer";

export type Selection =
  | { kind: "whole" }
  | { kind: "text"; start: number; len: number; text: string }
  | { kind: "edge"; edgeId: string };

export type UnitSelection = {
  messageId: string;
  selection: Selection;
  /** Exact address. The legacy selection is only the workbench's visual shorthand. */
  reference?: Reference;
  label?: string;
};

export type DemoMessage = {
  id: string;
  revision?: number;
  parts?: Part[];
  executedStance?: ExecutedStance;
  state?: MessageState;
  spending?: CoreMessage['spending'];
  author: string;
  authorId?: string;
  createdAt: string;
  content: string;
  kind: MessageKind;
  backendKind?: string;
  sourceMessageId?: string | null;
  sourceRefs?: Reference[];
  settlementTargetId?: string;   // Phase 6: target message for ROUND/ROUND_RESULT
  roundPayload?: Record<string,unknown>;  // Phase 6: roundId/result for settlement highlight
  relationType?: RelationType;
  relationPayload?: RelationPayload;
  targetRefs?: TargetRef[];
  declaredTargetRefs?:TargetRef[];
  /** Join info for container-add records (加入容器消息) */
  joinInfo?: {
    containerId: string;
    containerType: string;  // CLASSIFY | SUMMARY | ARRANGE | MERGE
    targetIds: string[];
  };
};

export type CorrectionVersion = {
  changes?: Array<{ start: number; end: number; replacement: string }>;
  appliedCorrectionIds?: string[];
  recommendationTied?: boolean;
  reference?: Reference;
  correctionKind?: 'TEXT' | 'MEANING';
  correctionId: string;
  targetId: string;
  baseContent: string;
  content: string;
  valid: boolean;
  createdAt: string;
  selection?: Selection;
  conflicted?: boolean;
};

export function resolveCorrectionContent(
  originalContent: string,
  baseContent: string,
  rawCorrectionContent: string,
  selection: Selection | undefined,
): string {
  if (selection?.kind !== 'text') return rawCorrectionContent;
  const baseMatches = baseContent.slice(selection.start, selection.start + selection.len) === selection.text;
  const originalMatches = originalContent.slice(selection.start, selection.start + selection.len) === selection.text;
  const baseHasContext = baseMatches && rawCorrectionContent.startsWith(baseContent.slice(0, selection.start))
    && rawCorrectionContent.endsWith(baseContent.slice(selection.start + selection.len));
  const originalHasContext = originalMatches && rawCorrectionContent.startsWith(originalContent.slice(0, selection.start))
    && rawCorrectionContent.endsWith(originalContent.slice(selection.start + selection.len));
  const usesBaseContext = baseHasContext && !originalHasContext;
  const contextContent = usesBaseContext ? baseContent : originalContent;
  const start = Math.max(0, Math.min(selection.start, contextContent.length));
  const end = Math.max(start, Math.min(start + selection.len, contextContent.length));
  if (contextContent.slice(start, end) !== selection.text) return rawCorrectionContent;
  const baseStart = usesBaseContext ? start : baseContent.indexOf(selection.text);
  if (baseStart < 0) return rawCorrectionContent;
  const hasContext = rawCorrectionContent.startsWith(contextContent.slice(0, start))
    && rawCorrectionContent.endsWith(contextContent.slice(end));
  const replacement = hasContext
    ? rawCorrectionContent.slice(start, rawCorrectionContent.length - (contextContent.length - end))
    : rawCorrectionContent.slice(start, start + selection.len);
  return baseContent.slice(0, baseStart) + replacement + baseContent.slice(baseStart + selection.len);
}

export function correctionSelectionIsStale(content: string, selection: Selection | undefined): boolean {
  return selection?.kind === 'text'
    && content.slice(selection.start, selection.start + selection.len) !== selection.text;
}

export function demoMessageToRelation(message: DemoMessage): BackendRelation | null {
  if (!['governance', 'code', 'operations'].includes(message.kind)
    || !message.relationType || !message.targetRefs) return null;
  return {
    id: message.id,
    revision: message.revision,
    parts: message.parts,
    executedStance: message.executedStance,
    state: message.state,
    spending: message.spending,
    relationType: message.relationType.toUpperCase(),
    sourceMessageId: message.sourceMessageId ?? null,
    sourceRefs: message.sourceRefs,
    targetRefs: message.targetRefs,
    payload: message.relationPayload,
    createdAt: message.createdAt,
    createdBy: {
      id: '',
      username: message.author,
      createdAt: message.createdAt,
    },
  };
}

export type DemoEdge = {
  proposalOnly?: boolean;
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
    CODE: '💻 代码\n—— 修改代码并部署后生效',
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
  if (!text) return null;
  const idx = content.indexOf(text);
  return idx === -1 ? null : { start: idx, len: text.length };
}

export function convertMessagesToDemoModel(
  messages: BackendMessage[],
  relations: BackendRelation[]
): { messages: DemoMessage[]; edges: DemoEdge[] } {
  const sequenceById = new Map([...relations, ...messages].map(record => [record.id, record.sequence ?? 0]));
  const byCreation = (a: { id: string; createdAt: string }, b: { id: string; createdAt: string }) =>
    (Date.parse(a.createdAt) - Date.parse(b.createdAt) || 0)
    || (sequenceById.get(a.id) ?? 0) - (sequenceById.get(b.id) ?? 0) || a.id.localeCompare(b.id);
  // API pagination and archive queries return different orders. Equal timestamps
  // must not change card order, relation precedence, or graph layout on reopening.
  messages = [...messages].sort(byCreation);
  relations = [...relations].sort(byCreation);
  const msgContentMap = new Map(messages.map(m => [m.id, m.content]));
  const messageById=new Map(messages.map(message=>[message.id,message]));
  // Build a set of relation IDs to detect when sourceMessageId references a relation message.
  const relationIds = new Set(relations.map(r => r.id));
  const relationById = new Map(relations.map(relation => [relation.id, relation]));

  const demoMessages: DemoMessage[] = messages.filter(m => (m as any).kind !== 'RELATION').map(m => {
    const bk = (m as any).kind ?? 'TEXT';
    const persistedRelation = relationById.get(m.id);
    // Extract settlement target from ROUND/ROUND_RESULT targetRefs
    let settlementTargetId: string | undefined;
    let roundPayload: Record<string,unknown> | undefined;
    if (bk === 'ROUND' || bk === 'ROUND_RESULT') {
      const ref = m.targetRefs?.[0];
      roundPayload = (m as any).relationPayload as Record<string,unknown> | undefined;
      settlementTargetId = typeof roundPayload?.subjectId === 'string' ? roundPayload.subjectId
        : ref?.reference?.messageId ?? (ref?.kind === 'relation' ? ref.relationId : ref?.messageId);
    }
    const stype = roundPayload?.settlementType as string | undefined;
    return {
    id: m.id,
    revision: m.revision,
    parts: m.parts,
    executedStance: m.executedStance,
    state: m.state,
    spending: m.spending,
    author: m.createdBy.username,
    authorId: m.createdBy.id,
    createdAt: m.createdAt,
    content: m.content ?? kindLabel(bk, undefined, stype),
    kind: mapBackendKind(bk),
    backendKind: bk,
    sourceMessageId: (m as any).relSourceId ?? persistedRelation?.sourceMessageId ?? null,
    sourceRefs: persistedRelation?.sourceRefs,
    settlementTargetId,
    roundPayload,
      relationType: ((m as any).relationType ?? persistedRelation?.relationType)?.toLowerCase() as RelationType | undefined,
      relationPayload: (m as any).relationPayload ?? persistedRelation?.payload ?? undefined,
      targetRefs: (m as any).targetRefs ?? persistedRelation?.targetRefs ?? undefined,
      declaredTargetRefs:m.declaredTargetRefs??persistedRelation?.declaredTargetRefs,
  }});

  const demoEdges: DemoEdge[] = [];
  const seenRelMsgIds = new Set<string>();

  for (const rel of relations) {
    // Relation messages use their plain backend ID — no synthetic prefix needed.
    const relMsgId = rel.id;
    const relType: string = rel.relationType.toLowerCase();

    // Governance relations are persisted as content messages. The API may
    // still expose a compatibility relation projection, but it must not
    // create a second card for the same backend entity.
    const persistedMessage = messageById.get(rel.id);
    if (persistedMessage && (persistedMessage as any).kind !== 'RELATION') seenRelMsgIds.add(rel.id);

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
            .map(r => r.kind === 'relation' ? r.relationId : r.messageId),
        };
      } else if (relType === 'correct') {
        content = rel.payload?.correctionContent ?? '';
      } else if (relType === 'classify') {
        content = persistedMessage?.content ?? rel.parts?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? `分类：${classifyTitle}\n目标：${targetRefsSummary(rel.targetRefs)}`;
      } else if (relType === 'summary') {
        const summaryTitle = getRelationTitle(rel.payload) || `总结（${rel.targetRefs.length}）`;
        content = persistedMessage?.content ?? rel.parts?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? `总结：${summaryTitle}`;
      } else if (['proposal', 'delegation', 'code_change', 'operations'].includes(relType) && rel.payload?.content) {
        content = rel.payload.content;
      } else if (relType === 'tag' && tagLabel) {
        content = `标签「${tagLabel}」\n目标：${targetRefsSummary(rel.targetRefs)}`;
      } else if (relType === 'agree' || relType === 'disagree') {
        content = `目标：${targetRefsSummary(rel.targetRefs)}`;
      } else if (rel.sourceMessageId) {
        content = `${typeName}  ${rel.sourceMessageId} → ${targetRefsSummary(rel.targetRefs)}`;
      } else {
        content = `目标：${targetRefsSummary(rel.targetRefs)}`;
      }
      demoMessages.push({
        id: relMsgId,
        revision: rel.revision,
        parts: rel.parts,
        executedStance: rel.executedStance,
        state: rel.state,
        spending: rel.spending,
        author: rel.createdBy.username,
        authorId: rel.createdBy.id,
        createdAt: rel.createdAt,
        content,
        kind: msgKind,
        relationType: relType as RelationType,
        relationPayload: rel.payload,
        targetRefs: rel.targetRefs,
        declaredTargetRefs:rel.declaredTargetRefs,
        sourceMessageId: rel.sourceMessageId,
        sourceRefs: rel.sourceRefs,
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

      if (ref.reference) {
        toUnit = targetRefToUnit(ref);
      } else if (ref.kind === 'message') {
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
        proposalOnly: isCorrectionProposal(rel),
        relationMessageId: relMsgId,
        relationType: relType as RelationType,
        from: rel.sourceRefs?.[0] ? referenceToUnit(rel.sourceRefs[0]) : { messageId: fromMessageId, selection: { kind: "whole" } },
        to: toUnit,
        relationLabel,
      });
    });
    } // !isJoin
  }

  // Create edges from content-kind relation messages that have relationType and targetRefs
  // (PROPOSAL / CODE_CHANGE sent via the relation creation path).
  for (const m of messages) {
    const bk = (m as any).kind as string | undefined;
    if (bk !== 'GOVERNANCE' && bk !== 'CODE' && bk !== 'OPERATIONS') continue;
    if (relationById.has(m.id)) continue;
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
      if (ref.reference) {
        toUnit = targetRefToUnit(ref);
      } else if (ref.kind === 'message') {
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
        proposalOnly: isCorrectionProposal(m),
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
  demoMessages.sort(byCreation);

  return { messages: demoMessages, edges: demoEdges };
}

/** Resolve effective edits on the original, using personal choices before public counts. */
export function computeCorrectionVersions(
  messages: DemoMessage[],
  edges: DemoEdge[],
  invalidCorrectionIds: Set<string> = new Set(),
  currentUsername: string | null = null,
  options: { previewCorrectionId?: string } = {},
): Map<string, { current?: CorrectionVersion; versions: CorrectionVersion[] }> {
  const msgMap = new Map(messages.map(message => [message.id, message]));
  const personal = computeUserActiveStanceRelIds(edges, messages, currentUsername);
  const statistics = computeTransitiveVoteStats(edges, messages);
  const score = (version: CorrectionVersion) => {
    const state = msgMap.get(version.correctionId)?.state;
    const pro = state?.supportCount ?? statistics[version.correctionId]?.agreeCount ?? 0;
    const con = state?.oppositionCount ?? statistics[version.correctionId]?.disagreeCount ?? 0;
    const stance = personal.get(version.correctionId);
    const chosenAt = stance?.type === 'agree' ? Date.parse(msgMap.get(stance.relMsgId)?.createdAt ?? '') || 0 : 0;
    return [version.correctionId === options.previewCorrectionId ? 1 : 0, stance?.type === 'agree' ? 1 : 0, chosenAt, pro - con, pro];
  };
  const compare = (left: CorrectionVersion, right: CorrectionVersion) => {
    const a = score(left), b = score(right);
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] - b[index];
    return left.createdAt.localeCompare(right.createdAt) || left.correctionId.localeCompare(right.correctionId);
  };
  const result = new Map<string, { current?: CorrectionVersion; versions: CorrectionVersion[] }>();
  const correctionTargets = new Map(edges.filter(edge => edge.relationType === 'correct').map(edge => [edge.relationMessageId, edge.to.messageId]));
  const rootTarget = (id: string) => {
    const seen = new Set<string>();
    while (correctionTargets.has(id) && !seen.has(id)) { seen.add(id); id = correctionTargets.get(id)!; }
    return id;
  };
  for (const edge of edges) {
    if (edge.relationType !== 'correct') continue;
    const correction = msgMap.get(edge.relationMessageId);
    const target = msgMap.get(edge.to.messageId);
    if (!correction || !target) continue;
    const content = correction.relationPayload?.correctionAfterContent ?? correction.relationPayload?.correctionContent ?? correction.content;
    const version: CorrectionVersion = {
      correctionKind: correction.relationPayload?.correctionKind ?? 'TEXT',
      correctionId: correction.id,
      targetId: rootTarget(edge.to.messageId),
      baseContent: correction.relationPayload?.correctionBeforeContent ?? target.content,
      content,
      valid: !edge.proposalOnly && !isCorrectionProposal(correction) && (!invalidCorrectionIds.has(correction.id) || correction.id === options.previewCorrectionId)
        && ((edge.to.reference?.revision) === undefined || target.revision === undefined
          || (edge.to.reference?.revision) === target.revision),
      createdAt: correction.createdAt,
      selection: edge.to.selection,
      reference: edge.to.reference,
    };
    // Part addresses have local ranges. Resolve each readable field into the
    // original body's coordinates so independent fields compose without conflict.
    if (edge.to.reference?.partId && !edge.to.reference.memberId) {
      let offset = 0;
      for (const part of target.parts ?? []) {
        if (part.type !== 'text' && part.type !== 'code' && part.type !== 'web') continue;
        const value = part.type === 'text' ? part.text : part.type === 'code' ? part.source : part.excerpt || part.url;
        if (part.id === edge.to.reference.partId) {
          const range = edge.to.reference.range ?? { start: 0, end: value.length };
          version.selection = { kind: 'text', start: offset + range.start, len: range.end-range.start, text: value.slice(range.start,range.end) };
          break;
        }
        offset += value.length + 1;
      }
    }
    const entry = result.get(version.targetId) ?? { versions: [] };
    if (!entry.versions.some(item => item.correctionId === version.correctionId)) entry.versions.push(version);
    result.set(version.targetId, entry);
  }
  for (const entry of result.values()) {
    entry.versions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const originalContent = msgMap.get(entry.versions[0]?.targetId ?? '')?.content ?? entry.versions[0]?.baseContent ?? '';
    for (const version of entry.versions) {
      version.baseContent = originalContent;
      version.conflicted = false;
    }

    const changes = entry.versions.map(version => getCorrectionChange(version, originalContent));
    const effectiveChanges = new Map<string, { version: CorrectionVersion; change: CorrectionChange }>();
    for (let index = 0; index < entry.versions.length; index++) {
      const version = entry.versions[index];
      const change = changes[index];
      if (!version.valid || !change) continue;
      const fieldKey = correctionFieldKey(version.selection, originalContent);
      const previous = effectiveChanges.get(fieldKey);
      if (!previous || compare(version, previous.version) > 0) effectiveChanges.set(fieldKey, { version, change });
    }
    const chosen: Array<{ version: CorrectionVersion; change: CorrectionChange }> = [];
    for (const candidate of [...effectiveChanges.values()].sort((a, b) => compare(b.version, a.version))) {
      if (!chosen.some(({ change }) => candidate.change.start < change.end && candidate.change.end > change.start
        || candidate.change.start === change.start && candidate.change.end === change.end)) chosen.push(candidate);
    }
    const orderedChanges = chosen.sort((left, right) => right.change.start - left.change.start || right.change.end - left.change.end);
    let currentContent = originalContent;
    for (const { change } of orderedChanges) {
      currentContent = currentContent.slice(0, change.start)
        + change.replacement
        + currentContent.slice(change.end);
    }
    const latest = [...chosen].sort((left, right) => compare(right.version, left.version))[0]?.version;
    const eligible = entry.versions.flatMap((version,index) => version.valid && changes[index] ? [{version,change:changes[index]!}] : []);
    const recommendationTied = chosen.some(candidate => eligible.some(other => {
      if (other.version.correctionId === candidate.version.correctionId || other.change.replacement === candidate.change.replacement) return false;
      const a = score(candidate.version), b = score(other.version);
      return a.every((value,index) => value === b[index]) && (candidate.change.start < other.change.end && candidate.change.end > other.change.start
        || candidate.change.start === other.change.start && candidate.change.end === other.change.end);
    }));
    entry.current = latest ? { ...latest, content: currentContent, changes: orderedChanges.map(({ change }) => change),
      appliedCorrectionIds: chosen.map(({version}) => version.correctionId), recommendationTied } : undefined;
  }
  return result;
}

export function correctionFieldKey(selection: Selection | undefined, originalContent: string): string {
  if (selection?.kind !== 'text') return `whole:0:${originalContent.length}`;
  return `text:${selection.start}:${selection.len}`;
}

export function hasActiveCorrectionForSelection(
  targetId: string,
  selection: Selection | undefined,
  corrections: Map<string, { current?: CorrectionVersion; versions: CorrectionVersion[] }>,
  excludedCorrectionId?: string,
): boolean {
  const entry = corrections.get(targetId);
  if (!entry) return false;
  const fieldKey = correctionFieldKey(selection, entry.versions[0]?.baseContent ?? '');
  return entry.versions.some(version =>
    version.correctionId !== excludedCorrectionId &&
    version.valid && correctionFieldKey(version.selection, version.baseContent) === fieldKey,
  );
}

type CorrectionChange = { start: number; end: number; replacement: string; fromBase: boolean };

function getCorrectionChange(version: CorrectionVersion, originalContent: string): CorrectionChange | undefined {
  if (version.selection?.kind !== 'text') {
    return { start: 0, end: originalContent.length, replacement: version.content, fromBase: false };
  }
  const start = Math.max(0, Math.min(version.selection.start, originalContent.length));
  const end = Math.max(start, Math.min(start + version.selection.len, originalContent.length));
  const originalMatches = originalContent.slice(start, end) === version.selection.text;
  const baseStart = Math.max(0, Math.min(version.selection.start, version.baseContent.length));
  const baseEnd = Math.max(baseStart, Math.min(baseStart + version.selection.len, version.baseContent.length));
  const baseMatches = version.baseContent.slice(baseStart, baseEnd) === version.selection.text;
  const originalSuffix = originalContent.slice(end);
  const originalPrefix = originalContent.slice(0, start);
  if (originalMatches && version.content.startsWith(originalPrefix) && version.content.endsWith(originalSuffix)) {
    return { start, end, replacement: version.content.slice(start, version.content.length - originalSuffix.length), fromBase: false };
  }
  const baseSuffix = version.baseContent.slice(baseEnd);
  const basePrefix = version.baseContent.slice(0, baseStart);
  if (baseMatches && version.content.startsWith(basePrefix) && version.content.endsWith(baseSuffix)) {
    return { start: baseStart, end: baseEnd, replacement: version.content.slice(baseStart, version.content.length - baseSuffix.length), fromBase: true };
  }
  return undefined;
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
  const reference = unitSelectionToReference(unit, msgMap);
  if (s.kind === 'whole') {
    if (msgMap.get(unit.messageId)?.kind === "relation") {
      return { kind: 'relation', relationId: unit.messageId, reference };
    }
    return { kind: 'message', messageId: unit.messageId, reference };
  }
  if (s.kind === 'text') {
    return {
      kind: 'text-fragment',
      messageId: unit.messageId,
      text: s.text,
      hash: hashText(s.text),
      reference,
    };
  }
  // edge selection always targets a relation message's label/edge part
  return { kind: 'relation', relationId: unit.messageId, part: 'label', reference };
}

export function unitSelectionToReference(unit: UnitSelection, msgMap: Map<string, DemoMessage>): Reference {
  if (unit.reference) return structuredClone(unit.reference);
  const message = msgMap.get(unit.messageId);
  const reference: Reference = { messageId: unit.messageId };
  if (message?.revision && unit.selection.kind !== 'whole') reference.revision = message.revision;
  if (unit.selection.kind === 'text') {
    reference.partId = message?.parts?.find(part => part.type === 'text' || part.type === 'code' || part.type === 'web')?.id ?? 'content';
    reference.range = { start: unit.selection.start, end: unit.selection.start + unit.selection.len };
  } else if (unit.selection.kind === 'edge') {
    reference.partId = message?.parts?.find(part => part.type === 'relation')?.id ?? 'relation';
    reference.path = ['relation'];
  }
  return reference;
}

export function referenceToUnit(reference: Reference, text?: string, label?: string): UnitSelection {
  return {
    messageId: reference.messageId,
    reference: structuredClone(reference),
    ...(label ? { label } : {}),
    selection: reference.range
      ? { kind: 'text', start: reference.range.start, len: reference.range.end - reference.range.start, text: text ?? '' }
      : reference.partId || reference.path || reference.memberId
        ? { kind: 'edge', edgeId: JSON.stringify(reference) }
        : { kind: 'whole' },
  };
}

export function targetRefToUnit(ref: TargetRef, content = ''): UnitSelection {
  if (ref.reference) return referenceToUnit(ref.reference, ref.kind === 'text-fragment' ? ref.text : undefined);
  if (ref.kind === 'text-fragment') {
    const found = findTextInContent(content, ref.text);
    return { messageId: ref.messageId, selection: found
      ? { kind: 'text', start: found.start, len: found.len, text: ref.text }
      : { kind: 'whole' } };
  }
  return { messageId: ref.kind === 'relation' ? ref.relationId : ref.messageId, selection: { kind: 'whole' } };
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
    if (e.relationType !== 'correct' || e.proposalOnly) continue;
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
export function buildStanceTargetMap(
  edges: DemoEdge[],
  msgMap: Map<string, DemoMessage>
): Map<string, { targetId: string; type: 'agree' | 'disagree' }> {
  const stanceMap = new Map<string, { targetId: string; type: 'agree' | 'disagree' }>();
  for (const e of edges) {
    const msg = msgMap.get(e.relationMessageId);
    if (msg?.kind !== 'relation' || stanceMap.has(msg.id)) continue;
    if ((msg.relationType === 'agree' || msg.relationType === 'disagree') && e.relationType === msg.relationType)
      stanceMap.set(msg.id, { targetId: e.to.messageId, type: msg.relationType });
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

/** Whole-message badges must never reinterpret a vote on a reason or member field. */
export function resolveDisplayedStance(edge: DemoEdge, msgMap: Map<string, DemoMessage>, stanceMap: Map<string, { targetId: string; type: 'agree' | 'disagree' }>) {
  const executed = msgMap.get(edge.relationMessageId)?.executedStance;
  const addressKey = (reference: Reference) => {
    const target = msgMap.get(reference.messageId);
    const correction = target?.relationType === 'correct' && !isCorrectionProposal(target);
    const relationPart = target?.parts?.find(part => part.type === 'relation' && ['correct', 'amend'].includes(part.relation));
    const correctionLabel = correction && reference.partId === relationPart?.id
      && !reference.memberId && !reference.path?.length && !reference.range;
    return (reference.partId && !correctionLabel) || reference.memberId || reference.path?.length || reference.range
      || (reference.revision !== undefined && reference.revision !== target?.revision)
      ? `reference:${JSON.stringify(reference)}` : reference.messageId;
  };
  if (executed) return { targetId: addressKey(executed.target), type: executed.side === 'pro' ? 'agree' as const : 'disagree' as const };
  if (edge.to.reference) {
    const side = edge.relationType === 'agree' ? 'pro' : 'con';
    const resolved = resolveStance(edge.to.reference, side, (id, revision) => {
      const message = msgMap.get(id);
      return message?.parts && (!revision || message.revision === revision) ? message as unknown as CoreMessage : undefined;
    });
    return { targetId: addressKey(resolved.target), type: resolved.side === 'pro' ? 'agree' as const : 'disagree' as const };
  }
  return resolveUltimateStance(edge.to.messageId, edge.relationType as 'agree' | 'disagree', stanceMap);
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
    const resolved = resolveDisplayedStance(e, msgMap, stanceMap);
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

    const resolved = resolveDisplayedStance(e, msgMap, stanceMap);
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

    const resolved = resolveDisplayedStance(e, msgMap, stanceMap);
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
  currentUsername: string | null,
  stanceEdges: DemoEdge[] = edges,
): DemoEdge[] {
  const suppressedRelIds = computeUserSuppressedRelIds(stanceEdges, messages, currentUsername);
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
  messages: DemoMessage[],
  excludedEdges?: ReadonlySet<string>,
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
    if (excludedEdges?.has(e.id)) continue;
    if (e.relationType !== 'agree' && e.relationType !== 'disagree') continue;
    if (e.to.selection.kind !== 'whole' && !e.to.reference && !msgMap.get(e.relationMessageId)?.executedStance) continue;
    const toMsg = msgMap.get(e.to.messageId);
    if (toMsg?.kind !== 'relation') continue;

    const resolved = resolveDisplayedStance(e, msgMap, stanceMap);
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
  messages: DemoMessage[],
  excludedEdges?: ReadonlySet<string>,
): Record<string, { agreeCount: number; disagreeCount: number; agreeKey: string; disagreeKey: string }> {
  const msgMap = new Map(messages.map(m => [m.id, m]));
  const stanceMap = buildStanceTargetMap(edges, msgMap);

  const res: Record<string, { agreeCount: number; disagreeCount: number; agreeKey: string; disagreeKey: string }> = {};
  const ensure = (mid: string) => {
    if (!res[mid]) res[mid] = { agreeCount: 0, disagreeCount: 0, agreeKey: `dec:agree:${mid}`, disagreeKey: `dec:disagree:${mid}` };
    return res[mid];
  };

  for (const e of edges) {
    if (excludedEdges?.has(e.id)) continue;
    if (e.relationType !== 'agree' && e.relationType !== 'disagree') continue;
    if (e.to.selection.kind !== 'whole' && !e.to.reference && !msgMap.get(e.relationMessageId)?.executedStance) continue;

    const resolved = resolveDisplayedStance(e, msgMap, stanceMap);
    const targetId = resolved ? resolved.targetId : e.to.messageId;
    const effectiveType = resolved ? resolved.type : e.relationType as 'agree' | 'disagree';

    const entry = ensure(targetId);
    if (effectiveType === 'agree') entry.agreeCount++;
    else entry.disagreeCount++;
  }

  return res;
}

/**
 * Compute relation messages rejected by the shared vote result.
 * A tie remains visible; only a strict DISAGREE majority suppresses a relation.
 */
export function computeGloballySuppressedRelIds(
  edges: DemoEdge[],
  messages: DemoMessage[],
): Set<string> {
  const stats = computeTransitiveVoteStats(edges, messages);
  const relationIds = new Set(messages.filter(message => message.kind === 'relation').map(message => message.id));
  const suppressed = new Set(
    Object.entries(stats)
      .filter(([messageId, value]) => relationIds.has(messageId) && value.disagreeCount > value.agreeCount)
      .map(([messageId]) => messageId),
  );
  for (const message of messages) {
    if (!message.state) continue;
    const correction = message.relationType === 'correct' && !isCorrectionProposal(message);
    if (correction ? message.state.oppositionCount > message.state.supportCount : message.state.suppressed) suppressed.add(message.id);
    else suppressed.delete(message.id);
  }
  return suppressed;
}

/**
 * Resolve the display result for one user: the community majority is only a
 * default for users without an active stance on that target.
 */
export function computeEffectiveSuppressedRelIds(
  edges: DemoEdge[],
  messages: DemoMessage[],
  currentUsername: string | null,
): Set<string> {
  const suppressed = computeGloballySuppressedRelIds(edges, messages);
  const relationIds = new Set(messages.filter(message => message.kind === 'relation').map(message => message.id));
  const activeStances = computeUserActiveStanceRelIds(edges, messages, currentUsername);
  for (const [targetId, stance] of activeStances) {
    if (!relationIds.has(targetId)) continue;
    const target = messages.find(message => message.id === targetId);
    if (target?.state && !(target.relationType === 'correct' && !isCorrectionProposal(target))) continue;
    if (stance.type === 'agree') suppressed.delete(targetId);
    else suppressed.add(targetId);
  }
  return suppressed;
}
