import {act,renderHook} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {useReadingViewportAnchor} from '../hooks/useReadingViewportAnchor';
it('keeps a located reading card in place after a branch grows and respects manual scroll',async()=>{
  vi.useFakeTimers();
  const panel=document.createElement('div'),card=document.createElement('div');card.dataset.msgid='reading';panel.append(card);document.body.append(panel);
  Object.defineProperty(panel,'clientHeight',{value:400});
  vi.spyOn(panel,'getBoundingClientRect').mockImplementation(()=>new DOMRect(0,100,600,400));
  let y=200;vi.spyOn(card,'getBoundingClientRect').mockImplementation(()=>new DOMRect(0,y-panel.scrollTop,300,80));
  const view=renderHook(()=>useReadingViewportAnchor({current:panel},'reading'));
  try{
    y+=120;card.style.top='120px';
    await act(async()=>{await Promise.resolve();await vi.advanceTimersByTimeAsync(32);});
    expect(panel.scrollTop).toBe(120);expect(card.getBoundingClientRect().top).toBe(200);
    panel.scrollTop=160;panel.dispatchEvent(new Event('scroll'));
    y+=40;card.style.top='160px';
    await act(async()=>{await Promise.resolve();await vi.advanceTimersByTimeAsync(32);});
    expect(panel.scrollTop).toBe(200);expect(card.getBoundingClientRect().top).toBe(160);
  }finally{view.unmount();panel.remove();vi.useRealTimers();}
});
