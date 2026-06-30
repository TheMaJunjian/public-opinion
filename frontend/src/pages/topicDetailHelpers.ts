import type { DemoEdge, DemoMessage, RelationType, UnitSelection } from '../utils/modelBridge';
import { isContentKind, unitSelectionToTargetRef } from '../utils/modelBridge';
import type { Relation, RelationPayload, TargetRef } from '../types';
import { getRelationLabel, getRelationTitle } from '../types';
import { relationTypeName } from '../components/GraphView';

export const ALL_RELATION_TYPES: RelationType[] = [
  'annotation', 'reference', 'reply', 'agree', 'disagree', 'tag', 'arrange',
  'correct', 'classify', 'merge', 'summary',
  'proposal', 'code_change', 'operations',
];

export const MAX_TAG_LABEL_DISPLAY_LENGTH = 20;
export const CLASSIFY_TARGET_HINT = '文本消息、排列关系消息、分类消息或归并关系消息';

export function secondaryRelationLabel(t: string): string {
  if (t === 'none') return '无';
  if (t === 'question') return '疑问';
  if (t === 'answer') return '回答';
  if (t === 'vertical') return '纵';
  if (t === 'horizontal') return '横';
  if (t === 'evidence') return '证据';
  if (t === 'custom') return '自定义';
  if (t === 'recommend' || t === 'archive') return relationTypeName(t);
  if (ALL_RELATION_TYPES.includes(t as RelationType)) return relationTypeName(t as RelationType);
  return t;
}

export function replyAdditionalLabel(t: string): string {
  if (t === 'question') return '疑问';
  if (t === 'answer') return '回答';
  return '回复';
}

export function isValidTagLabel(label: string | undefined): label is string {
  return !!label && label !== 'tag';
}

export const SUB_TYPE_LABELS: Record<string, string> = { SPAM: '垃圾', OFFTOPIC: '跑题', LOWVALUE: '低质', IMPORTANT: '重要', CUSTOM: '自定义' };
export const SUB_TYPE_OPTIONS = ['', 'SPAM', 'OFFTOPIC', 'LOWVALUE', 'IMPORTANT', 'CUSTOM'];

export function subTypeLabel(st: string) {
  return SUB_TYPE_LABELS[st] ?? st;
}

export function selKey(u: UnitSelection): string {
  const s = u.selection;
  if (s.kind === 'whole') return `${u.messageId}::whole`;
  if (s.kind === 'edge') return `${u.messageId}::edge:${s.edgeId}`;
  return `${u.messageId}::text:${s.start}:${s.len}:${s.text}`;
}

export function unitEquals(a: UnitSelection, b: UnitSelection) {
  return selKey(a) === selKey(b);
}

export function mergeUnits(base: UnitSelection[], added: UnitSelection[]) {
  const set = new Set(base.map(selKey));
  const res = [...base];
  for (const u of added) {
    const k = selKey(u);
    if (!set.has(k)) { set.add(k); res.push(u); }
  }
  return res;
}

export function foldUpToWhole(units: UnitSelection[]) {
  const seen = new Set<string>(); const res: UnitSelection[] = [];
  for (const u of units) {
    if (seen.has(u.messageId)) continue;
    seen.add(u.messageId);
    res.push({ messageId: u.messageId, selection: { kind: 'whole' } });
  }
  return res;
}

export function describeUnit(u: UnitSelection): string {
  const s = u.selection;
  if (s.kind === 'whole') return `整条消息 ${u.messageId}`;
  if (s.kind === 'edge') return `关系消息 ${u.messageId} 的边片段 @edge:${s.edgeId}`;
  return `消息 ${u.messageId} 的片段(start=${s.start}, len=${s.len})「${s.text}」`;
}

let nextIdCounter = 1;

export function nextId(prefix: string): string {
  return `${prefix}-local-${Date.now()}-${nextIdCounter++}`;
}

export function targetRefDisplayId(r: TargetRef): string {
  if (r.kind === 'message' || r.kind === 'text-fragment') return r.messageId;
  return r.relationId;
}

