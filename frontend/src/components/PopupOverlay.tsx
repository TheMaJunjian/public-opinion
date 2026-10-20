import { createPortal } from 'react-dom';
import { Z_INDEX } from '../constants/zIndex';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode, RefObject } from 'react';

const EDGE_ARROW_COUNT = 25;
const GUIDE_EDGE_INSET = 12;

/** Copy the highlighted region without duplicating every card in a large graph. */
function cloneHighlightRegion(source: Element, bounds: DOMRect): Element | null {
  // SVG definitions have no visible bounds but are needed by copied paths.
  if (['defs', 'style'].includes(source.localName)) return source.cloneNode(true) as Element;
  const rect = source.getBoundingClientRect();
  // Absolute card children can overflow a zero-height wrapper above the frame.
  // Such wrappers have no visible region of their own to cull.
  if (rect.width > 0 && rect.height > 0
    && (rect.right < bounds.left || rect.left > bounds.right || rect.bottom < bounds.top || rect.top > bounds.bottom)) return null;
  // Preserve card/badge layout, including children that overflow its own box.
  if (source.matches('[data-msgid], [data-rel-overlay]')) return source.cloneNode(true) as Element;
  const clone = source.cloneNode(false) as Element;
  for (const child of source.childNodes) {
    const copied = child instanceof Element ? cloneHighlightRegion(child, bounds) : child.cloneNode(false);
    if (copied) clone.appendChild(copied);
  }
  return clone;
}

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
  const contentLayerRef = useRef<HTMLDivElement>(null);
  const cloneId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const targetCenter = {
    x: targetRect.left + targetRect.width / 2,
    y: targetRect.top + targetRect.height / 2,
  };

  useLayoutEffect(() => {
    const layer = contentLayerRef.current;
    if (!layer || !targetElement.isConnected) return;
    // Organization frames and their member cards are sibling layers in the canvas.
    const source = targetElement.hasAttribute('data-rel-overlay')
      ? targetElement.closest<HTMLElement>('[data-jump-canvas]') ?? targetElement
      : targetElement;
    const sourceRect = source.getBoundingClientRect();
    const clone = (source === targetElement ? source.cloneNode(true) : cloneHighlightRegion(source, targetRect)) as HTMLElement | null;
    if (!clone) return;
    const frame = document.createElement('div');
    frame.dataset.messageJumpClone = 'true';
    frame.inert = true;
    const sourceStyle = getComputedStyle(source);
    Object.assign(frame.style, {
      position: 'fixed', left: `${targetRect.left}px`, top: `${targetRect.top}px`,
      width: `${targetRect.width}px`, height: `${targetRect.height}px`,
      overflow: 'hidden', background: '#1f1f1f', pointerEvents: 'none',
      font: sourceStyle.font, color: sourceStyle.color, letterSpacing: sourceStyle.letterSpacing,
    });
    Object.assign(clone.style, {
      position: 'absolute', left: `${sourceRect.left - targetRect.left}px`, top: `${sourceRect.top - targetRect.top}px`,
      width: `${sourceRect.width}px`, height: `${sourceRect.height}px`,
      boxSizing: 'border-box', margin: '0', transform: 'none',
    });
    const nodes = [clone, ...clone.querySelectorAll<HTMLElement | SVGElement>('*')];
    const ids = new Map<string, string>();
    for (const node of nodes) {
      node.style.setProperty('pointer-events', 'none', 'important');
      if (node.id) {
        const replacement = `jump-${cloneId}-${node.id}`;
        ids.set(node.id, replacement);
        node.id = replacement;
      }
    }
    // Keep copied SVG markers local to the copy and avoid duplicate document IDs.
    for (const node of nodes) for (const attribute of Array.from(node.attributes)) {
      const value = attribute.value.replace(/url\((['"]?)#([^)'"\s]+)\1\)/g,
        (match, quote: string, id: string) => ids.has(id) ? `url(${quote}#${ids.get(id)}${quote})` : match);
      const reference = attribute.localName === 'href' && value.startsWith('#') ? ids.get(value.slice(1)) : undefined;
      if (value !== attribute.value || reference) node.setAttribute(attribute.name, reference ? `#${reference}` : value);
    }
    frame.appendChild(clone);
    layer.appendChild(frame);
    // The live scene stays visible and interactive underneath this pointer-transparent copy.
    return () => frame.remove();
  }, [targetElement, targetRect, cloneId]);

  if (!targetElement.isConnected) return null;

  return createPortal((
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
      <div ref={contentLayerRef} style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }} />
      <div style={{
        position: 'fixed', left: '50%', top: 16, transform: 'translateX(-50%)',
        zIndex: 3,
        padding: '6px 12px', border: '1px solid rgba(250,204,21,0.7)', borderRadius: 4,
        background: 'rgba(23,23,23,0.92)', color: '#fde68a', fontSize: 13, fontWeight: 600,
        whiteSpace: 'nowrap', boxShadow: '0 2px 10px rgba(0,0,0,0.45)', pointerEvents: 'none',
      }}>已定位目标消息</div>
    </div>
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
      <div className="popup-guides" aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseGuide key={`top-${index}`}
              start={{ x: ratio * overlayWidth, y: GUIDE_EDGE_INSET }} end={center} />;
          })}
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseGuide key={`bottom-${index}`}
              start={{ x: ratio * overlayWidth, y: overlayHeight - GUIDE_EDGE_INSET }} end={center} />;
          })}
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseGuide key={`left-${index}`}
              start={{ x: GUIDE_EDGE_INSET, y: ratio * overlayHeight }} end={center} />;
          })}
          {Array.from({ length: EDGE_ARROW_COUNT }, (_, index) => {
            const ratio = (index + 0.5) / EDGE_ARROW_COUNT;
            return <PulseGuide key={`right-${index}`}
              start={{ x: overlayWidth - GUIDE_EDGE_INSET, y: ratio * overlayHeight }} end={center} />;
          })}
      </div>
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
