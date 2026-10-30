import type { CSSProperties } from 'react';
import type { DemoEdge, DemoMessage } from './modelBridge';
import { getPresentationSpec, getRelationTitle } from '../types';
import { getRelationMessageLabel } from './attachedRelationLabels';

/** Use the card's type names for entries in the selection collections. */
export function getMessageTypeLabel(message: DemoMessage | undefined): string {
  if (!message) return '消息';
  if (['classify', 'summary', 'merge'].includes(message.relationType ?? '')) return getPresentationSpec(message.relationType!).label;
  const specific = getRelationMessageLabel(message);
  if (specific) return specific;
  if (message.kind === 'relation') return getPresentationSpec(message.relationType ?? 'relation').label;
  if (message.kind === 'round' || message.kind === 'round_result') {
    return `${message.roundPayload?.settlementType === 'VALUE' ? '价值' : '真假'}仲裁${message.kind === 'round_result' ? '结算' : ''}`;
  }
  return ({ normal: '文本', join: '加入', governance: '治理提案', code: '代码', operations: '运营' } as Record<string, string>)[message.kind] ?? '消息';
}

/** Visible organization text, without the bridge's synthetic target-ID summary. */
export function getOrganizationTitle(message: DemoMessage, memberCount?: number): string {
  const label = ({ classify: '分类', summary: '总结', merge: '归并' } as Record<string, string>)[message.relationType ?? ''];
  if (!label) return '';
  const count = memberCount ?? new Set((message.targetRefs ?? []).map(ref => ref.kind === 'relation' ? ref.relationId : ref.messageId)).size;
  return getRelationTitle(message.relationPayload) || `${label}（${count}）`;
}

export function getMessageCardContent(message: DemoMessage | undefined): string {
  return message ? getOrganizationTitle(message) || message.content : '';
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
