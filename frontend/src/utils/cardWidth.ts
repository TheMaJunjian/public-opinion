import { computeTransitiveVoteStats, computeUserActiveStanceRelIds, type DemoEdge, type DemoMessage } from './modelBridge';
import { CARD_W } from './layout';

export const MAX_CARD_WIDTH = 2400;
export const isCardWidth = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= CARD_W && value <= MAX_CARD_WIDTH;

/** Include the ellipsis in the limit, and never split a Unicode code point. */
export function cardAuthor(author: string, messageId: string): string {
  const characters = Array.from(author), limit = Math.max(1, Array.from(messageId).length);
  return characters.length <= limit ? author : `${characters.slice(0, limit - 1).join('')}…`;
}

/** Width corrections choose a display independently of all body corrections. */
export function effectiveCardWidths(messages: DemoMessage[], edges: DemoEdge[], username: string | null = null): Record<string, number> {
  const byId = new Map(messages.map(message => [message.id, message]));
  const personal = computeUserActiveStanceRelIds(edges, messages, username);
  const statistics = computeTransitiveVoteStats(edges, messages);
  const selected = new Map<string, { width: number; score: number[]; id: string }>();
  for (const edge of edges) {
    if (edge.relationType !== 'correct' || edge.proposalOnly) continue;
    const correction = byId.get(edge.relationMessageId), payload = correction?.relationPayload;
    if (!correction || payload?.correctionKind !== 'WIDTH' || !isCardWidth(payload.correctionWidth)) continue;
    const stance = personal.get(correction.id);
    const pro = correction.state?.supportCount ?? statistics[correction.id]?.agreeCount ?? 0;
    const con = correction.state?.oppositionCount ?? statistics[correction.id]?.disagreeCount ?? 0;
    if (stance?.type === 'disagree' || !stance && (con > pro || correction.state?.suppressed)) continue;
    const score = [stance?.type === 'agree' ? 1 : 0,
      stance?.type === 'agree' ? Date.parse(byId.get(stance.relMsgId)?.createdAt ?? '') || 0 : 0,
      pro - con, pro, Date.parse(correction.createdAt) || 0];
    const previous = selected.get(edge.to.messageId);
    const difference = previous ? score.map((value, index) => value - previous.score[index]).find(value => value !== 0) ?? correction.id.localeCompare(previous.id) : 1;
    if (difference > 0) selected.set(edge.to.messageId, { width: payload.correctionWidth, score, id: correction.id });
  }
  return Object.fromEntries([...selected].map(([id, choice]) => [id, choice.width]));
}