export function buildRelationPayload(params: {
  relationType: string;
  label?: string;
  title?: string;
  targetLayout?: RelationPayload['targetLayout'];
  content?: string;
}): RelationPayload | undefined {
  const payload: RelationPayload = {};
  if (params.label) payload.label = params.label;
  if (params.title) payload.title = params.title;
  if (params.targetLayout) payload.targetLayout = params.targetLayout;
  if (params.content) payload.content = params.content;
  if ((params.relationType.toUpperCase() === 'MERGE' || params.relationType.toUpperCase() === 'SUMMARY') && !payload.targetLayout) {
    payload.targetLayout = 'multi-column';
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

function relationTargetRefsSummary(targetRefs: TargetRef[]): string {
  if (targetRefs.length === 0) return '（无目标）';
  return targetRefs.map(ref => {
    if (ref.kind === 'message') return ref.messageId;
    if (ref.kind === 'text-fragment') return `${ref.messageId} 的片段`;
    return ref.relationId;
  }).join(', ');
}

export function buildRelationDemoMessage(relation: Relation): DemoMessage {
  const relType = relation.relationType.toLowerCase() as RelationType;
  const label = getRelationLabel(relation.payload);
  const title = getRelationTitle(relation.payload);
  const typeName = relationTypeName(relType);
  const targetSummary = relationTargetRefsSummary(relation.targetRefs);
  let content: string;
  if (relType === 'classify') {
    content = `分类：${title ?? `分类（${relation.targetRefs.length}）`}\n目标：${targetSummary}`;
  } else if (relType === 'summary') {
    content = `总结：${title ?? `总结（${relation.targetRefs.length}）`}\n目标：${targetSummary}`;
  } else if (relType === 'proposal' || relType === 'code_change' || relType === 'operations') {
    const proposalContent = getRelationTitle(relation.payload) ?? '';
    content = `${typeName}\n${proposalContent}\n目标：${targetSummary}`;
  } else if (relType === 'tag' && label) {
    content = `标签「${label}」\n目标：${targetSummary}`;
  } else if (relType === 'recommend' || relType === 'archive') {
    const st = (relation.payload as Record<string, unknown> | null)?.subType as string | undefined;
    const stLabel = st ? (st === 'CUSTOM' ? ((relation.payload as Record<string, unknown> | null)?.customLabel as string | undefined || '自定义') : subTypeLabel(st)) : '';
    const displayLabel = stLabel ? `${typeName}·${stLabel}` : typeName;
    const sc = (relation.payload as Record<string, unknown> | null)?.sendCount as number | undefined;
    const countSuffix = (sc && sc >= 2) ? ` ×${sc}` : '';
    const tf = (relation.payload as Record<string, unknown> | null)?.transformedFrom as string | undefined;
    const fromSuffix = tf === 'AGREE' ? '（来自赞同）' : tf === 'DISAGREE' ? '（来自反对）' : '';
    content = `${displayLabel}${countSuffix}${fromSuffix}\n目标：${targetSummary}`;
  } else if (relation.sourceMessageId) {
    content = `${typeName}  ${relation.sourceMessageId} → ${targetSummary}`;
  } else {
    content = `${typeName}（无来源）\n目标：${targetSummary}`;
  }
  return {
    id: relation.id,
    author: relation.createdBy.username,
    createdAt: relation.createdAt,
    kind: 'relation',
    relationType: relType,
    relationPayload: relation.payload,
    content,
  };
}

export function getTextTargetIds(targetRefs: TargetRef[]): string[] {
  return Array.from(new Set(
    targetRefs
      .filter((ref): ref is Extract<TargetRef, { kind: 'message' | 'text-fragment' }> =>
        ref.kind === 'message' || ref.kind === 'text-fragment'
      )
      .map(ref => ref.messageId)
  ));
}

export function getRelationTargetIds(targetRefs: TargetRef[]): string[] {
  return Array.from(new Set(
    targetRefs
      .filter((ref): ref is Extract<TargetRef, { kind: 'relation' }> => ref.kind === 'relation')
      .map(ref => ref.relationId)
  ));
}

export function collectOwnedByRelation(
  relationId: string,
  relationById: Map<string, Relation>,
  visited = new Set<string>()
): { textIds: Set<string>; relationIds: Set<string> } {
  const textIds = new Set<string>();
  const relationIds = new Set<string>();
  if (visited.has(relationId)) return { textIds, relationIds };
  visited.add(relationId);
  const relation = relationById.get(relationId);
  if (!relation) return { textIds, relationIds };

  for (const textId of getTextTargetIds(relation.targetRefs)) textIds.add(textId);
  const relType = relation.relationType.toUpperCase();
  if (relType === 'ARRANGE' && relation.sourceMessageId) {
    textIds.add(relation.sourceMessageId);
  }
  for (const childRelationId of getRelationTargetIds(relation.targetRefs)) {
    relationIds.add(childRelationId);
    const child = relationById.get(childRelationId);
    if (!child) continue;
    const childType = child.relationType.toUpperCase();
    if (childType !== 'CLASSIFY' && childType !== 'MERGE' && childType !== 'ARRANGE' && childType !== 'SUMMARY') continue;
    const nested = collectOwnedByRelation(childRelationId, relationById, visited);
    nested.textIds.forEach(id => textIds.add(id));
    nested.relationIds.forEach(id => relationIds.add(id));
  }

  return { textIds, relationIds };
}

export function expandTextIdsWithCorrections(
  textIds: Set<string>,
  edges: DemoEdge[],
  msgMap: Map<string, DemoMessage>
): Set<string> {
  const expanded = new Set(textIds);
  const queue = Array.from(textIds);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const tid = queue.shift()!;
    if (visited.has(tid)) continue;
    visited.add(tid);
    for (const e of edges) {
      if (e.relationType !== 'correct') continue;
      if (msgMap.get(e.from.messageId)?.kind !== 'normal' || msgMap.get(e.to.messageId)?.kind !== 'normal') continue;
      if (e.from.messageId === tid && !expanded.has(e.to.messageId)) {
        expanded.add(e.to.messageId);
        queue.push(e.to.messageId);
      } else if (e.to.messageId === tid && !expanded.has(e.from.messageId)) {
        expanded.add(e.from.messageId);
        queue.push(e.from.messageId);
      }
    }
  }
  return expanded;
}

export function uniqueTargetRefsFromEdges(
  relEdges: DemoEdge[],
  msgMap: Map<string, DemoMessage>
): TargetRef[] {
  const seen = new Set<string>();
  const refs: TargetRef[] = [];
  for (const e of relEdges) {
    const key = e.to.messageId + '::' + e.to.selection.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(unitSelectionToTargetRef(e.to, msgMap));
  }
  return refs;
}

export function generateCorrectionContent(
  targetUnits: UnitSelection[],
  replacementText: string,
  msgMap: Map<string, DemoMessage>
): string | null {
  const uniqueTargetMids = Array.from(new Set(targetUnits.map(u => u.messageId)));
  if (uniqueTargetMids.length !== 1) return null;
  const targetMid = uniqueTargetMids[0];
  const targetMsg = msgMap.get(targetMid);
  if (!targetMsg || targetMsg.kind !== 'normal') return null;

  const textFragments = targetUnits
    .filter(u => u.selection.kind === 'text')
    .map(u => u.selection as { kind: 'text'; start: number; len: number; text: string });

  if (textFragments.length > 0) {
    const sorted = [...textFragments].sort((a, b) => b.start - a.start);
    let content = targetMsg.content;
    for (const frag of sorted) {
      content = content.slice(0, frag.start) + replacementText + content.slice(frag.start + frag.len);
    }
    return content;
  }

  return replacementText;
}

function buildTextCorrectionReplacementMap(
  edges: DemoEdge[],
  msgMap: Map<string, DemoMessage>
): Map<string, string> {
  const raw = new Map<string, string>();
  for (const e of edges) {
    if (e.relationType !== 'correct') continue;
    if (e.from.messageId.startsWith('anon:')) continue;
    const fromMsg = msgMap.get(e.from.messageId);
    const toMsg = msgMap.get(e.to.messageId);
    if (fromMsg?.kind !== 'normal' || toMsg?.kind !== 'normal') continue;
    raw.set(e.to.messageId, e.from.messageId);
  }
  const resolved = new Map<string, string>();
  function resolve(id: string, seen = new Set<string>()): string {
    const next = raw.get(id);
    if (!next) return id;
    if (seen.has(id)) return id;
    seen.add(id);
    const finalId = resolve(next, seen);
    resolved.set(id, finalId);
    return finalId;
  }
  for (const oldId of raw.keys()) resolve(oldId);
  return resolved;
}

export function applyTextCorrectionInheritance(
  edges: DemoEdge[],
  msgMap: Map<string, DemoMessage>
): DemoEdge[] {
  const replaceMap = buildTextCorrectionReplacementMap(edges, msgMap);
  if (replaceMap.size === 0) return edges;
  const next: DemoEdge[] = [];
  const seen = new Set<string>();
  let changed = false;
  for (const e of edges) {
    if (e.relationType === 'correct') {
      next.push(e);
      continue;
    }
    const fromIsNormal = (() => { const m = msgMap.get(e.from.messageId); return m && isContentKind(m.kind); })();
    const toIsNormal = (() => { const m = msgMap.get(e.to.messageId); return m && isContentKind(m.kind); })();
    const mappedFrom = fromIsNormal ? (replaceMap.get(e.from.messageId) ?? e.from.messageId) : e.from.messageId;
    const mappedTo = toIsNormal ? (replaceMap.get(e.to.messageId) ?? e.to.messageId) : e.to.messageId;
    const updated: DemoEdge = (mappedFrom === e.from.messageId && mappedTo === e.to.messageId)
      ? e
      : {
          ...e,
          from: { ...e.from, messageId: mappedFrom },
          to: { ...e.to, messageId: mappedTo },
        };
    const edgeKey = `${updated.relationMessageId}::${updated.relationType}::${selKey(updated.from)}::${selKey(updated.to)}::${updated.relationLabel}`;
    if (seen.has(edgeKey)) {
      changed = true;
      continue;
    }
    seen.add(edgeKey);
    if (updated !== e) changed = true;
    next.push(updated);
  }
  if (!changed && next.length === edges.length) return edges;
  return next;
}
