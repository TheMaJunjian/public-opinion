import {useLayoutEffect,type RefObject} from 'react';
import {findMessageElements} from '../pages/workbench/actions/scrollNavigation';

/** Activate after navigation completes; layout insertions then preserve the reading position. */
export function useReadingViewportAnchor(viewport:RefObject<HTMLDivElement>,messageId:string|null){
  useLayoutEffect(()=>{
    const panel=viewport.current;if(!panel||!messageId)return;
    let frame=0,previous:number|undefined,previousLeft:number|undefined,scrollTop=panel.scrollTop,scrollLeft=panel.scrollLeft;
    const element=()=>findMessageElements(panel,messageId).find(item=>!item.hasAttribute('data-rel-overlay'))??findMessageElements(panel,messageId)[0];
    const remember=()=>{const target=element();if(target){const rect=target.getBoundingClientRect();previous=rect.top;previousLeft=rect.left;}scrollTop=panel.scrollTop;scrollLeft=panel.scrollLeft;};
    const scroll=()=>{
      // A scroll event can arrive after content has moved but before our layout
      // frame. Apply only its scroll delta, retaining the pending layout shift.
      const {height,width}=panel.getBoundingClientRect();
      if(previous!==undefined)previous-=(panel.scrollTop-scrollTop)*(panel.clientHeight&&height?height/panel.clientHeight:1);
      if(previousLeft!==undefined)previousLeft-=(panel.scrollLeft-scrollLeft)*(panel.clientWidth&&width?width/panel.clientWidth:1);
      scrollTop=panel.scrollTop;scrollLeft=panel.scrollLeft;
    };
    const update=()=>{
      frame=0;scroll();const target=element();if(!target)return;
      const bounds=target.getBoundingClientRect(),clip=panel.getBoundingClientRect();
      if(previous!==undefined&&previousLeft!==undefined&&previous<clip.bottom&&previous+bounds.height>clip.top
        &&previousLeft<clip.right&&previousLeft+bounds.width>clip.left){
        const delta=bounds.top-previous;
        if(Math.abs(delta)>0.5){
          const scale=panel.clientHeight&&clip.height?panel.clientHeight/clip.height:1;
          panel.scrollTop+=delta*scale;
        }
        const deltaLeft=bounds.left-previousLeft;
        if(Math.abs(deltaLeft)>0.5)panel.scrollLeft+=deltaLeft*(panel.clientWidth&&clip.width?panel.clientWidth/clip.width:1);
      }
      remember();
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(update);};
    remember();const observer=new MutationObserver(schedule);
    observer.observe(panel,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['style','class','data-msgid']});
    panel.addEventListener('scroll',scroll,{passive:true});
    return()=>{cancelAnimationFrame(frame);observer.disconnect();panel.removeEventListener('scroll',scroll);};
  },[viewport,messageId]);
}
