import { useRef } from 'react';
import { act, render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useViewedMessageHighlight } from '../hooks/useViewedMessageHighlight';
import {clipFrameScene} from '../components/graph/FrameViewport';
import ViewTargetCorners from '../components/ViewTargetCorners';
import type {ReadingNavigationMarkers} from '../hooks/useViewedMessageHighlight';

it('marks every group member and displays overlapping navigation roles side by side',async()=>{
  function Harness({markers,shown=true}:{markers:ReadingNavigationMarkers;shown?:boolean}){
    const root=useRef<HTMLDivElement>(null);useViewedMessageHighlight(root,['a','b'],markers);
    return <div ref={root}><div data-msgid="a"/>{shown&&<div data-msgid="b"/>}<div data-msgid="c"/>
      <div data-directed-edge-label="edge" data-msgid="edge" data-rel-overlay="true"/>
      <svg><g data-frame-visual="frame"><ViewTargetCorners x={0} y={0} width={400} height={200}/></g></svg><div data-msgid="frame" data-frame-header/>
    </div>;
  }
  const markers:ReadingNavigationMarkers={current:['a','b'],previous:['b','c'],next:['edge','frame'],continue:['frame','a']};
  const view=render(<Harness markers={markers}/>);
  expect(view.container.querySelector('[data-msgid="a"]')).toHaveAttribute('data-reading-position','current continue');
  expect(view.container.querySelector('[data-msgid="b"]')).toHaveAttribute('data-reading-position','current previous');
  expect(view.container.querySelector('[data-msgid="c"]')).toHaveAttribute('data-reading-position','previous');
  expect(view.container.querySelector('[data-directed-edge-label]')).toHaveAttribute('data-reading-position','next');
  const frame=view.container.querySelector('[data-frame-visual]')!;
  expect(frame).toHaveAttribute('data-reading-position','next continue');
  expect(frame.querySelectorAll('.reading-position-marks[data-position="continue"] path')).toHaveLength(4);
  expect((frame as SVGElement).style.getPropertyValue('--reading-next-offset')).toBe('-9px');
  expect((frame as SVGElement).style.getPropertyValue('--reading-continue-offset')).toBe('9px');
  expect(view.container.querySelector('[data-frame-header]')).not.toHaveAttribute('data-reading-position');
  view.rerender(<Harness markers={markers} shown={false}/>);await act(async()=>{});
  view.rerender(<Harness markers={markers}/>);await act(async()=>{});
  expect(view.container.querySelector('[data-msgid="b"]')).toHaveAttribute('data-reading-position','current previous');
  view.rerender(<Harness markers={{current:['a','c'],previous:[],next:[],continue:[]}}/>);
  expect(view.container.querySelector('[data-msgid="b"]')).not.toHaveAttribute('data-reading-position');
  expect(view.container.querySelector('[data-msgid="c"]')).toHaveAttribute('data-reading-position','current');
  expect(frame).not.toHaveAttribute('data-reading-position');
  expect((frame as SVGElement).style.getPropertyValue('--reading-next-offset')).toBe('');
});

it('marks current, previous and next at their primary anchors and updates virtual remounts',async()=>{
  function Harness({current='b',next='c',shown=true}:{current?:string;next?:string;shown?:boolean}){
    const root=useRef<HTMLDivElement>(null);useViewedMessageHighlight(root,[current],{current,previous:'a',next});
    return <div ref={root}><div data-msgid="a"/><div data-msgid="b"><span data-msgid="b"/></div>
      {shown&&<div data-directed-edge-label="c" data-msgid="c" data-rel-overlay="true"/>}
      <svg><g data-jump-visual-msgids="c"><path/></g></svg><div data-msgid="d"/></div>;
  }
  const view=render(<Harness/>);
  expect(view.container.querySelector('[data-msgid="a"]')).toHaveAttribute('data-reading-position','previous');
  expect(view.container.querySelector('[data-msgid="b"]')).toHaveAttribute('data-reading-position','current');
  expect(view.container.querySelector('span')).not.toHaveAttribute('data-reading-position');
  expect(view.container.querySelector('[data-directed-edge-label]')).toHaveAttribute('data-reading-position','next');
  expect(view.container.querySelector('g')).not.toHaveAttribute('data-reading-position');
  view.rerender(<Harness shown={false}/>);await act(async()=>{});
  view.rerender(<Harness/>);await act(async()=>{});
  expect(view.container.querySelector('[data-directed-edge-label]')).toHaveAttribute('data-reading-position','next');
  view.rerender(<Harness current="c" next="d"/>);await act(async()=>{});
  expect(view.container.querySelector('[data-msgid="b"]')).not.toHaveAttribute('data-reading-position');
  expect(view.container.querySelector('[data-directed-edge-label]')).toHaveAttribute('data-reading-position','current');
  expect(view.container.querySelector('[data-msgid="d"]')).toHaveAttribute('data-reading-position','next');
});

