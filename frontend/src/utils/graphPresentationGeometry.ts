import type { DemoMessage, DemoEdge } from './modelBridge';
import { isContentKind } from './modelBridge';
import { getPresentationSpec } from '../types';
import type { PresentationKind } from '../types';
import { GRID_LEFT, FRAME_PAD, MERGE_CARD_H } from './layout';
import type { LayoutBox, Rect } from './layout';
type RelationBounds = { rect: LayoutBox; cardIds: Set<string> };

export const DEC_W = 56;        // width of each decoration badge
export const DEC_H = 22;        // height of each decoration badge
export const DEC_GAP = 4;       // vertical gap between agree / disagree decorations
export const DEC_RIGHT_GAP = 6; // horizontal gap between card right edge and decoration
export const DEC_RIGHT_TOP = 4; // y offset from card top
export const DEC_ICON_W = 20;   // clickable icon area width within a decoration badge
export const EDGE_HINT_W = 16;

export function getEdgeDecorationLeft(label: Rect, hasHint = true): number {
  return label.x + label.width + DEC_RIGHT_GAP + (hasHint ? EDGE_HINT_W + DEC_GAP : 0);
}

export function getDecorationColumnWidth(expanded: boolean): number {
  return EDGE_HINT_W + (expanded ? DEC_GAP + DEC_W : 0);
}
// TAG label constants
export const TAG_H = 18;            // height of each tag label badge
export const TAG_MIN_W = 36;        // minimum width
export const TAG_V_GAP = 3;         // vertical gap between stacked tag labels
export const TAG_RIGHT_GAP = 6;     // horizontal gap from card right edge
export const TAG_MAX_LABEL_CHARS = 20; // max characters shown in a tag label badge
export const TAG_HIT_PAD = 14;  // extra transparent padding around tag hit area so tags are easy to click even when overlapping frames (> FRAME_PAD=12 so tag hit area fully covers frame border strip overlap)
// Frame constants (shared by arrange, classify, merge, summary frames)
// FRAME_PAD is imported from ../utils/layout
export const FRAME_PAD_X = GRID_LEFT;  // 18 — horizontal padding inside frame
export const FRAME_PAD_Y = FRAME_PAD;  // 16 — keep category content close to its frame header
export const FRAME_RADIUS = 8; // border-radius of group frames
export const MAX_RELATION_NESTING_DEPTH = 10; // guard against infinite recursion when resolving nested relation visual boxes
export const LABEL_BBOX_STABILITY_THRESHOLD = 0.5;
export const MERGE_CONTENT_TOP_GAP = 8;
export const MERGE_CARD_HEADER_X_OFFSET = 8;
export const MERGE_CARD_HEADER_Y_OFFSET = 8;
export const GROUP_HEADER_MIN_W = 180;
export const GROUP_HEADER_MAX_W = 320;
export const GROUP_HEADER_X_OFFSET = 6;
export const GROUP_HEADER_HEIGHT = 56;
// MERGE_CARD_H is imported from ../utils/layout

// Shared empty set for fallback


// Group frame stroke colors by relColor value
export const GROUP_FRAME_STROKE: Record<string,string> = {
  yellow: 'rgba(220,180,0,0.7)', amber: 'rgba(200,140,0,0.7)',
  gray: 'rgba(140,140,150,0.55)', slate: 'rgba(100,110,120,0.55)',
};
export const SHOW_SELECTED_ACTUAL_RECTS = false;

// Inline badge background colors by relColor value
export const INLINE_BADGE_COLOR: Record<string,string> = {
  orange: 'rgba(200,90,0,0.9)',
  slate: 'rgba(80,90,100,0.9)',
};



export function unionLayoutRects(first: Rect | undefined, second: Rect | undefined): Rect | undefined {
  if (!first) return second;
  if (!second) return first;
  const right = Math.max(first.x + first.width, second.x + second.width);
  const bottom = Math.max(first.y + first.height, second.y + second.height);
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  return { x, y, width: right - x, height: bottom - y };
}

export function getRelKind(relType: string): PresentationKind {
  return getPresentationSpec(relType).kind;
}

export function isArrangeFrameRel(relType: string): boolean {
  return getRelKind(relType) === 'arrange-frame';
}

export function isAnyFrameRel(relType: string): boolean {
  const k = getRelKind(relType);
  return k === 'arrange-frame' || k === 'frame-group' || k === 'replace-overlay';
}

export function isCorrectionBadgeRel(relType: string): boolean {
  return getRelKind(relType) === 'correction-badge';
}

