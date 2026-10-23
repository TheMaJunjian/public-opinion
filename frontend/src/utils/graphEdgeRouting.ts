import type { MutableRefObject } from 'react';
import type { DemoMessage, DemoEdge } from './modelBridge';
import { isContentKind } from './modelBridge';
import { getPresentationSpec } from '../types';
import { selectionIsText, relationTypeName } from './graphTextSelection';
import type { LayoutBox, Rect } from './layout';
import type { Box } from './frameLayout';
import type { Point, LabelSeed } from './graphEdgeGeometry';
import { getEdgeDecorationLeft, getDecorationColumnWidth, DEC_W, DEC_H, DEC_GAP, DEC_RIGHT_GAP, DEC_RIGHT_TOP, EDGE_HINT_W, TAG_H, TAG_MIN_W, TAG_V_GAP, TAG_MAX_LABEL_CHARS, MAX_RELATION_NESTING_DEPTH } from './graphPresentationGeometry';
import { quadAt, rayRectIntersectionFirst, samplePerimeterCandidates, computeLabelPlacementsAlongCurve } from './graphEdgeGeometry';
import type { PositionedEdge } from './graphOverlays';

export interface GraphRoutingInput {
  visibleDecorationIds?: ReadonlySet<string>;
  getCachedFragment?: (messageId: string, key: string) => Rect | undefined;
  newTagDecorationsByMsg: Record<string, { label: string; relMsgIds: string[]; rect: Rect; relAgreeCount: number; relDisagreeCount: number; relAgreeMsgIds: string[]; relDisagreeMsgIds: string[]; }[]>;
  edgesByRelMsg: Map<string, DemoEdge[]>;
  endpointBoxForNormal: (id: string) => { box: LayoutBox; col: number; } | null;
  layout: Record<string, Box>;
  relationCardMsgIds: Set<string>;
  frameByRelMsgId: Map<string, Rect>;
  groupFrameByRelMsgId: Map<string, Rect>;
  msgMap: Map<string, DemoMessage>;
  labelBboxes: Record<string, Rect>;
  relDecByRelMsgId: Map<string, { agreeCount: number; disagreeCount: number; agreeRelMsgIds: string[]; disagreeRelMsgIds: string[]; }>;
  decorationRects: Record<string, { kind: "agree" | "disagree"; rect: Rect; iconRect: Rect; bodyRect: Rect; key: string; messageId: string; }>;
  edges: DemoEdge[];
  comparisonSuppressedRelIds: Set<string>;
  colOf: { [x: string]: number; };
  correctedEdgeIdsByRelMsg: Map<string, Set<string>>;
  normalSet: Set<string>;
  contentRefs: MutableRefObject<Record<string, HTMLDivElement | null>>;
  toCanvasRect: (rect: DOMRect) => Rect;
  getMessageRects: (messageId: string) => Rect[];
  sampleQuad: (p0: Point, p1: Point, p2: Point, n?: number) => Point[];
  penScore: (samples: Point[], rects: Rect[]) => number;
  globalForbiddenRects: Rect[];
}

