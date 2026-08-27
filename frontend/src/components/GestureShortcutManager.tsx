import { createPortal } from 'react-dom';
import { Z_INDEX } from '../constants/zIndex';
import { useEffect, useRef, useState } from 'react';
import { GestureDirection, GesturePoint, GestureSide, ShortcutSymbol, recognizeGesture } from '../utils/gestureShortcut';

interface Props {
  onConfirm: (direction: GestureDirection, target: HTMLElement | null, symbol: ShortcutSymbol) => void;
}

const CONFIRM_DELAY = 900;
const MIN_SAMPLES = 3;
const CANCEL_DISTANCE = 12;

function shouldBlockTouchScroll(points: GesturePoint[], current: GesturePoint) {
  if (points.length < 2) return false;
  const start = points[0];
  const deltaX = current.x - start.x;
  const deltaY = current.y - start.y;
  const absoluteX = Math.abs(deltaX);
  const absoluteY = Math.abs(deltaY);
  const distance = Math.hypot(deltaX, deltaY);
  if (distance < 24) return false;
  const angle = Math.atan2(absoluteY, absoluteX) * (180 / Math.PI);
  const diagonal = angle >= 20 && angle <= 70;
  const pathDistance = points.slice(1).reduce((total, point, index) => (
    total + Math.hypot(point.x - points[index].x, point.y - points[index].y)
  ), 0) + Math.hypot(current.x - points[points.length - 1].x, current.y - points[points.length - 1].y);
  const turning = pathDistance / Math.max(distance, 1) > 1.18;
  return diagonal || turning;
}

const directionActions: Record<GestureDirection, string> = {
  up: '当前界面向上滚动',
  down: '当前界面向下滚动',
  left: '当前界面向左滚动',
  right: '当前界面向右滚动',
};

const shortcutActions: Record<ShortcutSymbol, string> = {
  'scroll-up': directionActions.up, 'scroll-down': directionActions.down,
  'scroll-left': directionActions.left, 'scroll-right': directionActions.right,
  'zoom-in': '放大界面', 'zoom-out': '缩小界面',
  confirm: '确认当前可确认操作', 'open-input': '打开快捷符输入蒙版', cancel: ' 取消或关闭',
  'close-input': '关闭快捷符输入蒙版', 'switch-view': '切换显示视图',
};

const shortcutGuide: ShortcutSymbol[] = [
  'open-input', 'close-input', 'confirm', 'cancel', 'zoom-in', 'zoom-out',
  'scroll-up', 'scroll-down', 'scroll-left', 'scroll-right', 'switch-view',
];

interface GesturePosition {
  x: number;
  y: number;
}

function isExcludedTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(
    'input, textarea, select, button, a, [contenteditable="true"], [data-gesture-disabled="true"]',
  ));
}