it('keeps card, frame and edge view anchors marked through remounts, and clears them when viewing ends', async () => {
  function Harness({ids, mounted=true}:{ids:string[];mounted?:boolean}) {
    const viewport=useRef<HTMLDivElement>(null);
    useViewedMessageHighlight(viewport,ids);
    return <div ref={viewport}>{mounted&&<div data-msgid="card"><span data-msgid="card"/></div>}
      <div data-directed-edge-start="edge" data-jump-msgids="edge"/>
      <div data-msgid="edge" data-rel-overlay="true"/>
      <svg><rect data-jump-visual-msgids="frame"/></svg>
    </div>;
  }
  const view=render(<Harness ids={['card','frame','edge']}/>);
  expect(view.container.querySelectorAll('[data-view-target]')).toHaveLength(3);
  expect(view.container.querySelector('[data-directed-edge-start]')).not.toHaveAttribute('data-view-target');
  view.rerender(<Harness ids={['card','frame','edge']} mounted={false}/>);
  await act(async()=>{});
  expect(view.container.querySelectorAll('[data-view-target]')).toHaveLength(2);
  view.rerender(<Harness ids={['card','frame','edge']}/>);
  await act(async()=>{});
  expect(view.container.querySelectorAll('[data-view-target]')).toHaveLength(3);
  expect(view.container.querySelector('[data-directed-edge-start]')).not.toHaveAttribute('data-view-target');
  view.rerender(<Harness ids={[]}/>);
  expect(view.container.querySelector('[data-view-target]')).toBeNull();
});

it('marks an expanded frame once and keeps its green corners with the clipped boundary',async()=>{
  function Harness({expanded=true}:{expanded?:boolean}){
    const root=useRef<HTMLDivElement>(null);useViewedMessageHighlight(root,['frame','member']);
    const box={x:20,y:50,width:400,height:200};
    const scene=<div ref={root}>{expanded?<><svg><g data-frame-visual="frame" data-jump-visual-msgids="frame">
      <rect data-jump-visual-msgids="frame" {...box}/><ViewTargetCorners {...box}/>
    </g></svg><div data-msgid="frame" data-frame-header="true"/></>:<div data-msgid="frame"/>}
      <div data-msgid="member"/><div data-jump-visual-msgids="frame" data-rel-overlay="true"/></div>;
    return clipFrameScene(scene,id=>id==='frame'?box:undefined);
  }
  const view=render(<Harness/>),frame=view.container.querySelector('[data-frame-visual]')!;
  expect(frame).toHaveAttribute('data-view-target','true');
  expect(frame.querySelector('.view-target-corners')).not.toBeNull();
  expect(frame.parentElement).toHaveAttribute('viewBox');
  expect(view.container.querySelector('[data-frame-header]')).not.toHaveAttribute('data-view-target');
  expect(view.container.querySelectorAll('[data-view-target]')).toHaveLength(2);
  view.rerender(<Harness expanded={false}/>);await act(async()=>{});
  expect(view.container.querySelector('[data-msgid="frame"]')).toHaveAttribute('data-view-target','true');
});
