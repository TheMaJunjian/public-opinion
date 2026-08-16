import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode, RefObject } from 'react';

type GuidePosition = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const EDGE_ARROW_COUNT = 25;
const GUIDE_EDGE_INSET = 12;
const POPUP_GUIDE_GAP = 32;
const GUIDE_ARROW_PROGRESS = 0.68;

function PulseArrow({ start, end, index }: { start: { x: number; y: number }; end: { x: number; y: number }; index: number }) {
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
  return <>
    <div style={{
      position: 'absolute', left: start.x, top: start.y, width: length, height: 2,
      transform: `rotate(${angle}deg)`, transformOrigin: '0 50%', ...lineStyle,
    }} />
    <div style={{
      position: 'absolute',
      left: start.x + deltaX * GUIDE_ARROW_PROGRESS,
      top: start.y + deltaY * GUIDE_ARROW_PROGRESS,
      width: 0,
      height: 0,
      borderTop: '6px solid transparent',
      borderBottom: '6px solid transparent',
      borderLeft: '10px solid rgba(250,204,21,0.72)',
      transform: `translate(-10px, -6px) rotate(${angle}deg)`,
      transformOrigin: '0 50%',
      ...({ '--arrow-angle': `${angle}deg` } as CSSProperties),
      animation: 'popup-guide-arrow 1.8s ease-in-out infinite',
      animationDelay: `${(index % 5) * 0.12}s`,
      willChange: 'opacity, transform',
    }} />
  </>;
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

  const [guide, setGuide] = useState<GuidePosition | null>(null);

  useLayoutEffect(() => {
    const updateGuide = () => {
      const overlay = overlayRef.current;
      const content = contentRef.current;
      if (!overlay || !content) return;
      const overlayRect = overlay.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      setGuide({
        left: contentRect.left - overlayRect.left,
        top: contentRect.top - overlayRect.top,
        right: contentRect.right - overlayRect.left,
        bottom: contentRect.bottom - overlayRect.top,
      });
    };

    updateGuide();
    const resizeObserver = new ResizeObserver(updateGuide);
    if (overlayRef.current) resizeObserver.observe(overlayRef.current);
    if (contentRef.current) resizeObserver.observe(contentRef.current);
    return () => resizeObserver.disconnect();
  }, [contentRef]);

  const overlayWidth = overlayRef.current?.clientWidth ?? window.innerWidth;
  const overlayHeight = overlayRef.current?.clientHeight ?? window.innerHeight;

  return (
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
      {guide && <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseArrow key={`top-${index}`} index={index}
              start={{ x: ratio * overlayWidth, y: GUIDE_EDGE_INSET }}
              end={{ x: guide.left + ratio * (guide.right - guide.left), y: guide.top - POPUP_GUIDE_GAP }} />;
          })}
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseArrow key={`bottom-${index}`} index={index}
              start={{ x: ratio * overlayWidth, y: overlayHeight - GUIDE_EDGE_INSET }}
              end={{ x: guide.left + ratio * (guide.right - guide.left), y: guide.bottom + POPUP_GUIDE_GAP }} />;
          })}
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseArrow key={`left-${index}`} index={index}
              start={{ x: GUIDE_EDGE_INSET, y: ratio * overlayHeight }}
              end={{ x: guide.left - POPUP_GUIDE_GAP, y: guide.top + ratio * (guide.bottom - guide.top) }} />;
          })}
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseArrow key={`right-${index}`} index={index}
              start={{ x: overlayWidth - GUIDE_EDGE_INSET, y: ratio * overlayHeight }}
              end={{ x: guide.right + POPUP_GUIDE_GAP, y: guide.top + ratio * (guide.bottom - guide.top) }} />;
          })}
      </div>}
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
        @keyframes popup-guide-arrow {
          0%, 100% {
            opacity: 0.36;
            transform: translate(-10px, -6px) rotate(var(--arrow-angle));
          }
          50% {
            opacity: 0.78;
            transform: translate(2px, -6px) rotate(var(--arrow-angle));
          }
        }
      `}</style>
    </div>
  );
}
