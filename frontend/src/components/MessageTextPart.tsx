import { type ReactNode, type MouseEvent, type ClipboardEvent } from 'react';
import type { DemoMessage } from '../utils/modelBridge';
import { useReadingTextLinks } from './ReadingTextLinksContext';
import { renderReadingTextLinks } from './ReadingTextLinks';
import { messageTextField } from '../utils/messageTextField';

/** Keep selection offsets local to content, never to card metadata or controls. */
export default function MessageTextPart({ message, partId, displayedText, children, activeText = false, onMouseUp }: {
  message: DemoMessage;
  partId?: string;
  displayedText?: string;
  children?: ReactNode;
  activeText?: boolean;
  onMouseUp?: (event: MouseEvent<HTMLElement>, messageId: string) => void;
}) {
  const { enabled: readingLinks, hints } = useReadingTextLinks(message.id);
  const field = partId ? { part: message.parts?.find(candidate => candidate.id === partId), path: undefined } : messageTextField(message, displayedText);
  const part = field?.part;
  const text = displayedText ?? (part?.type === 'text' ? part.text : part?.type === 'code' ? part.source : part?.type === 'web' ? part.excerpt : message.content);
  const selectable = activeText || ['classify', 'summary', 'merge'].includes(message.relationType ?? '');
  const formatLinks = readingLinks && part?.type !== 'code';
  const content = formatLinks ? renderReadingTextLinks(children ?? text, text, hints) : children ?? text;
  const hasTextSelection = (element: HTMLElement) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return false;
    const range = selection.getRangeAt(0);
    return element.contains(range.startContainer) && element.contains(range.endContainer);
  };
  const copyOriginalText = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!event.clipboardData) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);
    if (!event.currentTarget.contains(range.startContainer) || !event.currentTarget.contains(range.endContainer)) return;
    // CSS block layout can add visual line breaks to Selection.toString().
    // Copy the unchanged DOM text used by source ranges and correction records.
    event.clipboardData.setData('text/plain', range.toString());
    event.preventDefault();
  };
  return <div
    className="message-card-body"
    data-message-part-id={part?.id ?? (!message.parts ? partId ?? 'content' : undefined)}
    data-message-part-path={field?.path ? JSON.stringify(field.path) : undefined}
    data-message-revision={message.revision ?? 1}
    data-gesture-disabled={selectable ? 'true' : undefined}
    onMouseUp={event => {
      // Reading a local document must not consume the browser selection as a
      // composer fragment before the reader can copy it.
      if (readingLinks && hasTextSelection(event.currentTarget)) { event.stopPropagation(); return; }
      if (selectable && event.detail < 2) onMouseUp?.(event, message.id);
    }}
    // The click following a text drag must not toggle the card or a highlighted fragment.
    onClickCapture={event => { if ((selectable || readingLinks) && hasTextSelection(event.currentTarget)) event.stopPropagation(); }}
    onCopy={copyOriginalText}
    style={{ userSelect: selectable || readingLinks ? 'text' : 'none', cursor: activeText || readingLinks ? 'text' : 'inherit', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0,
      fontFamily: part?.type === 'code' ? 'Menlo, Monaco, Consolas, monospace' : 'var(--font-reading)', fontSize: 'inherit', fontWeight: 'inherit' }}
  >{content}</div>;
}
