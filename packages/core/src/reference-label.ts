import type { Part } from './types.js';

/** Older UI references stored their label as a text part. It is still the edge label, not a second body card. */
export function referenceLabelPart(parts: readonly Part[] | undefined): string | undefined {
  if (!parts?.some(part => part.type === 'relation' && part.relation === 'reference')) return;
  const data = Object.assign({}, ...parts.flatMap(part => part.type === 'data' && part.value && typeof part.value === 'object' && !Array.isArray(part.value) ? [part.value] : []));
  if (typeof data.label !== 'string' || !data.label.trim() || data.content || data.title) return;
  const readable = parts.filter(part => part.type === 'text' && part.text.trim() || part.type === 'code' || part.type === 'web');
  const label = readable[0];
  return readable.length === 1 && label?.type === 'text' && label.text.trim() === data.label.trim() ? label.id : undefined;
}
