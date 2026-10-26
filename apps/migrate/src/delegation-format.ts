import { relations, type Message } from '@gonglun/core';

/** Replace only the old generated body; keep its part ID and authored fields. */
export function restoreDelegationBody(message: Message): boolean {
  const data = Object.assign({}, ...message.parts.flatMap(part => part.type === 'data' && part.value && typeof part.value === 'object' && !Array.isArray(part.value) ? [part.value] : []));
  const relation = relations(message).find(part => ['delegate', 'fulfill', 'delegation', 'legacy-delegation'].includes(part.relation));
  if (!relation || typeof data.content !== 'string' || !data.content.trim()) return false;
  const normalize = (text: string) => text.replace(/\s+/gu, '');
  const generated = new Set(['建立关系：DELEGATION']);
  const ids = (relation.roles.target ?? []).map(binding => binding.reference.messageId);
  for (const targets of [ids, ids.map(id => id.slice(-8))]) for (const separator of [',', '、']) {
    if (targets.length) generated.add(`建立关系：DELEGATION；目标：${targets.join(separator)}`);
  }
  let changed = false;
  for (const part of message.parts) if (part.type === 'text' && generated.has(normalize(part.text))) {
    part.text = data.content;
    changed = true;
  }
  // Transport projections and offline exports also carry a cached body.
  const projection = message as Message & { content?: string };
  if (typeof projection.content === 'string' && generated.has(normalize(projection.content))) {
    projection.content = data.content;
    changed = true;
  }
  return changed;
}
