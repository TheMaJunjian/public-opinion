import type { MouseEvent, ReactNode } from 'react';
import type { DemoMessage, UnitSelection } from '../../utils/modelBridge';
import { getRelationTitle } from '../../types';
import { isMessageElementSelected, messageMembersReference, messageTypeReference } from '../../utils/messageElementSelection';
import MessageElement from '../MessageElement';
import MessageTextPart from '../MessageTextPart';
import MessageSettlementActions, { type MessageStakeCounts } from '../MessageSettlementActions';

export default function OrganizationFrameHeader({ message, messageId, kind, memberCount, selectedUnits, activeText,
  counts, openMessageId, openType, onTruth, onValue, onTextMouseUp, joinBadges,
}: {
  joinBadges?: ReactNode;
  message?: DemoMessage;
  messageId: string;
  kind: 'classify' | 'summary' | 'merge';
  memberCount: number;
  selectedUnits: readonly UnitSelection[];
  activeText: boolean;
  counts?: MessageStakeCounts;
  openMessageId?: string | null;
  openType?: 'TRUTH' | 'VALUE' | null;
  onTruth?: (messageId: string) => void;
  onValue?: (messageId: string) => void;
  onTextMouseUp?: (event: MouseEvent<HTMLElement>, messageId: string) => void;
}) {
  const label = kind === 'summary' ? '总结' : kind === 'merge' ? '归并' : '分类';
  const title = getRelationTitle(message?.relationPayload) || `${label}（${memberCount}）`;
  const content = kind === 'summary' ? message?.content || title : title;
  const typeRef = message && messageTypeReference(message);
  const membersRef = message && messageMembersReference(message);
  const typeBadge = <MessageElement reference={typeRef} selected={isMessageElementSelected(selectedUnits, typeRef)} label={label}
    style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999, background: kind === 'merge' ? 'rgba(148,163,184,0.22)' : kind === 'summary' ? 'rgba(52,211,153,0.2)' : 'rgba(34,197,94,0.2)', color: kind === 'merge' ? '#cbd5e1' : kind === 'summary' ? '#6ee7b7' : '#86efac' }}
  >{label}</MessageElement>;
  return <>
    <div style={{ display: 'flex', flexWrap: kind === 'merge' ? 'nowrap' : 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#f3f4f6', flex: kind === 'merge' ? 1 : '1 0 80px', minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {message ? <MessageTextPart message={message} activeText={activeText} onMouseUp={onTextMouseUp}>{content}</MessageTextPart> : content}
      </div>
      {kind === 'merge'
        ? <div style={{ marginLeft: 'auto', flexShrink: 0 }}><MessageSettlementActions messageId={messageId} counts={counts} openMessageId={openMessageId} openType={openType} onTruth={onTruth} onValue={onValue} /></div>
        : <>{joinBadges}{typeBadge}</>}
    </div>
    {kind === 'merge' && <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      {joinBadges}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <MessageElement reference={membersRef} selected={isMessageElementSelected(selectedUnits, membersRef)} label="所含消息" style={{ fontSize: 10, color: '#9ca3af' }}>💬{memberCount}</MessageElement>
        {typeBadge}
      </div>
    </div>}
    {kind === 'classify' && <div style={{ marginTop: 4, fontSize: 10, color: '#9ca3af', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>由 {message?.author ?? '系统'} 发起</span>
      <MessageElement reference={membersRef} selected={isMessageElementSelected(selectedUnits, membersRef)} label="所含消息" style={{ flexShrink: 0 }}>💬 {memberCount}</MessageElement>
      <span style={{ flexShrink: 0 }}>{message ? new Date(message.createdAt).toLocaleDateString('zh-CN') : ''}</span>
    </div>}
  </>;
}
