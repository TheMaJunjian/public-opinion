import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DemoMessage, DemoEdge, UnitSelection, Selection, RelationType } from '../utils/modelBridge';
import { getPresentationSpec } from '../types';
import { computeCorrectedEdgeMap } from '../utils/modelBridge';
import type { PresentationKind } from '../types';
import { extractClassifyTopicTitle } from '../utils/classifyTopic';

// ========================= Layout types =========================

type LayoutBox = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };
type LabelBbox = { x: number; y: number; width: number; height: number };
type LabelSeed = { drawId: string; text: string; p0: Point; p1: Point; p2: Point };
type PositionedEdge = {
  drawId: string;
  edge: DemoEdge;
  fromAuthor: string;
  fromBox: LayoutBox;
  toBox: LayoutBox;
  fromCol: number;
  toCol: number;
  fragRectCanvas: DOMRect | null;
  edgeLabelText: string;
  expandedToEdgeId: string | null;
  labelX: number;
  labelY: number;
  start: Point;
  ctrl: Point;
  end: Point;
};

const CARD_W = 320;
const MIN_CARD_H = 86;
const GRID_LEFT = 18;
const GRID_TOP = 18;
const COL_GAP = 80;      // right-side decorations need ~58px (DEC_RIGHT_GAP=6 + DEC_W=56 + buffer)
const ROW_GAP = 32;
const CANVAS_BOTTOM_PAD = 120;
const CANVAS_RIGHT_PAD = 120; // extra right padding so decoration badges/frames never overflow the canvas
// Decoration constants — decorations are now on the RIGHT side of each card, stacked vertically
const DEC_W = 56;        // width of each decoration badge
const DEC_H = 22;        // height of each decoration badge
const DEC_GAP = 4;       // vertical gap between agree / disagree decorations
const DEC_RIGHT_GAP = 6; // horizontal gap between card right edge and decoration
const DEC_RIGHT_TOP = 4; // y offset from card top
const DEC_ICON_W = 20;   // clickable icon area width within a decoration badge
// TAG label constants
const TAG_H = 18;            // height of each tag label badge
const TAG_MIN_W = 36;        // minimum width
const TAG_V_GAP = 3;         // vertical gap between stacked tag labels
const TAG_RIGHT_GAP = 6;     // horizontal gap from card right edge
const TAG_MAX_LABEL_CHARS = 20; // max characters shown in a tag label badge
// SUPPLEMENT frame constants
const SUPP_FRAME_PAD = 12; // padding around the frame that wraps supplement pairs (wide enough to click)
const SUPP_FRAME_RADIUS = 8; // border-radius of supplement frame
const MAX_RELATION_NESTING_DEPTH = 10; // guard against infinite recursion when resolving nested relation visual boxes
const LABEL_BBOX_STABILITY_THRESHOLD = 0.5; // px — label bbox changes smaller than this are treated as stable
const MERGE_CANVAS_LABEL_H = 24;
const MERGE_CANVAS_LABEL_W = 56;
const MERGE_CANVAS_LABEL_LEFT_OFFSET = 10;
const MERGE_CANVAS_LABEL_TOP_OFFSET = 8;
const MERGE_CANVAS_STACK_GAP = ROW_GAP;

// Shared empty map to avoid allocating a new one on every render
const EMPTY_MAP: Map<string, string> = new Map();

// Group frame stroke colors by relColor value
const GROUP_FRAME_STROKE: Record<string,string> = {
  yellow: 'rgba(220,180,0,0.7)', amber: 'rgba(200,140,0,0.7)',
  gray: 'rgba(140,140,150,0.55)', slate: 'rgba(100,110,120,0.55)',
};

// Inline badge background colors by relColor value
const INLINE_BADGE_COLOR: Record<string,string> = {
  orange: 'rgba(200,90,0,0.9)',
  slate: 'rgba(80,90,100,0.9)',
};

/** True when a TAG edge's relationLabel carries actual user-entered label text (not the bare type name). */
function isValidTagLabel(label: string | undefined): label is string {
  return !!label && label !== 'tag';
}

function colX(col: number) {
  return GRID_LEFT + col * (CARD_W + COL_GAP);
}

function selKey(u: UnitSelection): string {
  const s = u.selection;
  if (s.kind === "whole") return `${u.messageId}::whole`;
  if (s.kind === "edge") return `${u.messageId}::edge:${s.edgeId}`;
  return `${u.messageId}::text:${s.start}:${s.len}:${s.text}`;
}

function unitEquals(a: UnitSelection, b: UnitSelection) {
  return selKey(a) === selKey(b);
}

export function selectionIsText(
  s: Selection
): s is { kind: "text"; start: number; len: number; text: string } {
  return s.kind === "text";
}

export function clearBrowserSelection() {
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
}

export function getRangeStartOffsetUTF16(container: HTMLElement, range: Range): number {
  const pre = range.cloneRange();
  pre.selectNodeContents(container);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

export function getSelectionFragment(
  container: HTMLElement
): { start: number; len: number; text: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return null;
  const common = range.commonAncestorContainer;
  if (!(common instanceof Node)) return null;
  if (!container.contains(common)) return null;
  const raw = sel.toString();
  if (raw.trim().length === 0) return null;
  const rawStart = getRangeStartOffsetUTF16(container, range);
  return { start: rawStart, len: raw.length, text: raw };
}

export function extractTextTargetsForMessage(messageId: string, edges: DemoEdge[]) {
  const res: { start: number; len: number; relationType: RelationType; edgeId: string }[] = [];
  for (const e of edges) {
    if (!(e.relationType === "annotation" || e.relationType === "reference")) continue;
    if (e.to.messageId !== messageId) continue;
    if (!selectionIsText(e.to.selection)) continue;
    res.push({ start: e.to.selection.start, len: e.to.selection.len, relationType: e.relationType, edgeId: e.id });
  }
  res.sort((a, b) => a.start - b.start || a.len - b.len || a.edgeId.localeCompare(b.edgeId));
  return res;
}

export function relationTypeName(t: RelationType | string): string {
  return getPresentationSpec(t).label;
}

// ========================= Annotation tree helpers =========================
// Supports nested annotations where a sub-fragment is annotated within an
// already-annotated parent fragment.  The tree is built from a flat list of
// annotation/reference targets sorted by start ASC then end DESC (outer first).

export type AnnoNode = {
  start: number;
  end: number;
  relationType: RelationType;
  edgeId: string;
  children: AnnoNode[];
};

/** Build a nesting tree from a flat list of annotation targets. */
export function buildAnnoTree(
  items: { start: number; end: number; relationType: RelationType; edgeId: string }[]
): AnnoNode[] {
  // Sort: start ascending, end descending (larger/outer intervals first at same start)
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);

  function consume(idx: number, boundEnd: number): { nodes: AnnoNode[]; nextIdx: number } {
    const nodes: AnnoNode[] = [];
    let i = idx;
    while (i < sorted.length) {
      const item = sorted[i];
      if (item.start >= boundEnd) break;
      const { nodes: children, nextIdx } = consume(i + 1, item.end);
      nodes.push({ start: item.start, end: item.end, relationType: item.relationType, edgeId: item.edgeId, children });
      i = nextIdx;
    }
    return { nodes, nextIdx: i };
  }

  return consume(0, Infinity).nodes;
}

/** Recursively render annotation tree nodes as React spans. */
export function renderAnnoNodes(
  text: string,
  nodes: AnnoNode[],
  from: number,
  to: number,
  depth: number,
  messageId: string,
  isFragSel: (id: string, start: number, len: number, text: string) => boolean,
  onFragClick: (id: string, start: number, len: number, text: string) => void,
): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  let cursor = from;
  for (const node of nodes) {
    if (node.start >= to) break;
    if (node.start > cursor) {
      result.push(<span key={`t-${cursor}`} style={{whiteSpace:"pre-wrap"}}>{text.slice(cursor, node.start)}</span>);
    }
    const len = node.end - node.start;
    const frag = text.slice(node.start, node.end);
    const isAnno = node.relationType === "annotation";
    const selected = isFragSel(messageId, node.start, len, frag);
    const isInner = depth > 0;
    const bgColor = selected
      ? "rgba(11,132,255,0.25)"
      : isInner
        ? (isAnno ? "rgba(255,220,0,0.30)" : "rgba(80,180,255,0.20)")
        : (isAnno ? "rgba(255,255,0,0.12)" : "rgba(80,180,255,0.08)");
    const outlineStyle = selected
      ? "2px solid rgba(11,132,255,0.95)"
      : isInner
        ? (isAnno ? "2px solid rgba(255,210,0,0.95)" : "2px solid rgba(80,180,255,0.85)")
        : (isAnno ? "1px solid rgba(255,255,0,0.8)" : "1px solid rgba(80,180,255,0.45)");
    const innerContent = node.children.length > 0
      ? renderAnnoNodes(text, node.children, node.start, node.end, depth + 1, messageId, isFragSel, onFragClick)
      : text.slice(node.start, node.end);
    result.push(
      <span key={`h-${node.start}-${node.end}`}
        data-rel-anchor={`${node.relationType}::${node.start}:${node.end}`}
        onClick={e => { e.stopPropagation(); onFragClick(messageId, node.start, len, frag); }}
        title="点击：进入文本选择状态并切换选中该片段"
        style={{whiteSpace:"pre-wrap",cursor:"pointer",position:"relative",zIndex:isInner?1:undefined,
          backgroundColor:bgColor,outline:outlineStyle,borderRadius:2}}
      >
        {innerContent}
      </span>
    );
    cursor = node.end;
  }
  if (cursor < to) {
    result.push(<span key={`t-${cursor}`} style={{whiteSpace:"pre-wrap"}}>{text.slice(cursor, to)}</span>);
  }
  return result;
}
// ===========================================================================

/** Get the PresentationKind for a relation type (handles lowercase bridge keys). */
function getRelKind(relType: string): PresentationKind {
  return getPresentationSpec(relType).kind;
}

/** True for relation types that use the supplement-frame kind specifically. */
function isSuppFrameRel(relType: string): boolean {
  return getRelKind(relType) === 'supplement-frame';
}

/** True for relation types that render as a frame (supplement-frame OR frame-group OR replace-overlay). */
function isAnyFrameRel(relType: string): boolean {
  const k = getRelKind(relType);
  return k === 'supplement-frame' || k === 'frame-group' || k === 'replace-overlay';
}

/** True for correction-badge relations (CORRECT): badge inside source card, same-column stacking. */
function isCorrectionBadgeRel(relType: string): boolean {
  return getRelKind(relType) === 'correction-badge';
}

type RelationBounds = { rect: LayoutBox; cardIds: Set<string> };
type MergeCanvasReservation = { relMsgId: string; rect: Rect; contentRect: Rect; headerRect: Rect; cardIds: Set<string> };

function unionBoxes(boxes: LayoutBox[]): LayoutBox | null {
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

function rectsOverlapX(a: Rect, b: Rect): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x);
}

function getRelationBoundsFromLayout(params: {
  relMsgId: string;
  edgesByRelMsg: Map<string, DemoEdge[]>;
  layout: Record<string, LayoutBox>;
  msgMap: Map<string, DemoMessage>;
  classifyRelMsgIds: Set<string>;
  visited?: Set<string>;
}): RelationBounds | null {
  const { relMsgId, edgesByRelMsg, layout, msgMap, classifyRelMsgIds } = params;
  const visited = params.visited ?? new Set<string>();
  if (visited.has(relMsgId)) return null;
  visited.add(relMsgId);

  const directBox = layout[relMsgId];
  if (directBox && classifyRelMsgIds.has(relMsgId)) {
    return { rect: directBox, cardIds: new Set([relMsgId]) };
  }

  const relEdges = edgesByRelMsg.get(relMsgId) ?? [];
  const boxes: LayoutBox[] = [];
  const cardIds = new Set<string>();
  for (const edge of relEdges) {
    for (const endpointId of [edge.from.messageId, edge.to.messageId]) {
      if (endpointId.startsWith("anon:")) continue;
      const endpointMsg = msgMap.get(endpointId);
      const endpointBox = layout[endpointId];
      if (endpointBox && (endpointMsg?.kind === "normal" || classifyRelMsgIds.has(endpointId))) {
        boxes.push(endpointBox);
        cardIds.add(endpointId);
        continue;
      }
      if (endpointMsg?.kind === "relation") {
        const nested = getRelationBoundsFromLayout({ relMsgId: endpointId, edgesByRelMsg, layout, msgMap, classifyRelMsgIds, visited });
        if (!nested) continue;
        boxes.push(nested.rect);
        nested.cardIds.forEach(id => cardIds.add(id));
      }
    }
  }

  const rect = unionBoxes(boxes);
  return rect ? { rect, cardIds } : null;
}

export function buildMergeCanvasReservations(params: {
  edges: DemoEdge[];
  layout: Record<string, LayoutBox>;
  msgMap: Map<string, DemoMessage>;
  classifyRelMsgIds: Set<string>;
}): MergeCanvasReservation[] {
  const { edges, layout, msgMap, classifyRelMsgIds } = params;
  const edgesByRelMsg = new Map<string, DemoEdge[]>();
  for (const edge of edges) {
    const arr = edgesByRelMsg.get(edge.relationMessageId) ?? [];
    arr.push(edge);
    edgesByRelMsg.set(edge.relationMessageId, arr);
  }

  const reservations: MergeCanvasReservation[] = [];
  for (const [relMsgId, relEdges] of edgesByRelMsg) {
    if (relEdges[0]?.relationType !== "merge") continue;
    const boxes: LayoutBox[] = [];
    const cardIds = new Set<string>();
    for (const edge of relEdges) {
      const targetMsg = msgMap.get(edge.to.messageId);
      const targetBox = layout[edge.to.messageId];
      if (targetBox && (targetMsg?.kind === "normal" || classifyRelMsgIds.has(edge.to.messageId))) {
        boxes.push(targetBox);
        cardIds.add(edge.to.messageId);
        continue;
      }
      if (targetMsg?.kind === "relation") {
        const nested = getRelationBoundsFromLayout({ relMsgId: edge.to.messageId, edgesByRelMsg, layout, msgMap, classifyRelMsgIds });
        if (!nested) continue;
        boxes.push(nested.rect);
        nested.cardIds.forEach(id => cardIds.add(id));
      }
    }
    const contentUnion = unionBoxes(boxes);
    if (!contentUnion) continue;
    const contentRect = {
      x: contentUnion.x - SUPP_FRAME_PAD,
      y: contentUnion.y - SUPP_FRAME_PAD,
      width: contentUnion.width + SUPP_FRAME_PAD * 2,
      height: contentUnion.height + SUPP_FRAME_PAD * 2,
    };
    const headerRect = {
      x: contentRect.x + MERGE_CANVAS_LABEL_LEFT_OFFSET,
      y: contentRect.y - MERGE_CANVAS_LABEL_TOP_OFFSET,
      width: MERGE_CANVAS_LABEL_W,
      height: MERGE_CANVAS_LABEL_H,
    };
    reservations.push({
      relMsgId,
      contentRect,
      headerRect,
      rect: {
        x: contentRect.x,
        y: headerRect.y,
        width: contentRect.width,
        height: contentRect.y + contentRect.height - headerRect.y,
      },
      cardIds,
    });
  }
  reservations.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  return reservations;
}

export function applyMergeCanvasReservations(params: {
  layout: Record<string, LayoutBox>;
  normals: DemoMessage[];
  colOf: Record<string, number>;
  reservations: MergeCanvasReservation[];
}) {
  const nextLayout: Record<string, LayoutBox> = {};
  for (const [id, box] of Object.entries(params.layout)) nextLayout[id] = { ...box };

  const byCol = new Map<number, string[]>();
  for (const msg of params.normals) {
    const col = params.colOf[msg.id] ?? 0;
    const arr = byCol.get(col) ?? [];
    arr.push(msg.id);
    byCol.set(col, arr);
  }
  for (const ids of byCol.values()) ids.sort((a, b) => (nextLayout[a]?.y ?? 0) - (nextLayout[b]?.y ?? 0));

  for (const reservation of params.reservations) {
    for (const ids of byCol.values()) {
      let cursor = reservation.rect.y + reservation.rect.height + MERGE_CANVAS_STACK_GAP;
      for (const id of ids) {
        const box = nextLayout[id];
        if (!box || reservation.cardIds.has(id)) continue;
        if (!rectsOverlapX(box, reservation.rect)) continue;
        if (box.y + box.height <= reservation.rect.y) continue;
        if (box.y >= cursor) {
          cursor = box.y + box.height + ROW_GAP;
          continue;
        }
        nextLayout[id] = { ...box, y: cursor };
        cursor = nextLayout[id].y + nextLayout[id].height + ROW_GAP;
      }
    }
  }

  let maxBottom = GRID_TOP;
  for (const box of Object.values(nextLayout)) maxBottom = Math.max(maxBottom, box.y + box.height);
  for (const reservation of params.reservations) maxBottom = Math.max(maxBottom, reservation.rect.y + reservation.rect.height);
  return { layout: nextLayout, canvasHeight: maxBottom + CANVAS_BOTTOM_PAD };
}

function computeMinColumnsForAnnoRefRule1(normalIds: string[], edges: DemoEdge[], relIds: Set<string>) {
  const normalSet = new Set(normalIds);
  const relevant = edges.filter(
    (e) => (e.relationType === "annotation" || e.relationType === "reference") &&
      normalSet.has(e.from.messageId) && normalSet.has(e.to.messageId)
  );
  // anno/ref edges where source is a normal message but target is a relation message
  // Rule: source must be in a column to the right of the relation's rightmost normal endpoint.
  const toRelEdges = edges.filter(
    (e) => (e.relationType === "annotation" || e.relationType === "reference") &&
      normalSet.has(e.from.messageId) && relIds.has(e.to.messageId)
  );
  // Pre-build relEdgesByRelMsg for relation-message endpoint lookup
  const relEdgesByRelMsg = new Map<string, DemoEdge[]>();
  for (const e of edges) {
    const arr = relEdgesByRelMsg.get(e.relationMessageId) ?? [];
    arr.push(e);
    relEdgesByRelMsg.set(e.relationMessageId, arr);
  }
  const col: Record<string, number> = {};
  for (const id of normalIds) col[id] = 0;
  let changed = true, iter = 0;
  while (changed && iter < 5000) {
    iter++; changed = false;
    for (const e of relevant) {
      const need = (col[e.to.messageId] ?? 0) + 1;
      if ((col[e.from.messageId] ?? 0) < need) { col[e.from.messageId] = need; changed = true; }
    }
    // Constraint: anno/ref source targeting a relation message must be to the right of the
    // relation's rightmost normal-message endpoint column.
    for (const e of toRelEdges) {
      const targetRelEdges = relEdgesByRelMsg.get(e.to.messageId) ?? [];
      let maxEndpointCol = -1;
      for (const te of targetRelEdges) {
        if (normalSet.has(te.from.messageId)) maxEndpointCol = Math.max(maxEndpointCol, col[te.from.messageId] ?? 0);
        if (normalSet.has(te.to.messageId)) maxEndpointCol = Math.max(maxEndpointCol, col[te.to.messageId] ?? 0);
      }
      if (maxEndpointCol < 0) continue;
      const need = maxEndpointCol + 1;
      if ((col[e.from.messageId] ?? 0) < need) { col[e.from.messageId] = need; changed = true; }
    }
  }
  if (iter >= 5000) { console.warn("Anno/Ref cycle; fallback."); for (const id of normalIds) col[id] = 0; }
  const targetsByFrom = new Map<string, string[]>();
  for (const e of relevant) {
    const arr = targetsByFrom.get(e.from.messageId) ?? [];
    arr.push(e.to.messageId);
    targetsByFrom.set(e.from.messageId, arr);
  }
  // For anno/ref-to-relation edges, add the relation's normal endpoints as effective targets
  for (const e of toRelEdges) {
    const arr = targetsByFrom.get(e.from.messageId) ?? [];
    targetsByFrom.set(e.from.messageId, arr);
    const targetRelEdges = relEdgesByRelMsg.get(e.to.messageId) ?? [];
    for (const te of targetRelEdges) {
      if (normalSet.has(te.from.messageId) && !arr.includes(te.from.messageId)) arr.push(te.from.messageId);
      if (normalSet.has(te.to.messageId) && !arr.includes(te.to.messageId)) arr.push(te.to.messageId);
    }
  }
  for (const [fromId, toArr] of targetsByFrom) {
    let maxTarget = -Infinity;
    for (const t of toArr) maxTarget = Math.max(maxTarget, col[t] ?? 0);
    const need = maxTarget === -Infinity ? 0 : maxTarget + 1;
    if ((col[fromId] ?? 0) < need) col[fromId] = need;
  }
  const minCol = Math.min(...Object.values(col));
  if (minCol !== 0) for (const id of normalIds) col[id] -= minCol;
  return { col, maxCol: Math.max(...Object.values(col)) };
}

