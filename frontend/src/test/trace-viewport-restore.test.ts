import {afterEach,expect,it,vi} from 'vitest';
import {createWorkbenchDrawingTasks} from '../context/WorkbenchDrawingContext';
import {captureSnapshot,restoreSnapshot} from '../pages/workbench/actions/viewHistory';
import {clampAndSetScroll} from '../pages/workbench/actions/scrollNavigation';
import {REVEAL_VIRTUAL_MESSAGE} from '../hooks/useVirtualMessageMounts';

afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();document.body.replaceChildren();});

function fixture(){
  vi.useFakeTimers();
  const panel=document.createElement('div'),right=document.createElement('div'),card=document.createElement('div');
  card.dataset.msgid='reading-card';panel.append(card);document.body.append(panel,right);
  for(const element of [panel,right])for(const [name,value] of Object.entries({clientHeight:400,offsetHeight:400,clientWidth:600,offsetWidth:600,scrollHeight:5000,scrollWidth:3000}))
    Object.defineProperty(element,name,{configurable:true,value});
  vi.spyOn(panel,'getBoundingClientRect').mockReturnValue(new DOMRect(0,100,600,400));
  let extraTop=0,extraLeft=0;
  vi.spyOn(card,'getBoundingClientRect').mockImplementation(()=>new DOMRect(40+extraLeft-panel.scrollLeft,1100+extraTop-panel.scrollTop,320,86));
  panel.scrollTop=900;right.scrollTop=80;
  const snapshot=()=>captureSnapshot({viewMode:'graph',traceDistance:2,readingAnchorId:'reading-card',leftPanelRef:{current:panel},rightPanelRef:{current:right}});
  const drawing=createWorkbenchDrawingTasks(),registration=drawing.begin('positioning');
  const deps={startPositioning:()=>({...registration,complete:registration.release,run:(work:()=>void)=>work()}),scrollRequestIdRef:{current:0},
    setTraceDistance:vi.fn(),setViewMode:vi.fn(),scrollRafRef:{current:null as number|null},scrollRaf2Ref:{current:null as number|null},
    leftPanelRef:{current:panel},rightPanelRef:{current:right},clampAndSetScroll,onRestored:vi.fn(),showMessagePulse:vi.fn(),
    cancelScrollRafs:()=>{if(deps.scrollRafRef.current!==null)cancelAnimationFrame(deps.scrollRafRef.current);if(deps.scrollRaf2Ref.current!==null)cancelAnimationFrame(deps.scrollRaf2Ref.current);}};
  const reveals:string[][]=[];
  panel.addEventListener(REVEAL_VIRTUAL_MESSAGE,event=>{
    const ids=(event as CustomEvent<{ids:string[]}>).detail.ids;reveals.push(ids);
    if(ids.includes('reading-card')&&!card.isConnected)panel.append(card);
  });
  return {panel,right,card,snapshot,deps,registration,drawing,reveals,move:(top:number,left=0)=>{extraTop=top;extraLeft=left;}};
}

it('remounts the saved reading card and restores its visible position against background layout changes',()=>{
  const f=fixture(),snapshot=f.snapshot(),before=f.card.getBoundingClientRect();
  f.card.remove();f.move(350,120);f.panel.scrollTop=0;f.right.scrollTop=500;
  restoreSnapshot(f.deps,snapshot);vi.advanceTimersByTime(250);
  expect(f.card.isConnected).toBe(true);expect(f.card.getBoundingClientRect().top).toBe(before.top);expect(f.card.getBoundingClientRect().left).toBe(before.left);
  expect(f.panel.scrollTop).toBe(1250);expect(f.panel.scrollLeft).toBe(120);expect(f.right.scrollTop).toBe(80);
  expect(f.deps.onRestored).toHaveBeenCalledOnce();expect(f.deps.showMessagePulse).not.toHaveBeenCalled();expect(f.reveals.at(-1)).toEqual([]);expect(f.drawing.pending).toBe(0);
});

it('preserves manual scrolling when the reading focus was outside the saved viewport',()=>{
  const f=fixture();f.panel.scrollTop=0;const snapshot=f.snapshot();expect(snapshot.readingViewportAnchor).toBeNull();
  f.move(350);f.panel.scrollTop=800;
  restoreSnapshot(f.deps,snapshot);vi.advanceTimersByTime(150);
  expect(f.panel.scrollTop).toBe(0);expect(f.reveals).toEqual([]);expect(f.deps.onRestored).toHaveBeenCalledOnce();expect(f.drawing.pending).toBe(0);
});

it('cancels deferred alignment without moving the new view or leaving a virtual pin',()=>{
  const f=fixture(),snapshot=f.snapshot();f.card.remove();f.move(350);
  restoreSnapshot(f.deps,snapshot);vi.advanceTimersByTime(34);expect(f.reveals).toContainEqual(['reading-card']);
  f.registration.cancel();f.panel.scrollTop=777;vi.advanceTimersByTime(200);
  expect(f.panel.scrollTop).toBe(777);expect(f.deps.onRestored).not.toHaveBeenCalled();expect(f.reveals.at(-1)).toEqual([]);expect(f.drawing.pending).toBe(0);
});
