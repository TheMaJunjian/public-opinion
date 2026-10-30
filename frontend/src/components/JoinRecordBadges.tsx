import type { Relation } from '../types';

export type JoinRecordDirection = 'incoming' | 'outgoing';

/** Member: 加入 (JOIN targets it). Container: 被加入 (JOIN names it as parent). */
export default function JoinRecordBadges({ messageId, memberRecords = [], containerRecords = [], isContainer = false,
  isEffective, onOpen, compact = false,
}: {
  messageId: string;
  memberRecords?: readonly Relation[];
  containerRecords?: readonly Relation[];
  isContainer?: boolean;
  isEffective: (record: Relation) => boolean;
  onOpen?: (messageId: string, direction: JoinRecordDirection) => void;
  compact?: boolean;
}) {
  if (!onOpen || (!memberRecords.length && !containerRecords.length && !isContainer)) return null;
  const badge = (label: string, records: readonly Relation[], direction: JoinRecordDirection) => {
    const active = records.filter(isEffective).length;
    const description = direction === 'incoming' ? '此消息加入容器的全部加入消息' : '成员加入此容器的全部加入消息';
    return <button type="button" aria-label={`查看${label}消息（${records.length}条）`}
      title={`查看${description}，包含历史记录；共 ${records.length} 条，${direction==='outgoing'?`${active} 条当前采用，${records.length-active} 条未采用`:`${active} 条生效`}`}
      onClick={event => { event.stopPropagation(); onOpen(messageId, direction); }}
      onMouseDown={event => event.stopPropagation()} onMouseUp={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
        background: direction === 'incoming' ? 'var(--surface-rgba-59-130-246-0-14)' : 'var(--surface-rgba-16-185-129-0-14)',
        color: direction === 'incoming' ? 'var(--ink-bfdbfe)' : 'var(--ink-a7f3d0)', border: '1px solid var(--line-475569)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
      {label}：{records.length}{!compact && <span style={{ fontWeight: 400 }}>（{active} {direction==='outgoing'?'当前采用':'生效'}）</span>}
    </button>;
  };
  return <span style={{ display: 'inline-flex', alignSelf: 'flex-start', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 }}>
    {memberRecords.length > 0 && badge('加入', memberRecords, 'incoming')}
    {(isContainer || containerRecords.length > 0) && badge('被加入', containerRecords, 'outgoing')}
  </span>;
}
