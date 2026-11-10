import type { Message, Part, Reference } from './types.js';

const readable = (part: Part | undefined) => part?.type === 'text' ? part.text
  : part?.type === 'code' ? part.source : part?.type === 'web' ? part.excerpt || part.url : undefined;
const string = (value: unknown) => typeof value === 'string' ? value : undefined;
const dataOf = (message: Pick<Message, 'parts'>): Record<string, unknown> => Object.assign({}, ...message.parts.flatMap(part =>
  part.type === 'data' && part.value && typeof part.value === 'object' && !Array.isArray(part.value) ? [part.value] : []));

/** Keep both sides visible in compact summaries, instead of truncating away the replacement. */
export function formatCorrectionSummary(before: string | undefined, after: string | undefined, limit?: number): string {
  const preview = (value: string) => limit === undefined ? value : (() => {
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  })();
  const original = before ? `「${preview(before)}」` : '所选内容';
  if (after === undefined) return `更正${original}`;
  if (!after.length) return `删除${original}`;
  if (before === '') return `在所选位置插入「${preview(after)}」`;
  return `将${original}修改为「${preview(after)}」`;
}

/** Only an immutable target version may supply text missing from the correction itself. */
export function correctionTargetReference(message: Pick<Message, 'parts'>): Reference | undefined {
  const relation = message.parts.find(part => part.type === 'relation' && ['correct', 'amend'].includes(part.relation));
  if (relation?.type !== 'relation' || relation.roles.target?.length !== 1) return;
  const reference = relation.roles.target[0]!.reference, expected = dataOf(message).expectedRevision;
  const revision = reference.revision ?? (typeof expected === 'number' ? expected : undefined);
  return revision === undefined ? undefined : { ...reference, revision };
}

/** Describe the selected text, never the generated relation body or endpoint IDs. */
export function messageCorrectionSummary(message: Pick<Message, 'parts'>, target?: Pick<Message, 'parts'>, limit = 24): string | undefined {
  const relation = message.parts.find(part => part.type === 'relation' && ['correct', 'amend'].includes(part.relation));
  if (relation?.type !== 'relation') return;
  const data = dataOf(message);
  if (data.correctionKind === 'WIDTH') return typeof data.correctionWidth === 'number' ? `宽度调整 · ${data.correctionWidth} px` : '宽度调整';
  const reference = relation.roles.target?.[0]?.reference;
  const field = readable(target?.parts.find(part => part.id === reference?.partId));
  const before = string(data.correctionBeforeContent) ?? (target ? target.parts.flatMap(part => {
    const value = readable(part); return value === undefined ? [] : [value];
  }).join('\n') : undefined);
  const after = readable(message.parts.find(part => part.id === 'corrected-body'))
    ?? string(data.correctionAfterContent) ?? string(data.correctionContent);
  let replacement = string(data.value) ?? string(data.correctionValue);
  let original: string | undefined;
  const range = reference?.range;
  if (field !== undefined) {
    original = range ? field.slice(range.start, range.end) : field;
    if (replacement === undefined && before !== undefined && after !== undefined) {
      let offset = 0;
      for (const part of target!.parts) {
        if (part.id === reference?.partId) break;
        const value = readable(part); if (value !== undefined) offset += value.length + 1;
      }
      const prefix = before.slice(0, offset + (range?.start ?? 0)), suffix = before.slice(offset + (range?.end ?? field.length));
      if (after.length >= prefix.length + suffix.length && after.startsWith(prefix) && after.endsWith(suffix))
        replacement = after.slice(prefix.length, after.length - suffix.length);
    }
  } else if (before !== undefined && !reference?.partId && !range) original = before;
  else if (before !== undefined && after !== undefined) {
    // A self-contained snapshot can describe an edit even when its target is not loaded.
    // Use the exact selected range when it reproduces the stored result.
    if (range && replacement !== undefined && before.slice(0, range.start) + replacement + before.slice(range.end) === after)
      original = before.slice(range.start, range.end);
    else {
      let start = 0, end = before.length, nextEnd = after.length;
      while (start < end && start < nextEnd && before[start] === after[start]) start++;
      while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
      original = before.slice(start, end); replacement = after.slice(start, nextEnd);
    }
  }
  return formatCorrectionSummary(original, replacement ?? after, limit);
}
