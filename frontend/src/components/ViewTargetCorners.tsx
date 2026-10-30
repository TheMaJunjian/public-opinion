/** Whole-frame corners and navigation symbols share the same visual boundary. */
export default function ViewTargetCorners({x,y,width,height}:{x:number;y:number;width:number;height:number}) {
  const left=x-4,top=y-4,right=x+width+4,bottom=y+height+4;
  const length=Math.min(12,(width+8)/3,(height+8)/3);
  const centers=[[x+width/2,y-5],[x+width/2,y+height+5],[x-5,y+height/2],[x+width+5,y+height/2]];
  return <><path className="view-target-corners" aria-hidden="true" d={[
    `M ${left+length} ${top} H ${left} V ${top+length}`,
    `M ${right-length} ${top} H ${right} V ${top+length}`,
    `M ${right} ${bottom-length} V ${bottom} H ${right-length}`,
    `M ${left+length} ${bottom} H ${left} V ${bottom-length}`,
  ].join(' ')}/>{(['current','previous','next','continue'] as const).map(role=><g key={role} className="reading-position-marks" data-position={role} aria-hidden="true">
    {centers.map(([cx,cy],index)=><path key={index} style={{transform:`translate${index<2?'X':'Y'}(var(--reading-${role}-offset, 0px))`}}
      d={role==='current'?`M ${cx-6} ${cy} h 12`:role==='previous'?`M ${cx+4} ${cy-6} l -8 6 l 8 6`:role==='next'?`M ${cx-4} ${cy-6} l 8 6 l -8 6`:`M ${cx-7} ${cy-6} l 8 6 l -8 6 M ${cx+1} ${cy-6} l 8 6 l -8 6`}/>)}
  </g>)}</>;
}
