/** Version changes update content in place; preserve the user's scroll offsets. */
export function captureReadingVersionPosition(anchor:HTMLElement|null) {
  if(!anchor)return ()=>{};
  const page=document.scrollingElement;
  const scrollers:{element:Element;left:number;top:number}[]=[];
  for(let parent=anchor.parentElement;parent;parent=parent.parentElement){
    if(parent===page)continue;
    const style=getComputedStyle(parent);
    if(/auto|scroll/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)){
      scrollers.push({element:parent,left:parent.scrollLeft,top:parent.scrollTop});
    }
  }
  if(page)scrollers.push({element:page,left:page.scrollLeft,top:page.scrollTop});
  return ()=>{
    for(const saved of scrollers){
      if(!saved.element.isConnected)continue;
      saved.element.scrollLeft=saved.left;
      saved.element.scrollTop=saved.top;
    }
  };
}
