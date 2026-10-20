import type { Rect } from './layout';

/** Coordinates relative to a card survive both scrolling and card unmounting. */
export interface CachedGraphAnchors {
  obstacles: Rect[];
  fragments: Record<string, Rect>;
}
export type GraphAnchorCache = Map<string, CachedGraphAnchors>;

export function moveAnchor(rect: Rect, box: Rect): Rect {
  return { ...rect, x: box.x + rect.x, y: box.y + rect.y };
}
