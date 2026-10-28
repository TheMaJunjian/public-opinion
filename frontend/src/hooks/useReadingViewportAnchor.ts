import {useLayoutEffect,type RefObject} from 'react';
import {findMessageElements} from '../pages/workbench/actions/scrollNavigation';

/** Activate after navigation completes; layout insertions then preserve the reading position. */
export function useReadingViewportAnchor(viewport:RefObject<HTMLDivElement>,messageId:string|null){
  useLayoutEffect(()=>{
    const panel=viewport.current;if(!panel||!messageId)return;
    let frame=0,previous:number|undefined,adjusting=false;
    const element=()=>findMessageElements(panel,messageId).find(item=>!item.hasAttribute('data-rel-overlay'))??findMessageElements(panel,messageId)[0];
    const remember=()=>{const target=element();if(target)previous=target.getBoundingClientRect().top;};
    const update=()=>{
      frame=0;const target=element();if(!target)return;
      const bounds=target.getBoundingClientRect(),clip=panel.getBoundingClientRect();
      if(previous!==undefined&&previous<clip.bottom&&previous+bounds.height>clip.top){
        const delta=bounds.top-previous;
        if(Math.abs(delta)>0.5){
          const scale=panel.clientHeight&&clip.height?panel.clientHeight/clip.height:1;
          adjusting=true;panel.scrollTop+=delta*scale;adjusting=false;
        }
      }
      remember();
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(update);};
    const scroll=()=>{if(!adjusting)remember();};
    remember();const observer=new MutationObserver(schedule);
    observer.observe(panel,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class','data-msgid']});
    panel.addEventListener('scroll',scroll,{passive:true});
    return()=>{cancelAnimationFrame(frame);observer.disconnect();panel.removeEventListener('scroll',scroll);};
  },[viewport,messageId]);
}
