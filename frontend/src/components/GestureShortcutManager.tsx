import { useEffect, useRef, useState } from 'react';
import { GestureDirection, GesturePoint, GestureSide, ShortcutSymbol, recognizeGesture } from '../utils/gestureShortcut';

interface Props {
  onConfirm: (direction: GestureDirection, target: HTMLElement | null, symbol: ShortcutSymbol) => void;
}

const CONFIRM_DELAY = 900;
const MIN_SAMPLES = 3;
const CANCEL_DISTANCE = 12;

const directionActions: Record<GestureDirection, string> = {
  up: '当前界面向上滚动',
  down: '当前界面向下滚动',
  left: '当前界面向左滚动',
  right: '当前界面向右滚动',
};

const shortcutLabels: Record<ShortcutSymbol, string> = {
  'scroll-up': '上滑', 'scroll-down': '下滑', 'scroll-left': '左滑', 'scroll-right': '右滑',
  'zoom-in': '>', 'zoom-out': '<', confirm: '✓', cancel: '/',
};

const shortcutActions: Record<ShortcutSymbol, string> = {
  'scroll-up': directionActions.up, 'scroll-down': directionActions.down,
  'scroll-left': directionActions.left, 'scroll-right': directionActions.right,
  'zoom-in': '放大界面', 'zoom-out': '缩小界面',
  confirm: '确认当前可确认操作', cancel: '取消或关闭',
};

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
  if (symbol === 'confirm') return [
    { x1: 12, y1: 32, x2: 34, y2: 52 },
    { x1: 34, y1: 52, x2: 84, y2: 12 },
  ];
  if (symbol === 'cancel') return [
    { x1: 20, y1: 52, x2: 76, y2: 12 },
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

export default function GestureShortcutManager({ onConfirm }: Props) {
  const pointsRef = useRef<GesturePoint[]>([]);
  const pointerIdRef = useRef<number | null>(null);
  const pointerCaptureTargetRef = useRef<Element | null>(null);
  const scrollTargetRef = useRef<HTMLElement | null>(null);
  const pendingPositionRef = useRef<GesturePosition | null>(null);
  const pendingCancelOriginRef = useRef<GesturePosition | null>(null);
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

  useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);

  useEffect(() => {
    if (pendingDirection !== null) return;
    const action = pendingActionRef.current;
    if (!action || action.token !== actionTokenRef.current) return;
    pendingActionRef.current = null;
    onConfirmRef.current(action.direction, action.target, action.symbol);
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

    const onPointerDown = (event: PointerEvent) => {
      if (event.isPrimary === false) return;
      if (pendingPositionRef.current) {
        cancelCandidateRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          position: pendingPositionRef.current,
        };
        clearPending();
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
      if (event.pointerType === 'touch' && pointsRef.current.length >= 2) {
        const first = pointsRef.current[0];
        if (Math.hypot(event.clientX - first.x, event.clientY - first.y) >= 8) event.preventDefault();
      }
      pointsRef.current.push({ x: event.clientX, y: event.clientY });
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerIdRef.current) return;
      const cancelCandidate = cancelCandidateRef.current;
      cancelCandidateRef.current = null;
      const points = pointsRef.current;
      const scrollTarget = scrollTargetRef.current;
      pointerIdRef.current = null;
      scrollTargetRef.current = null;
      pointsRef.current = [];
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
      if (!match) return;
      window.getSelection()?.removeAllRanges();
      const bounds = points.reduce((result, point) => ({
        minX: Math.min(result.minX, point.x),
        maxX: Math.max(result.maxX, point.x),
        minY: Math.min(result.minY, point.y),
        maxY: Math.max(result.maxY, point.y),
      }), { minX: points[0].x, maxX: points[0].x, minY: points[0].y, maxY: points[0].y });
      const position = {
        x: Math.max(72, Math.min(window.innerWidth - 72, (bounds.minX + bounds.maxX) / 2)),
        y: Math.max(36, Math.min(window.innerHeight - 36, (bounds.minY + bounds.maxY) / 2)),
      };
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

    const onCancel = () => {
      pointerIdRef.current = null;
      scrollTargetRef.current = null;
      cancelCandidateRef.current = null;
      pointsRef.current = [];
      pointerCaptureTargetRef.current = null;
      clearPending();
    };

    const onKeyDown = () => clearPending(true);

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onCancel, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointermove', onPointerMove, { capture: true });
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onCancel, true);
      document.removeEventListener('keydown', onKeyDown, true);
      if (cancelledTimerRef.current !== null) window.clearTimeout(cancelledTimerRef.current);
      clearPending();
    };
  }, []);

  if (!pendingDirection || !pendingSide || !pendingSymbol || !pendingPosition) {
    if (!cancelledPosition) return null;
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'fixed', left: cancelledPosition.x, top: cancelledPosition.y,
          transform: 'translate(-50%, -50%)',
          zIndex: 3000, pointerEvents: 'none', padding: '8px 14px', borderRadius: 6,
          background: 'rgba(20, 20, 20, 0.94)', border: '1px solid #f87171', color: '#fecaca',
          fontSize: 13, boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
        }}
      >
        快捷符操作已取消
      </div>
    );
  }
  const symbolLines = getSymbolLines(pendingSymbol, pendingDirection, pendingSide);
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed', left: pendingPosition.x, top: pendingPosition.y,
        transform: 'translate(-50%, -50%)',
        zIndex: 3000, pointerEvents: 'none', padding: '8px 14px', borderRadius: 6,
        background: 'rgba(20, 20, 20, 0.94)', border: '1px solid #666', color: '#fff',
        fontSize: 13, boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
      }}
    >
      <div>快捷符：</div>
      <svg
        role="img"
        aria-label="识别后的快捷符"
        width={96}
        height={64}
        style={{ display: 'block', margin: '2px auto 0' }}
      >
        <g fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
          {symbolLines.map(line => <line key={`${line.x1}-${line.y1}-${line.x2}-${line.y2}`} {...line} />)}
        </g>
      </svg>
      <div>识别结果：{shortcutLabels[pendingSymbol]}</div>
      <div>快捷操作：{shortcutActions[pendingSymbol]}</div>
      <div style={{ marginTop: 2, color: '#cbd5e1' }}>无操作将执行</div>
      <div style={{ color: '#fca5a5' }}>其他操作将取消</div>
    </div>
  );
}