function applyReplyLayoutAdjustmentsWithConstraints(params: {
  normals: DemoMessage[]; edges: DemoEdge[]; baseCol: Record<string, number>; baseMaxCol: number; relIds: Set<string>;
}) {
  const { normals, edges, baseCol, baseMaxCol, relIds } = params;
  const col: Record<string, number> = { ...baseCol };
  let maxCol = baseMaxCol;
  const normalSet = new Set(normals.map(m => m.id));
  const msgById = new Map(normals.map(m => [m.id, m]));
  const minAllowed: Record<string, number> = {};
  for (const m of normals) minAllowed[m.id] = baseCol[m.id] ?? 0;
  // Pre-build relEdgesByRelMsg for relation-message endpoint lookup (used for reply-to-relation column constraints)
  const relEdgesByRelMsgForReply = new Map<string, DemoEdge[]>();
  for (const e of edges) {
    const arr = relEdgesByRelMsgForReply.get(e.relationMessageId) ?? [];
    arr.push(e);
    relEdgesByRelMsgForReply.set(e.relationMessageId, arr);
  }
  for (const e of edges) {
    if (!(e.relationType === "annotation" || e.relationType === "reference")) continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    const need = (col[e.to.messageId] ?? 0) + 1;
    minAllowed[e.from.messageId] = Math.max(minAllowed[e.from.messageId] ?? 0, need);
  }
  // Constraint for reply edges targeting relation messages: source must be to the right of
  // the relation's rightmost normal-message endpoint column.
  for (const e of edges) {
    if (e.relationType !== "reply") continue;
    if (!normalSet.has(e.from.messageId)) continue;
    if (!relIds.has(e.to.messageId)) continue;
    const targetRelEdges = relEdgesByRelMsgForReply.get(e.to.messageId) ?? [];
    for (const te of targetRelEdges) {
      if (normalSet.has(te.from.messageId)) {
        const need = (col[te.from.messageId] ?? 0) + 1;
        minAllowed[e.from.messageId] = Math.max(minAllowed[e.from.messageId] ?? 0, need);
      }
      if (normalSet.has(te.to.messageId)) {
        const need = (col[te.to.messageId] ?? 0) + 1;
        minAllowed[e.from.messageId] = Math.max(minAllowed[e.from.messageId] ?? 0, need);
      }
    }
  }
  const replyTargetsByFrom = new Map<string, string[]>();
  for (const e of edges.filter(e => e.relationType === "reply")) {
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    if (!replyTargetsByFrom.has(e.from.messageId)) replyTargetsByFrom.set(e.from.messageId, []);
    replyTargetsByFrom.get(e.from.messageId)!.push(e.to.messageId);
  }
  function mode(nums: number[]) {
    const cnt = new Map<number, number>();
    for (const n of nums) cnt.set(n, (cnt.get(n) ?? 0) + 1);
    let best = nums[0] ?? 0, bestC = -1;
    for (const [k, c] of cnt) if (c > bestC || (c === bestC && k < best)) { best = k; bestC = c; }
    return best;
  }
  const byAuthor = new Map<string, number[]>();
  for (const m of normals) {
    const arr = byAuthor.get(m.author) ?? [];
    arr.push(baseCol[m.id] ?? 0);
    byAuthor.set(m.author, arr);
  }
  const authorAnchor: Record<string, number> = {};
  for (const [author, colsArr] of byAuthor) authorAnchor[author] = mode(colsArr);
  const authorPrevLane: Record<string, number | null> = {};
  for (const a of Object.keys(authorAnchor)) authorPrevLane[a] = null;
  const replyFromIds = Array.from(replyTargetsByFrom.keys());
  replyFromIds.sort((a, b) => {
    const ta = new Date(msgById.get(a)?.createdAt ?? 0).getTime();
    const tb = new Date(msgById.get(b)?.createdAt ?? 0).getTime();
    return ta !== tb ? ta - tb : a.localeCompare(b);
  });
  function better(a: any, b: any) {
    if (!b) return true; if (!a) return false;
    for (const k of ["incMax","maxDist","sumDist","inLane","stable","c"]) {
      if (a[k] < b[k]) return true; if (a[k] > b[k]) return false;
    }
    return false;
  }
  for (const fromId of replyFromIds) {
    const fromMsg = msgById.get(fromId); if (!fromMsg) continue;
    const targets = replyTargetsByFrom.get(fromId) ?? [];
    const targetCols = targets.filter(t => normalSet.has(t)).map(t => col[t] ?? baseCol[t] ?? 0);
    const forbidden = new Set<number>(targetCols);
    const baseMin = minAllowed[fromId] ?? baseCol[fromId] ?? 0;
    const anchor = authorAnchor[fromMsg.author] ?? baseMin;
    const prevLane = authorPrevLane[fromMsg.author] ?? null;
    const candidates: number[] = [];
    if (prevLane !== null) candidates.push(Math.max(baseMin, prevLane));
    candidates.push(Math.max(baseMin, anchor), Math.max(baseMin, anchor + 1));
    if (targetCols.length > 0) {
      const med = [...targetCols].sort((a,b)=>a-b)[Math.floor(targetCols.length/2)];
      candidates.push(Math.max(baseMin,med), Math.max(baseMin,med+1), Math.max(baseMin,med-1));
    }
    for (let d = 0; d <= 6; d++) candidates.push(Math.max(baseMin,anchor-d), Math.max(baseMin,anchor+d), baseMin+d);
    const uniq: number[] = [];
    const seen = new Set<number>();
    for (const c0 of candidates) { const c = Math.max(baseMin,c0); if (!seen.has(c)) { seen.add(c); uniq.push(c); } }
    const scoreCandidate = (c: number) => {
      if (c < baseMin || forbidden.has(c)) return null;
      const maxDist = targetCols.length === 0 ? 0 : Math.max(...targetCols.map(a => Math.abs(c-a)));
      const sumDist = targetCols.reduce((s,t) => s+Math.abs(c-t), 0);
      const inLane = (c===anchor||c===anchor+1) ? 0 : 1;
      const stable = (prevLane!==null && c===prevLane) ? 0 : 1;
      const incMax = c > maxCol ? c-maxCol : 0;
      return { incMax, maxDist, sumDist, inLane, stable, c };
    };
    let bestScore: any = null, bestC: number | null = null;
    for (const c of uniq) { const sc = scoreCandidate(c); if (sc && better(sc, bestScore)) { bestScore = sc; bestC = c; } }
    if (bestC === null) { let c = Math.max(baseMin, maxCol+1); while (forbidden.has(c)) c++; bestC = c; }
    col[fromId] = bestC; maxCol = Math.max(maxCol, bestC); authorPrevLane[fromMsg.author] = bestC;
  }
  return { col, maxCol };
}

/**
 * High-priority grouping column rule.
 *
 * Applies to ALL relation types with `groupsTargets=true` (supplement-frame, frame-group)
 * and to replace-overlay types that also group targets (SUMMARY).
 * For CORRECT (correction-badge), only the source→target pair is handled (no frame).
 *
 * Rules:
 *   - Source message (if real, not anon:) → same column as its first target.
 *   - No-source framing relations with multiple targets → all targets chained into the same column.
 *   - All framing-type relations (supplement-frame, frame-group, replace-overlay) participate.
 *   - correction-badge (CORRECT) also uses same-column stacking without a frame.
 */
function applyGroupingColumnOverride(params: {
  normals: DemoMessage[];
  edges: DemoEdge[];
  col: Record<string, number>;
  maxCol: number;
}): { col: Record<string, number>; maxCol: number; groupSourceToTarget: Map<string, string> } {
  const { normals, edges } = params;
  const col = { ...params.col };
  const normalSet = new Set(normals.map(m => m.id));
  const msgById = new Map(normals.map(m => [m.id, m]));

  // groupSourceToTarget: maps a "child" message to the message it should be stacked below.
  // For supplement/correct: source message → target message.
  // For frame-group / no-source framing: target[i] → target[i-1] (chain).
  const groupSourceToTarget = new Map<string, string>();
  for (const e of edges) {
    if (!isAnyFrameRel(e.relationType) && !isCorrectionBadgeRel(e.relationType)) continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    // Source message gets stacked below its first target.
    if (!groupSourceToTarget.has(e.from.messageId)) {
      groupSourceToTarget.set(e.from.messageId, e.to.messageId);
    }
  }

  // For ALL framing / correction-badge relations (regardless of whether the source is anon:
  // or a real message), collect all *target* message IDs per relation message and chain
  // them together so that multiple targets within the same relation are placed in the same
  // column and stacked tightly (zero gap).  This also covers the previously-anon-only case
  // where an explicit-source supplement has more than one target: those targets now also get
  // chained, so they are stacked below the first target together with the source message.
  const frameTargetsByRelMsg = new Map<string, string[]>();
  for (const e of edges) {
    if (!isAnyFrameRel(e.relationType) && !isCorrectionBadgeRel(e.relationType)) continue;
    if (!normalSet.has(e.to.messageId)) continue;
    const arr = frameTargetsByRelMsg.get(e.relationMessageId) ?? [];
    arr.push(e.to.messageId);
    frameTargetsByRelMsg.set(e.relationMessageId, arr);
  }
  for (const [, targetIds] of frameTargetsByRelMsg) {
    if (targetIds.length < 2) continue;
    // Sort by creation time for deterministic, chronological ordering.
    targetIds.sort((a, b) =>
      new Date(msgById.get(a)?.createdAt ?? Number.MAX_SAFE_INTEGER).getTime() -
      new Date(msgById.get(b)?.createdAt ?? Number.MAX_SAFE_INTEGER).getTime()
    );
    // Chain: each subsequent target is "stacked below" the previous one.
    for (let i = 1; i < targetIds.length; i++) {
      if (!groupSourceToTarget.has(targetIds[i])) {
        groupSourceToTarget.set(targetIds[i], targetIds[i - 1]);
      }
    }
  }

  // Propagate columns: each chained message gets the same column as its anchor.
  let changed = true, iter = 0;
  while (changed && iter < 1000) {
    changed = false; iter++;
    for (const [srcId, tgtId] of groupSourceToTarget) {
      const tgtCol = col[tgtId] ?? 0;
      if ((col[srcId] ?? 0) !== tgtCol) { col[srcId] = tgtCol; changed = true; }
    }
  }

  const maxCol = Math.max(0, ...(Object.values(col).length ? Object.values(col) : [0]));
  return { col, maxCol, groupSourceToTarget };
}

/**
 * Apply AGREE/DISAGREE layout column rules:
 *   AGREE source → same column as target (visual alignment = "I agree with this")
 *   DISAGREE source → one column to the right of target (visually contrasted)
 *
 * Only applies when both source and target are normal (text) messages.
 * Pure-stance (anon: source) or relation-message targets are skipped.
 *
 * Annotation/reference column constraints are respected: if a message is also an
 * annotation/reference source it will not be placed to the left of its anno/ref targets.
 */
function applyAgreeDisagreeColumnOverride(params: {
  normals: DemoMessage[];
  edges: DemoEdge[];
  col: Record<string, number>;
  maxCol: number;
}): { col: Record<string, number>; maxCol: number } {
  const { normals, edges } = params;
  const col = { ...params.col };
  let maxCol = params.maxCol;
  const normalSet = new Set(normals.map(m => m.id));

  // Pre-compute the minimum column each message must occupy due to annotation/reference
  // constraints (annotation/reference source must be in the column to the RIGHT of its target).
  // These minimums are computed from the incoming column values, which already satisfy the
  // annotation/reference constraint, so targets won't move and these bounds stay valid.
  // annoRefMinCol[id] = minimum column index that message `id` must be assigned to,
  // derived from annotation/reference edges where `id` is the source.
  const annoRefMinCol: Record<string, number> = {};
  for (const e of edges) {
    if (e.relationType !== "annotation" && e.relationType !== "reference") continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    const need = (col[e.to.messageId] ?? 0) + 1;
    annoRefMinCol[e.from.messageId] = Math.max(annoRefMinCol[e.from.messageId] ?? 0, need);
  }

  // Only process stance-type edges between two normal (text) messages
  const stanceEdges = edges.filter(e => e.relationType === "agree" || e.relationType === "disagree");

  for (const e of stanceEdges) {
    const fromId = e.from.messageId, toId = e.to.messageId;
    // Skip pure-stance (anon: source) and relation-message targets
    if (!normalSet.has(fromId) || !normalSet.has(toId)) continue;
    const tgtCol = col[toId] ?? 0;
    const desired = e.relationType === "agree" ? tgtCol : tgtCol + 1;
    // Enforce annotation/reference minimum: agree/disagree cannot place a source message
    // to the left of any message it annotates or references.
    col[fromId] = Math.max(desired, annoRefMinCol[fromId] ?? 0);
    maxCol = Math.max(maxCol, col[fromId]);
  }

  return { col, maxCol };
}

function computeNoOverlapLayout(params: {
  normals: DemoMessage[]; colOf: Record<string, number>; measuredHeights: Record<string, number>; maxCol: number;
  groupSourceToTarget?: Map<string, string>;
  correctedTargetIds?: Set<string>;
}) {
  const { normals, colOf, measuredHeights, maxCol } = params;
  const correctedTargetIds = params.correctedTargetIds ?? new Set<string>();
  const groupSourceToTarget = params.groupSourceToTarget ?? EMPTY_MAP;

  // Build reverse map: target → list of grouped children (supplement sources, frame-group members, etc.)
  const groupTargetToChildren = new Map<string, string[]>();
  for (const [srcId, tgtId] of groupSourceToTarget) {
    const arr = groupTargetToChildren.get(tgtId) ?? [];
    arr.push(srcId);
    groupTargetToChildren.set(tgtId, arr);
  }

  const byCol = new Map<number, DemoMessage[]>();
  for (const m of normals) {
    const c = colOf[m.id] ?? 0;
    const arr = byCol.get(c) ?? [];
    arr.push(m);
    byCol.set(c, arr);
  }

  // Grouped children in the same column as their anchor are NOT "root" messages
  const groupChildIds = new Set(groupSourceToTarget.keys());

  const colCursor: Record<number, number> = {};
  for (let c = 0; c <= maxCol; c++) colCursor[c] = GRID_TOP;
  const layout: Record<string, LayoutBox> = {};
  let maxBottom = GRID_TOP;

  // Recursively place a message then its grouped children (with zero gap)
  function placeGroup(msg: DemoMessage, c: number, gapBefore: number, visited: Set<string>) {
    if (visited.has(msg.id)) return;
    visited.add(msg.id);
    colCursor[c] += gapBefore;
    // Corrected targets are invisible placeholders with zero height; the correction source
    // is then placed at the same y-coordinate, effectively replacing the target card.
    const h = correctedTargetIds.has(msg.id) ? 0 : Math.max(MIN_CARD_H, measuredHeights[msg.id] ?? MIN_CARD_H);
    layout[msg.id] = { x: colX(c), y: colCursor[c], width: CARD_W, height: h };
    maxBottom = Math.max(maxBottom, colCursor[c] + h);
    colCursor[c] += h;
    // Place grouped children directly below with zero gap
    const colMsgs = byCol.get(c) ?? [];
    const children = (groupTargetToChildren.get(msg.id) ?? []).filter(s => (colOf[s] ?? 0) === c);
    children.sort((a, b) => {
      const ma = colMsgs.find(m => m.id === a), mb = colMsgs.find(m => m.id === b);
      return new Date(ma?.createdAt ?? 0).getTime() - new Date(mb?.createdAt ?? 0).getTime();
    });
    for (const childId of children) {
      const childMsg = colMsgs.find(m => m.id === childId);
      if (childMsg) placeGroup(childMsg, c, 0, visited);
    }
  }

  for (let c = 0; c <= maxCol; c++) {
    const colMsgs = byCol.get(c) ?? [];
    // Root messages: not grouped children that have their anchor in the same column
    const roots = colMsgs.filter(m => {
      if (!groupChildIds.has(m.id)) return true;
      const tgtId = groupSourceToTarget.get(m.id)!;
      return (colOf[tgtId] ?? 0) !== c; // anchor in different col → treat as root
    });
    roots.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const visited = new Set<string>();
    for (let i = 0; i < roots.length; i++) {
      placeGroup(roots[i], c, i === 0 ? 0 : ROW_GAP, visited);
    }
  }
  return { layout, canvasHeight: maxBottom + CANVAS_BOTTOM_PAD };
}

function quadAt(p0: Point, p1: Point, p2: Point, t: number): Point {
  const u = 1-t;
  return { x: u*u*p0.x+2*u*t*p1.x+t*t*p2.x, y: u*u*p0.y+2*u*t*p1.y+t*t*p2.y };
}

