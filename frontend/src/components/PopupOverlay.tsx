import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode, RefObject } from 'react';

type GuidePosition = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const EDGE_ARROW_COUNT = 25;
const POPUP_GUIDE_GAP = 32;

function PulseArrow({ start, end, index }: { start: { x: number; y: number }; end: { x: number; y: number }; index: number }) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const length = Math.max(12, Math.hypot(deltaX, deltaY));
  const angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI);
  const arrowCount = Math.max(1, Math.ceil(length / 72));
  const lineStyle: CSSProperties = {
    background: 'repeating-linear-gradient(90deg, rgba(250,204,21,0.5) 0 11px, transparent 11px 20px)',
    backgroundSize: '20px 100%',
    backgroundPosition: '0 0',
    borderRadius: 3,
    boxShadow: '0 0 6px rgba(250,204,21,0.45)',
    animation: 'popup-guide-line 1.8s ease-in-out infinite',
    animationDelay: `${(index % 5) * 0.12}s`,
    willChange: 'opacity',
  };
  return <>
    <div style={{
      position: 'absolute', left: start.x, top: start.y, width: length, height: 2,
      transform: `rotate(${angle}deg)`, transformOrigin: '0 50%', ...lineStyle,
    }} />
    {Array.from({ length: arrowCount }, (_, arrowIndex) => {
      const progress = (arrowIndex + 1) / arrowCount;
      const arrowX = start.x + deltaX * progress;
      const arrowY = start.y + deltaY * progress;
      return (
        <div key={arrowIndex} style={{
          position: 'absolute', left: arrowX, top: arrowY, width: 0, height: 0,
          borderTop: '6px solid transparent', borderBottom: '6px solid transparent', borderLeft: '10px solid rgba(250,204,21,0.72)',
          transform: `translate(-10px, -6px) rotate(${angle}deg)`, transformOrigin: '0 50%',
          ...({ '--arrow-angle': `${angle}deg` } as CSSProperties),
          filter: 'drop-shadow(0 0 5px rgba(250,204,21,0.55))',
          animation: 'popup-guide-arrow 1.8s ease-in-out infinite',
          animationDelay: `${(index % 5) * 0.12}s`,
          willChange: 'opacity',
        }} />
      );
    })}
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
  const [guide, setGuide] = useState<GuidePosition | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

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
    window.addEventListener('resize', updateGuide);
    window.visualViewport?.addEventListener('resize', updateGuide);
    window.visualViewport?.addEventListener('scroll', updateGuide);
    return () => {
      window.removeEventListener('resize', updateGuide);
      window.visualViewport?.removeEventListener('resize', updateGuide);
      window.visualViewport?.removeEventListener('scroll', updateGuide);
    };
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
      {guide && (
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }}>
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseArrow key={`top-${index}`} index={index}
              start={{ x: ratio * overlayWidth, y: 12 }}
              end={{ x: guide.left + ratio * (guide.right - guide.left), y: guide.top - POPUP_GUIDE_GAP }} />;
          })}
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseArrow key={`bottom-${index}`} index={index}
              start={{ x: ratio * overlayWidth, y: overlayHeight - 12 }}
              end={{ x: guide.left + ratio * (guide.right - guide.left), y: guide.bottom + POPUP_GUIDE_GAP }} />;
          })}
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseArrow key={`left-${index}`} index={index}
              start={{ x: 12, y: ratio * overlayHeight }}
              end={{ x: guide.left - POPUP_GUIDE_GAP, y: guide.top + ratio * (guide.bottom - guide.top) }} />;
          })}
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseArrow key={`right-${index}`} index={index}
              start={{ x: overlayWidth - 12, y: ratio * overlayHeight }}
              end={{ x: guide.right + POPUP_GUIDE_GAP, y: guide.top + ratio * (guide.bottom - guide.top) }} />;
          })}
        </div>
      )}
      {children}
      <style>{`
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
