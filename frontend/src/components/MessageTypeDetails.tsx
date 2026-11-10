import type { DemoMessage } from '../utils/modelBridge';
import { getMessageTypeDetails } from '../utils/messageDisplay';

/** Shared by graph cards and list records so subtype and judgment never drift apart. */
export default function MessageTypeDetails({ message }: { message: DemoMessage }) {
  return <>{getMessageTypeDetails(message).map(detail => <span key={detail.kind} data-message-type-detail={detail.kind}
    title={detail.label} style={{ display: 'inline-block', marginRight: 6, padding: '1px 5px', borderRadius: 3,
      border: '1px solid var(--line-rgba-148-163-184-0-35)', background: 'var(--surface-rgba-148-163-184-0-05)',
      color: detail.tone === 'pass' ? 'var(--ink-4ade80)' : detail.tone === 'reject' ? 'var(--ink-f87171)' : 'var(--text-secondary)',
      fontSize: 11, fontWeight: detail.kind === 'verdict' ? 600 : 400, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%' }}>
    {detail.label}
  </span>)}</>;
}
