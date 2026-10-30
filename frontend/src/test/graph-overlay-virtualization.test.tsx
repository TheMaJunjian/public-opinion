import {useMemo,useRef} from 'react';
import {render} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {useGraphOverlays} from '../hooks/useGraphOverlays';
import type {GraphOverlayInput} from '../utils/graphOverlays';
import type {DemoEdge,DemoMessage} from '../utils/modelBridge';

it('keeps dependent edge geometry when scrolling unmounts and remounts its label',()=>{
  const cards:DemoMessage[]=['a','b','c'].map(id=>({id,kind:'normal',content:id,author:'tester',createdAt:''}));
  const edge=(id:string,from:string,to:string):DemoEdge=>({id,relationMessageId:id,relationType:'reference',relationLabel:'引用',
    from:{messageId:from,selection:{kind:'whole'}},to:{messageId:to,selection:{kind:'whole'}}});
  const edges=[edge('ref','a','b'),edge('nested','c','ref')];
  const messages:DemoMessage[]=[...cards,...edges.map(link=>({id:link.id,kind:'relation' as const,relationType:link.relationType,content:'',author:'tester',createdAt:''}))];
  const input:Omit<GraphOverlayInput,'canvasRef'|'labelBboxes'>={normalIds:cards.map(card=>card.id),normals:cards,messages,edges,
    msgMap:new Map(messages.map(message=>[message.id,message])),relationCardMsgIds:new Set(),cardRefs:{current:{}},headerRefs:{current:{}},contentRefs:{current:{}},
    colOf:{a:1,b:0,c:2},layout:{a:{x:400,y:0,width:240,height:100},b:{x:0,y:200,width:240,height:100},c:{x:800,y:0,width:240,height:100}},
    isTraceWindow:false,anonCorrectedRelMsgIds:new Set(),finalFrameRects:{},traceExpandedFrameIds:new Set(),edgesByRelMsg:new Map(edges.map(link=>[link.id,[link]])),
    comparisonSuppressedRelIds:new Set(),correctedEdgeIdsByRelMsg:new Map()};
  const bounds=vi.spyOn(Element.prototype,'getBoundingClientRect').mockImplementation(function(this:Element){
    if(this.tagName==='text')return new DOMRect(Number(this.getAttribute('x'))-20,Number(this.getAttribute('y'))-5,40,10);
    return new DOMRect(0,0,1200,1000);
  });
  function Harness({shown,top}:{shown:boolean;top:number}){
    const canvasRef=useRef<HTMLDivElement>(null),textRefs=useRef<Record<string,SVGTextElement|null>>({});
    const labelViewport=useMemo(()=>({x:0,y:top,width:1200,height:400}),[top]);
    const overlays=useGraphOverlays({...input,canvasRef,textRefs,actualCanvasWidth:1200,actualCanvasHeight:1000,labelViewport});
    return <div ref={canvasRef}><svg>{shown&&overlays.positionedEdges.map(pe=><text key={pe.drawId} x={pe.labelX} y={pe.labelY}
      ref={element=>{textRefs.current[pe.drawId]=element;}}>{pe.edgeLabelText}</text>)}</svg><output>{JSON.stringify({edges:overlays.positionedEdges,labels:overlays.labelBboxes})}</output></div>;
  }
  const view=render(<Harness shown top={0}/>);
  try{
    const initial=view.getByRole('status').textContent;
    expect(JSON.parse(initial!).labels).toHaveProperty('ref');
    view.rerender(<Harness shown={false} top={800}/>);
    expect(view.getByRole('status').textContent).toBe(initial);
    view.rerender(<Harness shown top={0}/>);
    expect(view.getByRole('status').textContent).toBe(initial);
    // Real scene updates still reroute the graph, including cached labels.
    input.layout={...input.layout,b:{...input.layout.b,y:500}};
    view.rerender(<Harness shown top={200}/>);
    const changed=view.getByRole('status').textContent;
    expect(changed).not.toBe(initial);
    view.rerender(<Harness shown={false} top={800}/>);
    expect(view.getByRole('status').textContent).toBe(changed);
  }finally{view.unmount();bounds.mockRestore();}
});
