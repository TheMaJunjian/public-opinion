import { useState, type SyntheticEvent } from 'react';
import type { CrossCanvasRelationGroups } from '../utils/crossCanvasRelations';
import type { DemoMessage, UnitSelection } from '../utils/modelBridge';
import { isMessageElementSelected, messageTypeReference } from '../utils/messageElementSelection';
import MessageElement from './MessageElement';

const stopControlPropagation = (event: SyntheticEvent) => {
  if (event.target instanceof Element && event.target.closest('button,[data-message-reference]')) event.stopPropagation();
};

export default function CrossCanvasRelatedMessages({ groups, messages, selectedUnits, onView }: {
  groups?: CrossCanvasRelationGroups;
  messages: ReadonlyMap<string, DemoMessage>;
  selectedUnits?: readonly UnitSelection[];
  onView?: (messageId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(5);
  const directions = (['outgoing', 'incoming'] as const).map(direction => {
    const seen = new Set<string>();
    const rows = Object.entries(groups?.[direction] ?? {}).flatMap(([type, ids]) => ids.flatMap(id => {
      if (seen.has(id)) return [];
      seen.add(id);
      return [{ id, type }];
    }));
    return { direction, rows };
  });
  const count = new Set(directions.flatMap(group => group.rows.map(row => row.id))).size;
  if (!count) return null;
  return <div data-cross-canvas-related-messages style={{ marginTop: 5, fontSize: 11, color: '#a5b4fc' }}
    onMouseDown={stopControlPropagation} onMouseUp={stopControlPropagation}
    onClick={stopControlPropagation} onDoubleClick={stopControlPropagation}>
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
      style={{ color: 'inherit', background: 'none', border: 0, cursor: 'pointer', padding: 0, fontSize: 'inherit' }}>
      {expanded ? '▾' : '▸'} 相关消息：{count}
    </button>
    {expanded && directions.filter(group => group.rows.length > 0).map(({ direction, rows }) => <div key={direction}
      role="group" aria-label={direction === 'outgoing' ? '发出的关联' : '指向本消息的关联'}
      style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
      <div style={{ color: '#94a3b8' }}>{direction === 'outgoing' ? '发出的关联' : '指向本消息的关联'}</div>
      {rows.slice(0, limit).map(({ id, type }) => {
        const message = messages.get(id);
        const reference = message && messageTypeReference(message) || { messageId: id, revision: message?.revision };
        return <div key={id} data-related-relation-id={id} style={{ border: '1px solid #373c70', borderRadius: 4, padding: '2px 5px', overflowWrap: 'anywhere' }}>
          <MessageElement reference={reference} selected={isMessageElementSelected(selectedUnits, reference)} label={`相关${type}消息部件`}>
            <span style={{ color: '#94a3b8' }}>【{type}】 </span><span style={{ fontFamily: 'monospace' }}>{id}</span>
          </MessageElement>{' '}
          <button type="button" onClick={() => onView?.(id)} title={`追溯${type}消息 ${id}（距离 1）`}
            style={{ color: '#a5b4fc', background: 'none', border: 0, cursor: 'pointer', fontSize: 10 }}>查看</button>
        </div>;
      })}
      {rows.length > limit && <button type="button" onClick={() => setLimit(value => value + 5)}>显示更多相关消息</button>}
    </div>)}
  </div>;
}
