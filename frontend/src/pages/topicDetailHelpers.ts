import type { DemoEdge, DemoMessage, RelationType, UnitSelection } from '../utils/modelBridge';
import { computeCharDiff } from '../components/CharDiffText';
import { isContentKind, unitSelectionToTargetRef } from '../utils/modelBridge';
import type { Relation, RelationPayload, TargetRef } from '../types';
import { getPresentationSpec, getRelationLabel, getRelationTitle } from '../types';
import { relationTypeName } from '../components/GraphView';

export const ALL_RELATION_TYPES: RelationType[] = [
  'annotation', 'reference', 'reply', 'notify', 'agree', 'disagree', 'tag', 'arrange',
  'correct', 'classify', 'merge', 'summary',
  'proposal', 'delegation', 'code_change', 'operations',
];

export const READ_STATUS_RELATION_TYPES = new Set(['read', 'unread']);

export const MAX_TAG_LABEL_DISPLAY_LENGTH = 20;
export const CLASSIFY_TARGET_HINT = '文本消息、排列关系消息、分类消息或归并关系消息';

export function secondaryRelationLabel(t: string): string {
  if (t === 'none') return '无';
  if (t === 'question') return '疑问';
  if (t === 'answer') return '回答';
  if (t === 'notify') return '通知';
  if (t === 'read') return '已读';
  if (t === 'unread') return '未读';
  if (t === 'vertical') return '纵';
  if (t === 'horizontal') return '横';
  if (t === 'evidence') return '证据';
  if (t === 'delegation') return '完成委托';
  if (t === 'custom') return '自定义';
  if (t === 'recommend' || t === 'archive' || t === 'attention' || t === 'block') return relationTypeName(t as RelationType);
  if (t === '分配收入') return '分配收入';
  if (t === '终止结算') return '终止结算';
  if (t === '充值分账') return '充值分账';
  if (t === '运营收入注入') return '运营收入注入';
  if (t === 'create') return '创建委托';
  if (t === 'fulfill') return '完成委托';
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

export function isAppendToExistingClassifyAction(options: {
  relationType: string | null;
  draftCount: number;
  targetCount: number;
  text: string;
  sourceClassifyCount: number;
}): boolean {
  return options.relationType === 'classify' &&
    (options.draftCount > 0 || options.targetCount > 0) &&
    options.text.trim().length === 0 &&
    options.sourceClassifyCount === 1;
}

/** Return rejected container IDs that must also receive AGREE to restore a JOIN. */
export function getJoinRecoveryTargetIds(
  targetMessageIds: string[],
  relations: Pick<Relation, 'id' | 'relationType' | 'sourceMessageId'>[],
  rejectedContainerIds: Set<string>,
): string[] {
  const targetIdSet = new Set(targetMessageIds);
  return Array.from(new Set(
    relations
      .filter(relation =>
        targetIdSet.has(relation.id) &&
        relation.relationType?.toUpperCase() === 'JOIN' &&
        !!relation.sourceMessageId &&
        rejectedContainerIds.has(relation.sourceMessageId)
      )
      .map(relation => relation.sourceMessageId!)
  ));
}

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
  correctionContent?: string;
  operationType?: string;
  amount?: number;
  revenuePoolShare?: number;
  recipientUserId?: string;
  source?: string;
  note?: string;
  attentionUserIds?: string[];
  notifyUserIds?: string[];
  delegationKind?: RelationPayload['delegationKind'];
  rewardAmount?: number;
  rewardRatio?: number;
}): RelationPayload | undefined {
  const payload: RelationPayload = {};
  if (params.label) payload.label = params.label;
  if (params.title) payload.title = params.title;
  if (params.targetLayout) payload.targetLayout = params.targetLayout;
  if (params.content) payload.content = params.content;
  if (params.correctionContent) payload.correctionContent = params.correctionContent;
  if (params.operationType) payload.operationType = params.operationType;
  if (params.amount !== undefined) payload.amount = params.amount;
  if (params.revenuePoolShare !== undefined) payload.revenuePoolShare = params.revenuePoolShare;
  if (params.recipientUserId) payload.recipientUserId = params.recipientUserId;
  if (params.source) payload.source = params.source;
  if (params.note) payload.note = params.note;
  if (params.attentionUserIds?.length) payload.attentionUserIds = params.attentionUserIds;
  if (params.notifyUserIds?.length) payload.notifyUserIds = params.notifyUserIds;
  if (params.delegationKind) payload.delegationKind = params.delegationKind;
  if (params.rewardAmount !== undefined) payload.rewardAmount = params.rewardAmount;
  if (params.rewardRatio !== undefined) payload.rewardRatio = params.rewardRatio;
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

export function getAutoClassifyTargetForSettlementMessage(msg: Pick<DemoMessage, 'id' | 'kind'>): TargetRef | null {
  if (msg.kind === 'round_result') {
    return { kind: 'message', messageId: msg.id };
  }
  return null;
}

export function getSettlementClassifyJoinTarget(msg: Pick<DemoMessage, 'id' | 'kind'>): TargetRef | null {
  return getAutoClassifyTargetForSettlementMessage(msg);
}

export function getRejectedJoinRelationIds(
  relations: Pick<Relation, 'id' | 'relationType'>[],
  voteStats: Record<string, { agreeCount: number; disagreeCount: number }> | Map<string, { agreeCount: number; disagreeCount: number }>,
): string[] {
  const statsMap = voteStats instanceof Map ? voteStats : new Map(Object.entries(voteStats));
  return relations
    .filter(r => {
      if (r.relationType?.toUpperCase() !== 'JOIN') return false;
      const stats = statsMap.get(r.id);
      return !!stats && stats.disagreeCount > stats.agreeCount;
    })
    .map(r => r.id);
}

export function expandTextIdsWithSettlementResults(
  textIds: Set<string>,
  messages: Pick<DemoMessage, 'id' | 'kind' | 'settlementTargetId'>[],
): Set<string> {
  const expanded = new Set(textIds);
  for (const msg of messages) {
    if (msg.kind !== 'round_result') continue;
    if (msg.settlementTargetId && expanded.has(msg.settlementTargetId)) {
      expanded.add(msg.id);
    }
  }
  return expanded;
}

export function buildRelationDemoMessage(relation: Relation): DemoMessage {
  const relType: string = relation.relationType.toLowerCase();
  const label = getRelationLabel(relation.payload);
  const title = getRelationTitle(relation.payload);
  const typeName = relationTypeName(relType);
  const targetSummary = relationTargetRefsSummary(relation.targetRefs);

  // JOIN type records are "add-to-container" records, not containers themselves.
  // Render them as text-like normal cards so they are visually distinct from container cards.
  const isContainerAddRecord = relType === 'join';

  let content: string;
  let joinInfo: DemoMessage['joinInfo'] | undefined;
  if (isContainerAddRecord) {
    content = '加入容器';
    joinInfo = {
      containerId: relation.sourceMessageId!,
      containerType: 'JOIN',
      targetIds: getRelationTargetIds(relation.targetRefs).length > 0
        ? getRelationTargetIds(relation.targetRefs)
        : getTextTargetIds(relation.targetRefs),
    };
  } else if (relType === 'classify') {
    content = `分类：${title ?? `分类（${relation.targetRefs.length}）`}\n目标：${targetSummary}`;
  } else if (relType === 'summary') {
    content = `总结：${title ?? `总结（${relation.targetRefs.length}）`}\n目标：${targetSummary}`;
  } else if (relType === 'proposal' || relType === 'code_change' || relType === 'operations') {
    const proposalContent = getRelationTitle(relation.payload) ?? '';
    content = `${typeName}\n${proposalContent}\n目标：${targetSummary}`;
  } else if (relType === 'tag' && label) {
    content = `标签「${label}」\n目标：${targetSummary}`;
  } else if (relType === 'notify') {
    const notifyPayload = relation.payload as Record<string, unknown> | null;
    const notifyUsers = Array.isArray(notifyPayload?.notifyUsers)
      ? (notifyPayload.notifyUsers as unknown[]).filter((user): user is { id: string; username: string } =>
          !!user && typeof user === 'object' && typeof (user as { id?: unknown }).id === 'string' && typeof (user as { username?: unknown }).username === 'string')
      : [];
    const notifyUserIds = Array.isArray(notifyPayload?.notifyUserIds)
      ? (notifyPayload.notifyUserIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];
    const notifyLabels = notifyUsers.length > 0
      ? notifyUsers.map(user => user.username)
      : notifyUserIds.map(id => `用户 ${id}`);
    content = `回复通知：${notifyLabels.length > 0 ? notifyLabels.join('、') : '无匹配用户'}\n目标：${targetSummary}`;
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
    kind: isContainerAddRecord
      ? 'join'
      : relType === 'proposal' ? 'governance' : relType === 'code_change' ? 'code' : relType === 'operations' ? 'operations' : 'relation',
    relationType: relType as RelationType,
    relationPayload: relation.payload,
    content,
    joinInfo,
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

export function resolveNavigationTargetId(
  messageId: string,
  messages: DemoMessage[],
  relations: Relation[],
): string {
  const message = messages.find(item => item.id === messageId);
  if (message && (message.kind === 'round' || message.kind === 'round_result')) {
    return message.settlementTargetId ?? messageId;
  }
  const relation = relations.find(item => item.id === messageId);
  if (!relation) return messageId;

  if (relation.relationType.toUpperCase() === 'JOIN') {
    return messageId;
  }

  if (['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'].includes(relation.relationType.toUpperCase())) {
    return messageId;
  }

  if (['AGREE', 'DISAGREE', 'CORRECT'].includes(relation.relationType.toUpperCase())
    || getPresentationSpec(relation.relationType).kind === 'inline-badge') {
    return messageId;
  }

  if (getPresentationSpec(relation.relationType).kind === 'edge-label') {
    return messageId;
  }

  const firstTarget = (relation.targetRefs ?? []).find(ref =>
    (ref.kind === 'message' || ref.kind === 'text-fragment' || ref.kind === 'relation') &&
    (('messageId' in ref && !!ref.messageId) || ('relationId' in ref && !!ref.relationId))
  );
  if (firstTarget) {
    return firstTarget.kind === 'relation'
      ? (firstTarget.relationId ?? messageId)
      : ((firstTarget as { messageId?: string }).messageId ?? messageId);
  }

  return messageId;
}

function targetIsOwnedByContainer(
  containerId: string,
  targetRef: TargetRef,
  relations: Pick<Relation, 'id' | 'relationType' | 'sourceMessageId' | 'targetRefs'>[],
  effectiveJoinRelationIds: Set<string>,
): boolean {
  const normalizedTargetRef = normalizeContainerTargetRef(targetRef, relations);
  const matchingJoins = relations.filter(relation =>
    relation.relationType?.toUpperCase() === 'JOIN' &&
    (relation.targetRefs ?? []).some(candidate =>
      sameTargetRef(normalizeContainerTargetRef(candidate, relations), normalizedTargetRef)
    )
  );
  if (matchingJoins.length === 0) return true;
  return matchingJoins.some(join =>
    join.sourceMessageId === containerId && effectiveJoinRelationIds.has(join.id)
  );
}

function normalizeContainerTargetRef(
  targetRef: TargetRef,
  relations: Pick<Relation, 'id' | 'relationType'>[],
): TargetRef {
  if (targetRef.kind === 'relation') return targetRef;
  const targetRelation = relations.find(relation => relation.id === targetRef.messageId);
  const targetType = targetRelation?.relationType?.toUpperCase();
  if (targetType === 'CLASSIFY' || targetType === 'MERGE' || targetType === 'ARRANGE' || targetType === 'SUMMARY') {
    return { kind: 'relation', relationId: targetRef.messageId };
  }
  return targetRef;
}

function sameTargetRef(left: TargetRef, right: TargetRef): boolean {
  if (left.kind === 'relation' || right.kind === 'relation') {
    return left.kind === 'relation' && right.kind === 'relation' && left.relationId === right.relationId;
  }
  return left.messageId === right.messageId;
}

export function collectContainerVisibleIds(
  containerId: string,
  relations: Pick<Relation, 'id' | 'relationType' | 'sourceMessageId' | 'targetRefs'>[],
  rejectedContainerIds: Set<string> = new Set(),
  rejectedJoinRelationIds: Set<string> = new Set(),
  userPreferredJoinByTarget?: ReadonlyMap<string, string>,
): { textIds: Set<string>; relationIds: Set<string> } {
  const textIds = new Set<string>();
  const relationIds = new Set<string>();
  const effectiveJoinRelationIds = getEffectiveJoinRelationIds([...relations], rejectedContainerIds, rejectedJoinRelationIds, userPreferredJoinByTarget);
  const container = relations.find(r => r.id === containerId);
  if (!container) return { textIds, relationIds };

  const containerType = container.relationType?.toUpperCase();
  if (containerType === 'ARRANGE' && container.sourceMessageId) {
    textIds.add(container.sourceMessageId);
  }

  for (const ref of container.targetRefs ?? []) {
    if (!targetIsOwnedByContainer(containerId, ref, relations, effectiveJoinRelationIds)) continue;
    const normalizedRef = normalizeContainerTargetRef(ref, relations);
    if (normalizedRef.kind === 'relation') {
      relationIds.add(normalizedRef.relationId);
    } else {
      textIds.add(normalizedRef.messageId);
    }
  }

  for (const relation of relations) {
    if (relation.relationType?.toUpperCase() !== 'JOIN') continue;
    if (relation.sourceMessageId !== containerId) continue;
    if (rejectedContainerIds.has(relation.id)) continue;
    if (rejectedContainerIds.has(relation.sourceMessageId)) continue;
    if (rejectedJoinRelationIds.has(relation.id)) continue;
    if (!effectiveJoinRelationIds.has(relation.id)) continue;
    for (const ref of relation.targetRefs ?? []) {
      const normalizedRef = normalizeContainerTargetRef(ref, relations);
      if (normalizedRef.kind === 'relation') {
        relationIds.add(normalizedRef.relationId);
      } else {
        textIds.add(normalizedRef.messageId);
      }
    }
  }

  return { textIds, relationIds };
}

export function collectOwnedByRelation(
  relationId: string,
  relationById: Map<string, Relation>,
  visited = new Set<string>(),
  rejectedContainerIds?: Set<string>,
  rejectedJoinRelationIds?: Set<string>,
  userPreferredJoinByTarget?: ReadonlyMap<string, string>,
): { textIds: Set<string>; relationIds: Set<string> } {
  const textIds = new Set<string>();
  const relationIds = new Set<string>();
  if (visited.has(relationId)) return { textIds, relationIds };
  visited.add(relationId);
  const relation = relationById.get(relationId);
  if (!relation) return { textIds, relationIds };
  const effectiveJoinRelationIds = getEffectiveJoinRelationIds([...relationById.values()], rejectedContainerIds ?? new Set(), rejectedJoinRelationIds ?? new Set(), userPreferredJoinByTarget);

  for (const targetRef of relation.targetRefs ?? []) {
    if (!targetIsOwnedByContainer(relationId, targetRef, [...relationById.values()], effectiveJoinRelationIds)) continue;
    const normalizedRef = normalizeContainerTargetRef(targetRef, [...relationById.values()]);
    if (normalizedRef.kind === 'relation') relationIds.add(normalizedRef.relationId);
    else textIds.add(normalizedRef.messageId);
  }
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

    // Skip "加入" relations whose parent container is rejected —
    // their targets return to the parent canvas instead of being owned here.
    if (rejectedContainerIds && rejectedContainerIds.size > 0) {
      // A child with sourceMessageId is a "加入" relation (any container type).
      // If its parent container is rejected, the membership is dissolved.
      if (child.sourceMessageId && rejectedContainerIds.has(child.sourceMessageId)) {
        continue;
      }
      // Skip child containers that are themselves rejected.
      if (rejectedContainerIds.has(childRelationId)) {
        continue;
      }
    }
    if (rejectedJoinRelationIds && rejectedJoinRelationIds.size > 0 && rejectedJoinRelationIds.has(childRelationId)) {
      continue;
    }

    const nested = collectOwnedByRelation(childRelationId, relationById, visited, rejectedContainerIds, rejectedJoinRelationIds, userPreferredJoinByTarget);
    nested.textIds.forEach(id => textIds.add(id));
    nested.relationIds.forEach(id => relationIds.add(id));
  }

  for (const joinRel of relationById.values()) {
    if (joinRel.id === relationId) continue;
    if (joinRel.relationType?.toUpperCase() !== 'JOIN') continue;
    if (joinRel.sourceMessageId !== relationId) continue;
    if (rejectedContainerIds && rejectedContainerIds.size > 0 && rejectedContainerIds.has(joinRel.id)) continue;
    if (rejectedJoinRelationIds && rejectedJoinRelationIds.size > 0 && rejectedJoinRelationIds.has(joinRel.id)) continue;
    if (!effectiveJoinRelationIds.has(joinRel.id)) continue;
    for (const targetRef of joinRel.targetRefs ?? []) {
      const normalizedRef = normalizeContainerTargetRef(targetRef, [...relationById.values()]);
      if (normalizedRef.kind === 'message' || normalizedRef.kind === 'text-fragment') {
        textIds.add(normalizedRef.messageId);
      } else if (normalizedRef.kind === 'relation') {
        relationIds.add(normalizedRef.relationId);
        const targetRelation = relationById.get(normalizedRef.relationId);
        if (targetRelation && (targetRelation.relationType?.toUpperCase() === 'CLASSIFY' || targetRelation.relationType?.toUpperCase() === 'MERGE' || targetRelation.relationType?.toUpperCase() === 'ARRANGE' || targetRelation.relationType?.toUpperCase() === 'SUMMARY')) {
          const nested = collectOwnedByRelation(normalizedRef.relationId, relationById, visited, rejectedContainerIds, rejectedJoinRelationIds, userPreferredJoinByTarget);
          nested.textIds.forEach(id => textIds.add(id));
          nested.relationIds.forEach(id => relationIds.add(id));
        }
      }
    }
  }

  return { textIds, relationIds };
}

/**
 * Walk up the container chain: find all ancestor containers of a given container
 * by following "加入" relations (CLASSIFY with sourceMessageId) that target it.
 * Returns a Set of container IDs ordered from innermost to outermost.
 */
export function getContainerAncestorChain(
  containerId: string,
  relations: Relation[],
): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current = containerId;

  while (current && !visited.has(current)) {
    visited.add(current);
    // Find a "加入" relation (any container type) whose targetRefs contain `current`
    const joinRel = relations.find(r =>
      JOIN_RELATION_TYPES.has(r.relationType) &&
      !!r.sourceMessageId &&
      (r.targetRefs as TargetRef[]).some(ref =>
        (ref.kind === 'relation' && ref.relationId === current) ||
        (ref.kind === 'message' && ref.messageId === current)
      )
    );
    if (!joinRel || !joinRel.sourceMessageId) break;
    chain.push(joinRel.sourceMessageId);
    current = joinRel.sourceMessageId;
  }

  return chain;
}

/**
 * Check whether two containers are on the same ancestor chain.
 */
export function areContainersOnSameChain(
  a: string,
  b: string,
  relations: Relation[],
): boolean {
  if (a === b) return true;
  const chainA = new Set(getContainerAncestorChain(a, relations));
  const chainB = getContainerAncestorChain(b, relations);
  // If b is in a's ancestor chain, or a is in b's ancestor chain
  if (chainA.has(b)) return true;
  if (chainB.includes(a)) return true;
  return false;
}

/**
 * Get all active (non-rejected) "加入" relations for a message.
 * Covers all four container types: CLASSIFY, SUMMARY, ARRANGE, MERGE.
 * A "加入" relation is identified by having a sourceMessageId (the container
 * being joined) and targeting this message.
 * Returns sorted by createdAt descending (latest first).
 */
const JOIN_RELATION_TYPES = new Set(['JOIN']);

type JoinRelationRecord = Omit<Pick<Relation, 'id' | 'relationType' | 'sourceMessageId' | 'targetRefs' | 'createdAt'>, 'createdAt'> & { createdAt?: string; createdBy?: Relation['createdBy'] };

function getJoinTargetKey(ref: TargetRef): string {
  return ref.kind === 'relation' ? `relation:${ref.relationId}` : `message:${ref.messageId}`;
}

function joinTargetsMessage(joinRelation: JoinRelationRecord, messageId: string): boolean {
  return (joinRelation.targetRefs as TargetRef[]).some(ref =>
    (ref.kind === 'message' || ref.kind === 'text-fragment') && ref.messageId === messageId
  );
}

/** JOIN records whose source container no longer exists. */
export function getStaleJoinRelationIds(
  relations: JoinRelationRecord[],
): string[] {
  const joins = relations.filter(relation => JOIN_RELATION_TYPES.has(relation.relationType?.toUpperCase() ?? ''));
  return joins
    .filter(join => !join.sourceMessageId)
    .map(join => join.id);
}

export function getActiveJoinRelationsForMessage(
  messageId: string,
  relations: JoinRelationRecord[],
  rejectedContainerIds: Set<string>,
  rejectedJoinRelationIds?: Set<string>,
): JoinRelationRecord[] {
  const staleJoinRelationIds = new Set(getStaleJoinRelationIds(relations));
  return relations
    .filter(r =>
      JOIN_RELATION_TYPES.has(r.relationType) &&
      !!r.sourceMessageId &&
      !rejectedContainerIds.has(r.id) &&
      !rejectedContainerIds.has(r.sourceMessageId) &&
      !(rejectedJoinRelationIds && rejectedJoinRelationIds.has(r.id)) &&
      !staleJoinRelationIds.has(r.id) &&
      joinTargetsMessage(r, messageId)
    )
    .sort((a, b) =>
      new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
    )
    .slice(0, 1);
}

/** Return the single effective JOIN for every message target. */
export function getEffectiveJoinRelationIds(
  relations: JoinRelationRecord[],
  rejectedContainerIds: Set<string>,
  rejectedJoinRelationIds: Set<string>,
  userPreferredJoinByTarget?: ReadonlyMap<string, string>,
): Set<string> {
  const staleJoinRelationIds = new Set(getStaleJoinRelationIds(relations));
  const targetKeys = new Set<string>();
  for (const relation of relations) {
    if (relation.relationType?.toUpperCase() !== 'JOIN') continue;
    for (const ref of relation.targetRefs as TargetRef[]) {
      targetKeys.add(getJoinTargetKey(ref));
    }
  }
  const effective = new Set<string>();
  for (const targetKey of targetKeys) {
    const targetId = targetKey.startsWith('message:') ? targetKey.slice('message:'.length) : null;
    const userPreferredJoinId = targetId ? userPreferredJoinByTarget?.get(targetId) : undefined;
    const userPreferredJoin = userPreferredJoinId
      ? relations.find(relation =>
        relation.id === userPreferredJoinId &&
        relation.relationType?.toUpperCase() === 'JOIN' &&
        !!relation.sourceMessageId &&
        !rejectedContainerIds.has(relation.id) &&
        !rejectedJoinRelationIds.has(relation.id) &&
        !staleJoinRelationIds.has(relation.id) &&
        !rejectedContainerIds.has(relation.sourceMessageId) &&
        (relation.targetRefs as TargetRef[]).some(ref => getJoinTargetKey(ref) === targetKey)
      )
      : undefined;
    const join = userPreferredJoin ?? relations
      .filter(relation =>
        relation.relationType?.toUpperCase() === 'JOIN' &&
        !!relation.sourceMessageId &&
        !rejectedContainerIds.has(relation.id) &&
        !rejectedJoinRelationIds.has(relation.id) &&
        !staleJoinRelationIds.has(relation.id) &&
        !rejectedContainerIds.has(relation.sourceMessageId) &&
        (relation.targetRefs as TargetRef[]).some(ref => getJoinTargetKey(ref) === targetKey)
      )
      .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
    if (join) effective.add(join.id);
  }
  return effective;
}

/** Keep container frame edges only for their currently effective JOIN members. */
export function filterContainerEdgesByEffectiveJoins(
  edges: DemoEdge[],
  relations: Pick<Relation, 'id' | 'relationType' | 'sourceMessageId' | 'targetRefs'>[],
  effectiveJoinRelationIds: Set<string>,
): DemoEdge[] {
  const containerTypes = new Set(['CLASSIFY', 'SUMMARY', 'ARRANGE', 'MERGE']);
  return edges.filter(edge => {
    if (!containerTypes.has(edge.relationType.toUpperCase())) return true;
    return relations.some(relation =>
      relation.relationType?.toUpperCase() === 'JOIN' &&
      relation.sourceMessageId === edge.relationMessageId &&
      effectiveJoinRelationIds.has(relation.id) &&
      (relation.targetRefs as TargetRef[]).some(ref =>
        (ref.kind === 'relation' && ref.relationId === edge.to.messageId) ||
        (ref.kind !== 'relation' && ref.messageId === edge.to.messageId)
      )
    );
  });
}

/** Return the latest JOIN action for each target in the current user's view. */
export function getUserPreferredJoinByTarget(
  relations: JoinRelationRecord[],
  activeStanceMap: ReadonlyMap<string, { relMsgId: string; type: 'agree' | 'disagree' }>,
  username: string | null,
): Map<string, string> {
  const preferred = new Map<string, { relationId: string; time: number }>();
  const joins = relations.filter(relation => relation.relationType?.toUpperCase() === 'JOIN');
  const consider = (targetId: string, relationId: string, time: number) => {
    const current = preferred.get(targetId);
    if (!current || time > current.time) preferred.set(targetId, { relationId, time });
  };
  if (username) {
    for (const join of joins) {
      if (join.createdBy?.username !== username) continue;
      const time = new Date(join.createdAt ?? 0).getTime();
      for (const ref of join.targetRefs as TargetRef[]) {
        if (ref.kind === 'message' || ref.kind === 'text-fragment') consider(ref.messageId, join.id, time);
      }
    }
  }
  for (const [targetRelationId, stance] of activeStanceMap) {
    if (stance.type !== 'agree') continue;
    const join = joins.find(relation => relation.id === targetRelationId);
    const agree = relations.find(relation => relation.id === stance.relMsgId);
    if (!join || !agree) continue;
    const time = new Date(agree.createdAt ?? 0).getTime();
    for (const ref of join.targetRefs as TargetRef[]) {
      if (ref.kind === 'message' || ref.kind === 'text-fragment') consider(ref.messageId, join.id, time);
    }
  }
  return new Map(Array.from(preferred, ([targetId, value]) => [targetId, value.relationId]));
}

/** Get every JOIN record directly targeting a message or container relation. */
export function getJoinRelationsForMessage(messageId: string, relations: Relation[]): Relation[] {
  return relations
    .filter(r =>
      r.relationType?.toUpperCase() === 'JOIN' &&
      !!r.sourceMessageId &&
      (r.targetRefs as TargetRef[]).some(ref =>
        (ref.kind === 'relation' && ref.relationId === messageId) ||
        (ref.kind !== 'relation' && ref.messageId === messageId)
      )
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Resolve which container (if any) a message currently belongs to.
 *
 * Walks the "加入" relation chain bottom-up: finds the latest active CLASSIFY
 * relation targeting this message, returns its sourceMessageId (the container).
 * If the container itself is in another container, we still return the IMMEDIATE
 * container — nesting is handled by the caller via recursive expansion.
 *
 * Returns the container relation ID, or null if the message is on the main canvas.
 */
export function resolveMessageCanvas(
  messageId: string,
  relations: Relation[],
  rejectedContainerIds: Set<string>,
  rejectedJoinRelationIds?: Set<string>,
): string | null {
  const active = getActiveJoinRelationsForMessage(messageId, relations, rejectedContainerIds, rejectedJoinRelationIds);
  if (active.length === 0) return null;
  return active[0].sourceMessageId!;
}

/**
 * Build a map from content-kind message ID → immediate container ID (or null).
 * Used as a drop-in replacement for the activeClassifyOwnership.textIds pattern.
 */
export function buildMessageCanvasMap(
  messages: Array<{ id: string; kind: string }>,
  relations: Relation[],
  rejectedContainerIds: Set<string>,
  rejectedJoinRelationIds?: Set<string>,
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const m of messages) {
    map.set(m.id, resolveMessageCanvas(m.id, relations, rejectedContainerIds, rejectedJoinRelationIds));
  }
  return map;
}

/**
 * Check if a message can be added to (or agreed into) a container without conflict.
 * Uses resolveMessageCanvas to find the message's current container —
 * it must be null (main canvas) or on the same chain as the target.
 */
export function checkJoinConflict(
  messageId: string,
  targetContainerId: string,
  relations: Relation[],
  rejectedContainerIds: Set<string>,
  rejectedJoinRelationIds?: Set<string>,
): { ok: boolean; conflictContainerId?: string } {
  const current = resolveMessageCanvas(messageId, relations, rejectedContainerIds, rejectedJoinRelationIds);
  if (current === null) return { ok: true };
  if (current === targetContainerId) return { ok: true };
  if (areContainersOnSameChain(current, targetContainerId, relations)) return { ok: true };
  return { ok: false, conflictContainerId: current };
}

/**
 * Check whether disagreeing on a "加入" relation would leave a message
 * in two unrelated canvases.
 */
export function checkJoinConflictAfterRemoval(
  textMessageId: string,
  containerBeingLeft: string,
  relations: Relation[],
  rejectedContainerIds: Set<string>,
  rejectedJoinRelationIds?: Set<string>,
): { ok: boolean } {
  const current = resolveMessageCanvas(textMessageId, relations, rejectedContainerIds, rejectedJoinRelationIds);
  if (current === null) return { ok: true };
  // If the message's effective container IS the one being left, it leaves together.
  if (current === containerBeingLeft) return { ok: true };
  // If on the same chain, the message is inside a child container that also leaves.
  if (areContainersOnSameChain(current, containerBeingLeft, relations)) return { ok: true };
  // Unrelated container — no conflict from this removal.
  return { ok: true };
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
  msgMap: Map<string, DemoMessage>,
  baseContent?: string,
): string | null {
  const uniqueTargetMids = Array.from(new Set(targetUnits.map(u => u.messageId)));
  if (uniqueTargetMids.length !== 1) return null;
  const targetMid = uniqueTargetMids[0];
  const targetMsg = msgMap.get(targetMid);
  const correctableRelationTypes = new Set(['classify', 'summary', 'proposal', 'delegation', 'code_change', 'operations']);
  const canCorrectTarget = targetMsg?.kind === 'normal'
    || (targetMsg?.kind === 'relation' && correctableRelationTypes.has(targetMsg.relationType ?? ''));
  if (!targetMsg || !canCorrectTarget) return null;

  const textFragments = targetUnits
    .filter(u => u.selection.kind === 'text')
    .map(u => u.selection as { kind: 'text'; start: number; len: number; text: string });

  if (textFragments.length > 0) {
    const sorted = [...textFragments].sort((a, b) => b.start - a.start);
    let content = baseContent ?? targetMsg.content;
    for (const frag of sorted) {
      content = content.slice(0, frag.start) + replacementText + content.slice(frag.start + frag.len);
    }
    return content;
  }

  return replacementText;
}

export function formatCorrectionRange(start: number, len: number, text: string): string {
  return `start=${start} len=${len} "${text}"`;
}

export function getCorrectionChangeSummary(original: string, corrected: string): {
  removed: string;
  added: string;
} {
  const { origParts, nextParts } = computeCharDiff(original, corrected);
  return {
    removed: origParts.filter(part => part.type === 'del').map(part => part.text).join(''),
    added: nextParts.filter(part => part.type === 'ins').map(part => part.text).join(''),
  };
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
