import { useId, useLayoutEffect, useRef, useState, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import type { CrossCanvasRelationGroups } from '../utils/crossCanvasRelations';
import type { DemoMessage, UnitSelection } from '../utils/modelBridge';
import { isMessageElementSelected, messageTypeReference } from '../utils/messageElementSelection';
import MessageElement from './MessageElement';
import {useWorkbenchPortalTarget} from '../context/WorkbenchPortalContext';

const stopControlPropagation = (event: SyntheticEvent) => {
  if (event.target instanceof Element && event.target.closest('button,[data-message-reference]')) event.stopPropagation();
};

export default function CrossCanvasRelatedMessages({ groups, messages, selectedUnits, onView }: {
  groups?: CrossCanvasRelationGroups;
  messages: ReadonlyMap<string, DemoMessage>;
  selectedUnits?: readonly UnitSelection[];
  onView?: (messageId: string) => void;
}) {
  const portalTarget=useWorkbenchPortalTarget();
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(5);
  const triggerRef = useRef<HTMLButtonElement>(null), popupRef = useRef<HTMLDivElement>(null);
  const popupId = useId();
  const [position, setPosition] = useState({ left: 8, top: 8 });
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
  useLayoutEffect(() => {
    if (!expanded || !count) { if (!count) setExpanded(false); return; }
    let frame = 0;
    const close = () => setExpanded(false);
    const place = () => {
      frame = 0;
      const trigger = triggerRef.current, popup = popupRef.current;
      if (!trigger || !popup || !trigger.isConnected) { close(); return; }
      const rect = trigger.getBoundingClientRect(), bounds = popup.getBoundingClientRect(), viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const right = left + (viewport?.width ?? window.innerWidth), bottom = top + (viewport?.height ?? window.innerHeight);
      const below = rect.bottom + 6, above = rect.top - bounds.height - 6;
      const next = {
        left: Math.max(left + 8, Math.min(rect.left, right - bounds.width - 8)),
        top: Math.max(top + 8, Math.min(below + bounds.height <= bottom - 8 ? below : above, bottom - bounds.height - 8)),
      };
      setPosition(previous => previous.left === next.left && previous.top === next.top ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    const outside = (event: PointerEvent) => {
      if (!triggerRef.current?.contains(event.target as Node) && !popupRef.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); close(); triggerRef.current?.focus({ preventScroll: true });
    };
    const scroll = (event: Event) => { if (!popupRef.current?.contains(event.target as Node)) schedule(); };
    place(); popupRef.current?.focus({ preventScroll: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (popupRef.current) observer?.observe(popupRef.current);
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true);
    document.addEventListener('scroll', scroll, true); document.addEventListener('wheel', scroll, true); window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule); window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame); observer?.disconnect();
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true);
      document.removeEventListener('scroll', scroll, true); document.removeEventListener('wheel', scroll, true); window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [expanded, count]);
  if (!count) return null;
  return <div data-cross-canvas-related-messages style={{ marginTop: 5, fontSize: 11, color: '#a5b4fc' }}
    onMouseDown={stopControlPropagation} onMouseUp={stopControlPropagation}
    onClick={stopControlPropagation} onDoubleClick={stopControlPropagation}>
    <button ref={triggerRef} type="button" data-jump-msgids={directions.flatMap(group => group.rows.map(row => row.id)).join(' ')} data-rel-overlay="true" aria-expanded={expanded} aria-haspopup="dialog" aria-controls={expanded ? popupId : undefined} onClick={() => setExpanded(value => !value)}
      style={{ color: 'inherit', background: 'none', border: 0, cursor: 'pointer', padding: 0, fontSize: 'inherit' }}>
      {expanded ? '▾' : '▸'} 其他相关消息：{count}
    </button>
    {expanded && createPortal(<div ref={popupRef} id={popupId} role="dialog" tabIndex={-1} aria-label={`其他相关消息：${count}`} data-related-messages-popup
      onMouseDown={event => event.stopPropagation()} onMouseUp={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
      style={{ position: 'fixed', ...position, zIndex: 10050, width: 360, maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box',
        maxHeight: 'min(420px, calc(100dvh - 16px))', display: 'flex', flexDirection: 'column', padding: '8px 10px', gap: 6,
        border: '1px solid #475569', borderRadius: 4, background: '#17202e', color: '#e2e8f0', fontSize: 11, lineHeight: 1.6,
        boxShadow: '0 3px 12px rgba(0,0,0,0.35)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span>其他相关消息：{count}</span>
        <button type="button" aria-label="关闭其他相关消息" onClick={() => { setExpanded(false); triggerRef.current?.focus({ preventScroll: true }); }}
          style={{ color: '#bae6fd', background: '#243448', border: '1px solid #475569', borderRadius: 3, cursor: 'pointer', fontSize: 10 }}>关闭</button>
      </div>
      <div style={{ color: '#94a3b8', fontSize: 10 }}>点击消息部件可选择，点击“查看”跳转。</div>
      <div style={{ overflowY: 'auto', minHeight: 0, overscrollBehavior: 'contain', display: 'grid', gap: 6 }}>
      {directions.filter(group => group.rows.length > 0).map(({ direction, rows }) => <div key={direction}
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
          <button type="button" onClick={() => { setExpanded(false); onView?.(id); }} title={`追溯${type}消息 ${id}（距离 1）`}
            style={{ color: '#a5b4fc', background: 'none', border: 0, cursor: 'pointer', fontSize: 10 }}>查看</button>
        </div>;
      })}
      {rows.length > limit && <button type="button" onClick={() => setLimit(value => value + 5)}>显示更多相关消息</button>}
    </div>)}
      </div>
    </div>, portalTarget)}
  </div>;
}
