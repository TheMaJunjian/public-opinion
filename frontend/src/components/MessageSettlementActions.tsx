import ThemeIcon from '../theme/ThemeIcon';
import {useContext} from 'react';
import type {ModerationSummary} from '@gonglun/core';
import {LocalReviewRecordsContext,ModerationContext,reviewStatusLabel,type ArbitrationType} from './ModerationContext';
import ReviewVerdictIcon from './ReviewVerdictIcon';

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
  const moderation=useContext(ModerationContext),local=useContext(LocalReviewRecordsContext),statistics=moderation??local;
  const ownReview=statistics?.summaries?.get(messageId),sources=statistics?.sourcesFor?.(messageId)??[];
  function reviewActions(review:ModerationSummary,source:boolean){
    const address={messageId:review.messageId,revision:review.revision};
    const sourceAddress=source?`来源 ${review.messageId} 第 ${review.revision} 版`:'';
    const suffix=source?`（${sourceAddress}）`:'';
    const reason=moderation?.subjectLabel?.(review.messageId)==='这条理由';
    const arbitration=reason?'审核这条理由':'审核仲裁';
    const canOpen=!!moderation||local?.available.has(JSON.stringify([address.messageId,address.revision]));
    const expanded=moderation?.activeId===messageId&&(moderation.activeTarget
      ?moderation.activeTarget.messageId===review.messageId&&moderation.activeTarget.revision===review.revision:!source);
    return <span key={review.caseId} data-settlement-statistics="REVIEW" style={{display:'inline-flex',alignItems:'center',gap:2}}>
      {source&&<span title={sourceAddress} style={{color:'var(--text-muted)'}}>{sources.length>1?`来源 ${review.messageId.slice(0,8)} · 第 ${review.revision} 版`:'来源'}</span>}
      {(['pass','reject'] as const).map(verdict=>{
        const label=`审核${verdict==='pass'?'通过':'不通过'} ${review[verdict]} 点`;
        const color=verdict==='pass'?'var(--ink-4ade80)':'var(--ink-f87171)';
        const count=<span style={{display:'inline-flex',alignItems:'center',gap:3,color}}>
          <ReviewVerdictIcon verdict={verdict}/>
          <span style={{fontWeight:review[verdict]>review[verdict==='pass'?'reject':'pass']?700:undefined}}>{review[verdict]}</span>
        </span>;
        return canOpen?<button key={verdict} type="button" title={'查看审核通过与审核不通过汇总'+suffix} aria-label={label+'，查看记录'+suffix}
          onClick={event=>{event.stopPropagation();statistics?.open(review.messageId,review.revision);}} onDoubleClick={event=>event.stopPropagation()}
          style={{display:'inline-flex',width:'auto',fontSize:'inherit',background:'none',border:0,padding:'0 2px',cursor:'pointer'}}>{count}</button>
          :<span key={verdict} aria-label={label+suffix} title={label+suffix}>{count}</span>;
      })}
      {moderation&&<button type="button" data-settlement-toggle-review="true" title={arbitration+suffix} aria-label={`审核仲裁：${reviewStatusLabel[review.status]}${reason?'（审核这条理由）':''}${suffix}`} aria-expanded={expanded}
        onClick={event=>{event.stopPropagation();moderation?.arbitrate(messageId,address);}} onDoubleClick={event=>event.stopPropagation()}
        style={{fontSize:13,cursor:'pointer',background:expanded?'var(--surface-rgba-99-102-241-0-2)':'none',border:`1px solid ${expanded?'var(--line-6366f1)':'transparent'}`,borderRadius:4,padding:'0 3px',color:expanded?'var(--ink-a5b4fc)':'var(--ink-6b7280-2)',lineHeight:1}}>
        <ThemeIcon name="review" fallback="🛡️"/>{reason&&arbitration}
      </button>}
    </span>;
  }
  return <div data-message-settlement-actions={messageId} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize, flexShrink: 0, whiteSpace: 'nowrap' }}>
    {(ownReview||sources.length>0)&&<span style={{display:'inline-flex',flexDirection:'column',alignItems:'flex-start',gap:2}}>
      {ownReview&&reviewActions(ownReview,false)}
      {sources.map(review=>reviewActions(review,true))}
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
