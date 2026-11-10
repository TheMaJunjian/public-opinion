import type { Part } from './types.js';

/** UI directed relations can store their label as text. It labels the edge, not a second body card. */
export function relationLabelPart(parts: readonly Part[] | undefined): string | undefined {
  if (!parts?.some(part => part.type === 'relation' && ['annotation', 'reference', 'reply', 'notify'].includes(part.relation))) return;
  const data = Object.assign({}, ...parts.flatMap(part => part.type === 'data' && part.value && typeof part.value === 'object' && !Array.isArray(part.value) ? [part.value] : []));
  if (typeof data.label !== 'string' || !data.label.trim() || data.content || data.title) return;
  const readable = parts.filter(part => part.type === 'text' && part.text.trim() || part.type === 'code' || part.type === 'web');
  const label = readable[0];
  return readable.length === 1 && label?.type === 'text' && label.text.trim() === data.label.trim() ? label.id : undefined;
}
