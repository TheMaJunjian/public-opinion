export interface MessageStakeCounts {
  truth: { pro: number; con: number };
  value: { pro: number; con: number };
}

export default function MessageSettlementActions({ messageId, counts, openMessageId, openType, onTruth, onValue, fontSize = 10 }: {
  messageId: string;
  counts?: MessageStakeCounts;
  openMessageId?: string | null;
  openType?: 'TRUTH' | 'VALUE' | null;
  onTruth?: (messageId: string) => void;
  onValue?: (messageId: string) => void;
  fontSize?: number;
}) {
  return <div data-message-settlement-actions={messageId} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize, flexShrink: 0, whiteSpace: 'nowrap' }}>
    {(['TRUTH', 'VALUE'] as const).map(type => {
      const truth = type === 'TRUTH';
      const stake = truth ? counts?.truth : counts?.value;
      const toggle = truth ? onTruth : onValue;
      const open = openMessageId === messageId && openType === type;
      const color = truth ? '#a5b4fc' : '#fcd34d';
      return <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        {!!stake && (stake.pro > 0 || stake.con > 0) && <span data-settlement-statistics={type} title={truth ? '真假统计' : '价值统计'} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {stake.pro > 0 && <span aria-label={`${truth ? '真' : '有价值'} ${stake.pro} 点`} style={{ color: '#4ade80' }}>{truth ? '✓' : <span aria-hidden="true" style={{ marginRight: 2, fontSize: '1em', lineHeight: 1, verticalAlign: '-0.05em' }}>▲</span>}<span style={{fontWeight:stake.pro>stake.con?700:undefined,textDecorationLine:stake.pro>stake.con?'underline':undefined,textDecorationThickness:1,textUnderlineOffset:3}}>{stake.pro}</span></span>}
          {stake.con > 0 && <span aria-label={`${truth ? '假' : '低价值'} ${stake.con} 点`} style={{ color: '#f87171' }}>{truth ? '✕' : <span aria-hidden="true" style={{ marginRight: 2, fontSize: '1em', lineHeight: 1, verticalAlign: '-0.05em' }}>▼</span>}<span style={{fontWeight:stake.con>stake.pro?700:undefined,textDecorationLine:stake.con>stake.pro?'underline':undefined,textDecorationThickness:1,textUnderlineOffset:3}}>{stake.con}</span></span>}
        </span>}
        {toggle && <button
          type="button"
          data-settlement-toggle-truth={truth ? true : undefined}
          data-settlement-toggle-value={truth ? undefined : true}
          data-guide-settlement-entry="true" data-guide-target-message={messageId}
          onClick={event => { event.stopPropagation(); window.dispatchEvent(new Event('guide-settlement-opened')); toggle(messageId); }}
          onDoubleClick={event => event.stopPropagation()}
          title={truth ? '真假仲裁' : '价值仲裁'}
          style={{ fontSize: 13, cursor: 'pointer', background: open ? (truth ? 'rgba(99,102,241,0.2)' : 'rgba(245,158,11,0.2)') : 'none', border: `1px solid ${open ? (truth ? '#6366f1' : '#f59e0b') : 'transparent'}`, borderRadius: 4, padding: '0 3px', color: open ? color : '#6b7280', lineHeight: 1 }}
        >{truth ? '⚖️' : '💎'}</button>}
      </span>;
    })}
  </div>;
}
