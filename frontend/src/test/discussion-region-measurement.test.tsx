import { StrictMode, useCallback, useState } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import DiscussionRegions from '../components/graph/DiscussionRegions';

const originalObserver=window.ResizeObserver;
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.ResizeObserver=originalObserver; });

it('settles header measurements through repeated region folds and still responds to changed text width', () => {
  let textWidth=100;
  vi.spyOn(HTMLElement.prototype,'scrollWidth','get').mockImplementation(function(this:HTMLElement) {
    return this.hasAttribute('data-discussion-header-content') ? textWidth : 0;
  });
  const observers=new Set<() => void>();
  window.ResizeObserver=class {
    private measure:() => void;
    constructor(callback:ResizeObserverCallback) { this.measure=()=>callback([],this); observers.add(this.measure); }
    observe() {}
    unobserve() {}
    disconnect() { observers.delete(this.measure); }
  };
  const reported=vi.fn();
  function Scene() {
    const [collapsed,setCollapsed]=useState(false);
    const [widths,setWidths]=useState<Readonly<Record<string,number>>>({});
    const measure=useCallback((next:Readonly<Record<string,number>>) => { reported(next); setWidths(next); },[]);
    return <DiscussionRegions regions={[{key:'reply',targetId:'root',type:'reply',directCount:1,collapsed,
      x:0,y:0,width:widths.reply??200,height:collapsed?24:200,headerHeight:24}]}
      onToggle={()=>setCollapsed(value=>!value)} clipFor={()=>undefined} onHeaderWidthsChange={measure}/>;
  }
  const ui=render(<StrictMode><Scene/></StrictMode>);
  expect(reported).toHaveBeenCalledTimes(1);
  const initial=reported.mock.calls[0][0].reply;
  for(let index=0;index<60;index++) {
    fireEvent.click(ui.getByRole('button',{name:`${index%2?'展开':'收起'}回复分支 root`}));
  }
  expect(reported).toHaveBeenCalledTimes(1);
  expect(ui.getByRole('button',{name:'收起回复分支 root'})).toHaveAttribute('aria-expanded','true');
  textWidth=180;
  act(()=>{for(const measure of [...observers])measure();});
  expect(reported).toHaveBeenCalledTimes(2);
  expect(reported.mock.lastCall?.[0].reply).toBe(initial+80);
  expect(ui.getByRole('group')).toHaveStyle({width:`${initial+80}px`});
});
