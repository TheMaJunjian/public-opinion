import ThemeIcon from '../theme/ThemeIcon';
import {useContext} from 'react';
import {ModerationContext,reviewStatusLabel,type ArbitrationType} from './ModerationContext';

export interface MessageStakeCounts {
  truth: { pro: number; con: number };
  value: { pro: number; con: number };
}

export default function MessageSettlementActions({ messageId, counts, openMessageId, openType, onTruth, onValue, fontSize = 10 }: {
  messageId: string;
  counts?: MessageStakeCounts;
  openMessageId?: string | null;
  openType?: ArbitrationType | null;
  onTruth?: (messageId: string) => void;
  onValue?: (messageId: string) => void;
  fontSize?: number;
}) {
  const moderation=useContext(ModerationContext),review=moderation?.summaries.get(messageId);
  return <div data-message-settlement-actions={messageId} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize, flexShrink: 0, whiteSpace: 'nowrap' }}>
    {review&&<span data-settlement-statistics="REVIEW" style={{display:'inline-flex',alignItems:'center',gap:2}}>
      {(['pass','reject'] as const).filter(verdict=>review[verdict]>0).map(verdict=><button key={verdict} type="button"
        title="查看审核通过与审核不通过汇总" aria-label={`审核${verdict==='pass'?'通过':'不通过'} ${review[verdict]} 点，查看记录`}
        onClick={event=>{event.stopPropagation();moderation?.open(messageId);}} onDoubleClick={event=>event.stopPropagation()}
        style={{display:'inline-flex',gap:3,color:verdict==='pass'?'var(--ink-4ade80)':'var(--ink-f87171)',fontSize:'inherit',background:'none',border:0,padding:'0 2px',cursor:'pointer'}}>
        <span aria-hidden="true">{verdict==='pass'?'@':'#'}</span><span style={{fontWeight:review[verdict]>review[verdict==='pass'?'reject':'pass']?700:undefined}}>{review[verdict]}</span>
      </button>)}
      <button type="button" data-settlement-toggle-review="true" title="审核仲裁" aria-label={`审核仲裁：${reviewStatusLabel[review.status]}`} aria-expanded={moderation?.activeId===messageId}
        onClick={event=>{event.stopPropagation();moderation?.arbitrate(messageId);}} onDoubleClick={event=>event.stopPropagation()}
        style={{fontSize:13,cursor:'pointer',background:moderation?.activeId===messageId?'var(--surface-rgba-99-102-241-0-2)':'none',border:`1px solid ${moderation?.activeId===messageId?'var(--line-6366f1)':'transparent'}`,borderRadius:4,padding:'0 3px',color:moderation?.activeId===messageId?'var(--ink-a5b4fc)':'var(--ink-6b7280-2)',lineHeight:1}}>
        <ThemeIcon name="review" fallback="🛡️"/>
      </button>
    </span>}
    {(['TRUTH', 'VALUE'] as const).map(type => {
      const truth = type === 'TRUTH';
      const stake = truth ? counts?.truth : counts?.value;
      const toggle = truth ? onTruth : onValue;
      const open = openMessageId === messageId && openType === type;
      const color = truth ? 'var(--ink-a5b4fc)' : 'var(--ink-fcd34d)';
      return <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        {!!stake && (stake.pro > 0 || stake.con > 0) && <span data-settlement-statistics={type} title={truth ? '真假统计' : '价值统计'} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {stake.pro > 0 && <span aria-label={`${truth ? '真' : '有价值'} ${stake.pro} 点`} style={{ color: 'var(--ink-4ade80)' }}>{truth ? '✓' : <span aria-hidden="true" style={{ marginRight: 2, fontSize: '1em', lineHeight: 1, verticalAlign: '-0.05em' }}>▲</span>}<span style={{fontWeight:stake.pro>stake.con?700:undefined,textDecorationLine:stake.pro>stake.con?'underline':undefined,textDecorationThickness:1,textUnderlineOffset:3}}>{stake.pro}</span></span>}
          {stake.con > 0 && <span aria-label={`${truth ? '假' : '低价值'} ${stake.con} 点`} style={{ color: 'var(--ink-f87171)' }}>{truth ? '✕' : <span aria-hidden="true" style={{ marginRight: 2, fontSize: '1em', lineHeight: 1, verticalAlign: '-0.05em' }}>▼</span>}<span style={{fontWeight:stake.con>stake.pro?700:undefined,textDecorationLine:stake.con>stake.pro?'underline':undefined,textDecorationThickness:1,textUnderlineOffset:3}}>{stake.con}</span></span>}
        </span>}
        {toggle && <button
          type="button"
          data-settlement-toggle-truth={truth ? true : undefined}
          data-settlement-toggle-value={truth ? undefined : true}
          data-guide-settlement-entry="true" data-guide-target-message={messageId}
          onClick={event => { event.stopPropagation(); window.dispatchEvent(new Event('guide-settlement-opened')); toggle(messageId); }}
          onDoubleClick={event => event.stopPropagation()}
          title={truth ? '真假仲裁' : '价值仲裁'}
          aria-expanded={open}
          style={{ fontSize: 13, cursor: 'pointer', background: open ? (truth ? 'var(--surface-rgba-99-102-241-0-2)' : 'var(--surface-rgba-245-158-11-0-2)') : 'none', border: `1px solid ${open ? (truth ? 'var(--line-6366f1)' : 'var(--line-f59e0b)') : 'transparent'}`, borderRadius: 4, padding: '0 3px', color: open ? color : 'var(--ink-6b7280-2)', lineHeight: 1 }}
        ><ThemeIcon name={truth ? 'truth' : 'value'} fallback={truth ? '⚖️' : '💎'} /></button>}
      </span>;
    })}
  </div>;
}
