import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode, RefObject } from 'react';

const EDGE_ARROW_COUNT = 25;
const GUIDE_EDGE_INSET = 12;

interface Point {
  x: number;
  y: number;
}

function PulseGuide({ start, end, index }: { start: Point; end: Point; index: number }) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const length = Math.max(12, Math.hypot(deltaX, deltaY));
  const angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI);
  const lineStyle: CSSProperties = {
    background: 'repeating-linear-gradient(90deg, rgba(250,204,21,0.5) 0 11px, transparent 11px 20px)',
    backgroundSize: '20px 100%',
    backgroundPosition: '0 0',
    borderRadius: 3,
    animation: 'popup-guide-line 1.8s ease-in-out infinite',
    animationDelay: `${(index % 5) * 0.12}s`,
    willChange: 'opacity, background-position',
  };
  return <div style={{
      position: 'absolute', left: start.x, top: start.y, width: length, height: 2,
      transform: `rotate(${angle}deg)`, transformOrigin: '0 50%', ...lineStyle,
    }} />;
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
  const [overlaySize, setOverlaySize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [contentCenter, setContentCenter] = useState<Point | null>(null);

  useLayoutEffect(() => {
    const updateGeometry = () => {
      const overlay = overlayRef.current;
      const content = contentRef.current;
      if (!overlay) return;
      const overlayBounds = overlay.getBoundingClientRect();
      setOverlaySize({ width: overlay.clientWidth, height: overlay.clientHeight });
      if (content) {
        const contentBounds = content.getBoundingClientRect();
        setContentCenter({
          x: (contentBounds.left + contentBounds.right) / 2 - overlayBounds.left,
          y: (contentBounds.top + contentBounds.bottom) / 2 - overlayBounds.top,
        });
      }
    };

    updateGeometry();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateGeometry);
    if (observer && overlayRef.current) observer.observe(overlayRef.current);
    if (observer && contentRef.current) observer.observe(contentRef.current);
    window.addEventListener('resize', updateGeometry);
    window.visualViewport?.addEventListener('resize', updateGeometry);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateGeometry);
      window.visualViewport?.removeEventListener('resize', updateGeometry);
    };
  }, [children, contentRef]);

  const overlayWidth = overlaySize.width;
  const overlayHeight = overlaySize.height;
  const center = contentCenter ?? { x: overlayWidth / 2, y: overlayHeight / 2 };

  return createPortal((
    <div
      data-popup-overlay="true"
      data-prompt-modal={dataPromptModal ? 'true' : undefined}
      ref={overlayRef}
      style={{
        position: 'fixed', inset: 0, zIndex,
        background,
        ...style,
      }}
      onClick={onClick}
    >
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseGuide key={`top-${index}`} index={index}
              start={{ x: ratio * overlayWidth, y: GUIDE_EDGE_INSET }} end={center} />;
          })}
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseGuide key={`bottom-${index}`} index={index}
              start={{ x: ratio * overlayWidth, y: overlayHeight - GUIDE_EDGE_INSET }} end={center} />;
          })}
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseGuide key={`left-${index}`} index={index}
              start={{ x: GUIDE_EDGE_INSET, y: ratio * overlayHeight }} end={center} />;
          })}
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseGuide key={`right-${index}`} index={index}
              start={{ x: overlayWidth - GUIDE_EDGE_INSET, y: ratio * overlayHeight }} end={center} />;
          })}
      </div>
      {children}
      <style>{`
        [data-popup-overlay="true"] > :not([aria-hidden="true"]):not(style) {
          position: relative;
          z-index: 2;
        }
        @keyframes popup-guide-line {
          0%, 100% { opacity: 0.16; background-position: 0 0; }
          50% { opacity: 0.58; background-position: 20px 0; }
        }
      `}</style>
    </div>
  ), document.body);
}