function rayRectIntersectionFirst(ox: number, oy: number, dx: number, dy: number, box: Rect, eps=1e-9): Point | null {
  const cands: {t:number;x:number;y:number}[] = [];
  if (Math.abs(dx) > eps) {
    const tx1=(box.x-ox)/dx, yx1=oy+tx1*dy;
    if (tx1>eps && yx1>=box.y-1e-6 && yx1<=box.y+box.height+1e-6) cands.push({t:tx1,x:box.x,y:yx1});
    const tx2=(box.x+box.width-ox)/dx, yx2=oy+tx2*dy;
    if (tx2>eps && yx2>=box.y-1e-6 && yx2<=box.y+box.height+1e-6) cands.push({t:tx2,x:box.x+box.width,y:yx2});
  }
  if (Math.abs(dy) > eps) {
    const ty1=(box.y-oy)/dy, xt1=ox+ty1*dx;
    if (ty1>eps && xt1>=box.x-1e-6 && xt1<=box.x+box.width+1e-6) cands.push({t:ty1,x:xt1,y:box.y});
    const ty2=(box.y+box.height-oy)/dy, xt2=ox+ty2*dx;
    if (ty2>eps && xt2>=box.x-1e-6 && xt2<=box.x+box.width+1e-6) cands.push({t:ty2,x:xt2,y:box.y+box.height});
  }
  if (!cands.length) return null;
  cands.sort((a,b)=>a.t-b.t);
  return {x:cands[0].x, y:cands[0].y};
}

function samplePerimeterCandidates(box: Rect): Point[] {
  const res: Point[] = [];
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const t = i/n;
    res.push({x:box.x+box.width*t,y:box.y},{x:box.x+box.width,y:box.y+box.height*t},
      {x:box.x+box.width*(1-t),y:box.y+box.height},{x:box.x,y:box.y+box.height*(1-t)});
  }
  res.push({x:box.x,y:box.y},{x:box.x+box.width,y:box.y},{x:box.x+box.width,y:box.y+box.height},{x:box.x,y:box.y+box.height});
  return res;
}

function rectsIntersect(a: Rect, b: Rect) {
  return !(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y);
}

function labelRectApprox(x: number, y: number, text: string) {
  const w = Math.max(30, text.length * 6.2) + 10, h = 14;
  return { x:x-w/2, y:y-h/2, width:w, height:h };
}

function computeLabelPlacementsAlongCurve(params: { seeds: LabelSeed[]; forbiddenRects: Rect[] }) {
  const { seeds, forbiddenRects } = params;
  const sorted = [...seeds].sort((a,b) => {
    const pa=quadAt(a.p0,a.p1,a.p2,0.5), pb=quadAt(b.p0,b.p1,b.p2,0.5);
    return pa.y-pb.y || pa.x-pb.x || a.drawId.localeCompare(b.drawId);
  });
  const placements: Record<string, {x:number;y:number}> = {};
  const placed: Rect[] = [];
  const ts = [0.35,0.42,0.5,0.58,0.65,0.28,0.72,0.2,0.8];
  for (const s of sorted) {
    let chosen: {x:number;y:number}|null = null;
    for (const t of ts) {
      const p=quadAt(s.p0,s.p1,s.p2,t), r=labelRectApprox(p.x,p.y,s.text);
      let ok=true;
      for (const tr of [...forbiddenRects,...placed]) if (rectsIntersect(r,tr)) { ok=false; break; }
      if (ok) { chosen={x:p.x,y:p.y}; placed.push(r); break; }
    }
    if (!chosen) {
      const p=quadAt(s.p0,s.p1,s.p2,0.5); let x=p.x,y=p.y, r=labelRectApprox(x,y,s.text);
      for (let iter=0;iter<200;iter++) {
        let collision=false;
        for (const tr of [...forbiddenRects,...placed]) if (rectsIntersect(r,tr)) { collision=true; break; }
        if (!collision) break;
        y=p.y+Math.ceil(iter/2)*16*(iter%2===0?1:-1); r=labelRectApprox(x,y,s.text);
      }
      chosen={x,y}; placed.push(r);
    }
    placements[s.drawId]=chosen;
  }
  return placements;
}

export interface GraphViewProps {
  messages: DemoMessage[];
  edges: DemoEdge[];
  draftUnits: UnitSelection[];
  activeTextSelectId: string | null;
  lastClickedMessageId: string | null;
  voteStats: Record<string,{agreeCount:number;disagreeCount:number;agreeKey:string;disagreeKey:string}>;
  onMessageClick: (e: React.MouseEvent, messageId: string) => void;
  onMessageDoubleClick: (e: React.MouseEvent, messageId: string) => void;
  onTextMouseUp: (e: React.MouseEvent, messageId: string) => void;
  onEdgeLabelSingleClick: (e: React.MouseEvent, relationMessageId: string, edgeId: string) => void;
  onEdgeLabelDoubleClick: (e: React.MouseEvent, relationMessageId: string) => void;
  onFragmentAnchorClick: (messageId: string, start: number, len: number, text: string) => void;
  isFragmentSelected: (messageId: string, start: number, len: number, text: string) => boolean;
  onCanvasBlankClick?: () => void;
  onMessageMouseDown?: (e: React.MouseEvent, messageId: string) => void;
  onMessageMouseUp?: (e: React.MouseEvent, messageId: string) => void;
  /** Click on the icon area of a decoration badge — quick send empty agree/disagree */
  onDecorationIconClick?: (messageId: string, kind: "agree" | "disagree") => void;
  /** Click on the body (non-icon area) of a decoration badge — toggles selection */
  onDecorationBodyClick?: (e: React.MouseEvent, messageId: string, kind: "agree" | "disagree") => void;
  /** Double-click on a decoration badge — shows sender info popup */
  onDecorationDoubleClick?: (e: React.MouseEvent, messageId: string, kind: "agree" | "disagree") => void;
  /** Click on an aggregated tag badge — toggles selection of all relation messages in the group */
  onTagBodyClick?: (e: React.MouseEvent, messageId: string, tagLabel: string, relMsgIds: string[]) => void;
  /** Double-click on a tag badge — shows details popup */
  onTagDoubleClick?: (e: React.MouseEvent, messageId: string, tagLabel: string, relMsgIds: string[]) => void;
  /**
   * Single-click on a group frame border (frame-group: CLASSIFY/MERGE) — selects the relation
   * or opens "add message to group" UI.  Falls back to onMessageClick if not provided.
   */
  onGroupFrameClick?: (e: React.MouseEvent, relMsgId: string) => void;
  /**
   * Double-click on a group frame border (frame-group: CLASSIFY/MERGE) — expands the topic view
   * for this group, or shows group details.  Falls back to onMessageDoubleClick if not provided.
   */
  onGroupFrameDoubleClick?: (e: React.MouseEvent, relMsgId: string) => void;
  /**
   * Single-click on an inline badge (RECOMMEND / ARCHIVE) — selects the relation message.
   * Falls back to onMessageClick if not provided.
   */
  onInlineBadgeClick?: (e: React.MouseEvent, relMsgId: string) => void;
  /**
   * Double-click on an inline badge (RECOMMEND / ARCHIVE) — shows operation details
   * (who operated, when, etc.).  Falls back to onMessageDoubleClick if not provided.
   */
  onInlineBadgeDoubleClick?: (e: React.MouseEvent, relMsgId: string) => void;
  /** Optional message IDs to hide from card rendering while keeping layout/frame computation. */
  hideMessageIds?: Set<string>;
}

