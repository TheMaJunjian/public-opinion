import type { DemoMessage, UnitSelection } from './modelBridge';

/** A DOM range must stay inside one versioned content part. Offsets use UTF-16. */
export function capturePartSelection(container: HTMLElement, message: DemoMessage, selection = window.getSelection()): UnitSelection | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
  const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer as Element : range.endContainer.parentElement;
  const partElement = startElement?.closest<HTMLElement>('[data-message-part-id]');
  const endPart = endElement?.closest<HTMLElement>('[data-message-part-id]');
  if (partElement !== endPart) return null;
  if (message.parts && !partElement) return null;
  const textContainer = partElement && container.contains(partElement) ? partElement : container;
  if (!textContainer.contains(range.startContainer) || !textContainer.contains(range.endContainer)) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const before = range.cloneRange();
  before.selectNodeContents(textContainer);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const partId = textContainer.dataset.messagePartId ?? message.parts?.find(part => ['text', 'code', 'web'].includes(part.type))?.id ?? 'content';
  const revision = Number(textContainer.dataset.messageRevision) || message.revision || 1;
  return {
    messageId: message.id,
    reference: { messageId: message.id, revision, partId, range: { start, end: start + text.length } },
    selection: { kind: 'text', start, len: text.length, text },
  };
}
