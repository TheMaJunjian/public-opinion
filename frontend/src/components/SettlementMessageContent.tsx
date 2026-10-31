import type { MouseEvent } from 'react';
import type { DemoMessage } from '../utils/modelBridge';
import { getSettlementDetails } from '../utils/messageDisplay';

/** Settlement targets are navigable identities, never copies of their bodies. */
export default function SettlementMessageContent({ message, onTargetClick, disabled = false, showDetails = true }: {
  message: DemoMessage;
  onTargetClick?: (event: MouseEvent, targetId: string) => void;
  disabled?: boolean;
  showDetails?: boolean;
}) {
  const targetId = message.settlementTargetId;
  const details = showDetails ? getSettlementDetails(message) : '';
  return <div style={{ display: 'contents' }}>
    {targetId ? <div style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: '100%', order: 1, fontSize: 11 }}>
      <span>目标</span>
      <button type="button" title={`跳转到目标消息 ${targetId}`} disabled={disabled || !onTargetClick}
        onClick={event => { event.stopPropagation(); onTargetClick?.(event, targetId); }}
        onDoubleClick={event => event.stopPropagation()}
        style={{ padding: '1px 5px', border: '1px solid var(--line-374151)', borderRadius: 3, background: 'var(--surface-rgba-148-163-184-0-05)', color: 'var(--ink-93c5fd)', cursor: disabled || !onTargetClick ? 'default' : 'pointer', fontFamily: 'monospace', fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' }}>{targetId}</button>
    </div> : <span title="这条结算记录没有保存目标消息引用" style={{ order: 1, fontSize: 11, color: 'var(--ink-9ca3af)' }}>目标未记录</span>}
    {details && <div style={{ order: 1, minWidth: 0, fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{details}</div>}
  </div>;
}
