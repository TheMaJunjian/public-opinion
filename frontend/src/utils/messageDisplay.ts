import type { CSSProperties } from 'react';
import {messageCorrectionSummary} from '@gonglun/core';
import type { DemoEdge, DemoMessage } from './modelBridge';
import { getPresentationSpec, getRelationTitle } from '../types';
import { getRelationMessageLabel, getRelationRecordContentLabel } from './attachedRelationLabels';

const annotations = new Set(['tag', 'recommend', 'archive', 'attention', 'block']);
const isReview = (message: DemoMessage) => message.relationType === 'review' || message.relationPayload?.operationType === 'REVIEW';

export interface MessageTypeDetail {
  kind: 'subtype' | 'verdict' | 'reason' | 'label';
  label: string;
  tone?: 'pass' | 'reject';
}

/** A category, its operation and its judgment are separate pieces of information. */
export function getMessageTypeDetails(message: DemoMessage): MessageTypeDetail[] {
  const type = message.relationType, payload = message.relationPayload;
  if (isReview(message)) return [{ kind: 'subtype', label: '审核' },
    ...(payload?.verdict === 'pass' || payload?.verdict === 'reject'
      ? [{ kind: 'verdict' as const, label: payload.verdict === 'pass' ? '通过' : '不通过', tone: payload.verdict }] : [])];
  if (message.kind === 'operations' || message.backendKind === 'OPERATIONS' || type === 'operations')
    return [{ kind: 'subtype', label: '公告' }];
  if (type === 'reference') {
    const label = getRelationRecordContentLabel(message);
    return label ? [{ kind: 'label', label }] : [];
  }
  if (annotations.has(type ?? '')) {
    const detail = getRelationRecordContentLabel(message);
    return [
      ...(type === 'tag' ? [] : [{ kind: 'subtype' as const, label: getPresentationSpec(type!).label }]),
      ...(detail ? [{ kind: type === 'tag' ? 'label' as const : 'reason' as const, label: detail }] : []),
    ];
  }
  return [];
}

/** Generated label/reason text is already visible in the header, including when opened as a review target. */
export function hasMetadataOnlyContent(message: DemoMessage): boolean {
  if (!annotations.has(message.relationType ?? '') && message.relationType !== 'reference') return false;
  const detail = message.relationType === 'reference' ? message.relationPayload?.label?.trim() : getRelationRecordContentLabel(message);
  if (!detail || message.relationPayload?.content || message.relationPayload?.title) return false;
  const readable = message.parts?.filter(part => ['text', 'code', 'web'].includes(part.type)) ?? [];
  return readable.every(part => part.type === 'text' && (!part.text.trim() || part.text.trim() === detail));
}

/** Use the card's type names for entries in the selection collections. */
export function getMessageTypeLabel(message: DemoMessage | undefined): string {
  if (!message) return '消息';
  if (message.relationType === 'distribution') return '结算';
  if (isReview(message)) return '运营';
  if (message.relationType === 'reference') return '引用';
  if (annotations.has(message.relationType ?? '')) return '标注';
  if (['classify', 'summary', 'merge'].includes(message.relationType ?? '')) return getPresentationSpec(message.relationType!).label;
  const specific = getRelationMessageLabel(message);
  if (specific) return specific;
  if (message.kind === 'relation') return message.relationType === 'proposal' ? '提案' : getPresentationSpec(message.relationType ?? 'relation').label;
  if (message.kind === 'round' || message.kind === 'round_result') {
    return `${message.roundPayload?.settlementType === 'VALUE' ? '价值' : '真假'}仲裁${message.kind === 'round_result' ? '结算' : ''}`;
  }
  return ({ normal: '文本', join: '加入', governance: '提案', code: '代码', operations: '运营' } as Record<string, string>)[message.kind] ?? '消息';
}

/** Visible organization text, without the bridge's synthetic target-ID summary. */
export function getOrganizationTitle(message: DemoMessage, memberCount?: number): string {
  const label = ({ classify: '分类', summary: '总结', merge: '归并' } as Record<string, string>)[message.relationType ?? ''];
  if (!label) return '';
  const count = memberCount ?? new Set((message.targetRefs ?? []).map(ref => ref.kind === 'relation' ? ref.relationId : ref.messageId)).size;
  return getRelationTitle(message.relationPayload) || `${label}（${count}）`;
}

