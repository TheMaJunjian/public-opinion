import type { Rect } from './layout';
export type Point = { x: number; y: number };
export type LabelSeed = { drawId: string; text: string; p0: Point; p1: Point; p2: Point;
  measuredWidth?: number; measuredHeight?: number; leftWidth?: number; rightWidth?: number; rightHeight?: number;
  labelPlacement?: 'edge' };
const labelCurveTimes = [0.35,0.42,0.5,0.58,0.65,0.28,0.72,0.2,0.8];
export const EDGE_LABEL_CLEARANCE = 6;

/** A gentle arc, with facing-side routes kept inside their column gutter. */
export function curvedEdgeControl(start:Point,end:Point,constrainToGutter=false):Point {
  const dx=end.x-start.x,dy=end.y-start.y,length=Math.hypot(dx,dy)||1;
  const nx=-dy/length,ny=dx/length;
  let offset=Math.min(60,length*0.3);
  if(constrainToGutter&&Math.abs(nx)>1e-8)offset=Math.min(offset,Math.abs(dx)*0.4/Math.abs(nx));
  return {x:(start.x+end.x)/2+nx*offset,y:(start.y+end.y)/2+ny*offset};
}

export function quadAt(p0: Point, p1: Point, p2: Point, t: number): Point {
  const u = 1-t;
  return { x: u*u*p0.x+2*u*t*p1.x+t*t*p2.x, y: u*u*p0.y+2*u*t*p1.y+t*t*p2.y };
}

/** Bend a quadratic through an attachment without moving either endpoint. */
function controlPointThroughPoint(start: Point, control: Point, end: Point, label: Point): Point {
  for (const t of labelCurveTimes) {
    const point = quadAt(start, control, end, t);
    if (Math.hypot(point.x-label.x,point.y-label.y)<1e-6) return control;
  }
  const dx=end.x-start.x,dy=end.y-start.y;
  const tx=dx?(label.x-start.x)/dx:NaN,ty=dy?(label.y-start.y)/dy:NaN;
  // Horizontal facing-side routes stay inside their existing column gutter.
  // Vertical routes use the same rule along their source-to-target direction.
  const t=Math.max(0.1,Math.min(0.9,tx>0&&tx<1?tx:ty>0&&ty<1?ty:0.5)),u=1-t,weight=2*u*t;
  return {x:(label.x-u*u*start.x-t*t*end.x)/weight,y:(label.y-u*u*start.y-t*t*end.y)/weight};
}

function labelHalfSize(seed: LabelSeed) {
  return {x:(seed.measuredWidth ?? Math.max(30,seed.text.length*6.2))/2+6+EDGE_LABEL_CLEARANCE,
    y:(seed.measuredHeight ?? 14)/2+1+EDGE_LABEL_CLEARANCE};
}

/** Keep tags beside the curve without covering it. */
function labelEdgeOffset(seed: LabelSeed, t: number): Point {
  const {p0,p1,p2}=seed,size=labelHalfSize(seed);
  const dx=(1-t)*(p1.x-p0.x)+t*(p2.x-p1.x),dy=(1-t)*(p1.y-p0.y)+t*(p2.y-p1.y);
  let nx=-dy,ny=dx;
  if(Math.abs(nx)+Math.abs(ny)<1e-8){nx=0;ny=1;}
  if(ny<0||ny===0&&nx<0){nx=-nx;ny=-ny;}
  if(nx*(p0.x-2*p1.x+p2.x)+ny*(p0.y-2*p1.y+p2.y)>1e-8){nx=-nx;ny=-ny;}
  return {x:Math.abs(nx)<1e-8?0:Math.sign(nx)*size.x,y:Math.abs(ny)<1e-8?0:Math.sign(ny)*size.y};
}

function labelPositionOnCurve(seed: LabelSeed,t:number): Point {
  const anchor=quadAt(seed.p0,seed.p1,seed.p2,t),offset=seed.labelPlacement==='edge'?labelEdgeOffset(seed,t):{x:0,y:0};
  return {x:anchor.x+offset.x,y:anchor.y+offset.y};
}

