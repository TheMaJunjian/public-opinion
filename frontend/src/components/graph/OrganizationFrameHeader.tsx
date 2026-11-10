import StakeTierBadge, { SkinOrnament } from '../../theme/StakeTierBadge';
import type { MouseEvent, ReactNode } from 'react';
import type { DemoMessage, UnitSelection } from '../../utils/modelBridge';
import { getRelationTitle } from '../../types';
import MessageElement from '../MessageElement';
import MessageCardSelfStake from '../MessageCardSelfStake';
import MessageMemberCount from '../MessageMemberCount';
import { MessageDisplayMarker } from '../MessageDisplayHints';
import MessageTextPart from '../MessageTextPart';
import MessageSettlementActions, { type MessageStakeCounts } from '../MessageSettlementActions';
import { CardWidthHandle } from './CardWidthContext';
import HomeFilterBadge from '../HomeFilterBadge';

export default function OrganizationFrameHeader({ message, messageId, kind, depth, memberCount, directMemberCount, activeText,
  counts, openMessageId, openType, onTruth, onValue, onTextMouseUp, joinBadges, correctionRecords, homeLabel, homeReason, canEnter = false,
}: {
  joinBadges?: ReactNode;
  correctionRecords?: ReactNode;
  homeLabel?: string|null;
  homeReason?: string;
  message?: DemoMessage;
  messageId: string;
  kind: 'classify' | 'summary' | 'merge' | 'arrange';
  depth?: number;
  memberCount?: number;
  directMemberCount?: number;
  canEnter?: boolean;
  selectedUnits: readonly UnitSelection[];
  activeText: boolean;
  counts?: MessageStakeCounts;
  openMessageId?: string | null;
  openType?: 'TRUTH' | 'VALUE' | 'REVIEW' | null;
  onTruth?: (messageId: string) => void;
  onValue?: (messageId: string) => void;
  onTextMouseUp?: (event: MouseEvent<HTMLElement>, messageId: string) => void;
}) {
  const label = kind === 'summary' ? '总结' : kind === 'merge' ? '归并' : kind === 'arrange' ? '排列' : '分类';
  const hasFrameCard = kind === 'merge' || kind === 'arrange';
  const title = getRelationTitle(message?.relationPayload) || (memberCount === undefined ? label : `${label}（${memberCount}）`);
  const content = kind === 'summary' ? (message?.relationPayload?.separateTitle ? message.content : getRelationTitle(message?.relationPayload) || message?.content) || title : title;
  const typeBadge = <MessageElement data-skin-type-label="true" label={label}
    style={{ flexShrink: 0, fontSize: 10, fontWeight: hasFrameCard?700:600, padding: hasFrameCard?'2px 6px':'1px 6px', borderRadius: hasFrameCard?4:999, background: kind === 'arrange' ? 'var(--surface-rgba-167-139-250-0-2)' : kind === 'merge' ? 'var(--surface-rgba-148-163-184-0-22)' : kind === 'summary' ? 'var(--surface-rgba-52-211-153-0-2)' : 'var(--surface-rgba-34-197-94-0-2)', color: kind === 'arrange' ? 'var(--ink-c4b5fd)' : kind === 'merge' ? 'var(--ink-cbd5e1)' : kind === 'summary' ? 'var(--ink-6ee7b7)' : 'var(--ink-86efac)' }}
  >{label}</MessageElement>;
  const depthBadge = depth !== undefined && <span className="skin-frame-depth" style={{display:'none'}} title={`框架层级：第 ${depth + 1} 层`}>{['Ⅰ','Ⅱ','Ⅲ'][depth] ?? depth + 1}</span>;
  const identity = <div className="organization-frame-identity" data-card-header="true" style={{fontSize:10,color:'var(--ink-9ca3af)',textAlign:'right'}}><span className="organization-frame-identity-content" data-card-header-content="true" style={{display:'inline-flex',whiteSpace:'nowrap',width:'max-content'}}><StakeTierBadge counts={counts} /><span className="organization-frame-id" title={messageId}><bdi dir="ltr">{messageId}</bdi></span><MessageDisplayMarker messageId={messageId} /></span></div>;
  if(hasFrameCard)return <><SkinOrnament />
    <CardWidthHandle messageId={messageId}/>
    <div data-organization-card-header="true" data-card-header="true" data-card-header-content="true" style={{display:'flex',width:'max-content',minWidth:'100%',alignItems:'flex-start',justifyContent:'space-between',gap:8,marginBottom:4}}>
      <span className="organization-frame-type-group" style={{display:'inline-flex',alignItems:'center',gap:6}}>{depthBadge}{typeBadge}<HomeFilterBadge label={homeLabel} reason={homeReason}/>{message&&<MessageCardSelfStake message={message}/>}</span>
      <div style={{marginLeft:'auto',display:'flex',flexDirection:'column',alignItems:'flex-end',gap:2}}>{identity}
        <MessageSettlementActions messageId={messageId} counts={counts} openMessageId={openMessageId} openType={openType} onTruth={onTruth} onValue={onValue}/>
      </div>
    </div>
    {correctionRecords}
    <div className="organization-frame-members" style={{marginTop:4,display:'flex',flexWrap:'wrap',alignItems:'center',gap:8}}>{joinBadges}
      <MessageMemberCount total={memberCount} direct={directMemberCount} style={{marginLeft:'auto',fontSize:'max(var(--badge-min-size), 10px)',color:'var(--ink-9ca3af)'}} />
    </div>
  </>;
  return <><SkinOrnament />
    <CardWidthHandle messageId={messageId} />
    {activeText && <div style={{fontSize:11,color:'var(--ink-0b84ff)',marginBottom:4}}>拖选文字即可选择片段，或点击已有高亮片段</div>}
    <div className="organization-frame-heading" style={{display:'contents'}}>
    {identity}
    <div className="organization-frame-content-row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <div className="skin-frame-title organization-frame-title" style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-f3f4f6)', flex: '1 0 80px', minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {message ? <MessageTextPart message={message} displayedText={content} activeText={activeText} onMouseUp={onTextMouseUp}/> : content}
      </div>
      <div className="organization-frame-records" style={{display:'contents'}}>{correctionRecords}{joinBadges}</div>
      <span className="organization-frame-type-group" style={{display:'inline-flex',alignItems:'center',gap:6}}>{depthBadge}{typeBadge}<HomeFilterBadge label={homeLabel} reason={homeReason}/>{message&&<MessageCardSelfStake message={message}/>}</span>
    </div>
    <div className="organization-frame-actions" style={{display:'none'}}>
      <MessageSettlementActions messageId={messageId} counts={counts} openMessageId={openMessageId} openType={openType} onTruth={onTruth} onValue={onValue}/>
    </div>
    </div>
    <div className="organization-frame-members" style={{ marginTop: 4, fontSize: 10, color: 'var(--ink-9ca3af)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <MessageMemberCount total={memberCount} direct={directMemberCount} style={{ flexShrink: 0 }} showEnterHint={canEnter} />
    </div>
  </>;
}
