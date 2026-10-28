import { useRef } from 'react';
import { act, render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useViewedMessageHighlight } from '../hooks/useViewedMessageHighlight';
import {clipFrameScene} from '../components/graph/FrameViewport';
import ViewTargetCorners from '../components/ViewTargetCorners';

it('keeps card, frame and edge view anchors marked through remounts, and clears them when viewing ends', async () => {
  function Harness({ids, mounted=true}:{ids:string[];mounted?:boolean}) {
    const viewport=useRef<HTMLDivElement>(null);
    useViewedMessageHighlight(viewport,ids);
    return <div ref={viewport}>{mounted&&<div data-msgid="card"><span data-msgid="card"/></div>}
      <div data-msgid="edge" data-rel-overlay="true"/>
      <svg><rect data-jump-visual-msgids="frame"/></svg>
    </div>;
  }
  const view=render(<Harness ids={['card','frame','edge']}/>);
  expect(view.container.querySelectorAll('[data-view-target]')).toHaveLength(3);
  view.rerender(<Harness ids={['card','frame','edge']} mounted={false}/>);
  await act(async()=>{});
  expect(view.container.querySelectorAll('[data-view-target]')).toHaveLength(2);
  view.rerender(<Harness ids={['card','frame','edge']}/>);
  await act(async()=>{});
  expect(view.container.querySelectorAll('[data-view-target]')).toHaveLength(3);
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
