import React,{useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import type {Box,FrameViewSize} from '../../utils/frameLayout';
import {FRAME_SCROLLBAR,type FrameScroll} from '../../utils/frameViewports';

const stop=(event:React.SyntheticEvent)=>event.stopPropagation();
function FrameSizeGrip({id,size,mode,direction=1,onSize,label,style,children}:{id:string;size:FrameViewSize;mode:'width'|'height'|'both';direction?:1|-1;onSize:(size:FrameViewSize)=>void;label:string;style:React.CSSProperties;children?:ReactNode}){
  const drag=useRef<{x:number;y:number;width:number;height:number;scaleX:number;scaleY:number}|null>(null);
  const title=mode==='width'?(direction===-1?'向左拖动加宽，向右拖动缩小；固定左上角':'横向拖动调整宽度；左右键微调'):mode==='height'?(direction===-1?'向上拖动增高，向下拖动缩小；固定左上角':'纵向拖动调整高度；上下键微调'):'拖动调整宽高；方向键微调';
  return <button type="button" data-frame-resize={id} aria-label={`${label} ${id}`} title={title}
    onClick={stop} onDoubleClick={stop} onMouseDown={stop} onMouseUp={stop}
    onPointerDown={event=>{event.stopPropagation();const canvas=event.currentTarget.closest<HTMLElement>('[data-jump-canvas]'),bounds=canvas?.getBoundingClientRect();
      drag.current={x:event.clientX,y:event.clientY,width:size.width,height:size.height,scaleX:canvas?.offsetWidth&&bounds?.width?bounds.width/canvas.offsetWidth:1,scaleY:canvas?.offsetHeight&&bounds?.height?bounds.height/canvas.offsetHeight:1};event.currentTarget.setPointerCapture?.(event.pointerId);}}
    onPointerMove={event=>{const start=drag.current;if(!start)return;onSize({width:mode==='height'?start.width:Math.max(240,start.width+direction*(event.clientX-start.x)/start.scaleX),height:mode==='width'?start.height:Math.max(120,start.height+direction*(event.clientY-start.y)/start.scaleY)});}}
    onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}
    onKeyDown={event=>{event.stopPropagation();const delta={ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]}[event.key];if(!delta)return;event.preventDefault();onSize({width:Math.max(240,size.width+direction*(mode==='height'?0:delta[0])),height:Math.max(120,size.height+direction*(mode==='width'?0:delta[1]))});}}
    style={{padding:0,border:'1px solid #64748b',borderRadius:2,color:'#cbd5e1',background:'#18212e',fontSize:12,lineHeight:1,touchAction:'none',pointerEvents:'auto',...style}}>{children}</button>;
}
function FrameDimension({label,value,min,onChange}:{label:string;value:number;min:number;onChange:(value:number)=>void}){
  const [draft,setDraft]=useState<string|null>(null);
  useLayoutEffect(()=>setDraft(null),[value]);
  return <input type="number" aria-label={label} min={min} step={20} value={draft??Math.round(value)}
    onChange={event=>{setDraft(event.currentTarget.value);const next=event.currentTarget.valueAsNumber;if(Number.isFinite(next)&&next>=min)onChange(next);}}
    onBlur={event=>{const next=event.currentTarget.valueAsNumber;if(Number.isFinite(next))onChange(Math.max(min,next));setDraft(null);}}
    style={{width:66,padding:'2px 3px',border:'1px solid #475569',borderRadius:3,background:'#111827',color:'#e2e8f0'}}/>;
}
export function FrameViewportTools({id,size,natural,onChange}:{id:string;size?:FrameViewSize;natural:FrameViewSize;onChange:(value:FrameViewSize|undefined)=>void}){
  const [open,setOpen]=useState(false),value=size??natural;
  return <div data-frame-size-controls={id} onClick={stop} onDoubleClick={stop} onMouseDown={stop} onMouseUp={stop} onKeyDown={stop} style={{fontSize:10,color:'#cbd5e1',cursor:'default',display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
    <button type="button" aria-label={`调整框架大小 ${id}`} aria-expanded={open} onClick={()=>setOpen(!open)}>调整大小</button>
    {open&&<><label>宽 <FrameDimension label={`框架宽度 ${id}`} min={240} value={value.width} onChange={width=>onChange({...value,width})}/></label>
      <label>高 <FrameDimension label={`框架高度 ${id}`} min={120} value={value.height} onChange={height=>onChange({...value,height})}/></label>
      <button type="button" disabled={!size} onClick={()=>onChange(undefined)}>恢复自适应</button><span>仅本次查看</span></>}
  </div>;
}

export function FrameViewportScrollbars({id,rect,content,scroll,onScroll,onSize,resized}:{id:string;rect:Box;content:FrameViewSize;scroll:FrameScroll;onScroll:(scroll:FrameScroll)=>void;onSize:(size:FrameViewSize)=>void;resized:boolean}){
  const horizontal=useRef<HTMLDivElement>(null),vertical=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{if(horizontal.current)horizontal.current.scrollLeft=scroll.left;if(vertical.current)vertical.current.scrollTop=scroll.top;},[scroll.left,scroll.top,rect.width,rect.height]);
  const common:React.CSSProperties={position:'absolute',zIndex:20,pointerEvents:'auto',background:'#18212e',overscrollBehavior:'contain',scrollbarColor:'#64748b #18212e'};
  return <>
    {resized&&<><div ref={horizontal} data-frame-scrollbar={id} aria-label={`框架水平滚动条 ${id}`} tabIndex={0}
      onScroll={event=>onScroll({...scroll,left:event.currentTarget.scrollLeft})}
      style={{...common,left:rect.x,top:rect.y+rect.height-FRAME_SCROLLBAR,width:rect.width-FRAME_SCROLLBAR,height:FRAME_SCROLLBAR,overflowX:'scroll',overflowY:'hidden'}}>
      <div style={{width:content.width,height:1}}/>
    </div><div ref={vertical} data-frame-scrollbar={id} aria-label={`框架垂直滚动条 ${id}`} tabIndex={0}
      onScroll={event=>onScroll({...scroll,top:event.currentTarget.scrollTop})}
      style={{...common,left:rect.x+rect.width-FRAME_SCROLLBAR,top:rect.y,width:FRAME_SCROLLBAR,height:rect.height-FRAME_SCROLLBAR,overflowY:'scroll',overflowX:'hidden'}}>
      <div style={{height:content.height,width:1}}/>
    </div></>}
    <FrameSizeGrip id={id} size={rect} mode="width" onSize={onSize} label="从右边缘调整框架宽度"
      style={{...common,left:rect.x+rect.width+1,top:rect.y+8,width:8,height:Math.max(20,rect.height-24),border:0,background:'transparent',cursor:'col-resize'}}/>
    <FrameSizeGrip id={id} size={rect} mode="width" direction={-1} onSize={onSize} label="从左边缘调整框架宽度"
      style={{...common,left:rect.x-5,top:rect.y+8,width:8,height:Math.max(20,rect.height-24),border:0,background:'transparent',cursor:'col-resize'}}/>
    <FrameSizeGrip id={id} size={rect} mode="height" onSize={onSize} label="从下边缘调整框架高度"
      style={{...common,left:rect.x+8,top:rect.y+rect.height+1,width:Math.max(20,rect.width-24),height:8,border:0,background:'transparent',cursor:'row-resize'}}/>
    <FrameSizeGrip id={id} size={rect} mode="height" direction={-1} onSize={onSize} label="从上边缘调整框架高度"
      style={{...common,left:rect.x+8,top:rect.y-5,width:Math.max(20,rect.width-24),height:8,border:0,background:'transparent',cursor:'row-resize'}}/>
    <FrameSizeGrip id={id} size={rect} mode="both" onSize={onSize} label="拖动调整框架大小"
      style={{...common,left:rect.x+rect.width-16,top:rect.y+rect.height-16,width:16,height:16,cursor:'nwse-resize'}}>◢</FrameSizeGrip>
  </>;
}

/** Clip entire cards and their controls together, while preserving their canvas coordinates. */
function FrameClip({clip,svg,children}:{clip:Box;svg:boolean;children:ReactNode}){
  if(svg)return <svg x={clip.x} y={clip.y} width={clip.width} height={clip.height} viewBox={`${clip.x} ${clip.y} ${clip.width||1} ${clip.height||1}`} style={{overflow:'hidden',pointerEvents:'none'}}>{children}</svg>;
  return <div data-frame-clip="true" style={{position:'absolute',left:clip.x,top:clip.y,width:clip.width,height:clip.height,overflow:'clip',pointerEvents:'none'}}>
    <div style={{position:'absolute',left:-clip.x,top:-clip.y,pointerEvents:'none'}}><div style={{display:'contents',pointerEvents:'auto'}}>{children}</div></div>
  </div>;
}

/** Bounded frames add clipping layers; the ordinary canvas keeps its original DOM. */
export function clipFrameScene(node:ReactNode,clipFor:(id:string,edgeId?:string)=>Box|undefined,svg=false):ReactNode{
  if(Array.isArray(node)){
    let changed=false;
    const next=node.map((child,index)=>{const result=clipFrameScene(child,clipFor,svg);if(result===child)return child;changed=true;
      return React.isValidElement(result)&&result.key===null?React.cloneElement(result,{key:`frame-slot-${index}`}):result;
    });
    return changed?next:node;
  }
  const child=node;
    if(!React.isValidElement<{children?:ReactNode;msg?:{id:string};[name:string]:unknown}>(child))return child;
    const props=child.props,insideSvg=svg||child.type==='svg';
    const ids=typeof props['data-directed-edge-source']==='string'?[props['data-directed-edge-source']]:[props['data-msgid'],props['data-jump-visual-msgids'],props['data-frame-visual'],props['data-directed-edge-label'],props['data-directed-edge-start'],props['data-decoration-toggle'],props['data-annotation-toggle'],props['data-frame-scrollbar'],props['data-frame-resize'],props.msg?.id,child.type===FrameViewportScrollbars?props.id:undefined].filter((id):id is string=>typeof id==='string');
    const clip=ids.flatMap(ids=>ids.split(/\s+/)).map(id=>clipFor(id,typeof props['data-directed-edge-start']!=='string'&&typeof props['data-frame-edge-id']==='string'?props['data-frame-edge-id']:undefined)).find(Boolean);
    if(clip){const wrapped=<FrameClip clip={clip} svg={insideSvg}>{child}</FrameClip>;return child.key===null?wrapped:React.cloneElement(wrapped,{key:child.key});}
    const children=props.children?clipFrameScene(props.children,clipFor,insideSvg):props.children;
    return children===props.children?child:React.cloneElement(child,undefined,children);
}
