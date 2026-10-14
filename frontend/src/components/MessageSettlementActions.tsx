export interface MessageStakeCounts {
  truth: { pro: number; con: number };
  value: { pro: number; con: number };
}

export default function MessageSettlementActions({ messageId, counts, openMessageId, openType, onTruth, onValue }: {
  messageId: string;
  counts?: MessageStakeCounts;
  openMessageId?: string | null;
  openType?: 'TRUTH' | 'VALUE' | null;
  onTruth?: (messageId: string) => void;
  onValue?: (messageId: string) => void;
}) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
    {(['TRUTH', 'VALUE'] as const).map(type => {
      const truth = type === 'TRUTH';
      const stake = truth ? counts?.truth : counts?.value;
      const toggle = truth ? onTruth : onValue;
      const open = openMessageId === messageId && openType === type;
      const color = truth ? '#a5b4fc' : '#fcd34d';
      return <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        {!!stake && (stake.pro > 0 || stake.con > 0) && <span>
          <span style={{ color }}>{truth ? '⚖️' : '💎'}</span>
          {stake.pro > 0 && <span style={{ color: '#4ade80' }}>👍{stake.pro}</span>}
          {stake.con > 0 && <span style={{ color: '#f87171' }}>👎{stake.con}</span>}
        </span>}
        {toggle && <button
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
