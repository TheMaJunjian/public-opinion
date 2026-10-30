import {describe,expect,it} from 'vitest';
import {computeSceneLayout,INITIAL_FRAME_MAX_WIDTH,INITIAL_FRAME_MAX_HEIGHT,type FrameBlock} from '../utils/frameLayout';
import {projectFrameViewports,createFrameClipResolver,frameConnectionVisible} from '../utils/frameViewports';
import type {DemoMessage,DemoEdge} from '../utils/modelBridge';
import {getGroupHeaderRect} from '../utils/graphPresentationGeometry';

const message=(id:string):DemoMessage=>({id,kind:'normal',author:'a',createdAt:'2026-01-01',content:id});
const frame=(id:string,members:string[],children:string[]=[]):FrameBlock=>({relMsgId:id,cardIds:new Set([...members,...children]),directCardIds:new Set(members),childRelMsgIds:children,isMerge:false,hasGroupHeader:true,targetLayout:'single-row'});
describe('temporary frame viewports',()=>{
  it('fully expands the only traced classification when every displayed message is inside it',()=>{
    const members=Array.from({length:10},(_,index)=>message(`member-${index}`));
    const group={...message('group'),kind:'relation' as const,relationType:'classify' as const};
    const input={normals:members,allMessages:[group,...members],edges:[],colOf:{},maxCol:0,measuredHeights:Object.fromEntries(members.map(message=>[message.id,150])),measuredWidths:{},availableFrameWidth:600,
      traceMode:true,frameViewSizes:{group:{width:300,height:120}},frameBlocks:[{...frame('group',members.map(message=>message.id)),targetLayout:'single-row' as const}]};
    const expanded=computeSceneLayout(input);
    expect(expanded.fullFrameIds).toEqual(['group']);
    expect(expanded.frameViewportSizes.group).toBeUndefined();
    expect(expanded.frameRects.group.width).toBeGreaterThan(3000);
    const outside=message('outside');
    const separate=computeSceneLayout({...input,normals:[...members,outside],allMessages:[group,...members,outside]});
    expect(separate.fullFrameIds).toEqual([]);expect(separate.frameViewportSizes.group.width).toBe(300);
    expect(computeSceneLayout({...input,traceMode:false}).fullFrameIds).toEqual([]);
    const second={...group,id:'second'};
    expect(computeSceneLayout({...input,allMessages:[group,second,...members]}).fullFrameIds).toEqual([]);
  });
  it.each(['single-column','single-row','multi-column'] as const)('preserves citation columns in a fully expanded classification (%s)',targetLayout=>{
    const source=message('source'),target=message('target');
    const group:DemoMessage={...message('group'),kind:'relation',relationType:'classify',parts:[{id:'display',type:'display',layout:targetLayout==='single-row'?'row':targetLayout==='single-column'?'flow':'columns',relationPartId:'members'}]};
    const citation:DemoEdge={id:'reference',relationMessageId:'reference',relationType:'reference',relationLabel:'引用',from:{messageId:'source',selection:{kind:'whole'}},to:{messageId:'target',selection:{kind:'whole'}}};
    const result=computeSceneLayout({normals:[source,target],allMessages:[group,source,target],edges:[citation],colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{},availableFrameWidth:500,traceMode:true,
      frameBlocks:[{...frame('group',['source','target']),targetLayout}]});
    expect(result.fullFrameIds).toEqual(['group']);
    expect(result.layout.source.x).toBeGreaterThan(result.layout.target.x);
    expect(result.layout.source.y).toBeGreaterThanOrEqual(result.layout.target.y);
    expect(result.frameViewportSizes.group).toBeUndefined();
  });
  it('clips local arrows while allowing directed connections to cross their source window',()=>{
    const layout={source:{x:30,y:180,width:320,height:90},target:{x:30,y:300,width:320,height:90},outside:{x:700,y:100,width:320,height:90}};
    const frames={group:{x:10,y:100,width:500,height:200}},contents={group:{...frames.group,height:900}};
    const views=projectFrameViewports(layout,frames,contents,[frame('group',['source','target'])],{group:{width:500,height:200}},{});
    const edge=(id:string,from:string,to:string):DemoEdge=>({id,relationMessageId:id,relationType:'reference',relationLabel:'引用',from:{messageId:from,selection:{kind:'whole'}},to:{messageId:to,selection:{kind:'whole'}}});
    const links=[edge('first','source','target'),edge('nested','source','first'),edge('external','source','outside'),edge('incoming','outside','source')];
    const clip=createFrameClipResolver(views,links);
    for(const id of ['first','nested'])expect(clip(id,id)).toEqual(views.viewports.group);
    expect(clip('external','external')).toBeUndefined();
    expect(clip('incoming','incoming')).toBeUndefined();
    const joined={...edge('group','anon:group','relation-member'),relationType:'classify' as const};
    expect(createFrameClipResolver(views,[...links,joined])('relation-member')).toEqual(views.viewports.group);
    const mixed=[{...edge('inside-edge','source','target'),relationMessageId:'shared'}, {...edge('outside-edge','outside','source'),relationMessageId:'shared'}];
    const perEdge=createFrameClipResolver(views,mixed);
    expect(perEdge('shared','inside-edge')).toEqual(views.viewports.group);expect(perEdge('shared','outside-edge')).toBeUndefined();
  });
  it('clips a connection between nested frames only to their shared outer viewport',()=>{
    const frames={outer:{x:0,y:0,width:900,height:600},left:{x:20,y:100,width:400,height:200},right:{x:450,y:100,width:400,height:200}};
    const layout={source:{x:40,y:160,width:320,height:900},target:{x:470,y:180,width:320,height:90}};
    const blocks=[frame('outer',[],['left','right']),frame('left',['source']),frame('right',['target'])];
    const views=projectFrameViewports(layout,frames,frames,blocks,frames,{});
    const citation:DemoEdge={id:'cross',relationMessageId:'cross',relationType:'reference',relationLabel:'引用',from:{messageId:'source',selection:{kind:'whole'}},to:{messageId:'target',selection:{kind:'whole'}}};
    expect(createFrameClipResolver(views,[citation])('cross','cross')).toEqual(views.viewports.outer);
  });
  it('hides an entire cross-frame connection until both anchors are visible',()=>{
    const frames={group:{x:10,y:100,width:500,height:200}},contents={group:{...frames.group,height:900}};
    const layout={source:{x:30,y:600,width:320,height:90},outside:{x:700,y:100,width:320,height:90}};
    const blocks=[frame('group',['source'])],sizes={group:{width:500,height:200}};
    const link:DemoEdge={id:'cross',relationMessageId:'cross',relationType:'reference',relationLabel:'引用',from:{messageId:'source',selection:{kind:'whole'}},to:{messageId:'outside',selection:{kind:'whole'}}};
    const before=projectFrameViewports(layout,frames,contents,blocks,sizes,{}),end={x:700,y:140};
    expect(frameConnectionVisible(createFrameClipResolver(before,[link]),link,{x:350,y:640},end)).toBe(false);
    const after=projectFrameViewports(layout,frames,contents,blocks,sizes,{group:{left:0,top:500}});
    expect(frameConnectionVisible(createFrameClipResolver(after,[link]),link,{x:350,y:140},end)).toBe(true);
    const incoming={...link,from:link.to,to:link.from};
    expect(frameConnectionVisible(createFrameClipResolver(before,[incoming]),incoming,end,{x:350,y:640})).toBe(false);
    // Even a partly visible tall card cannot leave an arrow from a hidden anchor.
    expect(frameConnectionVisible(createFrameClipResolver(before,[link]),link,{x:350,y:310},end)).toBe(false);
  });
  it('reveals the directed start near the bottom of a tall source through nested viewports',()=>{
    const layout={source:{x:800,y:500,width:320,height:1800}},frames={outer:{x:10,y:100,width:400,height:200},inner:{x:40,y:220,width:700,height:500}};
    const contents={outer:{...frames.outer,width:1000,height:1200},inner:{...frames.inner,width:1300,height:2400}};
    const blocks=[frame('outer',[],['inner']),frame('inner',['source'])],sizes={outer:{width:400,height:200},inner:{width:700,height:500}};
    const start={x:1104,y:2284,width:16,height:16},views=projectFrameViewports(layout,frames,contents,blocks,sizes,{});
    const next=views.reveal(['source'],new Map([['source',start]]));
    const after=projectFrameViewports(layout,frames,contents,blocks,sizes,next);
    const point={...start,x:start.x-next.inner.left-next.outer.left,y:start.y-next.inner.top-next.outer.top};
    const clip=after.clipFor('source')!;
    expect(point.x).toBeGreaterThanOrEqual(clip.x);expect(point.x+point.width).toBeLessThanOrEqual(clip.x+clip.width);
    expect(point.y).toBeGreaterThanOrEqual(clip.y);expect(point.y+point.height).toBeLessThanOrEqual(clip.y+clip.height);
    expect(next.inner.top).toBeGreaterThan(1300);
  });
  it.each(['classify','summary'] as const)('keeps tall %s members inside the initial height limit without removing their content',type=>{
    const members=Array.from({length:6},(_,index)=>({...message(`tall-${index}`),sequence:index+1}));
    const group:DemoMessage={...message('group'),kind:'relation',relationType:type};
    const result=computeSceneLayout({normals:members,allMessages:[group,...members],edges:[],colOf:{},maxCol:0,measuredHeights:Object.fromEntries(members.map(member=>[member.id,1000])),measuredWidths:{},availableFrameWidth:1500,
      frameBlocks:[{...frame('group',members.map(member=>member.id)),targetLayout:'multi-column'}]});
    expect(result.frameViewportSizes.group.height).toBe(INITIAL_FRAME_MAX_HEIGHT);
    expect(result.frameContentRects.group.height).toBeGreaterThan(INITIAL_FRAME_MAX_HEIGHT);
    expect(Object.keys(result.layout)).toHaveLength(members.length);
  });
  it.each(['classify','summary'] as const)('keeps the citation source after its target when a saved flow %s expands automatically',type=>{
    const source={...message('source'),createdAt:'2026-10-27'},target={...message('target'),createdAt:'2026-10-26'};
    const group:DemoMessage={...message('group'),kind:'relation',relationType:type,parts:[{id:'display',type:'display',layout:'flow',relationPartId:'members'}]};
    const citation:DemoEdge={id:'reference',relationMessageId:'reference',relationType:'reference',relationLabel:'引用',from:{messageId:'source',selection:{kind:'whole'}},to:{messageId:'target',selection:{kind:'whole'}}};
    for(const width of [500,1000,1500]){
      const result=computeSceneLayout({normals:[source,target],allMessages:[group,source,target],edges:[citation],colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{},availableFrameWidth:width,
        frameBlocks:[{...frame('group',['source','target']),targetLayout:'single-column'}]});
      expect(result.layout.source.x).toBeGreaterThan(result.layout.target.x);
      expect(result.layout.source.y).toBeGreaterThanOrEqual(result.layout.target.y);
    }
  });
  it.each((['classify','summary'] as const).flatMap(type=>(['flow','row','columns'] as const).map(display=>({type,display}))))('automatically flows an expanded $type ($display) into the available pane width before manual sizing',({type,display})=>{
    const members=Array.from({length:8},(_,index)=>({...message(`auto-${index}`),sequence:index+1}));
    const group:DemoMessage={...message('group'),kind:'relation',relationType:type,parts:[{id:'display',type:'display',layout:display,relationPartId:'members'}]};
    const input={normals:members,allMessages:[group,...members],edges:[],colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{},frameBlocks:[{...frame('group',members.map(member=>member.id)),targetLayout:display==='row'?'single-row' as const:display==='columns'?'multi-column' as const:'single-column' as const}]};
    for(const [available,columns] of [[500,1],[1000,2],[1500,2]]){
      const result=computeSceneLayout({...input,availableFrameWidth:available});
      expect(new Set(Object.values(result.layout).map(box=>box.x)).size).toBe(columns);
      expect(result.frameViewportSizes.group.width).toBeLessThanOrEqual(available);
      expect(result.frameViewportSizes.group.width).toBeLessThanOrEqual(INITIAL_FRAME_MAX_WIDTH);
      expect(result.frameViewportSizes.group.height).toBeLessThanOrEqual(INITIAL_FRAME_MAX_HEIGHT);
      const views=projectFrameViewports(result.layout,result.frameRects,result.frameContentRects,input.frameBlocks,result.frameViewportSizes,{});
      expect(Object.entries(views.layout).filter(([id,box])=>views.extent(id,box).height===box.height)).toHaveLength(columns*2);
      const header=getGroupHeaderRect(result.frameRects.group);expect(header.x).toBe(result.frameRects.group.x);expect(header.width).toBe(result.frameRects.group.width);
    }
    const enlarged=computeSceneLayout({...input,availableFrameWidth:1500,frameViewSizes:{group:{width:1500,height:900}}});
    expect(new Set(Object.values(enlarged.layout).map(box=>box.x)).size).toBe(3);
    expect(enlarged.frameViewportSizes.group).toEqual({width:1500,height:900});
  });
  it.each(['classify','summary'] as const)('uses additional columns when a legacy single-column %s frame is widened',type=>{
    const members=Array.from({length:6},(_,index)=>({...message(`member-${index}`),sequence:index+1}));
    const group:DemoMessage={...message('group'),kind:'relation',relationType:type,parts:[{id:'display',type:'display',layout:'flow',relationPartId:'members'}]};
    const blocks=[{...frame('group',members.map(member=>member.id)),targetLayout:'single-column' as const}];
    const input={normals:members,allMessages:[group,...members],edges:[],colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{},frameBlocks:blocks};
    const narrow=computeSceneLayout({...input,frameViewSizes:{group:{width:380,height:220}}});
    const wide=computeSceneLayout({...input,frameViewSizes:{group:{width:1000,height:220}}});
    expect(new Set(Object.values(narrow.layout).map(box=>box.x)).size).toBe(1);
    expect(new Set(Object.values(wide.layout).map(box=>box.x)).size).toBe(2);
    expect(wide.layout['member-0'].y).toBe(wide.layout['member-1'].y);
    expect(wide.frameContentRects.group.height).toBeLessThan(narrow.frameContentRects.group.height);
    expect(wide.layout['member-0'].width).toBe(320);
    expect(new Set(Object.values(computeSceneLayout(input).layout).map(box=>box.x)).size).toBe(1);
  });
  it('keeps an arrangement row and its member widths intact when its viewport is resized',()=>{
    const members=Array.from({length:12},(_,i)=>({...message(`member-${i}`),sequence:i+1})),blocks=[{...frame('group',members.map(m=>m.id)),hasGroupHeader:false}];
    const input={normals:members,allMessages:members,colOf:{},maxCol:0,measuredHeights:{},measuredWidths:{},frameBlocks:blocks};
    const natural=computeSceneLayout(input),resized=computeSceneLayout({...input,frameViewSizes:{group:{width:480,height:180}}});
    expect(natural.frameRects.group.width).toBeGreaterThan(4500);
    expect(new Set(Object.values(natural.layout).map(box=>box.x)).size).toBe(12);
    expect(resized.frameRects.group).toMatchObject({width:480,height:180});
    expect(resized.frameContentRects.group.width).toBe(natural.frameRects.group.width);
    expect(resized.layout['member-11']).toEqual(natural.layout['member-11']);
    const views=projectFrameViewports(resized.layout,resized.frameRects,resized.frameContentRects,blocks,{group:{width:480,height:180}},{});
    expect(views.extent('member-11',views.layout['member-11']).width).toBe(0);
    expect(views.reveal(['group',...members.map(member=>member.id)]).group.left).toBe(0);
    const next=views.reveal(['member-11']);expect(next.group.left).toBeGreaterThan(4000);
    const after=projectFrameViewports(resized.layout,resized.frameRects,resized.frameContentRects,blocks,{group:{width:480,height:180}},next);
    expect(after.extent('member-11',after.layout['member-11']).width).toBe(320);
  });
  it('clips nested members to both viewports and clamps scrolling after resizing',()=>{
    const layout={leaf:{x:400,y:800,width:320,height:90}},frames={outer:{x:10,y:100,width:500,height:400},inner:{x:40,y:220,width:400,height:200}};
    const contents={outer:{...frames.outer,width:900,height:1200},inner:{...frames.inner,width:800,height:900}};
    const blocks=[frame('outer',[],['inner']),frame('inner',['leaf'])],sizes={outer:{width:500,height:400},inner:{width:400,height:200}};
    const views=projectFrameViewports(layout,frames,contents,blocks,sizes,{outer:{left:0,top:80},inner:{left:120,top:500}});
    expect(views.layout.leaf).toMatchObject({x:280,y:220});
    expect(views.frameRects.inner.y).toBe(140);
    expect(views.clipFor('leaf')).toEqual({x:40,y:140,width:386,height:186});
    const limited=projectFrameViewports(layout,frames,contents,blocks,sizes,{outer:{left:10000,top:10000},inner:{left:-5,top:-5}});
    expect(limited.offsets.outer).toEqual({left:414,top:814});expect(limited.offsets.inner).toEqual({left:0,top:0});
  });
  it('reveals a destination through a larger inner frame without changing either viewport',()=>{
    const layout={leaf:{x:800,y:1600,width:320,height:90}},frames={outer:{x:10,y:100,width:400,height:200},inner:{x:40,y:220,width:700,height:500}};
    const contents={outer:{...frames.outer,width:1000,height:1200},inner:{...frames.inner,width:1300,height:1900}};
    const blocks=[frame('outer',[],['inner']),frame('inner',['leaf'])],sizes={outer:{width:400,height:200},inner:{width:700,height:500}};
    const views=projectFrameViewports(layout,frames,contents,blocks,sizes,{});
    const next=views.reveal(['leaf']);
    expect(next.inner.left).toBeGreaterThan(0);expect(next.inner.top).toBeGreaterThan(0);
    expect(next.outer.left).toBeGreaterThan(0);expect(next.outer.top).toBeGreaterThan(0);
    const after=projectFrameViewports(layout,frames,contents,blocks,sizes,next);
    expect(after.extent('leaf',after.layout.leaf)).toEqual(after.layout.leaf);
    for(const id of ['inner','outer'])expect(after.frameRects[id]).toMatchObject(sizes[id as keyof typeof sizes]);
  });
  it('centers an oversized message within a small viewport and clamps the requested scroll',()=>{
    const layout={leaf:{x:50,y:900,width:320,height:1000}},frames={group:{x:20,y:100,width:240,height:120}};
    const contents={group:{...frames.group,width:400,height:2000}},blocks=[frame('group',['leaf'])],sizes={group:{width:240,height:120}};
    const views=projectFrameViewports(layout,frames,contents,blocks,sizes,{}),next=views.reveal(['leaf']);
    const after=projectFrameViewports(layout,frames,contents,blocks,sizes,next),box=after.layout.leaf,viewport=after.viewports.group;
    expect(box.x+box.width/2).toBe(viewport.x+viewport.width/2);
    expect(box.y+box.height/2).toBe(viewport.y+viewport.height/2);
    expect(after.frameRects.group).toEqual(frames.group);
  });
});
