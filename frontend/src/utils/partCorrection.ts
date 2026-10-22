import { replaceReference, resolveReference, textOf, type Json, type Message as CoreMessage } from '@gonglun/core';
import { unitSelectionToReference, type DemoMessage, type UnitSelection } from './modelBridge';

/** Translate a visible selection through effective edits back to the immutable original. */
export function mapCorrectionSelection(original: string, displayed: string,
  changes: Array<{ start: number; end: number; replacement: string }>, range: { start: number; end: number }, replacement: string) {
  if (range.start < 0 || range.end <= range.start || range.end > displayed.length) throw new Error('当前选择已变化，请重新选字');
  const spans: Array<{ start: number; end: number; visibleStart: number; visibleEnd: number; changed: boolean }> = [];
  let cursor = 0, visible = 0;
  for (const change of [...changes].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const length = change.start - cursor;
    if (length > 0) spans.push({ start: cursor, end: change.start, visibleStart: visible, visibleEnd: visible + length, changed: false });
    visible += length;
    spans.push({ start: change.start, end: change.end, visibleStart: visible, visibleEnd: visible + change.replacement.length, changed: true });
    cursor = change.end; visible += change.replacement.length;
  }
  if (cursor < original.length) spans.push({ start: cursor, end: original.length, visibleStart: visible, visibleEnd: displayed.length, changed: false });
  const selected = spans.filter(span => range.start < span.visibleEnd && range.end > span.visibleStart);
  if (!selected.length) throw new Error('无法定位对应原文，请重新选字');
  const first = selected[0], last = selected.at(-1)!;
  const start = first.changed ? first.start : first.start + range.start - first.visibleStart;
  const end = last.changed ? last.end : last.start + range.end - last.visibleStart;
  const visibleStart = first.changed ? first.visibleStart : range.start;
  const visibleEnd = last.changed ? last.visibleEnd : range.end;
  return { range: { start, end }, value: displayed.slice(visibleStart, range.start) + replacement + displayed.slice(range.end, visibleEnd) };
}

export function preparePartCorrection(message: DemoMessage, selection: UnitSelection, content: string) {
  if (!message.parts) throw new Error('请重新加载消息后选择要修改的部件');
  const reference = unitSelectionToReference(selection, new Map([[message.id, message]]));
  const coreMessage = message as unknown as CoreMessage;
  const current = resolveReference(reference, id => id === message.id ? coreMessage : undefined);
  if (current === undefined) throw new Error('选择的部件或版本已变化，请重新选择');
  let value: Json;
  if (typeof current === 'string') value = content;
  else if (reference.partId && !reference.memberId && !reference.path?.length && !reference.range) {
    const part = message.parts.find(candidate => candidate.id === reference.partId)!;
    if (part.type === 'text') value = { ...part, text: content };
    else if (part.type === 'code') value = { ...part, source: content };
    else if (part.type === 'web') value = { ...part, excerpt: content };
    else {
      try { value = JSON.parse(content) as Json; } catch { throw new Error('此部件需要有效的 JSON 内容'); }
    }
  } else {
    try { value = JSON.parse(content) as Json; } catch { throw new Error(reference.partId ? '此字段需要有效的 JSON 值' : '整条消息的修改内容需要是部件数组'); }
  }
  const parts = replaceReference(coreMessage, reference, value);
  const display = (input: unknown) => typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  const part = message.parts.find(candidate => candidate.id === reference.partId);
  if (part && ['text', 'code', 'web'].includes(part.type)
    && !reference.memberId && (!reference.path?.length || reference.path.length === 1 && ['text', 'source', 'excerpt'].includes(String(reference.path[0])))) {
    return { before: textOf(coreMessage), after: textOf({ ...coreMessage, parts }), value, target: { ...selection, reference } };
  }
  return { before: display(reference.partId ? current : message.parts), after: display(value), value, target: { ...selection, reference } };
}
