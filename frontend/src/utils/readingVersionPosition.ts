/** Capture the clicked header before a version change moves cards or their ancestors. */
export function captureReadingVersionPosition(anchor:HTMLElement|null) {
  if(!anchor)return ()=>{};
  const attribute=anchor.hasAttribute('data-reading-version-marker')?'data-reading-version-marker':'data-display-hint';
  const messageId=anchor.getAttribute(attribute),scope=anchor.closest('[data-comparison-view]')??anchor.closest('[data-workbench-left-panel]')??document;
  const original=anchor.getBoundingClientRect();
  const scrollers:{element:HTMLElement;x:boolean;y:boolean;left:number;top:number}[]=[];
  for(let parent=anchor.parentElement;parent;parent=parent.parentElement){
    if(parent===document.scrollingElement)continue;
    const style=getComputedStyle(parent),rect=parent.getBoundingClientRect();
    const x=/auto|scroll/.test(style.overflowX||style.overflow);
    const y=/auto|scroll/.test(style.overflowY||style.overflow);
    if(x||y)scrollers.push({element:parent,x,y,left:original.left-rect.left,top:original.top-rect.top});
  }
  return ()=>{
    const target=anchor.isConnected?anchor:[...scope.querySelectorAll<HTMLElement>(`[${attribute}]`)].find(element=>element.getAttribute(attribute)===messageId);
    if(!target)return;
    for(const saved of scrollers){
      if(!saved.element.isConnected)continue;
      const rect=target.getBoundingClientRect(),viewport=saved.element.getBoundingClientRect();
      const scaleX=saved.element.offsetWidth?viewport.width/saved.element.offsetWidth:1;
      const scaleY=saved.element.offsetHeight?viewport.height/saved.element.offsetHeight:1;
      if(saved.x)saved.element.scrollLeft+=(rect.left-viewport.left-saved.left)/(scaleX||1);
      if(saved.y)saved.element.scrollTop+=(rect.top-viewport.top-saved.top)/(scaleY||1);
    }
    const page=document.scrollingElement;
    if(page){
      const rect=target.getBoundingClientRect();
      page.scrollLeft+=rect.left-original.left;
      page.scrollTop+=rect.top-original.top;
    }
  };
}
