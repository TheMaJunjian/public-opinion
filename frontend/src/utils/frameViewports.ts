import type {Box,FrameBlock,FrameViewSize} from './frameLayout';
import type {DemoEdge} from './modelBridge';
import {getPresentationSpec} from '../types';

export type FrameScroll={left:number;top:number};
export type GraphFrameViewState=Record<string,{sizes:Record<string,FrameViewSize>;scrolls:Record<string,FrameScroll>;full?:Record<string,boolean>}>;
export const FRAME_SCROLLBAR=14;
export const intersectFrameRects=(a:Box,b:Box):Box=>{
  const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y);
  return {x,y,width:Math.max(0,Math.min(a.x+a.width,b.x+b.width)-x),height:Math.max(0,Math.min(a.y+a.height,b.y+b.height)-y)};
};

/** A local viewport changes occupied space without changing member columns or card widths. */
export function projectFrameViewports(layout:Record<string,Box>,frames:Record<string,Box>,naturalContents:Record<string,Box>,blocks:FrameBlock[],sizes:Readonly<Record<string,FrameViewSize>>,scrolls:Readonly<Record<string,FrameScroll>>,rightPadding=0,paddedIds?:ReadonlySet<string>){
  const contents=Object.fromEntries(Object.entries(naturalContents).map(([id,box])=>[id,sizes[id]&&(!paddedIds||paddedIds.has(id))?{...box,width:box.width+rightPadding}:box]));
  const parents=new Map<string,string>();
  for(const block of blocks)for(const id of [...block.directCardIds,...block.childRelMsgIds])if(id!==block.relMsgId&&!parents.has(id))parents.set(id,block.relMsgId);
  const ancestors=(id:string)=>{const values:string[]=[],seen=new Set([id]);let parent=parents.get(id);while(parent&&!seen.has(parent)){seen.add(parent);values.push(parent);parent=parents.get(parent);}return values;};
  const offsets:Record<string,FrameScroll>={};
  for(const [id,size] of Object.entries(sizes)){
    const content=contents[id];if(!content||!frames[id])continue;
    const requested=scrolls[id]??{left:0,top:0};
    offsets[id]={left:Math.min(Math.max(0,requested.left),Math.max(0,content.width-size.width+FRAME_SCROLLBAR)),top:Math.min(Math.max(0,requested.top),Math.max(0,content.height-size.height+FRAME_SCROLLBAR))};
  }
  const moved=(id:string,box:Box)=>{
    let {x,y}=box;for(const parent of ancestors(id)){x-=offsets[parent]?.left??0;y-=offsets[parent]?.top??0;}
    return {...box,x,y};
  };
  const frameRects=Object.fromEntries(Object.entries(frames).map(([id,box])=>[id,moved(id,box)]));
  const viewports=Object.fromEntries(Object.keys(offsets).map(id=>[id,{...frameRects[id],width:Math.max(0,frameRects[id].width-FRAME_SCROLLBAR),height:Math.max(0,frameRects[id].height-FRAME_SCROLLBAR)}]));
  const clips=new Map<string,Box>();
  const clipFor=(id:string)=>{
    const known=clips.get(id);if(known)return known;
    let clip:Box|undefined;
    for(const parent of ancestors(id)){const viewport=viewports[parent];if(viewport)clip=clip?intersectFrameRects(clip,viewport):viewport;}
    if(clip)clips.set(id,clip);return clip;
  };
  const displayLayout=Object.fromEntries(Object.entries(layout).map(([id,box])=>[id,moved(id,box)]));
  for(const id of [...Object.keys(layout),...Object.keys(frames)])clipFor(id);
  const extent=(id:string,box:Box)=>{const clip=clipFor(id);if(!clip)return box;const result=intersectFrameRects(box,clip);return result.width&&result.height?result:{x:clip.x,y:clip.y,width:0,height:0};};
  const reveal=(ids:string[],anchors?:ReadonlyMap<string,Box>)=>{
    const next={...offsets},requested=new Set(ids);
    for(const id of ids){
      if(ancestors(id).some(parent=>requested.has(parent)))continue;
      let box=anchors?.get(id)??layout[id]??frames[id];if(!box)continue;
      for(const parent of ancestors(id)){
        if(!offsets[parent])continue;
        const viewport=frames[parent],current=next[parent],width=viewport.width-FRAME_SCROLLBAR,height=viewport.height-FRAME_SCROLLBAR;
        const x=box.x-viewport.x,y=box.y-viewport.y;
        const left=box.width>width?x+(box.width-width)/2:x<current.left?x:x+box.width>current.left+width?x+box.width-width:current.left;
        const top=box.height>height?y+(box.height-height)/2:y<current.top?y:y+box.height>current.top+height?y+box.height-height:current.top;
        const content=contents[parent];
        const scroll={left:Math.max(0,Math.min(left,content.width-width)),top:Math.max(0,Math.min(top,content.height-height))};
        next[parent]=scroll;
        // Reveal the visible part of the destination through each outer frame,
        // even when the inner frame itself is larger than its parent's viewport.
        box=intersectFrameRects({...box,x:box.x-scroll.left,y:box.y-scroll.top},{...viewport,width,height});
      }
    }
    return next;
  };
  return {layout:displayLayout,frameRects,contentRects:contents,viewports,offsets,clips,clipFor,extent,reveal,ancestors};
}

