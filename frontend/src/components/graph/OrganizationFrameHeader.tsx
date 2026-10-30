import StakeTierBadge, { SkinOrnament } from '../../theme/StakeTierBadge';
import ThemeIcon from '../../theme/ThemeIcon';
import type { MouseEvent, ReactNode } from 'react';
import type { DemoMessage, UnitSelection } from '../../utils/modelBridge';
import { getRelationTitle } from '../../types';
import { isMessageElementSelected, messageMembersReference, messageTypeReference } from '../../utils/messageElementSelection';
import MessageElement from '../MessageElement';
import { MessageDisplayMarker } from '../MessageDisplayHints';
import MessageTextPart from '../MessageTextPart';
import MessageSettlementActions, { type MessageStakeCounts } from '../MessageSettlementActions';
import { CardWidthHandle } from './CardWidthContext';
import HomeFilterBadge from '../HomeFilterBadge';

export default function OrganizationFrameHeader({ message, messageId, kind, memberCount, selectedUnits, activeText,
  counts, openMessageId, openType, onTruth, onValue, onTextMouseUp, joinBadges, correctionRecords, homeLabel, homeReason,
}: {
  joinBadges?: ReactNode;
  correctionRecords?: ReactNode;
  homeLabel?: string|null;
  homeReason?: string;
  message?: DemoMessage;
  messageId: string;
  kind: 'classify' | 'summary' | 'merge' | 'arrange';
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
  const label = kind === 'summary' ? '总结' : kind === 'merge' ? '归并' : kind === 'arrange' ? '排列' : '分类';
  const hasFrameCard = kind === 'merge' || kind === 'arrange';
  const title = getRelationTitle(message?.relationPayload) || `${label}（${memberCount}）`;
  const content = kind === 'summary' ? message?.content || title : title;
  const typeRef = message && messageTypeReference(message);
  const membersRef = message && messageMembersReference(message);
  const typeBadge = <MessageElement reference={typeRef} selected={isMessageElementSelected(selectedUnits, typeRef)} label={label}
    style={{ flexShrink: 0, fontSize: 10, fontWeight: hasFrameCard?700:600, padding: hasFrameCard?'2px 6px':'1px 6px', borderRadius: hasFrameCard?4:999, background: kind === 'arrange' ? 'var(--surface-rgba-167-139-250-0-2)' : kind === 'merge' ? 'var(--surface-rgba-148-163-184-0-22)' : kind === 'summary' ? 'var(--surface-rgba-52-211-153-0-2)' : 'var(--surface-rgba-34-197-94-0-2)', color: kind === 'arrange' ? 'var(--ink-c4b5fd)' : kind === 'merge' ? 'var(--ink-cbd5e1)' : kind === 'summary' ? 'var(--ink-6ee7b7)' : 'var(--ink-86efac)' }}
  >{label}</MessageElement>;
  const identity = <div data-card-header="true" style={{fontSize:10,color:'var(--ink-9ca3af)',textAlign:'right'}}><span data-card-header-content="true" style={{display:'inline-flex',whiteSpace:'nowrap',width:'max-content'}}><StakeTierBadge counts={counts} /><span>{messageId}</span><MessageDisplayMarker messageId={messageId} /></span></div>;
  if(hasFrameCard)return <><SkinOrnament />
    <CardWidthHandle messageId={messageId}/>
    {activeText&&<div style={{fontSize:11,color:'var(--ink-0b84ff)',marginBottom:4}}>拖选文字即可选择片段，或点击已有高亮片段</div>}
    <div data-organization-card-header="true" style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:8,marginBottom:4}}>
      <span style={{display:'inline-flex',alignItems:'center',gap:6}}>{typeBadge}<HomeFilterBadge label={homeLabel} reason={homeReason}/></span>
      <div style={{marginLeft:'auto',display:'flex',flexDirection:'column',alignItems:'flex-end',gap:2}}>{identity}
        <MessageSettlementActions messageId={messageId} counts={counts} openMessageId={openMessageId} openType={openType} onTruth={onTruth} onValue={onValue}/>
      </div>
    </div>
    <div className="skin-frame-title" style={{fontSize:12,fontWeight:600,color:'var(--ink-f3f4f6)',minWidth:0,whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>
      {message?<MessageTextPart message={message} activeText={activeText} onMouseUp={onTextMouseUp}>{activeText&&message.parts?undefined:content}</MessageTextPart>:content}
    </div>
    {correctionRecords}
    <div style={{marginTop:4,display:'flex',flexWrap:'wrap',alignItems:'center',gap:8}}>{joinBadges}
      <MessageElement reference={membersRef} selected={isMessageElementSelected(selectedUnits,membersRef)} label="所含消息" style={{marginLeft:'auto',fontSize:10,color:'var(--ink-9ca3af)'}}><ThemeIcon name="message" fallback="💬" />{memberCount}</MessageElement>
    </div>
  </>;
  return <><SkinOrnament />
    <CardWidthHandle messageId={messageId} />
    {activeText && <div style={{fontSize:11,color:'var(--ink-0b84ff)',marginBottom:4}}>拖选文字即可选择片段，或点击已有高亮片段</div>}
    {identity}
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <div className="skin-frame-title" style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-f3f4f6)', flex: '1 0 80px', minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {message ? <MessageTextPart message={message} activeText={activeText} onMouseUp={onTextMouseUp}>{activeText && message.parts ? undefined : content}</MessageTextPart> : content}
      </div>
      {correctionRecords}
      {joinBadges}<span style={{display:'inline-flex',alignItems:'center',gap:6}}>{typeBadge}<HomeFilterBadge label={homeLabel} reason={homeReason}/></span>
    </div>
    {kind === 'classify' && <div style={{ marginTop: 4, fontSize: 10, color: 'var(--ink-9ca3af)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <MessageElement reference={membersRef} selected={isMessageElementSelected(selectedUnits, membersRef)} label="所含消息" style={{ flexShrink: 0 }}><ThemeIcon name="message" fallback="💬" /> {memberCount}</MessageElement>
    </div>}
  </>;
}
