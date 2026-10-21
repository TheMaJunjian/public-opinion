import { createPortal } from 'react-dom';
import { Z_INDEX } from '../constants/zIndex';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode, RefObject } from 'react';
import { getMessageJumpRegions } from '../utils/messageJumpDisplay';

const EDGE_ARROW_COUNT = 25;
const GUIDE_EDGE_INSET = 12;

export function PulseGuide({ start, end }: { start: { x: number; y: number }; end: { x: number; y: number } }) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const length = Math.max(12, Math.hypot(deltaX, deltaY));
  const angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI);
  const lineStyle: CSSProperties = {
    background: 'repeating-linear-gradient(90deg, rgba(250,204,21,0.5) 0 11px, transparent 11px 20px)',
    backgroundSize: '20px 100%',
    backgroundPosition: '0 0',
    borderRadius: 3,
  };
  return <div style={{
      position: 'absolute', left: start.x, top: start.y, width: length, height: 2,
      transform: `rotate(${angle}deg)`, transformOrigin: '0 50%', ...lineStyle,
    }} />;
}

export function MessageJumpOverlay({
  messageId,
  targetElement,
  targetRect,
}: {
  messageId?: string;
  targetElement: HTMLElement;
  targetRect: DOMRect;
}) {
  const maskId = `jump-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [regions, setRegions] = useState<ReturnType<typeof getMessageJumpRegions>>([]);
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const targetCenter = {
    x: targetRect.left + targetRect.width / 2,
    y: targetRect.top + targetRect.height / 2,
  };

  useLayoutEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setRegions(targetElement.isConnected
        ? getMessageJumpRegions(targetElement, messageId ?? targetElement.dataset.msgid ?? '') : []);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [messageId, targetElement, targetRect]);

  if (!targetElement.isConnected) return null;

  return createPortal((
    <>
    <svg width="0" height="0" aria-hidden="true" style={{ position: 'fixed', pointerEvents: 'none' }}>
      <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={viewportWidth} height={viewportHeight} style={{ maskType: 'luminance' }}>
        <rect width={viewportWidth} height={viewportHeight} fill="white" />
        {regions.map(({ rect, ids }, index) => <rect key={index} data-message-jump-region={ids}
          x={rect.left} y={rect.top} width={rect.width} height={rect.height} fill="black" />)}
      </mask></defs>
    </svg>
    <div
      aria-hidden="true"
      data-message-jump-overlay="true"
      data-message-jump-target={messageId ?? targetElement.getAttribute('data-msgid') ?? undefined}
      style={{
        position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
        width: '100dvw', height: '100dvh', minWidth: '100vw', minHeight: '100vh',
        boxSizing: 'border-box', zIndex: Z_INDEX.popup,
        background: 'rgba(0,0,0,0.42)',
        pointerEvents: 'none',
        // One cutout covers every part of the prompt, including guides and text.
        // The original live message remains visible, even with translucent frames.
        maskImage: `url(#${maskId})`,
        WebkitMaskImage: `url(#${maskId})`,
      }}
    >
      <div className="popup-guides" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }}>
        {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
          const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
          return <PulseGuide key={`top-${index}`}
            start={{ x: ratio * viewportWidth, y: GUIDE_EDGE_INSET }} end={targetCenter} />;
        })}
        {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
          const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
          return <PulseGuide key={`bottom-${index}`}
            start={{ x: ratio * viewportWidth, y: viewportHeight - GUIDE_EDGE_INSET }} end={targetCenter} />;
        })}
        {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
          const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
          return <PulseGuide key={`left-${index}`}
            start={{ x: GUIDE_EDGE_INSET, y: ratio * viewportHeight }} end={targetCenter} />;
        })}
        {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
          const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
          return <PulseGuide key={`right-${index}`}
            start={{ x: viewportWidth - GUIDE_EDGE_INSET, y: ratio * viewportHeight }} end={targetCenter} />;
        })}
      </div>
      <div style={{
        position: 'fixed', left: '50%', top: 16, transform: 'translateX(-50%)',
        zIndex: 2,
        padding: '6px 12px', border: '1px solid rgba(250,204,21,0.7)', borderRadius: 4,
        background: 'rgba(23,23,23,0.92)', color: '#fde68a', fontSize: 13, fontWeight: 600,
        whiteSpace: 'nowrap', boxShadow: '0 2px 10px rgba(0,0,0,0.45)', pointerEvents: 'none',
      }}>已定位目标消息</div>
    </div>
    </>
  ), document.body);
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
        <path className="popup-backdrop-flow" fill="none" stroke="rgba(250,204,21,0.55)" strokeWidth={1.5}
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
  ), document.body);
}
