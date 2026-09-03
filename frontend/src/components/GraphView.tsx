import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DemoMessage, DemoEdge, UnitSelection, Selection, RelationType } from '../utils/modelBridge';
import { getPresentationSpec, getRelationLabel, getRelationTitle, PRESENTATION_SPECS } from '../types';
import { computeCorrectedEdgeMap, computeCorrectionVersions, computeTransitiveVoteStats, computeTransitiveRelDecStats, isContentKind } from '../utils/modelBridge';
import { computeFrameAwareColumnCorrection, compactAnnoRefClusters, convergeGroupingAndRightConstraints } from '../utils/layout';
import SettlementPanel from './SettlementPanel';
import RoundHistory from './RoundHistory';
import {
  CARD_W, MIN_CARD_H, GRID_LEFT, GRID_TOP, COL_GAP, ROW_GAP,
  CANVAS_BOTTOM_PAD, CANVAS_RIGHT_PAD, FRAME_PAD, MERGE_CARD_H,
} from '../utils/layout';
import type { PresentationKind, Relation, RelationTargetLayout } from '../types';

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
const TAG_HIT_PAD = 14;  // extra transparent padding around tag hit area so tags are easy to click even when overlapping frames (> FRAME_PAD=12 so tag hit area fully covers frame border strip overlap)
// Frame constants (shared by arrange, classify, merge, summary frames)
// FRAME_PAD is imported from ../utils/layout
const FRAME_PAD_X = GRID_LEFT;  // 18 — horizontal padding inside frame
const FRAME_PAD_Y = FRAME_PAD;  // 16 — keep category content close to its frame header
const FRAME_RADIUS = 8; // border-radius of group frames
const MAX_RELATION_NESTING_DEPTH = 10; // guard against infinite recursion when resolving nested relation visual boxes
const LABEL_BBOX_STABILITY_THRESHOLD = 0.5; // px — label bbox changes smaller than this are treated as stable
const MERGE_CANVAS_LABEL_H = 24;
const MERGE_HEADER_MIN_W = 56;
const MERGE_HEADER_MAX_W = 320;
const MERGE_CANVAS_LABEL_LEFT_OFFSET = 10;
const MERGE_CANVAS_LABEL_TOP_OFFSET = 8;
const MERGE_CANVAS_STACK_GAP = ROW_GAP;
const MERGE_CONTENT_TOP_GAP = 8;
const MERGE_CARD_HEADER_X_OFFSET = 8;
const MERGE_CARD_HEADER_Y_OFFSET = 8;
// Approximate per-character width for mixed Chinese/Latin short titles in the current 12px header style.
const MERGE_LABEL_CHAR_WIDTH_ESTIMATE = 14;
const MERGE_LABEL_HORIZONTAL_PADDING = 24;
const GROUP_HEADER_MIN_W = 180;
const GROUP_HEADER_MAX_W = 320;
const GROUP_HEADER_X_OFFSET = 6;
const GROUP_HEADER_HEIGHT = 56;
// MERGE_CARD_H is imported from ../utils/layout

