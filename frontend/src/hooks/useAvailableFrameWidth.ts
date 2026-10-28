import {useLayoutEffect,useState,type RefObject} from 'react';

/** The containing pane's width is independent of the canvas's scroll position and content size. */
export function useAvailableFrameWidth(ref:RefObject<HTMLElement>,enabled:boolean){
  const [width,setWidth]=useState<number>();
  useLayoutEffect(()=>{
    const canvas=ref.current;if(!enabled||!canvas){setWidth(undefined);return;}
    let frame=0;
    const update=()=>{
      frame=0;const rect=canvas.getBoundingClientRect();if(!rect.width)return;
      const scale=canvas.offsetWidth?rect.width/canvas.offsetWidth:1;
      let available=window.visualViewport?.width??window.innerWidth;
      for(let parent=canvas.parentElement;parent;parent=parent.parentElement){
        const style=getComputedStyle(parent),bounds=parent.getBoundingClientRect();
        if(bounds.width&&/auto|scroll|hidden|clip/.test(style.overflowX||style.overflow))available=Math.min(available,parent.clientWidth?parent.clientWidth*scale:bounds.width);
      }
      const next=Math.max(240,Math.floor(available/(scale||1)));
      setWidth(previous=>previous!==undefined&&Math.abs(previous-next)<1?previous:next);
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(update);};
    const observer=new ResizeObserver(schedule);observer.observe(canvas);
    for(let parent=canvas.parentElement;parent;parent=parent.parentElement)observer.observe(parent);
    update();window.addEventListener('resize',schedule);window.visualViewport?.addEventListener('resize',schedule);
    return()=>{observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('resize',schedule);};
  },[ref,enabled]);
  return width;
}
