import { useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import type { LeaderboardWindowSize } from '../utils/leaderboardPreferences';
import PopupOverlay from './PopupOverlay';
import { DIALOG_BACKDROP, dialogStyles } from './dialogStyles';

const MANUAL_LAYOUT = {
  '--leaderboard-body-flex': '1',
  '--leaderboard-body-overflow': 'auto',
  '--leaderboard-table-overflow': 'auto',
  '--leaderboard-table-flex': '1 0 120px',
  '--leaderboard-table-min-height': '120px',
  '--leaderboard-table-sticky-top': '0px',
};

const RESIZE_PREVIEW_PROPERTIES = ['width', 'height', 'min-height', ...Object.keys(MANUAL_LAYOUT)];
interface ResizeDrag {
  pointerId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  latest: LeaderboardWindowSize;
  moved: boolean;
  margin: string;
  frozenMargin: string;
  sizing: string | undefined;
  styles: [string, string][];
}

interface Props {
  size: LeaderboardWindowSize | null;
  contentWidth: number;
  onSizeChange: (size: LeaderboardWindowSize | null) => void;
  onClose: () => void;
  scrollResetKey: string;
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}

export default function LeaderboardWindow({ size, contentWidth, onSizeChange, onClose, scrollResetKey, header, footer, children }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ResizeDrag | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.visualViewport?.width ?? window.innerWidth);
  const measuredViewportWidth = useRef(viewportWidth);

  useLayoutEffect(() => {
    const measure = () => {
      const viewport = viewportRef.current;
      const headerElement = headerRef.current;
      const width = viewport?.clientWidth;
      if (width && width !== measuredViewportWidth.current) {
        measuredViewportWidth.current = width;
        setViewportWidth(width);
      }
      const dialog = dialogRef.current;
      if (headerElement && dialog) {
        const height = `${headerElement.offsetHeight}px`;
        if (dialog.style.getPropertyValue('--leaderboard-header-height') !== height) dialog.style.setProperty('--leaderboard-header-height', height);
      }
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (viewportRef.current) observer?.observe(viewportRef.current);
    if (headerRef.current) observer?.observe(headerRef.current);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, []);

  useLayoutEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [scrollResetKey]);

  const finishResize = (pointerId?: number, commit = false) => {
    const drag = dragRef.current;
    if (!drag || (pointerId !== undefined && pointerId !== drag.pointerId)) return;
    dragRef.current = null;
    const dialog = dialogRef.current;
    if (!dialog || !drag.moved) return;
    dialog.style.margin = drag.margin;
    if (commit && (drag.latest.width !== drag.width || drag.latest.height !== drag.height)) {
      onSizeChange(drag.latest);
    } else {
      for (const [property, value] of drag.styles) {
        if (value) dialog.style.setProperty(property, value);
        else dialog.style.removeProperty(property);
      }
      if (drag.sizing) dialog.dataset.leaderboardSizing = drag.sizing;
      else delete dialog.dataset.leaderboardSizing;
    }
  };

  const startResize = (event: PointerEvent<HTMLSpanElement>) => {
    const dialog = dialogRef.current;
    const stage = stageRef.current;
    if (event.button !== 0 || event.isPrimary === false || dragRef.current || !dialog || !stage) return;
    event.preventDefault();
    const bounds = dialog.getBoundingClientRect();
    const stageBounds = stage.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height,
      latest: { width: bounds.width, height: bounds.height }, moved: false,
      margin: dialog.style.margin,
      frozenMargin: `${Math.max(0, bounds.top - stageBounds.top - 16)}px 0 0 ${Math.max(0, bounds.left - stageBounds.left - 16)}px`,
      sizing: dialog.dataset.leaderboardSizing,
      styles: RESIZE_PREVIEW_PROPERTIES.map(property => [property, dialog.style.getPropertyValue(property)]),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  return (
    <PopupOverlay contentRef={dialogRef} zIndex={1500} background={DIALOG_BACKDROP}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={viewportRef} role="region" aria-label="排行榜窗口区域" tabIndex={0} data-gesture-disabled="true"
        style={{ width: '100%', height: '100%', overflow: 'auto', overscrollBehavior: 'contain' }}
        onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
        <div ref={stageRef}
          style={{ position: 'relative', display: 'flex', width: 'max-content', height: 'max-content', minWidth: '100%', minHeight: '100%', padding: 16, boxSizing: 'border-box' }}
          onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
          <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="排行榜" data-leaderboard-sizing={size ? 'manual' : 'auto'}
            style={{
              ...dialogStyles.panel,
              ...(size ? MANUAL_LAYOUT : {}),
              position: 'relative', width: size?.width ?? Math.max(480, contentWidth), height: size?.height ?? 'auto',
              minWidth: 480, minHeight: size ? 240 : undefined, boxSizing: 'border-box', flexShrink: 0,
              margin: 'auto',
              display: 'flex', flexDirection: 'column',
            }}>
            <div ref={headerRef} style={{ position: 'sticky', top: 0, left: 0, zIndex: 5, flexShrink: 0, width: '100%', maxWidth: Math.max(280, viewportWidth - 32), background: dialogStyles.panel.background, borderRadius: '12px 12px 0 0' }}>
              {header}
            </div>
            {children}
            <div style={{ position: 'sticky', bottom: 0, left: 0, zIndex: 5, flexShrink: 0, width: '100%', maxWidth: Math.max(280, viewportWidth - 32), background: dialogStyles.panel.background, borderRadius: '0 0 12px 12px' }}>
              {footer}
            </div>
            <span role="separator" aria-label="调整排行榜宽高" aria-orientation="horizontal" tabIndex={0}
              title="拖动调整宽高，松开后居中；方向键也可调整，双击恢复自适应"
              style={{ position: 'absolute', right: 0, bottom: 0, width: 20, height: 20, zIndex: 6, cursor: 'nwse-resize', touchAction: 'none', userSelect: 'none', background: 'repeating-linear-gradient(135deg, transparent 0 3px, #64748b 3px 4px)', clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' }}
              onPointerDown={startResize}
              onPointerMove={event => {
                const drag = dragRef.current;
                const dialog = dialogRef.current;
                if (!drag || drag.pointerId !== event.pointerId || !dialog) return;
                if (!drag.moved && Math.max(Math.abs(event.clientX - drag.x), Math.abs(event.clientY - drag.y)) < 3) return;
                const next = { width: Math.max(480, Math.min(20000, drag.width + event.clientX - drag.x)), height: Math.max(240, Math.min(20000, drag.height + event.clientY - drag.y)) };
                if (next.width === drag.latest.width && next.height === drag.latest.height) return;
                // Preview locally; rebuilding the table and saving settings waits for pointer release.
                if (!drag.moved) {
                  // A click must leave the centered layout untouched. Freeze only for a real drag.
                  dialog.style.margin = drag.frozenMargin;
                  for (const [property, value] of Object.entries(MANUAL_LAYOUT)) dialog.style.setProperty(property, value);
                  dialog.style.minHeight = '240px';
                  dialog.dataset.leaderboardSizing = 'manual';
                }
                drag.moved = true;
                drag.latest = next;
                dialog.style.width = `${next.width}px`;
                dialog.style.height = `${next.height}px`;
              }}
              onPointerUp={event => {
                finishResize(event.pointerId, true);
                if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={event => finishResize(event.pointerId)}
              onLostPointerCapture={event => finishResize(event.pointerId)}
              onDoubleClick={() => onSizeChange(null)}
              onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
                event.preventDefault();
                if (event.key === 'Home') { onSizeChange(null); return; }
                const bounds = dialogRef.current?.getBoundingClientRect();
                const width = size?.width ?? bounds?.width ?? contentWidth;
                const height = size?.height ?? bounds?.height ?? 240;
                onSizeChange({
                  width: Math.max(480, Math.min(20000, width + (event.key === 'ArrowLeft' ? -32 : event.key === 'ArrowRight' ? 32 : 0))),
                  height: Math.max(240, Math.min(20000, height + (event.key === 'ArrowUp' ? -32 : event.key === 'ArrowDown' ? 32 : 0))),
                });
              }} />
          </div>
        </div>
      </div>
    </PopupOverlay>
  );
}
