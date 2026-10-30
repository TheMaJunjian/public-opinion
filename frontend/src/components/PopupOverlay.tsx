import { createPortal } from 'react-dom';
import { Z_INDEX } from '../constants/zIndex';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode, RefObject } from 'react';
import { getMessageJumpRegions } from '../utils/messageJumpDisplay';
import {useWorkbenchPortalTarget} from '../context/WorkbenchPortalContext';

const EDGE_ARROW_COUNT = 25;
const GUIDE_EDGE_INSET = 12;

export function MessageJumpOverlay({
  messageId,
  targetElement,
  targetRect,
}: {
  messageId?: string;
  targetElement: HTMLElement;
  targetRect: DOMRect;
}) {
  const portalTarget=useWorkbenchPortalTarget();
  const maskId = `jump-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const overlayRef = useRef<SVGSVGElement>(null);
  const [geometry, setGeometry] = useState(() => ({
    width: window.innerWidth, height: window.innerHeight,
    left: 0, top: 0, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    centerX: targetRect.left + targetRect.width / 2, centerY: targetRect.top + targetRect.height / 2,
    regions: [] as ReturnType<typeof getMessageJumpRegions>,
  }));
  const geometryRef = useRef(geometry);

  useLayoutEffect(() => {
    const layer = overlayRef.current;
    if (!layer) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const overlay = overlayRef.current;
      if (!overlay) return;
      const width = window.innerWidth, height = window.innerHeight;
      const bounds = overlay.getBoundingClientRect();
      // Mobile browsers can pan a visual viewport inside a wider layout viewport.
      // Measure the painted layer itself, so openings and guides share its origin
      // and scale even when that viewport is stationary.
      const scaleX = bounds.width > 0 ? bounds.width / geometryRef.current.width : 1;
      const scaleY = bounds.height > 0 ? bounds.height / geometryRef.current.height : 1;
      const localRect = (rect: DOMRect) => new DOMRect((rect.left - bounds.left) / scaleX,
        (rect.top - bounds.top) / scaleY, rect.width / scaleX, rect.height / scaleY);
      const card = localRect(targetElement.getBoundingClientRect());
      const viewport = window.visualViewport;
      const next = {
        width, height,
        left: ((viewport?.offsetLeft ?? 0) - bounds.left) / scaleX,
        top: ((viewport?.offsetTop ?? 0) - bounds.top) / scaleY,
        viewportWidth: (viewport?.width ?? width) / scaleX,
        viewportHeight: (viewport?.height ?? height) / scaleY,
        // Aim at the selected card/hit area, not the union with distant relations.
        centerX: card.left + card.width / 2, centerY: card.top + card.height / 2,
        regions: targetElement.isConnected
          ? getMessageJumpRegions(targetElement, messageId ?? targetElement.dataset.msgid ?? '')
            .map(region => ({ ...region, rect: localRect(region.rect) })) : [],
      };
      const previous = geometryRef.current;
      if (next.width === previous.width && next.height === previous.height
        && next.left === previous.left && next.top === previous.top
        && next.viewportWidth === previous.viewportWidth && next.viewportHeight === previous.viewportHeight
        && next.centerX === previous.centerX && next.centerY === previous.centerY
        && next.regions.length === previous.regions.length
        && next.regions.every(({ ids, rect }, index) => {
          const before = previous.regions[index];
          return ids === before.ids && rect.left === before.rect.left && rect.top === before.rect.top
            && rect.width === before.rect.width && rect.height === before.rect.height;
        })) return;
      geometryRef.current = next;
      setGeometry(next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(targetElement);
    observer?.observe(layer);
    const canvas = targetElement.closest('[data-jump-canvas]');
    if (canvas) observer?.observe(canvas);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const viewport = window.visualViewport;
    viewport?.addEventListener('scroll', schedule);
    viewport?.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      viewport?.removeEventListener('resize', schedule);
    };
  }, [messageId, targetElement, targetRect]);

  if (!targetElement.isConnected) return null;

  return createPortal((
    <svg
      ref={overlayRef}
      aria-hidden="true"
      data-message-jump-overlay="true"
      data-message-jump-target={messageId ?? targetElement.getAttribute('data-msgid') ?? undefined}
      width={geometry.width} height={geometry.height}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      style={{
        position: 'fixed', left: 0, top: 0,
        width: geometry.width, height: geometry.height,
        zIndex: Z_INDEX.popup, overflow: 'hidden', pointerEvents: 'none',
      }}
    >
      <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={geometry.width} height={geometry.height} style={{ maskType: 'luminance' }}>
        <rect width={geometry.width} height={geometry.height} fill="white" />
        {geometry.regions.map(({ rect, ids }, index) => <rect key={index} data-message-jump-region={ids}
          x={rect.left} y={rect.top} width={rect.width} height={rect.height} fill="black" />)}
      </mask></defs>
      {/* Keep the backdrop, guides, hint and openings in the same painted
          viewport instead of mixing CSS viewport units with an SVG mask. */}
      <g data-message-jump-layer="true" mask={`url(#${maskId})`}>
        <rect data-message-jump-backdrop="true" width={geometry.width} height={geometry.height} fill="var(--ink-rgba-0-0-0-0-42)" />
        <path className="popup-guides" fill="none" stroke="var(--ink-rgba-250-204-21-0-5)" strokeWidth="2" strokeDasharray="11 9" strokeLinecap="round"
          d={Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return [
              [geometry.left + ratio * geometry.viewportWidth, geometry.top + GUIDE_EDGE_INSET],
              [geometry.left + ratio * geometry.viewportWidth, geometry.top + geometry.viewportHeight - GUIDE_EDGE_INSET],
              [geometry.left + GUIDE_EDGE_INSET, geometry.top + ratio * geometry.viewportHeight],
              [geometry.left + geometry.viewportWidth - GUIDE_EDGE_INSET, geometry.top + ratio * geometry.viewportHeight],
            ].map(([x, y]) => `M${x},${y}L${geometry.centerX},${geometry.centerY}`).join(' ');
          }).join(' ')} />
        <g data-message-jump-hint="true" transform={`translate(${geometry.left + geometry.viewportWidth / 2},${geometry.top + 16})`}>
          <rect x="-58" width="116" height="30" rx="4" fill="var(--ink-rgba-23-23-23-0-92)" stroke="var(--ink-rgba-250-204-21-0-7)" />
          <text y="15" textAnchor="middle" dominantBaseline="central" fill="var(--ink-fde68a)" fontSize="13" fontWeight="600">已定位目标消息</text>
        </g>
      </g>
    </svg>
  ), portalTarget);
}