// Shared empty set for fallback


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
  isTargetHintFrag?: (id: string, start: number, len: number, relationType: RelationType) => boolean,
): React.ReactNode[] {
  const selectedStyles = [
    {
      bg: "rgba(11,132,255,0.24)",
      outline: "2px solid rgba(11,132,255,0.95)",
      ring: "inset 0 0 0 1px rgba(147,197,253,0.7)",
    },
    {
      bg: "rgba(56,189,248,0.28)",
      outline: "2px dashed rgba(56,189,248,0.95)",
      ring: "inset 0 0 0 1px rgba(125,211,252,0.78)",
    },
    {
      bg: "rgba(14,165,233,0.32)",
      outline: "2px dotted rgba(14,165,233,0.98)",
      ring: "inset 0 0 0 1px rgba(103,232,249,0.86)",
    },
  ] as const;
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
    const isTargetHint = !selected && (isTargetHintFrag?.(messageId, node.start, len, node.relationType) ?? false);
    const isInner = depth > 0;
    const selectedStyle = selectedStyles[Math.min(depth, selectedStyles.length - 1)];
    const bgColor = selected
      ? selectedStyle.bg
      : isTargetHint
        ? (isInner ? "rgba(16,185,129,0.20)" : "rgba(16,185,129,0.12)")
      : isInner
        ? (isAnno ? "rgba(255,220,0,0.30)" : "rgba(80,180,255,0.20)")
        : (isAnno ? "rgba(255,255,0,0.12)" : "rgba(80,180,255,0.08)");
    const outlineStyle = selected
      ? selectedStyle.outline
      : isTargetHint
        ? "2px dashed rgba(16,185,129,0.95)"
      : isInner
        ? (isAnno ? "2px solid rgba(255,210,0,0.95)" : "2px solid rgba(80,180,255,0.85)")
        : (isAnno ? "1px solid rgba(255,255,0,0.8)" : "1px solid rgba(80,180,255,0.45)");
    const innerContent = node.children.length > 0
      ? renderAnnoNodes(text, node.children, node.start, node.end, depth + 1, messageId, isFragSel, onFragClick, isTargetHintFrag)
      : text.slice(node.start, node.end);
    result.push(
      <span key={`h-${node.start}-${node.end}`}
        data-rel-anchor={`${node.relationType}::${node.start}:${node.end}`}
        onClick={e => { e.stopPropagation(); onFragClick(messageId, node.start, len, frag); }}
        title="点击：进入文本选择状态并切换选中该片段"
        style={{whiteSpace:"pre-wrap",cursor:"pointer",position:"relative",zIndex:isInner?Math.min(9,1+depth):undefined,
          backgroundColor:bgColor,outline:outlineStyle,borderRadius:2,
          boxShadow:selected?selectedStyle.ring:(isTargetHint?"inset 0 0 0 1px rgba(110,231,183,0.85)":undefined)}}
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

/** True for relation types that use the arrange-frame kind specifically. */
function isArrangeFrameRel(relType: string): boolean {
  return getRelKind(relType) === 'arrange-frame';
}

/** True for relation types that render as a frame (arrange-frame OR frame-group OR replace-overlay). */
function isAnyFrameRel(relType: string): boolean {
  const k = getRelKind(relType);
  return k === 'arrange-frame' || k === 'frame-group' || k === 'replace-overlay';
}

/** True for correction-badge relations (CORRECT): badge inside source card, same-column stacking. */
function isCorrectionBadgeRel(relType: string): boolean {
  return getRelKind(relType) === 'correction-badge';
}

type RelationBounds = { rect: LayoutBox; cardIds: Set<string> };
type MergeCanvasReservation = { relMsgId: string; rect: Rect; contentRect: Rect; headerRect: Rect; cardIds: Set<string> };
type FrameAvoidanceReservation = { relMsgId: string; rect: Rect; cardIds: Set<string>; headerTopPad?: number };

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

/** Resolve the merge header text with fallback priority: payload title → payload label → relation type label. */
function getMergeHeaderText(msg: DemoMessage | undefined): string {
  if (!msg) return getPresentationSpec('merge').label;
  return getRelationTitle(msg.relationPayload)
    ?? getRelationLabel(msg.relationPayload)
    ?? getPresentationSpec(msg.relationType ?? 'merge').label;
}

/** Estimate adaptive merge-header width from the rendered title/label text length. */
function getMergeHeaderWidth(text: string): number {
  const estimated = Math.round(text.length * MERGE_LABEL_CHAR_WIDTH_ESTIMATE + MERGE_LABEL_HORIZONTAL_PADDING);
  return Math.max(MERGE_HEADER_MIN_W, Math.min(MERGE_HEADER_MAX_W, estimated));
}

/** Compute the floating header card rect shown above classify/merge/summary group frames. */
function getGroupHeaderHeight(measuredHeights: Record<string, number>, relMsgId: string): number {
  return Math.max(GROUP_HEADER_HEIGHT, measuredHeights[relMsgId] ?? GROUP_HEADER_HEIGHT);
}

function getGroupHeaderRect(frameRect: Rect, height = GROUP_HEADER_HEIGHT): Rect {
  return {
    x: frameRect.x + GROUP_HEADER_X_OFFSET,
    y: frameRect.y - height,
    width: Math.min(GROUP_HEADER_MAX_W, Math.max(GROUP_HEADER_MIN_W, frameRect.width - 24)),
    height,
  };
}

/** Compute the card-style header rect for MERGE group frames, positioned inside the frame at the top-left. */
function getMergeCardHeaderRect(frameRect: Rect): Rect {
  return {
    x: frameRect.x + MERGE_CARD_HEADER_X_OFFSET,
    y: frameRect.y + MERGE_CARD_HEADER_Y_OFFSET,
    width: Math.min(GROUP_HEADER_MAX_W, Math.max(GROUP_HEADER_MIN_W, frameRect.width - 24)),
    height: MERGE_CARD_H,
  };
}

function getRelationBoundsFromLayout(params: {
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
  // (classify/summary topic card).  Its own box is not covered by the edge endpoints
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

export function buildMergeCanvasReservations(params: {
  edges: DemoEdge[];
  layout: Record<string, LayoutBox>;
  msgMap: Map<string, DemoMessage>;
  relationCardMsgIds: Set<string>;
}): MergeCanvasReservation[] {
  const { edges, layout, msgMap, relationCardMsgIds } = params;
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
      if (targetMsg?.kind === "relation") {
        const nested = getRelationBoundsFromLayout({ relMsgId: edge.to.messageId, edgesByRelMsg, layout, msgMap, relationCardMsgIds });
        if (nested) {
          boxes.push(nested.rect);
          nested.cardIds.forEach(id => cardIds.add(id));
          continue;
        }
      }
      const targetBox = layout[edge.to.messageId];
      if (targetBox && (targetMsg && isContentKind(targetMsg.kind) || relationCardMsgIds.has(edge.to.messageId))) {
        boxes.push(targetBox);
        cardIds.add(edge.to.messageId);
      }
    }
    const contentUnion = unionBoxes(boxes);
    if (!contentUnion) continue;
    const headerWidth = getMergeHeaderWidth(getMergeHeaderText(msgMap.get(relMsgId)));
    // Left FRAME_PAD is preserved; card x-shifting in applyFrameAvoidanceReservations
    // ensures the merge canvas left border aligns with text message cards outside the frame.
    const contentRect = {
      x: contentUnion.x - FRAME_PAD,
      y: contentUnion.y - FRAME_PAD,
      width: contentUnion.width + FRAME_PAD * 2,
      height: contentUnion.height + FRAME_PAD * 2,
    };
    const headerRect = {
      x: contentRect.x + MERGE_CANVAS_LABEL_LEFT_OFFSET,
      y: contentRect.y - MERGE_CANVAS_LABEL_TOP_OFFSET,
      width: headerWidth,
      height: MERGE_CANVAS_LABEL_H,
    };
    reservations.push({
      relMsgId,
      contentRect,
      headerRect,
      rect: {
        x: contentRect.x,
        y: headerRect.y,
        width: Math.max(contentRect.width, headerRect.x + headerRect.width - contentRect.x),
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
  edgesByRelMsg: Map<string, DemoEdge[]>;
  msgMap: Map<string, DemoMessage>;
  relationCardMsgIds: Set<string>;
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
  const sortIdsByY = (ids: string[]) => ids.sort((a, b) => (nextLayout[a]?.y ?? 0) - (nextLayout[b]?.y ?? 0));

  // ── Identify cards that belong to inner relation frames ──
  // Any relation message that is targeted by a merge edge has its member
  // cards managed by computeNoOverlapLayout (or the relation's own layout).
  // The merge must not move them individually — their relative positions
  // are determined by the inner relation, not by the merge compaction.
  const innerFrameCards = new Map<string, Set<string>>();   // innerFrameRelMsgId → cardIds
  const innerFrameCardSet = new Set<string>();               // all cards in any inner frame

  for (const [relMsgId] of params.edgesByRelMsg) {
    if (innerFrameCards.has(relMsgId)) continue;
    const relMsg = params.msgMap.get(relMsgId);
    if (!relMsg || relMsg.kind !== 'relation') continue;
    // Check whether this relation is a direct or indirect target of a merge edge.
    // We intentionally do NOT filter by presentation kind — custom relation types
    // (e.g. 'supp') may form frames without being in PRESENTATION_SPECS.
    const isMergeTarget = Array.from(params.edgesByRelMsg.values()).some(edges =>
      edges.some(e => e.relationType === 'merge' && e.to.messageId === relMsgId)
    );
    if (!isMergeTarget) continue;

    const innerBounds = getRelationBoundsFromLayout({
      relMsgId,
      edgesByRelMsg: params.edgesByRelMsg,
      layout: params.layout,  // use ORIGINAL layout to identify members
      msgMap: params.msgMap,
      relationCardMsgIds: params.relationCardMsgIds,
    });
    if (!innerBounds || innerBounds.cardIds.size === 0) continue;

    innerFrameCards.set(relMsgId, innerBounds.cardIds);
    for (const cid of innerBounds.cardIds) {
      innerFrameCardSet.add(cid);
    }
  }

  function computeCurrentReservationRect(reservation: MergeCanvasReservation): Rect {
    const boxes: LayoutBox[] = [];
    const seenInnerFrames = new Set<string>();
    reservation.cardIds.forEach(id => {
      if (innerFrameCardSet.has(id)) {
        // Inner-frame card: defer to the frame-level bounding box
        const innerFrameId = [...innerFrameCards.entries()]
          .find(([, cids]) => cids.has(id))?.[0];
        if (innerFrameId && !seenInnerFrames.has(innerFrameId)) {
          seenInnerFrames.add(innerFrameId);
          const frameCardIds = innerFrameCards.get(innerFrameId);
          if (frameCardIds) {
            const frameUnion = unionBoxes(
              [...frameCardIds].map(cid => nextLayout[cid]).filter(Boolean) as LayoutBox[]
            );
            if (frameUnion) {
              boxes.push({
                x: frameUnion.x - FRAME_PAD,
                y: frameUnion.y - FRAME_PAD,
                width: frameUnion.width + FRAME_PAD * 2,
                height: frameUnion.height + FRAME_PAD * 2,
              });
            }
          }
        }
        return;
      }
      const box = nextLayout[id];
      if (box) boxes.push(box);
    });
    const union = unionBoxes(boxes);
    if (!union) return reservation.rect;
    const contentRect = {
      x: union.x - FRAME_PAD,
      y: union.y - FRAME_PAD,
      width: union.width + FRAME_PAD * 2,
      height: union.height + FRAME_PAD * 2,
    };
    const headerRect = {
      x: contentRect.x + MERGE_CANVAS_LABEL_LEFT_OFFSET,
      y: contentRect.y - MERGE_CANVAS_LABEL_TOP_OFFSET,
      width: reservation.headerRect.width,
      height: MERGE_CANVAS_LABEL_H,
    };
    return {
      x: contentRect.x,
      y: headerRect.y,
      width: Math.max(contentRect.width, headerRect.x + headerRect.width - contentRect.x),
      height: contentRect.y + contentRect.height - headerRect.y,
    };
  }

  const finalReservationRects: Rect[] = [];
  for (const reservation of params.reservations) {
    // Compact ONLY direct merge-target cards upward within each column.
    // Cards inside inner relation frames are skipped — their layout is
    // determined by computeNoOverlapLayout and must not be altered here.
    for (const ids of byCol.values()) {
      sortIdsByY(ids);
      let cursor = GRID_TOP;
      for (const id of ids) {
        const box = nextLayout[id];
        if (!box) continue;
        if (!reservation.cardIds.has(id)) {
          cursor = Math.max(cursor, box.y + box.height + ROW_GAP);
          continue;
        }
        // Skip cards belonging to inner relation frames
        if (innerFrameCardSet.has(id)) {
          cursor = Math.max(cursor, box.y + box.height + ROW_GAP);
          continue;
        }
        // Compact upward only: never push a reserved target further down.
        const nextY = box.y > cursor ? cursor : box.y;
        nextLayout[id] = { ...box, y: nextY };
        cursor = nextLayout[id].y + nextLayout[id].height + ROW_GAP;
      }
    }

    const reservationRect = computeCurrentReservationRect(reservation);
    finalReservationRects.push(reservationRect);
    for (const ids of byCol.values()) {
      sortIdsByY(ids);
      let cursor = reservationRect.y + reservationRect.height + MERGE_CANVAS_STACK_GAP;
      for (const id of ids) {
        const box = nextLayout[id];
        if (!box || reservation.cardIds.has(id)) continue;
        if (!rectsOverlapX(box, reservationRect)) continue;
        if (box.y + box.height <= reservationRect.y) continue;
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
  for (const reservationRect of finalReservationRects) maxBottom = Math.max(maxBottom, reservationRect.y + reservationRect.height);

  return { layout: nextLayout, canvasHeight: maxBottom + CANVAS_BOTTOM_PAD };
}

export function buildFrameAvoidanceReservations(params: {
  edges: DemoEdge[];
  layout: Record<string, LayoutBox>;
  msgMap: Map<string, DemoMessage>;
  relationCardMsgIds: Set<string>;
  frameRects?: Record<string, Rect>;
}): FrameAvoidanceReservation[] {
  const { edges, layout, msgMap, relationCardMsgIds, frameRects } = params;
  const edgesByRelMsg = new Map<string, DemoEdge[]>();
  for (const edge of edges) {
    const arr = edgesByRelMsg.get(edge.relationMessageId) ?? [];
    arr.push(edge);
    edgesByRelMsg.set(edge.relationMessageId, arr);
  }
  const reservations: FrameAvoidanceReservation[] = [];
  for (const [relMsgId, relEdges] of edgesByRelMsg) {
    if (relEdges.length === 0) continue;
    const relKind = getRelKind(relEdges[0].relationType);
    if (relKind !== 'arrange-frame' && relKind !== 'frame-group' && relKind !== 'replace-overlay') continue;
    const boxes: LayoutBox[] = [];
    const cardIds = new Set<string>();
    const sourceId = relEdges[0].from.messageId;
    if (!sourceId.startsWith('anon:')) {
      const sourceMsg = msgMap.get(sourceId);
      const sourceBox = layout[sourceId];
      if (sourceBox && (sourceMsg && isContentKind(sourceMsg.kind) || relationCardMsgIds.has(sourceId))) {
        boxes.push(sourceBox);
        cardIds.add(sourceId);
      }
    }
    for (const edge of relEdges) {
      const targetMsg = msgMap.get(edge.to.messageId);
      if (targetMsg?.kind === 'relation') {
        const nested = getRelationBoundsFromLayout({
          relMsgId: edge.to.messageId,
          edgesByRelMsg,
          layout,
          msgMap,
          relationCardMsgIds,
        });
        if (nested) {
          boxes.push(nested.rect);
          nested.cardIds.forEach(id => cardIds.add(id));
          // Also include the relation-message card itself (e.g. classify/summary
          // topic card) so it stays inside the frame rather than being pushed
          // below by applyFrameAvoidanceReservations.
          if (relationCardMsgIds.has(edge.to.messageId)) {
            const cardBox = layout[edge.to.messageId];
            if (cardBox) boxes.push(cardBox);
            cardIds.add(edge.to.messageId);
          }
          continue;
        }
      }
      const targetBox = layout[edge.to.messageId];
      if (targetBox && (targetMsg && isContentKind(targetMsg.kind) || relationCardMsgIds.has(edge.to.messageId))) {
        boxes.push(targetBox);
        cardIds.add(edge.to.messageId);
      }
    }
    const union = unionBoxes(boxes);
    if (!union) continue;
    // For MERGE frames, reserve extra space above the frame content for the card-style header.
    // Must match the GROUP_HEADER_HEIGHT used in the group frame rendering (line ~1751)
    // so the reservation exactly covers the rendered frame + merge card header.
    // Left FRAME_PAD is preserved; card x-shifting in applyFrameAvoidanceReservations
    // ensures the frame left border aligns with text message cards outside the frame.
    const isMergeFrame = relEdges[0].relationType === "merge";
    const headerTopPad = isMergeFrame ? MERGE_CARD_H + FRAME_PAD + MERGE_CONTENT_TOP_GAP : 0;
    const layoutFrameRect = frameRects?.[relMsgId];
    reservations.push({
      relMsgId,
      cardIds,
      headerTopPad: isMergeFrame ? headerTopPad : undefined,
      rect: layoutFrameRect ?? {
        // Keep avoidance aligned with the rendered frame. Arrange/group frames
        // use GRID_LEFT/GRID_TOP as their internal horizontal/vertical padding.
        x: union.x - FRAME_PAD_X,
        y: union.y - FRAME_PAD_Y - headerTopPad,
        width: union.width + FRAME_PAD_X * 2,
        height: union.height + FRAME_PAD_Y * 2 + headerTopPad,
      },
    });
  }
  reservations.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  return reservations;
}

/** Apply frame-avoidance: push cards that overlap merge frames below them,
 *  and compute final canvas height.  Frame blocks are already placed by
 *  computeNoOverlapLayout; this function acts as a safety net for collisions. */
function applyFrameAvoidanceReservations(params: {
  layout: Record<string, LayoutBox>;
  normals: DemoMessage[];
  colOf: Record<string, number>;
  reservations: FrameAvoidanceReservation[];
  minCanvasHeight: number;
  msgMap: Map<string, DemoMessage>;
  edgesByRelMsg: Map<string, DemoEdge[]>;
  relationCardMsgIds: Set<string>;
}) {
  const nextLayout: Record<string, LayoutBox> = {};
  for (const [id, box] of Object.entries(params.layout)) nextLayout[id] = { ...box };

  // Rebuild the reservation from the current member positions.  Earlier frame
  // avoidance may have moved a card that also belongs to a later frame, so the
  // later frame must be checked against its updated bounds.
  function currentReservationRect(reservation: FrameAvoidanceReservation): Rect {
    // Frame rectangles are atomic layout units. Their member cards are
    // protected from movement, so rebuilding the rect from cards would only
    // reintroduce coordinate drift for nested frames.
    return reservation.rect;
  }

  const protectedCardIds = new Set<string>();
  for (const reservation of params.reservations) {
    for (const id of reservation.cardIds) protectedCardIds.add(id);
  }

  // Treat every frame as an opaque layout unit. Only cards outside the frame
  // are candidates for movement; members move only with their own frame.
  for (const reservation of params.reservations) {
    const rect = currentReservationRect(reservation);
    const frameBottom = rect.y + rect.height;

    // Collect all horizontally overlapping external cards, sorted by their
    // current y. Keeping cards below the frame in the sequence makes a moved
    // card push its own followers instead of creating a second overlap.
    const toPush: { id: string; box: LayoutBox }[] = [];
    for (const [id, box] of Object.entries(nextLayout)) {
      if (reservation.cardIds.has(id)) continue;
      if (box.x + box.width <= rect.x || rect.x + rect.width <= box.x) continue;
      if (box.y + box.height <= rect.y) continue;
      toPush.push({ id, box });
    }
    toPush.sort((a, b) => a.box.y - b.box.y);

    let pushY = frameBottom + ROW_GAP;
    for (const { id, box } of toPush) {
      const nextY = Math.max(box.y, pushY);
      nextLayout[id] = { ...box, y: nextY };
      pushY = nextY + box.height + ROW_GAP;
    }

  }

  // Frame avoidance may leave intentional whitespace. Do not rebuild columns
  // or run a global chronological cascade here: both operations destroy the
  // shorter directed-edge placement computed earlier.

  let maxBottom = GRID_TOP;
  for (const box of Object.values(nextLayout)) maxBottom = Math.max(maxBottom, box.y + box.height);
  return { layout: nextLayout, canvasHeight: Math.max(params.minCanvasHeight, maxBottom + CANVAS_BOTTOM_PAD) };
}

function computeMinColumnsForAnnoRefRule1(normalIds: string[], edges: DemoEdge[], relIds: Set<string>) {
  const normalSet = new Set(normalIds);
  const relevant = edges.filter(
    (e) => (e.relationType === "annotation" || e.relationType === "reference" || e.relationType === "notify") &&
      normalSet.has(e.from.messageId) && normalSet.has(e.to.messageId)
  );
  const toRelEdges = edges.filter(
    (e) => (e.relationType === "annotation" || e.relationType === "reference" || e.relationType === "notify") &&
      normalSet.has(e.from.messageId) && relIds.has(e.to.messageId)
  );
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
  const relEdgesByRelMsgForReply = new Map<string, DemoEdge[]>();
  for (const e of edges) {
    const arr = relEdgesByRelMsgForReply.get(e.relationMessageId) ?? [];
    arr.push(e);
    relEdgesByRelMsgForReply.set(e.relationMessageId, arr);
  }
  for (const e of edges) {
    if (!(e.relationType === "annotation" || e.relationType === "reference" || e.relationType === "notify")) continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    const need = (col[e.to.messageId] ?? 0) + 1;
    minAllowed[e.from.messageId] = Math.max(minAllowed[e.from.messageId] ?? 0, need);
  }
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

  // Propagate right-shift constraints after reply placement.
  // Annotation/reference/notify sources must remain at least target+1;
  // reply edges do not cascade so same-author reply chains can return to one lane.
  const sourcesByTarget = new Map<string, string[]>();
  for (const e of edges) {
    if (e.relationType !== "annotation" && e.relationType !== "reference" && e.relationType !== "notify") continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    const arr = sourcesByTarget.get(e.to.messageId) ?? [];
    arr.push(e.from.messageId);
    sourcesByTarget.set(e.to.messageId, arr);
  }
  const queue: string[] = [];
  const queued = new Set<string>();
  for (const m of normals) {
    const id = m.id;
    if ((col[id] ?? 0) > (baseCol[id] ?? 0)) {
      queue.push(id);
      queued.add(id);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const targetId = queue[qi++];
    const targetCol = col[targetId] ?? 0;
    const sources = sourcesByTarget.get(targetId) ?? [];
    for (const fromId of sources) {
      const need = targetCol + 1;
      if ((col[fromId] ?? 0) < need) {
        col[fromId] = need;
        maxCol = Math.max(maxCol, need);
        if (!queued.has(fromId)) {
          queued.add(fromId);
          queue.push(fromId);
        }
      }
    }
  }

  return { col, maxCol };
}

/**
 * High-priority grouping column rule.
 *
 * Applies to ALL relation types with `groupsTargets=true` (arrange-frame, frame-group)
 * and to replace-overlay types that also group targets (SUMMARY).
 * For CORRECT (correction-badge), only the source→target pair is handled (no frame).
 *
 * Rules:
 *   - Source message (if real, not anon:) → same column as its first target.
 *   - No-source framing relations with multiple targets → all targets chained into the same column,
 *     except MERGE which keeps its natural multi-column layout.
 *   - All framing-type relations (arrange-frame, frame-group, replace-overlay) participate.
 *   - correction-badge (CORRECT) also uses same-column stacking without a frame.
 */
export function applyGroupingColumnOverride(params: {
  normals: DemoMessage[];
  edges: DemoEdge[];
  col: Record<string, number>;
  maxCol: number;
}): { col: Record<string, number>; maxCol: number; groupSourceToTarget: Map<string, string> } {
  const { normals, edges } = params;
  const col = { ...params.col };
  const normalSet = new Set(normals.map(m => m.id));
  const msgById = new Map(normals.map(m => [m.id, m]));
  const createdAtMs = (messageId: string): number => {
    const raw = msgById.get(messageId)?.createdAt;
    if (!raw) return Number.POSITIVE_INFINITY;
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  const groupSourceToTarget = new Map<string, string>();
  for (const e of edges) {
    if (!isAnyFrameRel(e.relationType) && !isCorrectionBadgeRel(e.relationType)) continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    if (!groupSourceToTarget.has(e.from.messageId)) {
      groupSourceToTarget.set(e.from.messageId, e.to.messageId);
    }
  }
  const frameTargetsByRelMsg = new Map<string, { targetIds: string[]; relationType: string }>();
  for (const e of edges) {
    if (!isAnyFrameRel(e.relationType) && !isCorrectionBadgeRel(e.relationType)) continue;
    if (!normalSet.has(e.to.messageId)) continue;
    const entry = frameTargetsByRelMsg.get(e.relationMessageId) ?? { targetIds: [], relationType: e.relationType };
    entry.targetIds.push(e.to.messageId);
    frameTargetsByRelMsg.set(e.relationMessageId, entry);
  }
  for (const [, { targetIds, relationType }] of frameTargetsByRelMsg) {
    if (relationType === 'merge') continue;
    if (targetIds.length < 2) continue;
    targetIds.sort((a, b) => createdAtMs(a) - createdAtMs(b));
    for (let i = 1; i < targetIds.length; i++) {
      if (!groupSourceToTarget.has(targetIds[i])) {
        groupSourceToTarget.set(targetIds[i], targetIds[i - 1]);
      }
    }
  }
  let changed = true, iter = 0;
  while (changed && iter < 1000) {
    changed = false; iter++;
    for (const [srcId, tgtId] of groupSourceToTarget) {
      const tgtCol = col[tgtId] ?? 0;
      if ((col[srcId] ?? 0) !== tgtCol) { col[srcId] = tgtCol; changed = true; }
    }
  }

  const converged = convergeGroupingAndRightConstraints({
    normals,
    edges,
    col,
    groupSourceToTarget,
  });

  // Restore reply author lanes after structural convergence. Explicit grouping
  // and non-reply right-side constraints keep their higher priority.
  const replySources = new Set<string>();
  const replyTargetsBySource = new Map<string, number[]>();
  for (const e of edges) {
    if (e.relationType !== 'reply' || !normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    replySources.add(e.from.messageId);
    const targets = replyTargetsBySource.get(e.from.messageId) ?? [];
    targets.push(converged.col[e.to.messageId] ?? 0);
    replyTargetsBySource.set(e.from.messageId, targets);
  }
  const authorColumns = new Map<string, number[]>();
  for (const message of normals) {
    const columns = authorColumns.get(message.author) ?? [];
    columns.push(converged.col[message.id] ?? 0);
    authorColumns.set(message.author, columns);
  }
  const authorLane = (columns: number[]): number => {
    const counts = new Map<number, number>();
    for (const column of columns) counts.set(column, (counts.get(column) ?? 0) + 1);
    let best = columns[0] ?? 0;
    for (const [column, count] of counts) {
      if (count > (counts.get(best) ?? 0) || (count === (counts.get(best) ?? 0) && column < best)) best = column;
    }
    return best;
  };
  for (const message of normals) {
    if (!replySources.has(message.id) || groupSourceToTarget.has(message.id)) continue;
    const targetColumns = replyTargetsBySource.get(message.id) ?? [];
    const forbidden = new Set(targetColumns);
    const lane = authorLane(authorColumns.get(message.author) ?? [0]);
    if (forbidden.has(lane)) continue;
    let preferred = lane;
    while (forbidden.has(preferred)) preferred++;
    const minColumn = edges
      .filter(e => (e.relationType === 'annotation' || e.relationType === 'reference' || e.relationType === 'notify') && e.from.messageId === message.id && normalSet.has(e.to.messageId))
      .reduce((min, e) => Math.max(min, (converged.col[e.to.messageId] ?? 0) + 1), 0);
    converged.col[message.id] = Math.max(preferred, minColumn);
  }
  const maxCol = Math.max(0, ...Object.values(converged.col));
  return { col: converged.col, maxCol, groupSourceToTarget };
}

/**
 * Apply AGREE/DISAGREE layout column rules:
 *   AGREE source → one column to the left of target
 *   DISAGREE source → one column to the right of target (visually contrasted)
 *   If AGREE target is too far left to host a left-side source, move target right
 *   and propagate right-side constraints (annotation/reference/notify/reply).
 *
 * Only applies when both source and target are normal (text) messages.
 * Pure-stance (anon: source) or relation-message targets are skipped.
 *
 * Right-side constraints are respected: if a message is also a
 * annotation/reference/notify/reply source it will not be placed to the left
 * of its constrained targets.
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

  const rightMinCol: Record<string, number> = {};
  const rightSourcesByTarget = new Map<string, string[]>();
  for (const e of edges) {
    if (
      e.relationType !== "annotation" &&
      e.relationType !== "reference" &&
      e.relationType !== "notify" &&
      e.relationType !== "reply"
    ) continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    const need = (col[e.to.messageId] ?? 0) + 1;
    rightMinCol[e.from.messageId] = Math.max(rightMinCol[e.from.messageId] ?? 0, need);
    const arr = rightSourcesByTarget.get(e.to.messageId) ?? [];
    arr.push(e.from.messageId);
    rightSourcesByTarget.set(e.to.messageId, arr);
  }

  const propagateRightDependents = (startTargetIds: string[]) => {
    const queue = [...startTargetIds];
    const queued = new Set(queue);
    let qi = 0;
    while (qi < queue.length) {
      const targetId = queue[qi++];
      const targetCol = col[targetId] ?? 0;
      const sources = rightSourcesByTarget.get(targetId) ?? [];
      for (const fromId of sources) {
        const need = targetCol + 1;
        if ((col[fromId] ?? 0) < need) {
          col[fromId] = need;
          maxCol = Math.max(maxCol, need);
          if (!queued.has(fromId)) {
            queued.add(fromId);
            queue.push(fromId);
          }
        }
      }
    }
  };

  const stanceEdges = edges.filter(e => e.relationType === "agree" || e.relationType === "disagree");
  for (const e of stanceEdges) {
    const fromId = e.from.messageId, toId = e.to.messageId;
    if (!normalSet.has(fromId) || !normalSet.has(toId)) continue;

    if (e.relationType === "agree") {
      const minFrom = rightMinCol[fromId] ?? 0;
      const requiredTargetCol = minFrom + 1;
      const currentTargetCol = col[toId] ?? 0;
      if (currentTargetCol < requiredTargetCol) {
        col[toId] = requiredTargetCol;
        maxCol = Math.max(maxCol, requiredTargetCol);
        propagateRightDependents([toId]);
      }

      const finalTargetCol = col[toId] ?? 0;
      const newFromCol = Math.max(0, finalTargetCol - 1);
      const prevFromCol = col[fromId] ?? 0;
      col[fromId] = newFromCol;
      if (newFromCol > prevFromCol) {
        maxCol = Math.max(maxCol, newFromCol);
        propagateRightDependents([fromId]);
      }
      continue;
    }

    const tgtCol = col[toId] ?? 0;
    const desired = tgtCol + 1;
    const prevFromCol = col[fromId] ?? 0;
    col[fromId] = Math.max(desired, rightMinCol[fromId] ?? 0);
    maxCol = Math.max(maxCol, col[fromId]);
    if (col[fromId] > prevFromCol) {
      propagateRightDependents([fromId]);
    }
  }
  return { col, maxCol };
}

type FrameBlock = {
  relMsgId: string;
  /** All card IDs in this frame (source + targets + nested frame cards). */
  cardIds: Set<string>;
  /** Card IDs directly in this frame (not in any child frame). */
  directCardIds: Set<string>;
  /** IDs of child frames (frames nested inside this one). */
  childRelMsgIds: string[];
  /** True for merge frames (need extra header space). */
  isMerge: boolean;
  /** True when CLASSIFY/SUMMARY renders a header card inside the frame. */
  hasGroupHeader: boolean;
  /** Layout direction for arrange frames: 'single-row' (horizontal) or 'single-column' (vertical, default). */
  targetLayout?: RelationTargetLayout;
};

/** Identify frame blocks from edges and build parent-child hierarchy.
 *  Frame types: arrange, frame-group (classify/merge), replace-overlay (summary). */
export function buildFrameBlocks(params: {
  edges: DemoEdge[];
  visibleCardIds: Set<string>;
  msgMap: Map<string, DemoMessage>;
  keepEmptyFrameIds?: Set<string>;
  traceMode?: boolean;
}): FrameBlock[] {
  const { edges, visibleCardIds, msgMap, keepEmptyFrameIds = new Set<string>(), traceMode = false } = params;
  const edgesByRelMsg = new Map<string, DemoEdge[]>();
  for (const e of edges) {
    const arr = edgesByRelMsg.get(e.relationMessageId) ?? [];
    arr.push(e);
    edgesByRelMsg.set(e.relationMessageId, arr);
  }
  const blocks: FrameBlock[] = [];
  for (const [relMsgId, relEdges] of edgesByRelMsg) {
    if (relEdges.length === 0) continue;
    const relKind = getRelKind(relEdges[0].relationType);
    const relType = relEdges[0].relationType;
    // A type is "known" if it exists in PRESENTATION_SPECS (case-insensitive).
    // Removed types (e.g. SUPPORT) are NOT in specs and get the default edge-label kind,
    // but they are known non-frame types — NOT custom frame types.
    const isKnownType = relType in PRESENTATION_SPECS || relType.toUpperCase() in PRESENTATION_SPECS;
    // Known non-frame types → skip.  Custom types → treat as arrange-frame.
    if (relKind !== 'arrange-frame' && relKind !== 'frame-group' && relKind !== 'replace-overlay') {
      if (isKnownType) continue;
    }
    const cardIds = new Set<string>();
    const sourceId = relEdges[0].from.messageId;
    if (!sourceId.startsWith('anon:') && visibleCardIds.has(sourceId)) cardIds.add(sourceId);
    // Collect direct card IDs. When a frame targets another frame, keep only
    // that relation message here; the nested frame owns its own contents.
    // Recursing into the target frame would put its text cards in both the
    // parent and nested layouts, which breaks collapsed-frame behavior.
    const collectNestedCardIds = (targetMsgId: string, visited: Set<string>) => {
      if (visited.has(targetMsgId)) return;
      visited.add(targetMsgId);
      if (visibleCardIds.has(targetMsgId)) {
        cardIds.add(targetMsgId);
        return;
      }
      // Check if target is itself a frame-type relation message
      const nestedEdges = edgesByRelMsg.get(targetMsgId);
      if (nestedEdges && nestedEdges.length > 0) {
        const nk = getRelKind(nestedEdges[0].relationType);
        const nrt = nestedEdges[0].relationType;
        const nIsKnown = nrt in PRESENTATION_SPECS || nrt.toUpperCase() in PRESENTATION_SPECS;
        const nIsFrame = nk === 'arrange-frame' || nk === 'frame-group' || nk === 'replace-overlay'
          || !nIsKnown;
        if (nIsFrame) {
          // The relation message is the parent's direct embedded node.
          cardIds.add(targetMsgId);
        }
      }
    };
    for (const edge of relEdges) {
      collectNestedCardIds(edge.to.messageId, new Set());
    }
    const relationType = relEdges[0].relationType.toLowerCase();
    const keepEmpty = keepEmptyFrameIds.has(relMsgId) && getPresentationSpec(relationType).isContainer === true;
    if (cardIds.size > 0 || keepEmpty) {
      const relMsg = msgMap.get(relMsgId);
      const isArrange = isKnownType ? (relKind === 'arrange-frame') : true;
      const targetLayout = isArrange ? (relMsg?.relationPayload?.targetLayout) : undefined;
      blocks.push({ relMsgId, cardIds, directCardIds: new Set(), childRelMsgIds: [], isMerge: relEdges[0].relationType === 'merge', hasGroupHeader: relationType === 'classify' || relationType === 'summary', targetLayout });
    }
  }
  // Build parent-child: a block B is a child of block A if A has an edge
  // that targets B's relMsgId.  Relation messages are also messages —
  // child frames appear as cards inside their parent frame.
  for (const block of blocks) {
    for (const edge of edgesByRelMsg.get(block.relMsgId) ?? []) {
      const tgtId = edge.to.messageId;
      const childBlock = blocks.find(b => b.relMsgId === tgtId && b.relMsgId !== block.relMsgId);
      if (childBlock && !block.childRelMsgIds.includes(childBlock.relMsgId)) {
        block.childRelMsgIds.push(childBlock.relMsgId);
      }
    }
  }
  if (traceMode) {
    for (const block of blocks) {
      for (const childId of block.childRelMsgIds) block.cardIds.add(childId);
    }
    for (const block of blocks) {
      const childCards = new Set<string>();
      const collectChildCards = (parent: FrameBlock) => {
        for (const childId of parent.childRelMsgIds) {
          const child = blocks.find(candidate => candidate.relMsgId === childId);
          if (child) {
            child.cardIds.forEach(id => childCards.add(id));
            collectChildCards(child);
          }
        }
      };
      collectChildCards(block);
      block.directCardIds = new Set([...block.cardIds].filter(id =>
        !childCards.has(id) && !block.childRelMsgIds.includes(id)
      ));
    }
    return blocks;
  }

  // Transitive expansion: when a frame's text-message cards are fully covered
  // by another frame, add the covered frame's relMsgId to the covering frame's cardIds.
  // This allows subset detection to nest arrange-inside-arrange properly.
  for (const block of blocks) {
    for (const other of blocks) {
      if (block.relMsgId === other.relMsgId) continue;
      // An explicit edge from `other` to `block` already establishes that
      // `block` is nested inside `other`; shared cards must not infer the
      // reverse relationship and create a frame hierarchy cycle.
      const otherTargetsBlock = (edgesByRelMsg.get(other.relMsgId) ?? [])
        .some(edge => edge.to.messageId === block.relMsgId);
      if (otherTargetsBlock) continue;
      const otherRelMsgIds = new Set(blocks.filter(b => b.relMsgId !== other.relMsgId).map(b => b.relMsgId));
      const otherTextCards = new Set([...other.cardIds].filter(id => !otherRelMsgIds.has(id)));
      if (otherTextCards.size === 0) continue;
      const allInBlock = [...otherTextCards].every(id => block.cardIds.has(id));
      if (allInBlock) {
        block.cardIds.add(other.relMsgId);
      }
    }
  }
  // Subset-relationship detection: when a smaller frame's cardIds are fully
  // contained within a larger frame's cardIds (frame-group or arrange-frame),
  // the smaller frame should be a child of the larger one.  This handles the
  // case where a frame targets text messages directly rather than targeting
  // the arrange relation message that groups those same text messages.
  // Without this, both frames become root frames and overwrite each other's
  // card positions, causing inconsistent layout.
  //
  // We compare against the ORIGINAL edge-derived cardIds (before transitive
  // expansion added relMsgIds), because the expansion may have already
  // modified large.cardIds.  The subset relationship is about text-message
  // containment; two arrange frames that each target [A,B] and [A,B,C,D]
  // should nest regardless of which relMsgIds were added during expansion.
  //
  // Sort blocks by cardIds size ascending so smaller (more specific) frames
  // are processed first.
  const sortedBySize = [...blocks].sort((a, b) => a.cardIds.size - b.cardIds.size);
  for (let i = 0; i < sortedBySize.length; i++) {
    const small = sortedBySize[i];
    const smallKind = getRelKind(edgesByRelMsg.get(small.relMsgId)?.[0]?.relationType ?? '');
    // arrange-frame, replace-overlay, and frame-group can be nested inside
    // frame-group or arrange-frame (handles merge-inside-merge, etc.)
    if (smallKind !== 'arrange-frame' && smallKind !== 'replace-overlay' && smallKind !== 'frame-group') continue;
    // Iterate from i+1 upward: pick the SMALLEST containing frame (most specific).
    // e.g. r10→mock-101→mock-103, not r10→mock-103 skipping mock-101.
    for (let j = i + 1; j < sortedBySize.length; j++) {
      const large = sortedBySize[j];
      const largeKind = getRelKind(edgesByRelMsg.get(large.relMsgId)?.[0]?.relationType ?? '');
      // frame-group and arrange-frame can contain other frames
      if (largeKind !== 'frame-group' && largeKind !== 'arrange-frame') continue;
      // Check subset: all of small's cardIds (text + relMsgIds) are in large's cardIds.
      // Use the expanded cardIds because large.cardIds was augmented during
      // transitive expansion, and small.cardIds may include nested relMsgIds.
      let isSubset = small.cardIds.size > 0;
      for (const cid of small.cardIds) {
        if (!large.cardIds.has(cid)) { isSubset = false; break; }
      }
      if (!isSubset) continue;
      // Avoid creating a cycle
      const isDescendant = (ancestor: FrameBlock, descendantId: string): boolean => {
        if (ancestor.relMsgId === descendantId) return true;
        return ancestor.childRelMsgIds.some(cid => {
          const c = blocks.find(b => b.relMsgId === cid);
          return c ? isDescendant(c, descendantId) : false;
        });
      };
      if (isDescendant(small, large.relMsgId)) continue;
      if (!large.childRelMsgIds.includes(small.relMsgId)) {
        large.childRelMsgIds.push(small.relMsgId);
      }
      break; // small only gets one parent
    }
  }
  // Include child frame relMsgIds in parent cardIds — relation messages are also messages.
  for (const block of blocks) {
    for (const childId of block.childRelMsgIds) {
      block.cardIds.add(childId);
    }
  }
  // Compute directCardIds: cardIds minus cards in any child frame, AND minus
  // child frame relMsgIds themselves (they are laid out as child frames, not direct cards).
  for (const block of blocks) {
    const childCards = new Set<string>();
    const collectChildCards = (b: FrameBlock) => {
      for (const cid of b.childRelMsgIds) {
        const child = blocks.find(x => x.relMsgId === cid);
        if (child) { child.cardIds.forEach(id => childCards.add(id)); collectChildCards(child); }
      }
    };
    collectChildCards(block);
    block.directCardIds = new Set([...block.cardIds].filter(id => {
      if (childCards.has(id)) return false;
      if (block.childRelMsgIds.includes(id)) return false;
      return true;
    }));
  }
  return blocks;
}

function buildFrameLayoutUnits(params: {
  frameBlocks: FrameBlock[];
  layout: Record<string, LayoutBox>;
  frameRects: Record<string, Rect>;
  measuredHeights: Record<string, number>;
}): FrameAvoidanceReservation[] {
  const units: FrameAvoidanceReservation[] = [];
  for (const frame of params.frameBlocks) {
    const rect = params.frameRects[frame.relMsgId];
    if (!rect) continue;
    const headerHeight = frame.hasGroupHeader ? getGroupHeaderHeight(params.measuredHeights, frame.relMsgId) : 0;
    units.push({
      relMsgId: frame.relMsgId,
      rect: headerHeight > 0
        ? { ...rect, y: rect.y - headerHeight, height: rect.height + headerHeight }
        : rect,
      cardIds: new Set([...frame.cardIds].filter(id => id in params.layout)),
      ...(frame.isMerge ? { headerTopPad: MERGE_CARD_H + FRAME_PAD + MERGE_CONTENT_TOP_GAP } : {}),
    });
  }
  return units.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

function computeNoOverlapLayout(params: {
  normals: DemoMessage[]; colOf: Record<string, number>; measuredHeights: Record<string, number>; measuredWidths: Record<string, number>; maxCol: number;
  correctedTargetIds?: Set<string>;
  frameBlocks?: FrameBlock[];
  allMessages: DemoMessage[];
  activeTextSelectId?: string | null;
  traceMode?: boolean;
}) {
  const { normals, colOf, measuredHeights, measuredWidths } = params;
  const correctedTargetIds = params.correctedTargetIds ?? new Set<string>();
  const frameBlocks = params.frameBlocks ?? [];
  const allMsgMap = new Map(params.allMessages.map(m => [m.id, m]));

  const layout: Record<string, LayoutBox> = {};
  const frameRectMap = new Map<string, Rect>();
  let maxBottom = GRID_TOP;

  function cardHeight(id: string) {
    if (correctedTargetIds.has(id)) return 0;
    return Math.max(MIN_CARD_H, measuredHeights[id] ?? MIN_CARD_H);
  }

  function cardWidth(id: string) {
    return Math.max(CARD_W, measuredWidths[id] ?? CARD_W);
  }

  // --- Build a frame lookup and card→innermost-frame mapping ---
  const frameById = new Map<string, FrameBlock>();
  const cardInnermostFrame = new Map<string, string>(); // cardId → innermost frame relMsgId
  for (const fb of frameBlocks) frameById.set(fb.relMsgId, fb);

  // Assign each card to its innermost (most specific) frame
  for (const fb of frameBlocks) {
    for (const cid of fb.directCardIds) {
      // directCardIds only contains cards not in child frames, so this IS the innermost
      cardInnermostFrame.set(cid, fb.relMsgId);
    }
  }

  // --- Recursive frame layout ---
  // Each frame is its own "sub-canvas": internal cards start from local col 0,
  // the column pipeline runs independently per frame. The frame's rect is
  // computed from its content bounds and placed as an opaque rectangle in the parent.
  interface FrameLayoutResult { rect: Rect; }

  /** Merge: normalize global colOf (translate from original canvas).
   *  Arrange: no pipeline needed — items are placed as opaque rectangles.
   *  extraCols: columns occupied by child frame cards, used to compute the
   *  true leftmost column across ALL merge content (preserves relative positions). */
  function computeMergeLocalColumns(frameCards: DemoMessage[], extraCols?: number[]): Record<string, number> {
    const localCol: Record<string, number> = {};
    let minCol = Infinity;
    for (const m of frameCards) {
      const c = colOf[m.id] ?? 0;
      localCol[m.id] = c;
      if (c < minCol) minCol = c;
    }
    if (extraCols) {
      for (const c of extraCols) {
        if (c < minCol) minCol = c;
      }
    }
    if (isFinite(minCol) && minCol !== 0)
      for (const m of frameCards) localCol[m.id] -= minCol;
    return localCol;
  }

  function layoutFrameBlock(fb: FrameBlock, frameX: number, frameY: number): FrameLayoutResult {
    type FrameItem = { kind: 'card'; msg: DemoMessage } | { kind: 'childFrame'; child: FrameBlock };
    const items: FrameItem[] = [];
    const frameCards: DemoMessage[] = [];
    for (const cid of fb.directCardIds) {
      const m = normals.find(x => x.id === cid);
      if (m) { frameCards.push(m); items.push({ kind: 'card', msg: m }); }
    }
    const isMerge = fb.isMerge;
    const isHorizontal = !isMerge && fb.targetLayout === 'single-row';
    // Merge: normalize global columns. Collect columns from child frame cards
    // so the normalization accounts for the full column span of the merge content.
    const childFrameCols: number[] = [];
    for (const childId of fb.childRelMsgIds) {
      const child = frameById.get(childId);
      if (child) {
        for (const cid of child.cardIds) {
          const c = colOf[cid];
          if (c !== undefined) childFrameCols.push(c);
        }
      }
    }
    const localColOf = !isHorizontal ? computeMergeLocalColumns(frameCards, childFrameCols) : {};
    const parentMinCol = Math.min(
      ...frameCards.map(card => colOf[card.id] ?? 0),
      ...childFrameCols,
      0,
    );
    const childFrameX = (child: FrameBlock) => {
      const childCols = [...child.cardIds]
        .map(id => colOf[id])
        .filter((column): column is number => column !== undefined);
      const childMinCol = childCols.length > 0 ? Math.min(...childCols) : parentMinCol;
      return contentX + colX(Math.max(0, childMinCol - parentMinCol)) - colX(0);
    };
    for (const childId of fb.childRelMsgIds) {
      const child = frameById.get(childId);
      if (child) items.push({ kind: 'childFrame', child });
    }
    items.sort((a, b) => {
      const ta = a.kind === 'card' ? new Date(a.msg.createdAt).getTime()
        : Math.min(...[...a.child.cardIds].map(id => new Date(allMsgMap.get(id)?.createdAt ?? 0).getTime()));
      const tb = b.kind === 'card' ? new Date(b.msg.createdAt).getTime()
        : Math.min(...[...b.child.cardIds].map(id => new Date(allMsgMap.get(id)?.createdAt ?? 0).getTime()));
      return ta - tb;
    });

    const mergeHeaderPad = isMerge ? MERGE_CARD_H + MERGE_CONTENT_TOP_GAP : 0;
    const groupHeaderPad = fb.hasGroupHeader ? getGroupHeaderHeight(measuredHeights, fb.relMsgId) : 0;
    const contentX = frameX + FRAME_PAD_X;
    const contentY = frameY + groupHeaderPad + FRAME_PAD_Y + mergeHeaderPad;

    let yCursor = contentY;
    const colYCursor = new Map<number, number>();
    let xCursor = contentX;
    let rowMaxHeight = 0;
    let contentLeft = Infinity, contentTop = Infinity, contentRight = -Infinity, contentBottom = -Infinity;
    function unionCard(mid: string) {
      const box = layout[mid];
      if (!box) return;
      contentLeft   = Math.min(contentLeft,   box.x);
      contentTop    = Math.min(contentTop,    box.y);
      contentRight  = Math.max(contentRight,  box.x + box.width);
      contentBottom = Math.max(contentBottom, box.y + box.height);
    }

    for (const item of items) {
      if (item.kind === 'card') {
        const m = item.msg;
        const h = cardHeight(m.id);
        const w = cardWidth(m.id);
        if (!isHorizontal) {
          const col = localColOf[m.id] ?? 0;
          const curY = colYCursor.get(col) ?? contentY;
          layout[m.id] = { x: contentX + colX(col) - colX(0), y: curY, width: w, height: h };
          colYCursor.set(col, curY + h + ROW_GAP);
        } else if (isHorizontal) {
          layout[m.id] = { x: xCursor, y: yCursor, width: w, height: h };
          xCursor += w + COL_GAP;
          rowMaxHeight = Math.max(rowMaxHeight, h);
        } else {
          layout[m.id] = { x: contentX, y: yCursor, width: w, height: h };
          yCursor += h + ROW_GAP;
        }
        unionCard(m.id);
        maxBottom = Math.max(maxBottom, layout[m.id].y + h);
      } else {
        const child = item.child;
        // Track child frame rect in content bounds
        function trackChildRect(r: Rect) {
          contentLeft   = Math.min(contentLeft,   r.x);
          contentTop    = Math.min(contentTop,    r.y);
          contentRight  = Math.max(contentRight,  r.x + r.width);
          contentBottom = Math.max(contentBottom, r.y + r.height);
        }
        function occupiedChildRect(r: Rect): Rect {
          const headerHeight = child.hasGroupHeader ? getGroupHeaderHeight(measuredHeights, child.relMsgId) : 0;
          return headerHeight > 0
            ? { ...r, y: r.y - headerHeight, height: r.height + headerHeight }
            : r;
        }
        if (isMerge) {
          // Start child frame below the bottom of all previously placed content
          let childStartY = contentY;
          for (const [, cy] of colYCursor) {
            childStartY = Math.max(childStartY, cy);
          }
          const result = layoutFrameBlock(child, contentX, childStartY);
          const occupiedRect = occupiedChildRect(result.rect);
          const childBottom = occupiedRect.y + occupiedRect.height + ROW_GAP;
          // Sync all column cursors below the child frame so items in other
          // columns don't end up visually above it.
          for (const [col] of colYCursor) {
            colYCursor.set(col, Math.max(colYCursor.get(col) ?? contentY, childBottom));
          }
          // Sync column cursors ONLY for columns that the child frame
          // horizontally overlaps. Cards in non-overlapping columns
          // (to the right of the frame) stay at their original Y level.
          const maxLocalCol = Math.max(0, ...Object.values(localColOf));
          const childLeft = occupiedRect.x;
          const childRight = occupiedRect.x + occupiedRect.width;
          for (let col = 0; col <= maxLocalCol; col++) {
            const cardLeft = contentX + colX(col) - colX(0);
            const cardRight = cardLeft + CARD_W;
            if (cardLeft < childRight && childLeft < cardRight) {
              colYCursor.set(col, Math.max(colYCursor.get(col) ?? contentY, childBottom));
            }
          }
          // Ensure col 0 is always synced (child frame always starts at contentX)
          colYCursor.set(0, Math.max(colYCursor.get(0) ?? contentY, childBottom));
          trackChildRect(occupiedRect);
        } else if (isHorizontal) {
          const result = layoutFrameBlock(child, xCursor, yCursor);
          const occupiedRect = occupiedChildRect(result.rect);
          xCursor += occupiedRect.width + COL_GAP;
          rowMaxHeight = Math.max(rowMaxHeight, occupiedRect.height);
          trackChildRect(occupiedRect);
        } else {
          // Measure the child to know which columns it occupies. A vertical
          // child must start below only the columns it overlaps; using the
          // maximum cursor from every column creates unrelated empty space.
          const measuredChild = layoutFrameBlock(child, childFrameX(child), contentY);
          const childLeft = measuredChild.rect.x;
          const childRight = measuredChild.rect.x + measuredChild.rect.width;
          let childStartY = contentY;
          for (const [col, columnY] of colYCursor) {
            const cardLeft = contentX + colX(col) - colX(0);
            const cardRight = cardLeft + CARD_W;
            if (cardLeft < childRight && childLeft < cardRight) {
              childStartY = Math.max(childStartY, columnY);
            }
          }
          const result = layoutFrameBlock(child, childFrameX(child), childStartY);
          const occupiedRect = occupiedChildRect(result.rect);
          const childBottom = occupiedRect.y + occupiedRect.height + ROW_GAP;
          for (const [col, columnY] of colYCursor) {
            const cardLeft = contentX + colX(col) - colX(0);
            const cardRight = cardLeft + CARD_W;
            if (cardLeft < occupiedRect.x + occupiedRect.width && occupiedRect.x < cardRight) {
              colYCursor.set(col, Math.max(columnY, childBottom));
            }
          }
          trackChildRect(occupiedRect);
        }
      }
    }

    const hasContent = isFinite(contentLeft) && isFinite(contentTop) && isFinite(contentRight) && isFinite(contentBottom);
    const frameW = hasContent
      ? Math.max(contentRight - contentLeft, CARD_W) + FRAME_PAD_X * 2
      : CARD_W + FRAME_PAD_X * 2;
    const frameH = hasContent
      ? Math.max(contentBottom - contentTop, 0) + FRAME_PAD_Y * 2 + mergeHeaderPad
      : FRAME_PAD_Y * 2 + mergeHeaderPad;
    // frameX/frameY are the collision-layout position of this opaque unit.
    // Content bounds determine its size, not a second position that would
    // move the frame away from the cards laid out from the same origin.
    const frameRect: Rect = { x: frameX, y: frameY + groupHeaderPad, width: frameW, height: frameH };
    frameRectMap.set(fb.relMsgId, frameRect);
    return { rect: frameRect };
  }

  // --- Second-pass nesting check ---
  // Ensure all subset relationships between frames are captured, even when
  // the primary detection in buildFrameBlocks missed them.  This is critical
  // for arrange-inside-arrange (horizontal) and merge-containing-arrange layouts.
  // Without this, nested frames are placed as independent root frames, causing
  // vertical stacking when horizontal alignment is expected.
  if (!params.traceMode) for (const fb of frameBlocks) {
    for (const other of frameBlocks) {
      if (fb.relMsgId === other.relMsgId) continue;
      if (fb.childRelMsgIds.includes(other.relMsgId)) continue;
      if (other.childRelMsgIds.includes(fb.relMsgId)) continue;
      // Don't steal a frame that already has a parent
      if (frameBlocks.some(b => b.childRelMsgIds.includes(other.relMsgId))) continue;
      // Check if other's text-only cards are fully contained in fb's cardIds.
      // We filter out relMsgIds from the comparison because transitive expansion
      // in buildFrameBlocks may have added them asymmetrically.
      const allBlockIds = new Set(frameBlocks.map(b => b.relMsgId));
      const otherTextOnly = [...other.cardIds].filter(id => !allBlockIds.has(id));
      if (otherTextOnly.length === 0) continue;
      const allInFb = otherTextOnly.every(id => fb.cardIds.has(id));
      if (allInFb && fb.cardIds.size > other.cardIds.size) {
        fb.childRelMsgIds.push(other.relMsgId);
        // Also add to cardIds so directCardIds recomputation below works
        if (!fb.cardIds.has(other.relMsgId)) fb.cardIds.add(other.relMsgId);
      }
    }
  }
  // Recompute directCardIds for any blocks that gained children above
  for (const fb of frameBlocks) {
    if (fb.childRelMsgIds.length === 0) continue;
    const childCards = new Set<string>();
    const collectChildCards = (b: FrameBlock) => {
      for (const cid of b.childRelMsgIds) {
        const child = frameBlocks.find(x => x.relMsgId === cid);
        if (child) { child.cardIds.forEach(id => childCards.add(id)); collectChildCards(child); }
      }
    };
    collectChildCards(fb);
    fb.directCardIds = new Set([...fb.cardIds].filter(id => {
      if (childCards.has(id)) return false;
      if (fb.childRelMsgIds.includes(id)) return false;
      return true;
    }));
  }

  // --- Top-level layout ---
  // Single pass: estimate-based findY for placement, actual frameRect for placedRects.

  const childFrameIds2 = new Set<string>();
  for (const fb of frameBlocks) fb.childRelMsgIds.forEach(id => childFrameIds2.add(id));
  const rootFrames2 = frameBlocks.filter(fb => !childFrameIds2.has(fb.relMsgId));
  const allFrameCardIds2 = new Set<string>();
  for (const fb of frameBlocks) fb.cardIds.forEach(id => allFrameCardIds2.add(id));
  const standaloneCards2 = normals.filter(m => !allFrameCardIds2.has(m.id));

  type LayoutItem = { kind: 'card'; msg: DemoMessage; col: number } | { kind: 'frame'; block: FrameBlock };
  const items2: LayoutItem[] = [];
  for (const m of standaloneCards2) items2.push({ kind: 'card', msg: m, col: colOf[m.id] ?? 0 });
  for (const fb of rootFrames2) items2.push({ kind: 'frame', block: fb });
  items2.sort((a, b) => {
    const ta = a.kind === 'card' ? new Date(a.msg.createdAt).getTime()
      : Math.min(...[...a.block.cardIds].map(id => new Date(allMsgMap.get(id)?.createdAt ?? 0).getTime()));
    const tb = b.kind === 'card' ? new Date(b.msg.createdAt).getTime()
      : Math.min(...[...b.block.cardIds].map(id => new Date(allMsgMap.get(id)?.createdAt ?? 0).getTime()));
    return ta - tb;
  });

  const placedRects2: Rect[] = [];

  function findY2(x: number, w: number, topPad = 0): number {
    let y = GRID_TOP + topPad;
    for (const r of placedRects2) {
      if (x + w <= r.x || r.x + r.width <= x) continue;
      y = Math.max(y, r.y + r.height + ROW_GAP + topPad);
    }
    return y;
  }

  // A frame is one layout unit.  Anchor it to the leftmost column occupied by
  // its visible members instead of always starting at column zero; otherwise a
  // frame member constrained to the right of an external card leaves the frame
  // behind that card while only its contents appear to move right.
  function frameAnchorCol(block: FrameBlock): number {
    const memberCols = [...block.cardIds]
      .map(id => colOf[id])
      .filter((column): column is number => column !== undefined);
    return memberCols.length > 0 ? Math.min(...memberCols) : 0;
  }
  for (const item of items2) {
    if (item.kind === 'card') {
      const m = item.msg;
      const h = cardHeight(m.id);
      const w = cardWidth(m.id);
      const x = colX(item.col);
      const y = findY2(x, w);
      layout[m.id] = { x, y, width: w, height: h };
      placedRects2.push({ x, y, width: w, height: h });
      maxBottom = Math.max(maxBottom, y + h);
    } else {
      const fb = item.block;
      const frameX = colX(frameAnchorCol(fb));
      // Measure the frame before choosing its Y position.  A fixed card-width
      // estimate lets wide frames overlap cards that were placed earlier in
      // the same horizontal band.
      const measuredFrame = layoutFrameBlock(fb, frameX, GRID_TOP);
      const frameY = findY2(frameX, measuredFrame.rect.width);
      const result2 = layoutFrameBlock(fb, frameX, frameY);
      placedRects2.push({
        x: result2.rect.x,
        y: result2.rect.y - (fb.hasGroupHeader ? getGroupHeaderHeight(measuredHeights, fb.relMsgId) : 0),
        width: result2.rect.width,
        height: result2.rect.height + (fb.hasGroupHeader ? getGroupHeaderHeight(measuredHeights, fb.relMsgId) : 0),
      });
      frameRectMap.set(fb.relMsgId, result2.rect);
      maxBottom = Math.max(maxBottom, result2.rect.y + result2.rect.height);
    }
  }

  // Any remaining cards (shouldn't happen with correct frame hierarchy)
  for (const m of normals) {
    if (layout[m.id]) continue;
    const c = colOf[m.id] ?? 0;
    const h = cardHeight(m.id);
    const w = cardWidth(m.id);
    const x = colX(c);
    const y = findY2(x, w);
    layout[m.id] = { x, y, width: w, height: h };
    maxBottom = Math.max(maxBottom, y + h);
  }

  return { layout, canvasHeight: maxBottom + CANVAS_BOTTOM_PAD, frameRects: Object.fromEntries(frameRectMap) };
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
      const p=quadAt(s.p0,s.p1,s.p2,0.5); const x=p.x; let y=p.y, r=labelRectApprox(x,y,s.text);
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
  invalidCorrectionIds?: Set<string>;
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
  /** Which decoration badges are currently selected: keys are `${messageId}::agree` / `${messageId}::disagree` */
  selectedDecorations?: Set<string>;
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
  onInlineBadgeDoubleClick?: (e: React.MouseEvent, relMsgId: string, detail?: { relMsgIds?: string[]; subDetails?: Array<{subType:string;customLabel?:string;count:number}> }) => void;
  /** Optional message IDs to hide from card rendering while keeping layout/frame computation. */
  hideMessageIds?: Set<string>;
  /** In trace mode, these CLASSIFY/SUMMARY IDs render as frames instead of cards. */
  traceExpandedFrameIds?: Set<string>;
  /** Directly traced CLASSIFY/SUMMARY IDs use exclusive card/frame rendering. */
  traceFrameIds?: Set<string>;
  /** Render two aligned comparison projections using the same graph layout. */
  comparisonPair?: boolean;
  comparisonTargetId?: string | null;
  comparisonDisplay?: 'agree' | 'disagree';
  comparisonRecommendedDisplay?: 'agree' | 'disagree';
  comparisonAgreeMessages?: DemoMessage[];
  comparisonAgreeEdges?: DemoEdge[];
  comparisonAgreeHideMessageIds?: Set<string>;
  comparisonDisagreeMessages?: DemoMessage[];
  comparisonDisagreeEdges?: DemoEdge[];
  comparisonDisagreeHideMessageIds?: Set<string>;
  comparisonAgreeSuppressedRelIds?: Set<string>;
  comparisonDisagreeSuppressedRelIds?: Set<string>;
  comparisonSuppressedRelIds?: Set<string>;
  autoCenterMessageId?: string | null;
  /** Phase 2: stake counts per message (truth/value split) for display on cards */
  stakeCounts?: Record<string, { truth: { pro: number; con: number }; value: { pro: number; con: number } }>;
  /** Phase 3: callback when ⚖️ truth settlement toggle is clicked */
  onSettlementToggleTruth?: (messageId: string) => void;
  /** Phase 3: callback when 💎 value settlement toggle is clicked */
  onSettlementToggleValue?: (messageId: string) => void;
  /** Topic ID for SettlementPanel message creation */
  topicId?: string;
  /** Phase 3: currently open settlement message ID (for active state styling) */
  settlementOpenMsgId?: string | null;
  /** Phase 3: currently open settlement type (TRUTH or VALUE) */
  settlementOpenType?: 'TRUTH' | 'VALUE' | null;
  onSettlementMessageCreated?: (m: { id: string; content: string; createdAt: string; author: string; kind: string }) => void;
  /** Phase 5: Stance path highlight — { stanceMsgId, evidenceMsgIds } */
  stanceHighlight?: { stanceMsgId: string; evidenceMsgIds: string[] } | null;
  /** Phase 5: Settlement entry highlight filter for SettlementPanel */
  settlementEntryHighlight?: { side?: 'PRO' | 'CON'; vote?: 'TRUE' | 'FALSE'; username?: string } | null;
  /** 跨分类引用标签：msgId → { outgoing: { "证据": [...], "引用": [...], ... }, incoming: {...} } */
  crossClassifyRefs?: Map<string, { outgoing: Record<string, string[]>; incoming: Record<string, string[]> }>;
  /** 点击跨分类引用标签：选中关系消息 */
  onCrossRefTagClick?: (e: React.MouseEvent, relMsgIds: string[]) => void;
  /** 点击加入消息标签；incoming 表示“被加入”，outgoing 表示“加入” */
  onNavigateToMessage?: (messageId: string) => void;
  /** JOIN records grouped by their target message, used by the target filter badge. */
  joinRelationsByTarget?: Map<string, Relation[]>;
  /** JOIN records emitted by each container. */
  joinRelationsBySource?: Map<string, Relation[]>;
  onJoinFilterClick?: (messageId: string, direction: 'incoming' | 'outgoing') => void;
  joinStatusByMessage?: Map<string, 'valid' | 'rejected' | 'superseded' | 'container-rejected'>;
}

const EMPTY_COMPARISON_SUPPRESSED_REL_IDS = new Set<string>();
const COMPARISON_HEADER_HEIGHT = 28;
const COMPARISON_CANVAS_EXTRA_RIGHT_PAD = 96;

function ComparisonGraphPair(props: GraphViewProps) {
  const pairRef = useRef<HTMLDivElement | null>(null);
  const agreeViewportRef = useRef<HTMLDivElement | null>(null);
  const disagreeViewportRef = useRef<HTMLDivElement | null>(null);
  const verticalScrollRef = useRef<HTMLDivElement | null>(null);
  const horizontalScrollRef = useRef<HTMLDivElement | null>(null);
  const syncingScrollRef = useRef(false);
  const splitDragRef = useRef<{ startX: number; startAgreeRatio: number } | null>(null);
  const [agreeRatio, setAgreeRatio] = useState(0.5);
  const [contentSize, setContentSize] = useState({ width: 0, height: 0 });
  const [scrollHostSize, setScrollHostSize] = useState({ height: 0, viewportHeight: 0 });

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = splitDragRef.current;
      const pair = pairRef.current;
      if (!drag || !pair) return;
      const pairWidth = pair.getBoundingClientRect().width;
      const availableWidth = Math.max(1, pairWidth - 14 - 16);
      const nextRatio = (drag.startAgreeRatio * availableWidth + event.clientX - drag.startX) / availableWidth;
      setAgreeRatio(Math.max(0.25, Math.min(0.75, nextRatio)));
    };
    const handlePointerUp = () => { splitDragRef.current = null; };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, []);

  const handleSplitPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    splitDragRef.current = { startX: event.clientX, startAgreeRatio: agreeRatio };
  };

  const setSharedScroll = (top: number, left: number) => {
    const scrollHost = pairRef.current?.closest('[data-topic-left-panel]') as HTMLDivElement | null;
    const viewports = [agreeViewportRef.current, disagreeViewportRef.current].filter(Boolean) as HTMLDivElement[];
    for (const viewport of viewports) {
      viewport.scrollTop = 0;
      viewport.scrollLeft = left;
    }
    if (scrollHost) scrollHost.scrollTop = top;
    if (verticalScrollRef.current) verticalScrollRef.current.scrollTop = top;
    if (horizontalScrollRef.current) horizontalScrollRef.current.scrollLeft = left;
  };

  useEffect(() => {
    const targetId = props.autoCenterMessageId;
    const agreeViewport = agreeViewportRef.current;
    const verticalScroll = verticalScrollRef.current;
    if (!targetId || !agreeViewport || !verticalScroll) return;
    const centerTarget = () => {
      const target = Array.from(agreeViewport.querySelectorAll<HTMLElement>('[data-msgid]'))
        .find(element => element.getAttribute('data-msgid') === targetId);
      if (!target) return;
      const targetRect = target.getBoundingClientRect();
      const viewportRect = agreeViewport.getBoundingClientRect();
      const scrollHost = pairRef.current?.closest('[data-topic-left-panel]') as HTMLDivElement | null;
      const scrollRect = scrollHost?.getBoundingClientRect() ?? viewportRect;
      const scrollTop = scrollHost?.scrollTop ?? agreeViewport.scrollTop;
      const scrollHeight = scrollHost?.scrollHeight ?? contentSize.height;
      const clientHeight = scrollHost?.clientHeight ?? agreeViewport.clientHeight;
      const nextTop = Math.max(0, Math.min(
        scrollTop + targetRect.top - scrollRect.top + targetRect.height / 2 - clientHeight / 2,
        Math.max(0, scrollHeight - clientHeight),
      ));
      const nextLeft = Math.max(0, Math.min(
        agreeViewport.scrollLeft + targetRect.left - viewportRect.left + targetRect.width / 2 - agreeViewport.clientWidth / 2,
        Math.max(0, contentSize.width - agreeViewport.clientWidth),
      ));
      setSharedScroll(nextTop, nextLeft);
    };
    const timer = window.setTimeout(centerTarget, 100);
    return () => window.clearTimeout(timer);
  }, [props.autoCenterMessageId, props.messages, props.edges, contentSize]);

  useEffect(() => {
    const updateContentSize = () => {
      const scrollHost = pairRef.current?.closest('[data-topic-left-panel]') as HTMLDivElement | null;
      const dimensions = [agreeViewportRef.current, disagreeViewportRef.current].map(viewport => ({
        width: viewport?.scrollWidth ?? 0,
        height: viewport?.scrollHeight ?? 0,
      }));
      setContentSize({
        width: Math.max(...dimensions.map(dimension => dimension.width), 0),
        height: Math.max(...dimensions.map(dimension => dimension.height), agreeViewportRef.current?.clientHeight ?? 0),
      });
      setScrollHostSize({ height: scrollHost?.scrollHeight ?? 0, viewportHeight: scrollHost?.clientHeight ?? 0 });
    };
    updateContentSize();
    const observer = new ResizeObserver(updateContentSize);
    if (agreeViewportRef.current) observer.observe(agreeViewportRef.current);
    if (disagreeViewportRef.current) observer.observe(disagreeViewportRef.current);
    const scrollHost = pairRef.current?.closest('[data-topic-left-panel]') as HTMLDivElement | null;
    if (scrollHost) observer.observe(scrollHost);
    for (const canvas of [agreeViewportRef.current, disagreeViewportRef.current]
      .flatMap(viewport => viewport ? Array.from(viewport.querySelectorAll<HTMLElement>('[data-jump-canvas]')) : [])) {
      observer.observe(canvas);
    }
    window.addEventListener('resize', updateContentSize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateContentSize);
    };
  }, [props.messages, props.edges]);

  useEffect(() => {
    const viewports = [agreeViewportRef.current, disagreeViewportRef.current].filter(Boolean) as HTMLDivElement[];
    const scrollHost = pairRef.current?.closest('[data-topic-left-panel]') as HTMLDivElement | null;
    const verticalScroll = verticalScrollRef.current;
    const horizontalScroll = horizontalScrollRef.current;
    if (!verticalScroll || !horizontalScroll) return;
    const getHorizontalMax = (element: HTMLElement) => Math.max(0, element.scrollWidth - element.clientWidth);
    const getScrollProgress = (element: HTMLElement) => {
      const max = getHorizontalMax(element);
      return max > 0 ? element.scrollLeft / max : 0;
    };
    const setHorizontalProgress = (progress: number) => {
      const clampedProgress = Math.max(0, Math.min(1, progress));
      for (const viewport of viewports) viewport.scrollLeft = getHorizontalMax(viewport) * clampedProgress;
      horizontalScroll.scrollLeft = getHorizontalMax(horizontalScroll) * clampedProgress;
    };
    const syncFromViewport = (source: HTMLDivElement) => {
      if (syncingScrollRef.current) return;
      syncingScrollRef.current = true;
      for (const viewport of viewports) {
        viewport.scrollTop = 0;
      }
      setHorizontalProgress(getScrollProgress(source));
      if (scrollHost) scrollHost.scrollTop = source.scrollTop;
      verticalScroll.scrollTop = source.scrollTop;
      requestAnimationFrame(() => { syncingScrollRef.current = false; });
    };
    const syncFromVerticalScroll = () => {
      if (syncingScrollRef.current) return;
      syncingScrollRef.current = true;
      if (scrollHost) scrollHost.scrollTop = verticalScroll.scrollTop;
      for (const viewport of viewports) viewport.scrollTop = 0;
      requestAnimationFrame(() => { syncingScrollRef.current = false; });
    };
    const syncFromHorizontalScroll = () => {
      if (syncingScrollRef.current) return;
      syncingScrollRef.current = true;
      setHorizontalProgress(getScrollProgress(horizontalScroll));
      requestAnimationFrame(() => { syncingScrollRef.current = false; });
    };
    const handlers = viewports.map(viewport => {
      const handler = () => syncFromViewport(viewport);
      viewport.addEventListener('scroll', handler, { passive: true });
      return [viewport, handler] as const;
    });
    const handleScrollHost = () => {
      if (syncingScrollRef.current) return;
      syncingScrollRef.current = true;
      verticalScroll.scrollTop = scrollHost?.scrollTop ?? 0;
      const source = scrollHost ?? viewports[0];
      setHorizontalProgress(source ? getScrollProgress(source) : 0);
      for (const viewport of viewports) viewport.scrollTop = 0;
      requestAnimationFrame(() => { syncingScrollRef.current = false; });
    };
    verticalScroll.addEventListener('scroll', syncFromVerticalScroll, { passive: true });
    horizontalScroll.addEventListener('scroll', syncFromHorizontalScroll, { passive: true });
    scrollHost?.addEventListener('scroll', handleScrollHost, { passive: true });
    return () => {
      for (const [viewport, handler] of handlers) viewport.removeEventListener('scroll', handler);
      verticalScroll.removeEventListener('scroll', syncFromVerticalScroll);
      horizontalScroll.removeEventListener('scroll', syncFromHorizontalScroll);
      scrollHost?.removeEventListener('scroll', handleScrollHost);
    };
  }, []);

  const viewportStyle: React.CSSProperties = {
    flex: '0 0 auto',
    minWidth: 0,
    minHeight: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
  };

  return (
    <div ref={pairRef} data-comparison-pair="true" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 8, width: '100%', minHeight: '100%' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `${agreeRatio}fr 30px ${1 - agreeRatio}fr`, gap: 8, alignItems: 'stretch' }}>
      <div data-comparison-view="agree" style={{ minWidth: 0, minHeight: 0, border: '1px solid #365314', borderRadius: 6, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: `0 0 ${COMPARISON_HEADER_HEIGHT}px`, height: COMPARISON_HEADER_HEIGHT, boxSizing: 'border-box', display: 'flex', alignItems: 'center', padding: '6px 8px', color: '#86efac', background: '#17210f', fontSize: 12, fontWeight: 600 }}>赞同后显示{props.comparisonRecommendedDisplay === 'agree' ? ' · 推荐显示' : ''}</div>
        <div ref={agreeViewportRef} data-comparison-viewport="agree" style={viewportStyle}>
          <GraphView {...props} messages={props.comparisonAgreeMessages ?? props.messages} edges={props.comparisonAgreeEdges ?? props.edges} hideMessageIds={props.comparisonAgreeHideMessageIds ?? props.hideMessageIds} comparisonPair={false} comparisonDisplay="agree" comparisonSuppressedRelIds={props.comparisonAgreeSuppressedRelIds} autoCenterMessageId={null} />
        </div>
      </div>
      <div data-comparison-divider="true" style={{ minHeight: 0, marginTop: COMPARISON_HEADER_HEIGHT, display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr)', gap: 4, position: 'sticky', top: 0, alignSelf: 'start', height: Math.max(scrollHostSize.viewportHeight, 1), overflow: 'hidden', background: '#2a2a2a', borderRadius: 4 }}>
        <div ref={verticalScrollRef} data-comparison-scroll-vertical="true" aria-label="对比视图垂直滚动条" style={{ minHeight: 0, minWidth: 0, height: '100%', overflowY: 'scroll', overflowX: 'hidden', scrollbarGutter: 'stable', borderRadius: 4 }}>
          <div style={{ height: Math.max(scrollHostSize.height, contentSize.height, 1), width: 1 }} />
        </div>
        <div onPointerDown={handleSplitPointerDown} role="separator" aria-label="调整对比视图宽度" style={{ minWidth: 0, cursor: 'col-resize', background: '#3a3a3a', borderRadius: 4, touchAction: 'none', userSelect: 'none' }} />
      </div>
      <div data-comparison-view="disagree" style={{ minWidth: 0, minHeight: 0, border: '1px solid #7f1d1d', borderRadius: 6, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: `0 0 ${COMPARISON_HEADER_HEIGHT}px`, height: COMPARISON_HEADER_HEIGHT, boxSizing: 'border-box', display: 'flex', alignItems: 'center', padding: '6px 8px', color: '#fca5a5', background: '#2a1212', fontSize: 12, fontWeight: 600 }}>反对后显示{props.comparisonRecommendedDisplay === 'disagree' ? ' · 推荐显示' : ''}</div>
        <div ref={disagreeViewportRef} data-comparison-viewport="disagree" style={viewportStyle}>
          <GraphView {...props} messages={props.comparisonDisagreeMessages ?? props.messages} edges={props.comparisonDisagreeEdges ?? props.edges} hideMessageIds={props.comparisonDisagreeHideMessageIds ?? props.hideMessageIds} comparisonPair={false} comparisonDisplay="disagree" comparisonSuppressedRelIds={props.comparisonDisagreeSuppressedRelIds} autoCenterMessageId={null} />
        </div>
      </div>
      </div>
      <div ref={horizontalScrollRef} data-comparison-scroll-horizontal="true" aria-label="对比视图水平滚动条" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 1, opacity: 0, pointerEvents: 'none', overflowX: 'scroll', overflowY: 'hidden' }}>
        <div style={{ width: Math.max(contentSize.width, 1), height: 1 }} />
      </div>
    </div>
  );
}

function GraphViewCanvas(props: GraphViewProps) {
  const {
    messages: inputMessages, edges: inputEdges, invalidCorrectionIds, draftUnits, activeTextSelectId, lastClickedMessageId,
    onMessageClick, onMessageDoubleClick, onTextMouseUp,
    onEdgeLabelSingleClick, onEdgeLabelDoubleClick,
    onFragmentAnchorClick, isFragmentSelected, onCanvasBlankClick,
    onMessageMouseDown, onMessageMouseUp,
    onDecorationIconClick, onDecorationBodyClick, onDecorationDoubleClick,
    selectedDecorations,
    onTagBodyClick, onTagDoubleClick,
    onGroupFrameClick, onGroupFrameDoubleClick,
    onInlineBadgeClick, onInlineBadgeDoubleClick,
    stakeCounts,
    onSettlementToggleTruth,
    onSettlementToggleValue,
    topicId,
    settlementOpenMsgId,
    settlementOpenType,
    onSettlementMessageCreated,
    stanceHighlight,
    settlementEntryHighlight,
    crossClassifyRefs,
    onCrossRefTagClick,
    onNavigateToMessage,
    joinRelationsByTarget,
    joinRelationsBySource,
    onJoinFilterClick,
    joinStatusByMessage,
    // voteStats is accepted for API compatibility but decoration counts are derived internally from edges
  } = props;

  const messages = inputMessages;
  const edges = inputEdges;
  const traceFrameIds = props.traceFrameIds ?? new Set<string>();
  const isTraceWindow = traceFrameIds.size > 0 || (props.traceExpandedFrameIds?.size ?? 0) > 0;
  // An entering trace can briefly render with the previous expansion state.
  // Only frames belonging to the current trace may be rendered as expanded.
  const traceExpandedFrameIds = useMemo(
    () => new Set(props.traceExpandedFrameIds ?? []),
    [props.traceExpandedFrameIds],
  );
  const comparisonSuppressedRelIds = props.comparisonSuppressedRelIds ?? EMPTY_COMPARISON_SUPPRESSED_REL_IDS;
  const effectiveHideMessageIds = props.hideMessageIds
    ? new Set([...props.hideMessageIds, ...comparisonSuppressedRelIds])
    : comparisonSuppressedRelIds;

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
      if (e.relationType === "tag" && msgMap.get(e.from.messageId)?.kind && isContentKind(msgMap.get(e.from.messageId)!.kind)) {
        isTagSource.add(e.from.messageId);
      }
      // Keep visible: any message targeted by a relation, or source of a non-TAG relation
      if (msgMap.get(e.to.messageId)?.kind && isContentKind(msgMap.get(e.to.messageId)!.kind)) shouldKeepVisible.add(e.to.messageId);
      if (e.relationType !== "tag" && msgMap.get(e.from.messageId)?.kind && isContentKind(msgMap.get(e.from.messageId)!.kind)) {
        shouldKeepVisible.add(e.from.messageId);
      }
    }
    for (const id of shouldKeepVisible) isTagSource.delete(id);
    return isTagSource;
  }, [edges, msgMap]);
  // CLASSIFY relation messages are displayed as topic cards on the main canvas.
  // SUMMARY relation messages are displayed as normal cards (replace-overlay semantics).
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
  const summaryRelMsgIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of messages) {
      if (m.kind === "relation" && m.relationType === "summary") ids.add(m.id);
    }
    for (const e of edges) {
      if (e.relationType === 'summary') ids.add(e.relationMessageId);
    }
    return ids;
  }, [edges, messages]);
  const relationCardMsgIds = useMemo(() => {
    const ids = new Set(classifyRelMsgIds);
    for (const id of summaryRelMsgIds) ids.add(id);
    return ids;
  }, [classifyRelMsgIds, summaryRelMsgIds]);
  const normals = useMemo(() => messages.filter(m =>
    !traceExpandedFrameIds.has(m.id) && (
      (isContentKind(m.kind) && !tagSourceIds.has(m.id)) ||
      (m.kind === "relation" && relationCardMsgIds.has(m.id))
    )
  ), [messages, tagSourceIds, relationCardMsgIds, traceExpandedFrameIds]);
  const normalIds = useMemo(() => normals.map(m => m.id), [normals]);
  // Exclude CLASSIFY/SUMMARY/ARRANGE messages from relIds — they are now in normals and should not be
  // treated as relation-message endpoints for edge-routing constraint algorithms.
  // (SUMMARY is in normals via summaryRelMsgIds ⊆ relationCardMsgIds)
  const relIds = useMemo(() => new Set(messages.filter(m => m.kind === "relation" && !relationCardMsgIds.has(m.id)).map(m => m.id)), [messages, relationCardMsgIds]);

  const { col: baseCol, maxCol: baseMaxCol } = useMemo(() => computeMinColumnsForAnnoRefRule1(normalIds, edges, relIds), [normalIds, edges, relIds]);
  const { col: replyCol, maxCol: replyMaxCol } = useMemo(() => applyReplyLayoutAdjustmentsWithConstraints({ normals, edges, baseCol, baseMaxCol, relIds }), [normals, edges, baseCol, baseMaxCol, relIds]);
  // AGREE/DISAGREE column override: applied before grouping so grouping can override it
  const { col: agreeDisCol, maxCol: agreeDisMaxCol } = useMemo(() => applyAgreeDisagreeColumnOverride({ normals, edges, col: replyCol, maxCol: replyMaxCol }), [normals, edges, replyCol, replyMaxCol]);
  // Grouping column override: highest priority — arrange/frame-group/replace-overlay/correction-badge source must
  // be in same column as target, overriding any agree/disagree placement for zero-gap stacking.
  const { col: pipelineCol, maxCol: pipelineMaxCol } = useMemo(() => applyGroupingColumnOverride({ normals, edges, col: agreeDisCol, maxCol: agreeDisMaxCol }), [normals, edges, agreeDisCol, agreeDisMaxCol]);
  // Phase 6: column spreading handled via edges in modelBridge
  const layoutCol = useMemo(() => ({ col: pipelineCol, maxCol: pipelineMaxCol }), [pipelineCol, pipelineMaxCol]);

  const [measuredHeights, setMeasuredHeights] = useState<Record<string,number>>({});
  // Reserved: populate via ResizeObserver when cards need variable widths (e.g. MERGE headers).
  const [measuredWidths] = useState<Record<string,number>>({});
  const [positionedEdges, setPositionedEdges] = useState<PositionedEdge[]>([]);
  const [labelBboxes, setLabelBboxes] = useState<Record<string,LabelBbox>>({});
  const [selectedActualRects, setSelectedActualRects] = useState<Record<string, Rect>>({});
  const [decorationRectsState, setDecorationRectsState] = useState<Record<string,{kind:"agree"|"disagree";rect:Rect;iconRect:Rect;bodyRect:Rect;key:string;messageId:string}>|null>(null);
  const [decorationsByMsgState, setDecorationsByMsgState] = useState<Record<string,{agreeCount:number;disagreeCount:number;agreeKey:string;disagreeKey:string}>|null>(null);
  // TAG decorations: aggregated by label text — map from messageId → list of {label, relMsgIds, rect, relAgreeCount, relDisagreeCount, relAgreeMsgIds, relDisagreeMsgIds}
  const [tagDecorationsByMsg, setTagDecorationsByMsg] = useState<Record<string,{label:string;relMsgIds:string[];rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[]>>({});
  // ARRANGE frames: list of {targetId, sourceId, frame rect, isBlankCorrected, relAgreeCount, ...}
  // isBlankCorrected: true when the arrange is targeted by a CORRECT with no replacement (anon source) —
  // the SVG frame border is hidden but the correction badge remains visible.
  const [arrangeFrames, setArrangeFrames] = useState<{targetId:string;sourceId:string;relMsgId:string;isBlankCorrected:boolean;rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[]>([]);
  // GROUP frames: frame-group (CLASSIFY/MERGE) and replace-overlay (SUMMARY) — same visual structure as arrange frames
  // relKind field distinguishes arrange-frame / frame-group / replace-overlay for styling
  // isBlankCorrected: same semantics as for arrangeFrames above.
  const [groupFrames, setGroupFrames] = useState<{targetId:string;sourceId:string;relMsgId:string;relType:string;isBlankCorrected:boolean;relKind:PresentationKind;relLabel:string;relColor:string;rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[]>([]);
  // INLINE BADGES: RECOMMEND / ARCHIVE — small badge anchored to the target message card
  const [inlineBadgesByMsg, setInlineBadgesByMsg] = useState<Map<string,Array<{relMsgId:string;relMsgIds?:string[];relKind:string;relLabel:string;relColor:string;rect:Rect;subDetails?:Array<{subType:string;customLabel?:string;count:number}>}>>>(new Map());
  // AGREE/DISAGREE decorations targeting relation messages — for edge-label relations (annotation/reference/reply)
  const [relDecByRelMsgState, setRelDecByRelMsgState] = useState<Map<string,{agreeCount:number;disagreeCount:number;agreeRelMsgIds:string[];disagreeRelMsgIds:string[]}>>(new Map());
  // TAG relations targeting relation messages — for rendering next to edge labels / arrange frames
  const [tagsByRelMsgState, setTagsByRelMsgState] = useState<Map<string,Array<{label:string;relMsgId:string}>>>(new Map());

  const canvasRightPad = props.comparisonDisplay ? CANVAS_RIGHT_PAD + COMPARISON_CANVAS_EXTRA_RIGHT_PAD : CANVAS_RIGHT_PAD;
  const canvasWidth = GRID_LEFT + (pipelineMaxCol+1)*CARD_W + pipelineMaxCol*COL_GAP + canvasRightPad;
  const edgesByRelMsg = useMemo(() => {
    const map = new Map<string,DemoEdge[]>();
    for (const e of edges) { const arr=map.get(e.relationMessageId)??[]; arr.push(e); map.set(e.relationMessageId,arr); }
    return map;
  }, [edges]);

  const selectedAnnotationRelMsgIds = useMemo(() => {
    const selected = new Set<string>();
    if (lastClickedMessageId) selected.add(lastClickedMessageId);
    for (const u of draftUnits) selected.add(u.messageId);
    const annotationIds = new Set<string>();
    for (const relId of selected) {
      const relType = edgesByRelMsg.get(relId)?.[0]?.relationType
        ?? (msgMap.get(relId)?.kind === 'relation' ? msgMap.get(relId)?.relationType : undefined);
      if (relType === 'annotation') annotationIds.add(relId);
    }
    return annotationIds;
  }, [lastClickedMessageId, draftUnits, edgesByRelMsg, msgMap]);

  const annotationTargetFragmentHints = useMemo(() => {
    const fragmentKeys = new Set<string>();
    if (selectedAnnotationRelMsgIds.size === 0) return fragmentKeys;
    for (const e of edges) {
      if (e.relationType !== 'annotation') continue;
      if (!selectedAnnotationRelMsgIds.has(e.relationMessageId)) continue;
      if (selectionIsText(e.to.selection)) {
        fragmentKeys.add(`${e.to.messageId}::${e.to.selection.start}:${e.to.selection.len}:annotation`);
      }
    }
    return fragmentKeys;
  }, [edges, selectedAnnotationRelMsgIds]);

  const notifyUsersByRelationMsg = useMemo(() => {
    const result = new Map<string, Array<{ id: string; username: string }>>();
    for (const message of messages) {
      if (message.kind !== 'relation' || message.relationType !== 'notify') continue;
      const payloadUsers = Array.isArray(message.relationPayload?.notifyUsers)
        ? message.relationPayload.notifyUsers.filter(user => user && typeof user.id === 'string' && typeof user.username === 'string')
        : [];
      if (payloadUsers.length > 0) {
        result.set(message.id, Array.from(new Map(payloadUsers.map(user => [user.id, user])).values()));
        continue;
      }
      const ids = Array.isArray(message.relationPayload?.notifyUserIds)
        ? message.relationPayload.notifyUserIds.filter((id): id is string => typeof id === 'string')
        : [];
      if (ids.length > 0) result.set(message.id, Array.from(new Set(ids), id => ({ id, username: `与会者 ${id}` })));
    }
    return result;
  }, [messages]);

  // IDs of all targets of CORRECT relations that have a real (non-anonymous) replacement source.
  // Their cards are hidden in the non-linear view because the replacement source card/edge
  // takes the same position, effectively replacing the target.
  // Only hide when the CORRECT relation has a non-anon source — if there is no replacement
  // (secondary type = "none", anon: source), the original remains visible with a correction badge.
  const correctedTargetMsgIds = useMemo(() => {
    // CORRECT is a version relation. The original target card remains visible;
    // its projected content is supplied by the parent view model.
    return new Set<string>();
  }, [edges]);

  // Map: target message ID → CORRECT revision records. The target card remains
  // the canonical card; each revision is only a version badge on that card.
  const correctionsByTargetMsgId = useMemo(() => {
    const map = new Map<string, Array<{relMsgId: string; targetMsgId: string}>>();
    for (const e of edges) {
      if (e.relationType !== 'correct') continue;
      const targetId = e.to.messageId;
      const arr = map.get(targetId) ?? [];
      arr.push({ relMsgId: e.relationMessageId, targetMsgId: e.to.messageId });
      map.set(targetId, arr);
    }
    return map;
  }, [edges, msgMap]);

  const correctionVersionsByTargetMsgId = useMemo(
    () => computeCorrectionVersions(messages, edges, invalidCorrectionIds),
    [messages, edges, invalidCorrectionIds],
  );

  // Corrected-target IDs that are NOT themselves correction sources.
  // A message that corrects another while also being corrected (chained correction) must
  // remain visible so its own correction badge is not lost.
  const hiddenCorrectedTargetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of correctedTargetMsgIds) {
      if (!correctionsByTargetMsgId.has(id)) ids.add(id);
    }
    return ids;
  }, [correctedTargetMsgIds, correctionsByTargetMsgId]);

  // Summary-target IDs: all text-message targets of SUMMARY relations.
  // These are hidden in the non-linear view — the summary card replaces them.
  const summaryTargetMsgIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of edges) {
      if (e.relationType !== 'summary') continue;
      if (e.to.selection.kind !== 'whole' && e.to.selection.kind !== 'text') continue;
      ids.add(e.to.messageId);
    }
    return ids;
  }, [edges]);

  // Summary-target IDs that are NOT themselves summary source messages.
  // A summary that is also summarized by another (chained) remains visible.
  const hiddenSummaryTargetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of summaryTargetMsgIds) {
      if (!summaryRelMsgIds.has(id)) ids.add(id);
    }
    return ids;
  }, [summaryTargetMsgIds, summaryRelMsgIds]);

  // Combined set of all hidden target message IDs (CORRECT + SUMMARY).
  const hiddenTargetIds = useMemo(() => {
    const ids = new Set(hiddenCorrectedTargetIds);
    const directlyTracedSummaryMemberIds = new Set<string>();
    for (const edge of edges) {
      if (edge.relationType !== 'summary' || !traceExpandedFrameIds.has(edge.relationMessageId)) continue;
      if (!edge.from.messageId.startsWith('anon:')) directlyTracedSummaryMemberIds.add(edge.from.messageId);
      if (!edge.to.messageId.startsWith('anon:')) directlyTracedSummaryMemberIds.add(edge.to.messageId);
    }
    for (const id of hiddenSummaryTargetIds) {
      if (!directlyTracedSummaryMemberIds.has(id)) ids.add(id);
    }
    return ids;
  }, [edges, hiddenCorrectedTargetIds, hiddenSummaryTargetIds, traceExpandedFrameIds, traceFrameIds]);

  // Build frame blocks: identify which cards belong to which frames (arrange/merge/classify/summary).
  // This is computed before the layout so frames are placed as atomic units.
  // visibleCardIds includes all cards that endpointBoxForNormal can find (normals + tag sources).
  const visibleCardIds = useMemo(() => {
    const ids = new Set(normalIds);
    for (const m of messages) {
      if (!traceExpandedFrameIds.has(m.id) && (isContentKind(m.kind) || relationCardMsgIds.has(m.id))) ids.add(m.id);
    }
    return ids;
  }, [messages, normalIds, relationCardMsgIds, traceExpandedFrameIds]);
  const traceEmbeddedFrameIds = useMemo(() => {
    const ids = new Set(traceExpandedFrameIds);
    for (const edge of edges) {
      if (!traceExpandedFrameIds.has(edge.relationMessageId)) continue;
      for (const endpointId of [edge.from.messageId, edge.to.messageId]) {
        if (traceFrameIds.has(endpointId)) ids.add(endpointId);
      }
    }
    return ids;
  }, [edges, traceExpandedFrameIds, traceFrameIds]);
  const frameBlocks = useMemo(() => {
    const blocks = buildFrameBlocks({ edges, visibleCardIds, msgMap, keepEmptyFrameIds: traceEmbeddedFrameIds, traceMode: isTraceWindow });
    if (!isTraceWindow) return blocks;
    return blocks.filter(block =>
      !['classify', 'summary'].includes(msgMap.get(block.relMsgId)?.relationType ?? '')
      || traceEmbeddedFrameIds.has(block.relMsgId),
    );
  }, [edges, visibleCardIds, msgMap, traceExpandedFrameIds, traceEmbeddedFrameIds, isTraceWindow]);
  // Compute nesting depth for each frame: root=0, child=parentDepth+1
  const frameDepthMap = useMemo(() => {
    const depth = new Map<string, number>();
    const computeDepth = (relMsgId: string, d: number) => {
      if (depth.has(relMsgId)) return;
      depth.set(relMsgId, d);
      const block = frameBlocks.find(b => b.relMsgId === relMsgId);
      if (block) block.childRelMsgIds.forEach(cid => computeDepth(cid, d + 1));
    };
    for (const fb of frameBlocks) {
      if (!frameBlocks.some(other => other.childRelMsgIds.includes(fb.relMsgId))) {
        computeDepth(fb.relMsgId, 0);
      }
    }
    return depth;
  }, [frameBlocks]);

  // ── Two-pass layout: pass 1 gets frame rects, correct columns, pass 2 is final ──
  // Pass 1: compute initial layout solely to obtain actual frame rects
  const { frameRects: pass1FrameRects } = useMemo(
    () => computeNoOverlapLayout({ normals, colOf: pipelineCol, measuredHeights, measuredWidths, maxCol: pipelineMaxCol, correctedTargetIds: hiddenTargetIds, frameBlocks, allMessages: messages, activeTextSelectId, traceMode: isTraceWindow }),
    [normals, pipelineCol, measuredHeights, measuredWidths, pipelineMaxCol, hiddenTargetIds, frameBlocks, messages, activeTextSelectId, isTraceWindow]
  );

  // Column correction: push anno/ref/reply sources targeting frames to the right of the frame's actual visual boundary
  const correctedResult = useMemo(
    () => computeFrameAwareColumnCorrection({ normals, edges, colOf: layoutCol.col, maxCol: layoutCol.maxCol, frameRects: pass1FrameRects }),
    [normals, edges, layoutCol.col, layoutCol.maxCol, pass1FrameRects]
  );
  const colOf = correctedResult.col;
  const maxCol = correctedResult.maxCol;

  // Pass 2: final layout with corrected columns
  const { layout: pass2Layout, canvasHeight: pass2CanvasHeight, frameRects: baseFrameRects } = useMemo(
    () => computeNoOverlapLayout({ normals, colOf, measuredHeights, measuredWidths, maxCol, correctedTargetIds: hiddenTargetIds, frameBlocks, allMessages: messages, activeTextSelectId, traceMode: isTraceWindow }),
    [normals, colOf, measuredHeights, measuredWidths, maxCol, hiddenTargetIds, frameBlocks, messages, activeTextSelectId, isTraceWindow]
  );

  // Compact: shift anno/ref source clusters toward their targets
  const { layout: compactedLayout, canvasHeight: compactedCanvasHeight } = useMemo(
    () => compactAnnoRefClusters({
      layout: pass2Layout,
      normals,
      colOf,
      edges,
      allFrameRects: { ...baseFrameRects, ...pass1FrameRects },
      frameMemberIds: new Set(frameBlocks.flatMap(frame => [...frame.cardIds])),
      canvasHeight: pass2CanvasHeight,
    }),
    [pass2Layout, normals, colOf, edges, baseFrameRects, pass1FrameRects, frameBlocks, pass2CanvasHeight]
  );

  const expandFrameRectsToMembers = (sourceRects: Record<string, Rect>, currentLayout: Record<string, LayoutBox>) => {
    const next = { ...sourceRects };
    const normalIds = new Set(normals.map(message => message.id));
    const frameById = new Map(frameBlocks.map(frame => [frame.relMsgId, frame]));
    const expanded = new Set<string>();
    const expandFrame = (frame: FrameBlock) => {
      if (expanded.has(frame.relMsgId)) return next[frame.relMsgId];
      for (const childId of frame.childRelMsgIds) {
        const child = frameById.get(childId);
        if (child) expandFrame(child);
      }
      const rect = next[frame.relMsgId];
      if (!rect) return undefined;
      let left = rect.x;
      let top = rect.y;
      let right = rect.x + rect.width;
      let bottom = rect.y + rect.height;
      let contentTop = Infinity;
      // cardIds is transitive and includes cards inside child frames. Those
      // cards are already represented by the child frame rect; using them
      // here expands the parent twice and creates artificial empty space.
      for (const memberId of frame.directCardIds) {
        if (!normalIds.has(memberId)) continue;
        const member = currentLayout[memberId];
        if (!member) continue;
        contentTop = Math.min(contentTop, member.y);
        left = Math.min(left, member.x - FRAME_PAD_X);
        right = Math.max(right, member.x + member.width + FRAME_PAD_X);
        top = Math.min(top, member.y - FRAME_PAD_Y);
        bottom = Math.max(bottom, member.y + member.height + FRAME_PAD_Y);
      }
      for (const childId of frame.childRelMsgIds) {
        const child = frameById.get(childId);
        const childRect = next[childId];
        if (childRect) {
          const childHeaderHeight = child?.hasGroupHeader
            ? getGroupHeaderHeight(measuredHeights, childId)
            : 0;
          const occupiedChildRect = childHeaderHeight > 0
            ? { ...childRect, y: childRect.y - childHeaderHeight, height: childRect.height + childHeaderHeight }
            : childRect;
          left = Math.min(left, occupiedChildRect.x - FRAME_PAD_X);
          right = Math.max(right, occupiedChildRect.x + occupiedChildRect.width + FRAME_PAD_X);
          top = Math.min(top, occupiedChildRect.y - FRAME_PAD_Y);
          bottom = Math.max(bottom, occupiedChildRect.y + occupiedChildRect.height + FRAME_PAD_Y);
          contentTop = Math.min(contentTop, occupiedChildRect.y);
        }
      }
      if (contentTop !== Infinity) {
        const headerPad = frame.isMerge ? MERGE_CARD_H + MERGE_CONTENT_TOP_GAP : 0;
        top = Math.min(top, contentTop - FRAME_PAD_Y - headerPad);
      }
      next[frame.relMsgId] = { x: left, y: top, width: right - left, height: bottom - top };
      expanded.add(frame.relMsgId);
      return next[frame.relMsgId];
    };
    for (const frame of frameBlocks) expandFrame(frame);
    return next;
  };

  const expandedFrameRects = useMemo(
    () => expandFrameRectsToMembers(baseFrameRects, compactedLayout),
    [baseFrameRects, compactedLayout, frameBlocks, normals, msgMap]
  );

  // Frame avoidance — safety net ensuring frames don't overlap with cards below
  const frameAvoidanceReservations = useMemo(
    () => buildFrameLayoutUnits({ frameBlocks, layout: compactedLayout, frameRects: expandedFrameRects, measuredHeights }),
    [frameBlocks, compactedLayout, expandedFrameRects, measuredHeights]
  );
  const { layout, canvasHeight } = useMemo(
    () => {
      // A member can grow after entering text-selection mode. Re-run the
      // external layout after the frame rect is expanded from that member;
      // one pass is insufficient because the expanded frame is itself the
      // obstacle that determines the next card positions.
      let currentLayout = compactedLayout;
      let currentReservations = frameAvoidanceReservations;
      let currentCanvasHeight = compactedCanvasHeight;
      for (let pass = 0; pass < 3; pass++) {
        const result = applyFrameAvoidanceReservations({
          layout: currentLayout,
          normals,
          colOf,
          reservations: currentReservations,
          minCanvasHeight: currentCanvasHeight,
          msgMap,
          edgesByRelMsg,
          relationCardMsgIds,
        });
        currentLayout = result.layout;
        currentCanvasHeight = result.canvasHeight;
        const settledFrameRects = expandFrameRectsToMembers(baseFrameRects, currentLayout);
        currentReservations = buildFrameLayoutUnits({
          frameBlocks,
          layout: currentLayout,
          frameRects: settledFrameRects,
          measuredHeights,
        });
      }
      return { layout: currentLayout, canvasHeight: currentCanvasHeight };
    },
    [compactedLayout, normals, colOf, frameAvoidanceReservations, compactedCanvasHeight, msgMap, edgesByRelMsg, relationCardMsgIds, baseFrameRects, frameBlocks, measuredHeights]
  );
  
  const finalFrameRects = useMemo(() => {
    // Recompute after frame avoidance so rendering matches the protected layout.
    return expandFrameRectsToMembers(baseFrameRects, layout);
  }, [baseFrameRects, frameBlocks, layout, normals]);
  const actualCanvasWidth = useMemo(() => {
    let w = canvasWidth;
    for (const box of Object.values(layout)) w = Math.max(w, box.x + box.width + canvasRightPad);
    for (const r of Object.values(finalFrameRects)) w = Math.max(w, r.x + r.width + canvasRightPad);
    return w;
  }, [canvasWidth, canvasRightPad, layout, finalFrameRects]);
  const actualCanvasHeight = useMemo(() => {
    let h = canvasHeight;
    for (const box of Object.values(layout)) h = Math.max(h, box.y + box.height + CANVAS_BOTTOM_PAD);
    for (const r of Object.values(finalFrameRects)) h = Math.max(h, r.y + r.height + CANVAS_BOTTOM_PAD);
    return h;
  }, [canvasHeight, layout, finalFrameRects]);
  const visibleArrangeFrames = arrangeFrames.filter(frame => !effectiveHideMessageIds.has(frame.relMsgId));
  const renderedGroupFrames = groupFrames.map(frame => {
    const rect = finalFrameRects[frame.relMsgId];
    return rect ? { ...frame, rect } : frame;
  });
  const visibleGroupFrames = renderedGroupFrames.filter(frame =>
    !effectiveHideMessageIds.has(frame.relMsgId) &&
    (!isTraceWindow || !['classify', 'summary'].includes(frame.relType)
      || traceFrameIds.has(frame.relMsgId) || traceExpandedFrameIds.has(frame.relMsgId)) &&
    (!traceFrameIds.has(frame.relMsgId) || traceExpandedFrameIds.has(frame.relMsgId)),
  );

  const selectedMessageIds = useMemo(() => new Set([
    ...draftUnits
      .filter(unit => unit.selection.kind === 'whole')
      .map(unit => unit.messageId),
    ...(lastClickedMessageId ? [lastClickedMessageId] : []),
  ]), [draftUnits, lastClickedMessageId]);

  useLayoutEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const canvasRect = canvasEl.getBoundingClientRect();
    const scaleX = canvasEl.offsetWidth > 0 ? canvasRect.width / canvasEl.offsetWidth : 1;
    const scaleY = canvasEl.offsetHeight > 0 ? canvasRect.height / canvasEl.offsetHeight : 1;
    const next: Record<string, Rect> = {};
    const unionRects = (first: Rect, second: Rect): Rect => {
      const right = Math.max(first.x + first.width, second.x + second.width);
      const bottom = Math.max(first.y + first.height, second.y + second.height);
      const x = Math.min(first.x, second.x);
      const y = Math.min(first.y, second.y);
      return { x, y, width: right - x, height: bottom - y };
    };
    const toCanvasRect = (rect: DOMRect): Rect => ({
      x: (rect.left - canvasRect.left) / scaleX,
      y: (rect.top - canvasRect.top) / scaleY,
      width: rect.width / scaleX,
      height: rect.height / scaleY,
    });
    for (const messageId of selectedMessageIds) {
      const element = cardRefs.current[messageId];
      const actualRect = element?.getBoundingClientRect();
      let selectedRect = actualRect && actualRect.width > 1 && actualRect.height > 1
        ? toCanvasRect(actualRect)
        : undefined;
      const selectedFrame = visibleGroupFrames.find(frame =>
        frame.relMsgId === messageId && (frame.relType === 'classify' || frame.relType === 'summary')
      );
      const frameRect = selectedFrame?.rect ?? (selectedFrame ? finalFrameRects[messageId] : undefined);
      if (frameRect) selectedRect = selectedRect ? unionRects(selectedRect, frameRect) : frameRect;
      if (selectedRect) next[messageId] = selectedRect;
    }
    setSelectedActualRects(prev => {
      const prevIds = Object.keys(prev);
      const nextIds = Object.keys(next);
      if (prevIds.length === nextIds.length && nextIds.every(id => {
        const before = prev[id];
        const after = next[id];
        return before && Math.abs(before.x - after.x) < 0.5 && Math.abs(before.y - after.y) < 0.5
          && Math.abs(before.width - after.width) < 0.5 && Math.abs(before.height - after.height) < 0.5;
      })) return prev;
      return next;
    });
  }, [selectedMessageIds, visibleGroupFrames, finalFrameRects, layout, actualCanvasWidth, actualCanvasHeight, measuredHeights]);

  useEffect(() => {
    if (!props.autoCenterMessageId) return;
    const target = cardRefs.current[props.autoCenterMessageId];
    if (!target) return;
    target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
  }, [props.autoCenterMessageId, layout]);

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
        const canvasEl = canvasRef.current;
        const canvasRect = canvasEl?.getBoundingClientRect();
        const scaleY = canvasEl && canvasEl.offsetHeight > 0 && canvasRect
          ? canvasRect.height / canvasEl.offsetHeight
          : 1;
        const measuredHeight = Math.ceil(el.getBoundingClientRect().height / scaleY);
        next[id] = Math.max(MIN_CARD_H, measuredHeight);
      }
      if (!Object.keys(next).length) return;
      setMeasuredHeights(prev => {
        let changed=false; const merged={...prev};
        for (const [k,v] of Object.entries(next)) if (!merged[k]||Math.abs(merged[k]-v)>1) { merged[k]=v; changed=true; }
        return changed ? merged : prev;
      });
    });
    for (const m of normals) { const el=cardRefs.current[m.id]; if (el) ro.observe(el); }
    for (const frame of visibleGroupFrames) {
      const el = cardRefs.current[frame.relMsgId];
      if (el) ro.observe(el);
    }
    return () => ro.disconnect();
  }, [normals, layout, activeTextSelectId, visibleGroupFrames]);

  useEffect(() => {
    const canvasEl = canvasRef.current; if (!canvasEl) return;
    const canvasRect = canvasEl.getBoundingClientRect();
    const scaleX = canvasEl.offsetWidth > 0 ? canvasRect.width / canvasEl.offsetWidth : 1;
    const scaleY = canvasEl.offsetHeight > 0 ? canvasRect.height / canvasEl.offsetHeight : 1;
    const toCanvasRect = (rect: DOMRect): Rect => ({
      x: (rect.left - canvasRect.left) / scaleX,
      y: (rect.top - canvasRect.top) / scaleY,
      width: rect.width / scaleX,
      height: rect.height / scaleY,
    });
    const normalSet = new Set(normalIds);

    function endpointBoxForNormal(id: string): {box:LayoutBox;col:number}|null {
      const m = msgMap.get(id);
      // Accept both normal text messages and relation messages currently rendered as cards.
      if (!m || (!isContentKind(m.kind) && !relationCardMsgIds.has(id))) return null;
      const cardEl = cardRefs.current[id];
      if (cardEl) {
        const r = cardEl.getBoundingClientRect();
        // Only trust the DOM rect when the element has real dimensions (>1px).
        // After a focus-mode transition, stale refs to unmounted cards may return
        // zero-area rects, which would place edges at (0,0) making them invisible.
        if (r.width > 1 && r.height > 1) {
          return { box:toCanvasRect(r), col:colOf[id]??0 };
        }
      }
      const box = layout[id]; if (!box) return null;
      return { box, col:colOf[id]??0 };
    }

    const globalForbiddenRects: Rect[] = [];
    for (const m of normals) {
      const header=headerRefs.current[m.id], content=contentRefs.current[m.id];
      if (!header||!content) {
        const el=cardRefs.current[m.id];
        if (el) for (const r of Array.from(el.getClientRects())) globalForbiddenRects.push(toCanvasRect(r));
        continue;
      }
      for (const ref of [...Array.from(header.getClientRects()),...Array.from(content.getClientRects())])
        globalForbiddenRects.push(toCanvasRect(ref));
    }

    function getMessageRects(messageId: string): Rect[] {
      const res: Rect[] = [];
      const header=headerRefs.current[messageId], content=contentRefs.current[messageId];
      for (const el of [header,content].filter(Boolean) as HTMLElement[])
        for (const r of Array.from(el.getClientRects())) res.push(toCanvasRect(r));
      const cardEl=cardRefs.current[messageId];
      if (cardEl) for (const r of Array.from(cardEl.getClientRects())) res.push(toCanvasRect(r));
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

    const decorationsByMsg = computeTransitiveVoteStats(edges, messages);

    // Decorations are placed to the RIGHT of the card, stacked vertically (agree on top, disagree below).
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
        const tagW=Math.max(TAG_MIN_W, label.length*8+8+28);
        const rect={x:tagX,y:tagY,width:tagW,height:TAG_H};
        newTagDecorationsByMsg[mid].push({label,relMsgIds:[e.relationMessageId],rect,relAgreeCount:0,relDisagreeCount:0,relAgreeMsgIds:[],relDisagreeMsgIds:[]});
        globalForbiddenRects.push(rect);
      }
    }

    // Compute ARRANGE frames — one frame per relation message (relMsgId), wrapping all target
    // messages and the source message (if any) within a single border frame.
    const newArrangeFrames: {targetId:string;sourceId:string;relMsgId:string;isBlankCorrected:boolean;rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[] = [];
    // Compute GROUP frames — frame-group (CLASSIFY/MERGE) and replace-overlay (SUMMARY).
    // Same structure as arrange frames; relKind/relLabel/relColor distinguish them for styling.
    // Note: CORRECT uses correction-badge kind (not replace-overlay) — no frame, badge only.
    const newGroupFrames: {targetId:string;sourceId:string;relMsgId:string;relType:string;isBlankCorrected:boolean;relKind:PresentationKind;relLabel:string;relColor:string;rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[] = [];

    // Generic frame computation — shared logic for arrange, frame-group, replace-overlay.
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
        // DOM-aware box lookup: use actual rendered positions so ARRANGE frames fully contain
        // nested relation frames whose card heights may exceed their initial layout estimates.
        const domBoxFn = (id: string) => endpointBoxForNormal(id)?.box ?? layout[id];
        let anyTarget = false;
        for (const e of frameEdges) {
          const relationTargetBounds = msgMap.get(e.to.messageId)?.kind === "relation"
            ? getRelationBoundsFromLayout({ relMsgId: e.to.messageId, edgesByRelMsg, layout, msgMap, relationCardMsgIds, boxFn: domBoxFn })
            : null;
          const targetBox = relationTargetBounds?.rect ?? endpointBoxForNormal(e.to.messageId)?.box ?? layout[e.to.messageId];
          if (!targetBox) continue;
          anyTarget = true;
          minX = Math.min(minX, targetBox.x); minY = Math.min(minY, targetBox.y);
          maxX = Math.max(maxX, targetBox.x + targetBox.width); maxY = Math.max(maxY, targetBox.y + targetBox.height);
        }
        if (!anyTarget && !sourceBox) {
          const emptyFrameRect = finalFrameRects[relMsgId];
          const isEmptyExpandedFrame = traceExpandedFrameIds.has(relMsgId) &&
            (relType === 'classify' || relType === 'summary') && !!emptyFrameRect;
          if (!isEmptyExpandedFrame) continue;
        }
        if (minX === Infinity) {
          const emptyFrameRect = finalFrameRects[relMsgId];
          const isEmptyExpandedFrame = traceExpandedFrameIds.has(relMsgId) &&
            (relType === 'classify' || relType === 'summary') && !!emptyFrameRect;
          if (!isEmptyExpandedFrame) continue;
          minX = emptyFrameRect.x;
          minY = emptyFrameRect.y;
          maxX = emptyFrameRect.x + emptyFrameRect.width;
          maxY = emptyFrameRect.y + emptyFrameRect.height;
        }
        // The layout pass already computes the complete frame, including
        // nested frames and padding. Do not rebuild it from DOM members here:
        // that would apply padding a second time and make rendering disagree
        // with the layout used for collision avoidance.
        const rect = finalFrameRects[relMsgId] ?? {
          x: minX - FRAME_PAD, y: minY - FRAME_PAD,
          width: maxX - minX + FRAME_PAD * 2, height: maxY - minY + FRAME_PAD * 2,
        };
        const targetId = frameEdges[0].to.messageId;
        appendFn({ targetId, sourceId, relMsgId, relType, isBlankCorrected, relKind: spec.kind, relLabel: spec.label, relColor: spec.color, rect, relAgreeCount:0, relDisagreeCount:0, relAgreeMsgIds:[], relDisagreeMsgIds:[] });
      }
    }

    computeFramesForRelType(isArrangeFrameRel, f => newArrangeFrames.push({ targetId:f.targetId, sourceId:f.sourceId, relMsgId:f.relMsgId, isBlankCorrected:f.isBlankCorrected, rect:f.rect, relAgreeCount:f.relAgreeCount, relDisagreeCount:f.relDisagreeCount, relAgreeMsgIds:f.relAgreeMsgIds, relDisagreeMsgIds:f.relDisagreeMsgIds }));
    computeFramesForRelType(t => !isArrangeFrameRel(t) && isAnyFrameRel(t), f => newGroupFrames.push(f));
    for (const frame of newGroupFrames) {
      const layoutRect = finalFrameRects[frame.relMsgId];
      if (layoutRect) frame.rect = layoutRect;
    }

    // For MERGE group frames: extend upward to include the card-style header inside the frame.
    // Skip when the rect already comes from baseFrameRects (header already applied).
    const mergeHeaderTopPad = MERGE_CARD_H + FRAME_PAD + MERGE_CONTENT_TOP_GAP;
    for (const gf of newGroupFrames) {
      if (gf.relType === 'merge') {
        const fromBaseRects = !!finalFrameRects[gf.relMsgId];
        if (fromBaseRects) continue;
        let rightEdge = gf.rect.x + gf.rect.width;
        let bottomEdge = gf.rect.y + gf.rect.height;
        // Extend past nested arrange frames geometrically contained in this merge
        for (const af of newArrangeFrames) {
          if (af.rect.x >= gf.rect.x && af.rect.y >= gf.rect.y &&
              af.rect.y + af.rect.height <= gf.rect.y + gf.rect.height) {
            rightEdge = Math.max(rightEdge, af.rect.x + af.rect.width + FRAME_PAD * 2);
            bottomEdge = Math.max(bottomEdge, af.rect.y + af.rect.height + FRAME_PAD);
          }
        }
        // Also extend past nested group frames (e.g. classify / summary) inside this merge
        for (const ogf of newGroupFrames) {
          if (ogf.relMsgId === gf.relMsgId) continue;
          if (ogf.rect.x >= gf.rect.x && ogf.rect.y >= gf.rect.y &&
              ogf.rect.y + ogf.rect.height <= gf.rect.y + gf.rect.height) {
            rightEdge = Math.max(rightEdge, ogf.rect.x + ogf.rect.width + FRAME_PAD * 2);
            bottomEdge = Math.max(bottomEdge, ogf.rect.y + ogf.rect.height + FRAME_PAD);
          }
        }
        const expandedHeight = Math.max(gf.rect.height, bottomEdge - gf.rect.y);
        if (fromBaseRects) {
          // baseFrameRects already includes merge header; only apply right/bottom extensions
          gf.rect = { ...gf.rect, width: rightEdge - gf.rect.x, height: expandedHeight };
        } else {
          // Fallback: computed via per-edge union, need to add header pad
          gf.rect = { ...gf.rect, width: rightEdge - gf.rect.x, y: gf.rect.y - mergeHeaderTopPad, height: expandedHeight + mergeHeaderTopPad };
        }
      }
    }

    // Compute AGREE/DISAGREE decorations targeting relation messages (relDecByRelMsgId)
    // These are displayed next to the relation's visual element (tag badge, arrange frame, edge label).
    // Uses transitive resolution: disagree-on-disagree projects as agree on the original target.
    const relDecByRelMsgId = computeTransitiveRelDecStats(edges, messages);
    // Propagate counts and IDs to tag groups, arrange frames, and group frames
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
    for (const sf of [...newArrangeFrames, ...newGroupFrames]) {
      const dec=relDecByRelMsgId.get(sf.relMsgId);
      if (dec) {
        sf.relAgreeCount+=dec.agreeCount; sf.relDisagreeCount+=dec.disagreeCount;
        sf.relAgreeMsgIds.push(...dec.agreeRelMsgIds); sf.relDisagreeMsgIds.push(...dec.disagreeRelMsgIds);
      }
    }
    setRelDecByRelMsgState(relDecByRelMsgId);
    setTagDecorationsByMsg(newTagDecorationsByMsg);
    setArrangeFrames(newArrangeFrames);
    setGroupFrames(newGroupFrames);

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
    const frameByRelMsgId = new Map<string,Rect>();
    for (const sf of newArrangeFrames) frameByRelMsgId.set(sf.relMsgId, sf.rect);

    const groupFrameByRelMsgId = new Map<string,Rect>();
    for (const gf of newGroupFrames) groupFrameByRelMsgId.set(gf.relMsgId, gf.rect);

    // Compute INLINE BADGES — RECOMMEND / ARCHIVE: small badge anchored to target message card.
    // Positioned after frameByRelMsgId / groupFrameByRelMsgId so frame targets resolve correctly.
    const BADGE_W = 56, BADGE_H = 18, BADGE_RIGHT_GAP = -6, BADGE_TOP_OFFSET = -8;
    // Aggregate RECOMMEND/ARCHIVE badges by (target message, relationType) —
    // all subTypes of the same type share one badge with a unified send count.
    const inlineBadgeGroups = new Map<string, { relMsgIds: string[]; relType: string; subDetails: Array<{subType:string;customLabel?:string;count:number}> }>();
    for (const e of edges) {
      if (getRelKind(e.relationType) !== 'inline-badge') continue;
      if (e.to.selection.kind !== 'whole') continue;
      const mid = e.to.messageId;
      const targetMsg = msgMap.get(mid);
      const isInlineBadgeTargetCard = !!targetMsg && (
        isContentKind(targetMsg.kind) ||
        (targetMsg.kind === 'relation' && (
          relationCardMsgIds.has(mid) ||
          frameByRelMsgId.has(mid) ||
          groupFrameByRelMsgId.has(mid)
        ))
      );
      if (!isInlineBadgeTargetCard) continue;
      const ep = endpointBoxForNormal(mid), frameRect = frameByRelMsgId.get(mid) ?? groupFrameByRelMsgId.get(mid);
      const box = ep?.box ?? layout[mid] ?? (frameRect ? { x: frameRect.x, y: frameRect.y, width: frameRect.width, height: frameRect.height } : null);
      if (!box) continue;
      const rt = e.relationType.toUpperCase();
      const groupKey = `${mid}|${rt}`;
      let group = inlineBadgeGroups.get(groupKey);
      if (!group) {
        group = { relMsgIds: [], relType: rt, subDetails: [] };
        inlineBadgeGroups.set(groupKey, group);
      }
      const relMsg = msgMap.get(e.relationMessageId);
      const rp = (relMsg as any)?.relationPayload as Record<string,unknown> | undefined;
      const sc = (rp?.sendCount as number) ?? 1;
      const st = rp?.subType as string | undefined;
      // Aggregate: add relMsgId and subType detail
      if (!group.relMsgIds.includes(e.relationMessageId)) {
        group.relMsgIds.push(e.relationMessageId);
      }
      if (st) {
        const existing = group.subDetails.find(d => d.subType === st);
        if (existing) {
          existing.count += sc;
        } else {
          group.subDetails.push({ subType: st, customLabel: rp?.customLabel as string | undefined, count: sc });
        }
      }
    }
    // Build badges from aggregated groups
    const newInlineBadgesByMsg = new Map<string, Array<{relMsgId:string;relMsgIds?:string[];relKind:string;relLabel:string;relColor:string;rect:Rect;subDetails?:Array<{subType:string;customLabel?:string;count:number}>}>>();
    for (const [groupKey, group] of inlineBadgeGroups) {
      const [mid, rt] = groupKey.split('|');
      const spec = getPresentationSpec(rt);
      // Sum total sendCount from all subDetails + any non-subType sends
      let totalCount = 0;
      for (const d of group.subDetails) { totalCount += d.count; }
      // Non-subType sends: each relation without subType contributes its sendCount
      for (const rmId of group.relMsgIds) {
        const rm = msgMap.get(rmId);
        const rp = (rm as any)?.relationPayload as Record<string,unknown> | undefined;
        if (!rp?.subType) {
          totalCount += (rp?.sendCount as number) ?? 1;
        }
      }
      if (totalCount <= 0) continue;
      let badgeLabel = spec.label;
      if (totalCount >= 2) badgeLabel = `${badgeLabel} ×${totalCount}`;
      const ep = endpointBoxForNormal(mid), frameRect = frameByRelMsgId.get(mid) ?? groupFrameByRelMsgId.get(mid);
      const box = ep?.box ?? layout[mid] ?? (frameRect ? { x: frameRect.x, y: frameRect.y, width: frameRect.width, height: frameRect.height } : null);
      if (!box) continue;
      const arr = newInlineBadgesByMsg.get(mid) ?? [];
      const badgeX = box.x + box.width - BADGE_W + BADGE_RIGHT_GAP;
      const badgeY = box.y + BADGE_TOP_OFFSET - arr.length * (BADGE_H + 2);
      arr.push({
        relMsgId: group.relMsgIds[0],
        relMsgIds: group.relMsgIds,
        relKind: spec.kind,
        relLabel: badgeLabel,
        relColor: spec.color,
        rect: { x: badgeX, y: badgeY, width: BADGE_W, height: BADGE_H },
        subDetails: group.subDetails.length > 0 ? group.subDetails : undefined,
      });
      newInlineBadgesByMsg.set(mid, arr);
    }
    setInlineBadgesByMsg(newInlineBadgesByMsg);

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
      if (relType === "arrange") {
        const fr = frameByRelMsgId.get(relId);
        return fr ? { x: fr.x, y: fr.y, width: fr.width, height: fr.height } : null;
      }
      // frame-group or replace-overlay: use the computed group frame rect
      const relTypeKind = getPresentationSpec(relType).kind;
      if (relTypeKind === 'frame-group' || relTypeKind === 'replace-overlay' || relTypeKind === 'correction-badge') {
        const fr = groupFrameByRelMsgId.get(relId);
        if (!fr && (relTypeKind === 'frame-group' || relTypeKind === 'replace-overlay')) {
          // A relation whose targets are hidden from this projection is rendered as a card.
          const relCard = endpointBoxForNormal(relId)?.box ?? layout[relId];
          if (relCard) return relCard;
        }
        return fr ? { x: fr.x, y: fr.y, width: fr.width, height: fr.height } : null;
      }
      // CLASSIFY / SUMMARY are edge-label kind but rendered as topic cards in normals.
      // When another relation (e.g. REFERENCE) targets them, use their card position.
      if (relType === 'classify' || relType === 'summary') {
        const relCard = endpointBoxForNormal(relId)?.box ?? layout[relId];
        if (relCard) return relCard;
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
          if (fm && isContentKind(fm.kind)) fromBox = endpointBoxForNormal(te0.from.messageId)?.box ?? null;
        }
      }
      let toBox: LayoutBox | null = null;
      if (msgMap.get(te0.to.messageId)?.kind === "relation") {
        toBox = getRelVisualBox(te0.to.messageId, depth + 1);
      } else {
        const tm = msgMap.get(te0.to.messageId);
        if (tm && isContentKind(tm.kind)) toBox = endpointBoxForNormal(te0.to.messageId)?.box ?? null;
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
    function replyEdgeLabel(raw: string): string {
      const normalized = raw.trim().toLowerCase();
      if (normalized === "question" || normalized === "疑问") return "疑问";
      if (normalized === "answer" || normalized === "回答") return "回答";
      return "回复";
    }
    function referenceEdgeLabel(raw: string): string {
      const normalized = raw.trim().toLowerCase();
      if (normalized === "evidence" || normalized === "证据") return "证据";
      return (normalized === "reference" || normalized === "ref") ? "引用" : raw;
    }
    function notifyEdgeLabel(edge: DemoEdge): string {
      const relationMessage = msgMap.get(edge.relationMessageId);
      const users = relationMessage?.relationPayload?.notifyUsers ?? [];
      const names = users
        .filter(user => user && typeof user.username === 'string')
        .map(user => user.username);
      const legacyIds = relationMessage?.relationPayload?.notifyUserIds ?? [];
      return `${names.length > 0 ? names.join('、') : legacyIds.length > 0 ? legacyIds.join('、') : '与会者'}：通知`;
    }
    const labelText = (e: DemoEdge, author: string) => {
      if (e.relationType === "notify") return notifyEdgeLabel(e);
      if (e.relationType === "reply") return `${author} · ${replyEdgeLabel(e.relationLabel)}`;
      if (e.relationType === "reference") return `${author} · ${referenceEdgeLabel(e.relationLabel)}`;
      return `${author} · ${edgeLabelName(e.relationType)}`;
    };

    for (const e of edges) {
      if (comparisonSuppressedRelIds.has(e.relationMessageId)) continue;
      const fromMsg=msgMap.get(e.from.messageId);
      if (!fromMsg) continue;
      // Container relations are rendered as frames rather than cards.  They can
      // still be the source of an edge relation (for example REPLY), so use the
      // frame bounds as their visual endpoint.
      const fromFrameRect = fromMsg.kind === "relation"
        ? (frameByRelMsgId.get(fromMsg.id) ?? groupFrameByRelMsgId.get(fromMsg.id))
        : undefined;
      if (!isContentKind(fromMsg.kind) && !relationCardMsgIds.has(fromMsg.id) && !fromFrameRect) continue;
      const fromEp=endpointBoxForNormal(fromMsg.id);
      const fromBox = fromEp?.box ?? fromFrameRect;
      if (!fromBox) continue;
      const fromCol = fromEp?.col ?? colOf[fromMsg.id] ?? colOf[e.to.messageId] ?? 0;
      const fromAuthor=fromMsg.author;
      const toMsg=msgMap.get(e.to.messageId);

      // Tag and arrange relations are rendered as decorations/frames — no directed arrows.
      // Agree/disagree: pure-stance (anon: source) → decoration only;
      //   with real source → directed arrow pointing to the decorated message (not the badge).
      if (e.relationType==="tag"||e.relationType==="arrange") continue;
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
            fromBox,toBox:toEpN.box,fromCol,toCol:toEpN.col,
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

        // arrange frame: edge should point to the frame border (the relation's clickable area)
        if (targetRelType === "arrange") {
          const frameRect = frameByRelMsgId.get(relId);
          if (frameRect) {
            rawEdges.push({
              drawId:e.id,edge:e,fromAuthor,
              fromBox,toBox:{x:frameRect.x,y:frameRect.y,width:frameRect.width,height:frameRect.height},
              fromCol,toCol:fromCol,
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
              fromBox,toBox:{x:tagInfo.rect.x,y:tagInfo.rect.y,width:tagInfo.rect.width,height:tagInfo.rect.height},
              fromCol,toCol:fromCol,
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
              ? fromCol  // nested relation target — fall back to source col
              : (colOf[decoratedMid] ?? fromCol);
            rawEdges.push({
              drawId:e.id,edge:e,fromAuthor,
              fromBox,toBox:visualBox,fromCol,toCol,
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
              fromBox,
              toBox:{x:visualBox.x,y:visualBox.y,width:visualBox.width,height:visualBox.height},
              fromCol,toCol:fromCol,
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
        if (span) {
          const r = toCanvasRect(span.getBoundingClientRect());
          fragRectCanvas = new DOMRect(r.x, r.y, r.width, r.height);
        }
      }

      rawEdges.push({
        drawId:e.id,edge:e,fromAuthor,fromBox,toBox:toEp.box,fromCol,toCol:toEp.col,
        fragRectCanvas,edgeLabelText:labelText(e,fromAuthor),expandedToEdgeId:null,
        start:{x:0,y:0},ctrl:{x:0,y:0},end:{x:0,y:0},
      });
    }

    for (let idx=0;idx<rawEdges.length;idx++) {
      const pe=rawEdges[idx];
      const { fromBox, toBox, fragRectCanvas, edge } = pe;
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

      // Control point base: offset perpendicular to start→end direction,
      // so the curve arcs outward from both cards rather than hugging their edges.
      const midX = (startP.x + endP.x) / 2;
      const midY = (startP.y + endP.y) / 2;
      const dx = endP.x - startP.x;
      const dy = endP.y - startP.y;
      const dist = Math.hypot(dx, dy) || 1;
      const perpX = -dy / dist;  // perpendicular (rotate 90° CCW)
      const perpY = dx / dist;
      const fanBase = (idx - (rawEdges.length - 1) / 2) * 6;
      const arcOffset = Math.min(60, dist * 0.3);
      const ctrlBase = {
        x: midX + perpX * arcOffset + perpX * fanBase,
        y: midY + perpY * arcOffset + perpY * fanBase,
      };
      // Candidates: vary along perpendicular + along the line direction
      const ctrlCands = [
        ctrlBase,
        ...[ -120, -80, -40, 0, 40, 80, 120 ].map(o => ({ x: ctrlBase.x + perpX * o, y: ctrlBase.y + perpY * o })),
        ...[ -60, -30, 30, 60 ].map(o => ({ x: ctrlBase.x + (dx/dist) * o, y: ctrlBase.y + (dy/dist) * o })),
      ];

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

      const chosenS=snapBound(fromBox,chosenCurve.s), chosenE=snapBound(toRect,chosenCurve.e);
      const clampY=(y:number,box:Rect)=>Math.min(Math.max(y,box.y),box.y+box.height);
      const dirX=toCenter.x-fromCenter.x, dirY=toCenter.y-fromCenter.y;
      const preferHorizontalSide=pe.fromCol!==pe.toCol||Math.abs(dirX)>=Math.abs(dirY)*0.7;
      let finalS=chosenS, finalE=chosenE;
      if (preferHorizontalSide) {
        const targetOnLeft=dirX<0||pe.fromCol>pe.toCol;
        if (targetOnLeft) {
          finalS={x:fromBox.x,y:clampY(chosenS.y,fromBox)};
          finalE={x:toRect.x+toRect.width,y:clampY(chosenE.y,toRect)};
        } else {
          finalS={x:fromBox.x+fromBox.width,y:clampY(chosenS.y,fromBox)};
          finalE={x:toRect.x,y:clampY(chosenE.y,toRect)};
        }
      }
      pe.start=finalS; pe.ctrl=chosenCurve.c; pe.end=finalE;
      labelSeeds.push({drawId:pe.drawId,text:pe.edgeLabelText,p0:pe.start,p1:pe.ctrl,p2:pe.end});
    }

    const placements=computeLabelPlacementsAlongCurve({seeds:labelSeeds,forbiddenRects:globalForbiddenRects});
    setPositionedEdges(rawEdges.map(pe => ({ ...pe, labelX:(placements[pe.drawId]??quadAt(pe.start,pe.ctrl,pe.end,0.5)).x, labelY:(placements[pe.drawId]??quadAt(pe.start,pe.ctrl,pe.end,0.5)).y })));
    setDecorationRectsState(decorationRects);
    setDecorationsByMsgState(decorationsByMsg);
  }, [edges, comparisonSuppressedRelIds, msgMap, layout, colOf, normalIds, edgesByRelMsg, actualCanvasWidth, actualCanvasHeight, normals, labelBboxes, correctedEdgeIdsByRelMsg, relationCardMsgIds]);

  useEffect(() => {
    const canvasEl=canvasRef.current; if (!canvasEl) return;
    const canvasRect=canvasEl.getBoundingClientRect();
    const scaleX = canvasEl.offsetWidth > 0 ? canvasRect.width / canvasEl.offsetWidth : 1;
    const scaleY = canvasEl.offsetHeight > 0 ? canvasRect.height / canvasEl.offsetHeight : 1;
    const next: Record<string,LabelBbox>={};
    for (const pe of positionedEdges) {
      const t=textRefs.current[pe.drawId]; if (!t) continue;
      const r=t.getBoundingClientRect();
      next[pe.drawId]={
        x:(r.left-canvasRect.left)/scaleX,
        y:(r.top-canvasRect.top)/scaleY,
        width:r.width/scaleX,
        height:r.height/scaleY,
      };
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
  }, [positionedEdges, actualCanvasWidth, actualCanvasHeight]);

  function isEdgeLabelFragSel(relId:string,edgeId:string) {
    return draftUnits.some(x=>unitEquals(x,{messageId:relId,selection:{kind:"edge",edgeId}}));
  }
  function isRelWholeSel(relId:string) {
    return draftUnits.some(x=>unitEquals(x,{messageId:relId,selection:{kind:"whole"}}));
  }

  function isDecorationSelected(relId:string, kind:"agree"|"disagree") {
    const decoration = relDecByRelMsgState.get(relId);
    const selectedIds = kind === "agree" ? decoration?.agreeRelMsgIds : decoration?.disagreeRelMsgIds;
    return selectedIds?.some(isRelWholeSel) ?? false;
  }

  function renderContent(message: DemoMessage) {
    const targets = extractTextTargetsForMessage(message.id, edges);
    if (!targets.length) return <pre style={{margin:0,whiteSpace:"pre-wrap",fontFamily:"Menlo,Monaco,Consolas,'Courier New',monospace",fontSize:13}}>{message.content}</pre>;
    const text = message.content;
    const validItems = targets
      .filter(t => t.start >= 0 && t.start + t.len <= text.length && t.len > 0)
      .map(t => ({ start: t.start, end: t.start + t.len, relationType: t.relationType, edgeId: t.edgeId }));
    const tree = buildAnnoTree(validItems);
    const nodes = renderAnnoNodes(
      text,
      tree,
      0,
      text.length,
      0,
      message.id,
      isFragmentSelected,
      onFragmentAnchorClick,
      (id, start, len, relationType) => annotationTargetFragmentHints.has(`${id}::${start}:${len}:${relationType}`)
    );
    return <pre style={{margin:0,whiteSpace:"pre-wrap",fontFamily:"Menlo,Monaco,Consolas,'Courier New',monospace",fontSize:13}}>{nodes}</pre>;
  }



  return (
    <div ref={canvasRef} data-jump-canvas="true" style={{position:"relative",width:actualCanvasWidth,height:actualCanvasHeight,zIndex:0}}
      onDoubleClick={e=>{const t=e.target as HTMLElement;if(!canvasRef.current)return;if(t.closest&&(t.closest("[data-msgid]")||t.closest("svg")||t.closest('[title^="relation="]')||t.closest("[data-rel-overlay]")))return;onCanvasBlankClick?.();}}>
      <div style={{position:"absolute",left:0,top:0,width:actualCanvasWidth,height:actualCanvasHeight,zIndex:1}}>
        {normals.map(msg=>{
          const box=layout[msg.id]; if(!box) return null;
          if (effectiveHideMessageIds.has(msg.id) || traceExpandedFrameIds.has(msg.id)) return null;
          // Hidden targets: corrected targets (replaced by correction source) and
          // summarized targets (covered by summary card). Chained sources remain visible.
          if (hiddenTargetIds.has(msg.id)) return null;

          // CLASSIFY relation messages are shown as topic cards on the main canvas.
          // SUMMARY messages fall through to normal card rendering below.
          if (msg.kind === "relation" && classifyRelMsgIds.has(msg.id)) {
            // Count unique text-message targets from ALL edges (not just visible ones).
            // The graphEdges filter may exclude edges whose targets are hidden (classified),
            // so we count from the raw edges prop directly. Deduplicate by to.messageId
            // because secondary relation types create duplicate edges.
            const targetCount = (() => {
              const seen = new Set<string>();
              for (const e of edges) {
                if (e.relationMessageId !== msg.id) continue;
                if (e.to.messageId.startsWith('anon:')) continue;
                seen.add(e.to.messageId);
              }
              return seen.size;
            })();
            const topicTitle = getRelationTitle(msg.relationPayload) || `分类（${targetCount}）`;
            const relatedJoinRelations = joinRelationsByTarget?.get(msg.id) ?? [];
            const outgoingJoinRelations = joinRelationsBySource?.get(msg.id) ?? [];
            const validJoinCount = relatedJoinRelations.filter(join => joinStatusByMessage?.get(join.id) === 'valid').length;
            const invalidJoinCount = relatedJoinRelations.length - validJoinCount;
            const isWhole = draftUnits.some(u => u.messageId === msg.id && u.selection.kind === "whole");
            const isActive = lastClickedMessageId === msg.id;
            const isTopicStanceTarget = stanceHighlight?.stanceMsgId === msg.id;
            return (
              <div key={msg.id} data-msgid={msg.id} ref={el=>{cardRefs.current[msg.id]=el;}}
                onClick={e=>onMessageClick(e,msg.id)} onDoubleClick={e=>onMessageDoubleClick(e,msg.id)}
                onMouseDown={e=>onMessageMouseDown?.(e,msg.id)} onMouseUp={e=>onMessageMouseUp?.(e,msg.id)}
                style={{position:"absolute",left:box.x,top:box.y,width:box.width,boxSizing:"border-box",background:isTopicStanceTarget?"#2a2410":isWhole?"#4a3510":"#1f1f1f",borderRadius:6,
                  borderTop:isWhole?"2px solid #fbbf24":isTopicStanceTarget?"2px solid #f59e0b":isActive?"1px solid rgba(56,189,248,0.8)":"1px solid #444",
                  borderRight:isWhole?"2px solid #fbbf24":isTopicStanceTarget?"2px solid #f59e0b":isActive?"1px solid rgba(56,189,248,0.8)":"1px solid #444",
                  borderBottom:isWhole?"2px solid #fbbf24":isTopicStanceTarget?"2px solid #f59e0b":isActive?"1px solid rgba(56,189,248,0.8)":"1px solid #444",
                  borderLeft:"3px solid #a78bfa",
                  padding:"12px 16px",boxShadow:isTopicStanceTarget?"0 0 16px rgba(245,158,11,0.35), 0 4px 10px rgba(0,0,0,0.5)":isWhole?"0 8px 20px rgba(11,132,255,0.22)":isActive?"0 6px 16px rgba(56,189,248,0.14)":"0 4px 10px rgba(0,0,0,0.5)",display:"flex",flexDirection:"column",
                  gap:8,cursor:"pointer",outline:isWhole?"none":isActive?"1px dashed #0b84ff":"none",userSelect:"none",color:"#f5f5f5"}}>
                <div ref={el=>{headerRefs.current[msg.id]=el;}} style={{fontSize:11,opacity:0.85,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span style={{display:"flex",alignItems:"center",gap:6}}>
                    {isWhole && <span style={{fontSize:10,fontWeight:800,padding:"2px 6px",borderRadius:4,background:"#fbbf24",color:"#111827"}}>分类</span>}
                    <span style={{fontSize:10,fontWeight:600,padding:"0 5px",borderRadius:3,background:"rgba(167,139,250,0.18)",color:"#a78bfa",lineHeight:"16px"}}>分类</span>
                    <span>{msg.id}</span>
                  </span>
                  <div style={{display:"flex",alignItems:"center",gap:4}}>
                    {(() => {
                      const sc = stakeCounts?.[msg.id];
                      const truthPro = sc?.truth.pro ?? 0;
                      const truthCon = sc?.truth.con ?? 0;
                      const valuePro = sc?.value.pro ?? 0;
                      const valueCon = sc?.value.con ?? 0;
                      return (
                        <>
                          {(truthPro > 0 || truthCon > 0) && (
                            <span style={{fontSize:10}}>
                              <span style={{color:"#a5b4fc"}}>⚖️</span>
                              {truthPro > 0 && <span style={{color:"#4ade80"}}>👍{truthPro}</span>}
                              {truthCon > 0 && <span style={{color:"#f87171"}}>👎{truthCon}</span>}
                            </span>
                          )}
                          {(valuePro > 0 || valueCon > 0) && (
                            <span style={{fontSize:10}}>
                              <span style={{color:"#fcd34d"}}>💎</span>
                              {valuePro > 0 && <span style={{color:"#4ade80"}}>👍{valuePro}</span>}
                              {valueCon > 0 && <span style={{color:"#f87171"}}>👎{valueCon}</span>}
                            </span>
                          )}
                        </>
                      );
                    })()}
                    {onSettlementToggleTruth && (
                      <button
                        onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new Event('guide-settlement-opened')); onSettlementToggleTruth(msg.id); }}
                        data-guide-settlement-entry="true" data-guide-target-message={msg.id}
                        style={{fontSize:13,cursor:"pointer",background:settlementOpenMsgId===msg.id&&settlementOpenType==='TRUTH'?"rgba(99,102,241,0.2)":"none",border:settlementOpenMsgId===msg.id&&settlementOpenType==='TRUTH'?"1px solid #6366f1":"1px solid transparent",borderRadius:4,padding:"0 3px",color:settlementOpenMsgId===msg.id&&settlementOpenType==='TRUTH'?"#a5b4fc":"#6b7280",lineHeight:1}}
                        title="真假仲裁"
                      >⚖️</button>
                    )}
                    {onSettlementToggleValue && (
                      <button
                        onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new Event('guide-settlement-opened')); onSettlementToggleValue(msg.id); }}
                        data-guide-settlement-entry="true" data-guide-target-message={msg.id}
                        style={{fontSize:13,cursor:"pointer",background:settlementOpenMsgId===msg.id&&settlementOpenType==='VALUE'?"rgba(245,158,11,0.2)":"none",border:settlementOpenMsgId===msg.id&&settlementOpenType==='VALUE'?"1px solid #f59e0b":"1px solid transparent",borderRadius:4,padding:"0 3px",color:settlementOpenMsgId===msg.id&&settlementOpenType==='VALUE'?"#fcd34d":"#6b7280",lineHeight:1}}
                        title="价值仲裁"
                      >💎</button>
                    )}
                  </div>
                </div>
                <div ref={el=>{contentRefs.current[msg.id]=el;}} style={{display:"flex",flexDirection:"column",gap:4}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                    <div style={{fontWeight:600,color:"#f3f4f6",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {topicTitle}
                    </div>
                  </div>
                  <div style={{fontSize:12,color:"#9ca3af",display:"flex",gap:12,flexWrap:"wrap"}}>
                    <span>由 <span style={{fontWeight:600,color:"#e5e7eb"}}>{msg.author}</span> 发起</span>
                    <span>💬 {targetCount} 条观点</span>
                    <span>{new Date(msg.createdAt).toLocaleDateString('zh-CN')}</span>
                  </div>
                </div>
                {outgoingJoinRelations.length > 0 && onJoinFilterClick && (
                  <button
                    onClick={event => { event.stopPropagation(); onJoinFilterClick(msg.id, 'outgoing'); }}
                    title="筛选显示该容器发出的全部加入消息"
                    style={{ alignSelf: 'flex-start', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: 'rgba(16,185,129,0.14)', color: '#a7f3d0', border: '1px solid rgba(16,185,129,0.4)', cursor: 'pointer' }}
                  >
                    加入消息：{outgoingJoinRelations.length} 条
                  </button>
                )}
                {relatedJoinRelations.length > 0 && onJoinFilterClick && (
                  <button
                    onClick={event => { event.stopPropagation(); onJoinFilterClick(msg.id, 'incoming'); }}
                    title="筛选显示把此分类加入容器的全部加入消息"
                    style={{ alignSelf: 'flex-start', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: 'rgba(59,130,246,0.14)', color: '#bfdbfe', border: '1px solid rgba(59,130,246,0.4)', cursor: 'pointer' }}
                  >
                    被加入消息：{validJoinCount} 条有效{invalidJoinCount > 0 ? `，${invalidJoinCount} 条无效` : ''}
                  </button>
                )}
              </div>
            );
          }

          const isWhole=draftUnits.some(u=>u.messageId===msg.id&&u.selection.kind==="whole");
          const isCorrectableRelation = msg.kind === 'relation'
            && ['classify', 'summary', 'proposal', 'delegation', 'code_change', 'operations'].includes(msg.relationType ?? '');
          const isText=activeTextSelectId===msg.id&&(msg.kind==="normal" || isCorrectableRelation);
          const corrBadges = correctionsByTargetMsgId.get(msg.id) ?? [];
          const uniqueCorrBadges = Array.from(new Map(corrBadges.map(b => [b.relMsgId, b])).values());
          const correctionBadge = uniqueCorrBadges[uniqueCorrBadges.length - 1];
          const correctionCount = uniqueCorrBadges.length;
          const correctionBadgeJumpIds = uniqueCorrBadges.map(b => b.relMsgId).join(' ');
          const versionState = correctionVersionsByTargetMsgId.get(msg.id);
          const validCorrectionIds = new Set(
            versionState?.versions
              .filter(version => version.valid && !version.conflicted)
              .map(version => version.correctionId) ?? [],
          );
          const validCorrectionCount = uniqueCorrBadges.filter(b => validCorrectionIds.has(b.relMsgId)).length;
          const correctionBadgeOpacity = validCorrectionCount === 0 ? 0.45 : 1;
          const correctionBadgeLabel = `✏更正 ${validCorrectionCount}/${correctionCount}`;

          // Phase 5: Stance path highlighting
          const isStanceTarget = stanceHighlight?.stanceMsgId === msg.id;
          const isStanceEvidence = stanceHighlight?.evidenceMsgIds.includes(msg.id) ?? false;
          const stanceBorder = isStanceTarget
            ? '2px solid #f59e0b'
            : isStanceEvidence
              ? '1px solid rgba(245,158,11,0.6)'
              : undefined;
          const stanceShadow = isStanceTarget
            ? '0 0 16px rgba(245,158,11,0.35), 0 4px 10px rgba(0,0,0,0.5)'
            : isStanceEvidence
              ? '0 0 8px rgba(245,158,11,0.18), 0 4px 10px rgba(0,0,0,0.5)'
              : undefined;
          const stanceBg = isStanceTarget
            ? '#2a2410'
            : isStanceEvidence
              ? '#242015'
              : undefined;

          // Kind-based styling for governance / code / settlement messages
          const kindMeta = (() => {
            if (msg.kind === 'governance') return { color: '#f59e0b', label: '提案', bg: 'rgba(245,158,11,0.08)' };
            if (msg.kind === 'code')        return { color: '#14b8a6', label: '代码', bg: 'rgba(20,184,166,0.08)' };
            if (msg.kind === 'operations')  return { color: '#06b6d4', label: '📊 运营', bg: 'rgba(6,182,212,0.08)' };
            if (msg.kind === 'round') {
              const isValue = (msg as any).roundPayload?.settlementType === 'VALUE';
              return isValue
                ? { color: '#fcd34d', label: '💎 结算中', bg: 'rgba(252,211,77,0.08)' }
                : { color: '#a5b4fc', label: '⚖️ 结算中', bg: 'rgba(165,180,252,0.08)' };
            }
            if (msg.kind === 'round_result') {
              const isValue = (msg as any).roundPayload?.settlementType === 'VALUE';
              return isValue
                ? { color: '#f59e0b', label: '💎 已结算', bg: 'rgba(245,158,11,0.12)' }
                : { color: '#818cf8', label: '⚖️ 已结算', bg: 'rgba(129,140,248,0.12)' };
            }
            if (msg.kind === 'relation' && msg.relationType === 'summary') return { color: '#34d399', label: '总结', bg: 'rgba(52,211,153,0.08)' };
            return null;
          })();
          const kindBorder = kindMeta ? `3px solid ${kindMeta.color}` : undefined;
          const kindBg = kindMeta ? kindMeta.bg : undefined;
          const relatedJoinRelations = joinRelationsByTarget?.get(msg.id) ?? [];
          const outgoingJoinRelations = joinRelationsBySource?.get(msg.id) ?? [];
          const joinStatus = joinStatusByMessage?.get(msg.id);
          const joinIsInvalid = joinStatus === 'rejected' || joinStatus === 'superseded' || joinStatus === 'container-rejected';
          const validJoinCount = relatedJoinRelations.filter(join => joinStatusByMessage?.get(join.id) === 'valid').length;
          const invalidJoinCount = relatedJoinRelations.length - validJoinCount;

          return (
            <div key={msg.id} data-msgid={msg.id} ref={el=>{cardRefs.current[msg.id]=el;}}
              onClick={e=>onMessageClick(e,msg.id)} onDoubleClick={e=>onMessageDoubleClick(e,msg.id)}
              onMouseDown={e=>onMessageMouseDown?.(e,msg.id)} onMouseUp={e=>onMessageMouseUp?.(e,msg.id)}
              style={{position:"absolute",left:box.x,top:box.y,width:box.width,boxSizing:"border-box",background:isWhole?"#5b4100":stanceBg||kindBg||"#1f1f1f",borderRadius:6,borderTop:stanceBorder||(isText?"2px dashed #0b84ff":isWhole?"2px solid #fbbf24":"1px solid #444"),borderRight:stanceBorder||(isText?"2px dashed #0b84ff":isWhole?"2px solid #fbbf24":"1px solid #444"),borderBottom:stanceBorder||(isText?"2px dashed #0b84ff":isWhole?"2px solid #fbbf24":"1px solid #444"),borderLeft:kindBorder||(stanceBorder?undefined:(isText?"2px dashed #0b84ff":isWhole?"2px solid #fbbf24":"1px solid #444")),padding:"12px 16px",boxShadow:stanceShadow||(isText?"0 6px 18px rgba(11,132,255,0.06)":isWhole?"0 0 0 3px #111827, 0 0 0 5px #fbbf24, 0 4px 18px rgba(251,191,36,0.45)":"0 4px 10px rgba(0,0,0,0.5)"),display:"flex",flexDirection:"column",gap:8,cursor:"pointer",outline:isWhole?"none":lastClickedMessageId===msg.id?"1px dashed #0b84ff":"none",userSelect:activeTextSelectId===msg.id?"text":"auto"}}>
              {/* Correction badges: for text messages, shown centered in the same header row as author/msgId */}
              <div ref={el=>{headerRefs.current[msg.id]=el;}} style={{fontSize:11,opacity:0.85,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{flex:1,display:"flex",alignItems:"center",gap:4}}>
                  {/* For non-text (relation) messages, keep badges left-aligned in header */}
                  {msg.kind!=="normal" && correctionBadge && (
                    <div key={`corr-hdr-${correctionBadge.relMsgId}`}
                      data-msgid={correctionBadge.relMsgId} data-jump-msgids={correctionBadgeJumpIds} data-rel-overlay="true"
                      onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,correctionBadge.relMsgId);}}
                      onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,correctionBadge.relMsgId);}}
                      title={`更正关系：${correctionBadge.relMsgId}；共${correctionCount}次更正，单击选中，双击查看历史`}
                      style={{background:isRelWholeSel(correctionBadge.relMsgId)?"#fbbf24":"rgba(170,110,0,0.9)",
                        color:isRelWholeSel(correctionBadge.relMsgId)?"#111827":"#fff",borderRadius:3,fontSize:9,padding:"0 4px",fontWeight:600,
                        cursor:"pointer",pointerEvents:"auto",
                        border:isRelWholeSel(correctionBadge.relMsgId)?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.15)",
                        boxShadow:isRelWholeSel(correctionBadge.relMsgId)?"0 0 0 2px #111827, 0 0 0 3px rgba(251,191,36,0.9)":"none",
                        whiteSpace:"nowrap",userSelect:"none",flexShrink:0,opacity:correctionBadgeOpacity}}>
                      {correctionBadgeLabel}
                    </div>
                  )}
                  {isWhole && <span style={{fontSize:10,fontWeight:800,padding:"2px 6px",borderRadius:4,background:"#fbbf24",color:"#111827"}}>{kindMeta?.label ?? (msg.kind === 'normal' ? '文本' : '关系')}</span>}
                  <span>{msg.author}</span>
                  {kindMeta && (
                    <span style={{fontSize:9,fontWeight:600,padding:"0 5px",borderRadius:3,background:`${kindMeta.color}22`,color:kindMeta.color,lineHeight:"16px",border:`1px solid ${kindMeta.color}44`}}>
                      {kindMeta.label}
                    </span>
                  )}
                </div>
                {/* For text messages, correction badges are centered between author and msgId,
                    with AGREE/DISAGREE mini-badges rendered inline to the right of each correction badge. */}
                {msg.kind==="normal" && correctionBadge && (
                  <div style={{flex:1,display:"flex",justifyContent:"center",gap:4,flexWrap:"wrap"}}>
                    {(() => {
                      const b = correctionBadge;
                      const corrDec=relDecByRelMsgState?.get(b.relMsgId);
                      return (
                        <React.Fragment key={`corr-hdr-${b.relMsgId}`}>
                          <div
                            data-msgid={b.relMsgId} data-jump-msgids={correctionBadgeJumpIds} data-rel-overlay="true"
                            onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,b.relMsgId);}}
                            onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,b.relMsgId);}}
                            title={`更正关系：${b.relMsgId}；共${correctionCount}次更正，单击选中，双击查看历史`}
                            style={{background:isRelWholeSel(b.relMsgId)?"#fbbf24":"rgba(170,110,0,0.9)",
                              color:isRelWholeSel(b.relMsgId)?"#111827":"#fff",borderRadius:3,fontSize:9,padding:"0 4px",fontWeight:600,
                              cursor:"pointer",pointerEvents:"auto",
                              border:isRelWholeSel(b.relMsgId)?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.15)",
                              boxShadow:isRelWholeSel(b.relMsgId)?"0 0 0 2px #111827, 0 0 0 3px rgba(251,191,36,0.9)":"none",
                              whiteSpace:"nowrap",userSelect:"none",flexShrink:0,opacity:correctionBadgeOpacity}}>
                            {correctionBadgeLabel}
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
                    })()}
                  </div>
                )}
                <div style={{flex:1,display:"flex",justifyContent:"flex-end",flexDirection:"column",alignItems:"flex-end"}}>
                  {msg.kind === "join" && onNavigateToMessage ? (
                    <span
                      data-rel-overlay="true"
                      onClick={e => { e.stopPropagation(); onNavigateToMessage(msg.id); }}
                      style={{opacity:0.95,fontFamily:"monospace",fontSize:10,color:"#93c5fd",cursor:"pointer",padding:"1px 4px",borderRadius:3,background:"rgba(59,130,246,0.15)",textDecoration:"underline",textUnderlineOffset:2}}
                      title={`跳转到加入消息 ${msg.id} 的当前实际位置`}
                    >{msg.id}</span>
                  ) : (
                    <span style={{opacity:0.7}}>{msg.id}</span>
                  )}
                  {(() => {
                    const sc = stakeCounts?.[msg.id];
                    const truthPro = sc?.truth.pro ?? 0;
                    const truthCon = sc?.truth.con ?? 0;
                    const valuePro = sc?.value.pro ?? 0;
                    const valueCon = sc?.value.con ?? 0;
                    const showTruth = truthPro > 0 || truthCon > 0;
                    const showValue = valuePro > 0 || valueCon > 0;
                    if (showTruth || showValue || onSettlementToggleTruth) {
                      return (
                        <div style={{ display: "flex", gap: 4, fontSize: 10, marginTop: 2, alignItems: "center" }}>
                          {showTruth && (
                            <span>
                              <span style={{ color: "#a5b4fc" }}>⚖️</span>
                              {truthPro > 0 && <span style={{ color: "#4ade80" }}>👍{truthPro}</span>}
                              {truthCon > 0 && <span style={{ color: "#f87171" }}>👎{truthCon}</span>}
                            </span>
                          )}
                          {showValue && (
                            <span>
                              <span style={{ color: "#fcd34d" }}>💎</span>
                              {valuePro > 0 && <span style={{ color: "#4ade80" }}>👍{valuePro}</span>}
                              {valueCon > 0 && <span style={{ color: "#f87171" }}>👎{valueCon}</span>}
                            </span>
                          )}
                          {onSettlementToggleTruth && (
                            <button
                              data-settlement-toggle-truth
                              onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new Event('guide-settlement-opened')); onSettlementToggleTruth(msg.id); }}
                              data-guide-settlement-entry="true" data-guide-target-message={msg.id}
                              style={{ fontSize: 13, cursor: "pointer", background: settlementOpenMsgId===msg.id&&settlementOpenType==='TRUTH'?"rgba(99,102,241,0.2)":"none", border: settlementOpenMsgId===msg.id&&settlementOpenType==='TRUTH'?"1px solid #6366f1":"1px solid transparent", borderRadius: 4, padding: "0 3px", color: settlementOpenMsgId===msg.id&&settlementOpenType==='TRUTH'?"#a5b4fc":"#6b7280", lineHeight: 1 }}
                              title="真假仲裁"
                            >⚖️</button>
                          )}
                          {onSettlementToggleValue && (
                            <button
                              data-settlement-toggle-value
                              onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new Event('guide-settlement-opened')); onSettlementToggleValue(msg.id); }}
                              data-guide-settlement-entry="true" data-guide-target-message={msg.id}
                              style={{ fontSize: 13, cursor: "pointer", background: settlementOpenMsgId===msg.id&&settlementOpenType==='VALUE'?"rgba(245,158,11,0.2)":"none", border: settlementOpenMsgId===msg.id&&settlementOpenType==='VALUE'?"1px solid #f59e0b":"1px solid transparent", borderRadius: 4, padding: "0 3px", color: settlementOpenMsgId===msg.id&&settlementOpenType==='VALUE'?"#fcd34d":"#6b7280", lineHeight: 1 }}
                              title="价值仲裁"
                            >💎</button>
                          )}
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>
              </div>
              {joinStatus && (
                <div style={{ fontSize: 10, fontWeight: 600, color: joinIsInvalid ? '#fca5a5' : '#86efac', alignSelf: 'flex-start', padding: '1px 6px', borderRadius: 4, background: joinIsInvalid ? 'rgba(239,68,68,0.16)' : 'rgba(34,197,94,0.15)', border: `1px solid ${joinIsInvalid ? 'rgba(239,68,68,0.35)' : 'rgba(34,197,94,0.3)'}` }}>
                  {joinStatus === 'rejected' ? '被反对 · 无效' : joinStatus === 'superseded' ? '已重新分类 · 无效' : joinStatus === 'container-rejected' ? '容器被反对 · 无效' : '有效'}
                </div>
              )}
              {isText&&<div style={{fontSize:11,color:"#0b84ff",marginBottom:4}}>文本选择模式：拖选记录 start+len；或点击高亮片段</div>}
              {/* Settlement: content with inline target tag on first line */}
              {(msg.kind === 'round' || msg.kind === 'round_result') ? (() => {
                const settleTargetId = (msg as any).settlementTargetId as string | undefined;
                const targetMsg = settleTargetId ? msgMap.get(settleTargetId) : undefined;
                const targetContent = targetMsg?.content ?? '';
                const targetPreview = targetContent.length > 40
                  ? targetContent.slice(0, 40) + '…'
                  : targetContent;
                const isValue = (msg as any).roundPayload?.settlementType === 'VALUE';
                const isRound = msg.kind === 'round';
                const tagColor = isValue
                  ? (isRound ? '#fcd34d' : '#f59e0b')
                  : (isRound ? '#a5b4fc' : '#818cf8');
                const lines = (msg.content ?? '').split('\n');
                const firstLine = lines[0];
                const restLines = lines.slice(1).join('\n');
                return (
                  <div ref={el=>{contentRefs.current[msg.id]=el;}} style={{fontSize:13,color:"#f5f5f5"}} onMouseUp={e=>onTextMouseUp(e,msg.id)}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 4, flexWrap: "wrap" }}>
                      <span style={{ whiteSpace: "pre-wrap", fontFamily: "Menlo,Monaco,Consolas,'Courier New',monospace", fontSize: 13 }}>{firstLine}</span>
                      {settleTargetId && (
                        onNavigateToMessage ? (
                          <span
                            onClick={(e) => { e.stopPropagation(); onNavigateToMessage(settleTargetId); }}
                            style={{
                              fontSize: 10, fontWeight: 500, padding: "1px 6px", borderRadius: 4,
                              background: `${tagColor}15`, color: tagColor, border: `1px solid ${tagColor}40`,
                              cursor: "pointer", maxWidth: 240, overflow: "hidden",
                              textOverflow: "ellipsis", whiteSpace: "nowrap",
                            }}
                            title={`点击跳转到目标消息 ${settleTargetId.slice(-6)}${targetContent ? '：' + targetContent : ''}`}
                          >
                            → {settleTargetId.slice(-6)}{targetPreview ? `「${targetPreview}」` : ''}
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, color: "#6b7280", padding: "1px 4px", borderRadius: 3, background: "rgba(107,114,128,0.1)" }}>
                            {settleTargetId.slice(-6)}
                          </span>
                        )
                      )}
                    </div>
                    {restLines && (
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "Menlo,Monaco,Consolas,'Courier New',monospace", fontSize: 13 }}>{restLines}</pre>
                    )}
                  </div>
                );
              })() : (
              <div ref={el=>{contentRefs.current[msg.id]=el;}} style={{fontSize:13,color:"#f5f5f5"}} onMouseUp={e=>onTextMouseUp(e,msg.id)}>
                {renderContent(msg)}
              </div>
              )}
              {outgoingJoinRelations.length > 0 && onJoinFilterClick && (
                <button
                  onClick={event => { event.stopPropagation(); onJoinFilterClick(msg.id, 'outgoing'); }}
                  title="筛选显示该容器发出的全部加入消息"
                  style={{ alignSelf: 'flex-start', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: 'rgba(16,185,129,0.14)', color: '#a7f3d0', border: '1px solid rgba(16,185,129,0.4)', cursor: 'pointer' }}
                >
                  加入消息：{outgoingJoinRelations.length} 条
                </button>
              )}
              {relatedJoinRelations.length > 0 && onJoinFilterClick && (
                <button
                  onClick={event => { event.stopPropagation(); onJoinFilterClick(msg.id, 'incoming'); }}
                  title="筛选显示把此消息加入容器的全部加入消息"
                  style={{ alignSelf: 'flex-start', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: 'rgba(59,130,246,0.14)', color: '#bfdbfe', border: '1px solid rgba(59,130,246,0.4)', cursor: 'pointer' }}
                >
                  被加入消息：{validJoinCount} 条有效{invalidJoinCount > 0 ? `，${invalidJoinCount} 条无效` : ''}
                </button>
              )}
              {(notifyUsersByRelationMsg.get(msg.id)?.length ?? 0) > 0 && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#67e8f9' }}>
                  通知与会者：
                  {notifyUsersByRelationMsg.get(msg.id)!.map((notifyUser, index) => (
                    <React.Fragment key={notifyUser.id}>
                      {index > 0 && '、'}
                      <span
                        style={{ color: '#a5f3fc' }}
                        title={`通知与会者 ${notifyUser.username}`}
                      >
                        {notifyUser.username}
                      </span>
                    </React.Fragment>
                  ))}
                </div>
              )}
              {/* 加入容器消息：显示容器和目标消息 ID 标签（可点击跳转） */}
              {msg.joinInfo && (() => {
                const { containerId, containerType, targetIds } = msg.joinInfo;
                const containerTypeLabel = containerType === 'CLASSIFY' ? '分类' : containerType === 'SUMMARY' ? '总结' : containerType === 'ARRANGE' ? '排列' : containerType === 'MERGE' ? '归并' : '容器';
                return (
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 10, color: "#9ca3af", flexShrink: 0 }}>容器:</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: "#a78bfa", padding: "1px 4px", borderRadius: 3, background: "rgba(167,139,250,0.15)", flexShrink: 0 }}>{containerTypeLabel}</span>
                      {onNavigateToMessage ? (
                        <span
                            onClick={(e) => { e.stopPropagation(); onNavigateToMessage(containerId); }}
                          style={{ fontSize: 10, fontFamily: "monospace", color: "#93c5fd", cursor: "pointer", padding: "1px 4px", borderRadius: 3, background: "rgba(59,130,246,0.15)", textDecoration: "underline", textUnderlineOffset: 2 }}
                          title={`跳转到 ${containerTypeLabel}消息 ${containerId}`}
                        >{containerId}</span>
                      ) : (
                        <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6b7280", padding: "1px 4px", borderRadius: 3, background: "rgba(107,114,128,0.1)" }}>{containerId}</span>
                      )}
                    </div>
                    {targetIds.length > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 10, color: "#9ca3af", flexShrink: 0 }}>目标:</span>
                        {targetIds.map(tid => (
                          onNavigateToMessage ? (
                            <span
                              key={tid}
                              onClick={(e) => { e.stopPropagation(); onNavigateToMessage(tid); }}
                              style={{ fontSize: 10, fontFamily: "monospace", color: "#93c5fd", cursor: "pointer", padding: "1px 4px", borderRadius: 3, background: "rgba(59,130,246,0.15)", textDecoration: "underline", textUnderlineOffset: 2 }}
                              title={`跳转到消息 ${tid}`}
                            >{tid}</span>
                          ) : (
                            <span key={tid} style={{ fontSize: 10, fontFamily: "monospace", color: "#6b7280", padding: "1px 4px", borderRadius: 3, background: "rgba(107,114,128,0.1)" }}>{tid}</span>
                          )
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
              {/* 跨分类引用标签（按二级标签分组） */}
              {isContentKind(msg.kind) && crossClassifyRefs && (() => {
                const ref = crossClassifyRefs.get(msg.id);
                if (!ref) return null;
                const tags: { label: string; relMsgIds: string[]; direction: "out" | "in" }[] = [];
                for (const [lbl, ids] of Object.entries(ref.outgoing)) {
                  if (ids.length > 0) tags.push({ label: lbl, relMsgIds: ids, direction: "out" });
                }
                for (const [lbl, ids] of Object.entries(ref.incoming)) {
                  if (ids.length > 0) tags.push({ label: lbl, relMsgIds: ids, direction: "in" });
                }
                if (tags.length === 0) return null;
                return (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                    {tags.map(({ label, relMsgIds, direction }) => {
                      const anySelected = relMsgIds.some(id =>
                        draftUnits.some(u => u.messageId === id && u.selection.kind === "whole")
                      );
                      return (
                      <span key={`${direction}-${label}`}
                        onClick={ev => { ev.stopPropagation(); onCrossRefTagClick?.(ev, relMsgIds); }}
                        title={`${direction === "out" ? "引用" : "被引用"}：${label}（${relMsgIds.length}条）\n单击${anySelected ? "取消" : ""}选中关系消息`}
                        style={{
                          background: anySelected
                            ? "rgba(99,102,241,0.35)"
                            : direction === "out" ? "rgba(99,102,241,0.15)" : "rgba(99,102,241,0.08)",
                          color: anySelected ? "#e0e7ff" : direction === "out" ? "#a5b4fc" : "#c7d2fe",
                          borderRadius: 4,
                          fontSize: 10, padding: "1px 6px", cursor: "pointer", userSelect: "none",
                          border: anySelected
                            ? "1px solid rgba(99,102,241,0.7)"
                            : direction === "out" ? "1px solid rgba(99,102,241,0.3)" : "1px solid rgba(99,102,241,0.15)",
                          fontWeight: 600,
                          boxShadow: anySelected ? "0 0 6px rgba(99,102,241,0.4)" : undefined,
                        }}
                      >{direction === "out" ? "📤→" : "📥←"} {label} {relMsgIds.length}</span>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
      {Object.entries(selectedActualRects).map(([messageId, rect]) => (
        <div
          key={`actual-rect-${messageId}`}
          data-actual-message-rect={messageId}
          title={`实际矩形：${messageId}（${Math.round(rect.width)} × ${Math.round(rect.height)}）`}
          style={{
            position: 'absolute',
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
            boxSizing: 'border-box',
            border: '2px solid #ff3b30',
            background: 'rgba(255,59,48,0.08)',
            pointerEvents: 'none',
            zIndex: 30,
          }}
        />
      ))}
      {/* Phase 3: Floating settlement panel in graph view */}
      {settlementOpenMsgId && (() => {
        const cardBox = layout[settlementOpenMsgId];
        const gf = groupFrames.find(f => f.relMsgId === settlementOpenMsgId);
        const sf = arrangeFrames.find(f => f.relMsgId === settlementOpenMsgId);
        const box = cardBox || (gf ? { x: gf.rect.x, y: gf.rect.y, width: gf.rect.width, height: gf.rect.height } : null) || (sf ? { x: sf.rect.x, y: sf.rect.y, width: sf.rect.width, height: sf.rect.height } : null);
        if (!box) return null;
        return (
        <div data-settlement-panel style={{
          position: "absolute",
          left: box.x,
          top: box.y + box.height + 8,
          width: 360,
          zIndex: 100,
        }}>
          <SettlementPanel messageId={settlementOpenMsgId} topicId={topicId ?? ''} highlightRoundId={sessionStorage.getItem('settlementHighlightRound')} entryHighlight={settlementEntryHighlight} onMessageCreated={onSettlementMessageCreated} filterSettlementType={settlementOpenType ?? undefined} />
          <RoundHistory messageId={settlementOpenMsgId} compact />
        </div>
        );
      })()}
      {/* SVG layer: frame visuals (behind cards, zIndex:0) so cards float above frames.
          Wide arrange frames (spanning multiple columns) no longer visually encompass
          unrelated cards that happen to share the same horizontal range. */}
      {(arrangeFrames.length>0||groupFrames.length>0)&&(
        <svg width={actualCanvasWidth} height={actualCanvasHeight} style={{position:"absolute",left:0,top:0,zIndex:0,pointerEvents:"none"}}>
          {/* arrange frames — stroke and fill reflect selection state; hidden when blank-corrected */}
          {visibleArrangeFrames.map(sf=>{
            if (sf.isBlankCorrected) return null;
            const isWhole=isRelWholeSel(sf.relMsgId);
            return (
              <rect key={`supp-frame-${sf.relMsgId}`} x={sf.rect.x} y={sf.rect.y} width={sf.rect.width} height={sf.rect.height}
                rx={FRAME_RADIUS} ry={FRAME_RADIUS}
                fill={isWhole?"rgba(251,191,36,0.22)":"rgba(130,80,200,0.04)"}
                stroke={isWhole?"rgba(251,191,36,1)":"rgba(130,80,200,0.55)"}
                strokeWidth={isWhole?3:2} strokeDasharray={isWhole?undefined:"5 3"}/>
            );
          })}
          {/* GROUP frames (CLASSIFY/MERGE) and REPLACE-OVERLAY (SUMMARY); hidden when blank-corrected */}
          {visibleGroupFrames.map(gf=>{
            if (gf.isBlankCorrected) return null;
            const isWhole=isRelWholeSel(gf.relMsgId);
            const isReplaceOverlay = gf.relKind === 'replace-overlay';
            const strokeColor = isWhole
              ? 'rgba(251,191,36,1)'
              : (isReplaceOverlay ? (GROUP_FRAME_STROKE[gf.relColor] ?? 'rgba(180,120,0,0.7)') : (GROUP_FRAME_STROKE[gf.relColor] ?? 'rgba(140,140,150,0.55)'));
            const fillColor = isWhole ? 'rgba(251,191,36,0.22)' : isReplaceOverlay ? 'rgba(200,150,0,0.04)' : 'rgba(130,130,140,0.03)';
            return (
              <rect key={`gf-${gf.relMsgId}`} x={gf.rect.x} y={gf.rect.y} width={gf.rect.width} height={gf.rect.height}
                rx={FRAME_RADIUS} ry={FRAME_RADIUS}
                fill={fillColor} stroke={strokeColor}
                strokeWidth={isWhole?3:2} strokeDasharray={isReplaceOverlay?undefined:(isWhole?undefined:"6 3")}/>
            );
          })}
        </svg>
      )}
      {/* SVG layer: edge paths and labels (raised above relation overlays to avoid label clipping/occlusion) */}
      {positionedEdges.length>0&&(
        <svg width={actualCanvasWidth} height={actualCanvasHeight} style={{position:"absolute",left:0,top:0,zIndex:12,pointerEvents:"none"}}>
          {positionedEdges.map(pe=>{
            const {edge,start,ctrl,end,edgeLabelText,labelX,labelY}=pe;
            const path=`M ${start.x} ${start.y} Q ${ctrl.x} ${ctrl.y} ${end.x} ${end.y}`;
            const angle=Math.atan2(end.y-ctrl.y,end.x-ctrl.x),al=7,aa=Math.PI/7;
            const ax1=end.x-al*Math.cos(angle-aa),ay1=end.y-al*Math.sin(angle-aa),ax2=end.x-al*Math.cos(angle+aa),ay2=end.y-al*Math.sin(angle+aa);
            // Phase 5: Stance highlight edge coloring
            const isStanceEdge = stanceHighlight && (
              (edge.relationType === 'agree' || edge.relationType === 'disagree') &&
              edge.to.messageId === stanceHighlight.stanceMsgId &&
              stanceHighlight.evidenceMsgIds.includes(edge.from.messageId)
            );
            const isEvidenceEdge = stanceHighlight && (
              edge.relationType === 'reference' &&
              (edge.relationLabel === '证据' || edge.relationLabel === 'evidence') &&
              stanceHighlight.evidenceMsgIds.includes(edge.from.messageId) &&
              stanceHighlight.evidenceMsgIds.includes(edge.to.messageId)
            );
            const color = isEvidenceEdge
              ? 'rgba(245,158,11,0.95)'  // gold for evidence edges
              : isStanceEdge
                ? (edge.relationType === 'agree' ? 'rgba(34,197,94,0.95)' : 'rgba(239,68,68,0.95)')  // brighter green/red for stance edges
                : edge.relationType === 'annotation' ? 'rgba(255,215,0,0.92)'
                : edge.relationType === 'reference' ? 'rgba(80,180,255,0.92)'
                : edge.relationType === 'reply' ? 'rgba(160,255,140,0.72)'
                : edge.relationType === 'agree' ? 'rgba(2,170,90,0.92)'
                : edge.relationType === 'disagree' ? 'rgba(210,50,50,0.92)'
                : 'rgba(120,120,120,0.72)';
            const edgeStrokeWidth = (isStanceEdge || isEvidenceEdge) ? 2.0 : edge.relationType === 'reply' ? 1.0 : 1.2;
            const relId=edge.relationMessageId,isWhole=isRelWholeSel(relId),isFrag=isEdgeLabelFragSel(relId,edge.id);
            const labelOpacity=isWhole||isFrag?1:edge.relationType==="reply"?0.65:0.9;
            const labelStroke="rgba(0,0,0,0.85)";
            // Blank-corrected: anon-source CORRECT targets a relation message → hide arrow/text, keep bbox for badge
            const isBlankCorrected=anonCorrectedRelMsgIds.has(relId);
            return (
              <g key={pe.drawId}>
                {!isBlankCorrected&&<path d={path} stroke={color} strokeWidth={edgeStrokeWidth} fill="none" strokeDasharray={isEvidenceEdge?"6 3":undefined}/>}
                {!isBlankCorrected&&<path d={`M ${ax1} ${ay1} L ${end.x} ${end.y} L ${ax2} ${ay2}`} fill={color}/>}
                {/* Text always rendered (opacity 0 when blank) so labelBboxes are stable for badge positioning */}
                {/* Text with stroke for readability against any background */}
                <text ref={el=>{textRefs.current[pe.drawId]=el;}} x={labelX} y={labelY} fill={color} opacity={isBlankCorrected?0:labelOpacity} fontSize={10} textAnchor="middle" dominantBaseline="central" style={{paintOrder:"stroke",stroke:labelStroke,strokeWidth:2} as any}>
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
            <div key={`hit-${pe.drawId}`} data-msgid={relId} data-jump-msgids={relId} data-rel-overlay="true" onClick={e=>onEdgeLabelSingleClick(e,relId,pe.edge.id)} onDoubleClick={e=>onEdgeLabelDoubleClick(e,relId)}
              style={{position:"absolute",left:box.x,top:box.y,width:box.width,height:box.height,zIndex:13,cursor:"pointer",pointerEvents:"auto",background:isWhole||isFrag?"rgba(91,65,0,0.35)":"transparent",borderRadius:6,border:isWhole||isFrag?"1px solid rgba(251,191,36,0.95)":"1px solid transparent",boxShadow:isWhole||isFrag?"0 0 0 2px #111827, 0 0 0 3px rgba(251,191,36,0.9)":"none"}}
              title={`relation=${pe.edge.relationMessageId} edge=${pe.edge.id}`}>
              {showCorrBadge&&(()=>{
                // Prefer newCorrInfo (this relation IS the replacement) over corrInfo (this relation was corrected)
                const corrRelMsgId = newCorrInfo?.length
                  ? newCorrInfo[0].corrRelMsgId
                  : corrInfo?.length ? corrInfo[0].corrRelMsgId : null;
                if (!corrRelMsgId) return null;
                const isCorrSel=isRelWholeSel(corrRelMsgId);
                return (
                  <div key={`corr-edge-${corrRelMsgId}`} data-msgid={corrRelMsgId} data-jump-msgids={corrRelMsgId} data-rel-overlay="true"
                    onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,corrRelMsgId);}}
                    onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,corrRelMsgId);}}
                    title={`更正关系：${corrRelMsgId}；单击选中，双击查看历史`}
                    style={{position:"absolute",left:2,top:"50%",transform:"translateY(-50%)",
                      width:CORR_BADGE_W_EDGE-4,background:isCorrSel?"#fbbf24":"rgba(170,110,0,0.9)",
                      color:isCorrSel?"#111827":"#fff",borderRadius:3,fontSize:9,padding:"0 3px",fontWeight:600,
                      cursor:"pointer",pointerEvents:"auto",
                      border:isCorrSel?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.15)",
                      boxShadow:isCorrSel?"0 0 0 2px #111827, 0 0 0 3px rgba(251,191,36,0.9)":"none",
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
          // Default: right side of label, stacked vertically
          let decLeft=bb.x+bb.width+DEC_RIGHT_GAP;
          let decTop=bb.y+Math.floor((bb.height-DEC_H)/2);
          let useBelow = false;
          // Check if right-side decorations would overlap any card; if so, shift below the label
          const hasAgree=dec&&dec.agreeCount>0, hasDisagree=dec&&dec.disagreeCount>0;
          const decCount=(hasAgree?1:0)+(hasDisagree?1:0);
          if (decCount>0) {
            const rightDecRect = { x: decLeft, y: decTop, width: DEC_W, height: decCount * DEC_H + (decCount-1) * DEC_GAP };
            useBelow = normals.some(m => {
              const cardBox = layout[m.id];
              if (!cardBox) return false;
              return rightDecRect.x < cardBox.x + cardBox.width &&
                     rightDecRect.x + rightDecRect.width > cardBox.x &&
                     rightDecRect.y < cardBox.y + cardBox.height &&
                     rightDecRect.y + rightDecRect.height > cardBox.y;
            });
            if (useBelow) {
              const totalW = (hasAgree?DEC_W:0) + (hasDisagree?DEC_W:0) + (hasAgree&&hasDisagree?4:0);
              decLeft = bb.x + Math.floor((bb.width - totalW) / 2);
              decTop = bb.y + bb.height + 2;
            }
          }
          for (const kind of ["agree","disagree"] as const) {
            const count=kind==="agree"?dec?.agreeCount??0:dec?.disagreeCount??0;
            if (count<=0) continue;
            const isSelected=isDecorationSelected(relId,kind);
            const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
            const icon=kind==="agree"?"👍":"👎";
            const label=kind==="agree"?"赞":"反";
            items.push(
              <div key={`reldec-${kind}-${relId}`} data-msgid={relId} data-jump-msgids={relId} data-rel-overlay="true"
                onClick={ev=>{ev.stopPropagation();}}
                onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,relId,kind);}}
                title={`${kind==="agree"?"赞同":"反对"}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
                style={{position:"absolute",left:decLeft,top:decTop,width:DEC_W,height:DEC_H,zIndex:14,
                  background:isSelected?"#fbbf24":bgColor,color:isSelected?"#111827":"#fff",borderRadius:4,display:"flex",alignItems:"center",
                  fontSize:11,pointerEvents:"auto",boxShadow:isSelected?"0 0 0 2px #111827, 0 0 0 3px rgba(251,191,36,0.9), 0 2px 6px rgba(0,0,0,0.5)":"0 2px 6px rgba(0,0,0,0.5)",border:isSelected?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.08)",
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
            if (useBelow) { decLeft += DEC_W + 4; }
            else { decTop += DEC_H + DEC_GAP; }
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
            items.push(
              <div key={`reltag-${relMsgIds[0]}`} data-msgid={relId} data-jump-msgids={[relId, ...relMsgIds].join(' ')} data-rel-overlay="true"
                onClick={ev=>{ev.stopPropagation();onTagBodyClick?.(ev,relId,tagLabel,relMsgIds);}}
                onDoubleClick={ev=>{ev.stopPropagation();onTagDoubleClick?.(ev,relId,tagLabel,relMsgIds);}}
                title={`标注：${displayLabel}；单击选中，双击展开详情`}
                style={{position:"absolute",left:decLeft-TAG_HIT_PAD,top:decTop-TAG_HIT_PAD,
                  width:tagW+2*TAG_HIT_PAD,height:TAG_H+2*TAG_HIT_PAD,
                  zIndex:14,cursor:"pointer",pointerEvents:"auto",background:"transparent",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  padding:TAG_HIT_PAD,boxSizing:"border-box"}}>
                <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",
                  width:tagW,height:TAG_H,boxSizing:"border-box",
                  background:"rgba(180,150,0,0.85)",color:"#fff",borderRadius:3,
                  fontSize:10,padding:"0 4px",boxShadow:"0 1px 4px rgba(0,0,0,0.4)",
                  border:"1px solid rgba(255,255,255,0.15)",
                  whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  🏷{displayLabel}
                </span>
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
              const isSelected=isDecorationSelected(ci.corrRelMsgId,kind);
              const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
              const icon=kind==="agree"?"👍":"👎";
              const label=kind==="agree"?"赞":"反";
              items.push(
                <div key={`corr-reldec-${kind}-${ci.corrRelMsgId}`} data-msgid={ci.corrRelMsgId} data-jump-msgids={ci.corrRelMsgId} data-rel-overlay="true"
                  onClick={ev=>{ev.stopPropagation();}}
                  onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,ci.corrRelMsgId,kind);}}
                  title={`${kind==="agree"?"赞同":"反对"}更正：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
                  style={{position:"absolute",left:decLeft,top:decTop,width:DEC_W,height:DEC_H,zIndex:14,
                    background:isSelected?"#fbbf24":bgColor,color:isSelected?"#111827":"#fff",borderRadius:4,display:"flex",alignItems:"center",
                    fontSize:11,pointerEvents:"auto",boxShadow:isSelected?"0 0 0 2px #111827, 0 0 0 3px rgba(251,191,36,0.9), 0 2px 6px rgba(251,191,36,0.35)":"0 2px 6px rgba(0,0,0,0.5)",border:isSelected?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.08)",
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

      {/* arrange frame border-strip hit areas — 4 thin divs at zIndex:4 covering the frame border,
          one strip per side.  Each strip is FRAME_PAD wide (half inside, half outside the rect),
          so it exactly covers the padding zone between the visible SVG border and the message cards.
          arrange relation messages are treated as first-class messages: single-click toggles whole
          selection (like a normal message card), double-click uses the message double-click handler.
          When isBlankCorrected, the frame border is invisible so border strips are omitted; only the
          correction badge is rendered so users can interact with the correction. */}
      {visibleArrangeFrames.map(sf=>{
        const handleClick=(e: React.MouseEvent)=>{e.stopPropagation();onMessageClick(e,sf.relMsgId);};
        const handleDblClick=(e: React.MouseEvent)=>{e.stopPropagation();onMessageDoubleClick(e,sf.relMsgId);};
        const {x,y,width,height}=sf.rect;
        const HH=FRAME_PAD;
        // Nested frames need higher zIndex so clicks hit inner frame before outer
        const frameZ = 4 + (frameDepthMap.get(sf.relMsgId) ?? 0);
        const stripBase: React.CSSProperties={position:"absolute",zIndex:frameZ,cursor:"pointer",pointerEvents:"auto",background:"transparent"};
        const title=`排列关系：${sf.relMsgId}；单击选中，双击展开详情`;
        const sfCorrInfo=correctedRelMsgTargets.get(sf.relMsgId);
        return (
          <React.Fragment key={`supp-hit-${sf.relMsgId}`}>
            {/* Border strips — omitted when blank-corrected (no visible frame border) */}
            {!sf.isBlankCorrected&&<>
              {/* Top strip — full width including corners */}
              <div data-msgid={sf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y-HH,width:width+HH*2,height:HH*2}}/>
              {/* Bottom strip — full width including corners */}
              <div data-msgid={sf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y+height-HH,width:width+HH*2,height:HH*2}}/>
              {/* Left strip — between top and bottom strips */}
              <div data-msgid={sf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y+HH,width:HH*2,height:height-HH*2}}/>
              {/* Right strip — between top and bottom strips */}
              <div data-msgid={sf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x+width-HH,top:y+HH,width:HH*2,height:height-HH*2}}/>
            </>}
            {/* Correction badge — embedded in frame top border when this arrange is a CORRECT target */}
            {sfCorrInfo&&(()=>{
              const ci=sfCorrInfo[0];
              const isCorrSel=isRelWholeSel(ci.corrRelMsgId);
              return (
                <div key={`corr-supp-${ci.corrRelMsgId}`} data-rel-overlay="true"
                  onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,ci.corrRelMsgId);}}
                  onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,ci.corrRelMsgId);}}
                  title={`更正关系：${ci.corrRelMsgId}；单击选中，双击查看历史`}
                  style={{position:"absolute",left:x+4,top:y-HH+1,zIndex:5,
                    background:isCorrSel?"#fbbf24":"rgba(170,110,0,0.9)",
                    color:isCorrSel?"#111827":"#fff",borderRadius:3,fontSize:9,padding:"0 4px",fontWeight:600,
                    cursor:"pointer",pointerEvents:"auto",
                    border:isCorrSel?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.15)",
                    boxShadow:isCorrSel?"0 0 0 2px #111827, 0 0 0 3px rgba(251,191,36,0.9)":"none",
                    whiteSpace:"nowrap",userSelect:"none",
                    height:HH*2-2,display:"flex",alignItems:"center"}}>
                  ✏更正
                </div>
              );
            })()}
          </React.Fragment>
        );
      })}

      {/* GROUP frame hit strips (CLASSIFY/MERGE/CORRECT/SUMMARY) */}
      {visibleGroupFrames.map(gf=>{
        const handleClick=(e: React.MouseEvent)=>{e.stopPropagation();(onGroupFrameClick??onMessageClick)(e,gf.relMsgId);};
        const handleDblClick=(e: React.MouseEvent)=>{e.stopPropagation();(onGroupFrameDoubleClick??onMessageDoubleClick)(e,gf.relMsgId);};
        const {x,y,width,height}=gf.rect;
        const HH=FRAME_PAD;
        const groupHeaderRect = getGroupHeaderRect(gf.rect, getGroupHeaderHeight(measuredHeights, gf.relMsgId));
        const gfZ = 4 + (frameDepthMap.get(gf.relMsgId) ?? 0);
        const isSummaryHeader = gf.relType === "summary";
        const headerKindColor = isSummaryHeader ? "#34d399" : "#a78bfa";
        const stripBase: React.CSSProperties={position:"absolute",zIndex:gfZ,cursor:"pointer",pointerEvents:"auto",background:"transparent"};
        const title=(gf.relType === "classify" || gf.relType === "summary")
          ? `${gf.relType === "summary" ? "总结" : "分类"}：${gf.relMsgId}；单击选中，双击进入${gf.relType === "summary" ? "总结" : "分类"}`
          : `${gf.relLabel}关系：${gf.relMsgId}；单击选中，双击展开详情`;
        const gfCorrInfo=correctedRelMsgTargets.get(gf.relMsgId);
        return (
          <React.Fragment key={`gf-hit-${gf.relMsgId}`}>
            {/* Border strips — omitted when blank-corrected (no visible frame border) */}
            {!gf.isBlankCorrected&&<>
              <div data-msgid={gf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y-HH,width:width+HH*2,height:HH*2}}/>
              <div data-msgid={gf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y+height-HH,width:width+HH*2,height:HH*2}}/>
              <div data-msgid={gf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
                style={{...stripBase,left:x-HH,top:y+HH,width:HH*2,height:height-HH*2}}/>
              <div data-msgid={gf.relMsgId} data-rel-overlay="true" onClick={handleClick} onDoubleClick={handleDblClick} title={title}
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
                    background:isCorrSel?"#fbbf24":"rgba(170,110,0,0.9)",
                    color:isCorrSel?"#111827":"#fff",borderRadius:3,fontSize:9,padding:"0 4px",fontWeight:600,
                    cursor:"pointer",pointerEvents:"auto",
                    border:isCorrSel?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.15)",
                    boxShadow:isCorrSel?"0 0 0 2px #111827, 0 0 0 3px rgba(251,191,36,0.9)":"none",
                    whiteSpace:"nowrap",userSelect:"none",
                    height:HH*2-2,display:"flex",alignItems:"center"}}>
                  ✏更正
                </div>
              );
            })()}
            {(gf.relType === "classify" || gf.relType === "summary" || gf.relType === "merge") && (
              <div data-msgid={gf.relMsgId} data-rel-overlay="true"
                ref={el => { cardRefs.current[gf.relMsgId] = el; }}
                onClick={handleClick}
                onDoubleClick={handleDblClick}
                title={title}
                style={{
                  ...(gf.relType === "merge"
                    ? (() => {
                        const mergeCardHeaderRect = getMergeCardHeaderRect(gf.rect);
                        return {
                          left: mergeCardHeaderRect.x,
                          top: mergeCardHeaderRect.y,
                          width: mergeCardHeaderRect.width,
                          minHeight: mergeCardHeaderRect.height,
                          color: "#f5f5f5",
                          borderRadius: 6,
                          background: isRelWholeSel(gf.relMsgId) ? "rgba(91,65,0,0.55)" : "#1f1f1f",
                          border: isRelWholeSel(gf.relMsgId) ? "2px solid #fbbf24" : (lastClickedMessageId===gf.relMsgId ? "1px solid rgba(56,189,248,0.8)" : "1px solid #444"),
                          boxShadow: isRelWholeSel(gf.relMsgId) ? "0 0 0 2px #111827, 0 0 0 4px rgba(251,191,36,0.9), 0 8px 20px rgba(251,191,36,0.28)" : (lastClickedMessageId===gf.relMsgId ? "0 6px 16px rgba(56,189,248,0.14)" : "0 6px 14px rgba(0,0,0,0.35)"),
                          outline: lastClickedMessageId===gf.relMsgId ? "1px dashed #0b84ff" : "none",
                          padding: "4px 10px",
                        } as React.CSSProperties;
                      })()
                    : {
                        left: groupHeaderRect.x,
                        top: groupHeaderRect.y,
                        width: groupHeaderRect.width,
                        minHeight: groupHeaderRect.height,
                        background: isRelWholeSel(gf.relMsgId) ? "#5b4100" : isSummaryHeader ? "rgba(52,211,153,0.08)" : "#1f1f1f",
                        color: "#f5f5f5",
                        borderRadius: 6,
                        borderTop: isRelWholeSel(gf.relMsgId) ? "2px solid #fbbf24" : lastClickedMessageId===gf.relMsgId ? "1px solid rgba(56,189,248,0.8)" : "1px solid #444",
                        borderRight: isRelWholeSel(gf.relMsgId) ? "2px solid #fbbf24" : lastClickedMessageId===gf.relMsgId ? "1px solid rgba(56,189,248,0.8)" : "1px solid #444",
                        borderBottom: isRelWholeSel(gf.relMsgId) ? "2px solid #fbbf24" : lastClickedMessageId===gf.relMsgId ? "1px solid rgba(56,189,248,0.8)" : "1px solid #444",
                        borderLeft: isRelWholeSel(gf.relMsgId) ? "2px solid #fbbf24" : lastClickedMessageId===gf.relMsgId ? "1px solid rgba(56,189,248,0.8)" : `3px solid ${headerKindColor}`,
                        boxShadow: isRelWholeSel(gf.relMsgId) ? "0 0 0 2px #111827, 0 0 0 4px rgba(251,191,36,0.9), 0 8px 20px rgba(251,191,36,0.28)" : (lastClickedMessageId===gf.relMsgId ? "0 6px 16px rgba(56,189,248,0.14)" : "0 4px 10px rgba(0,0,0,0.5)"),
                        outline: lastClickedMessageId===gf.relMsgId ? "1px dashed #0b84ff" : "none",
                        padding: "12px 16px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }),
                  position: "absolute",
                  zIndex: 5,
                  cursor: "pointer",
                  pointerEvents: "auto",
                  userSelect: "none",
                  boxSizing: "border-box",
                }}>
                {(() => {
                  const relMsg = msgMap.get(gf.relMsgId);
                  const isMergeTopic = gf.relType === "merge";
                  const isSummaryTopic = gf.relType === "summary";
                  const summaryContent = isSummaryTopic ? relMsg?.content : undefined;
                  const targetIds = Array.from(new Set(
                    (edgesByRelMsg.get(gf.relMsgId) ?? [])
                      .filter(ed => !ed.to.messageId.startsWith('anon:'))
                      .map(ed => ed.to.messageId)
                  ));
                  const topicTitle = getRelationTitle(relMsg?.relationPayload) || (
                    isSummaryTopic
                      ? `总结（${targetIds.length}）`
                      : isMergeTopic
                        ? `归并（${targetIds.length}）`
                        : `分类（${targetIds.length}）`
                  );
                  if (isMergeTopic) {
                    const scMerge = stakeCounts?.[gf.relMsgId];
                    const truthPro = scMerge?.truth.pro ?? 0;
                    const truthCon = scMerge?.truth.con ?? 0;
                    const valuePro = scMerge?.value.pro ?? 0;
                    const valueCon = scMerge?.value.con ?? 0;
                    return (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, height: "100%" }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#f3f4f6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                          {isRelWholeSel(gf.relMsgId) && <span style={{ marginRight: 6, fontSize: 10, fontWeight: 800, padding: "2px 6px", borderRadius: 4, background: "#fbbf24", color: "#111827" }}>归并</span>}
                          {topicTitle}
                        </span>
                        {(truthPro > 0 || truthCon > 0) && (
                          <span style={{ fontSize: 10, flexShrink: 0 }}>
                            <span style={{ color: "#a5b4fc" }}>⚖️</span>
                            {truthPro > 0 && <span style={{ color: "#4ade80" }}>👍{truthPro}</span>}
                            {truthCon > 0 && <span style={{ color: "#f87171" }}>👎{truthCon}</span>}
                          </span>
                        )}
                        {(valuePro > 0 || valueCon > 0) && (
                          <span style={{ fontSize: 10, flexShrink: 0 }}>
                            <span style={{ color: "#fcd34d" }}>💎</span>
                            {valuePro > 0 && <span style={{ color: "#4ade80" }}>👍{valuePro}</span>}
                            {valueCon > 0 && <span style={{ color: "#f87171" }}>👎{valueCon}</span>}
                          </span>
                        )}
                        {onSettlementToggleTruth && (
                          <button
                            onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new Event('guide-settlement-opened')); onSettlementToggleTruth(gf.relMsgId); }}
                            data-guide-settlement-entry="true" data-guide-target-message={gf.relMsgId}
                            style={{ flexShrink: 0, fontSize: 13, cursor: "pointer", background: settlementOpenMsgId === gf.relMsgId && settlementOpenType === 'TRUTH' ? "rgba(99,102,241,0.2)" : "none", border: settlementOpenMsgId === gf.relMsgId && settlementOpenType === 'TRUTH' ? "1px solid #6366f1" : "1px solid transparent", borderRadius: 4, padding: "0 3px", color: settlementOpenMsgId === gf.relMsgId && settlementOpenType === 'TRUTH' ? "#a5b4fc" : "#6b7280", lineHeight: 1 }}
                            title="真假仲裁"
                          >⚖️</button>
                        )}
                        {onSettlementToggleValue && (
                          <button
                            onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new Event('guide-settlement-opened')); onSettlementToggleValue(gf.relMsgId); }}
                            data-guide-settlement-entry="true" data-guide-target-message={gf.relMsgId}
                            style={{ flexShrink: 0, fontSize: 13, cursor: "pointer", background: settlementOpenMsgId === gf.relMsgId && settlementOpenType === 'VALUE' ? "rgba(245,158,11,0.2)" : "none", border: settlementOpenMsgId === gf.relMsgId && settlementOpenType === 'VALUE' ? "1px solid #f59e0b" : "1px solid transparent", borderRadius: 4, padding: "0 3px", color: settlementOpenMsgId === gf.relMsgId && settlementOpenType === 'VALUE' ? "#fcd34d" : "#6b7280", lineHeight: 1 }}
                            title="价值仲裁"
                          >💎</button>
                        )}
                        <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 500, color: "#9ca3af" }}>
                          💬{targetIds.length}
                        </span>
                        <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, padding: "0 5px", borderRadius: 999, background: "rgba(148,163,184,0.22)", color: "#cbd5e1", lineHeight: "16px" }}>
                          归并
                        </span>
                      </div>
                    );
                  }
                  return (
                    <>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#f3f4f6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {isRelWholeSel(gf.relMsgId) && <span style={{ display: "inline-block", marginRight: 6, fontSize: 10, fontWeight: 800, padding: "2px 6px", borderRadius: 4, background: "#fbbf24", color: "#111827" }}>{isSummaryTopic ? "总结" : "分类"}</span>}
                          {isSummaryTopic ? (
                            <>
                              <span style={{ display: "block", fontSize: 10, color: "#6ee7b7", marginBottom: 2 }}>总结内容</span>
                              <span style={{ display: "block", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{summaryContent || topicTitle}</span>
                            </>
                          ) : topicTitle}
                        </span>
                        <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 999, background: isMergeTopic ? "rgba(148,163,184,0.22)" : isSummaryTopic ? "rgba(52,211,153,0.2)" : "rgba(34,197,94,0.2)", color: isMergeTopic ? "#cbd5e1" : isSummaryTopic ? "#6ee7b7" : "#86efac" }}>
                          {isMergeTopic ? "归并容器" : isSummaryTopic ? "总结容器" : "分类容器"}
                        </span>
                      </div>
                      <div style={{ marginTop: 4, fontSize: 10, color: "#9ca3af", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>由 {relMsg?.author ?? "系统"} 发起</span>
                        <span style={{ flexShrink: 0 }}>💬 {targetIds.length}</span>
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

      {/* arrange frame decoration badges — full-size AGREE/DISAGREE badges to the RIGHT of the frame,
          styled and interactive identically to text-message decoration badges.
          Icon area: quick-send agree/disagree targeting the arrange relation message.
          Body area: toggle selection of all agree/disagree relation messages on this arrange. */}
      {visibleArrangeFrames.map(sf=>{
        const sfTagItems=tagsByRelMsgState.get(sf.relMsgId)??[];
        const sfDecLeft=sf.rect.x+sf.rect.width+DEC_RIGHT_GAP;
        let sfDecTop=sf.rect.y+DEC_RIGHT_TOP;
        const nodes: React.ReactNode[]=[];
        // Phase 6: ⚖️ settlement entry at top-right of arrange frame
        if (onSettlementToggleTruth) {
          const sc = stakeCounts?.[sf.relMsgId];
          const truthPro = sc?.truth.pro ?? 0;
          const truthCon = sc?.truth.con ?? 0;
          const valuePro = sc?.value.pro ?? 0;
          const valueCon = sc?.value.con ?? 0;
          nodes.push(
            <div key={`sf-settle-${sf.relMsgId}`} data-rel-overlay="true"
              style={{position:"absolute",left:sfDecLeft,top:sfDecTop,zIndex:7,
                display:"flex",gap:4,alignItems:"center",pointerEvents:"auto"}}>
              {(truthPro > 0 || truthCon > 0) && <span style={{fontSize:10}}><span style={{color:"#a5b4fc"}}>⚖️</span>{truthPro > 0 && <span style={{color:"#4ade80"}}>👍{truthPro}</span>}{truthCon > 0 && <span style={{color:"#f87171"}}>👎{truthCon}</span>}</span>}
              {(valuePro > 0 || valueCon > 0) && <span style={{fontSize:10}}><span style={{color:"#fcd34d"}}>💎</span>{valuePro > 0 && <span style={{color:"#4ade80"}}>👍{valuePro}</span>}{valueCon > 0 && <span style={{color:"#f87171"}}>👎{valueCon}</span>}</span>}
              <button
                onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new Event('guide-settlement-opened')); onSettlementToggleTruth(sf.relMsgId); }}
                data-guide-settlement-entry="true" data-guide-target-message={sf.relMsgId}
                style={{ fontSize: 13, cursor: "pointer", background: settlementOpenMsgId === sf.relMsgId && settlementOpenType === 'TRUTH' ? "rgba(99,102,241,0.2)" : "none", border: settlementOpenMsgId === sf.relMsgId && settlementOpenType === 'TRUTH' ? "1px solid #6366f1" : "1px solid transparent", borderRadius: 4, padding: "0 3px", color: settlementOpenMsgId === sf.relMsgId && settlementOpenType === 'TRUTH' ? "#a5b4fc" : "#6b7280", lineHeight: 1 }}
                title="真假仲裁"
              >⚖️</button>
              {onSettlementToggleValue && (
                <button
                  onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new Event('guide-settlement-opened')); onSettlementToggleValue(sf.relMsgId); }}
                  data-guide-settlement-entry="true" data-guide-target-message={sf.relMsgId}
                  style={{ fontSize: 13, cursor: "pointer", background: settlementOpenMsgId === sf.relMsgId && settlementOpenType === 'VALUE' ? "rgba(245,158,11,0.2)" : "none", border: settlementOpenMsgId === sf.relMsgId && settlementOpenType === 'VALUE' ? "1px solid #f59e0b" : "1px solid transparent", borderRadius: 4, padding: "0 3px", color: settlementOpenMsgId === sf.relMsgId && settlementOpenType === 'VALUE' ? "#fcd34d" : "#6b7280", lineHeight: 1 }}
                  title="价值仲裁"
                >💎</button>
              )}
            </div>
          );
          sfDecTop += DEC_H + DEC_GAP;
        }
        for (const kind of ["agree","disagree"] as const) {
          const count=kind==="agree"?sf.relAgreeCount:sf.relDisagreeCount;
          if (count<=0) continue;
          const isSelected=isDecorationSelected(sf.relMsgId,kind);
          const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
          const icon=kind==="agree"?"👍":"👎";
          const label=kind==="agree"?"赞":"反";
          nodes.push(
            <div key={`sf-${kind}-${sf.relMsgId}`} data-rel-overlay="true"
              onClick={ev=>{ev.stopPropagation();}}
              onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,sf.relMsgId,kind);}}
              title={`${kind==="agree"?"赞同":"反对"}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
              style={{position:"absolute",left:sfDecLeft,top:sfDecTop,width:DEC_W,height:DEC_H,zIndex:7,
                background:isSelected?"#fbbf24":bgColor,color:isSelected?"#111827":"#fff",borderRadius:4,display:"flex",alignItems:"center",
                fontSize:11,pointerEvents:"auto",boxShadow:isSelected?"0 0 0 2px #111827, 0 0 0 3px rgba(251,191,36,0.9), 0 2px 6px rgba(0,0,0,0.5)":"0 2px 6px rgba(0,0,0,0.5)",border:isSelected?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.08)",
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
        // TAG badges on this arrange relation message — aggregated by label text
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
          nodes.push(
            <div key={`sftag-${relMsgIds[0]}`} data-msgid={sf.relMsgId} data-jump-msgids={[sf.relMsgId, ...relMsgIds].join(' ')} data-rel-overlay="true"
              onClick={ev=>{ev.stopPropagation();onTagBodyClick?.(ev,sf.relMsgId,tagLabel,relMsgIds);}}
              onDoubleClick={ev=>{ev.stopPropagation();onTagDoubleClick?.(ev,sf.relMsgId,tagLabel,relMsgIds);}}
              title={`标注：${displayLabel}；单击选中，双击展开详情`}
              style={{position:"absolute",left:sfDecLeft-TAG_HIT_PAD,top:sfDecTop-TAG_HIT_PAD,
                width:tagW+2*TAG_HIT_PAD,height:TAG_H+2*TAG_HIT_PAD,
                zIndex:7,cursor:"pointer",pointerEvents:"auto",background:"transparent",
                display:"flex",alignItems:"center",justifyContent:"center",
                padding:TAG_HIT_PAD,boxSizing:"border-box"}}>
              <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",
                width:tagW,height:TAG_H,boxSizing:"border-box",
                  background:"rgba(180,150,0,0.85)",color:"#fff",borderRadius:3,
                  fontSize:10,padding:"0 4px",boxShadow:"0 1px 4px rgba(0,0,0,0.4)",
                border:"1px solid rgba(255,255,255,0.15)",
                whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                🏷{displayLabel}
              </span>
            </div>
          );
          sfDecTop+=TAG_H+TAG_V_GAP;
        }
        return <React.Fragment key={`supp-dec-${sf.relMsgId}`}>{nodes}</React.Fragment>;
      })}

      {/* GROUP frame decoration badges — AGREE/DISAGREE badges to the RIGHT of the group frame */}
      {visibleGroupFrames.map(gf=>{
        if (gf.relAgreeCount===0&&gf.relDisagreeCount===0) return null;
        const gfDecLeft=gf.rect.x+gf.rect.width+DEC_RIGHT_GAP;
        let gfDecTop=gf.rect.y+DEC_RIGHT_TOP;
        const nodes: React.ReactNode[]=[];
        for (const kind of ["agree","disagree"] as const) {
          const count=kind==="agree"?gf.relAgreeCount:gf.relDisagreeCount;
          if (count<=0) continue;
          const isSelected=isDecorationSelected(gf.relMsgId,kind);
          const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
          const icon=kind==="agree"?"👍":"👎";
          const label=kind==="agree"?"赞":"反";
          nodes.push(
            <div key={`gf-${kind}-${gf.relMsgId}`} data-rel-overlay="true"
              onClick={ev=>{ev.stopPropagation();}}
              onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,gf.relMsgId,kind);}}
              title={`${kind==="agree"?"赞同":"反对"}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
              style={{position:"absolute",left:gfDecLeft,top:gfDecTop,width:DEC_W,height:DEC_H,zIndex:7,
                background:isSelected?"#fbbf24":bgColor,color:isSelected?"#111827":"#fff",borderRadius:4,display:"flex",alignItems:"center",
                fontSize:11,pointerEvents:"auto",boxShadow:isSelected?"0 0 0 2px #111827, 0 0 0 3px rgba(251,191,36,0.9), 0 2px 6px rgba(0,0,0,0.5)":"0 2px 6px rgba(0,0,0,0.5)",border:isSelected?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.08)",
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
                data-msgid={_mid} data-jump-msgids={[_mid, ...group.relMsgIds].join(' ')} data-rel-overlay="true"
                onClick={ev=>{ev.stopPropagation();onTagBodyClick?.(ev,_mid,group.label,group.relMsgIds);}}
                onDoubleClick={ev=>{ev.stopPropagation();onTagDoubleClick?.(ev,_mid,group.label,group.relMsgIds);}}
                title={`标注：${group.label}（${count}人）；单击选中，双击展开详情`}
                style={{position:"absolute",left:group.rect.x-TAG_HIT_PAD,top:group.rect.y-TAG_HIT_PAD,
                  width:group.rect.width+2*TAG_HIT_PAD,height:group.rect.height+2*TAG_HIT_PAD,
                  zIndex:7,cursor:"pointer",pointerEvents:"auto",background:"transparent",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  padding:TAG_HIT_PAD,boxSizing:"border-box"}}>
                <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",
                  width:group.rect.width,height:group.rect.height,boxSizing:"border-box",
                  background:"rgba(180,150,0,0.85)",color:"#fff",borderRadius:3,
                  fontSize:10,padding:"0 4px",boxShadow:"0 1px 4px rgba(0,0,0,0.4)",
                  border:"1px solid rgba(255,255,255,0.15)",
                  whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  🏷{displayLabel}
                </span>
              </div>
            </React.Fragment>
          );
          return (
            <React.Fragment key={`tag-${_mid}-${group.label}`}>
              <div
                data-msgid={_mid} data-jump-msgids={[_mid, ...group.relMsgIds].join(' ')} data-rel-overlay="true"
                onClick={ev=>{ev.stopPropagation();onTagBodyClick?.(ev,_mid,group.label,group.relMsgIds);}}
                onDoubleClick={ev=>{ev.stopPropagation();onTagDoubleClick?.(ev,_mid,group.label,group.relMsgIds);}}
                title={`标注：${group.label}（${count}人）；单击选中，双击展开详情`}
                style={{position:"absolute",left:group.rect.x-TAG_HIT_PAD,top:group.rect.y-TAG_HIT_PAD,
                  width:group.rect.width+2*TAG_HIT_PAD,height:group.rect.height+2*TAG_HIT_PAD,
                  zIndex:7,cursor:"pointer",pointerEvents:"auto",background:"transparent",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  padding:TAG_HIT_PAD,boxSizing:"border-box"}}>
                <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",
                  width:group.rect.width,height:group.rect.height,boxSizing:"border-box",
                  background:"rgba(180,150,0,0.85)",color:"#fff",borderRadius:3,
                  fontSize:10,padding:"0 4px",boxShadow:"0 1px 4px rgba(0,0,0,0.4)",
                  border:"1px solid rgba(255,255,255,0.15)",
                  whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  🏷{displayLabel}
                </span>
              </div>
              {/* Full-size AGREE/DISAGREE decoration badges on this TAG relation group, stacked vertically */}
              {(()=>{
                const tagDecLeft=tagBadgeRight+DEC_RIGHT_GAP;
                let curTop=group.rect.y+Math.floor((group.rect.height-DEC_H)/2);
                return (["agree","disagree"] as const).map(kind=>{
                  const cnt=kind==="agree"?group.relAgreeCount:group.relDisagreeCount;
                  if (cnt<=0) return null;
                  const selectedDecorationIds=kind==="agree"?group.relAgreeMsgIds:group.relDisagreeMsgIds;
                  const isDecorationSel=selectedDecorationIds.some(isRelWholeSel);
                  const top=curTop; curTop+=DEC_H+DEC_GAP;
                  const bgColor=kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
                  const icon=kind==="agree"?"👍":"👎";
                  const label=kind==="agree"?"赞":"反";
                  return (
                    <div key={`tag-dec-${kind}-${_mid}-${group.label}`} data-rel-overlay="true"
                      onClick={ev=>{ev.stopPropagation();}}
                      onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,tagIconRelMsgId,kind);}}
                      title={`${kind==="agree"?"赞同":"反对"}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
                      style={{position:"absolute",left:tagDecLeft,top:top,width:DEC_W,height:DEC_H,zIndex:7,
                        background:bgColor,color:"#fff",borderRadius:4,display:"flex",alignItems:"center",
                        fontSize:11,pointerEvents:"auto",boxShadow:isDecorationSel?"0 0 0 2px #111827, 0 0 0 3px rgba(251,191,36,0.9), 0 2px 6px rgba(0,0,0,0.5)":"0 2px 6px rgba(0,0,0,0.5)",border:isDecorationSel?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.08)",
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
        const baseBg=v.kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)";
        const icon=v.kind==="agree"?"👍":"👎";
        const decKey=`${v.messageId}::${v.kind}`;
        const isSel=selectedDecorations?.has(decKey)??false;
        const bgColor=isSel
          ? "rgba(91,65,0,0.55)"
          : baseBg;
        const borderStyle=isSel
          ?"2px solid #fbbf24"
          :"1px solid rgba(255,255,255,0.08)";
        const shadowStyle=isSel
          ?"0 0 0 2px #111827, 0 0 0 3px rgba(251,191,36,0.9), 0 2px 8px rgba(251,191,36,0.35)"
          :"0 2px 6px rgba(0,0,0,0.5)";
        return (
          <div key={`dec-${v.key}`}
            data-msgid={v.messageId}
            data-jump-msgids={edges
              .filter(edge => edge.relationType === v.kind && edge.to.messageId === v.messageId)
              .map(edge => edge.relationMessageId)
              .join(' ') || undefined}
            data-rel-overlay="true"
            onClick={ev=>{ev.stopPropagation();}}
            onDoubleClick={ev=>{ev.stopPropagation();onDecorationDoubleClick?.(ev,v.messageId,v.kind);}}
            title={`${v.kind==="agree"?"赞同":"反对"}${isSel?"（已选中）":""}：点击图标快速发送，点击数字区域切换选中，双击展开详情`}
            style={{position:"absolute",left:v.rect.x,top:v.rect.y,width:v.rect.width,height:v.rect.height,zIndex:7,
              background:bgColor,color:"#fff",borderRadius:4,display:"flex",alignItems:"center",
              fontSize:11,pointerEvents:"auto",boxShadow:shadowStyle,border:borderStyle,
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
      {Array.from(inlineBadgesByMsg.entries()).map(([, badges]) =>
        badges.map(badge => {
          const isWholeSel = isRelWholeSel(badge.relMsgId);
          const bg = INLINE_BADGE_COLOR[badge.relColor] ?? 'rgba(100,100,120,0.9)';
          const tooltip = badge.subDetails && badge.subDetails.length > 0
            ? `${badge.relLabel}\n${badge.subDetails.map(d => {
                const stLabels: Record<string,string> = { SPAM:'垃圾', OFFTOPIC:'跑题', LOWVALUE:'低质', IMPORTANT:'重要', CUSTOM:'自定义' };
                return `  ${d.customLabel || stLabels[d.subType] || d.subType}: ${d.count}人`;
              }).join('\n')}\n双击查看详情`
            : `${badge.relLabel}；双击展开操作详情`;
          return (
            <div key={`badge-${badge.relMsgId}`} data-msgid={badge.relMsgId} data-jump-msgids={[badge.relMsgId, ...(badge.relMsgIds ?? [])].join(' ')} data-rel-overlay="true"
              onClick={ev=>{ev.stopPropagation();onInlineBadgeClick?.(ev,badge.relMsgId);}}
              onDoubleClick={ev=>{ev.stopPropagation();onInlineBadgeDoubleClick?.(ev,badge.relMsgId, { relMsgIds: badge.relMsgIds, subDetails: badge.subDetails });}}
              title={tooltip}
              style={{position:"absolute",left:badge.rect.x,top:badge.rect.y,width:badge.rect.width,height:badge.rect.height,
                zIndex:5,background:isWholeSel?"#fbbf24":bg,color:isWholeSel?"#111827":"#fff",borderRadius:3,display:"flex",alignItems:"center",justifyContent:"center",
                fontSize:9,pointerEvents:"auto",cursor:"pointer",padding:"0 4px",
                boxShadow:isWholeSel?"0 0 0 2px #111827, 0 0 0 3px rgba(251,191,36,0.9), 0 2px 8px rgba(251,191,36,0.35)":"0 1px 4px rgba(0,0,0,0.5)",
                border:isWholeSel?"2px solid #fbbf24":"1px solid rgba(255,255,255,0.15)",
                whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",fontWeight:600}}>
              {badge.relLabel}
            </div>
          );
        })
      )}

    </div>
  );
}

export default function GraphView(props: GraphViewProps) {
  return props.comparisonPair
    ? <ComparisonGraphPair {...props} />
    : <GraphViewCanvas {...props} />;
}










