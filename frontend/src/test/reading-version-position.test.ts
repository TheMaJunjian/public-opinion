import {afterEach,describe,expect,it,vi} from 'vitest';
import {captureReadingVersionPosition} from '../utils/readingVersionPosition';

afterEach(()=>{document.body.replaceChildren();document.documentElement.scrollTop=0;document.documentElement.scrollLeft=0;Reflect.deleteProperty(document,'scrollingElement');vi.restoreAllMocks();});

describe('reading version position',()=>{
  it.each([false,true])('keeps scroll offsets when the version changes layout, remounted=%s',remounted=>{
    const page=document.documentElement;
    Object.defineProperty(document,'scrollingElement',{configurable:true,value:page});page.scrollTop=80;
    const pane=document.createElement('div'),horizontal=document.createElement('div');
    pane.dataset.workbenchLeftPanel='true';pane.style.overflowY='auto';horizontal.style.overflowX='auto';
    document.body.append(pane);pane.append(horizontal);pane.scrollTop=500;horizontal.scrollLeft=90;
    let pageLayout=100,cardTop=700,cardLeft=200;
    vi.spyOn(pane,'getBoundingClientRect').mockImplementation(()=>new DOMRect(0,pageLayout-page.scrollTop,600,400));
    vi.spyOn(horizontal,'getBoundingClientRect').mockImplementation(()=>new DOMRect(20,pageLayout+20-pane.scrollTop-page.scrollTop,500,800));
    const makeMarker=()=>{
      const marker=document.createElement('button');marker.dataset.readingVersionMarker='m';
      vi.spyOn(marker,'getBoundingClientRect').mockImplementation(()=>new DOMRect(20+cardLeft-horizontal.scrollLeft,pageLayout+20+cardTop-pane.scrollTop-page.scrollTop,18,16));
      return marker;
    };
    const marker=makeMarker();horizontal.append(marker);
    const before=marker.getBoundingClientRect(),restore=captureReadingVersionPosition(marker);
    pageLayout+=150;cardTop+=450;cardLeft+=230;
    if(remounted)marker.replaceWith(makeMarker());
    restore();
    const after=horizontal.querySelector('button')!.getBoundingClientRect();
    expect(after.top).toBe(before.top+600);expect(after.left).toBe(before.left+230);
    expect(pane.scrollTop).toBe(500);expect(horizontal.scrollLeft).toBe(90);expect(page.scrollTop).toBe(80);
  });
  it('captures a pane before a larger version makes it overflow',()=>{
    const pane=document.createElement('div'),marker=document.createElement('button');pane.style.overflow='auto';pane.append(marker);document.body.append(pane);
    let contentTop=40;vi.spyOn(marker,'getBoundingClientRect').mockImplementation(()=>new DOMRect(20,contentTop-pane.scrollTop,18,16));
    const restore=captureReadingVersionPosition(marker);contentTop=500;restore();
    expect(pane.scrollTop).toBe(0);expect(marker.getBoundingClientRect().top).toBe(500);
  });
  it('restores nested and page offsets after browser scroll anchoring',()=>{
    const page=document.documentElement;
    Object.defineProperty(document,'scrollingElement',{configurable:true,value:page});
    const pane=document.createElement('div'),marker=document.createElement('button');
    pane.style.overflow='auto';pane.append(marker);document.body.append(pane);
    pane.scrollTop=240;pane.scrollLeft=45;page.scrollTop=60;page.scrollLeft=12;
    const restore=captureReadingVersionPosition(marker);
    pane.scrollTop=780;pane.scrollLeft=90;page.scrollTop=140;page.scrollLeft=24;
    restore();
    expect([pane.scrollTop,pane.scrollLeft,page.scrollTop,page.scrollLeft]).toEqual([240,45,60,12]);
  });
});
