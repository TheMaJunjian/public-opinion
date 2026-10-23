import type { Relation, RelationPayload, TargetRef } from '../../../types';
import { getPresentationSpec, getRelationLabel, getRelationTitle } from '../../../types';
import type { DemoMessage, RelationType } from '../../../utils/modelBridge';

export const ALL_RELATION_TYPES: RelationType[] = [
  'annotation', 'reference', 'reply', 'notify', 'agree', 'disagree', 'tag', 'arrange',
  'correct', 'classify', 'merge', 'summary',
  'proposal', 'delegation', 'code_change', 'operations',
];

export const MAX_TAG_LABEL_DISPLAY_LENGTH = 20;

export const CLASSIFY_TARGET_HINT = '文本消息、排列关系消息、分类消息或归并关系消息';

export function secondaryRelationLabel(t: string): string {
  if (t === 'none') return '无';
  if (t === 'question') return '疑问';
  if (t === 'answer') return '回答';
  if (t === 'text-correction') return '修正文字';
  if (t === 'meaning-change') return '修改原意';
  if (t === 'notify') return '通知';
  if (t === 'read') return '已读';
  if (t === 'unread') return '未读';
  if (t === 'vertical') return '纵';
  if (t === 'horizontal') return '横';
  if (t === 'evidence') return '证据';
  if (t === 'delegation') return '完成委托';
  if (t === 'custom') return '自定义';
  if (t === 'recommend' || t === 'archive' || t === 'attention' || t === 'block') return getPresentationSpec(t).label;
  if (t === '分配收入') return '分配收入';
  if (t === '终止结算') return '终止结算';
  if (t === '充值分账') return '充值分账';
  if (t === '运营收入注入') return '运营收入注入';
  if (t === 'create') return '创建委托';
  if (t === 'fulfill') return '完成委托';
  if (ALL_RELATION_TYPES.includes(t as RelationType)) return getPresentationSpec(t).label;
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

export const SUB_TYPE_LABELS: Record<string, string> = { SPAM: '垃圾', OFFTOPIC: '跑题', LOWVALUE: '低质', IMPORTANT: '重要', CUSTOM: '自定义', YES: '是', NO: '否' };

export const SUB_TYPE_OPTIONS = ['', 'SPAM', 'OFFTOPIC', 'LOWVALUE', 'IMPORTANT', 'CUSTOM'];

export function subTypeLabel(st: string) {
  return SUB_TYPE_LABELS[st] ?? st;
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

export function buildRelationDemoMessage(relation: Relation): DemoMessage {
  const relType: string = relation.relationType.toLowerCase();
  const label = getRelationLabel(relation.payload);
  const title = getRelationTitle(relation.payload);
  const typeName = getPresentationSpec(relType).label;
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
    content = `总结：${title ?? `总结（${relation.targetRefs.length}）`}`;
  } else if (relType === 'delegation') {
    content = getRelationTitle(relation.payload) ?? '';
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
      : notifyUserIds.map(id => `与会者 ${id}`);
    content = `回复通知：${notifyLabels.length > 0 ? notifyLabels.join('、') : '无匹配与会者'}\n目标：${targetSummary}`;
  } else if (['recommend','archive','attention','block'].includes(relType)) {
    const st = (relation.payload as Record<string, unknown> | null)?.subType as string | undefined;
    const stLabel = st ? (st === 'CUSTOM' ? ((relation.payload as Record<string, unknown> | null)?.customLabel as string | undefined || '自定义') : subTypeLabel(st)) : '';
    const displayLabel = stLabel ? `${typeName}·${stLabel}` : typeName;
    const sc = (relation.payload as Record<string, unknown> | null)?.repetitionCount as number | undefined;
    const countSuffix = (sc && sc >= 2) ? ` ×${sc}` : '';
    content = `${displayLabel}${countSuffix}\n目标：${targetSummary}`;
  } else if (relType === 'agree' || relType === 'disagree') {
    content = `目标：${targetSummary}`;
  } else if (relation.sourceMessageId) {
    content = `${typeName}  ${relation.sourceMessageId} → ${targetSummary}`;
  } else {
    content = `目标：${targetSummary}`;
  }
  return {
    id: relation.id,
    revision: relation.revision,
    parts: relation.parts,
    executedStance: relation.executedStance,
    state: relation.state,
    spending: relation.spending,
    targetRefs: relation.targetRefs,
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
