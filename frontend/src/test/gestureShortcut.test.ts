import { describe, expect, it } from 'vitest';
import { GestureDirection, GesturePoint, GestureSide, recognizeGesture } from '../utils/gestureShortcut';

const line = (x1: number, y1: number, x2: number, y2: number) => [
  { x: x1, y: y1 },
  { x: x2, y: y2 },
];

describe('recognizeGesture', () => {
  it.each([
    ['up', line(10, 100, 10, 20)],
    ['down', line(10, 20, 10, 100)],
    ['left', line(100, 20, 20, 20)],
    ['right', line(20, 20, 100, 20)],
  ])('recognizes a one-stroke %s gesture', (direction, points) => {
    expect(recognizeGesture(points)?.direction).toBe(direction);
  });

  it('preserves the half-arrow side from the input stroke', () => {
    const combinations: Array<[GesturePoint[], GestureDirection, GestureSide]> = [
      [[{ x: 20, y: 40 }, { x: 70, y: 40 }, { x: 84, y: 24 }], 'right', 'negative'],
      [[{ x: 20, y: 40 }, { x: 70, y: 40 }, { x: 84, y: 56 }], 'right', 'positive'],
      [[{ x: 84, y: 40 }, { x: 34, y: 40 }, { x: 20, y: 24 }], 'left', 'negative'],
      [[{ x: 84, y: 40 }, { x: 34, y: 40 }, { x: 20, y: 56 }], 'left', 'positive'],
      [[{ x: 40, y: 84 }, { x: 40, y: 34 }, { x: 24, y: 20 }], 'up', 'negative'],
      [[{ x: 40, y: 84 }, { x: 40, y: 34 }, { x: 56, y: 20 }], 'up', 'positive'],
      [[{ x: 40, y: 20 }, { x: 40, y: 70 }, { x: 24, y: 84 }], 'down', 'negative'],
      [[{ x: 40, y: 20 }, { x: 40, y: 70 }, { x: 56, y: 84 }], 'down', 'positive'],
    ];
    for (const [points, direction, side] of combinations) {
      expect(recognizeGesture(points)).toMatchObject({ direction, side });
    }
  });

  it.each([
    ['zoom-in', [{ x: 20, y: 20 }, { x: 80, y: 40 }, { x: 20, y: 60 }]],
    ['zoom-out', [{ x: 80, y: 20 }, { x: 20, y: 40 }, { x: 80, y: 60 }]],
    ['open-input', [{ x: 20, y: 20 }, { x: 40, y: 60 }, { x: 80, y: 20 }]],
    ['open-input', [{ x: 20, y: 20 }, { x: 40, y: 60 }, { x: 60, y: 60 }, { x: 80, y: 20 }]],
    ['confirm', [{ x: 20, y: 20 }, { x: 50, y: 42 }, { x: 80, y: 80 }]],
    ['cancel', [{ x: 20, y: 80 }, { x: 50, y: 42 }, { x: 80, y: 20 }]],
    ['confirm', [{ x: 80, y: 80 }, { x: 50, y: 42 }, { x: 20, y: 20 }]],
    ['cancel', [{ x: 80, y: 20 }, { x: 50, y: 42 }, { x: 20, y: 80 }]],
    ['close-input', [{ x: 80, y: 20 }, { x: 20, y: 80 }, { x: 20, y: 20 }, { x: 80, y: 80 }]],
    ['confirm', [{ x: 20, y: 20 }, { x: 35, y: 31 }, { x: 50, y: 42 }, { x: 65, y: 54 }, { x: 80, y: 80 }]],
    ['cancel', [{ x: 20, y: 80 }, { x: 35, y: 69 }, { x: 50, y: 58 }, { x: 65, y: 46 }, { x: 80, y: 20 }]],
  ])('recognizes %s shortcut symbols', (symbol, points) => {
    expect(recognizeGesture(points)).toMatchObject({ symbol });
  });

  it.each([
    [{ x: 20, y: 40 }, { x: 60, y: 40 }, { x: 100, y: 40 }, { x: 60, y: 40 }, { x: 24, y: 40 }],
    [{ x: 100, y: 40 }, { x: 60, y: 40 }, { x: 20, y: 40 }, { x: 60, y: 40 }, { x: 96, y: 40 }],
  ])('recognizes a horizontal out-and-back stroke as a view switch', (...points) => {
    expect(recognizeGesture(points)).toMatchObject({ symbol: 'switch-view' });
  });

  it('rejects short and heavily wavering strokes', () => {
    expect(recognizeGesture(line(0, 0, 20, 0))).toBeNull();
    expect(recognizeGesture(line(0, 0, 60, 15))).not.toMatchObject({ symbol: 'cancel' });
    expect(recognizeGesture([
      { x: 20, y: 40 }, { x: 70, y: 40 }, { x: 84, y: 24 },
    ])).toMatchObject({ symbol: 'scroll-right' });
    expect(recognizeGesture([
      { x: 20, y: 80 }, { x: 50, y: 72 }, { x: 80, y: 65 },
    ])).not.toMatchObject({ symbol: 'cancel' });
    expect(recognizeGesture([
      { x: 0, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 40 }, { x: 30, y: 60 },
    ])).toBeNull();
  });
});