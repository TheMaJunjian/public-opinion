import { routeGraphEdges } from './graphEdgeRouting';
import type { MutableRefObject } from 'react';
import type { DemoMessage, DemoEdge } from './modelBridge';
import { computeTransitiveVoteStats, computeTransitiveRelDecStats, isContentKind } from './modelBridge';
import type { PresentationKind } from '../types';
import { getPresentationSpec } from '../types';
import { hasActiveDisplayEffect } from './messageDisplay';
import { FRAME_PAD, MERGE_CARD_H } from './layout';
import type { LayoutBox, Rect } from './layout';
import type { Box } from './frameLayout';
import type { Point } from './graphEdgeGeometry';
import { getRelKind, isArrangeFrameRel, isAnyFrameRel, getRelationBoundsFromLayout, DEC_W, DEC_H, DEC_GAP, DEC_RIGHT_GAP, DEC_RIGHT_TOP, DEC_ICON_W, EDGE_HINT_W, TAG_H, TAG_MIN_W, TAG_V_GAP, TAG_MAX_LABEL_CHARS, MERGE_CONTENT_TOP_GAP } from './graphPresentationGeometry';
import { quadAt } from './graphEdgeGeometry';
import { moveAnchor, type GraphAnchorCache } from './graphAnchorCache';
import { getAnnotationPlacement, getDecorationColumnWidth } from './graphPresentationGeometry';
type LabelBbox = Rect;
export type PositionedEdge = {
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
function isValidTagLabel(label: string | undefined): label is string {
  return !!label && label !== 'tag';
}

export interface GraphOverlayInput {
  anchorCache?: GraphAnchorCache;
  skipRouting?: boolean;
  canvasRef: MutableRefObject<HTMLDivElement | null>;
  normalIds: string[];
  msgMap: Map<string, DemoMessage>;
  relationCardMsgIds: Set<string>;
  cardRefs: MutableRefObject<Record<string, HTMLDivElement | null>>;
  colOf: { [x: string]: number; };
  layout: Record<string, Box>;
  normals: DemoMessage[];
  headerRefs: MutableRefObject<Record<string, HTMLDivElement | null>>;
  contentRefs: MutableRefObject<Record<string, HTMLDivElement | null>>;
  edges: DemoEdge[];
  excludedStanceEdges?: ReadonlySet<string>;
  visibleDecorationIds?: ReadonlySet<string>;
  visibleAnnotationIds?: ReadonlySet<string>;
  messages: DemoMessage[];
  isTraceWindow: boolean;
  anonCorrectedRelMsgIds: Set<string>;
  finalFrameRects: Record<string, Box>;
  traceExpandedFrameIds: Set<string>;
  edgesByRelMsg: Map<string, DemoEdge[]>;
  labelBboxes: Record<string, LabelBbox>;
  comparisonSuppressedRelIds: Set<string>;
  correctedEdgeIdsByRelMsg: Map<string, Set<string>>;
}

export interface GraphOverlays {
  annotationToggleRects: Record<string, Rect>;
  positionedEdges: PositionedEdge[];
  decorationRectsState: Record<string,{kind:"agree"|"disagree";rect:Rect;iconRect:Rect;bodyRect:Rect;key:string;messageId:string}>|null;
  decorationsByMsgState: Record<string,{agreeCount:number;disagreeCount:number;agreeKey:string;disagreeKey:string}>|null;
  tagDecorationsByMsg: Record<string,{label:string;relMsgIds:string[];rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[]>;
  arrangeFrames: {targetId:string;sourceId:string;relMsgId:string;isBlankCorrected:boolean;rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[];
  groupFrames: {targetId:string;sourceId:string;relMsgId:string;relType:string;isBlankCorrected:boolean;relKind:PresentationKind;relLabel:string;relColor:string;rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[];
  inlineBadgesByMsg: Map<string,Array<{relMsgId:string;relMsgIds?:string[];relKind:string;relLabel:string;relColor:string;rect:Rect;subDetails?:Array<{subType:string;customLabel?:string;count:number}>}>>;
  relDecByRelMsgState: Map<string,{agreeCount:number;disagreeCount:number;agreeRelMsgIds:string[];disagreeRelMsgIds:string[]}>;
  tagsByRelMsgState: Map<string,Array<{label:string;relMsgId:string}>>;
}

export function emptyGraphOverlays(): GraphOverlays {
  return { annotationToggleRects: {}, positionedEdges: [], decorationRectsState: null, decorationsByMsgState: null, tagDecorationsByMsg: {}, arrangeFrames: [], groupFrames: [], inlineBadgesByMsg: new Map(), relDecByRelMsgState: new Map(), tagsByRelMsgState: new Map() };
}

/** Measure card anchors and project relation overlays without changing application state. */
export function measureGraphOverlays(input: GraphOverlayInput): GraphOverlays | undefined {
  const { canvasRef, normalIds, msgMap, relationCardMsgIds, cardRefs, colOf, layout, normals, headerRefs, contentRefs, edges, messages, isTraceWindow, anonCorrectedRelMsgIds, finalFrameRects, traceExpandedFrameIds, edgesByRelMsg, labelBboxes, comparisonSuppressedRelIds, correctedEdgeIdsByRelMsg } = input;

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
      const cached = input.anchorCache?.get(m.id), box = layout[m.id];
      if (cached && box) { globalForbiddenRects.push(...cached.obstacles.map(rect => moveAnchor(rect, box))); continue; }
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
      const cached = input.anchorCache?.get(messageId), box = layout[messageId];
      if (cached && box) return [...cached.obstacles.map(rect => moveAnchor(rect, box)), box];
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

    const decorationsByMsg = computeTransitiveVoteStats(edges, messages, input.excludedStanceEdges);

    // Decorations are placed to the RIGHT of the card, stacked vertically (agree on top, disagree below).
    // Each badge is split into icon area (left DEC_ICON_W px) and body area (rest).
    const decorationRects: Record<string,{kind:"agree"|"disagree";rect:Rect;iconRect:Rect;bodyRect:Rect;key:string;messageId:string}> = {};
    for (const [mid,data] of Object.entries(decorationsByMsg)) {
      const ep=endpointBoxForNormal(mid), box=ep?.box??layout[mid]; if (!box) continue;
      const hasAgree=data.agreeCount>0, hasDisagree=data.disagreeCount>0;
      const decX=box.x+box.width+DEC_RIGHT_GAP+EDGE_HINT_W+DEC_GAP;
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
    const decorationOwners=new Set<string>();
    for (const v of Object.values(decorationRects)) {
      if(!input.visibleDecorationIds||input.visibleDecorationIds.has(v.messageId))globalForbiddenRects.push(v.rect);
      if(!decorationOwners.has(v.messageId)){
        decorationOwners.add(v.messageId);
        globalForbiddenRects.push({x:v.rect.x-EDGE_HINT_W-DEC_GAP,y:v.rect.y,width:EDGE_HINT_W,height:EDGE_HINT_W});
      }
    }

    // Tag geometry is assigned after frame bounds and annotation controls are known.
    const newTagDecorationsByMsg: Record<string,{label:string;relMsgIds:string[];rect:Rect;relAgreeCount:number;relDisagreeCount:number;relAgreeMsgIds:string[];relDisagreeMsgIds:string[]}[]> = {};

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
        if (!isTraceWindow && !hasActiveDisplayEffect(e, msgMap)) continue;
        if (!filterFn(e.relationType)) continue;
        if (e.to.selection.kind !== "whole" && e.to.selection.kind !== "text") continue;
        const arr = frameEdgesByRelMsg.get(e.relationMessageId) ?? [];
        arr.push(e);
        frameEdgesByRelMsg.set(e.relationMessageId, arr);
      }
      for (const [relMsgId, frameEdges] of frameEdgesByRelMsg) {
        if (frameEdges.length === 0) continue;
        const frameType = frameEdges[0].relationType.toLowerCase();
        if (!isTraceWindow && (frameType === 'classify' || frameType === 'summary')) continue;
        // Skip frames replaced by a non-blank correction (source is a real new relation).
        // Blank-corrected frames (CORRECT with anon source / secondary="none") are included
        // but marked so their SVG border is hidden while the correction badge remains visible.
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
          const targetBox = finalFrameRects[e.to.messageId] ?? relationTargetBounds?.rect ?? endpointBoxForNormal(e.to.messageId)?.box ?? layout[e.to.messageId];
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
    const renderedGroupIds = new Set(newGroupFrames.map(frame => frame.relMsgId));
    const renderedArrangeIds = new Set(newArrangeFrames.map(frame => frame.relMsgId));
    for (const [relMsgId, rect] of Object.entries(finalFrameRects)) {
      const relType = msgMap.get(relMsgId)?.relationType;
      const base = { targetId: relMsgId, sourceId: `anon:${relMsgId}`, relMsgId,
        isBlankCorrected: anonCorrectedRelMsgIds.has(relMsgId), rect,
        relAgreeCount: 0, relDisagreeCount: 0, relAgreeMsgIds: [], relDisagreeMsgIds: [] };
      if (relType === 'arrange' && !renderedArrangeIds.has(relMsgId)) newArrangeFrames.push(base);
      if (relType && ['merge', 'classify', 'summary'].includes(relType) && !renderedGroupIds.has(relMsgId)) {
        const spec = getPresentationSpec(relType);
        newGroupFrames.push({ ...base, relType, relKind: spec.kind, relLabel: spec.label, relColor: spec.color });
      }
    }
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
    const relDecByRelMsgId = computeTransitiveRelDecStats(edges, messages, input.excludedStanceEdges);
    // Propagate counts and IDs to tag groups, arrange frames, and group frames
    for (const sf of [...newArrangeFrames, ...newGroupFrames]) {
      const dec=relDecByRelMsgId.get(sf.relMsgId);
      if (dec) {
        sf.relAgreeCount+=dec.agreeCount; sf.relDisagreeCount+=dec.disagreeCount;
        sf.relAgreeMsgIds.push(...dec.agreeRelMsgIds); sf.relDisagreeMsgIds.push(...dec.disagreeRelMsgIds);
      }
    }
    const relDecByRelMsgState = (relDecByRelMsgId);
    const tagDecorationsByMsg = (newTagDecorationsByMsg);
    const arrangeFrames = (newArrangeFrames);
    const groupFrames = (newGroupFrames);

    // Collect TAG relations targeting relation messages (for display next to edge labels / frames)
    const newTagsByRelMsg = new Map<string,Array<{label:string;relMsgId:string}>>();
    for (const e of edges) {
      if (e.relationType!=="tag") continue;
      if (e.to.selection.kind!=="whole") continue;
      const toId=e.to.messageId;
      if (msgMap.get(toId)?.kind !== "relation") continue;
      const label=isValidTagLabel(e.relationLabel)
        ? e.relationLabel.slice(0,TAG_MAX_LABEL_CHARS)
        : "标注";
      const arr=newTagsByRelMsg.get(toId)??[];
      arr.push({label,relMsgId:e.relationMessageId});
      newTagsByRelMsg.set(toId,arr);
    }
    const tagsByRelMsgState = (newTagsByRelMsg);

    // Build lookup maps for visual positions of relation messages (used in edge targeting)
    const frameByRelMsgId = new Map<string,Rect>();
    for (const sf of newArrangeFrames) frameByRelMsgId.set(sf.relMsgId, sf.rect);

    const groupFrameByRelMsgId = new Map<string,Rect>();
    for (const gf of newGroupFrames) groupFrameByRelMsgId.set(gf.relMsgId, gf.rect);

    const annotationToggleRects: Record<string,Rect> = {};
    const annotationPlacement = (mid:string, box:Rect) => {
      const votes=relDecByRelMsgId.get(mid)??decorationsByMsg[mid];
      const hasVotes=!!votes&&(votes.agreeCount>0||votes.disagreeCount>0);
      const placement=getAnnotationPlacement(box,hasVotes?getDecorationColumnWidth(!input.visibleDecorationIds||input.visibleDecorationIds.has(mid)):0);
      if(!annotationToggleRects[mid])globalForbiddenRects.push(placement.toggle);
      annotationToggleRects[mid]=placement.toggle;
      return placement;
    };
    for(const edge of edges){
      if(edge.relationType!=='tag'||edge.to.selection.kind!=='whole')continue;
      const mid=edge.to.messageId;
      const box=frameByRelMsgId.get(mid)??groupFrameByRelMsgId.get(mid)??endpointBoxForNormal(mid)?.box??layout[mid];
      if(!box)continue;
      const placement=annotationPlacement(mid,box);
      const label=isValidTagLabel(edge.relationLabel)?edge.relationLabel.slice(0,TAG_MAX_LABEL_CHARS):'标注';
      const groups=newTagDecorationsByMsg[mid]??(newTagDecorationsByMsg[mid]=[]);
      let group=groups.find(item=>item.label===label);
      if(!group){
        group={label,relMsgIds:[],rect:{x:placement.x,y:placement.y+groups.length*(TAG_H+TAG_V_GAP),width:Math.max(TAG_MIN_W,label.length*8+8+28),height:TAG_H},
          relAgreeCount:0,relDisagreeCount:0,relAgreeMsgIds:[],relDisagreeMsgIds:[]};
        groups.push(group);
        if(!input.visibleAnnotationIds||input.visibleAnnotationIds.has(mid))globalForbiddenRects.push(group.rect);
      }
      if(group.relMsgIds.includes(edge.relationMessageId))continue;
      group.relMsgIds.push(edge.relationMessageId);
      const votes=relDecByRelMsgId.get(edge.relationMessageId);
      if(votes){
        group.relAgreeCount+=votes.agreeCount;group.relDisagreeCount+=votes.disagreeCount;
        group.relAgreeMsgIds.push(...votes.agreeRelMsgIds);group.relDisagreeMsgIds.push(...votes.disagreeRelMsgIds);
      }
    }

    // Annotation badges share a separate foldable group at the upper right.
    // Positioned after frameByRelMsgId / groupFrameByRelMsgId so frame targets resolve correctly.
    const BADGE_W = 56, BADGE_H = 18;
    // Aggregate RECOMMEND/ARCHIVE badges by (target message, relationType) —
    // all subTypes of the same type share one badge with a unified send count.
    const inlineBadgeGroups = new Map<string, { relMsgIds: string[]; relType: string; reason?:string; subDetails: Array<{subType:string;customLabel?:string;count:number}> }>();
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
      const box = frameRect ?? ep?.box ?? layout[mid];
      if (!box) continue;
      const rt = e.relationType.toUpperCase();
      const relMsg = msgMap.get(e.relationMessageId);
      const rp = relMsg?.relationPayload;
      const reason = rt === 'ATTENTION' || rt === 'BLOCK' ? rp?.subType : undefined;
      const groupKey = `${mid}|${rt}|${reason ?? ''}`;
      let group = inlineBadgeGroups.get(groupKey);
      if (!group) {
        group = { relMsgIds: [], relType: rt, reason, subDetails: [] };
        inlineBadgeGroups.set(groupKey, group);
      }
      const sc = ((rp as Record<string,unknown> | undefined)?.repetitionCount as number) ?? 1;
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
      // Sum total repetitionCount from all subDetails + any non-subType sends
      let totalCount = 0;
      for (const d of group.subDetails) { totalCount += d.count; }
      // Non-subType sends: each relation without subType contributes its repetitionCount
      for (const rmId of group.relMsgIds) {
        const rm = msgMap.get(rmId);
        const rp = (rm as any)?.relationPayload as Record<string,unknown> | undefined;
        if (!rp?.subType) {
          totalCount += (rp?.repetitionCount as number) ?? 1;
        }
      }
      if (totalCount <= 0) continue;
      let badgeLabel = spec.label + (group.reason === 'YES' ? '－是' : group.reason === 'NO' ? '－否' : '');
      if (totalCount >= 2) badgeLabel = `${badgeLabel} ×${totalCount}`;
      const ep = endpointBoxForNormal(mid), frameRect = frameByRelMsgId.get(mid) ?? groupFrameByRelMsgId.get(mid);
      const box = frameRect ?? ep?.box ?? layout[mid];
      if (!box) continue;
      const arr = newInlineBadgesByMsg.get(mid) ?? [];
      const hasVotes = group.relMsgIds.some(id => {
        const votes = relDecByRelMsgState.get(id);
        return votes && (votes.agreeCount > 0 || votes.disagreeCount > 0);
      });
      const badgeWidth = Math.max(BADGE_W,badgeLabel.length*8+8) + (hasVotes ? EDGE_HINT_W + 2 : 0);
      const placement=annotationPlacement(mid,box);
      const badgeX = placement.x;
      const tags = newTagDecorationsByMsg[mid] ?? [];
      const tagBottom = Math.max(placement.y,
        ...tags.map(tag => tag.rect.y + tag.rect.height + TAG_V_GAP));
      // Stack downwards beside the card so even the topmost card stays reachable.
      const badgeY = tagBottom + arr.length * (BADGE_H + DEC_GAP);
      arr.push({
        relMsgId: group.relMsgIds[0],
        relMsgIds: group.relMsgIds,
        relKind: spec.kind,
        relLabel: badgeLabel,
        relColor: (rt === 'ATTENTION' && group.reason === 'YES') || (rt === 'BLOCK' && group.reason === 'NO')
          ? getPresentationSpec('RECOMMEND').color : spec.color,
        rect: { x: badgeX, y: badgeY, width: badgeWidth, height: BADGE_H },
        subDetails: group.subDetails.length > 0 ? group.subDetails : undefined,
      });
      newInlineBadgesByMsg.set(mid, arr);
      if (!input.visibleAnnotationIds || input.visibleAnnotationIds.has(mid)) globalForbiddenRects.push(arr[arr.length - 1].rect);
    }
    const inlineBadgesByMsg = (newInlineBadgesByMsg);

    const positionedEdges = input.skipRouting ? [] : routeGraphEdges({ newTagDecorationsByMsg, annotationToggleRects, edgesByRelMsg, endpointBoxForNormal, layout, relationCardMsgIds, frameByRelMsgId, groupFrameByRelMsgId, msgMap, labelBboxes, relDecByRelMsgId, decorationRects, edges, comparisonSuppressedRelIds, colOf, correctedEdgeIdsByRelMsg, normalSet, contentRefs, toCanvasRect, getMessageRects, sampleQuad, penScore, globalForbiddenRects, visibleDecorationIds:input.visibleDecorationIds, visibleAnnotationIds:input.visibleAnnotationIds,
      getCachedFragment(messageId, key) {
        const rect = input.anchorCache?.get(messageId)?.fragments[key], box = layout[messageId];
        return rect && box ? moveAnchor(rect, box) : undefined;
      },
    });
    const decorationRectsState = (decorationRects);
    const decorationsByMsgState = (decorationsByMsg);

    return { annotationToggleRects, positionedEdges, decorationRectsState, decorationsByMsgState, tagDecorationsByMsg, arrangeFrames, groupFrames, inlineBadgesByMsg, relDecByRelMsgState, tagsByRelMsgState };
}
