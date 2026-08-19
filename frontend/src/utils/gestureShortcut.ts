export type GestureDirection = 'up' | 'down' | 'left' | 'right';
export type GestureSide = 'negative' | 'positive';
export type ShortcutSymbol = 'scroll-up' | 'scroll-down' | 'scroll-left' | 'scroll-right' | 'zoom-in' | 'zoom-out' | 'confirm' | 'open-input' | 'cancel' | 'close-input';

export interface GesturePoint { x: number; y: number; }

export interface GestureMatch {
  direction: GestureDirection;
  side: GestureSide;
  symbol: ShortcutSymbol;
  confidence: number;
}

const MIN_DISTANCE = 36;
const MIN_AXIS_RATIO = 1.2;
const MAX_TURNS = 1;
const MIN_DIAGONAL_ANGLE = 20;
const MAX_DIAGONAL_ANGLE = 70;

function distance(a: GesturePoint, b: GesturePoint) { return Math.hypot(b.x - a.x, b.y - a.y); }

function countTurns(points: GesturePoint[], direction: GestureDirection) {
  let turns = 0;
  let previousSign = 0;
  for (let index = 1; index < points.length; index += 1) {
    const delta = direction === 'left' || direction === 'right'
      ? points[index].y - points[index - 1].y
      : points[index].x - points[index - 1].x;
    const sign = Math.sign(delta);
    if (sign !== 0 && previousSign !== 0 && sign !== previousSign) turns += 1;
    if (sign !== 0) previousSign = sign;
  }
  return turns;
}

function inferArrowSide(points: GesturePoint[], horizontal: boolean): GestureSide {
  const overall = horizontal
    ? points[points.length - 1].y - points[0].y
    : points[points.length - 1].x - points[0].x;
  if (Math.abs(overall) >= 3) return overall < 0 ? 'negative' : 'positive';
  for (let index = points.length - 1; index > 0; index -= 1) {
    const transverse = horizontal
      ? points[index].y - points[index - 1].y
      : points[index].x - points[index - 1].x;
    if (Math.abs(transverse) >= 3) return transverse < 0 ? 'negative' : 'positive';
  }
  return 'negative';
}