function findScrollTarget(target: EventTarget | null): HTMLElement | null {
  let element = target instanceof Element ? target as HTMLElement : null;
  while (element && element !== document.body) {
    const style = window.getComputedStyle(element);
    const verticalScrollable = element.scrollHeight > element.clientHeight
      && /(auto|scroll|overlay)/.test(style.overflowY);
    const horizontalScrollable = element.scrollWidth > element.clientWidth
      && /(auto|scroll|overlay)/.test(style.overflowX);
    if (verticalScrollable || horizontalScrollable) return element;
    element = element.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}

interface SymbolLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface PendingAction {
  token: number;
  direction: GestureDirection;
  target: HTMLElement | null;
  symbol: ShortcutSymbol;
}

interface CancelCandidate {
  pointerId: number;
  startX: number;
  startY: number;
  position: GesturePosition;
}

function getSymbolLines(symbol: ShortcutSymbol, direction: GestureDirection, side: GestureSide): SymbolLine[] {
  if (symbol === 'zoom-in') return [
    { x1: 12, y1: 16, x2: 72, y2: 32 },
    { x1: 72, y1: 32, x2: 12, y2: 48 },
  ];
  if (symbol === 'zoom-out') return [
    { x1: 84, y1: 16, x2: 24, y2: 32 },
    { x1: 24, y1: 32, x2: 84, y2: 48 },
  ];
  if (symbol === 'open-input') return [
    { x1: 12, y1: 32, x2: 34, y2: 52 },
    { x1: 34, y1: 52, x2: 84, y2: 12 },
  ];
  if (symbol === 'confirm') return [
    { x1: 20, y1: 16, x2: 76, y2: 48 },
  ];
  if (symbol === 'cancel') return [
    { x1: 20, y1: 52, x2: 76, y2: 12 },
  ];
  if (symbol === 'close-input') return [
    { x1: 78, y1: 16, x2: 18, y2: 48 },
    { x1: 18, y1: 48, x2: 18, y2: 16 },
    { x1: 18, y1: 16, x2: 78, y2: 48 },
  ];
  if (symbol === 'switch-view') return [
    { x1: 12, y1: 32, x2: 84, y2: 32 },
  ];
  const negative = side === 'negative';
  if (direction === 'right') return [
    { x1: 12, y1: 32, x2: 84, y2: 32 },
    { x1: 84, y1: 32, x2: 70, y2: negative ? 18 : 46 },
  ];
  if (direction === 'left') return [
    { x1: 84, y1: 32, x2: 12, y2: 32 },
    { x1: 12, y1: 32, x2: 26, y2: negative ? 18 : 46 },
  ];
  if (direction === 'down') return [
    { x1: 32, y1: 12, x2: 32, y2: 52 },
    { x1: 32, y1: 52, x2: negative ? 18 : 46, y2: 38 },
  ];
  return [
    { x1: 32, y1: 52, x2: 32, y2: 12 },
    { x1: 32, y1: 12, x2: negative ? 18 : 46, y2: 26 },
  ];
}

function ShortcutSymbolImage({
  symbol,
  side,
  bothSides = false,
  width = 52,
  height = 34,
}: {
  symbol: ShortcutSymbol;
  side?: GestureSide;
  bothSides?: boolean;
  width?: number;
  height?: number;
}) {
  const direction: GestureDirection = symbol.startsWith('scroll-')
    ? symbol.slice('scroll-'.length) as GestureDirection
    : 'right';
  const sides: GestureSide[] = bothSides && symbol.startsWith('scroll-')
    ? ['negative', 'positive']
    : [side ?? 'negative'];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      {sides.map(currentSide => {
        const lines = getSymbolLines(symbol, direction, currentSide);
        return (
          <svg key={currentSide} aria-hidden="true" width={width} height={height} viewBox="0 0 96 64">
            <g fill="none" stroke="#facc15" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
              {lines.map(line => <line key={`${line.x1}-${line.y1}-${line.x2}-${line.y2}`} {...line} />)}
            </g>
          </svg>
        );
      })}
    </span>
  );
}

