import type { RelationPayload } from '../types';
import { getPresentationSpec } from '../types';
import type { DemoMessage } from './modelBridge';

const SUB_TYPE_LABELS: Record<string, string> = {
  SPAM: '垃圾',
  OFFTOPIC: '跑题',
  LOWVALUE: '低质',
  IMPORTANT: '重要',
};

function replyAdditionalDisplayLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'question' || normalized === '疑问') return '疑问';
  if (normalized === 'answer' || normalized === '回答') return '回答';
  return '回复';
}

export const MAX_CUSTOM_LABEL_LENGTH = 20;

export function truncateCustomLabel(value: string, maxLength = MAX_CUSTOM_LABEL_LENGTH): string {
  const normalized = value.trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function getReasonLabel(payload: RelationPayload | undefined): string | undefined {
  if (!payload?.subType) return undefined;
  if (payload.subType === 'CUSTOM') {
    return payload.customLabel ? truncateCustomLabel(payload.customLabel) : '自定义';
  }
  return SUB_TYPE_LABELS[payload.subType] ?? payload.subType;
}

const OPERATION_LABELS: Record<string, string> = {
  DISTRIBUTE_REVENUE: '分配收入',
  ALLOCATE_REVENUE: '分配收入',
  TERMINATE_SETTLEMENT: '终止结算',
  RECHARGE: '充值分账',
  RECHARGE_SPLIT: '充值分账',
  REVENUE_INJECTION: '运营收入注入',
  INJECT_OPERATING_REVENUE: '运营收入注入',
};

/** Gets the specific type label for a relation message, including its secondary relation. */
export function getRelationMessageLabel(message: DemoMessage): string | undefined {
  const relationType = String(message.relationType ?? '').toLowerCase();
  const payload = message.relationPayload;
  if (message.kind !== 'relation' && message.backendKind !== 'GOVERNANCE') return undefined;
  if (relationType === 'delegation') {
    return payload?.delegationKind === 'FULFILL' ? '完成委托' : '创建委托';
  }
  if (relationType === 'reply' && payload?.label) return replyAdditionalDisplayLabel(payload.label);
  if (relationType === 'proposal' || message.backendKind === 'GOVERNANCE') {
    const operation = payload?.operationType;
    if (operation && OPERATION_LABELS[String(operation).toUpperCase()]) return OPERATION_LABELS[String(operation).toUpperCase()];
  }
  if (relationType === 'recommend' || relationType === 'archive') {
    const base = getPresentationSpec(relationType).label;
    const reason = getReasonLabel(payload);
    return reason ? `${base} · ${reason}` : base;
  }
  if (payload?.label?.trim()) return payload.label.trim();
  return undefined;
}