function curveEntersRect(start:Point,ctrl:Point,end:Point,rect:Rect):boolean {
  const bounds={x:Math.min(start.x,ctrl.x,end.x),y:Math.min(start.y,ctrl.y,end.y),
    width:Math.max(start.x,ctrl.x,end.x)-Math.min(start.x,ctrl.x,end.x),height:Math.max(start.y,ctrl.y,end.y)-Math.min(start.y,ctrl.y,end.y)};
  if(bounds.x>=rect.x+rect.width||bounds.x+bounds.width<=rect.x||bounds.y>=rect.y+rect.height||bounds.y+bounds.height<=rect.y)return false;
  const roots=[0,1];
  for(const axis of ['x','y'] as const)for(const boundary of [rect[axis],rect[axis]+(axis==='x'?rect.width:rect.height)]){
    const a=start[axis]-2*ctrl[axis]+end[axis],b=2*(ctrl[axis]-start[axis]),c=start[axis]-boundary;
    if(Math.abs(a)<1e-10){if(Math.abs(b)>1e-10)roots.push(-c/b);continue;}
    const d=b*b-4*a*c;if(d<0)continue;
    roots.push((-b-Math.sqrt(d))/(2*a),(-b+Math.sqrt(d))/(2*a));
  }
  const times=roots.filter(t=>t>=0&&t<=1).sort((a,b)=>a-b);
  for(let i=1;i<times.length;i++){
    const p=quadAt(start,ctrl,end,(times[i-1]+times[i])/2);
    if(p.x>rect.x+1e-6&&p.x<rect.x+rect.width-1e-6&&p.y>rect.y+1e-6&&p.y<rect.y+rect.height-1e-6)return true;
  }
  return false;
}

/** Preserve an unobstructed curve. A collision-displaced tag also adjusts its
 * curve so the tag remains nearby, with a clear gap around its border. */
export function attachLabelToCurve(seed:LabelSeed,label:Point,forbiddenRects:readonly Rect[]=[]):{ctrl:Point;anchor:Point} {
  for(const t of labelCurveTimes){
    const candidate=labelPositionOnCurve(seed,t);
    if(Math.hypot(candidate.x-label.x,candidate.y-label.y)<1e-6)return {ctrl:seed.p1,anchor:quadAt(seed.p0,seed.p1,seed.p2,t)};
  }
  const size=labelHalfSize(seed),preferred=labelEdgeOffset(seed,0.5);
  const plate={x:label.x-size.x,y:label.y-size.y,width:size.x*2,height:size.y*2};
  const offsets=[preferred,{x:0,y:size.y},{x:0,y:-size.y},{x:size.x,y:0},{x:-size.x,y:0},
    ...[-1,1].flatMap(x=>[-1,1].map(y=>({x:x*size.x,y:y*size.y})))];
  let best:{ctrl:Point;anchor:Point;score:number}|undefined;
  for(const offset of offsets){
    const anchor={x:label.x-offset.x,y:label.y-offset.y},dx=seed.p2.x-seed.p0.x,dy=seed.p2.y-seed.p0.y;
    const tx=dx?(anchor.x-seed.p0.x)/dx:NaN,ty=dy?(anchor.y-seed.p0.y)/dy:NaN;
    const times=[...new Set([tx,ty,0.5,...labelCurveTimes])].filter(t=>t>=0.1&&t<=0.9);
    for(const t of times){
      const u=1-t,w=2*u*t,ctrl={x:(anchor.x-u*u*seed.p0.x-t*t*seed.p2.x)/w,y:(anchor.y-u*u*seed.p0.y-t*t*seed.p2.y)/w};
      const tangent={x:u*(ctrl.x-seed.p0.x)+t*(seed.p2.x-ctrl.x),y:u*(ctrl.y-seed.p0.y)+t*(seed.p2.y-ctrl.y)};
      let nx=-tangent.y,ny=tangent.x;
      const length=Math.hypot(nx,ny);if(length<1e-8)continue;
      nx/=length;ny/=length;if(nx*offset.x+ny*offset.y<0){nx=-nx;ny=-ny;}
      const support=nx*offset.x+ny*offset.y-Math.abs(nx)*size.x-Math.abs(ny)*size.y;
      if(support < -1e-6 || curveEntersRect(seed.p0,ctrl,seed.p2,plate))continue;
      const outside=Math.max(0,Math.min(seed.p0.x,seed.p2.x)-ctrl.x,ctrl.x-Math.max(seed.p0.x,seed.p2.x));
      const crossings=forbiddenRects.filter(rect=>curveEntersRect(seed.p0,ctrl,seed.p2,rect)).length;
      const score=crossings*1e9+(ctrl.x-seed.p1.x)**2+(ctrl.y-seed.p1.y)**2+outside**2*1000;
      if(!best||score<best.score)best={ctrl,anchor,score};
    }
  }
  if(best)return {ctrl:best.ctrl,anchor:best.anchor};
  const anchor={x:label.x-preferred.x,y:label.y-preferred.y};
  return {ctrl:controlPointThroughPoint(seed.p0,seed.p1,seed.p2,anchor),anchor};
}