export function getMessageCardContent(message: DemoMessage | undefined): string {
  if (message?.relationType === 'correct' && message.parts) return messageCorrectionSummary({parts:message.parts}) ?? message.content;
  if (message && (message.kind === 'round' || message.kind === 'round_result')) {
    return [message.settlementTargetId ? `目标：${message.settlementTargetId}` : '目标未记录', getSettlementDetails(message)].filter(Boolean).join('\n');
  }
  return message ? getOrganizationTitle(message) || message.content : '';
}

/** Remove generated target previews while retaining the settlement's own results and notes. */
export function getSettlementDetails(message: DemoMessage): string {
  const parts = message.parts?.filter(part => part.type === 'text' || part.type === 'code' || part.type === 'web') ?? [];
  let details = parts.length ? parts.map(part => part.type === 'text' ? part.text : part.type === 'code' ? part.source : part.excerpt || part.url).join('\n') : message.content;
  const heading = details.match(/^(?:发起(?:真假|价值)仲裁|(?:真假|价值)仲裁完成)：目标消息/u);
  if (heading) {
    const target = details.slice(heading[0].length).trimStart();
    if (target.startsWith('「')) {
      let depth = 0, end = 0;
      for (; end < target.length; end++) {
        if (target[end] === '「') depth++;
        else if (target[end] === '」' && --depth === 0) break;
      }
      details = target.slice(end + 1).replace(/^；/u, '');
    } else details = target.replace(/^[^；\n]*(?:；|\n|$)/u, '');
  }
  if (/^发起结算：/u.test(details) && details.includes('。发起人：')) details = details.slice(details.lastIndexOf('。发起人：') + 1);
  else if (/^(?:请求)?发起结算：「[\s\S]*」$/u.test(details)) details = '';
  return details.replace(/^(?:发起(?:真假|价值)仲裁|(?:真假|价值)仲裁完成)：/u, '').trim();
}

/** Only recommendation expenditure buys prominence; wagers are not recommendations. */
export function getMessageProminence(message: Pick<DemoMessage, 'state' | 'spending'> | undefined) {
  const raw = message?.state?.recommendationTotal ?? message?.spending?.recommendation ?? 0;
  const recommendation = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const level = Math.min(1, Math.log10(1 + recommendation) / 3);
  return {
    recommendation,
    level,
    fontSize: 15 + 3 * level,
    cssFontSize: `calc(var(--message-font-min) + ${level} * var(--message-font-range))`,
    variables: { '--recommendation-level': level } as CSSProperties,
    backgroundImage: level ? 'var(--recommendation-gradient)' : undefined,
    boxShadow: level ? 'var(--recommendation-shadow)' : undefined,
  };
}

const organizations = new Set(['classify', 'summary', 'merge', 'arrange']);

/** Editing readable content must not replace the container or hide its frame. */
export function isBodyCorrection(edge: DemoEdge, messages: ReadonlyMap<string, DemoMessage>): boolean {
  if (edge.relationType !== 'correct') return false;
  const correction = messages.get(edge.relationMessageId);
  if (correction?.relationPayload?.correctionKind === 'WIDTH') return true;
  if (correction?.relationPayload?.correctionBeforeContent !== undefined) return true;
  const part = messages.get(edge.to.messageId)?.parts?.find(part => part.id === edge.to.reference?.partId);
  return !!part && ['text', 'code', 'web'].includes(part.type);
}

/** Votes on an addressed component/history need their own visible identity, not a whole-card badge. */
export function needsSeparateStanceCard(message: DemoMessage, messages: ReadonlyMap<string, DemoMessage>): boolean {
  const target = message.executedStance?.target;
  if (!target) return false;
  const current=messages.get(target.messageId);
  return !!current && target.revision !== undefined && target.revision !== current.revision;
}

/** Keep the declaration available for inspection, while suspending its display effect. */
export function hasActiveDisplayEffect(edge: DemoEdge, messages: ReadonlyMap<string, DemoMessage>): boolean {
  if (edge.proposalOnly) return false;
  if (!organizations.has(edge.relationType)) return true;
  const declaration = messages.get(edge.relationMessageId);
  if (declaration?.state?.suppressed) return false;
  // Current organization memberships cannot be inferred from a reference to a field or history.
  const ref = edge.to.reference;
  return !declaration?.parts || !ref || (ref.revision === undefined && !ref.partId && !ref.memberId && !ref.path?.length && !ref.range);
}

export function getSummaryCoveredIds(messages: ReadonlyMap<string, DemoMessage>, edges: DemoEdge[]): Set<string> {
  return new Set(edges.filter(edge => edge.relationType === 'summary'
    && hasActiveDisplayEffect(edge, messages)
    && (edge.to.selection.kind === 'whole' || edge.to.selection.kind === 'text'))
    .map(edge => edge.to.messageId));
}
