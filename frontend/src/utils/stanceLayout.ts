import type { DemoEdge, DemoMessage } from './modelBridge';
import { needsSeparateStanceCard } from './messageDisplay';

/** Execution locations are separate from the edges a user actually selected.
 * Keeping the original edges intact preserves trace, selection and reference chains.
 */
export function projectStanceLayoutEdges(messages: DemoMessage[], edges: DemoEdge[]): DemoEdge[] {
  const byId = new Map(messages.map(message => [message.id, message]));
  return edges.map(edge => {
    if (edge.relationType !== 'agree' && edge.relationType !== 'disagree') return edge;
    const relation = byId.get(edge.relationMessageId);
    const execution = relation?.executedStance;
    if (!execution) return edge;
    const sourceId = edge.from.messageId.startsWith('anon:') && relation && (needsSeparateStanceCard(relation, byId) || relation.parts?.some(part =>
      part.type === 'text' ? part.text.trim() : part.type === 'code' ? part.source.trim() : part.type === 'web' ? part.excerpt.trim() : false,
    )) ? relation.id : edge.from.messageId;
    return {
      ...edge,
      relationType: execution.side === 'pro' ? 'agree' : 'disagree',
      from: { ...edge.from, messageId: sourceId },
      to: { messageId: execution.target.messageId, selection: { kind: 'whole' }, reference: execution.target },
    };
  });
}
