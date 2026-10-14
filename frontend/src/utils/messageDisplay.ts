import type { DemoEdge, DemoMessage } from './modelBridge';

/** Only recommendation expenditure buys prominence; wagers are not recommendations. */
export function getMessageProminence(message: Pick<DemoMessage, 'state' | 'spending'> | undefined) {
  const raw = message?.state?.recommendationTotal ?? message?.spending?.recommendation ?? 0;
  const recommendation = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const level = Math.min(1, Math.log10(1 + recommendation) / 3);
  return {
    recommendation,
    level,
    fontSize: 13 + 5 * level,
    backgroundImage: level ? `linear-gradient(135deg, rgba(99,102,241,${0.06 + level * 0.15}), transparent)` : undefined,
    boxShadow: level ? `0 0 ${Math.round(8 + level * 16)}px rgba(129,140,248,${0.1 + level * 0.25}), 0 4px 10px rgba(0,0,0,0.5)` : undefined,
  };
}

const organizations = new Set(['classify', 'summary', 'merge', 'arrange']);

/** Votes on an addressed component/history need their own visible identity, not a whole-card badge. */
export function needsSeparateStanceCard(message: DemoMessage, messages: ReadonlyMap<string, DemoMessage>): boolean {
  const target = message.executedStance?.target;
  if (!target) return false;
  return !!(target.partId || target.memberId || target.path?.length || target.range
    || target.revision !== undefined && target.revision !== messages.get(target.messageId)?.revision);
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
