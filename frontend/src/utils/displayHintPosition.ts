export type DisplayHintPlacement='below'|'above'|'right'|'left';
type Bounds={left:number;top:number;right:number;bottom:number};
type Viewport={left:number;top:number;width:number;height:number};

/** Prefer vertical anchoring; use either side when it can avoid a short reading window. */
export function displayHintPosition(rect:Bounds,viewport:Viewport,expanded:boolean){
  const margin=8,gap=6,left=viewport.left+margin,top=viewport.top+margin;
  const availableWidth=Math.max(0,viewport.width-margin*2),availableHeight=Math.max(0,viewport.height-margin*2);
  const width=Math.min(expanded?420:300,availableWidth),height=Math.min(expanded?440:180,availableHeight);
  const right=left+availableWidth,bottom=top+availableHeight;
  const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(value,Math.max(min,max)));
  const below=Math.max(0,bottom-rect.bottom-gap),above=Math.max(0,rect.top-gap-top);
  const rightSpace=right-rect.right-gap,leftSpace=rect.left-gap-left;
  const placement:DisplayHintPlacement=below>=height?'below':above>=height?'above':rightSpace>=width?'right':leftSpace>=width?'left':above>below?'above':'below';
  const horizontal=placement==='right'||placement==='left';
  const maxHeight=horizontal?height:Math.min(height,placement==='above'?above:below);
  return {placement,width,maxHeight,
    left:clamp(placement==='right'?rect.right+gap:placement==='left'?rect.left-gap-width:rect.left,left,right-width),
    top:horizontal?clamp((rect.top+rect.bottom-height)/2,top,bottom-height)
      :placement==='above'?clamp(rect.top-gap,top+maxHeight,bottom):clamp(rect.bottom+gap,top,bottom-maxHeight)};
}