/** Route edges between rendered card, fragment, frame and relation anchors. */
export function routeGraphEdges(input: GraphRoutingInput): PositionedEdge[] {
  const { newTagDecorationsByMsg, edgesByRelMsg, endpointBoxForNormal, layout, relationCardMsgIds, frameByRelMsgId, groupFrameByRelMsgId, msgMap, labelBboxes, relDecByRelMsgId, decorationRects, edges, comparisonSuppressedRelIds, colOf, correctedEdgeIdsByRelMsg, normalSet, contentRefs, toCanvasRect, getMessageRects, sampleQuad, penScore, globalForbiddenRects } = input;
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
        // CLASSIFY relations may have no target edges yet, but their classification cards are still visible.
        const relCard = endpointBoxForNormal(relId)?.box ?? layout[relId];
        return relCard ?? null;
      }
      // Readable relation messages (for example DELEGATION) are rendered as
      // cards. An edge targeting such a relation must end at that card rather
      // than at one of the relation's own target labels.
      if (relationCardMsgIds.has(relId)) {
        const relCard = endpointBoxForNormal(relId)?.box ?? layout[relId];
        if (relCard) return relCard;
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
      // CLASSIFY / SUMMARY are edge-label kind but rendered as classification cards in normals.
      // When another relation (e.g. REFERENCE) targets them, use their card position.
      if (relType === 'classify' || relType === 'summary') {
        const relCard = endpointBoxForNormal(relId)?.box ?? layout[relId];
        if (relCard) return relCard;
      }
      if (relType === "tag") {
        const tagInfo = tagBadgeByRelMsgId.get(relId);
        if(tagInfo&&input.visibleDecorationIds&&!input.visibleDecorationIds.has(tagInfo.mid)){
          const box=endpointBoxForNormal(tagInfo.mid)?.box??layout[tagInfo.mid];
          return {x:tagInfo.rect.x-EDGE_HINT_W-DEC_GAP,y:box?box.y+DEC_RIGHT_TOP:tagInfo.rect.y,width:EDGE_HINT_W,height:EDGE_HINT_W};
        }
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
              const left=getEdgeDecorationLeft(bb,!normalSet.has(targetMid));
              if(input.visibleDecorationIds&&!input.visibleDecorationIds.has(targetMid))
                return {x:left,y:bb.y+(bb.height-EDGE_HINT_W)/2,width:EDGE_HINT_W,height:EDGE_HINT_W};
              const votes=relDecByRelMsgId.get(targetMid);
              const hasAgree=(votes?.agreeCount??0)>0;
              const count=(hasAgree?1:0)+((votes?.disagreeCount??0)>0?1:0);
              const top=bb.y+bb.height/2-(count*DEC_H+Math.max(0,count-1)*DEC_GAP)/2;
              return {x:left+EDGE_HINT_W+DEC_GAP,y:top+(relType==='disagree'&&hasAgree?DEC_H+DEC_GAP:0),width:DEC_W,height:DEC_H};
            }
          }
          // No label bbox available yet (first render) — fall back to recursive approximation
          return getRelVisualBox(targetMid, depth + 1);
        }
        // Point to the decoration badge rect so the arrow targets the badge, not the whole card
        const decKey = `${targetMid}::${relType}`;
        const decRect = decorationRects[decKey];
        if(decRect&&input.visibleDecorationIds&&!input.visibleDecorationIds.has(targetMid)){
          const first=decorationRects[`${targetMid}::agree`]??decRect;
          return {x:first.rect.x-EDGE_HINT_W-DEC_GAP,y:first.rect.y,width:EDGE_HINT_W,height:EDGE_HINT_W};
        }
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
      return `${names.length > 0 ? names.join('、') : '与会者'}：通知`;
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

      if ((e.relationType==="annotation"||e.relationType==="reference") && selectionIsText(e.to.selection)) {
        const container=contentRefs.current[toId];
        const start=e.to.selection.start, end=start+e.to.selection.len;
        const key = `${e.relationType}::${start}:${end}`;
        const span=container?.querySelector(`[data-rel-anchor="${key}"]`) as HTMLSpanElement|null;
        const cached = input.getCachedFragment?.(toId, key);
        if (cached || span) {
          const r = cached ?? toCanvasRect(span!.getBoundingClientRect());
          fragRectCanvas = new DOMRect(r.x, r.y, r.width, r.height);
        }
      }

      rawEdges.push({
        drawId:e.id,edge:e,fromAuthor,fromBox,toBox:toEp.box,fromCol,toCol:toEp.col,
        fragRectCanvas,edgeLabelText:labelText(e,fromAuthor),expandedToEdgeId:null,
        start:{x:0,y:0},ctrl:{x:0,y:0},end:{x:0,y:0},
      });
    }

    const decoratedLabels=new Set<string>();
    const relationTags=new Map<string,Map<string,number>>();
    for(const edge of edges){
      if(edge.relationType!=='tag'||edge.to.selection.kind!=='whole')continue;
      const label=(edge.relationLabel&&edge.relationLabel!=='tag'?edge.relationLabel:msgMap.get(edge.from.messageId)?.content??'标注').slice(0,TAG_MAX_LABEL_CHARS);
      const groups=relationTags.get(edge.to.messageId)??new Map<string,number>();
      groups.set(label,(groups.get(label)??0)+1);relationTags.set(edge.to.messageId,groups);
    }
    const correctionVotesByReplacement=new Map<string,string[]>();
    const voteBadgeCount=(relId:string)=>{
      const votes=relDecByRelMsgId.get(relId);
      return ((votes?.agreeCount??0)>0?1:0)+((votes?.disagreeCount??0)>0?1:0);
    };
    for(const edge of edges){
      if(edge.relationType!=='correct'||edge.proposalOnly
        ||msgMap.get(edge.from.messageId)?.kind!=='relation'||msgMap.get(edge.to.messageId)?.kind!=='relation')continue;
      const id=edge.from.messageId;
      if(voteBadgeCount(edge.relationMessageId)>0)
        correctionVotesByReplacement.set(id,[...(correctionVotesByReplacement.get(id)??[]),edge.relationMessageId]);
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
      let rightWidth=0,rightHeight=EDGE_HINT_W;
      const relId=edge.relationMessageId;
      if(!decoratedLabels.has(relId)){
        decoratedLabels.add(relId);
        const hasHint=!normalSet.has(relId);
        const owners=[...(['annotation','reference','reply'].includes(edge.relationType)&&(voteBadgeCount(relId)>0||relationTags.has(relId))?[relId]:[]),
          ...(correctionVotesByReplacement.get(relId)??[])];
        rightWidth=hasHint?DEC_RIGHT_GAP+EDGE_HINT_W:0;
        for(const owner of owners){
          const expanded=!input.visibleDecorationIds||input.visibleDecorationIds.has(owner);
          const count=voteBadgeCount(owner);
          rightWidth+=(rightWidth>0?DEC_GAP:DEC_RIGHT_GAP)+getDecorationColumnWidth(expanded);
          if(expanded)rightHeight=Math.max(rightHeight,count*DEC_H+Math.max(0,count-1)*DEC_GAP);
        }
        const tags=relationTags.get(relId);
        if(tags?.size&&(!input.visibleDecorationIds||input.visibleDecorationIds.has(relId))){
          const widths=[...tags].map(([label,count])=>Math.max(TAG_MIN_W,(count>1?`${label}（${count}人）`:label).length*8+36));
          rightWidth=Math.max(rightWidth,DEC_RIGHT_GAP+(hasHint?EDGE_HINT_W+DEC_GAP:0)+EDGE_HINT_W+DEC_GAP+Math.max(...widths));
          const tagHeight=tags.size*TAG_H+(tags.size-1)*TAG_V_GAP;
          rightHeight=voteBadgeCount(relId)>0||owners.length>1
            ? rightHeight+2*(DEC_GAP+tagHeight) : Math.max(rightHeight,tagHeight);
        }
      }
      labelSeeds.push({drawId:pe.drawId,text:pe.edgeLabelText,p0:pe.start,p1:pe.ctrl,p2:pe.end,rightWidth,rightHeight});
    }

    const placements=computeLabelPlacementsAlongCurve({seeds:labelSeeds,forbiddenRects:globalForbiddenRects});
    const positionedEdges = (rawEdges.map(pe => ({ ...pe, labelX:(placements[pe.drawId]??quadAt(pe.start,pe.ctrl,pe.end,0.5)).x, labelY:(placements[pe.drawId]??quadAt(pe.start,pe.ctrl,pe.end,0.5)).y })));

  return positionedEdges;
}