interface PopupOverlayProps {
  children: ReactNode;
  contentRef: RefObject<HTMLElement | null>;
  zIndex: number;
  background: string;
  style?: CSSProperties;
  dataPromptModal?: boolean;
  onClick: (event: MouseEvent<HTMLDivElement>) => void;
}

export default function PopupOverlay({
  children,
  contentRef,
  zIndex,
  background,
  style,
  dataPromptModal = false,
  onClick,
}: PopupOverlayProps) {
  const portalTarget=useWorkbenchPortalTarget();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState(() => ({
    left: window.visualViewport?.offsetLeft ?? 0,
    top: window.visualViewport?.offsetTop ?? 0,
    viewportWidth: window.visualViewport?.width ?? window.innerWidth,
    viewportHeight: window.visualViewport?.height ?? window.innerHeight,
    overlayWidth: window.innerWidth,
    overlayHeight: window.innerHeight,
    centerX: (window.visualViewport?.offsetLeft ?? 0) + (window.visualViewport?.width ?? window.innerWidth) / 2,
    centerY: (window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? window.innerHeight) / 2,
  }));
  const geometryRef = useRef(geometry);

  useLayoutEffect(() => {
    const updateGeometry = () => {
      const overlay = overlayRef.current;
      const content = contentRef.current;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const overlayBounds = overlay?.getBoundingClientRect();
      const contentBounds = content?.getBoundingClientRect();
      const next = {
        left,
        top,
        viewportWidth: width,
        viewportHeight: height,
        // The fixed mask belongs to the viewport. Including page/overlay scroll extents
        // feeds its own overflow back into layout and makes long graphs expensive to paint.
        overlayWidth: window.innerWidth,
        overlayHeight: window.innerHeight,
        centerX: contentBounds && overlayBounds ? Math.max(left, Math.min(left + width, (contentBounds.left + contentBounds.right) / 2 - overlayBounds.left)) : left + width / 2,
        centerY: contentBounds && overlayBounds ? Math.max(top, Math.min(top + height, (contentBounds.top + contentBounds.bottom) / 2 - overlayBounds.top)) : top + height / 2,
      };
      if (Object.keys(next).every(key => geometryRef.current[key as keyof typeof next] === next[key as keyof typeof next])) return;
      geometryRef.current = next;
      setGeometry(next);
    };

    updateGeometry();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateGeometry);
    if (observer && contentRef.current) observer.observe(contentRef.current);
    window.addEventListener('resize', updateGeometry);
    window.visualViewport?.addEventListener('resize', updateGeometry);
    window.visualViewport?.addEventListener('scroll', updateGeometry);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateGeometry);
      window.visualViewport?.removeEventListener('resize', updateGeometry);
      window.visualViewport?.removeEventListener('scroll', updateGeometry);
    };
  }, [children, contentRef]);

  const { overlayWidth, overlayHeight } = geometry;
  const center = { x: geometry.centerX, y: geometry.centerY };

  return createPortal((
    <div
      data-popup-overlay="true"
      data-prompt-modal={dataPromptModal ? 'true' : undefined}
      ref={overlayRef}
      style={{
        position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
        width: overlayWidth, height: overlayHeight,
        boxSizing: 'border-box', zIndex, overflow: 'hidden',
        background,
      }}
      onClick={onClick}
    >
      <svg className="popup-backdrop-guides" aria-hidden="true" width={overlayWidth} height={overlayHeight}
        viewBox={`0 0 ${overlayWidth} ${overlayHeight}`} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        {/* One animated path keeps the inward flow without a separate animation for every ray. */}
        <path className="popup-backdrop-flow" fill="none" stroke="var(--ink-rgba-250-204-21-0-55)" strokeWidth={1.5}
          strokeDasharray="11 9" strokeLinecap="round"
          d={Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return [
              [ratio * overlayWidth, GUIDE_EDGE_INSET], [ratio * overlayWidth, overlayHeight - GUIDE_EDGE_INSET],
              [GUIDE_EDGE_INSET, ratio * overlayHeight], [overlayWidth - GUIDE_EDGE_INSET, ratio * overlayHeight],
            ].map(([x, y]) => `M${x},${y}L${center.x},${center.y}`).join(' ');
          }).join(' ')} />
      </svg>
      <div
        data-popup-content-layer="true"
        style={{
          position: 'absolute',
          left: geometry.left,
          top: geometry.top,
          width: geometry.viewportWidth,
          height: geometry.viewportHeight,
          ...style,
        }}
        onClick={onClick}
      >
        {children}
      </div>
      <style>{`
        [data-popup-content-layer="true"] {
          position: relative;
          z-index: 2;
        }
      `}</style>
    </div>
  ), portalTarget);
}
