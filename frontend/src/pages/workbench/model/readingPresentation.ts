import type { ReadingInput, deriveReadingProgress } from './readingProgress';

export type ReadingPresentation = 'dimmed' | 'hidden';

/** Only direct relationships retain read context; read-only branches can disappear. */
export function deriveReadingPresentation(input: ReadingInput, progress: ReturnType<typeof deriveReadingProgress>) {
  const pending = new Set(input.messages.filter(message => !progress.confirmed(message.id)).map(message => message.id));
  const related = new Set<string>();
  const connect = (ids: readonly string[]) => {
    if (ids.some(id => pending.has(id))) ids.forEach(id => related.add(id));
  };
  for (const edge of input.edges) {
    if (['read', 'unread'].includes(edge.relationType)) continue;
    connect([edge.relationMessageId, edge.from.messageId, edge.to.messageId]);
  }
  // Membership is not always represented by an edge (for example, JOIN placements).
  for (const membership of input.memberships ?? []) {
    for (const id of membership.targetIds) connect([membership.containerId, id]);
  }
  // Include resolved influences such as a stance on a corrected version.
  for (const [target, influences] of progress.influences) {
    for (const influence of influences) connect([target, influence.messageId]);
  }
  return new Map(input.messages.filter(message => progress.confirmed(message.id))
    .map(message => [message.id, related.has(message.id) ? 'dimmed' : 'hidden'] as const));
}

/** A grouped badge must stay visible if any of its records still needs reading. */
export function groupedReadingPresentation(ids: readonly string[], presentation: ReadonlyMap<string, ReadingPresentation>): ReadingPresentation | undefined {
  if (!ids.length || ids.some(id => !presentation.has(id))) return undefined;
  return ids.some(id => presentation.get(id) === 'dimmed') ? 'dimmed' : 'hidden';
}