function recognizeShapeShortcut(points: GesturePoint[], totalDistance: number): GestureMatch | null {
  if (points.length < 3 || totalDistance < MIN_DISTANCE) return null;
  const start = points[0];
  const end = points[points.length - 1];
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;

  const cornerIndex = (selector: (point: GesturePoint) => number) => {
    let selectedIndex = 1;
    let selectedValue = selector(points[1]);
    for (let index = 2; index < points.length - 1; index += 1) {
      const value = selector(points[index]);
      if (value > selectedValue) {
        selectedIndex = index;
        selectedValue = value;
      }
    }
    return selectedIndex;
  };
  const diagonalAngle = Math.atan2(height, width) * (180 / Math.PI);
  const isDiagonal = width >= 24 && height >= 24
    && diagonalAngle >= MIN_DIAGONAL_ANGLE && diagonalAngle <= MAX_DIAGONAL_ANGLE;
  const directDistance = distance(start, end);
  const maxLineDeviation = directDistance === 0 ? Infinity : Math.max(...points.map(point => Math.abs(
    (end.x - start.x) * (start.y - point.y) - (start.x - point.x) * (end.y - start.y),
  ) / directDistance));
  const isStraightDiagonal = isDiagonal && maxLineDeviation <= Math.max(8, directDistance * 0.18);

  const lowerLeftIndex = points.findIndex(point => point.x <= minX + width * 0.3
    && point.y >= minY + height * 0.65);
  const upperLeftIndex = points.findIndex((point, index) => index > lowerLeftIndex
    && point.x <= minX + width * 0.3
    && point.y <= minY + height * 0.35);
  const isOneStrokeCross = points.length >= 4 && width >= 32 && height >= 32
    && start.x > minX + 12 && end.x > minX + 12
    && start.y < minY + height * 0.35
    && end.y > minY + height * 0.65
    && lowerLeftIndex > 0
    && upperLeftIndex > lowerLeftIndex
    && points.slice(upperLeftIndex + 1).some(point => point.x >= minX + width * 0.65
      && point.y >= minY + height * 0.65)
    && directDistance / totalDistance <= 0.6;

  if (isOneStrokeCross) {
    return {
      direction: end.y >= start.y ? 'down' : 'up',
      side: 'negative',
      symbol: 'close-input',
      confidence: 0.85,
    };
  }

  if (isStraightDiagonal) {
    const isBackslash = (end.x - start.x) * (end.y - start.y) > 0;
    return {
      direction: end.y > start.y ? 'down' : 'up',
      side: 'negative',
      symbol: isBackslash ? 'confirm' : 'cancel',
      confidence: 0.8,
    };
  }

  const isDiagonalLeg = (from: GesturePoint, to: GesturePoint) => {
    const legLength = distance(from, to);
    if (legLength < 16) return false;
    return Math.abs(to.x - from.x) / legLength >= 0.25
      && Math.abs(to.y - from.y) / legLength >= 0.25;
  };

  if (isDiagonal) {
    const corner = cornerIndex(point => point.x);
    const pivot = points[corner];
    const firstLeg = distance(start, pivot);
    const secondLeg = distance(pivot, end);
    if (pivot.x > start.x + 8 && pivot.x > end.x + 8
      && firstLeg / secondLeg >= 0.45 && secondLeg / firstLeg >= 0.45
      && isDiagonalLeg(start, pivot) && isDiagonalLeg(pivot, end)
      && pivot.y > start.y && pivot.y < end.y) {
      return { direction: 'right', side: 'negative', symbol: 'zoom-in', confidence: 0.85 };
    }
  }
  if (isDiagonal) {
    const corner = cornerIndex(point => -point.x);
    const pivot = points[corner];
    const firstLeg = distance(start, pivot);
    const secondLeg = distance(pivot, end);
    if (pivot.x < start.x - 8 && pivot.x < end.x - 8
      && firstLeg / secondLeg >= 0.45 && secondLeg / firstLeg >= 0.45
      && isDiagonalLeg(start, pivot) && isDiagonalLeg(pivot, end)
      && pivot.y > start.y && pivot.y < end.y) {
      return { direction: 'left', side: 'negative', symbol: 'zoom-out', confidence: 0.85 };
    }
  }
  if (isDiagonal) {
    const corner = cornerIndex(point => point.y);
    const pivot = points[corner];
    const firstLeg = distance(start, pivot);
    const secondLeg = distance(pivot, end);
    if (pivot.y > start.y + 8 && pivot.y > end.y + 8
      && firstLeg / secondLeg >= 0.45 && secondLeg / firstLeg >= 0.45
      && isDiagonalLeg(start, pivot) && isDiagonalLeg(pivot, end)
      && pivot.x > start.x && pivot.x < end.x) {
      return { direction: 'down', side: 'negative', symbol: 'open-input', confidence: 0.75 };
    }
  }
  return null;
}

export function recognizeGesture(points: GesturePoint[]): GestureMatch | null {
  if (points.length < 2) return null;
  const start = points[0];
  const end = points[points.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const absoluteX = Math.abs(dx);
  const absoluteY = Math.abs(dy);
  const totalDistance = points.slice(1).reduce((total, point, index) => total + distance(points[index], point), 0);
  if (totalDistance < MIN_DISTANCE) return null;
  const shapeShortcut = recognizeShapeShortcut(points, totalDistance);
  if (shapeShortcut) return shapeShortcut;
  const horizontal = absoluteX > absoluteY * MIN_AXIS_RATIO;
  const vertical = absoluteY > absoluteX * MIN_AXIS_RATIO;
  if (!horizontal && !vertical) return null;
  const direction: GestureDirection = horizontal ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  if (countTurns(points, direction) > MAX_TURNS) return null;
  const directness = Math.min(1, distance(start, end) / totalDistance);
  const axisRatio = horizontal ? absoluteX / Math.max(absoluteY, 1) : absoluteY / Math.max(absoluteX, 1);
  const confidence = Math.min(1, directness * 0.65 + Math.min(axisRatio / 3, 1) * 0.35);
  return confidence >= 0.55
    ? { direction, side: inferArrowSide(points, horizontal), symbol: `scroll-${direction}`, confidence }
    : null;
}