export function rayRectIntersectionFirst(ox: number, oy: number, dx: number, dy: number, box: Rect, eps=1e-9): Point | null {
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

export function samplePerimeterCandidates(box: Rect): Point[] {
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

export function rectsIntersect(a: Rect, b: Rect) {
  return !(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y);
}

export function labelRectApprox(x: number, y: number, text: string) {
  const w = Math.max(30, text.length * 6.2) + 18, h = 22;
  return { x:x-w/2, y:y-h/2, width:w, height:h };
}

export function computeLabelPlacementsAlongCurve(params: { seeds: LabelSeed[]; forbiddenRects: Rect[] }) {
  const { seeds, forbiddenRects } = params;
  const sorted = [...seeds].sort((a,b) => {
    const pa=quadAt(a.p0,a.p1,a.p2,0.5), pb=quadAt(b.p0,b.p1,b.p2,0.5);
    return pa.y-pb.y || pa.x-pb.x || a.drawId.localeCompare(b.drawId);
  });
  const placements: Record<string, {x:number;y:number}> = {};
  const placed: Rect[] = [];
  for (const s of sorted) {
    const size = (value: number | undefined) => Number.isFinite(value) && value! > 0 ? value! : 0;
    const obstacles = [...forbiddenRects, ...placed];
    const footprint=(x:number,y:number):Rect=>{
      const label=labelRectApprox(x,y,s.text);
      // The measured SVG text is surrounded by the actual HTML hit area's
      // 8px horizontal / 6px vertical padding. Retain conservative first-paint estimates.
      const width=Math.max(label.width,size(s.measuredWidth)+16),height=Math.max(label.height,size(s.measuredHeight)+12,size(s.rightHeight));
      return {x:x-width/2-size(s.leftWidth),y:y-height/2,width:width+size(s.leftWidth)+size(s.rightWidth),height};
    };
    const free = (rect: Rect) => rect.x >= 0 && rect.y >= 0 && !obstacles.some(obstacle => rectsIntersect(rect, obstacle));
    let chosen: {x:number;y:number}|null = null;
    for (const t of labelCurveTimes) {
      const p=labelPositionOnCurve(s,t), r=footprint(p.x,p.y);
      if (free(r)) { chosen={x:p.x,y:p.y}; placed.push(r); break; }
    }
    if (!chosen) {
      const p=labelPositionOnCurve(s,0.5), initial=footprint(p.x,p.y);
      const left=p.x-initial.x,right=initial.x+initial.width-p.x, nearby:number[]=[];
      let outerRight=0;
      for (const obstacle of obstacles) {
        outerRight=Math.max(outerRight,obstacle.x+obstacle.width);
        if (rectsIntersect(initial,obstacle)) nearby.push(obstacle.x-right-8,obstacle.x+obstacle.width+left+8);
      }
      nearby.sort((a,b)=>Math.abs(a-p.x)-Math.abs(b-p.x)||a-b);
      const escapeX=outerRight+left+8;
      // At most ten horizontal lanes. Merge their distance-ordered vertical
      // searches, stopping at the first clear candidate rather than scoring all combinations.
      const lanes=[...new Set([p.x,p.x-32,p.x+32,...nearby.slice(0,6),escapeX])]
        .filter(x=>x-left>=0).map(x=>({x,step:0}));
      const dy=(step:number)=>step===0?0:Math.ceil(step/2)*16*(step%2?-1:1);
      for (;;) {
        let lane:typeof lanes[number]|undefined,distance=Infinity;
        for (const candidate of lanes) {
          if (candidate.step>200) continue;
          const score=(candidate.x-p.x)**2+dy(candidate.step)**2;
          if (score<distance) { lane=candidate;distance=score; }
        }
        if (!lane) break;
        const point={x:lane.x,y:p.y+dy(lane.step++)},rect=footprint(point.x,point.y);
        if (free(rect)) { chosen=point;break; }
      }
      // Even a label starting above the canvas has a finite, clear fallback.
      chosen??={x:escapeX,y:Math.max(p.y,initial.height/2)};
      placed.push(footprint(chosen.x,chosen.y));
    }
    placements[s.drawId]=chosen;
  }
  return placements;
}