export default function GraphView(props: GraphViewProps) {
  const {
    messages, edges, draftUnits, activeTextSelectId, lastClickedMessageId,
    onMessageClick, onMessageDoubleClick, onTextMouseUp,
    onEdgeLabelSingleClick, onEdgeLabelDoubleClick,
    onFragmentAnchorClick, isFragmentSelected, onCanvasBlankClick,
    onMessageMouseDown, onMessageMouseUp,
    onDecorationIconClick, onDecorationBodyClick, onDecorationDoubleClick,
    onTagBodyClick, onTagDoubleClick,
    onGroupFrameClick, onGroupFrameDoubleClick,
    onInlineBadgeClick, onInlineBadgeDoubleClick,
    hideMessageIds,
    // voteStats is accepted for API compatibility but decoration counts are derived internally from edges
  } = props;

  const canvasRef = useRef<HTMLDivElement|null>(null);
  const cardRefs = useRef<Record<string,HTMLDivElement|null>>({});
  const contentRefs = useRef<Record<string,HTMLDivElement|null>>({});
  const headerRefs = useRef<Record<string,HTMLDivElement|null>>({});
  const textRefs = useRef<Record<string,SVGTextElement|null>>({});

  const msgMap = useMemo(() => new Map(messages.map(m => [m.id,m])), [messages]);
  // Per-edge corrected index: map from old relation-message ID → set of edge IDs that are
  // individually corrected (have a replacement edge in the new relation).
  // Used for fragment-level correction: only the matched fragments are hidden.
  const correctedEdgeIdsByRelMsg = useMemo(() => computeCorrectedEdgeMap(edges), [edges]);
  // TAG-only source messages: normal messages used exclusively as TAG relation sources.
  // They should not appear as graph cards — their label text is accessible via e.relationLabel.
  const tagSourceIds = useMemo(() => {
    const isTagSource = new Set<string>();
    const shouldKeepVisible = new Set<string>();
    for (const e of edges) {
      if (e.relationType === "tag" && msgMap.get(e.from.messageId)?.kind === "normal") {
        isTagSource.add(e.from.messageId);
      }
      // Keep visible: any message targeted by a relation, or source of a non-TAG relation
      if (msgMap.get(e.to.messageId)?.kind === "normal") shouldKeepVisible.add(e.to.messageId);
      if (e.relationType !== "tag" && msgMap.get(e.from.messageId)?.kind === "normal") {
        shouldKeepVisible.add(e.from.messageId);
      }
    }
    for (const id of shouldKeepVisible) isTagSource.delete(id);
    return isTagSource;
  }, [edges, msgMap]);
  // CLASSIFY relation messages are displayed as topic cards on the main canvas (not as SVG frames),
  // so they participate in the normals layout like regular text messages.
  const classifyRelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of messages) {
      if (m.kind === "relation" && m.relationType === "classify") ids.add(m.id);
    }
    for (const e of edges) {
      if (e.relationType === 'classify') ids.add(e.relationMessageId);
    }
    return ids;
  }, [edges, messages]);
  const normals = useMemo(() => messages.filter(m =>
    (m.kind === "normal" && !tagSourceIds.has(m.id)) ||
    (m.kind === "relation" && classifyRelMsgIds.has(m.id))
  ), [messages, tagSourceIds, classifyRelMsgIds]);
  const normalIds = useMemo(() => normals.map(m => m.id), [normals]);
  // Exclude CLASSIFY messages from relIds — they are now in normals and should not be
  // treated as relation-message endpoints for edge-routing constraint algorithms.
  const relIds = useMemo(() => new Set(messages.filter(m => m.kind === "relation" && !classifyRelMsgIds.has(m.id)).map(m => m.id)), [messages, classifyRelMsgIds]);

  const { col: baseCol, maxCol: baseMaxCol } = useMemo(() => computeMinColumnsForAnnoRefRule1(normalIds, edges, relIds), [normalIds, edges, relIds]);
  const { col: replyCol, maxCol: replyMaxCol } = useMemo(() => applyReplyLayoutAdjustmentsWithConstraints({ normals, edges, baseCol, baseMaxCol, relIds }), [normals, edges, baseCol, baseMaxCol, relIds]);
  // AGREE/DISAGREE column override: applied before grouping so grouping can override it
  const { col: agreeDisCol, maxCol: agreeDisMaxCol } = useMemo(() => applyAgreeDisagreeColumnOverride({ normals, edges, col: replyCol, maxCol: replyMaxCol }), [normals, edges, replyCol, replyMaxCol]);
  // Grouping column override: highest priority — supplement/frame-group/replace-overlay/correction-badge source must
  // be in same column as target, overriding any agree/disagree placement for zero-gap stacking.
  const { col: colOf, maxCol, groupSourceToTarget } = useMemo(() => applyGroupingColumnOverride({ normals, edges, col: agreeDisCol, maxCol: agreeDisMaxCol }), [normals, edges, agreeDisCol, agreeDisMaxCol]);

  const [measuredHeights, setMeasuredHeights] = useState<Record<string,number>>({});
  const [positionedEdges, setPositionedEdges] = useState<PositionedEdge[]>([]);
  const [labelBboxes, setLabelBboxes] = useState<Record<string,LabelBbox>>({});
  const [decorationRectsState, setDecorationRectsState] = useState<Record<string,{kind:"agree"|"disagree";rect:Rect;iconRect:Rect;bodyRect:Rect;key:string;messageId:string}>|null>(null);
  const [decorationsByMsgState, setDecorationsByMsgState] = useState<Record<string,{agreeCount:number;disagreeCount:number;agreeKey:string;disagreeKey:string}>|null>(null);
  // TAG decorations: aggregated by label text — map from messageId → list of {label, relMsgIds, rect, relAgreeCount, relDisagreeCount, relAgreeMsgIds, relDisagreeMsgIds}
  const [tagDecorationsByMsg, setTagDecorationsByMsg] = useState<Record<string,{label:string;relMsgIds:string[];rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[]>>({});
  // SUPPLEMENT frames: list of {targetId, sourceId, frame rect, isBlankCorrected, relAgreeCount, ...}
  // isBlankCorrected: true when the supplement is targeted by a CORRECT with no replacement (anon source) —
  // the SVG frame border is hidden but the correction badge remains visible.
  const [supplementFrames, setSupplementFrames] = useState<{targetId:string;sourceId:string;relMsgId:string;isBlankCorrected:boolean;rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[]>([]);
  // GROUP frames: frame-group (CLASSIFY/MERGE) and replace-overlay (SUMMARY) — same visual structure as supplement frames
  // relKind field distinguishes supplement-frame / frame-group / replace-overlay for styling
  // isBlankCorrected: same semantics as for supplementFrames above.
  const [groupFrames, setGroupFrames] = useState<{targetId:string;sourceId:string;relMsgId:string;relType:string;isBlankCorrected:boolean;relKind:PresentationKind;relLabel:string;relColor:string;rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[]>([]);
  // INLINE BADGES: RECOMMEND / ARCHIVE — small badge anchored to the target message card
  const [inlineBadgesByMsg, setInlineBadgesByMsg] = useState<Map<string,Array<{relMsgId:string;relKind:string;relLabel:string;relColor:string;rect:Rect}>>>(new Map());
  // AGREE/DISAGREE decorations targeting relation messages — for edge-label relations (annotation/reference/reply)
  const [relDecByRelMsgState, setRelDecByRelMsgState] = useState<Map<string,{agreeCount:number;disagreeCount:number;agreeRelMsgIds:string[];disagreeRelMsgIds:string[]}>>(new Map());
  // TAG relations targeting relation messages — for rendering next to edge labels / supplement frames
  const [tagsByRelMsgState, setTagsByRelMsgState] = useState<Map<string,Array<{label:string;relMsgId:string}>>>(new Map());

  const canvasWidth = GRID_LEFT + (maxCol+1)*CARD_W + maxCol*COL_GAP + CANVAS_RIGHT_PAD;
  const edgesByRelMsg = useMemo(() => {
    const map = new Map<string,DemoEdge[]>();
    for (const e of edges) { const arr=map.get(e.relationMessageId)??[]; arr.push(e); map.set(e.relationMessageId,arr); }
    return map;
  }, [edges]);

  // IDs of all targets of CORRECT relations that have a real (non-anonymous) replacement source.
  // Their cards are hidden in the non-linear view because the replacement source card/edge
  // takes the same position, effectively replacing the target.
  // Only hide when the CORRECT relation has a non-anon source — if there is no replacement
  // (secondary type = "none", anon: source), the original remains visible with a correction badge.
  const correctedTargetMsgIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of edges) {
      if (e.relationType === 'correct' && !e.from.messageId.startsWith('anon:')) {
        ids.add(e.to.messageId);
      }
    }
    return ids;
  }, [edges]);

  // Map: source normal-message ID → [{relMsgId, targetMsgId}] for CORRECT relations.
  // Used to render the correction badge inline in the source card header.
  const correctionsBySourceMsgId = useMemo(() => {
    const map = new Map<string, Array<{relMsgId: string; targetMsgId: string}>>();
    for (const e of edges) {
      if (e.relationType !== 'correct') continue;
      if (e.from.messageId.startsWith('anon:')) continue;
      const srcId = e.from.messageId;
      if (msgMap.get(srcId)?.kind !== 'normal') continue;
      const arr = map.get(srcId) ?? [];
      arr.push({ relMsgId: e.relationMessageId, targetMsgId: e.to.messageId });
      map.set(srcId, arr);
    }
    return map;
  }, [edges, msgMap]);

  // Corrected-target IDs that are NOT themselves correction sources.
  // A message that corrects another while also being corrected (chained correction) must
  // remain visible so its own correction badge is not lost.
  const hiddenCorrectedTargetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of correctedTargetMsgIds) {
      if (!correctionsBySourceMsgId.has(id)) ids.add(id);
    }
    return ids;
  }, [correctedTargetMsgIds, correctionsBySourceMsgId]);
  const { layout: baseLayout } = useMemo(
    () => computeNoOverlapLayout({ normals, colOf, measuredHeights, maxCol, groupSourceToTarget, correctedTargetIds: hiddenCorrectedTargetIds }),
    [normals, colOf, measuredHeights, maxCol, groupSourceToTarget, hiddenCorrectedTargetIds]
  );
  const mergeCanvasReservations = useMemo(
    () => buildMergeCanvasReservations({ edges, layout: baseLayout, msgMap, classifyRelMsgIds }),
    [edges, baseLayout, msgMap, classifyRelMsgIds]
  );
  const { layout, canvasHeight } = useMemo(
    () => applyMergeCanvasReservations({ layout: baseLayout, normals, colOf, reservations: mergeCanvasReservations }),
    [baseLayout, normals, colOf, mergeCanvasReservations]
  );

  // Map: target relation-message ID → [{corrRelMsgId, srcMsgId}] for CORRECT relations targeting relation messages.
  // Used to embed correction badge in the target relation's hit area.
  const correctedRelMsgTargets = useMemo(() => {
    const map = new Map<string, Array<{corrRelMsgId: string; srcMsgId: string}>>();
    for (const e of edges) {
      if (e.relationType !== 'correct') continue;
      const targetId = e.to.messageId;
      if (msgMap.get(targetId)?.kind !== 'relation') continue;
      const arr = map.get(targetId) ?? [];
      arr.push({ corrRelMsgId: e.relationMessageId, srcMsgId: e.from.messageId });
      map.set(targetId, arr);
    }
    return map;
  }, [edges, msgMap]);

  // Set of relation-message IDs that are targeted by a CORRECT relation with an anon: source
  // (i.e. correction with no replacement relation). These are displayed as a blank label with
  // only the correction badge visible — the original arrow and text are hidden.
  const anonCorrectedRelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of edges) {
      if (e.relationType === 'correct' && e.from.messageId.startsWith('anon:')) {
        if (msgMap.get(e.to.messageId)?.kind === 'relation') {
          ids.add(e.to.messageId);
        }
      }
    }
    return ids;
  }, [edges, msgMap]);

  // Map: new relation-message ID (source of CORRECT) → [{corrRelMsgId, targetRelMsgId}]
  // for CORRECT relations where both source and target are relation messages.
  // Used to show a correction badge on the replacement relation's edge label.
  const correctionSrcByNewRelMsg = useMemo(() => {
    const map = new Map<string, Array<{corrRelMsgId: string; targetRelMsgId: string}>>();
    for (const e of edges) {
      if (e.relationType !== 'correct') continue;
      const srcId = e.from.messageId;
      if (srcId.startsWith('anon:')) continue;
      if (msgMap.get(srcId)?.kind !== 'relation') continue;
      const targetId = e.to.messageId;
      if (msgMap.get(targetId)?.kind !== 'relation') continue;
      const arr = map.get(srcId) ?? [];
      arr.push({ corrRelMsgId: e.relationMessageId, targetRelMsgId: targetId });
      map.set(srcId, arr);
    }
    return map;
  }, [edges, msgMap]);

  useEffect(() => {
    const ro = new ResizeObserver(entries => {
      const next: Record<string,number> = {};
      for (const ent of entries) {
        const el = ent.target as HTMLElement;
        const id = el.getAttribute("data-msgid");
        if (!id) continue;
        next[id] = Math.ceil(el.getBoundingClientRect().height);
      }
      if (!Object.keys(next).length) return;
      setMeasuredHeights(prev => {
        let changed=false; const merged={...prev};
        for (const [k,v] of Object.entries(next)) if (!merged[k]||Math.abs(merged[k]-v)>1) { merged[k]=v; changed=true; }
        return changed ? merged : prev;
      });
    });
    for (const m of normals) { const el=cardRefs.current[m.id]; if (el) ro.observe(el); }
    return () => ro.disconnect();
  // layout is added so that when cards first appear in the DOM (after layout is computed),
  // we re-run and observe them — this fixes the initial-load overlap bug.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normals, layout]);

  useEffect(() => {
    const canvasEl = canvasRef.current; if (!canvasEl) return;
    const canvasRect = canvasEl.getBoundingClientRect();
    const normalSet = new Set(normalIds);

    function endpointBoxForNormal(id: string): {box:LayoutBox;col:number}|null {
      const m = msgMap.get(id);
      // Accept both normal text messages and CLASSIFY relation messages (shown as cards)
      if (!m || (m.kind !== "normal" && !classifyRelMsgIds.has(id))) return null;
      const cardEl = cardRefs.current[id];
      if (cardEl) {
        const r = cardEl.getBoundingClientRect();
        return { box:{x:r.left-canvasRect.left,y:r.top-canvasRect.top,width:r.width,height:r.height}, col:colOf[id]??0 };
      }
      const box = layout[id]; if (!box) return null;
      return { box, col:colOf[id]??0 };
    }

    const globalForbiddenRects: Rect[] = [];
    for (const m of normals) {
      const header=headerRefs.current[m.id], content=contentRefs.current[m.id];
      if (!header||!content) {
        const el=cardRefs.current[m.id];
        if (el) for (const r of Array.from(el.getClientRects())) globalForbiddenRects.push({x:r.left-canvasRect.left,y:r.top-canvasRect.top,width:r.width,height:r.height});
        continue;
      }
      for (const ref of [...Array.from(header.getClientRects()),...Array.from(content.getClientRects())])
        globalForbiddenRects.push({x:ref.left-canvasRect.left,y:ref.top-canvasRect.top,width:ref.width,height:ref.height});
    }
    for (const mergeCanvas of mergeCanvasReservations) globalForbiddenRects.push(mergeCanvas.headerRect);

    function getMessageRects(messageId: string): Rect[] {
      const res: Rect[] = [];
      const header=headerRefs.current[messageId], content=contentRefs.current[messageId];
      for (const el of [header,content].filter(Boolean) as HTMLElement[])
        for (const r of Array.from(el.getClientRects())) res.push({x:r.left-canvasRect.left,y:r.top-canvasRect.top,width:r.width,height:r.height});
      const cardEl=cardRefs.current[messageId];
      if (cardEl) for (const r of Array.from(cardEl.getClientRects())) res.push({x:r.left-canvasRect.left,y:r.top-canvasRect.top,width:r.width,height:r.height});
      else { const l=layout[messageId]; if (l) res.push({x:l.x,y:l.y,width:l.width,height:l.height}); }
      return res;
    }

    function pointInside(p: Point, r: Rect) {
      const e=1e-6; return p.x>r.x+e && p.x<r.x+r.width-e && p.y>r.y+e && p.y<r.y+r.height-e;
    }

    function sampleQuad(p0:Point,p1:Point,p2:Point,n=40): Point[] {
      const pts: Point[]=[];
      for (let i=0;i<=n;i++) pts.push(quadAt(p0,p1,p2,i/n));
      return pts;
    }

    function penScore(samples: Point[], rects: Rect[]) {
      let cnt=0;
      for (const p of samples) for (const r of rects) if (pointInside(p,r)) { cnt++; break; }
      return cnt;
    }

    const decorationsByMsg: Record<string,{agreeCount:number;disagreeCount:number;agreeKey:string;disagreeKey:string}> = {};
    for (const e of edges) {
      if (e.to.selection.kind==="edge") {
        const eid=e.to.selection.edgeId||"";
        if (eid.startsWith("dec:")) {
          const parts=eid.split(":");
          if (parts.length>=3) {
            const mid=parts.slice(2).join(":");
            if (!decorationsByMsg[mid]) decorationsByMsg[mid]={agreeCount:0,disagreeCount:0,agreeKey:`dec:agree:${mid}`,disagreeKey:`dec:disagree:${mid}`};
            if (e.relationType==="agree") decorationsByMsg[mid].agreeCount++;
            else if (e.relationType==="disagree") decorationsByMsg[mid].disagreeCount++;
          }
        }
      } else if (e.to.selection.kind==="whole") {
        const mid=e.to.messageId;
        // Relation message targets are tracked separately in relDecByRelMsgId below,
        // except CLASSIFY relation messages which are rendered as topic cards.
        if (msgMap.get(mid)?.kind === "relation" && !classifyRelMsgIds.has(mid)) continue;
        if (e.relationType==="agree"||e.relationType==="disagree") {
          if (!decorationsByMsg[mid]) decorationsByMsg[mid]={agreeCount:0,disagreeCount:0,agreeKey:`dec:agree:${mid}`,disagreeKey:`dec:disagree:${mid}`};
          if (e.relationType==="agree") decorationsByMsg[mid].agreeCount++;
          else decorationsByMsg[mid].disagreeCount++;
        }
      }
    }

    // Decorations are now placed to the RIGHT of the card, stacked vertically (agree on top, disagree below).
    // Each badge is split into icon area (left DEC_ICON_W px) and body area (rest).
    const decorationRects: Record<string,{kind:"agree"|"disagree";rect:Rect;iconRect:Rect;bodyRect:Rect;key:string;messageId:string}> = {};
    for (const [mid,data] of Object.entries(decorationsByMsg)) {
      const ep=endpointBoxForNormal(mid), box=ep?.box??layout[mid]; if (!box) continue;
      const hasAgree=data.agreeCount>0, hasDisagree=data.disagreeCount>0;
      const decX=box.x+box.width+DEC_RIGHT_GAP;
      let decY=box.y+DEC_RIGHT_TOP;
      if (hasAgree) {
        const rect={x:decX,y:decY,width:DEC_W,height:DEC_H};
        const iconRect={x:decX,y:decY,width:DEC_ICON_W,height:DEC_H};
        const bodyRect={x:decX+DEC_ICON_W,y:decY,width:DEC_W-DEC_ICON_W,height:DEC_H};
        decorationRects[`${mid}::agree`]={kind:"agree",key:data.agreeKey,messageId:mid,rect,iconRect,bodyRect};
        decY+=DEC_H+DEC_GAP;
      }
      if (hasDisagree) {
        const rect={x:decX,y:decY,width:DEC_W,height:DEC_H};
        const iconRect={x:decX,y:decY,width:DEC_ICON_W,height:DEC_H};
        const bodyRect={x:decX+DEC_ICON_W,y:decY,width:DEC_W-DEC_ICON_W,height:DEC_H};
        decorationRects[`${mid}::disagree`]={kind:"disagree",key:data.disagreeKey,messageId:mid,rect,iconRect,bodyRect};
      }
    }
    for (const v of Object.values(decorationRects)) globalForbiddenRects.push(v.rect);

    // Compute TAG label positions — aggregated by label text, stacked below agree/disagree decorations
    const newTagDecorationsByMsg: Record<string,{label:string;relMsgIds:string[];rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[]> = {};
    for (const e of edges) {
      if (e.relationType!=="tag") continue;
      if (e.to.selection.kind!=="whole") continue;
      const mid=e.to.messageId;
      const ep=endpointBoxForNormal(mid), box=ep?.box??layout[mid]; if (!box) continue;
      // Use e.relationLabel which carries the actual tag text (set in modelBridge for new-style tags,
      // or derived from source message content for legacy tags).
      const label=isValidTagLabel(e.relationLabel)
        ? e.relationLabel.slice(0,TAG_MAX_LABEL_CHARS)
        : (msgMap.get(e.from.messageId)?.content?.slice(0,TAG_MAX_LABEL_CHARS)??"标注");
      if (!newTagDecorationsByMsg[mid]) newTagDecorationsByMsg[mid]=[];
      // Find existing group for this label (aggregate same-text tags)
      const existing=newTagDecorationsByMsg[mid].find(g=>g.label===label);
      if (existing) {
        existing.relMsgIds.push(e.relationMessageId);
      } else {
        const tagX=box.x+box.width+TAG_RIGHT_GAP;
        const hasAgree=!!decorationRects[`${mid}::agree`], hasDisagree=!!decorationRects[`${mid}::disagree`];
        const decBottomY = box.y+DEC_RIGHT_TOP + (hasAgree?DEC_H+DEC_GAP:0) + (hasDisagree?DEC_H+DEC_GAP:0);
        const tagY=decBottomY + newTagDecorationsByMsg[mid].length*(TAG_H+TAG_V_GAP);
        // Reserve width for count suffix; we'll recalculate at render time
        const tagW=Math.max(TAG_MIN_W, label.length*8+8+28);
        const rect={x:tagX,y:tagY,width:tagW,height:TAG_H};
        newTagDecorationsByMsg[mid].push({label,relMsgIds:[e.relationMessageId],rect,relAgreeCount:0,relDisagreeCount:0,relAgreeMsgIds:[],relDisagreeMsgIds:[]});
        globalForbiddenRects.push(rect);
      }
    }

    // Compute SUPPLEMENT frames — one frame per relation message (relMsgId), wrapping all target
    // messages and the source message (if any) within a single border frame.
    const newSupplementFrames: {targetId:string;sourceId:string;relMsgId:string;isBlankCorrected:boolean;rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[] = [];
    // Compute GROUP frames — frame-group (CLASSIFY/MERGE) and replace-overlay (SUMMARY).
    // Same structure as supplement frames; relKind/relLabel/relColor distinguish them for styling.
    // Note: CORRECT uses correction-badge kind (not replace-overlay) — no frame, badge only.
    const newGroupFrames: {targetId:string;sourceId:string;relMsgId:string;relType:string;isBlankCorrected:boolean;relKind:PresentationKind;relLabel:string;relColor:string;rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[] = [];

    // Generic frame computation — shared logic for supplement, frame-group, replace-overlay.
    function computeFramesForRelType(
      filterFn: (relType: string) => boolean,
      appendFn: (f: {targetId:string;sourceId:string;relMsgId:string;relType:string;isBlankCorrected:boolean;relKind:PresentationKind;relLabel:string;relColor:string;rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}) => void
    ) {
      const frameEdgesByRelMsg = new Map<string, DemoEdge[]>();
      for (const e of edges) {
        if (!filterFn(e.relationType)) continue;
        if (e.to.selection.kind !== "whole" && e.to.selection.kind !== "text") continue;
        const arr = frameEdgesByRelMsg.get(e.relationMessageId) ?? [];
        arr.push(e);
        frameEdgesByRelMsg.set(e.relationMessageId, arr);
      }
      for (const [relMsgId, frameEdges] of frameEdgesByRelMsg) {
        if (frameEdges.length === 0) continue;
        // Skip frames replaced by a non-blank correction (source is a real new relation).
        // Blank-corrected frames (CORRECT with anon source / secondary="none") are included
        // but marked so their SVG border is hidden while the correction badge remains visible.
        if (correctedTargetMsgIds.has(relMsgId)) continue;
        const isBlankCorrected = anonCorrectedRelMsgIds.has(relMsgId);
        const relType = frameEdges[0].relationType;
        const spec = getPresentationSpec(relType);
        const sourceId = frameEdges[0].from.messageId;
        const hasExplicitSource = !sourceId.startsWith("anon:");
        const sourceBox = hasExplicitSource ? (endpointBoxForNormal(sourceId)?.box ?? layout[sourceId]) : null;
        if (hasExplicitSource && !sourceBox) continue;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        if (sourceBox) {
          minX = Math.min(minX, sourceBox.x); minY = Math.min(minY, sourceBox.y);
          maxX = Math.max(maxX, sourceBox.x + sourceBox.width); maxY = Math.max(maxY, sourceBox.y + sourceBox.height);
        }
        let anyTarget = false;
        for (const e of frameEdges) {
          const relationTargetBounds = msgMap.get(e.to.messageId)?.kind === "relation"
            ? getRelationBoundsFromLayout({ relMsgId: e.to.messageId, edgesByRelMsg, layout, msgMap, classifyRelMsgIds })
            : null;
          const targetBox = relationTargetBounds?.rect ?? endpointBoxForNormal(e.to.messageId)?.box ?? layout[e.to.messageId];
          if (!targetBox) continue;
          anyTarget = true;
          minX = Math.min(minX, targetBox.x); minY = Math.min(minY, targetBox.y);
          maxX = Math.max(maxX, targetBox.x + targetBox.width); maxY = Math.max(maxY, targetBox.y + targetBox.height);
        }
        if (!anyTarget && !sourceBox) continue;
        if (minX === Infinity) continue;
        const rect = {
          x: minX - SUPP_FRAME_PAD, y: minY - SUPP_FRAME_PAD,
          width: maxX - minX + SUPP_FRAME_PAD * 2, height: maxY - minY + SUPP_FRAME_PAD * 2,
        };
        const targetId = frameEdges[0].to.messageId;
        appendFn({ targetId, sourceId, relMsgId, relType, isBlankCorrected, relKind: spec.kind, relLabel: spec.label, relColor: spec.color, rect, relAgreeCount:0, relDisagreeCount:0, relAgreeMsgIds:[], relDisagreeMsgIds:[] });
      }
    }

    computeFramesForRelType(isSuppFrameRel, f => newSupplementFrames.push({ targetId:f.targetId, sourceId:f.sourceId, relMsgId:f.relMsgId, isBlankCorrected:f.isBlankCorrected, rect:f.rect, relAgreeCount:f.relAgreeCount, relDisagreeCount:f.relDisagreeCount, relAgreeMsgIds:f.relAgreeMsgIds, relDisagreeMsgIds:f.relDisagreeMsgIds }));
    computeFramesForRelType(t => !isSuppFrameRel(t) && isAnyFrameRel(t), f => newGroupFrames.push(f));

    // Compute INLINE BADGES — RECOMMEND / ARCHIVE: small badge anchored to target message card
    // Position: top-right corner of the target card, stacked upward for multiple badges.
    const BADGE_W = 46, BADGE_H = 18, BADGE_RIGHT_GAP = -6, BADGE_TOP_OFFSET = -8;
    const newInlineBadgesByMsg = new Map<string, Array<{relMsgId:string;relKind:string;relLabel:string;relColor:string;rect:Rect}>>();
    for (const e of edges) {
      if (getRelKind(e.relationType) !== 'inline-badge') continue;
      if (e.to.selection.kind !== 'whole') continue;
      const mid = e.to.messageId;
      const targetMsg = msgMap.get(mid);
      const isInlineBadgeTargetCard = !!targetMsg && (
        targetMsg.kind === 'normal' ||
        (targetMsg.kind === 'relation' && classifyRelMsgIds.has(mid))
      );
      if (!isInlineBadgeTargetCard) continue;
      const ep = endpointBoxForNormal(mid), box = ep?.box ?? layout[mid]; if (!box) continue;
      const spec = getPresentationSpec(e.relationType);
      const arr = newInlineBadgesByMsg.get(mid) ?? [];
      const badgeX = box.x + box.width - BADGE_W + BADGE_RIGHT_GAP;
      const badgeY = box.y + BADGE_TOP_OFFSET - arr.length * (BADGE_H + 2);
      arr.push({ relMsgId: e.relationMessageId, relKind: spec.kind, relLabel: spec.label, relColor: spec.color, rect: { x: badgeX, y: badgeY, width: BADGE_W, height: BADGE_H } });
      newInlineBadgesByMsg.set(mid, arr);
    }

    // Compute AGREE/DISAGREE decorations targeting relation messages (relDecByRelMsgId)
    // These are displayed next to the relation's visual element (tag badge, supplement frame, edge label)
    const relDecByRelMsgId = new Map<string,{agreeCount:number;disagreeCount:number;agreeRelMsgIds:string[];disagreeRelMsgIds:string[]}>();
    for (const e of edges) {
      if (e.relationType!=="agree"&&e.relationType!=="disagree") continue;
      if (e.to.selection.kind!=="whole") continue;
      const toId=e.to.messageId;
      if (msgMap.get(toId)?.kind !== "relation") continue;
      const cur=relDecByRelMsgId.get(toId)??{agreeCount:0,disagreeCount:0,agreeRelMsgIds:[],disagreeRelMsgIds:[]};
      if (e.relationType==="agree") { cur.agreeCount++; cur.agreeRelMsgIds.push(e.relationMessageId); }
      else { cur.disagreeCount++; cur.disagreeRelMsgIds.push(e.relationMessageId); }
      relDecByRelMsgId.set(toId, cur);
    }
    // Propagate counts and IDs to tag groups, supplement frames, and group frames
    for (const groups of Object.values(newTagDecorationsByMsg)) {
      for (const group of groups) {
        for (const rmId of group.relMsgIds) {
          const dec=relDecByRelMsgId.get(rmId);
          if (dec) {
            group.relAgreeCount+=dec.agreeCount; group.relDisagreeCount+=dec.disagreeCount;
            group.relAgreeMsgIds.push(...dec.agreeRelMsgIds); group.relDisagreeMsgIds.push(...dec.disagreeRelMsgIds);
          }
        }
      }
    }
    for (const sf of [...newSupplementFrames, ...newGroupFrames]) {
      const dec=relDecByRelMsgId.get(sf.relMsgId);
      if (dec) {
        sf.relAgreeCount+=dec.agreeCount; sf.relDisagreeCount+=dec.disagreeCount;
        sf.relAgreeMsgIds.push(...dec.agreeRelMsgIds); sf.relDisagreeMsgIds.push(...dec.disagreeRelMsgIds);
      }
    }
    setRelDecByRelMsgState(relDecByRelMsgId);
    setTagDecorationsByMsg(newTagDecorationsByMsg);
    setSupplementFrames(newSupplementFrames);
    setGroupFrames(newGroupFrames);
    setInlineBadgesByMsg(newInlineBadgesByMsg);

    // Collect TAG relations targeting relation messages (for display next to edge labels / frames)
    const newTagsByRelMsg = new Map<string,Array<{label:string;relMsgId:string}>>();
    for (const e of edges) {
      if (e.relationType!=="tag") continue;
      if (e.to.selection.kind!=="whole") continue;
      const toId=e.to.messageId;
      if (msgMap.get(toId)?.kind !== "relation") continue;
      const label=isValidTagLabel(e.relationLabel)
        ? e.relationLabel.slice(0,TAG_MAX_LABEL_CHARS)
        : (msgMap.get(e.from.messageId)?.content?.slice(0,TAG_MAX_LABEL_CHARS)??"标注");
      const arr=newTagsByRelMsg.get(toId)??[];
      arr.push({label,relMsgId:e.relationMessageId});
      newTagsByRelMsg.set(toId,arr);
    }
    setTagsByRelMsgState(newTagsByRelMsg);

    // Build lookup maps for visual positions of relation messages (used in edge targeting)
    const suppFrameByRelMsgId = new Map<string,Rect>();
    for (const sf of newSupplementFrames) suppFrameByRelMsgId.set(sf.relMsgId, sf.rect);

    const groupFrameByRelMsgId = new Map<string,Rect>();
    for (const gf of newGroupFrames) groupFrameByRelMsgId.set(gf.relMsgId, gf.rect);

    const tagBadgeByRelMsgId = new Map<string,{mid:string;rect:Rect}>();
    for (const [mid,groups] of Object.entries(newTagDecorationsByMsg)) {
      for (const group of groups) {
        for (const rmId of group.relMsgIds) tagBadgeByRelMsgId.set(rmId,{mid,rect:group.rect});
      }
    }

    // Helper: recursively resolve the visual bounding box for a relation message.
    // This is needed when an edge targets a relation message (rel:...) that is itself
    // a relation whose endpoints may also be relation messages (deeply nested annotations).
    function getRelVisualBox(relId: string, depth = 0): LayoutBox | null {
      if (depth > MAX_RELATION_NESTING_DEPTH) return null;
      const relEdges = edgesByRelMsg.get(relId) ?? [];
      if (relEdges.length === 0) {
        // CLASSIFY relations may have no target edges yet, but their topic cards are still visible.
        const relCard = endpointBoxForNormal(relId)?.box ?? layout[relId];
        return relCard ?? null;
      }
      const te0 = relEdges[0];
      const relType = te0.relationType;
      if (relType === "supplement") {
        const fr = suppFrameByRelMsgId.get(relId);
        return fr ? { x: fr.x, y: fr.y, width: fr.width, height: fr.height } : null;
      }
      // frame-group or replace-overlay: use the computed group frame rect
      const relTypeKind = getPresentationSpec(relType).kind;
      if (relTypeKind === 'frame-group' || relTypeKind === 'replace-overlay' || relTypeKind === 'correction-badge') {
        const fr = groupFrameByRelMsgId.get(relId);
        if (!fr && relTypeKind === 'frame-group') {
          // CLASSIFY relation messages are rendered as topic cards rather than SVG frames.
          const relCard = endpointBoxForNormal(relId)?.box ?? layout[relId];
          if (relCard) return relCard;
        }
        return fr ? { x: fr.x, y: fr.y, width: fr.width, height: fr.height } : null;
      }
      if (relType === "tag") {
        const tagInfo = tagBadgeByRelMsgId.get(relId);
        return tagInfo ? { x: tagInfo.rect.x, y: tagInfo.rect.y, width: tagInfo.rect.width, height: tagInfo.rect.height } : null;
      }
      if (relType === "agree" || relType === "disagree") {
        const targetMid = te0.to.messageId;
        if (msgMap.get(targetMid)?.kind === "relation") {
          // The decoration badge for this agree/disagree is rendered to the right of the
          // target relation message's edge label. Use labelBboxes (from the previous render)
          // to compute the actual badge position rather than approximating via card midpoints.
          // Find the edge label bbox for the target relation. Edges are stored in the same
          // insertion order as `edges` (prop), so the first matching entry corresponds to the
          // same positioned edge that the decoration-badge renderer picks (it also takes the
          // first unrendered positioned edge per relation message).
          const targetRelEdges = edgesByRelMsg.get(targetMid) ?? [];
          for (const r1e of targetRelEdges) {
            const bb = labelBboxes[r1e.id] ?? labelBboxes[`${r1e.id}__toRel__${r1e.to.messageId}`];
            if (bb) {
              const hasAgree = (relDecByRelMsgId.get(targetMid)?.agreeCount ?? 0) > 0;
              let badgeY = bb.y + Math.floor((bb.height - DEC_H) / 2);
              if (relType === "disagree" && hasAgree) badgeY += DEC_H + DEC_GAP;
              return { x: bb.x + bb.width + DEC_RIGHT_GAP, y: badgeY, width: DEC_W, height: DEC_H };
            }
          }
          // No label bbox available yet (first render) — fall back to recursive approximation
          return getRelVisualBox(targetMid, depth + 1);
        }
        // Point to the decoration badge rect so the arrow targets the badge, not the whole card
        const decKey = `${targetMid}::${relType}`;
        const decRect = decorationRects[decKey];
        if (decRect) return { x: decRect.rect.x, y: decRect.rect.y, width: decRect.rect.width, height: decRect.rect.height };
        const ep = endpointBoxForNormal(targetMid);
        return ep?.box ?? null;
      }
      // annotation / reference / reply (edge-label kind): the clickable area is the label.
      // Use labelBboxes from the previous render if available; fall back to midpoint on first render.
      // Key format: `e.id` when target is a normal message; `${e.id}__toRel__${target}` when target is a relation.
      for (const r1e of relEdges) {
        const bb = labelBboxes[r1e.id] ?? labelBboxes[`${r1e.id}__toRel__${r1e.to.messageId}`];
        if (bb) {
          return { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
        }
      }
      // Label bbox not yet available (first render) — fall back to midpoint approximation.
      let fromBox: LayoutBox | null = null;
      if (!te0.from.messageId.startsWith("anon:")) {
        if (msgMap.get(te0.from.messageId)?.kind === "relation") {
          fromBox = getRelVisualBox(te0.from.messageId, depth + 1);
        } else {
          const fm = msgMap.get(te0.from.messageId);
          if (fm?.kind === "normal") fromBox = endpointBoxForNormal(te0.from.messageId)?.box ?? null;
        }
      }
      let toBox: LayoutBox | null = null;
      if (msgMap.get(te0.to.messageId)?.kind === "relation") {
        toBox = getRelVisualBox(te0.to.messageId, depth + 1);
      } else {
        const tm = msgMap.get(te0.to.messageId);
        if (tm?.kind === "normal") toBox = endpointBoxForNormal(te0.to.messageId)?.box ?? null;
      }
      if (fromBox && toBox) {
        const midX = (fromBox.x + fromBox.width / 2 + toBox.x + toBox.width / 2) / 2;
        const midY = (fromBox.y + fromBox.height / 2 + toBox.y + toBox.height / 2) / 2;
        return { x: midX - 20, y: midY - 8, width: 40, height: 16 };
      }
      return fromBox ?? toBox ?? null;
    }

    const rawEdges: Omit<PositionedEdge,"labelX"|"labelY">[] = [];
    const labelSeeds: LabelSeed[] = [];
    // For agree/disagree with a real source message, use "支持"/"反驳" labels (support/rebut semantics).
    function edgeLabelName(relType: string): string {
      if (relType === "agree") return "支持";
      if (relType === "disagree") return "反驳";
      return relationTypeName(relType);
    }
    const labelText = (e:DemoEdge,author:string) => `${author} · ${edgeLabelName(e.relationType)}`;

    for (const e of edges) {
      const fromMsg=msgMap.get(e.from.messageId); if (!fromMsg||fromMsg.kind!=="normal") continue;
      const fromEp=endpointBoxForNormal(fromMsg.id); if (!fromEp) continue;
      const fromAuthor=fromMsg.author;
      const toMsg=msgMap.get(e.to.messageId);

      // Tag and supplement relations are rendered as decorations/frames — no directed arrows.
      // Agree/disagree: pure-stance (anon: source) → decoration only;
      //   with real source → directed arrow pointing to the decorated message (not the badge).
      if (e.relationType==="tag"||e.relationType==="supplement") continue;
      // frame-group, replace-overlay, and correction-badge relations are rendered as frames/badges, not arrows
      const eSpec = getPresentationSpec(e.relationType);
      if (eSpec.kind === 'frame-group' || eSpec.kind === 'replace-overlay' || eSpec.kind === 'correction-badge') continue;
      // Skip edges for relation messages that have been corrected at the fragment level:
      // only the individually corrected edge fragments are hidden; uncorrected fragments remain visible.
      if (correctedEdgeIdsByRelMsg.get(e.relationMessageId)?.has(e.id)) continue;
      if (e.relationType==="agree"||e.relationType==="disagree") {
        if (e.from.messageId.startsWith("anon:")) continue; // pure-stance, decoration only
        // Has source message: render directed arrow.
        // If the target is a normal message, point to its card box directly.
        // If the target is a relation message, fall through to the relation-message block below.
        const targetMid=e.to.messageId;
        if (msgMap.get(targetMid)?.kind !== "relation") {
          const toEpN=endpointBoxForNormal(targetMid); if (!toEpN) continue;
          rawEdges.push({
            drawId:e.id,edge:e,fromAuthor,
            fromBox:fromEp.box,toBox:toEpN.box,fromCol:fromEp.col,toCol:toEpN.col,
            fragRectCanvas:null,edgeLabelText:labelText(e,fromAuthor),expandedToEdgeId:null,
            start:{x:0,y:0},ctrl:{x:0,y:0},end:{x:0,y:0},
          });
          continue;
        }
        // else: target is a relation message — fall through to the toMsg.kind==="relation" block.
      }

      if (toMsg?.kind==="relation") {
        const relId=e.to.messageId;
        const targetRelEdges = edgesByRelMsg.get(relId) ?? [];
        // All edges in the same relation message share the same relationType by construction
        // (a relation has exactly one type), so using the first edge is always correct.
        const targetRelType = targetRelEdges[0]?.relationType ?? "";

        // Supplement frame: edge should point to the frame border (the relation's clickable area)
        if (targetRelType === "supplement") {
          const frameRect = suppFrameByRelMsgId.get(relId);
          if (frameRect) {
            rawEdges.push({
              drawId:e.id,edge:e,fromAuthor,
              fromBox:fromEp.box,toBox:{x:frameRect.x,y:frameRect.y,width:frameRect.width,height:frameRect.height},
              fromCol:fromEp.col,toCol:fromEp.col,
              fragRectCanvas:null,edgeLabelText:labelText(e,fromAuthor),expandedToEdgeId:null,
              start:{x:0,y:0},ctrl:{x:0,y:0},end:{x:0,y:0},
            });
          }
          continue;
        }

        // Tag badge: edge should point to the tag badge (the relation's clickable area)
        if (targetRelType === "tag") {
          const tagInfo = tagBadgeByRelMsgId.get(relId);
          if (tagInfo) {
            rawEdges.push({
              drawId:e.id,edge:e,fromAuthor,
              fromBox:fromEp.box,toBox:{x:tagInfo.rect.x,y:tagInfo.rect.y,width:tagInfo.rect.width,height:tagInfo.rect.height},
              fromCol:fromEp.col,toCol:fromEp.col,
              fragRectCanvas:null,edgeLabelText:labelText(e,fromAuthor),expandedToEdgeId:null,
              start:{x:0,y:0},ctrl:{x:0,y:0},end:{x:0,y:0},
            });
          }
          continue;
        }

        // Agree/disagree decoration: edge points to the decoration badge of the relation message.
        // getRelVisualBox handles nested relation targets (e.g. agree/disagree on a relation message).
        if (targetRelType === "agree" || targetRelType === "disagree") {
          const visualBox = getRelVisualBox(relId);
          if (visualBox) {
            // Use the column of the decorated message for proper edge routing
            const decoratedMid = targetRelEdges[0]?.to.messageId ?? "";
            const toCol = msgMap.get(decoratedMid)?.kind === "relation"
              ? fromEp.col  // nested relation target — fall back to source col
              : (colOf[decoratedMid] ?? fromEp.col);
            rawEdges.push({
              drawId:e.id,edge:e,fromAuthor,
              fromBox:fromEp.box,toBox:visualBox,fromCol:fromEp.col,toCol,
              fragRectCanvas:null,edgeLabelText:labelText(e,fromAuthor),expandedToEdgeId:null,
              start:{x:0,y:0},ctrl:{x:0,y:0},end:{x:0,y:0},
            });
          }
          continue;
        }

        // For annotation/reference/reply (edge-label kind): use getRelVisualBox to correctly resolve
        // the visual position of the target relation message at any level of nesting.
        // This is the same pattern used for agree/disagree above, which already handles nested
        // relation targets correctly — the arrow always points to the targeted relation message,
        // not to one of its inner endpoints.
        {
          const visualBox = getRelVisualBox(relId);
          if (visualBox) {
            rawEdges.push({
              drawId:`${e.id}__toRel__${relId}`,edge:e,fromAuthor,
              fromBox:fromEp.box,
              toBox:{x:visualBox.x,y:visualBox.y,width:visualBox.width,height:visualBox.height},
              fromCol:fromEp.col,toCol:fromEp.col,
              fragRectCanvas:null,edgeLabelText:labelText(e,fromAuthor),expandedToEdgeId:null,
              start:{x:0,y:0},ctrl:{x:0,y:0},end:{x:0,y:0},
            });
          }
        }
        continue;
      }

      const toId=e.to.messageId; if (!normalSet.has(toId)) continue;
      const toEp=endpointBoxForNormal(toId); if (!toEp) continue;
      let fragRectCanvas: DOMRect|null=null;

      if ((e.relationType==="annotation"||e.relationType==="reference") && selectionIsText(e.to.selection) && contentRefs.current[toId]) {
        const container=contentRefs.current[toId]!;
        const start=e.to.selection.start, end=start+e.to.selection.len;
        const span=container.querySelector(`[data-rel-anchor="${e.relationType}::${start}:${end}"]`) as HTMLSpanElement|null;
        if (span) { const r=span.getBoundingClientRect(); fragRectCanvas=new DOMRect(r.left-canvasRect.left,r.top-canvasRect.top,r.width,r.height); }
      }

      rawEdges.push({
        drawId:e.id,edge:e,fromAuthor,fromBox:fromEp.box,toBox:toEp.box,fromCol:fromEp.col,toCol:toEp.col,
        fragRectCanvas,edgeLabelText:labelText(e,fromAuthor),expandedToEdgeId:null,
        start:{x:0,y:0},ctrl:{x:0,y:0},end:{x:0,y:0},
      });
    }

    for (let idx=0;idx<rawEdges.length;idx++) {
      const pe=rawEdges[idx];
      const { fromBox, toBox, fromCol, toCol, fragRectCanvas, edge } = pe;
      const fromCenter={x:fromBox.x+fromBox.width/2,y:fromBox.y+fromBox.height/2};
      const toRect: Rect=fragRectCanvas ? {x:fragRectCanvas.x,y:fragRectCanvas.y,width:fragRectCanvas.width,height:fragRectCanvas.height} : {x:toBox.x,y:toBox.y,width:toBox.width,height:toBox.height};
      const toCenter={x:toRect.x+toRect.width/2,y:toRect.y+toRect.height/2};
      const vTo={x:toCenter.x-fromCenter.x,y:toCenter.y-fromCenter.y};
      const vFrom={x:fromCenter.x-toCenter.x,y:fromCenter.y-toCenter.y};

      let startP=rayRectIntersectionFirst(fromCenter.x,fromCenter.y,vTo.x,vTo.y,fromBox)??null;
      let endP=rayRectIntersectionFirst(toCenter.x,toCenter.y,vFrom.x,vFrom.y,toRect)??null;

      function chooseBest(box:Rect,dir:Point): Point|null {
        const cands=samplePerimeterCandidates(box); let best:{p:Point;score:number}|null=null;
        const cx=box.x+box.width/2,cy=box.y+box.height/2;
        for (const c of cands) {
          const dv={x:c.x-cx,y:c.y-cy};
          let diff=Math.abs(Math.atan2(dv.y,dv.x)-Math.atan2(dir.y,dir.x));
          if (diff>Math.PI) diff=2*Math.PI-diff;
          if (!best||diff<best.score) best={p:c,score:diff};
        }
        return best?.p??null;
      }

      if (!startP) {
        startP=chooseBest(fromBox,vTo);
        if (!startP) startP={x:Math.abs(vTo.x)>Math.abs(vTo.y)?(vTo.x>0?fromBox.x+fromBox.width:fromBox.x):fromCenter.x,y:Math.abs(vTo.y)>=Math.abs(vTo.x)?(vTo.y>0?fromBox.y+fromBox.height:fromBox.y):fromCenter.y};
      }
      if (!endP) {
        endP=chooseBest(toRect,vFrom);
        if (!endP) endP={x:Math.abs(vFrom.x)>Math.abs(vFrom.y)?(vFrom.x>0?toRect.x+toRect.width:toRect.x):toCenter.x,y:Math.abs(vFrom.y)>=Math.abs(vFrom.x)?(vFrom.y>0?toRect.y+toRect.height:toRect.y):toCenter.y};
      }

      const sCands=[startP,...samplePerimeterCandidates(fromBox).slice(0,12)];
      const eCands=[endP,...samplePerimeterCandidates(toRect).slice(0,12)];
      function uniq(arr:Point[]): Point[] {
        const s=new Set<string>(), r:Point[]=[];
        for (const p of arr) { const k=`${Math.round(p.x)},${Math.round(p.y)}`; if (!s.has(k)) { s.add(k); r.push(p); } }
        return r;
      }
      const sC=uniq(sCands).slice(0,24), eC=uniq(eCands).slice(0,24);

      const lC=Math.min(fromCol,toCol), rC=Math.max(fromCol,toCol);
      const gapMidX=(colX(lC)+CARD_W+colX(rC))/2;
      const fanBase=(idx-(rawEdges.length-1)/2)*6;
      const ctrlBase={x:gapMidX,y:(fromCenter.y+toCenter.y)/2+fanBase};
      const ctrlCands=[ctrlBase,...[-120,-80,-40,0,40,80,120].map(o=>({x:gapMidX+o*0.5,y:ctrlBase.y+o})),...[-120,-60,-30,30,60,120].map(ox=>({x:gapMidX+ox,y:ctrlBase.y}))];

      const connFR=[...getMessageRects(edge.from.messageId),...getMessageRects(edge.to.messageId)];
      if (fragRectCanvas) connFR.push({x:fragRectCanvas.x,y:fragRectCanvas.y,width:fragRectCanvas.width,height:fragRectCanvas.height});

      let chosenCurve:{s:Point;c:Point;e:Point}|null=null, chosenScore=Infinity, tries=0;
      outer: for (const s of sC) for (const ep of eC) for (const c of ctrlCands) {
        if (++tries>5000) break outer;
        const samps=sampleQuad(s,c,ep,36), pen=penScore(samps,connFR);
        let len=0; for (let i=1;i<samps.length;i++) len+=Math.hypot(samps[i].x-samps[i-1].x,samps[i].y-samps[i-1].y);
        const score=pen*20000+len;
        if (pen===0) { chosenCurve={s,c,e:ep}; chosenScore=score; break outer; }
        if (score<chosenScore) { chosenScore=score; chosenCurve={s,c,e:ep}; }
      }
      if (!chosenCurve) chosenCurve={s:startP,c:ctrlBase,e:endP};

      function snapBound(box:Rect,p:Point): Point {
        const e=1e-6; let x=p.x,y=p.y;
        if (Math.abs(x-box.x)<1e-5) x=box.x;
        if (Math.abs(x-(box.x+box.width))<1e-5) x=box.x+box.width;
        if (Math.abs(y-box.y)<1e-5) y=box.y;
        if (Math.abs(y-(box.y+box.height))<1e-5) y=box.y+box.height;
        const inside=x>box.x+e&&x<box.x+box.width-e&&y>box.y+e&&y<box.y+box.height-e;
        if (inside||x<box.x||x>box.x+box.width||y<box.y||y>box.y+box.height) {
          x=Math.min(Math.max(x,box.x),box.x+box.width); y=Math.min(Math.max(y,box.y),box.y+box.height);
          const dL=Math.abs(p.x-box.x),dR=Math.abs(p.x-(box.x+box.width)),dT=Math.abs(p.y-box.y),dB=Math.abs(p.y-(box.y+box.height));
          const m=Math.min(dL,dR,dT,dB);
          if (m===dL) { x=box.x; y=Math.min(Math.max(p.y,box.y),box.y+box.height); }
          else if (m===dR) { x=box.x+box.width; y=Math.min(Math.max(p.y,box.y),box.y+box.height); }
          else if (m===dT) { y=box.y; x=Math.min(Math.max(p.x,box.x),box.x+box.width); }
          else { y=box.y+box.height; x=Math.min(Math.max(p.x,box.x),box.x+box.width); }
        }
        return {x,y};
      }

      pe.start=snapBound(fromBox,chosenCurve.s); pe.ctrl=chosenCurve.c; pe.end=snapBound(toRect,chosenCurve.e);
      labelSeeds.push({drawId:pe.drawId,text:pe.edgeLabelText,p0:pe.start,p1:pe.ctrl,p2:pe.end});
    }

    const placements=computeLabelPlacementsAlongCurve({seeds:labelSeeds,forbiddenRects:globalForbiddenRects});
    setPositionedEdges(rawEdges.map(pe => ({ ...pe, labelX:(placements[pe.drawId]??quadAt(pe.start,pe.ctrl,pe.end,0.5)).x, labelY:(placements[pe.drawId]??quadAt(pe.start,pe.ctrl,pe.end,0.5)).y })));
    setDecorationRectsState(decorationRects);
    setDecorationsByMsgState(decorationsByMsg);
  }, [edges, msgMap, layout, colOf, normalIds, edgesByRelMsg, canvasWidth, canvasHeight, normals, labelBboxes, correctedEdgeIdsByRelMsg, classifyRelMsgIds, mergeCanvasReservations]);

  useEffect(() => {
    const canvasEl=canvasRef.current; if (!canvasEl) return;
    const canvasRect=canvasEl.getBoundingClientRect();
    const next: Record<string,LabelBbox>={};
    for (const pe of positionedEdges) {
      const t=textRefs.current[pe.drawId]; if (!t) continue;
      const r=t.getBoundingClientRect();
      next[pe.drawId]={x:r.left-canvasRect.left,y:r.top-canvasRect.top,width:r.width,height:r.height};
    }
    // Use a functional update with a stability check to avoid infinite re-render cycles:
    // the main useEffect now depends on labelBboxes, so we must not update state when the
    // values haven't meaningfully changed (within 0.5px).
    setLabelBboxes(prev => {
      const prevKeys=Object.keys(prev), nextKeys=Object.keys(next);
      if (prevKeys.length!==nextKeys.length) return next;
      for (const k of nextKeys) {
        if (!prev[k]) return next;
        const p=prev[k], n=next[k];
        if (Math.abs(p.x-n.x)>LABEL_BBOX_STABILITY_THRESHOLD||Math.abs(p.y-n.y)>LABEL_BBOX_STABILITY_THRESHOLD||Math.abs(p.width-n.width)>LABEL_BBOX_STABILITY_THRESHOLD||Math.abs(p.height-n.height)>LABEL_BBOX_STABILITY_THRESHOLD) return next;
      }
      return prev;
    });
  }, [positionedEdges, canvasWidth, canvasHeight]);

  function isEdgeLabelFragSel(relId:string,edgeId:string) {
    return draftUnits.some(x=>unitEquals(x,{messageId:relId,selection:{kind:"edge",edgeId}}));
  }
  function isRelWholeSel(relId:string) {
    return draftUnits.some(x=>unitEquals(x,{messageId:relId,selection:{kind:"whole"}}));
  }

  function renderContent(message: DemoMessage) {
    const targets = extractTextTargetsForMessage(message.id, edges);
    if (!targets.length) return <pre style={{margin:0,whiteSpace:"pre-wrap",fontFamily:"Menlo,Monaco,Consolas,'Courier New',monospace",fontSize:13}}>{message.content}</pre>;
    const text = message.content;
    const validItems = targets
      .filter(t => t.start >= 0 && t.start + t.len <= text.length && t.len > 0)
      .map(t => ({ start: t.start, end: t.start + t.len, relationType: t.relationType, edgeId: t.edgeId }));
    const tree = buildAnnoTree(validItems);
    const nodes = renderAnnoNodes(text, tree, 0, text.length, 0, message.id, isFragmentSelected, onFragmentAnchorClick);
    return <pre style={{margin:0,whiteSpace:"pre-wrap",fontFamily:"Menlo,Monaco,Consolas,'Courier New',monospace",fontSize:13}}>{nodes}</pre>;
  }



  return (
    <div ref={canvasRef} style={{position:"relative",width:canvasWidth,height:canvasHeight}}
      onMouseDown={e=>{const t=e.target as HTMLElement;if(!canvasRef.current)return;if(t.closest&&(t.closest("[data-msgid]")||t.closest("svg")||t.closest('[title^="relation="]')||t.closest("[data-rel-overlay]")))return;onCanvasBlankClick?.();}}>
      <div style={{position:"relative",width:canvasWidth,height:canvasHeight,zIndex:2}}>
        {normals.map(msg=>{
          const box=layout[msg.id]; if(!box) return null;
          if (hideMessageIds?.has(msg.id)) return null;
          // Corrected targets that are not themselves a correction source are invisible (replaced by the correction source card).
          // Chained correction sources remain visible so their own correction badge is preserved.
          if (hiddenCorrectedTargetIds.has(msg.id)) return null;

          // CLASSIFY relation messages are shown as topic cards (matching the list-view style).
          if (msg.kind === "relation" && classifyRelMsgIds.has(msg.id)) {
            const relEdgesForMsg = edges.filter(e => e.relationMessageId === msg.id);
            const targetCount = relEdgesForMsg.filter(e => !e.to.messageId.startsWith('anon:')).length;
            const classifyTitle = extractClassifyTopicTitle(msg.content, targetCount);
            const isWhole = draftUnits.some(u => u.messageId === msg.id && u.selection.kind === "whole");
            return (
              <div key={msg.id} data-msgid={msg.id} ref={el=>{cardRefs.current[msg.id]=el;}}
                onClick={e=>onMessageClick(e,msg.id)} onDoubleClick={e=>onMessageDoubleClick(e,msg.id)}
                onMouseDown={e=>onMessageMouseDown?.(e,msg.id)} onMouseUp={e=>onMessageMouseUp?.(e,msg.id)}
                style={{position:"absolute",left:box.x,top:box.y,width:box.width,background:"#ffffff",borderRadius:10,
                  border:isWhole?"2px solid #0b84ff":"1px solid #e5e7eb",
                  padding:"10px 12px",boxShadow:"0 4px 12px rgba(0,0,0,0.2)",display:"flex",flexDirection:"column",
                  gap:8,cursor:"pointer",outline:lastClickedMessageId===msg.id?"1px dashed #0b84ff":"none",userSelect:"auto",color:"#111827"}}>
                <div ref={el=>{headerRefs.current[msg.id]=el;}} style={{fontSize:11,opacity:0.8,display:"flex",justifyContent:"space-between"}}>
                  <span>{`分类话题 ${msg.id}`}</span>
                  <span>{"双击进入话题"}</span>
                </div>
                <div ref={el=>{contentRefs.current[msg.id]=el;}} style={{display:"flex",flexDirection:"column",gap:4}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                    <div style={{fontWeight:600,color:"#111827",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {classifyTitle}
                    </div>
                    <span style={{fontSize:11,fontWeight:600,padding:"1px 8px",borderRadius:999,background:"#dcfce7",color:"#15803d",flexShrink:0}}>
                      进行中
                    </span>
                  </div>
                  <div style={{fontSize:12,color:"#6b7280",display:"flex",gap:12,flexWrap:"wrap"}}>
                    <span>由 <span style={{fontWeight:600,color:"#4b5563"}}>{msg.author}</span> 发起</span>
                    <span>💬 {targetCount} 条观点</span>
                    <span>{new Date(msg.createdAt).toLocaleDateString('zh-CN')}</span>
                  </div>
                </div>
              </div>
            );
          }

          const isWhole=draftUnits.some(u=>u.messageId===msg.id&&u.selection.kind==="whole");
          const isText=activeTextSelectId===msg.id&&msg.kind==="normal";
          const corrBadges = correctionsBySourceMsgId.get(msg.id) ?? [];
          return (
            <div key={msg.id} data-msgid={msg.id} ref={el=>{cardRefs.current[msg.id]=el;}}
              onClick={e=>onMessageClick(e,msg.id)} onDoubleClick={e=>onMessageDoubleClick(e,msg.id)}
              onMouseDown={e=>onMessageMouseDown?.(e,msg.id)} onMouseUp={e=>onMessageMouseUp?.(e,msg.id)}
              style={{position:"absolute",left:box.x,top:box.y,width:box.width,background:"#1f1f1f",borderRadius:6,border:isText?"2px dashed #0b84ff":isWhole?"2px solid #0b84ff":"1px solid #444",padding:"12px 16px",boxShadow:isText?"0 6px 18px rgba(11,132,255,0.06)":"0 4px 10px rgba(0,0,0,0.5)",display:"flex",flexDirection:"column",gap:8,cursor:"pointer",outline:lastClickedMessageId===msg.id?"1px dashed #0b84ff":"none",userSelect:activeTextSelectId===msg.id?"text":"auto"}}>
              {/* Correction badges: for text messages, shown centered in the same header row as author/msgId */}
              <div ref={el=>{headerRefs.current[msg.id]=el;}} style={{fontSize:11,opacity:0.85,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{flex:1,display:"flex",alignItems:"center",gap:4}}>
                  {/* For non-text (relation) messages, keep badges left-aligned in header */}
                  {msg.kind!=="normal" && corrBadges.map((b) => (
                    <div key={`corr-hdr-${b.relMsgId}`}
                      data-rel-overlay="true"
                      onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,b.relMsgId);}}
                      onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,b.relMsgId);}}
                      title={`更正关系：${b.relMsgId}；单击选中，双击查看历史`}
                      style={{background:isRelWholeSel(b.relMsgId)?"rgba(200,130,0,0.95)":"rgba(170,110,0,0.9)",
                        color:"#fff",borderRadius:3,fontSize:9,padding:"0 4px",fontWeight:600,
                        cursor:"pointer",pointerEvents:"auto",
                        border:isRelWholeSel(b.relMsgId)?"1px solid rgba(255,255,255,0.5)":"1px solid rgba(255,255,255,0.15)",
                        whiteSpace:"nowrap",userSelect:"none",flexShrink:0}}>
                      ✏更正
                    </div>
                  ))}
                  <span>{msg.author}</span>
                </div>
                {/* For text messages, correction badges are centered between author and msgId,
                    with AGREE/DISAGREE mini-badges rendered inline to the right of each correction badge. */}
                {msg.kind==="normal" && corrBadges.length>0 && (
                  <div style={{flex:1,display:"flex",justifyContent:"center",gap:4,flexWrap:"wrap"}}>
                    {corrBadges.map((b) => {
                      const corrDec=relDecByRelMsgState?.get(b.relMsgId);
                      return (
                        <React.Fragment key={`corr-hdr-${b.relMsgId}`}>
                          <div
                            data-rel-overlay="true"
                            onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,b.relMsgId);}}
                            onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,b.relMsgId);}}
                            title={`更正关系：${b.relMsgId}；单击选中，双击查看历史`}
                            style={{background:isRelWholeSel(b.relMsgId)?"rgba(200,130,0,0.95)":"rgba(170,110,0,0.9)",
                              color:"#fff",borderRadius:3,fontSize:9,padding:"0 4px",fontWeight:600,
                              cursor:"pointer",pointerEvents:"auto",
                              border:isRelWholeSel(b.relMsgId)?"1px solid rgba(255,255,255,0.5)":"1px solid rgba(255,255,255,0.15)",
                              whiteSpace:"nowrap",userSelect:"none",flexShrink:0}}>
                            ✏更正
                          </div>
                          {corrDec && corrDec.agreeCount>0 && (
                            <div data-rel-overlay="true"
                              onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,b.relMsgId,"agree");}}
                              onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,b.relMsgId,"agree");}}
                              title={`赞同更正：${b.relMsgId}；单击选中，双击展开详情`}
                              style={{background:"rgba(2,150,80,0.9)",color:"#fff",borderRadius:3,fontSize:9,padding:"0 4px",
                                fontWeight:600,cursor:"pointer",pointerEvents:"auto",border:"1px solid rgba(255,255,255,0.15)",
                                whiteSpace:"nowrap",userSelect:"none",flexShrink:0}}>
                              👍{corrDec.agreeCount}
                            </div>
                          )}
                          {corrDec && corrDec.disagreeCount>0 && (
                            <div data-rel-overlay="true"
                              onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,b.relMsgId,"disagree");}}
                              onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,b.relMsgId,"disagree");}}
                              title={`反对更正：${b.relMsgId}；单击选中，双击展开详情`}
                              style={{background:"rgba(200,40,40,0.9)",color:"#fff",borderRadius:3,fontSize:9,padding:"0 4px",
                                fontWeight:600,cursor:"pointer",pointerEvents:"auto",border:"1px solid rgba(255,255,255,0.15)",
                                whiteSpace:"nowrap",userSelect:"none",flexShrink:0}}>
                              👎{corrDec.disagreeCount}
                            </div>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                )}
                <div style={{flex:1,display:"flex",justifyContent:"flex-end"}}>
                  <span style={{opacity:0.7}}>{msg.id}</span>
                </div>
              </div>
              {isText&&<div style={{fontSize:11,color:"#0b84ff",marginBottom:4}}>文本选择模式：拖选记录 start+len；或点击高亮片段</div>}
              <div ref={el=>{contentRefs.current[msg.id]=el;}} style={{fontSize:13,color:"#f5f5f5"}} onMouseUp={e=>onTextMouseUp(e,msg.id)}>
                {renderContent(msg)}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{position:"absolute",left:0,top:0,width:canvasWidth,height:canvasHeight,zIndex:4,pointerEvents:"none"}}>
        {mergeCanvasReservations.map(mc => {
          const title = `归并关系：${mc.relMsgId}；单击选中，双击展开详情`;
          const handleClick = (e: React.MouseEvent) => { e.stopPropagation(); (onGroupFrameClick ?? onMessageClick)(e, mc.relMsgId); };
          const handleDoubleClick = (e: React.MouseEvent) => { e.stopPropagation(); (onGroupFrameDoubleClick ?? onMessageDoubleClick)(e, mc.relMsgId); };
          return (
            <div key={`merge-canvas-header-${mc.relMsgId}`}
              data-rel-overlay="true"
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              title={title}
              style={{
                position:"absolute",
                left:mc.headerRect.x,
                top:mc.headerRect.y,
                width:mc.headerRect.width,
                height:mc.headerRect.height,
                borderRadius:999,
                border:"1px solid rgba(100,116,139,0.35)",
                background:"rgba(255,255,255,0.95)",
                color:"#475569",
                boxShadow:"0 6px 14px rgba(15,23,42,0.16)",
                cursor:"pointer",
                pointerEvents:"auto",
                userSelect:"none",
                display:"flex",
                alignItems:"center",
                justifyContent:"center"
              }}>
              <span style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em"}}>归并</span>
            </div>
          );
        })}
      </div>

      {/* SVG layer: supplement frame visuals + edge paths.
          Gate on either having edges or frames so frames render even with no other edges. */}
      {(positionedEdges.length>0||supplementFrames.length>0||groupFrames.length>0)&&(
        <svg width={canvasWidth} height={canvasHeight} style={{position:"absolute",left:0,top:0,zIndex:3,pointerEvents:"none"}}>
          {/* SUPPLEMENT frames — stroke and fill reflect selection state; hidden when blank-corrected */}
          {supplementFrames.map(sf=>{
            if (sf.isBlankCorrected) return null;
            const isWhole=isRelWholeSel(sf.relMsgId);
            return (
              <rect key={`supp-frame-${sf.relMsgId}`} x={sf.rect.x} y={sf.rect.y} width={sf.rect.width} height={sf.rect.height}
                rx={SUPP_FRAME_RADIUS} ry={SUPP_FRAME_RADIUS}
                fill={isWhole?"rgba(11,132,255,0.08)":"rgba(130,80,200,0.04)"}
                stroke={isWhole?"rgba(11,132,255,0.9)":"rgba(130,80,200,0.55)"}
                strokeWidth={isWhole?3:2} strokeDasharray={isWhole?undefined:"5 3"}/>
            );
          })}
          {/* GROUP frames (CLASSIFY/MERGE) and REPLACE-OVERLAY (SUMMARY); hidden when blank-corrected */}
          {groupFrames.map(gf=>{
            if (gf.isBlankCorrected) return null;
            const isWhole=isRelWholeSel(gf.relMsgId);
            const isReplaceOverlay = gf.relKind === 'replace-overlay';
            const strokeColor = isWhole
              ? 'rgba(11,132,255,0.9)'
              : (isReplaceOverlay ? (GROUP_FRAME_STROKE[gf.relColor] ?? 'rgba(180,120,0,0.7)') : (GROUP_FRAME_STROKE[gf.relColor] ?? 'rgba(140,140,150,0.55)'));
            const fillColor = isWhole ? 'rgba(11,132,255,0.06)' : isReplaceOverlay ? 'rgba(200,150,0,0.04)' : 'rgba(130,130,140,0.03)';
            return (
              <rect key={`gf-${gf.relMsgId}`} x={gf.rect.x} y={gf.rect.y} width={gf.rect.width} height={gf.rect.height}
                rx={SUPP_FRAME_RADIUS} ry={SUPP_FRAME_RADIUS}
                fill={fillColor} stroke={strokeColor}
                strokeWidth={isWhole?3:2} strokeDasharray={isReplaceOverlay?undefined:(isWhole?undefined:"6 3")}/>
            );
          })}
          {positionedEdges.map(pe=>{
            const {edge,start,ctrl,end,edgeLabelText,labelX,labelY}=pe;
            const path=`M ${start.x} ${start.y} Q ${ctrl.x} ${ctrl.y} ${end.x} ${end.y}`;
            const angle=Math.atan2(end.y-ctrl.y,end.x-ctrl.x),al=7,aa=Math.PI/7;
            const ax1=end.x-al*Math.cos(angle-aa),ay1=end.y-al*Math.sin(angle-aa),ax2=end.x-al*Math.cos(angle+aa),ay2=end.y-al*Math.sin(angle+aa);
            const color=edge.relationType==="annotation"?"rgba(255,215,0,0.92)":edge.relationType==="reference"?"rgba(80,180,255,0.92)":edge.relationType==="reply"?"rgba(160,255,140,0.72)":edge.relationType==="agree"?"rgba(2,170,90,0.92)":edge.relationType==="disagree"?"rgba(210,50,50,0.92)":"rgba(120,120,120,0.72)";
            const relId=edge.relationMessageId,isWhole=isRelWholeSel(relId),isFrag=isEdgeLabelFragSel(relId,edge.id);
            const labelOpacity=isWhole||isFrag?1:edge.relationType==="reply"?0.65:0.9;
            const labelStroke=isWhole||isFrag?"rgba(11,132,255,0.95)":"rgba(0,0,0,0.85)";
            // Blank-corrected: anon-source CORRECT targets a relation message → hide arrow/text, keep bbox for badge
            const isBlankCorrected=anonCorrectedRelMsgIds.has(relId);
            return (
              <g key={pe.drawId}>
                {!isBlankCorrected&&<path d={path} stroke={color} strokeWidth={edge.relationType==="reply"?1.0:1.2} fill="none"/>}
                {!isBlankCorrected&&<path d={`M ${ax1} ${ay1} L ${end.x} ${end.y} L ${ax2} ${ay2}`} fill={color}/>}
                {/* Text always rendered (opacity 0 when blank) so labelBboxes are stable for badge positioning */}
                <text ref={el=>{textRefs.current[pe.drawId]=el;}} x={labelX} y={labelY} fill={color} opacity={isBlankCorrected?0:labelOpacity} fontSize={10} textAnchor="middle" dominantBaseline="central" style={{paintOrder:"stroke",stroke:labelStroke,strokeWidth:isWhole||isFrag?3:2} as any}>
                  {edgeLabelText}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {/* Edge label HTML hit areas */}
      {(()=>{
        const corrRendered=new Set<string>();
        return positionedEdges.map(pe=>{
          const bb=labelBboxes[pe.drawId]; if (!bb) return null;
          const CORR_BADGE_W_EDGE=44;
          const relId=pe.edge.relationMessageId;
          // A correction badge is shown either when this relation's edge label has been corrected
          // (correctedRelMsgTargets: R1 is corrected) OR when this relation IS the replacement
          // (correctionSrcByNewRelMsg: R2 replaced R1).
          // For corrInfo: only show the badge if NO specific edge fragments were individually corrected
          // (i.e., the correction is whole-relation, not partial/fragment-level).  When specific edges
          // are marked in correctedEdgeIdsByRelMsg, those edges are already hidden from positionedEdges;
          // the remaining edges are uncorrected fragments and must NOT show the correction badge.
          const corrInfo=correctedRelMsgTargets.get(relId);
          const newCorrInfo=correctionSrcByNewRelMsg.get(relId);
          const hasCorrectedFragments=(correctedEdgeIdsByRelMsg.get(relId)?.size??0)>0;
          const showCorrBadge=((!!corrInfo?.length&&!hasCorrectedFragments)||!!newCorrInfo?.length)&&!corrRendered.has(relId);
          if (showCorrBadge) corrRendered.add(relId);
          const padX=8,padY=6;
          const extraLeft=showCorrBadge?CORR_BADGE_W_EDGE+4:0;
          const box:LayoutBox={x:bb.x-padX-extraLeft,y:bb.y-padY,width:bb.width+padX*2+extraLeft,height:bb.height+padY*2};
          const isWhole=isRelWholeSel(relId),isFrag=isEdgeLabelFragSel(relId,pe.edge.id);
          return (
            <div key={`hit-${pe.drawId}`} data-rel-overlay="true" onClick={e=>onEdgeLabelSingleClick(e,relId,pe.edge.id)} onDoubleClick={e=>onEdgeLabelDoubleClick(e,relId)}
              style={{position:"absolute",left:box.x,top:box.y,width:box.width,height:box.height,zIndex:4,cursor:"pointer",pointerEvents:"auto",background:"transparent",borderRadius:6,border:isWhole||isFrag?"1px solid rgba(11,132,255,0.85)":"1px solid transparent"}}
              title={`relation=${pe.edge.relationMessageId} edge=${pe.edge.id}`}>
              {showCorrBadge&&(()=>{
                // Prefer newCorrInfo (this relation IS the replacement) over corrInfo (this relation was corrected)
                const corrRelMsgId = newCorrInfo?.length
                  ? newCorrInfo[0].corrRelMsgId
                  : corrInfo?.length ? corrInfo[0].corrRelMsgId : null;
                if (!corrRelMsgId) return null;
                const isCorrSel=isRelWholeSel(corrRelMsgId);
                return (
                  <div key={`corr-edge-${corrRelMsgId}`}
                    onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,corrRelMsgId);}}
                    onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,corrRelMsgId);}}
                    title={`更正关系：${corrRelMsgId}；单击选中，双击查看历史`}
                    style={{position:"absolute",left:2,top:"50%",transform:"translateY(-50%)",
                      width:CORR_BADGE_W_EDGE-4,background:isCorrSel?"rgba(200,130,0,0.95)":"rgba(170,110,0,0.9)",
                      color:"#fff",borderRadius:3,fontSize:9,padding:"0 3px",fontWeight:600,
                      cursor:"pointer",pointerEvents:"auto",
                      border:isCorrSel?"1px solid rgba(255,255,255,0.5)":"1px solid rgba(255,255,255,0.15)",
                      whiteSpace:"nowrap",userSelect:"none",display:"flex",alignItems:"center",
                      justifyContent:"center",boxSizing:"border-box" as const}}>
                    ✏更正
                  </div>
                );
              })()}
            </div>
          );
        });
      })()}

      {/* Edge-label relation decoration badges — AGREE/DISAGREE + TAG badges on annotation/reference/reply
          relations, shown to the RIGHT of the edge label, stacked vertically (agree → disagree → tags). */}
      {(()=>{
        const rendered=new Set<string>();
        const items: React.ReactNode[]=[];
        for (const pe of positionedEdges) {
          // Only annotation / reference / reply carry edge-label decorations
          const rt=pe.edge.relationType;
          if (rt!=="annotation"&&rt!=="reference"&&rt!=="reply") continue;
          const bb=labelBboxes[pe.drawId]; if (!bb) continue;
          const relId=pe.edge.relationMessageId;
          if (rendered.has(relId)) continue;
          const dec=relDecByRelMsgState.get(relId);
          const tagItems=tagsByRelMsgState.get(relId)??[];
          if ((!dec||(dec.agreeCount===0&&dec.disagreeCount===0))&&tagItems.length===0) continue;
          rendered.add(relId);
          const decLeft=bb.x+bb.width+DEC_RIGHT_GAP;
          let decTop=bb.y+Math.floor((bb.height-DEC_H)/2);
          for (const kind of ["agree","disagree"] as const) {
            const count=kind==="agree"?dec?.agreeCount??0:dec?.disagreeCount??0;
            if (count<=0) continue;
            const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
            const icon=kind==="agree"?"👍":"👎";
            const label=kind==="agree"?"赞":"反";
            items.push(
              <div key={`reldec-${kind}-${relId}`} data-rel-overlay="true"
                onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,relId,kind);}}
                title={`${kind==="agree"?"赞同":"反对"}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
                style={{position:"absolute",left:decLeft,top:decTop,width:DEC_W,height:DEC_H,zIndex:5,
                  background:bgColor,color:"#fff",borderRadius:4,display:"flex",alignItems:"center",
                  fontSize:11,pointerEvents:"auto",boxShadow:"0 2px 6px rgba(0,0,0,0.5)",border:"1px solid rgba(255,255,255,0.08)",
                  overflow:"hidden"}}>
                <div onClick={ev=>{ev.stopPropagation();onDecorationIconClick?.(relId,kind);}}
                  style={{width:DEC_ICON_W,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                    cursor:"pointer",flexShrink:0,background:"rgba(0,0,0,0.15)",fontSize:12}}
                  title={`点击：快速发送${kind==="agree"?"赞同":"反对"}`}>{icon}</div>
                <div onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,relId,kind);}}
                  style={{flex:1,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:2,cursor:"pointer"}}>
                  <span style={{fontWeight:700}}>{count}</span>
                  <span style={{fontSize:9,opacity:0.85}}>{label}</span>
                </div>
              </div>
            );
            decTop+=DEC_H+DEC_GAP;
          }
          // TAG badges on this relation message — aggregated by label text
          const tagGroupMap=new Map<string,{label:string;relMsgIds:string[]}>();
          for (const {label:itemLabel,relMsgId:tagRelMsgId} of tagItems) {
            const existing=tagGroupMap.get(itemLabel);
            if (existing) { existing.relMsgIds.push(tagRelMsgId); }
            else { tagGroupMap.set(itemLabel,{label:itemLabel,relMsgIds:[tagRelMsgId]}); }
          }
          for (const {label:tagLabel,relMsgIds} of tagGroupMap.values()) {
            const count=relMsgIds.length;
            const displayLabel=count>1?`${tagLabel}（${count}人）`:tagLabel;
            const tagW=Math.max(TAG_MIN_W,displayLabel.length*8+8+28);
            const isTagSel=relMsgIds.some(id=>isRelWholeSel(id));
            items.push(
              <div key={`reltag-${relMsgIds[0]}`} data-rel-overlay="true"
                onClick={ev=>{ev.stopPropagation();onTagBodyClick?.(ev,relId,tagLabel,relMsgIds);}}
                onDoubleClick={ev=>{ev.stopPropagation();onTagDoubleClick?.(ev,relId,tagLabel,relMsgIds);}}
                title={`标注：${displayLabel}；单击选中，双击展开详情`}
                style={{position:"absolute",left:decLeft,top:decTop,width:tagW,height:TAG_H,zIndex:5,
                  background:isTagSel?"rgba(200,160,0,0.95)":"rgba(180,150,0,0.85)",color:"#fff",borderRadius:3,
                  display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,pointerEvents:"auto",
                  cursor:"pointer",padding:"0 4px",boxShadow:"0 1px 4px rgba(0,0,0,0.4)",
                  border:isTagSel?"1px solid rgba(255,255,255,0.5)":"1px solid rgba(255,255,255,0.15)",
                  whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                🏷{displayLabel}
              </div>
            );
            decTop+=TAG_H+TAG_V_GAP;
          }
        }
        return items;
      })()}

      {/* Correction-badge AGREE/DISAGREE decoration badges — shown to the RIGHT of the edge label
          for the replacement relation (R2) that carries a correction badge (✏更正).
          These decorations target the CORRECT relation message (R_correct) itself, shown next to
          the correction badge consistent with how text-message correction decorations are displayed. */}
      {(()=>{
        const corrDecRendered=new Set<string>();
        const items: React.ReactNode[]=[];
        for (const pe of positionedEdges) {
          const relId=pe.edge.relationMessageId;
          const bb=labelBboxes[pe.drawId]; if (!bb) continue;
          // Only process edge labels that ARE the replacement (correctionSrcByNewRelMsg maps R2 → correction info)
          const newCorrInfo=correctionSrcByNewRelMsg.get(relId);
          if (!newCorrInfo?.length) continue;
          if (corrDecRendered.has(relId)) continue;
          corrDecRendered.add(relId);
          const decLeft=bb.x+bb.width+DEC_RIGHT_GAP;
          // Start below any R2-targeting agree/disagree decorations already placed at this position
          const r2Dec=relDecByRelMsgState.get(relId);
          const r2Lines=((r2Dec?.agreeCount??0)>0?1:0)+((r2Dec?.disagreeCount??0)>0?1:0);
          let decTop=bb.y+Math.floor((bb.height-DEC_H)/2)+r2Lines*(DEC_H+DEC_GAP);
          for (const ci of newCorrInfo) {
            const dec=relDecByRelMsgState.get(ci.corrRelMsgId);
            if (!dec||(dec.agreeCount===0&&dec.disagreeCount===0)) continue;
            for (const kind of ["agree","disagree"] as const) {
              const count=kind==="agree"?dec.agreeCount:dec.disagreeCount;
              if (count<=0) continue;
              const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
              const icon=kind==="agree"?"👍":"👎";
              const label=kind==="agree"?"赞":"反";
              items.push(
                <div key={`corr-reldec-${kind}-${ci.corrRelMsgId}`} data-rel-overlay="true"
                  onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,ci.corrRelMsgId,kind);}}
                  title={`${kind==="agree"?"赞同":"反对"}更正：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
                  style={{position:"absolute",left:decLeft,top:decTop,width:DEC_W,height:DEC_H,zIndex:5,
                    background:bgColor,color:"#fff",borderRadius:4,display:"flex",alignItems:"center",
                    fontSize:11,pointerEvents:"auto",boxShadow:"0 2px 6px rgba(0,0,0,0.5)",border:"1px solid rgba(255,255,255,0.08)",
                    overflow:"hidden"}}>
                  <div onClick={ev=>{ev.stopPropagation();onDecorationIconClick?.(ci.corrRelMsgId,kind);}}
                    style={{width:DEC_ICON_W,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                      cursor:"pointer",flexShrink:0,background:"rgba(0,0,0,0.15)",fontSize:12}}
                    title={`点击：快速发送${kind==="agree"?"赞同":"反对"}`}>{icon}</div>
                  <div onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,ci.corrRelMsgId,kind);}}
                    style={{flex:1,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:2,cursor:"pointer"}}>
                    <span style={{fontWeight:700}}>{count}</span>
                    <span style={{fontSize:9,opacity:0.85}}>{label}</span>
                  </div>
                </div>
              );
              decTop+=DEC_H+DEC_GAP;
            }
          }
        }
        return items;
      })()}

      {/* Supplement frame border-strip hit areas — 4 thin divs at zIndex:4 covering the frame border,
          one strip per side.  Each strip is SUPP_FRAME_PAD wide (half inside, half outside the rect),
          so it exactly covers the padding zone between the visible SVG border and the message cards.
          Supplement relation messages are treated as first-class messages: single-click toggles whole
          selection (like a normal message card), double-click uses the message double-click handler.
          When isBlankCorrected, the frame border is invisible so border strips are omitted; only the
          correction badge is rendered so users can interact with the correction. */}
      {supplementFrames.map(sf=>{
        const handleClick=(e: React.MouseEvent)=>{e.stopPropagation();onMessageClick(e,sf.relMsgId);};
        const handleDblClick=(e: React.MouseEvent)=>{e.stopPropagation();onMessageDoubleClick(e,sf.relMsgId);};
        const {x,y,width,height}=sf.rect;
        const HH=SUPP_FRAME_PAD; // half-width of each border strip
        const stripBase: React.CSSProperties={position:"absolute",zIndex:4,cursor:"pointer",pointerEvents:"auto",background:"transparent"};
        const title=`补充关系：${sf.relMsgId}；单击选中，双击展开详情`;
        const sfCorrInfo=correctedRelMsgTargets.get(sf.relMsgId);
        return (
          <React.Fragment key={`supp-hit-${sf.relMsgId}`}>
            {/* Border strips — omitted when blank-corrected (no visible frame border) */}
            {!sf.isBlankCorrected&&<>
              {/* Top strip — full width including corners */}
              <div data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y-HH,width:width+HH*2,height:HH*2}}/>
              {/* Bottom strip — full width including corners */}
              <div data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y+height-HH,width:width+HH*2,height:HH*2}}/>
              {/* Left strip — between top and bottom strips */}
              <div data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y+HH,width:HH*2,height:height-HH*2}}/>
              {/* Right strip — between top and bottom strips */}
              <div data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x+width-HH,top:y+HH,width:HH*2,height:height-HH*2}}/>
            </>}
            {/* Correction badge — embedded in frame top border when this supplement is a CORRECT target */}
            {sfCorrInfo&&(()=>{
              const ci=sfCorrInfo[0];
              const isCorrSel=isRelWholeSel(ci.corrRelMsgId);
              return (
                <div key={`corr-supp-${ci.corrRelMsgId}`} data-rel-overlay="true"
                  onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,ci.corrRelMsgId);}}
                  onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,ci.corrRelMsgId);}}
                  title={`更正关系：${ci.corrRelMsgId}；单击选中，双击查看历史`}
                  style={{position:"absolute",left:x+4,top:y-HH+1,zIndex:5,
                    background:isCorrSel?"rgba(200,130,0,0.95)":"rgba(170,110,0,0.9)",
                    color:"#fff",borderRadius:3,fontSize:9,padding:"0 4px",fontWeight:600,
                    cursor:"pointer",pointerEvents:"auto",
                    border:isCorrSel?"1px solid rgba(255,255,255,0.5)":"1px solid rgba(255,255,255,0.15)",
                    whiteSpace:"nowrap",userSelect:"none",boxShadow:"0 1px 4px rgba(0,0,0,0.5)",
                    height:HH*2-2,display:"flex",alignItems:"center"}}>
                  ✏更正
                </div>
              );
            })()}
          </React.Fragment>
        );
      })}

      {/* GROUP frame hit strips (CLASSIFY/MERGE/CORRECT/SUMMARY) */}
      {groupFrames.map(gf=>{
        const handleClick=(e: React.MouseEvent)=>{e.stopPropagation();(onGroupFrameClick??onMessageClick)(e,gf.relMsgId);};
        const handleDblClick=(e: React.MouseEvent)=>{e.stopPropagation();(onGroupFrameDoubleClick??onMessageDoubleClick)(e,gf.relMsgId);};
        const {x,y,width,height}=gf.rect;
        const HH=SUPP_FRAME_PAD;
        const stripBase: React.CSSProperties={position:"absolute",zIndex:4,cursor:"pointer",pointerEvents:"auto",background:"transparent"};
        const title=gf.relType === "classify"
          ? `话题：${gf.relMsgId}；单击选中，双击进入话题`
          : `${gf.relLabel}关系：${gf.relMsgId}；单击选中，双击展开详情`;
        const gfCorrInfo=correctedRelMsgTargets.get(gf.relMsgId);
        return (
          <React.Fragment key={`gf-hit-${gf.relMsgId}`}>
            {/* Border strips — omitted when blank-corrected (no visible frame border) */}
            {!gf.isBlankCorrected&&<>
              <div data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y-HH,width:width+HH*2,height:HH*2}}/>
              <div data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y+height-HH,width:width+HH*2,height:HH*2}}/>
              <div data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y+HH,width:HH*2,height:height-HH*2}}/>
              <div data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x+width-HH,top:y+HH,width:HH*2,height:height-HH*2}}/>
            </>}
            {/* Correction badge — embedded in frame top border when this group frame is a CORRECT target */}
            {gfCorrInfo&&(()=>{
              const ci=gfCorrInfo[0];
              const isCorrSel=isRelWholeSel(ci.corrRelMsgId);
              return (
                <div key={`corr-gf-${ci.corrRelMsgId}`} data-rel-overlay="true"
                  onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,ci.corrRelMsgId);}}
                  onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,ci.corrRelMsgId);}}
                  title={`更正关系：${ci.corrRelMsgId}；单击选中，双击查看历史`}
                  style={{position:"absolute",left:x+4,top:y-HH+1,zIndex:5,
                    background:isCorrSel?"rgba(200,130,0,0.95)":"rgba(170,110,0,0.9)",
                    color:"#fff",borderRadius:3,fontSize:9,padding:"0 4px",fontWeight:600,
                    cursor:"pointer",pointerEvents:"auto",
                    border:isCorrSel?"1px solid rgba(255,255,255,0.5)":"1px solid rgba(255,255,255,0.15)",
                    whiteSpace:"nowrap",userSelect:"none",boxShadow:"0 1px 4px rgba(0,0,0,0.5)",
                    height:HH*2-2,display:"flex",alignItems:"center"}}>
                  ✏更正
                </div>
              );
            })()}
            {gf.relType === "classify" && (
              <div data-rel-overlay="true"
                onClick={handleClick}
                onDoubleClick={handleDblClick}
                title={title}
                style={{
                  position: "absolute",
                  left: x + 6,
                  // Keep the card slightly above the frame; tie offset to HH so spacing scales with frame strip size.
                  top: y - HH - Math.max(4, Math.round(HH / 2)),
                  zIndex: 5,
                  width: Math.min(280, Math.max(180, width - 24)),
                  background: "#ffffff",
                  color: "#111827",
                  borderRadius: 10,
                  border: "1px solid #e5e7eb",
                  boxShadow: "0 6px 14px rgba(0,0,0,0.22)",
                  padding: "8px 10px",
                  cursor: "pointer",
                  pointerEvents: "auto",
                  userSelect: "none",
                }}>
                {(() => {
                  const relMsg = msgMap.get(gf.relMsgId);
                  const targetTextIds = Array.from(new Set(
                    (edgesByRelMsg.get(gf.relMsgId) ?? [])
                      .filter(ed => msgMap.get(ed.to.messageId)?.kind === "normal")
                      .map(ed => ed.to.messageId)
                  ));
                  const topicTitle = extractClassifyTopicTitle(relMsg?.content, targetTextIds.length);
                  return (
                    <>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {topicTitle}
                        </span>
                        <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 999, background: "#dcfce7", color: "#15803d" }}>
                          进行中
                        </span>
                      </div>
                      <div style={{ marginTop: 4, fontSize: 10, color: "#6b7280", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>由 {relMsg?.author ?? "系统"} 发起</span>
                        <span style={{ flexShrink: 0 }}>💬 {targetTextIds.length}</span>
                        <span style={{ flexShrink: 0 }}>{relMsg ? new Date(relMsg.createdAt).toLocaleDateString('zh-CN') : ""}</span>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}
          </React.Fragment>
        );
      })}

      {/* Supplement frame decoration badges — full-size AGREE/DISAGREE badges to the RIGHT of the frame,
          styled and interactive identically to text-message decoration badges.
          Icon area: quick-send agree/disagree targeting the supplement relation message.
          Body area: toggle selection of all agree/disagree relation messages on this supplement. */}
      {supplementFrames.map(sf=>{
        const sfTagItems=tagsByRelMsgState.get(sf.relMsgId)??[];
        if (sf.relAgreeCount===0&&sf.relDisagreeCount===0&&sfTagItems.length===0) return null;
        const sfDecLeft=sf.rect.x+sf.rect.width+DEC_RIGHT_GAP;
        let sfDecTop=sf.rect.y+DEC_RIGHT_TOP;
        const nodes: React.ReactNode[]=[];
        for (const kind of ["agree","disagree"] as const) {
          const count=kind==="agree"?sf.relAgreeCount:sf.relDisagreeCount;
          if (count<=0) continue;
          const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
          const icon=kind==="agree"?"👍":"👎";
          const label=kind==="agree"?"赞":"反";
          nodes.push(
            <div key={`sf-${kind}-${sf.relMsgId}`} data-rel-overlay="true"
              onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,sf.relMsgId,kind);}}
              title={`${kind==="agree"?"赞同":"反对"}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
              style={{position:"absolute",left:sfDecLeft,top:sfDecTop,width:DEC_W,height:DEC_H,zIndex:5,
                background:bgColor,color:"#fff",borderRadius:4,display:"flex",alignItems:"center",
                fontSize:11,pointerEvents:"auto",boxShadow:"0 2px 6px rgba(0,0,0,0.5)",border:"1px solid rgba(255,255,255,0.08)",
                overflow:"hidden"}}>
              <div onClick={ev=>{ev.stopPropagation();onDecorationIconClick?.(sf.relMsgId,kind);}}
                style={{width:DEC_ICON_W,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                  cursor:"pointer",flexShrink:0,background:"rgba(0,0,0,0.15)",fontSize:12}}
                title={`点击：快速发送${kind==="agree"?"赞同":"反对"}`}>{icon}</div>
              <div onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,sf.relMsgId,kind);}}
                style={{flex:1,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:2,cursor:"pointer"}}>
                <span style={{fontWeight:700}}>{count}</span>
                <span style={{fontSize:9,opacity:0.85}}>{label}</span>
              </div>
            </div>
          );
          sfDecTop+=DEC_H+DEC_GAP;
        }
        // TAG badges on this supplement relation message — aggregated by label text
        const sfTagGroupMap=new Map<string,{label:string;relMsgIds:string[]}>();
        for (const {label:itemLabel,relMsgId:tagRelMsgId} of sfTagItems) {
          const existing=sfTagGroupMap.get(itemLabel);
          if (existing) { existing.relMsgIds.push(tagRelMsgId); }
          else { sfTagGroupMap.set(itemLabel,{label:itemLabel,relMsgIds:[tagRelMsgId]}); }
        }
        for (const {label:tagLabel,relMsgIds} of sfTagGroupMap.values()) {
          const count=relMsgIds.length;
          const displayLabel=count>1?`${tagLabel}（${count}人）`:tagLabel;
          const tagW=Math.max(TAG_MIN_W,displayLabel.length*8+8+28);
          const isTagSel=relMsgIds.some(id=>isRelWholeSel(id));
          nodes.push(
            <div key={`sftag-${relMsgIds[0]}`} data-rel-overlay="true"
              onClick={ev=>{ev.stopPropagation();onTagBodyClick?.(ev,sf.relMsgId,tagLabel,relMsgIds);}}
              onDoubleClick={ev=>{ev.stopPropagation();onTagDoubleClick?.(ev,sf.relMsgId,tagLabel,relMsgIds);}}
              title={`标注：${displayLabel}；单击选中，双击展开详情`}
              style={{position:"absolute",left:sfDecLeft,top:sfDecTop,width:tagW,height:TAG_H,zIndex:5,
                background:isTagSel?"rgba(200,160,0,0.95)":"rgba(180,150,0,0.85)",color:"#fff",borderRadius:3,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,pointerEvents:"auto",
                cursor:"pointer",padding:"0 4px",boxShadow:"0 1px 4px rgba(0,0,0,0.4)",
                border:isTagSel?"1px solid rgba(255,255,255,0.5)":"1px solid rgba(255,255,255,0.15)",
                whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
              🏷{displayLabel}
            </div>
          );
          sfDecTop+=TAG_H+TAG_V_GAP;
        }
        return <React.Fragment key={`supp-dec-${sf.relMsgId}`}>{nodes}</React.Fragment>;
      })}

      {/* GROUP frame decoration badges — AGREE/DISAGREE badges to the RIGHT of the group frame */}
      {groupFrames.map(gf=>{
        if (gf.relAgreeCount===0&&gf.relDisagreeCount===0) return null;
        const gfDecLeft=gf.rect.x+gf.rect.width+DEC_RIGHT_GAP;
        let gfDecTop=gf.rect.y+DEC_RIGHT_TOP;
        const nodes: React.ReactNode[]=[];
        for (const kind of ["agree","disagree"] as const) {
          const count=kind==="agree"?gf.relAgreeCount:gf.relDisagreeCount;
          if (count<=0) continue;
          const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
          const icon=kind==="agree"?"👍":"👎";
          const label=kind==="agree"?"赞":"反";
          nodes.push(
            <div key={`gf-${kind}-${gf.relMsgId}`} data-rel-overlay="true"
              onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,gf.relMsgId,kind);}}
              title={`${kind==="agree"?"赞同":"反对"}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
              style={{position:"absolute",left:gfDecLeft,top:gfDecTop,width:DEC_W,height:DEC_H,zIndex:5,
                background:bgColor,color:"#fff",borderRadius:4,display:"flex",alignItems:"center",
                fontSize:11,pointerEvents:"auto",boxShadow:"0 2px 6px rgba(0,0,0,0.5)",border:"1px solid rgba(255,255,255,0.08)",
                overflow:"hidden"}}>
              <div onClick={ev=>{ev.stopPropagation();onDecorationIconClick?.(gf.relMsgId,kind);}}
                style={{width:DEC_ICON_W,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                  cursor:"pointer",flexShrink:0,background:"rgba(0,0,0,0.15)",fontSize:12}}
                title={`点击：快速发送${kind==="agree"?"赞同":"反对"}`}>{icon}</div>
              <div onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,gf.relMsgId,kind);}}
                style={{flex:1,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:2,cursor:"pointer"}}>
                <span style={{fontWeight:700}}>{count}</span>
                <span style={{fontSize:9,opacity:0.85}}>{label}</span>
              </div>
            </div>
          );
          gfDecTop+=DEC_H+DEC_GAP;
        }
        return <React.Fragment key={`gf-dec-${gf.relMsgId}`}>{nodes}</React.Fragment>;
      })}

      {/* TAG decoration labels — aggregated by label text, interactive */}
      {Object.entries(tagDecorationsByMsg).map(([_mid,groups])=>
        groups.map(group=>{
          const count=group.relMsgIds.length;
          const displayLabel=count>1?`${group.label}（${count}人）`:group.label;
          const isSelected=group.relMsgIds.some(id=>isRelWholeSel(id));
          // Full-size agree/disagree decoration badges to the right of the tag badge, stacked vertically.
          // For icon click: quick-send targeting the first tag relation message in the group.
          // For body click: toggle selection of agree/disagree relations targeting any tag in the group.
          const tagBadgeRight = group.rect.x + group.rect.width;
          const tagIconRelMsgId = group.relMsgIds[0]; // first tag in group for icon-click quick-send
          // Guard: tagIconRelMsgId is always defined here (group.relMsgIds is non-empty when a group exists),
          // but the check ensures TypeScript and runtime safety.
          if (!tagIconRelMsgId) return (
            <React.Fragment key={`tag-${_mid}-${group.label}`}>
              <div
                data-rel-overlay="true"
                onClick={ev=>{ev.stopPropagation();onTagBodyClick?.(ev,_mid,group.label,group.relMsgIds);}}
                onDoubleClick={ev=>{ev.stopPropagation();onTagDoubleClick?.(ev,_mid,group.label,group.relMsgIds);}}
                style={{position:"absolute",left:group.rect.x,top:group.rect.y,width:group.rect.width,height:group.rect.height,zIndex:5,
                  background:isSelected?"rgba(200,160,0,0.95)":"rgba(180,150,0,0.85)",color:"#fff",borderRadius:3,display:"flex",alignItems:"center",
                  justifyContent:"center",fontSize:10,pointerEvents:"auto",cursor:"pointer",padding:"0 4px",
                  boxShadow:"0 1px 4px rgba(0,0,0,0.4)",border:isSelected?"1px solid rgba(255,255,255,0.5)":"1px solid rgba(255,255,255,0.15)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}
                title={`标注：${group.label}（${count}人）；单击选中，双击展开详情`}>
                🏷{displayLabel}
              </div>
            </React.Fragment>
          );
          return (
            <React.Fragment key={`tag-${_mid}-${group.label}`}>
              <div
                data-rel-overlay="true"
                onClick={ev=>{ev.stopPropagation();onTagBodyClick?.(ev,_mid,group.label,group.relMsgIds);}}
                onDoubleClick={ev=>{ev.stopPropagation();onTagDoubleClick?.(ev,_mid,group.label,group.relMsgIds);}}
                style={{position:"absolute",left:group.rect.x,top:group.rect.y,width:group.rect.width,height:group.rect.height,zIndex:5,
                  background:isSelected?"rgba(200,160,0,0.95)":"rgba(180,150,0,0.85)",color:"#fff",borderRadius:3,display:"flex",alignItems:"center",
                  justifyContent:"center",fontSize:10,pointerEvents:"auto",cursor:"pointer",padding:"0 4px",
                  boxShadow:"0 1px 4px rgba(0,0,0,0.4)",border:isSelected?"1px solid rgba(255,255,255,0.5)":"1px solid rgba(255,255,255,0.15)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}
                title={`标注：${group.label}（${count}人）；单击选中，双击展开详情`}>
                🏷{displayLabel}
              </div>
              {/* Full-size AGREE/DISAGREE decoration badges on this TAG relation group, stacked vertically */}
              {(()=>{
                const tagDecLeft=tagBadgeRight+DEC_RIGHT_GAP;
                let curTop=group.rect.y+Math.floor((group.rect.height-DEC_H)/2);
                return (["agree","disagree"] as const).map(kind=>{
                  const cnt=kind==="agree"?group.relAgreeCount:group.relDisagreeCount;
                  if (cnt<=0) return null;
                  const top=curTop; curTop+=DEC_H+DEC_GAP;
                  const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
                  const icon=kind==="agree"?"👍":"👎";
                  const label=kind==="agree"?"赞":"反";
                  return (
                    <div key={`tag-dec-${kind}-${_mid}-${group.label}`} data-rel-overlay="true"
                      onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,tagIconRelMsgId,kind);}}
                      title={`${kind==="agree"?"赞同":"反对"}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
                      style={{position:"absolute",left:tagDecLeft,top:top,width:DEC_W,height:DEC_H,zIndex:5,
                        background:bgColor,color:"#fff",borderRadius:4,display:"flex",alignItems:"center",
                        fontSize:11,pointerEvents:"auto",boxShadow:"0 2px 6px rgba(0,0,0,0.5)",border:"1px solid rgba(255,255,255,0.08)",
                        overflow:"hidden"}}>
                      <div onClick={ev=>{ev.stopPropagation();onDecorationIconClick?.(tagIconRelMsgId,kind);}}
                        style={{width:DEC_ICON_W,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                          cursor:"pointer",flexShrink:0,background:"rgba(0,0,0,0.15)",fontSize:12}}
                        title={`点击：快速发送${kind==="agree"?"赞同":"反对"}`}>{icon}</div>
                      <div onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,tagIconRelMsgId,kind);}}
                        style={{flex:1,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:2,cursor:"pointer"}}>
                        <span style={{fontWeight:700}}>{cnt}</span>
                        <span style={{fontSize:9,opacity:0.85}}>{label}</span>
                      </div>
                    </div>
                  );
                });
              })()}
            </React.Fragment>
          );
        })
      )}

      {/* Decoration badges (agree/disagree) — right side, with icon + body areas */}
      {decorationRectsState&&decorationsByMsgState&&Object.entries(decorationRectsState).map(([,v])=>{
        const counts=decorationsByMsgState[v.messageId]; if (!counts) return null;
        const cnt=v.kind==="agree"?counts.agreeCount:counts.disagreeCount;
        const bgColor=v.kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
        const icon=v.kind==="agree"?"👍":"👎";
        return (
          <div key={`dec-${v.key}`}
            data-rel-overlay="true"
            onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,v.messageId,v.kind);}}
            title={`${v.kind==="agree"?"赞同":"反对"}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
            style={{position:"absolute",left:v.rect.x,top:v.rect.y,width:v.rect.width,height:v.rect.height,zIndex:5,
              background:bgColor,color:"#fff",borderRadius:4,display:"flex",alignItems:"center",
              fontSize:11,pointerEvents:"auto",boxShadow:"0 2px 6px rgba(0,0,0,0.5)",border:"1px solid rgba(255,255,255,0.08)",
              overflow:"hidden"}}>
            {/* Icon area: click = quick send */}
            <div
              onClick={ev=>{ev.stopPropagation();onDecorationIconClick?.(v.messageId,v.kind);}}
              style={{width:DEC_ICON_W,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                cursor:"pointer",flexShrink:0,background:"rgba(0,0,0,0.15)",fontSize:12}}
              title={`点击：快速发送${v.kind==="agree"?"赞同":"反对"}`}>
              {icon}
            </div>
            {/* Body area: click = toggle selection */}
            <div
              onClick={ev=>{ev.stopPropagation();onDecorationBodyClick?.(ev,v.messageId,v.kind);}}
              style={{flex:1,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",
                gap:2,cursor:"pointer"}}>
              <span style={{fontWeight:700}}>{cnt}</span>
              <span style={{fontSize:9,opacity:0.85}}>{v.kind==="agree"?"赞":"反"}</span>
            </div>
          </div>
        );
      })}

      {/* INLINE BADGES (RECOMMEND/ARCHIVE) — small badge anchored to target message card */}
      {Array.from(inlineBadgesByMsg.entries()).map(([_mid, badges]) =>
        badges.map(badge => {
          const isWholeSel = isRelWholeSel(badge.relMsgId);
          const bg = INLINE_BADGE_COLOR[badge.relColor] ?? 'rgba(100,100,120,0.9)';
          return (
            <div key={`badge-${badge.relMsgId}`} data-rel-overlay="true"
              onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,badge.relMsgId);}}
              onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,badge.relMsgId);}}
              title={`${badge.relLabel}：${badge.relMsgId}；单击选中，双击展开操作详情`}
              style={{position:"absolute",left:badge.rect.x,top:badge.rect.y,width:badge.rect.width,height:badge.rect.height,
                zIndex:5,background:bg,color:"#fff",borderRadius:3,display:"flex",alignItems:"center",justifyContent:"center",
                fontSize:9,pointerEvents:"auto",cursor:"pointer",padding:"0 4px",boxShadow:"0 1px 4px rgba(0,0,0,0.5)",
                border:isWholeSel?"1px solid rgba(255,255,255,0.5)":"1px solid rgba(255,255,255,0.15)",
                whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",fontWeight:600}}>
              {badge.relLabel}
            </div>
          );
        })
      )}

    </div>
  );
}