export default function GestureShortcutManager({ onConfirm }: Props) {
  const pointsRef = useRef<GesturePoint[]>([]);
  const pointerIdRef = useRef<number | null>(null);
  const suppressedPointerIdRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const allowActionClickRef = useRef(false);
  const actionDispatchingRef = useRef(false);
  const pointerCaptureTargetRef = useRef<Element | null>(null);
  const scrollTargetRef = useRef<HTMLElement | null>(null);
  const pendingPositionRef = useRef<GesturePosition | null>(null);
  const pendingCancelOriginRef = useRef<GesturePosition | null>(null);
  const shortcutInputOpenRef = useRef(false);
  const actionTokenRef = useRef(0);
  const pendingActionRef = useRef<PendingAction | null>(null);
  const cancelCandidateRef = useRef<CancelCandidate | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const cancelledTimerRef = useRef<number | null>(null);
  const onConfirmRef = useRef(onConfirm);
  const [pendingDirection, setPendingDirection] = useState<GestureDirection | null>(null);
  const [pendingSide, setPendingSide] = useState<GestureSide | null>(null);
  const [pendingSymbol, setPendingSymbol] = useState<ShortcutSymbol | null>(null);
  const [pendingPosition, setPendingPosition] = useState<GesturePosition | null>(null);
  const [cancelledPosition, setCancelledPosition] = useState<GesturePosition | null>(null);
  const [shortcutFailurePosition, setShortcutFailurePosition] = useState<GesturePosition | null>(null);
  const [shortcutInputOpen, setShortcutInputOpen] = useState(false);
    const [shortcutInputPosition, setShortcutInputPosition] = useState<GesturePosition | null>(null);
  const [inputPoints, setInputPoints] = useState<GesturePoint[]>([]);

  useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);

  useEffect(() => {
    if (pendingDirection !== null) return;
    const action = pendingActionRef.current;
    if (!action || action.token !== actionTokenRef.current) return;
    pendingActionRef.current = null;
    allowActionClickRef.current = true;
    actionDispatchingRef.current = true;
    onConfirmRef.current(action.direction, action.target, action.symbol);
    shortcutInputOpenRef.current = true;
    setShortcutInputOpen(true);
    actionDispatchingRef.current = false;
    allowActionClickRef.current = false;
  }, [pendingDirection]);

  useEffect(() => {
    const clearPending = (showCancellation = false) => {
      actionTokenRef.current += 1;
      pendingActionRef.current = null;
      if (showCancellation && pendingPositionRef.current) {
        if (cancelledTimerRef.current !== null) window.clearTimeout(cancelledTimerRef.current);
        setCancelledPosition(pendingPositionRef.current);
        cancelledTimerRef.current = window.setTimeout(() => {
          cancelledTimerRef.current = null;
          setCancelledPosition(null);
        }, 1000);
      }
      if (pendingTimerRef.current !== null) window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
      setPendingDirection(null);
      setPendingSide(null);
      setPendingSymbol(null);
      setPendingPosition(null);
      pendingPositionRef.current = null;
      pendingCancelOriginRef.current = null;
    };

    const closeShortcutInput = () => {
      shortcutInputOpenRef.current = false;
      setShortcutInputOpen(false);
      clearPending();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.isPrimary === false) return;
      if (actionDispatchingRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (shortcutInputOpenRef.current) {
        const inputMask = event.target instanceof Element
          ? event.target.closest('[data-shortcut-input-mask="true"]')
          : null;
        if (!inputMask) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (shortcutInputOpenRef.current && event.pointerType === 'mouse' && event.button !== 0) return;
      if (shortcutInputOpenRef.current) {
        setInputPoints([{ x: event.clientX, y: event.clientY }]);
      }
      if (!shortcutInputOpenRef.current && pendingPositionRef.current) {
        cancelCandidateRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          position: pendingPositionRef.current,
        };
      } else {
        cancelCandidateRef.current = null;
      }
      if (isExcludedTarget(event.target)) {
        pointerIdRef.current = event.pointerId;
        pointsRef.current = [];
        return;
      }
      if (event.pointerType === 'touch' && event.target instanceof Element) {
        try {
          event.target.setPointerCapture(event.pointerId);
          pointerCaptureTargetRef.current = event.target;
        } catch {
          pointerCaptureTargetRef.current = null;
        }
      }
      pointerIdRef.current = event.pointerId;
      scrollTargetRef.current = findScrollTarget(event.target);
      pointsRef.current = [{ x: event.clientX, y: event.clientY }];
    };

    const onPointerMove = (event: PointerEvent) => {
      if (shortcutInputOpenRef.current && event.pointerId === pointerIdRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (pointerIdRef.current === null && pendingCancelOriginRef.current && pendingPositionRef.current) {
        const movement = Math.hypot(
          event.clientX - pendingCancelOriginRef.current.x,
          event.clientY - pendingCancelOriginRef.current.y,
        );
        if (movement >= CANCEL_DISTANCE) {
          clearPending(true);
          return;
        }
      }
      if (event.pointerId !== pointerIdRef.current) return;
      const isTopicLeftPanelTouch = event.pointerType === 'touch'
        && event.target instanceof Element
        && Boolean(event.target.closest('[data-topic-left-panel]'));
      if (event.pointerType === 'touch' && !isTopicLeftPanelTouch && pointsRef.current.length >= 2) {
        const first = pointsRef.current[0];
        const current = { x: event.clientX, y: event.clientY };
        if (Math.hypot(event.clientX - first.x, event.clientY - first.y) >= 8
          && shouldBlockTouchScroll(pointsRef.current, current)) event.preventDefault();
      }
      const point = { x: event.clientX, y: event.clientY };
      pointsRef.current.push(point);
      if (shortcutInputOpenRef.current) setInputPoints(current => [...current, point]);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (shortcutInputOpenRef.current && event.pointerId === pointerIdRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (event.pointerId === suppressedPointerIdRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressedPointerIdRef.current = null;
        pointerIdRef.current = null;
        pointsRef.current = [];
        return;
      }
      if (event.pointerId !== pointerIdRef.current) return;
      const cancelCandidate = cancelCandidateRef.current;
      cancelCandidateRef.current = null;
      const points = pointsRef.current;
      const scrollTarget = scrollTargetRef.current;
      pointerIdRef.current = null;
      scrollTargetRef.current = null;
      pointsRef.current = [];
      if (!shortcutInputOpenRef.current) setInputPoints([]);
      if (pointerCaptureTargetRef.current?.hasPointerCapture(event.pointerId)) {
        pointerCaptureTargetRef.current.releasePointerCapture(event.pointerId);
      }
      pointerCaptureTargetRef.current = null;
      if (cancelCandidate?.pointerId === event.pointerId) {
        const movement = Math.hypot(
          event.clientX - cancelCandidate.startX,
          event.clientY - cancelCandidate.startY,
        );
        if (movement === 0 || movement >= CANCEL_DISTANCE) {
          clearPending();
          if (cancelledTimerRef.current !== null) window.clearTimeout(cancelledTimerRef.current);
          setCancelledPosition(cancelCandidate.position);
          cancelledTimerRef.current = window.setTimeout(() => {
            cancelledTimerRef.current = null;
            setCancelledPosition(null);
          }, 1000);
        }
        return;
      }
      if (points.length < MIN_SAMPLES) return;

      const match = recognizeGesture(points);
      if (!match) {
        if (shortcutInputOpenRef.current) {
          setInputPoints([]);
          setShortcutFailurePosition({ x: event.clientX, y: event.clientY });
          window.setTimeout(() => setShortcutFailurePosition(null), 1400);
        }
        return;
      }
      if (!shortcutInputOpenRef.current && match.symbol !== 'open-input') return;
      if (shortcutInputOpenRef.current && (match.symbol === 'open-input' || match.symbol === 'close-input')) {
        if (match.symbol === 'close-input') closeShortcutInput();
        setInputPoints([]);
        return;
      }
      window.getSelection()?.removeAllRanges();
      const position = {
        x: Math.max(180, Math.min(window.innerWidth - 180, points[points.length - 1].x)),
        y: Math.max(120, Math.min(window.innerHeight - 120, points[points.length - 1].y)),
      };
      const inputWasOpen = shortcutInputOpenRef.current;
      if (inputWasOpen) {
        setInputPoints([]);
        if (cancelledTimerRef.current !== null) window.clearTimeout(cancelledTimerRef.current);
        cancelledTimerRef.current = null;
        setCancelledPosition(null);
        const actionToken = actionTokenRef.current + 1;
        actionTokenRef.current = actionToken;
        setPendingDirection(match.direction);
        setPendingSide(match.side);
        setPendingSymbol(match.symbol);
        setPendingPosition(position);
        pendingPositionRef.current = position;
        pendingCancelOriginRef.current = { x: points[points.length - 1].x, y: points[points.length - 1].y };
        pendingTimerRef.current = window.setTimeout(() => {
          if (actionToken !== actionTokenRef.current) return;
          pendingTimerRef.current = null;
          pendingActionRef.current = { token: actionToken, direction: match.direction, target: scrollTarget, symbol: match.symbol };
          setPendingDirection(null);
          setPendingSide(null);
          setPendingSymbol(null);
          setPendingPosition(null);
          pendingPositionRef.current = null;
          pendingCancelOriginRef.current = null;
        }, CONFIRM_DELAY);
        return;
      }
      if (match.symbol === 'open-input') {
        setShortcutInputPosition(position);
        shortcutInputOpenRef.current = true;
        setShortcutInputOpen(true);
        setInputPoints([]);
        return;
      }
      if (cancelledTimerRef.current !== null) window.clearTimeout(cancelledTimerRef.current);
      cancelledTimerRef.current = null;
      setCancelledPosition(null);
      const actionToken = actionTokenRef.current + 1;
      actionTokenRef.current = actionToken;
      setPendingDirection(match.direction);
      setPendingSide(match.side);
      setPendingSymbol(match.symbol);
      setPendingPosition(position);
      pendingPositionRef.current = position;
      pendingCancelOriginRef.current = { x: points[points.length - 1].x, y: points[points.length - 1].y };
      pendingTimerRef.current = window.setTimeout(() => {
        if (actionToken !== actionTokenRef.current) return;
        pendingTimerRef.current = null;
        pendingActionRef.current = { token: actionToken, direction: match.direction, target: scrollTarget, symbol: match.symbol };
        setPendingDirection(null);
        setPendingSide(null);
        setPendingSymbol(null);
        setPendingPosition(null);
        pendingPositionRef.current = null;
        pendingCancelOriginRef.current = null;
      }, CONFIRM_DELAY);
    };

    const onClick = (event: MouseEvent) => {
      if (actionDispatchingRef.current || allowActionClickRef.current) {
        allowActionClickRef.current = false;
        return;
      }
      if (shortcutInputOpenRef.current && event.target instanceof Element
        && event.target.closest('[data-shortcut-input-mask="true"]')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!suppressClickRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClickRef.current = false;
    };

    const onCancel = () => {
      if (actionDispatchingRef.current) return;
      if (shortcutInputOpenRef.current) {
        pointerIdRef.current = null;
        pointsRef.current = [];
        setInputPoints([]);
        return;
      }
      pointerIdRef.current = null;
      scrollTargetRef.current = null;
      cancelCandidateRef.current = null;
      pointsRef.current = [];
      pointerCaptureTargetRef.current = null;
      clearPending();
      suppressedPointerIdRef.current = null;
      suppressClickRef.current = false;
      allowActionClickRef.current = false;
      actionDispatchingRef.current = false;
      shortcutInputOpenRef.current = false;
      setShortcutInputOpen(false);
      setInputPoints([]);
    };

    const onKeyDown = () => {
      if (actionDispatchingRef.current) return;
      if (!shortcutInputOpenRef.current) clearPending(true);
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onCancel, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointermove', onPointerMove, { capture: true });
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onCancel, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      if (cancelledTimerRef.current !== null) window.clearTimeout(cancelledTimerRef.current);
      clearPending();
      shortcutInputOpenRef.current = false;
      setShortcutInputPosition(null);
      setInputPoints([]);
    };
  }, []);

  if (shortcutInputOpen) {
    return createPortal((
      <div
        role="dialog"
        aria-modal="true"
        aria-label="快捷符输入蒙版"
        style={{
          position: 'fixed', inset: 0, zIndex: Z_INDEX.shortcut,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none', userSelect: 'none',
        }}
      >
        <div
          aria-hidden="true"
          style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: Z_INDEX.shortcutVisual }}
        >
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`}
            preserveAspectRatio="none"
            style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
          >
            {inputPoints.length > 1 && (
              <>
                <polyline
                  points={inputPoints.map(point => `${point.x},${point.y}`).join(' ')}
                  fill="none" stroke="#ffffff" strokeWidth="11" opacity="0.95"
                  strokeLinecap="round" strokeLinejoin="round"
                />
                <polyline
                  points={inputPoints.map(point => `${point.x},${point.y}`).join(' ')}
                  fill="none" stroke="#22d3ee" strokeWidth="6"
                  strokeLinecap="round" strokeLinejoin="round"
                  style={{ filter: 'drop-shadow(0 0 5px rgba(34,211,238,0.95))' }}
                />
              </>
            )}
          </svg>
        </div>
        <div
          data-shortcut-input-mask="true"
          style={{
            width: 'min(360px, calc(100vw - 32px))', minHeight: 220,
            padding: '18px 20px', boxSizing: 'border-box',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
            background: 'rgba(20, 20, 20, 0.94)', border: '1px solid #facc15', borderRadius: 10,
            color: '#fff', boxShadow: '0 12px 40px rgba(0,0,0,0.5)', pointerEvents: 'auto',
            touchAction: 'none', userSelect: 'none', position: 'absolute',
            left: shortcutInputPosition?.x ?? window.innerWidth / 2,
            top: shortcutInputPosition?.y ?? window.innerHeight / 2,
            transform: 'translate(-50%, -50%)',
            zIndex: Z_INDEX.shortcutContent,
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600 }}>快捷符输入</div>
          <div style={{ color: '#cbd5e1', fontSize: 13, textAlign: 'center' }}>
            按住鼠标左键或手指滑动绘制快捷符
          </div>
          <div
            aria-label="快捷符功能"
            style={{
              width: '100%', marginTop: 8, padding: 8, boxSizing: 'border-box',
              display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6,
              borderTop: '1px solid #333', color: '#cbd5e1', fontSize: 11,
            }}
          >
            {shortcutGuide.map(symbol => (
              <div key={symbol} style={{
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <ShortcutSymbolImage symbol={symbol} bothSides />
                <span style={{ textAlign: 'right' }}>{shortcutActions[symbol]}</span>
              </div>
            ))}
          </div>
        </div>
        {pendingDirection && pendingSide && pendingSymbol && pendingPosition && (
          <div
            data-shortcut-input-mask="true"
            role="status"
            aria-live="polite"
            style={{
              position: 'fixed', left: pendingPosition.x, top: pendingPosition.y,
              transform: 'translate(-50%, -50%)', zIndex: Z_INDEX.shortcutStatus, pointerEvents: 'none',
              padding: '8px 14px', borderRadius: 6, background: 'rgba(20, 20, 20, 0.96)',
              border: '1px solid #666', color: '#fff', fontSize: 13,
              boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
            }}
          >
            <div>识别结果：</div>
            <ShortcutSymbolImage symbol={pendingSymbol} side={pendingSide} width={96} height={64} />
            <div>快捷操作：{shortcutActions[pendingSymbol]}</div>
            <div style={{ marginTop: 2, color: '#cbd5e1' }}>无操作将执行</div>
            <div style={{ color: '#fca5a5' }}>其他操作将取消</div>
          </div>
        )}
        {cancelledPosition && !pendingDirection && (
          <div
            role="status"
            aria-live="polite"
            style={{
              position: 'fixed', left: cancelledPosition.x, top: cancelledPosition.y,
              transform: 'translate(-50%, -50%)', zIndex: Z_INDEX.shortcutCancelled, pointerEvents: 'none',
              padding: '8px 14px', borderRadius: 6, background: 'rgba(20, 20, 20, 0.96)',
              border: '1px solid #f87171', color: '#fecaca', fontSize: 13,
              boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
            }}
          >
            快捷操作已取消
          </div>
        )}
        {shortcutFailurePosition && (
          <div
            role="status"
            aria-live="polite"
            style={{
              position: 'fixed', left: shortcutFailurePosition.x, top: shortcutFailurePosition.y,
              transform: 'translate(-50%, -50%)', zIndex: Z_INDEX.shortcutFailure, pointerEvents: 'none',
              padding: '8px 14px', borderRadius: 6, background: 'rgba(20, 20, 20, 0.96)',
              border: '1px solid #f87171', color: '#fecaca', fontSize: 13,
              boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
            }}
          >
            快捷符识别失败
          </div>
        )}
      </div>
    ), document.body);
  }

  if (!pendingDirection || !pendingSide || !pendingSymbol || !pendingPosition) {
    if (!cancelledPosition && !shortcutFailurePosition) return null;
    const statusPosition = shortcutFailurePosition ?? cancelledPosition!;
    return createPortal((
      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'fixed', left: statusPosition.x, top: statusPosition.y,
          transform: 'translate(-50%, -50%)',
          zIndex: Z_INDEX.shortcutTransient, pointerEvents: 'none', padding: '8px 14px', borderRadius: 6,
          background: 'rgba(20, 20, 20, 0.94)', border: '1px solid #f87171', color: '#fecaca',
          fontSize: 13, boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
        }}
      >
        {shortcutFailurePosition ? '快捷符识别失败' : '快捷符操作已取消'}
      </div>
    ), document.body);
  }
  return createPortal((
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed', left: pendingPosition.x, top: pendingPosition.y,
        transform: 'translate(-50%, -50%)',
        zIndex: Z_INDEX.shortcutTransient, pointerEvents: 'none', padding: '8px 14px', borderRadius: 6,
        background: 'rgba(20, 20, 20, 0.94)', border: '1px solid #666', color: '#fff',
        fontSize: 13, boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
      }}
    >
      <div>识别结果：</div>
      <ShortcutSymbolImage symbol={pendingSymbol} side={pendingSide} width={96} height={64} />
      <div>快捷操作：{shortcutActions[pendingSymbol]}</div>
      <div style={{ marginTop: 2, color: '#cbd5e1' }}>无操作将执行</div>
      <div style={{ color: '#fca5a5' }}>其他操作将取消</div>
    </div>
  ), document.body);
}