/** Four corner brackets for SVG container frames, without changing their own border. */
export default function ViewTargetCorners({x,y,width,height}:{x:number;y:number;width:number;height:number}) {
  const left=x-4,top=y-4,right=x+width+4,bottom=y+height+4;
  const length=Math.min(12,(width+8)/3,(height+8)/3);
  return <path className="view-target-corners" aria-hidden="true" d={[
    `M ${left+length} ${top} H ${left} V ${top+length}`,
    `M ${right-length} ${top} H ${right} V ${top+length}`,
    `M ${right} ${bottom-length} V ${bottom} H ${right-length}`,
    `M ${left+length} ${bottom} H ${left} V ${bottom-length}`,
  ].join(' ')}/>;
}
