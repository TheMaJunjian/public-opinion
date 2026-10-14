import type { ReactNode, MouseEvent } from 'react';
import type { DemoMessage } from '../utils/modelBridge';

/** Keep selection offsets local to content, never to card metadata or controls. */
export default function MessageTextPart({ message, partId, children, activeText = false, onMouseUp }: {
  message: DemoMessage;
  partId?: string;
  children?: ReactNode;
  activeText?: boolean;
  onMouseUp?: (event: MouseEvent<HTMLElement>, messageId: string) => void;
}) {
  const part = message.parts?.find(candidate => partId ? candidate.id === partId : ['text', 'code', 'web'].includes(candidate.type));
  const text = part?.type === 'text' ? part.text : part?.type === 'code' ? part.source : part?.type === 'web' ? part.excerpt : message.content;
  const selectable = activeText || ['classify', 'summary', 'merge'].includes(message.relationType ?? '');
  if (message.parts && !part) return <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{children ?? text}</div>;
  return <div
    data-message-part-id={part?.id ?? partId ?? 'content'}
    data-message-revision={message.revision ?? 1}
    data-gesture-disabled={selectable ? 'true' : undefined}
    onMouseUp={event => { if (selectable && event.detail < 2) onMouseUp?.(event, message.id); }}
    style={{ userSelect: selectable ? 'text' : 'none', cursor: activeText ? 'text' : 'inherit', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0 }}
  >{children ?? text}</div>;
}