export function unionBoxes(boxes: LayoutBox[]): LayoutBox | null {
  if (boxes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function getGroupHeaderHeight(measuredHeights: Record<string, number>, relMsgId: string): number {
  return Math.max(GROUP_HEADER_HEIGHT, measuredHeights[relMsgId] ?? GROUP_HEADER_HEIGHT);
}

export function getGroupHeaderRect(frameRect: Rect, height = GROUP_HEADER_HEIGHT): Rect {
  return {
    x: frameRect.x + GROUP_HEADER_X_OFFSET,
    y: frameRect.y - height,
    width: Math.min(GROUP_HEADER_MAX_W, Math.max(GROUP_HEADER_MIN_W, frameRect.width - 24)),
    height,
  };
}

export function getMergeCardHeaderRect(frameRect: Rect): Rect {
  return {
    x: frameRect.x + MERGE_CARD_HEADER_X_OFFSET,
    y: frameRect.y + MERGE_CARD_HEADER_Y_OFFSET,
    width: Math.min(GROUP_HEADER_MAX_W, Math.max(GROUP_HEADER_MIN_W, frameRect.width - 24)),
    height: MERGE_CARD_H,
  };
}

export function getRelationBoundsFromLayout(params: {
  relMsgId: string;
  edgesByRelMsg: Map<string, DemoEdge[]>;
  layout: Record<string, LayoutBox>;
  msgMap: Map<string, DemoMessage>;
  relationCardMsgIds: Set<string>;
  visited?: Set<string>;
  /** Optional DOM-aware box lookup; when provided, used instead of layout for individual cards. */
  boxFn?: (id: string) => LayoutBox | null | undefined;
}): RelationBounds | null {
  const { relMsgId, edgesByRelMsg, layout, msgMap, relationCardMsgIds } = params;
  const visited = params.visited ?? new Set<string>();
  if (visited.has(relMsgId)) return null;
  visited.add(relMsgId);

  const relMsg = msgMap.get(relMsgId);

  const relEdges = edgesByRelMsg.get(relMsgId) ?? [];
  const boxes: LayoutBox[] = [];
  const cardIds = new Set<string>();
  for (const edge of relEdges) {
    for (const endpointId of [edge.from.messageId, edge.to.messageId]) {
      if (endpointId.startsWith("anon:")) continue;
      const endpointMsg = msgMap.get(endpointId);
      if (endpointMsg?.kind === "relation") {
        const nested = getRelationBoundsFromLayout({ relMsgId: endpointId, edgesByRelMsg, layout, msgMap, relationCardMsgIds, visited, boxFn: params.boxFn });
        if (!nested) continue;
        boxes.push(nested.rect);
        nested.cardIds.forEach(id => cardIds.add(id));
        continue;
      }
      const endpointBox = params.boxFn ? (params.boxFn(endpointId) ?? layout[endpointId]) : layout[endpointId];
      if (endpointBox && (endpointMsg && isContentKind(endpointMsg.kind) || relationCardMsgIds.has(endpointId))) {
        boxes.push(endpointBox);
        cardIds.add(endpointId);
      }
    }
  }

  // Also include the relation message card itself if it is displayed as a card
  // (classify/summary classification card).  Its own box is not covered by the edge endpoints
  // above because relation edges use `anon:` as the source.
  if (relationCardMsgIds.has(relMsgId)) {
    const selfBox = params.boxFn ? (params.boxFn(relMsgId) ?? layout[relMsgId]) : layout[relMsgId];
    if (selfBox) {
      boxes.push(selfBox);
      cardIds.add(relMsgId);
    }
  }

  let rect = unionBoxes(boxes);
  if (!rect) return null;
  const relKind = relMsg?.relationType ? getRelKind(relMsg.relationType) : null;
  if (relMsg?.relationType === 'merge') {
    const headerTopPad = MERGE_CARD_H + FRAME_PAD + MERGE_CONTENT_TOP_GAP;
    rect = {
      x: rect.x - FRAME_PAD_X,
      y: rect.y - FRAME_PAD_Y - headerTopPad,
      width: rect.width + FRAME_PAD_X * 2,
      height: rect.height + FRAME_PAD_Y * 2 + headerTopPad,
    };
  } else if (relKind === 'arrange-frame' || relKind === 'frame-group' || relKind === 'replace-overlay') {
    rect = {
      x: rect.x - FRAME_PAD_X,
      y: rect.y - FRAME_PAD_Y,
      width: rect.width + FRAME_PAD_X * 2,
      height: rect.height + FRAME_PAD_Y * 2,
    };
  }
  return { rect, cardIds };
}
