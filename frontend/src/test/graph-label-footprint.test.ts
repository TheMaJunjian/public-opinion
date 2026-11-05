import { describe, expect, it } from 'vitest';
import { computeLabelPlacementsAlongCurve, rectsIntersect, type LabelSeed } from '../utils/graphEdgeGeometry';

const seed = (changes: Partial<LabelSeed> = {}): LabelSeed => ({ drawId: 'structural-edge', text: '标签',
  p0: { x: 200, y: 200 }, p1: { x: 200, y: 200 }, p2: { x: 200, y: 200 }, ...changes });
const place = (value: LabelSeed, forbiddenRects: Array<{x:number;y:number;width:number;height:number}>) => computeLabelPlacementsAlongCurve({ seeds: [value], forbiddenRects })[value.drawId];

describe('measured edge-label collision footprints', () => {
  it('reserves measured text width plus the real horizontal click padding', () => {
    const obstacle = { x: 240, y: 170, width: 50, height: 60 };
    expect(place(seed(), [obstacle])).toEqual({ x: 200, y: 200 });
    const result = place(seed({ measuredWidth: 140, measuredHeight: 28 }), [obstacle]);
    expect(rectsIntersect({ x: result.x - 78, y: result.y - 20, width: 156, height: 40 }, obstacle)).toBe(false);
    expect(result).not.toEqual({ x: 200, y: 200 });
  });

  it('reserves the real vertical click padding and never shrinks the initial estimate', () => {
    const obstacle = { x: 170, y: 225, width: 60, height: 30 };
    const result = place(seed({ measuredWidth: 10, measuredHeight: 50 }), [obstacle]);
    expect(rectsIntersect({ x: result.x - 24, y: result.y - 31, width: 48, height: 62 }, obstacle)).toBe(false);
    expect(place(seed({ measuredWidth: 1, measuredHeight: 1 }), [])).toEqual(place(seed(), []));
  });

  it('includes optional left controls and the existing right decorations in the protected footprint', () => {
    const obstacle = { x: 138, y: 180, width: 20, height: 40 };
    const result = place(seed({ leftWidth: 48, rightWidth: 70, rightHeight: 80 }), [obstacle]);
    expect(rectsIntersect({ x: result.x - 24 - 48, y: result.y - 40, width: 48 + 48 + 70, height: 80 }, obstacle)).toBe(false);
  });

  it('escapes sideways from a tall card instead of exhausting a fixed-x vertical search inside it', () => {
    const value = seed({ p0: { x: 200, y: 2000 }, p1: { x: 200, y: 2000 }, p2: { x: 200, y: 2000 } });
    const obstacle = { x: 0, y: 0, width: 400, height: 4000 }, result = place(value, [obstacle]);
    expect(result.y).toBe(2000); expect(result.x).toBe(432);
    expect(rectsIntersect({ x: result.x - 24, y: result.y - 11, width: 48, height: 22 }, obstacle)).toBe(false);
  });

  it('takes the nearest clear candidate rather than a distant horizontal exit, and separates measured labels', () => {
    const obstacle = { x: 0, y: 190, width: 400, height: 20 }, result = place(seed(), [obstacle]);
    expect(result.x).toBe(200); expect(Math.abs(result.y - 200)).toBe(32);
    const values = [seed({ drawId: 'one', measuredWidth: 160, measuredHeight: 24 }), seed({ drawId: 'two', measuredWidth: 160, measuredHeight: 24 })];
    const placed = computeLabelPlacementsAlongCurve({ seeds: values, forbiddenRects: [] });
    const box = (id: string) => ({ x: placed[id].x - 88, y: placed[id].y - 18, width: 176, height: 36 });
    expect(rectsIntersect(box('one'), box('two'))).toBe(false);
    expect(computeLabelPlacementsAlongCurve({ seeds: [...values].reverse(), forbiddenRects: [] })).toEqual(placed);
  });
});
