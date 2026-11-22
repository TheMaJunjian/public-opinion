import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import type { CrossCanvasRelationGroups } from '../utils/crossCanvasRelations';
import type { DemoMessage, UnitSelection } from '../utils/modelBridge';
import { isWholeMessageSelection } from '../utils/messageElementSelection';
import MessageElement from './MessageElement';
import { MessageDisplayMarker } from './MessageDisplayHints';
import {dialogStyles} from './dialogStyles';
import {useWorkbenchPortalTarget} from '../context/WorkbenchPortalContext';
import { LOCATE_RELATED_MESSAGE, type RelatedMessageLocation } from '../utils/relatedMessageNavigation';
import { nearestScrollDelta } from '../utils/scrollVisibility';

const stopControlPropagation = (event: SyntheticEvent) => {
  if (event.target instanceof Element && event.target.closest('button,[data-message-reference]')) event.stopPropagation();
};

const pageSize = 5;
const initialSection = { open: true, limit: pageSize };

export default function CrossCanvasRelatedMessages({ groups, messages, selectedUnits, highlightedMessageIds, onView, hiddenRelationIds, summarizedRelationIds, onToggleRelationVisibility, summaryLabel, triggerStyle, triggerClassName, onExpandedChange }: {
  groups?: CrossCanvasRelationGroups;
  messages: ReadonlyMap<string, DemoMessage>;
  selectedUnits?: readonly UnitSelection[];
  highlightedMessageIds?: ReadonlySet<string>;
  onView?: (messageId: string) => void;
  hiddenRelationIds?: ReadonlySet<string>;
  summarizedRelationIds?: ReadonlySet<string>;
  onToggleRelationVisibility?: (messageId: string) => void;
  /** An SVG summary supplies the visible trigger text and the title for its records. */
  summaryLabel?: string;
  triggerStyle?: CSSProperties;
  triggerClassName?: string;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const portalTarget=useWorkbenchPortalTarget();
  const [expanded, setExpanded] = useState(false);
  const expandedChangeRef = useRef(onExpandedChange);
  expandedChangeRef.current = onExpandedChange;
  const [sectionStates, setSectionStates] = useState<Record<string, typeof initialSection>>({});
  const triggerRef = useRef<HTMLButtonElement>(null), popupRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [location, setLocation] = useState<RelatedMessageLocation | null>(null);
  const completedLocation = useRef<RelatedMessageLocation | null>(null);
  const pendingLocation = useRef<RelatedMessageLocation | null>(null);
  const popupId = useId();
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const directions = useMemo(() => (['outgoing', 'incoming'] as const).map(direction => {
    const seen = new Set<string>();
    const sections = Object.entries(groups?.[direction] ?? {}).map(([type, records]) => {
      const ids = records.filter(id => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      return { type, key: `${direction}:${type}`, ids };
    }).filter(section => section.ids.length);
    return { direction, sections };
  }), [groups]);
  const recordIds = new Set(directions.flatMap(group => group.sections.flatMap(section => section.ids)));
  const count = recordIds.size;
  const title = summaryLabel ?? `其他相关消息：${count}`;
  const popupOpen = expanded && count > 0;
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const locate = (event: Event) => {
      const detail = (event as CustomEvent<RelatedMessageLocation>).detail;
      const section = directions.flatMap(group => group.sections).find(group => group.ids.includes(detail.messageId));
      if (!section) return;
      detail.handled = true;
      pendingLocation.current?.onLocated(null);
      pendingLocation.current = detail;
      const needed = Math.ceil((section.ids.indexOf(detail.messageId) + 1) / pageSize) * pageSize;
      setSectionStates(previous => ({ ...previous, [section.key]: {
        open: true, limit: Math.max(previous[section.key]?.limit ?? pageSize, needed),
      } }));
      setLocation(detail); setExpanded(true);
    };
    trigger.addEventListener(LOCATE_RELATED_MESSAGE, locate);
    return () => trigger.removeEventListener(LOCATE_RELATED_MESSAGE, locate);
  }, [directions]);
  useLayoutEffect(() => () => { pendingLocation.current?.onLocated(null); pendingLocation.current = null; }, []);
  useLayoutEffect(() => {
    expandedChangeRef.current?.(popupOpen);
    return () => { if (popupOpen) expandedChangeRef.current?.(false); };
  }, [popupOpen]);
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
      const target = event.target as Node;
      const ownHint = [...popupRef.current?.querySelectorAll('[data-display-hint][aria-describedby]') ?? []]
        .some(marker => marker.getAttribute('aria-describedby')?.split(/\s+/).some(id => document.getElementById(id)?.contains(target)));
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target) && !ownHint) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (popupRef.current?.querySelector('[data-display-hint][aria-expanded="true"]')) return;
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
  useLayoutEffect(() => {
    if (!location || completedLocation.current === location) return;
    if (!popupOpen) { completedLocation.current = location; pendingLocation.current = null; location.onLocated(null); return; }
    const frame = requestAnimationFrame(() => {
      const rows = rowsRef.current;
      const row = Array.from(rows?.querySelectorAll<HTMLElement>('[data-related-relation-id]') ?? [])
        .find(element => element.dataset.relatedRelationId === location.messageId);
      if (!rows || !row) { completedLocation.current = location; pendingLocation.current = null; location.onLocated(null); return; }
      const bounds = rows.getBoundingClientRect(), target = row.getBoundingClientRect();
      const delta = nearestScrollDelta(target.top, target.bottom, bounds.top, bounds.bottom);
      if (delta) rows.scrollTop += delta;
      completedLocation.current = location;
      pendingLocation.current = null;
      location.onLocated(row);
    });
    return () => cancelAnimationFrame(frame);
  }, [popupOpen, location, sectionStates, position]);
  if (!count) return null;
  const renderRow = (id: string, type: string) => {
    const message = messages.get(id);
    const reference = { messageId: id, revision: message?.revision };
    return <div key={id} data-related-relation-id={id} data-view-target={highlightedMessageIds?.has(id) || location?.messageId === id || undefined}
      style={{ border: '1px solid var(--line-373c70)', borderRadius: 4, padding: '2px 5px', overflowWrap: 'anywhere' }}>
      <MessageElement reference={reference} selected={selectedUnits?.some(unit => isWholeMessageSelection(unit, id))} label={`相关${type}消息`}>
        <span style={{ fontFamily: 'monospace' }}>{id}</span>
      </MessageElement>
      <MessageDisplayMarker messageId={id} compact />
      <span data-related-relation-actions style={{ display: 'inline-flex', alignItems: 'center', gap: 12, marginLeft: 6 }}>
        {(summarizedRelationIds?.has(id) || hiddenRelationIds?.has(id)) && (onToggleRelationVisibility
          ? <button type="button" data-summarized-relation={id} aria-label={`${hiddenRelationIds?.has(id) ? '显示' : '隐藏'}原始${type}关系 ${id}`}
              aria-pressed={!hiddenRelationIds?.has(id)} onClick={() => onToggleRelationVisibility(id)}
              style={{ color: 'var(--ink-94a3b8)', background: 'none', border: 0, cursor: 'pointer', fontSize: 10, padding: 0 }}>
              汇 · {hiddenRelationIds?.has(id) ? '隐藏' : '显示'}
            </button>
          : <span data-summarized-relation={id} style={{ color: 'var(--ink-94a3b8)', fontSize: 10 }}>汇 · {hiddenRelationIds?.has(id) ? '隐藏' : '显示'}</span>)}
        <button type="button" onClick={() => { setExpanded(false); onView?.(id); }} title={`查看${type}消息 ${id} 的关联上下文`}
          style={{ color: 'var(--ink-a5b4fc)', background: 'none', border: 0, cursor: 'pointer', fontSize: 10 }}>查看</button>
      </span>
    </div>;
  };
  return <div data-cross-canvas-related-messages style={{ marginTop: summaryLabel ? 0 : 5, fontSize: 11, color: 'var(--ink-a5b4fc)' }}
    onMouseDown={stopControlPropagation} onMouseUp={stopControlPropagation}
    onClick={stopControlPropagation} onDoubleClick={stopControlPropagation}>
    <button ref={triggerRef} type="button" className={triggerClassName} aria-label={summaryLabel}
      data-related-messages-trigger="true" data-jump-msgids={[...recordIds].join(' ')} data-rel-overlay="true" aria-expanded={expanded} aria-haspopup="dialog" aria-controls={expanded ? popupId : undefined} onClick={() => setExpanded(value => !value)}
      style={{ color: 'inherit', background: 'none', border: 0, cursor: 'pointer', padding: 0, fontSize: 'inherit', ...triggerStyle }}>
      {!summaryLabel && <>{expanded ? '▾' : '▸'} {title}</>}
    </button>
    {expanded && createPortal(<div ref={popupRef} id={popupId} role="dialog" tabIndex={-1} aria-label={title} data-related-messages-popup
      onMouseDown={event => event.stopPropagation()} onMouseUp={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => { if (!(event.target instanceof Element && event.target.closest('[data-display-hint-mode]'))) event.stopPropagation(); }}
      style={{ ...dialogStyles.panel, position: 'fixed', ...position, zIndex: 10050, width: 360, maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box',
        maxHeight: 'min(420px, calc(100dvh - 16px))', display: 'flex', flexDirection: 'column', padding: '8px 10px', gap: 6,
        fontSize: 11, lineHeight: 1.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span>{title}</span>
        <button type="button" className="workbench-popover-close" aria-label={summaryLabel ? '关闭汇总明细' : '关闭其他相关消息'} onClick={() => { setExpanded(false); triggerRef.current?.focus({ preventScroll: true }); }}
          style={{ color: 'var(--ink-bae6fd)', background: 'var(--surface-243448)', border: '1px solid var(--line-475569)', borderRadius: 3, cursor: 'pointer', fontSize: 10 }}>关闭</button>
      </div>
      <div style={{ color: 'var(--ink-94a3b8)', fontSize: 10 }}>点击消息选择整条，点击“查看”跳转。</div>
      <div ref={rowsRef} style={{ overflowY: 'auto', minHeight: 0, overscrollBehavior: 'contain', display: 'grid', gap: 6 }}>
      {directions.filter(group => group.sections.length).map(({ direction, sections }) => <div key={direction}
        role="group" aria-label={direction === 'outgoing' ? '发出的关联' : '指向本消息的关联'}
        style={{ display: 'grid', gap: 4, marginTop: 4 }}>
        {!summaryLabel && <div style={{ color: 'var(--ink-94a3b8)' }}>{direction === 'outgoing' ? '发出的关联' : '指向本消息的关联'}</div>}
        {sections.map(({ type, key, ids }, index) => {
          const state = sectionStates[key] ?? initialSection;
          const sectionId = `${popupId}-${direction}-${index}`;
          return <div key={key}>
            {!summaryLabel && <button type="button" aria-expanded={state.open} aria-controls={state.open ? sectionId : undefined}
              onClick={() => setSectionStates(previous => ({ ...previous, [key]: { ...state, open: !state.open } }))}
              style={{ width: '100%', padding: '3px 0', textAlign: 'left', font: 'inherit', fontWeight: 600, color: 'inherit', background: 'none', border: 0, cursor: 'pointer' }}>
              <span aria-hidden="true">{state.open ? '▾' : '▸'} </span>{type}（{ids.length}）
            </button>}
            {state.open && <div id={sectionId} style={{ display: 'grid', gap: 4 }}>
              {ids.slice(0, state.limit).map(id => renderRow(id, type))}
              {ids.length > state.limit && <button type="button"
                onClick={() => setSectionStates(previous => ({ ...previous, [key]: { ...state, limit: state.limit + pageSize } }))}>显示更多相关消息</button>}
            </div>}
          </div>;
        })}
      </div>)}
      </div>
    </div>, portalTarget)}
  </div>;
}
