import type { Rect } from './layout';
export type Point = { x: number; y: number };
export type LabelSeed = { drawId: string; text: string; p0: Point; p1: Point; p2: Point; rightWidth?: number; rightHeight?: number };

export function quadAt(p0: Point, p1: Point, p2: Point, t: number): Point {
  const u = 1-t;
  return { x: u*u*p0.x+2*u*t*p1.x+t*t*p2.x, y: u*u*p0.y+2*u*t*p1.y+t*t*p2.y };
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
  const w = Math.max(30, text.length * 6.2) + 10, h = 14;
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
  const ts = [0.35,0.42,0.5,0.58,0.65,0.28,0.72,0.2,0.8];
  for (const s of sorted) {
    const footprint=(x:number,y:number):Rect=>{
      const label=labelRectApprox(x,y,s.text);
      const height=Math.max(label.height,s.rightHeight??0);
      return {...label,y:y-height/2,width:label.width+(s.rightWidth??0),height};
    };
    let chosen: {x:number;y:number}|null = null;
    for (const t of ts) {
      const p=quadAt(s.p0,s.p1,s.p2,t), r=footprint(p.x,p.y);
      let ok=r.y>=0;
      for (const tr of [...forbiddenRects,...placed]) if (rectsIntersect(r,tr)) { ok=false; break; }
      if (ok) { chosen={x:p.x,y:p.y}; placed.push(r); break; }
    }
    if (!chosen) {
      const p=quadAt(s.p0,s.p1,s.p2,0.5); const x=p.x; let y=p.y, r=footprint(x,y);
      for (let iter=0;iter<200;iter++) {
        let collision=r.y<0;
        for (const tr of [...forbiddenRects,...placed]) if (rectsIntersect(r,tr)) { collision=true; break; }
        if (!collision) break;
        y=p.y+Math.ceil(iter/2)*16*(iter%2===0?1:-1); r=footprint(x,y);
      }
      chosen={x,y}; placed.push(r);
    }
    placements[s.drawId]=chosen;
  }
  return placements;
}
