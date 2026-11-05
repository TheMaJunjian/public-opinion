import { Fragment, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

type TextElementProps = {
  children?: ReactNode;
  dangerouslySetInnerHTML?: unknown;
  'data-reading-link'?: unknown;
};
export type ReadingTextLinkHint = { label: string; url: string };
type LinkRange = { start: number; end: number; urlStart: number; urlEnd: number; kind: 'labelled' | 'bare' };

// These are display boundaries, never a URL rewrite or a security allowlist.
// Query order, escapes, fragments, Unicode and original letter case stay intact.
const URL_START = /https?:\/\//gi;
const URL_END = /[\s<>"'`，。！？；、（）【】《》「」『』]/u;
const TERMINAL_PUNCTUATION = /[.,;:!]$/;
const PAIRS = new Map([[')', '('], [']', '['], ['}', '{']]);

function httpAddress(value: string) {
  if (!/^https?:\/\/[^/?#]+/i.test(value)) return false;
  try { return Boolean(new URL(value).hostname); } catch { return false; }
}

/** HTML-derived evidence identifies the title; it is never guessed from prose. */
function hintedRanges(text: string, hints: readonly ReadingTextLinkHint[]): LinkRange[] {
  const ranges: LinkRange[] = [];
  const seen = new Set<string>();
  for (const hint of hints) {
    if (!hint.label.trim() || !httpAddress(hint.url)) continue;
    const key = JSON.stringify([hint.label, hint.url]);
    if (seen.has(key)) continue;
    seen.add(key);
    for (let start = text.indexOf(hint.label); start !== -1; start = text.indexOf(hint.label, start + hint.label.length)) {
      let cursor = start + hint.label.length;
      const labelEnd = cursor;
      while (/[ \t]/.test(text[cursor] || '')) cursor++;
      if (cursor === labelEnd) continue;
      const close = text[cursor] === '(' ? ')' : text[cursor] === '（' ? '）' : null;
      if (!close) continue;
      cursor++;
      while (/[ \t]/.test(text[cursor] || '')) cursor++;
      const urlStart = cursor;
      if (!text.startsWith(hint.url, urlStart)) continue;
      cursor += hint.url.length;
      const urlEnd = cursor;
      while (/[ \t]/.test(text[cursor] || '')) cursor++;
      if (text[cursor] !== close) continue;
      ranges.push({ start, end: cursor + 1, urlStart, urlEnd, kind: 'labelled' });
    }
  }
  // Prefer the complete evidenced label if another label happens to be its suffix.
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const accepted: LinkRange[] = [];
  for (const range of ranges) if (!accepted.length || accepted.at(-1)!.end <= range.start) accepted.push(range);
  return accepted;
}

function bareRanges(text: string): LinkRange[] {
  const ranges: LinkRange[] = [];
  const matcher = new RegExp(URL_START);
  for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
    const urlStart = match.index;
    // Do not turn part of an identifier or another URI scheme into a link.
    if (urlStart && /[\w/@+-]/.test(text[urlStart - 1])) continue;
    let urlEnd = matcher.lastIndex;
    while (urlEnd < text.length && !URL_END.test(text[urlEnd])) urlEnd++;
    let candidate = text.slice(urlStart, urlEnd);
    // Sentence punctuation is left visible outside the URL. An unmatched
    // closing delimiter belongs to its surrounding prose, not to this URL.
    while (candidate) {
      const last = candidate.at(-1)!;
      const opening = PAIRS.get(last);
      if (TERMINAL_PUNCTUATION.test(candidate) && !/[?#]/.test(candidate)
        || opening && candidate.split(last).length > candidate.split(opening).length) {
        candidate = candidate.slice(0, -1); urlEnd--;
      } else break;
    }
    if (!candidate) continue;
    // Parse only to distinguish an actual HTTP(S) address from a bare prefix;
    // never use href/toString(), which would normalize the stored characters.
    if (!httpAddress(candidate)) continue;
    let start = urlStart, end = urlEnd;
    let before = start, after = end;
    while (before > 0 && /[ \t]/.test(text[before - 1])) before--;
    while (after < text.length && /[ \t]/.test(text[after])) after++;
    if (before > 0 && (text[before - 1] === '(' && text[after] === ')'
      || text[before - 1] === '（' && text[after] === '）')) {
      start = before - 1; end = after + 1;
    }
    ranges.push({ start, end, urlStart, urlEnd, kind: 'bare' });
    matcher.lastIndex = end;
  }
  return ranges;
}

function linkRanges(text: string, hints: readonly ReadingTextLinkHint[]): LinkRange[] {
  const hinted = hintedRanges(text, hints);
  const ranges = [...hinted, ...bareRanges(text).filter(range => !hinted.some(known => known.start < range.end && known.end > range.start))]
    .sort((a, b) => a.start - b.start);
  if (hints.length) return ranges;
  for (const range of ranges) {
    if (range.kind === 'labelled' || !['(', '（'].includes(text[range.start])) continue;
    const lineStart = text.lastIndexOf('\n', range.start - 1) + 1;
    const nextLine = text.indexOf('\n', range.end), lineEnd = nextLine === -1 ? text.length : nextLine;
    const before = text.slice(lineStart, range.start), after = text.slice(range.end, lineEnd);
    const label = before.trim();
    // Legacy plain text has no HTML evidence. Only a single, standalone title
    // plus parenthesized URL is eligible; sentence-like prose stays outside.
    if (!label || !/[ \t]$/.test(before) || after.trim()
      || /[。！？；：.!?;:()（）[\]【】\r\n]/u.test(label)
      || ranges.filter(other => other.start >= lineStart && other.start < lineEnd).length !== 1) continue;
    range.start = lineStart + before.indexOf(label);
    range.kind = 'labelled';
  }
  return ranges;
}

/** Read only transparent markup; component output cannot be inferred here. */
function textOf(node: ReactNode): string | null {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    let text = '';
    for (const child of node) { const value = textOf(child); if (value === null) return null; text += value; }
    return text;
  }
  if (!isValidElement<TextElementProps>(node) || (typeof node.type !== 'string' && node.type !== Fragment)
    || node.props.dangerouslySetInnerHTML || node.props['data-reading-link']) return null;
  return textOf(node.props.children);
}

/** Slice at source UTF-16 offsets, retaining annotation props and callbacks. */
function sliceMarkup(node: ReactNode, from: number, to: number, prefix: string): ReactNode {
  let offset = 0, serial = 0;
  const visit = (current: ReactNode): ReactNode => {
    if (current == null || typeof current === 'boolean') return null;
    if (typeof current === 'string' || typeof current === 'number') {
      const value = String(current), start = offset;
      offset += value.length;
      return value.slice(Math.max(0, from - start), Math.max(0, Math.min(value.length, to - start)));
    }
    if (Array.isArray(current)) return current.map(visit);
    const element = current as ReactElement<TextElementProps>;
    const start = offset;
    const children = visit(element.props.children);
    if (offset <= from || start >= to) return null;
    return cloneElement(element, { key: `${prefix}:${serial++}:${element.key ?? ''}` }, children);
  };
  return visit(node);
}

/**
 * Pure display: all whitespace, brackets and URLs remain original text nodes.
 * The surrounding square brackets are CSS-generated; no text, link,
 * HTML parsing or URL execution is added. Already formatted/opaque children
 * and source-text mismatches are kept untouched rather than guessed.
 */
export function renderReadingTextLinks(content: ReactNode, text?: string, hints: readonly ReadingTextLinkHint[] = []): ReactNode {
  const actual = textOf(content);
  if (actual === null || text !== undefined && actual !== text) return content;
  const ranges = linkRanges(actual, hints);
  if (!ranges.length) return content;
  const result: ReactNode[] = [];
  let cursor = 0;
  for (const [index, range] of ranges.entries()) {
    const prefix = `reading-link:${index}`;
    if (cursor < range.start) result.push(<Fragment key={`${prefix}:before`}>{sliceMarkup(content, cursor, range.start, `${prefix}:before`)}</Fragment>);
    result.push(<span key={prefix} data-reading-link="true" data-reading-link-kind={range.kind} style={{ overflowWrap: 'anywhere' }}>
      {sliceMarkup(content, range.start, range.urlStart, `${prefix}:open`)}
      <span data-reading-link-url="true" style={{ color: 'var(--ink-94a3b8)' }}>{sliceMarkup(content, range.urlStart, range.urlEnd, `${prefix}:url`)}</span>
      {sliceMarkup(content, range.urlEnd, range.end, `${prefix}:close`)}
    </span>);
    cursor = range.end;
  }
  if (cursor < actual.length) result.push(<Fragment key="reading-link:after">{sliceMarkup(content, cursor, actual.length, 'reading-link:after')}</Fragment>);
  return result;
}

export default function ReadingTextLinks({ text, children, hints }: { text: string; children?: ReactNode; hints?: readonly ReadingTextLinkHint[] }) {
  return <>{renderReadingTextLinks(children ?? text, text, hints)}</>;
}