/** Cards stay in their frame; directed connections use the endpoints' common viewport. */
export function createFrameClipResolver(views:ReturnType<typeof projectFrameViewports>,edges:DemoEdge[]){
  const byOwner=new Map<string,DemoEdge[]>(),byId=new Map(edges.map(edge=>[edge.id,edge]));
  const memberships=new Map<string,string[]>();
  for(const edge of edges){
    const own=byOwner.get(edge.relationMessageId)??[];own.push(edge);byOwner.set(edge.relationMessageId,own);
    if(getPresentationSpec(edge.relationType).isContainer){
      const parents=memberships.get(edge.to.messageId)??[];parents.push(edge.relationMessageId);memberships.set(edge.to.messageId,parents);
    }
  }
  const ancestors=(id:string,seen=new Set<string>()):string[]=>{
    if(seen.has(id))return [];seen.add(id);
    if(views.layout[id]||views.frameRects[id])return views.ancestors(id);
    const parent=memberships.get(id)?.[0];
    if(parent)return [parent,...views.ancestors(parent)];
    const edge=byOwner.get(id)?.[0];if(!edge)return [];
    const target=['agree','disagree','tag','correct'].includes(edge.relationType)||getPresentationSpec(edge.relationType).kind==='inline-badge'||edge.from.messageId.startsWith('anon:');
    return ancestors(target?edge.to.messageId:edge.from.messageId,seen);
  };
  const edgeClip=(edge:DemoEdge)=>{
    const targetAncestors=new Set(ancestors(edge.to.messageId));
    let clip:Box|undefined;
    for(const parent of ancestors(edge.from.messageId)){
      const viewport=views.viewports[parent];
      if(viewport&&targetAncestors.has(parent))clip=clip?intersectFrameRects(clip,viewport):viewport;
    }
    return clip;
  };
  const resolve=(id:string,edgeId?:string,seen=new Set<string>()):Box|undefined=>{
    const specified=edgeId?byId.get(edgeId):undefined;
    if(specified&&!specified.from.messageId.startsWith('anon:')&&getPresentationSpec(specified.relationType).kind==='edge-label')return edgeClip(specified);
    const own=views.clipFor(id);
    if(own||views.layout[id]||views.frameRects[id]||seen.has(id))return own;
    seen.add(id);
    // A relation need not have a card to be a member of the expanded frame.
    for(const parent of memberships.get(id)??[]){
      const viewport=views.viewports[parent];if(viewport)return views.extent(parent,viewport);
      const clip=resolve(parent,undefined,new Set(seen));if(clip)return clip;
    }
    for(const edge of specified?[specified]:byOwner.get(id)??[]){
      const kind=getPresentationSpec(edge.relationType).kind;
      if(!specified&&(['agree','disagree','tag','correct'].includes(edge.relationType)||kind==='inline-badge'))return resolve(edge.to.messageId,undefined,seen);
      const source=edge.from.messageId;
      if(!source.startsWith('anon:')&&source!==id)return resolve(source,undefined,seen);
      return resolve(edge.to.messageId,undefined,seen);
    }
    return undefined;
  };
  return (id:string,edgeId?:string)=>resolve(id,edgeId);
}

/** Cross-frame arrows require both anchors to be visible in their own frames. */
export function frameConnectionVisible(clipFor:(id:string)=>Box|undefined,edge:DemoEdge,start:{x:number;y:number},end:{x:number;y:number}):boolean{
  const source=clipFor(edge.from.messageId),target=clipFor(edge.to.messageId);
  // Connections within a single viewport are clipped together with its cards.
  if(source&&target&&source.x===target.x&&source.y===target.y&&source.width===target.width&&source.height===target.height)return true;
  const contains=(clip:Box|undefined,point:{x:number;y:number})=>!clip||clip.width>0&&clip.height>0
    &&point.x>=clip.x-1&&point.x<=clip.x+clip.width+1&&point.y>=clip.y-1&&point.y<=clip.y+clip.height+1;
  return contains(source,start)&&contains(target,end);
}
