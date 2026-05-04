import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DemoMessage, DemoEdge, UnitSelection, Selection, RelationType } from '../utils/modelBridge';

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
// Relation-decoration constants (AGREE/DISAGREE badges on relation visual elements, e.g. next to TAG badges)
const REL_DEC_W = 36;   // width of a relation-decoration badge
const REL_DEC_H = 16;   // height of a relation-decoration badge
const REL_DEC_GAP = 3;  // gap between adjacent relation-decoration badges

// Shared empty map to avoid allocating a new one on every render
const EMPTY_MAP: Map<string, string> = new Map();

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
  const names: Record<string, string> = {
    annotation: "注释", reference: "引用", reply: "回复",
    agree: "赞同", disagree: "反对", tag: "标注",
    correct: "更正", supplement: "补充",
  };
  return names[t] ?? t;
}

function computeMinColumnsForAnnoRefRule1(normalIds: string[], edges: DemoEdge[]) {
  const normalSet = new Set(normalIds);
  const relevant = edges.filter(
    (e) => (e.relationType === "annotation" || e.relationType === "reference") &&
      normalSet.has(e.from.messageId) && normalSet.has(e.to.messageId)
  );
  const col: Record<string, number> = {};
  for (const id of normalIds) col[id] = 0;
  let changed = true, iter = 0;
  while (changed && iter < 5000) {
    iter++; changed = false;
    for (const e of relevant) {
      const need = (col[e.to.messageId] ?? 0) + 1;
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
  normals: DemoMessage[]; edges: DemoEdge[]; baseCol: Record<string, number>; baseMaxCol: number;
}) {
  const { normals, edges, baseCol, baseMaxCol } = params;
  const col: Record<string, number> = { ...baseCol };
  let maxCol = baseMaxCol;
  const normalSet = new Set(normals.map(m => m.id));
  const msgById = new Map(normals.map(m => [m.id, m]));
  const minAllowed: Record<string, number> = {};
  for (const m of normals) minAllowed[m.id] = baseCol[m.id] ?? 0;
  for (const e of edges) {
    if (!(e.relationType === "annotation" || e.relationType === "reference")) continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    const need = (col[e.to.messageId] ?? 0) + 1;
    minAllowed[e.from.messageId] = Math.max(minAllowed[e.from.messageId] ?? 0, need);
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

/** High-priority rule: supplement source is placed in the same column as its target. */
function applySupplementColumnOverride(params: {
  normals: DemoMessage[];
  edges: DemoEdge[];
  col: Record<string, number>;
  maxCol: number;
}): { col: Record<string, number>; maxCol: number; suppSourceToTarget: Map<string, string> } {
  const { normals, edges } = params;
  const col = { ...params.col };
  const normalSet = new Set(normals.map(m => m.id));

  const suppSourceToTarget = new Map<string, string>();
  for (const e of edges) {
    if (e.relationType !== "supplement") continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId)) continue;
    suppSourceToTarget.set(e.from.messageId, e.to.messageId);
  }

  // Propagate columns: source gets same column as target (iterate until stable for chains)
  let changed = true, iter = 0;
  while (changed && iter < 1000) {
    changed = false; iter++;
    for (const [srcId, tgtId] of suppSourceToTarget) {
      const tgtCol = col[tgtId] ?? 0;
      if ((col[srcId] ?? 0) !== tgtCol) { col[srcId] = tgtCol; changed = true; }
    }
  }

  const maxCol = Math.max(0, ...(Object.values(col).length ? Object.values(col) : [0]));
  return { col, maxCol, suppSourceToTarget };
}

/**
 * Apply AGREE/DISAGREE layout column rules:
 *   AGREE source → same column as target (visual alignment = "I agree with this")
 *   DISAGREE source → one column to the right of target (visually contrasted)
 *
 * Only applies when both source and target are normal (text) messages.
 * Pure-stance (anon: source) or relation-message targets are skipped.
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
  // Only process stance-type edges between two normal (text) messages
  const stanceEdges = edges.filter(e => e.relationType === "agree" || e.relationType === "disagree");

  for (const e of stanceEdges) {
    const fromId = e.from.messageId, toId = e.to.messageId;
    // Skip pure-stance (anon: source) and relation-message targets
    if (!normalSet.has(fromId) || !normalSet.has(toId)) continue;
    const tgtCol = col[toId] ?? 0;
    col[fromId] = e.relationType === "agree" ? tgtCol : tgtCol + 1;
    maxCol = Math.max(maxCol, col[fromId]);
  }

  return { col, maxCol };
}

function computeNoOverlapLayout(params: {
  normals: DemoMessage[]; colOf: Record<string, number>; measuredHeights: Record<string, number>; maxCol: number;
  suppSourceToTarget?: Map<string, string>;
}) {
  const { normals, colOf, measuredHeights, maxCol } = params;
  const suppSourceToTarget = params.suppSourceToTarget ?? EMPTY_MAP;

  // Build reverse map: target → list of supplement sources
  const suppTargetToSources = new Map<string, string[]>();
  for (const [srcId, tgtId] of suppSourceToTarget) {
    const arr = suppTargetToSources.get(tgtId) ?? [];
    arr.push(srcId);
    suppTargetToSources.set(tgtId, arr);
  }

  const byCol = new Map<number, DemoMessage[]>();
  for (const m of normals) {
    const c = colOf[m.id] ?? 0;
    const arr = byCol.get(c) ?? [];
    arr.push(m);
    byCol.set(c, arr);
  }

  // Supplement sources in the same column as their target are NOT "root" messages
  const suppSourceIds = new Set(suppSourceToTarget.keys());

  const colCursor: Record<number, number> = {};
  for (let c = 0; c <= maxCol; c++) colCursor[c] = GRID_TOP;
  const layout: Record<string, LayoutBox> = {};
  let maxBottom = GRID_TOP;

  // Recursively place a message then its supplement children (with zero gap)
  function placeGroup(msg: DemoMessage, c: number, gapBefore: number, visited: Set<string>) {
    if (visited.has(msg.id)) return;
    visited.add(msg.id);
    colCursor[c] += gapBefore;
    const h = Math.max(MIN_CARD_H, measuredHeights[msg.id] ?? MIN_CARD_H);
    layout[msg.id] = { x: colX(c), y: colCursor[c], width: CARD_W, height: h };
    maxBottom = Math.max(maxBottom, colCursor[c] + h);
    colCursor[c] += h;
    // Place supplement sources directly below with zero gap
    const colMsgs = byCol.get(c) ?? [];
    const sources = (suppTargetToSources.get(msg.id) ?? []).filter(s => (colOf[s] ?? 0) === c);
    sources.sort((a, b) => {
      const ma = colMsgs.find(m => m.id === a), mb = colMsgs.find(m => m.id === b);
      return new Date(ma?.createdAt ?? 0).getTime() - new Date(mb?.createdAt ?? 0).getTime();
    });
    for (const srcId of sources) {
      const srcMsg = colMsgs.find(m => m.id === srcId);
      if (srcMsg) placeGroup(srcMsg, c, 0, visited);
    }
  }

  for (let c = 0; c <= maxCol; c++) {
    const colMsgs = byCol.get(c) ?? [];
    // Root messages: not supplement sources that have their target in the same column
    const roots = colMsgs.filter(m => {
      if (!suppSourceIds.has(m.id)) return true;
      const tgtId = suppSourceToTarget.get(m.id)!;
      return (colOf[tgtId] ?? 0) !== c; // target in different col → treat as root
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
    // voteStats is accepted for API compatibility but decoration counts are derived internally from edges
  } = props;

  const canvasRef = useRef<HTMLDivElement|null>(null);
  const cardRefs = useRef<Record<string,HTMLDivElement|null>>({});
  const contentRefs = useRef<Record<string,HTMLDivElement|null>>({});
  const headerRefs = useRef<Record<string,HTMLDivElement|null>>({});
  const textRefs = useRef<Record<string,SVGTextElement|null>>({});

  const msgMap = useMemo(() => new Map(messages.map(m => [m.id,m])), [messages]);
  const normals = useMemo(() => messages.filter(m => m.kind === "normal"), [messages]);
  const normalIds = useMemo(() => normals.map(m => m.id), [normals]);

  const { col: baseCol, maxCol: baseMaxCol } = useMemo(() => computeMinColumnsForAnnoRefRule1(normalIds, edges), [normalIds, edges]);
  const { col: replyCol, maxCol: replyMaxCol } = useMemo(() => applyReplyLayoutAdjustmentsWithConstraints({ normals, edges, baseCol, baseMaxCol }), [normals, edges, baseCol, baseMaxCol]);
  // AGREE/DISAGREE column override: applied before supplement so supplement can override it
  const { col: agreeDisCol, maxCol: agreeDisMaxCol } = useMemo(() => applyAgreeDisagreeColumnOverride({ normals, edges, col: replyCol, maxCol: replyMaxCol }), [normals, edges, replyCol, replyMaxCol]);
  // Supplement column override: highest priority — source must be in same column as target,
  // overriding any agree/disagree placement so zero-gap stacking is always preserved.
  const { col: colOf, maxCol, suppSourceToTarget } = useMemo(() => applySupplementColumnOverride({ normals, edges, col: agreeDisCol, maxCol: agreeDisMaxCol }), [normals, edges, agreeDisCol, agreeDisMaxCol]);

  const [measuredHeights, setMeasuredHeights] = useState<Record<string,number>>({});
  const [layout, setLayout] = useState<Record<string,LayoutBox>>({});
  const [canvasHeight, setCanvasHeight] = useState<number>(900);
  const [positionedEdges, setPositionedEdges] = useState<PositionedEdge[]>([]);
  const [labelBboxes, setLabelBboxes] = useState<Record<string,LabelBbox>>({});
  const [decorationRectsState, setDecorationRectsState] = useState<Record<string,{kind:"agree"|"disagree";rect:Rect;iconRect:Rect;bodyRect:Rect;key:string;messageId:string}>|null>(null);
  const [decorationsByMsgState, setDecorationsByMsgState] = useState<Record<string,{agreeCount:number;disagreeCount:number;agreeKey:string;disagreeKey:string}>|null>(null);
  // TAG decorations: aggregated by label text — map from messageId → list of {label, relMsgIds, rect, relAgreeCount, relDisagreeCount, relAgreeMsgIds, relDisagreeMsgIds}
  const [tagDecorationsByMsg, setTagDecorationsByMsg] = useState<Record<string,{label:string;relMsgIds:string[];rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[]>>({});
  // SUPPLEMENT frames: list of {targetId, sourceId, frame rect, relAgreeCount, relDisagreeCount, relAgreeMsgIds, relDisagreeMsgIds}
  const [supplementFrames, setSupplementFrames] = useState<{targetId:string;sourceId:string;relMsgId:string;rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[]>([]);
  // AGREE/DISAGREE decorations targeting relation messages — for edge-label relations (annotation/reference/reply)
  const [relDecByRelMsgState, setRelDecByRelMsgState] = useState<Map<string,{agreeCount:number;disagreeCount:number;agreeRelMsgIds:string[];disagreeRelMsgIds:string[]}>>(new Map());

  const canvasWidth = GRID_LEFT*2 + (maxCol+1)*CARD_W + maxCol*COL_GAP;
  const edgesByRelMsg = useMemo(() => {
    const map = new Map<string,DemoEdge[]>();
    for (const e of edges) { const arr=map.get(e.relationMessageId)??[]; arr.push(e); map.set(e.relationMessageId,arr); }
    return map;
  }, [edges]);

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
    const { layout: nl, canvasHeight: h } = computeNoOverlapLayout({ normals, colOf, measuredHeights, maxCol, suppSourceToTarget });
    setLayout(nl); setCanvasHeight(h);
  }, [normals, colOf, maxCol, measuredHeights, suppSourceToTarget]);

  useEffect(() => {
    const canvasEl = canvasRef.current; if (!canvasEl) return;
    const canvasRect = canvasEl.getBoundingClientRect();
    const normalSet = new Set(normalIds);

    function endpointBoxForNormal(id: string): {box:LayoutBox;col:number}|null {
      const m = msgMap.get(id); if (!m||m.kind!=="normal") return null;
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
        // Relation message targets (rel:...) are tracked separately in relDecByRelMsgId below
        if (mid.startsWith("rel:")) continue;
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
      const fromMsg=msgMap.get(e.from.messageId);
      const label=fromMsg?.content?.slice(0,TAG_MAX_LABEL_CHARS)??"标注";
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

    // Compute SUPPLEMENT frames (border wrapping target + source messages)
    const newSupplementFrames: {targetId:string;sourceId:string;relMsgId:string;rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[] = [];
    for (const e of edges) {
      if (e.relationType!=="supplement") continue;
      if (e.to.selection.kind!=="whole"&&e.to.selection.kind!=="text") continue;
      const targetId=e.to.messageId, sourceId=e.from.messageId;
      const targetBox=endpointBoxForNormal(targetId)?.box??layout[targetId];
      const sourceBox=endpointBoxForNormal(sourceId)?.box??layout[sourceId];
      if (!targetBox||!sourceBox) continue;
      const minX=Math.min(targetBox.x,sourceBox.x)-SUPP_FRAME_PAD;
      const minY=Math.min(targetBox.y,sourceBox.y)-SUPP_FRAME_PAD;
      const maxX=Math.max(targetBox.x+targetBox.width,sourceBox.x+sourceBox.width)+SUPP_FRAME_PAD;
      const maxY=Math.max(targetBox.y+targetBox.height,sourceBox.y+sourceBox.height)+SUPP_FRAME_PAD;
      const rect={x:minX,y:minY,width:maxX-minX,height:maxY-minY};
      newSupplementFrames.push({targetId,sourceId,relMsgId:e.relationMessageId,rect,relAgreeCount:0,relDisagreeCount:0,relAgreeMsgIds:[],relDisagreeMsgIds:[]});
    }

    // Compute AGREE/DISAGREE decorations targeting relation messages (relDecByRelMsgId)
    // These are displayed next to the relation's visual element (tag badge, supplement frame, edge label)
    const relDecByRelMsgId = new Map<string,{agreeCount:number;disagreeCount:number;agreeRelMsgIds:string[];disagreeRelMsgIds:string[]}>();
    for (const e of edges) {
      if (e.relationType!=="agree"&&e.relationType!=="disagree") continue;
      if (e.to.selection.kind!=="whole") continue;
      const toId=e.to.messageId;
      if (!toId.startsWith("rel:")) continue;
      const cur=relDecByRelMsgId.get(toId)??{agreeCount:0,disagreeCount:0,agreeRelMsgIds:[],disagreeRelMsgIds:[]};
      if (e.relationType==="agree") { cur.agreeCount++; cur.agreeRelMsgIds.push(e.relationMessageId); }
      else { cur.disagreeCount++; cur.disagreeRelMsgIds.push(e.relationMessageId); }
      relDecByRelMsgId.set(toId, cur);
    }
    // Propagate counts and IDs to tag groups and supplement frames
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
    for (const sf of newSupplementFrames) {
      const dec=relDecByRelMsgId.get(sf.relMsgId);
      if (dec) {
        sf.relAgreeCount+=dec.agreeCount; sf.relDisagreeCount+=dec.disagreeCount;
        sf.relAgreeMsgIds.push(...dec.agreeRelMsgIds); sf.relDisagreeMsgIds.push(...dec.disagreeRelMsgIds);
      }
    }
    setRelDecByRelMsgState(relDecByRelMsgId);
    setTagDecorationsByMsg(newTagDecorationsByMsg);
    setSupplementFrames(newSupplementFrames);

    // Build lookup maps for visual positions of relation messages (used in edge targeting)
    const suppFrameByRelMsgId = new Map<string,Rect>();
    for (const sf of newSupplementFrames) suppFrameByRelMsgId.set(sf.relMsgId, sf.rect);

    const tagBadgeByRelMsgId = new Map<string,{mid:string;rect:Rect}>();
    for (const [mid,groups] of Object.entries(newTagDecorationsByMsg)) {
      for (const group of groups) {
        for (const rmId of group.relMsgIds) tagBadgeByRelMsgId.set(rmId,{mid,rect:group.rect});
      }
    }

    const rawEdges: Omit<PositionedEdge,"labelX"|"labelY">[] = [];
    const labelSeeds: LabelSeed[] = [];
    const labelText = (e:DemoEdge,author:string) => `${author} · ${relationTypeName(e.relationType)}`;

    for (const e of edges) {
      const fromMsg=msgMap.get(e.from.messageId); if (!fromMsg||fromMsg.kind!=="normal") continue;
      const fromEp=endpointBoxForNormal(fromMsg.id); if (!fromEp) continue;
      const fromAuthor=fromMsg.author;
      const toMsg=msgMap.get(e.to.messageId);

      // Tag and supplement relations are rendered as decorations/frames — no directed arrows.
      // Agree/disagree: pure-stance (anon: source) → decoration only; with real source → directed arrow to decoration badge.
      if (e.relationType==="tag"||e.relationType==="supplement") continue;
      if (e.relationType==="agree"||e.relationType==="disagree") {
        if (e.from.messageId.startsWith("anon:")) continue; // pure-stance, decoration only
        // With source message: render directed arrow pointing to the decoration badge
        const targetMid=e.to.messageId;
        const decKey=`${targetMid}::${e.relationType}`;
        const decRect=decorationRects[decKey]?.rect;
        if (!decRect) continue; // decoration not yet laid out
        const toBox: LayoutBox={x:decRect.x,y:decRect.y,width:decRect.width,height:decRect.height};
        rawEdges.push({
          drawId:e.id,edge:e,fromAuthor,
          fromBox:fromEp.box,toBox,fromCol:fromEp.col,toCol:fromEp.col,
          fragRectCanvas:null,edgeLabelText:labelText(e,fromAuthor),expandedToEdgeId:null,
          start:{x:0,y:0},ctrl:{x:0,y:0},end:{x:0,y:0},
        });
        continue;
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

        // Agree/disagree decoration: edge should point to the decoration badge
        if (targetRelType === "agree" || targetRelType === "disagree") {
          const targetMid = targetRelEdges[0]?.to.messageId ?? "";
          const decKey = `${targetMid}::${targetRelType}`;
          const decRect = decorationRects[decKey]?.rect;
          if (decRect) {
            rawEdges.push({
              drawId:e.id,edge:e,fromAuthor,
              fromBox:fromEp.box,toBox:{x:decRect.x,y:decRect.y,width:decRect.width,height:decRect.height},
              fromCol:fromEp.col,toCol:fromEp.col,
              fragRectCanvas:null,edgeLabelText:labelText(e,fromAuthor),expandedToEdgeId:null,
              start:{x:0,y:0},ctrl:{x:0,y:0},end:{x:0,y:0},
            });
          }
          continue;
        }

        // For annotation/reference/reply (edge-label kind): use approximate midpoint of that relation's endpoints
        // as the best available proxy for where the edge label will appear.
        const expand=(te:DemoEdge) => {
          const teToMsg=msgMap.get(te.to.messageId);
          const epTarget=teToMsg?.kind==="normal" ? endpointBoxForNormal(te.to.messageId) : null;
          // Compute the approximate midpoint between the relation's from and to boxes
          const teFromMsg=msgMap.get(te.from.messageId);
          const epFrom=teFromMsg?.kind==="normal" ? endpointBoxForNormal(te.from.messageId) : null;
          let approxToBox: LayoutBox;
          if (epTarget && epFrom) {
            const midX=(epFrom.box.x+epFrom.box.width/2+epTarget.box.x+epTarget.box.width/2)/2;
            const midY=(epFrom.box.y+epFrom.box.height/2+epTarget.box.y+epTarget.box.height/2)/2;
            approxToBox={x:midX-20,y:midY-8,width:40,height:16};
          } else {
            approxToBox=epTarget?.box??fromEp.box;
          }
          rawEdges.push({
            drawId:`${e.id}__toRel__${te.id}`,edge:e,fromAuthor,
            fromBox:fromEp.box,toBox:approxToBox,
            fromCol:fromEp.col,toCol:epTarget?.col??fromEp.col,
            fragRectCanvas:null,edgeLabelText:labelText(e,fromAuthor),expandedToEdgeId:te.id,
            start:{x:0,y:0},ctrl:{x:0,y:0},end:{x:0,y:0},
          });
        };
        const toSel = e.to.selection;
        if (toSel.kind==="edge") (edgesByRelMsg.get(relId)??[]).filter(x=>x.id===(toSel as {kind:"edge";edgeId:string}).edgeId).forEach(expand);
        else if (toSel.kind==="whole") (edgesByRelMsg.get(relId)??[]).forEach(expand);
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
  }, [edges, msgMap, layout, colOf, normalIds, edgesByRelMsg, canvasWidth, canvasHeight, normals]);

  useEffect(() => {
    const canvasEl=canvasRef.current; if (!canvasEl) return;
    const canvasRect=canvasEl.getBoundingClientRect();
    const next: Record<string,LabelBbox>={};
    for (const pe of positionedEdges) {
      const t=textRefs.current[pe.drawId]; if (!t) continue;
      const r=t.getBoundingClientRect();
      next[pe.drawId]={x:r.left-canvasRect.left,y:r.top-canvasRect.top,width:r.width,height:r.height};
    }
    setLabelBboxes(next);
  }, [positionedEdges, canvasWidth, canvasHeight]);

  function isEdgeLabelFragSel(relId:string,edgeId:string) {
    return draftUnits.some(x=>unitEquals(x,{messageId:relId,selection:{kind:"edge",edgeId}}));
  }
  function isRelWholeSel(relId:string) {
    return draftUnits.some(x=>unitEquals(x,{messageId:relId,selection:{kind:"whole"}}));
  }

  function renderContent(message: DemoMessage) {
    const targets=extractTextTargetsForMessage(message.id,edges);
    if (!targets.length) return <pre style={{margin:0,whiteSpace:"pre-wrap",fontFamily:"Menlo,Monaco,Consolas,'Courier New',monospace",fontSize:13}}>{message.content}</pre>;
    const text=message.content;
    const segs:{start:number;end:number;relationType:RelationType}[]=[]; let lastEnd=-1;
    for (const t of targets) {
      if (t.start<0||t.start+t.len>text.length||t.len<=0||t.start<lastEnd) continue;
      segs.push({start:t.start,end:t.start+t.len,relationType:t.relationType}); lastEnd=t.start+t.len;
    }
    const nodes: React.ReactNode[]=[]; let cursor=0;
    for (const s of segs) {
      if (cursor<s.start) nodes.push(<span key={`t-${cursor}`} style={{whiteSpace:"pre-wrap"}}>{text.slice(cursor,s.start)}</span>);
      const frag=text.slice(s.start,s.end), len=s.end-s.start, isAnno=s.relationType==="annotation";
      const selected=isFragmentSelected(message.id,s.start,len,frag);
      nodes.push(
        <span key={`h-${s.start}-${s.end}`} data-rel-anchor={`${s.relationType}::${s.start}:${s.end}`}
          onClick={e=>{e.stopPropagation();onFragmentAnchorClick(message.id,s.start,len,frag);}}
          title="点击：进入文本选择状态并切换选中该片段"
          style={{whiteSpace:"pre-wrap",cursor:"pointer",backgroundColor:selected?"rgba(11,132,255,0.18)":isAnno?"rgba(255,255,0,0.12)":"rgba(80,180,255,0.08)",outline:selected?"2px solid rgba(11,132,255,0.95)":isAnno?"1px solid rgba(255,255,0,0.8)":"1px solid rgba(80,180,255,0.45)",borderRadius:2}}
        >{frag}</span>
      );
      cursor=s.end;
    }
    if (cursor<text.length) nodes.push(<span key={`t-${cursor}`} style={{whiteSpace:"pre-wrap"}}>{text.slice(cursor)}</span>);
    return <pre style={{margin:0,whiteSpace:"pre-wrap",fontFamily:"Menlo,Monaco,Consolas,'Courier New',monospace",fontSize:13}}>{nodes}</pre>;
  }

  /** Render small AGREE/DISAGREE count badges next to a relation's visual element.
   *  Pass `relMsgId` to make the badge clickable (selects the agree/disagree relation message). */
  function renderRelDecBadge(key: string, kind: "agree"|"disagree", count: number, left: number, top: number, zIndex: number, relMsgId?: string) {
    if (count <= 0) return null;
    const clickable = !!relMsgId;
    return (
      <div key={key} data-rel-overlay="true"
        onClick={clickable ? (e) => { e.stopPropagation(); onEdgeLabelSingleClick(e, relMsgId!, "whole"); } : undefined}
        style={{position:"absolute",left,top,width:REL_DEC_W,height:REL_DEC_H,zIndex,
          background:kind==="agree"?"rgba(2,150,80,0.9)":"rgba(200,40,40,0.9)",
          color:"#fff",borderRadius:3,fontSize:9,
          display:"flex",alignItems:"center",justifyContent:"center",
          pointerEvents:clickable?"auto":"none",cursor:clickable?"pointer":"default",
          boxShadow:"0 1px 3px rgba(0,0,0,0.4)"}}>
        {kind==="agree"?"👍":"👎"}{count}
      </div>
    );
  }

  return (
    <div ref={canvasRef} style={{position:"relative",width:"100%",height:"100%"}}
      onMouseDown={e=>{const t=e.target as HTMLElement;if(!canvasRef.current)return;if(t.closest&&(t.closest("[data-msgid]")||t.closest("svg")||t.closest('[title^="relation="]')||t.closest("[data-rel-overlay]")))return;onCanvasBlankClick?.();}}>      <div style={{position:"relative",width:canvasWidth,height:canvasHeight,zIndex:2}}>
        {normals.map(msg=>{
          const box=layout[msg.id]; if(!box) return null;
          const isWhole=draftUnits.some(u=>u.messageId===msg.id&&u.selection.kind==="whole");
          const isText=activeTextSelectId===msg.id&&msg.kind==="normal";
          return (
            <div key={msg.id} data-msgid={msg.id} ref={el=>{cardRefs.current[msg.id]=el;}}
              onClick={e=>onMessageClick(e,msg.id)} onDoubleClick={e=>onMessageDoubleClick(e,msg.id)}
              onMouseDown={e=>onMessageMouseDown?.(e,msg.id)} onMouseUp={e=>onMessageMouseUp?.(e,msg.id)}
              style={{position:"absolute",left:box.x,top:box.y,width:box.width,background:"#1f1f1f",borderRadius:6,border:isText?"2px dashed #0b84ff":isWhole?"2px solid #0b84ff":"1px solid #444",padding:"12px 16px",boxShadow:isText?"0 6px 18px rgba(11,132,255,0.06)":"0 4px 10px rgba(0,0,0,0.5)",display:"flex",flexDirection:"column",gap:8,cursor:"pointer",outline:lastClickedMessageId===msg.id?"1px dashed #0b84ff":"none",userSelect:activeTextSelectId===msg.id?"text":"auto"}}>
              <div ref={el=>{headerRefs.current[msg.id]=el;}} style={{fontSize:11,opacity:0.85,display:"flex",justifyContent:"space-between"}}>
                <span>{msg.author}</span><span style={{opacity:0.7}}>{msg.id}</span>
              </div>
              {isText&&<div style={{fontSize:11,color:"#0b84ff",marginBottom:4}}>文本选择模式：拖选记录 start+len；或点击高亮片段</div>}
              <div ref={el=>{contentRefs.current[msg.id]=el;}} style={{fontSize:13,color:"#f5f5f5"}} onMouseUp={e=>onTextMouseUp(e,msg.id)}>
                {renderContent(msg)}
              </div>
            </div>
          );
        })}
      </div>

      {/* SVG layer: supplement frame visuals + edge paths.
          Gate on either having edges or frames so frames render even with no other edges. */}
      {(positionedEdges.length>0||supplementFrames.length>0)&&(
        <svg width={canvasWidth} height={canvasHeight} style={{position:"absolute",left:0,top:0,zIndex:3,pointerEvents:"none"}}>
          {/* SUPPLEMENT frames — stroke reflects selection state */}
          {supplementFrames.map(sf=>{
            const isWhole=isRelWholeSel(sf.relMsgId);
            return (
              <rect key={`supp-frame-${sf.relMsgId}`} x={sf.rect.x} y={sf.rect.y} width={sf.rect.width} height={sf.rect.height}
                rx={SUPP_FRAME_RADIUS} ry={SUPP_FRAME_RADIUS}
                fill="rgba(130,80,200,0.04)"
                stroke={isWhole?"rgba(11,132,255,0.85)":"rgba(130,80,200,0.55)"}
                strokeWidth={2.5} strokeDasharray={isWhole?undefined:"5 3"}/>
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
            return (
              <g key={pe.drawId}>
                <path d={path} stroke={color} strokeWidth={edge.relationType==="reply"?1.0:1.2} fill="none"/>
                <path d={`M ${ax1} ${ay1} L ${end.x} ${end.y} L ${ax2} ${ay2}`} fill={color}/>
                <text ref={el=>{textRefs.current[pe.drawId]=el;}} x={labelX} y={labelY} fill={color} opacity={labelOpacity} fontSize={10} textAnchor="middle" dominantBaseline="central" style={{paintOrder:"stroke",stroke:labelStroke,strokeWidth:isWhole||isFrag?3:2} as any}>
                  {edgeLabelText}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {/* Edge label HTML hit areas */}
      {positionedEdges.map(pe=>{
        const bb=labelBboxes[pe.drawId]; if (!bb) return null;
        const padX=8,padY=6,box:LayoutBox={x:bb.x-padX,y:bb.y-padY,width:bb.width+padX*2,height:bb.height+padY*2};
        const relId=pe.edge.relationMessageId,isWhole=isRelWholeSel(relId),isFrag=isEdgeLabelFragSel(relId,pe.edge.id);
        return (
          <div key={`hit-${pe.drawId}`} data-rel-overlay="true" onClick={e=>onEdgeLabelSingleClick(e,relId,pe.edge.id)} onDoubleClick={e=>onEdgeLabelDoubleClick(e,relId)}
            style={{position:"absolute",left:box.x,top:box.y,width:box.width,height:box.height,zIndex:4,cursor:"pointer",pointerEvents:"auto",background:"transparent",borderRadius:6,border:isWhole||isFrag?"1px solid rgba(11,132,255,0.85)":"1px solid transparent"}}
            title={`relation=${pe.edge.relationMessageId} edge=${pe.edge.id}`}/>
        );
      })}

      {/* Edge-label relation decoration badges — AGREE/DISAGREE counts on annotation/reference/reply relations,
          shown to the RIGHT of the edge label (right of the target message, per spec). */}
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
          if (!dec||(dec.agreeCount===0&&dec.disagreeCount===0)) continue;
          rendered.add(relId);
          const badgeLeft=bb.x+bb.width+REL_DEC_GAP;
          const badgeTop=bb.y+Math.floor((bb.height-REL_DEC_H)/2);
          const disagreeLeft=badgeLeft+(dec.agreeCount>0?REL_DEC_W+REL_DEC_GAP:0);
          const a=renderRelDecBadge(`reldec-agree-${relId}`,"agree",dec.agreeCount,badgeLeft,badgeTop,5,dec.agreeRelMsgIds[0]);
          const d=renderRelDecBadge(`reldec-disagree-${relId}`,"disagree",dec.disagreeCount,disagreeLeft,badgeTop,5,dec.disagreeRelMsgIds[0]);
          if (a) items.push(a); if (d) items.push(d);
        }
        return items;
      })()}

      {/* Supplement frame border-strip hit areas — 4 thin divs at zIndex:4 covering the frame border,
          one strip per side.  Each strip is SUPP_FRAME_PAD wide (half inside, half outside the rect),
          so it exactly covers the padding zone between the visible SVG border and the message cards. */}
      {supplementFrames.map(sf=>{
        const handleClick=(e: React.MouseEvent)=>{e.stopPropagation();onEdgeLabelSingleClick(e,sf.relMsgId,"frame");};
        const handleDblClick=(e: React.MouseEvent)=>{e.stopPropagation();onEdgeLabelDoubleClick(e,sf.relMsgId);};
        const {x,y,width,height}=sf.rect;
        const HH=SUPP_FRAME_PAD; // half-width of each border strip
        const stripBase: React.CSSProperties={position:"absolute",zIndex:4,cursor:"pointer",pointerEvents:"auto",background:"transparent"};
        const title=`补充关系：${sf.relMsgId}；单击选中，双击展开详情`;
        return (
          <React.Fragment key={`supp-hit-${sf.relMsgId}`}>
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
          </React.Fragment>
        );
      })}

      {/* Supplement frame decoration badges — AGREE/DISAGREE counts shown to the RIGHT of the frame,
          outside the frame border (not inside), per spec. */}
      {supplementFrames.map(sf=>{
        if (sf.relAgreeCount===0&&sf.relDisagreeCount===0) return null;
        const sfDecLeft=sf.rect.x+sf.rect.width+DEC_RIGHT_GAP;
        const sfDecTop=sf.rect.y+DEC_RIGHT_TOP;
        const disagreeLeft=sfDecLeft+(sf.relAgreeCount>0?REL_DEC_W+REL_DEC_GAP:0);
        return (
          <React.Fragment key={`supp-dec-${sf.relMsgId}`}>
            {renderRelDecBadge(`sf-agree-${sf.relMsgId}`,"agree",sf.relAgreeCount,sfDecLeft,sfDecTop,4,sf.relAgreeMsgIds[0])}
            {renderRelDecBadge(`sf-disagree-${sf.relMsgId}`,"disagree",sf.relDisagreeCount,disagreeLeft,sfDecTop,4,sf.relDisagreeMsgIds[0])}
          </React.Fragment>
        );
      })}

      {/* TAG decoration labels — aggregated by label text, interactive */}
      {Object.entries(tagDecorationsByMsg).map(([_mid,groups])=>
        groups.map(group=>{
          const count=group.relMsgIds.length;
          const displayLabel=count>1?`${group.label}（${count}人）`:group.label;
          const isSelected=group.relMsgIds.some(id=>isRelWholeSel(id));
          // Relation-on-relation badges appear to the right of the tag badge
          const tagBadgeRight = group.rect.x + group.rect.width;
          const tagAgreeLeft = tagBadgeRight + REL_DEC_GAP;
          const tagDisagreeLeft = tagAgreeLeft + (group.relAgreeCount > 0 ? REL_DEC_W + REL_DEC_GAP : 0);
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
              {/* Relation-on-relation decorations: AGREE/DISAGREE badges on this TAG relation */}
              {renderRelDecBadge(`tag-agree-${_mid}-${group.label}`,"agree",group.relAgreeCount,tagAgreeLeft,group.rect.y,5,group.relAgreeMsgIds[0])}
              {renderRelDecBadge(`tag-disagree-${_mid}-${group.label}`,"disagree",group.relDisagreeCount,tagDisagreeLeft,group.rect.y,5,group.relDisagreeMsgIds[0])}
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
    </div>
  );
}
