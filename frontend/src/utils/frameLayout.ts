import type { DemoEdge, DemoMessage } from './modelBridge';
import type { RelationTargetLayout } from '../types';
import { CARD_W, MIN_CARD_H, GRID_LEFT, GRID_TOP, COL_GAP, ROW_GAP, FRAME_PAD, MERGE_CARD_H, CANVAS_BOTTOM_PAD } from './layout';
import { siblingColumns, type ColumnConstraints } from './graphSiblingColumns';
import { chronologicalOrder, discussionForest } from './discussionOrder';
import { computeMinColumnsForAnnoRefRule1, applyReplyLayoutAdjustmentsWithConstraints, applyAgreeDisagreeColumnOverride } from './graphColumnRules';

export interface FrameBlock {
  relMsgId: string;
  cardIds: Set<string>;
  directCardIds: Set<string>;
  childRelMsgIds: string[];
  isMerge: boolean;
  hasCardHeader?: boolean;
  hasGroupHeader: boolean;
  targetLayout?: RelationTargetLayout;
}
export interface Box { x: number; y: number; width: number; height: number }
export interface FrameViewSize {width:number;height:number}
// Initial viewports fit about two cards across and two text rows; manual sizes are unrestricted.
export const INITIAL_FRAME_MAX_WIDTH=CARD_W*2+COL_GAP+GRID_LEFT*2+FRAME_PAD;
export const INITIAL_FRAME_MAX_HEIGHT=160*2+ROW_GAP+FRAME_PAD*2+14;
export interface SceneLayoutInput {
  normals: DemoMessage[];
  colOf: Record<string, number>;
  measuredHeights: Record<string, number>;
  measuredWidths: Record<string, number>;
  maxCol: number;
  correctedTargetIds?: Set<string>;
  frameBlocks?: FrameBlock[];
  frameViewSizes?: Readonly<Record<string,FrameViewSize>>;
  availableFrameWidth?:number;
  allMessages: DemoMessage[];
  activeTextSelectId?: string | null;
  traceMode?: boolean;
  frameFullOverrides?: Record<string,boolean>;
  edges?: DemoEdge[];
  /** Keep complete loading units contiguous even when relation records have no card. */
  structureOrder?: string[];
}
interface Item {
  id: string;
  width: number;
  height: number;
  column: number;
  time: number;
  frame?: FrameBlock;
  header: number;
  contentWidth?:number;
  contentHeight?:number;
  children: Array<{ item: Item; x: number; y: number; column: number }>;
}

/** A skyline stores only occupied horizontal intervals, never every prior card. */
class Frontier {
  private spans: Array<{ left: number; right: number; bottom: number }> = [];
  top(left: number, width: number, minimum: number): number {
    let top = minimum;
    for (const span of this.spans) {
      if (span.left >= left + width) break;
      if (span.right > left) top = Math.max(top, span.bottom);
    }
    return top;
  }
  add(left: number, width: number, bottom: number) {
    const right = left + width;
    const next: typeof this.spans = [];
    for (const span of this.spans) {
      if (span.right <= left || span.left >= right) next.push(span);
      else {
        if (span.left < left) next.push({ ...span, right: left });
        if (span.right > right) next.push({ ...span, left: right });
      }
    }
    next.push({ left, right, bottom });
    next.sort((a, b) => a.left - b.left);
    this.spans = next;
  }
}

/** Measure each organization once, then place immutable blocks and emit their cards once. */
export function computeSceneLayout(input: SceneLayoutInput) {
  const messages = new Map(input.allMessages.map(message => [message.id, message]));
  const cards = new Map(input.normals.filter(message => !input.correctedTargetIds?.has(message.id))
    .map(message => [message.id, message]));
  const frames = new Map((input.frameBlocks ?? []).map(frame => [frame.relMsgId, frame]));
  const parents = new Map<string, string>();
  // Resolve one parent without modifying the caller's frame projection. A malformed
  // cycle remains a root/trace instead of entering an unbounded recursive layout.
  for (const frame of frames.values()) for (const child of frame.childRelMsgIds) {
    if (!frames.has(child) || child === frame.relMsgId || parents.has(child)) continue;
    let ancestor: string | undefined = frame.relMsgId;
    const visited = new Set<string>();
    while (ancestor && ancestor !== child && !visited.has(ancestor)) {
      visited.add(ancestor); ancestor = parents.get(ancestor);
    }
    if (!ancestor) parents.set(child, frame.relMsgId);
  }
  const owners = new Map<string, string>();
  for (const frame of frames.values()) for (const id of frame.directCardIds) {
    if (id !== frame.relMsgId && cards.has(id) && !frames.has(id) && !owners.has(id)) owners.set(id, frame.relMsgId);
  }
  // Resolve both endpoints to siblings in their nearest shared container. The
  // original endpoints remain intact for selection, statistics and arrow routing.
  const scopeConstraints = new Map<string | undefined, ColumnConstraints>();
  const scopeEdges = new Map<string | undefined, DemoEdge[]>();
  const edgesByRelation = new Map<string, DemoEdge[]>();
  for (const edge of input.edges ?? []) {
    const own = edgesByRelation.get(edge.relationMessageId) ?? [];
    own.push(edge); edgesByRelation.set(edge.relationMessageId, own);
  }
  const ancestry = (id: string): string[] => {
    const chain: string[] = [], visited = new Set<string>();
    if (!cards.has(id) && !frames.has(id)) return chain;
    let current: string | undefined = id;
    while (current && !visited.has(current)) {
      chain.push(current); visited.add(current); current = owners.get(current) ?? parents.get(current);
    }
    return chain;
  };
  const classifications=[...messages.values()].filter(message=>message.relationType==='classify');
  const onlyClassification=classifications.length===1?classifications[0].id:undefined;
  const automaticFullFrame=input.traceMode&&onlyClassification&&frames.get(onlyClassification)?.hasGroupHeader
    &&[...cards.keys(),...frames.keys()].every(id=>ancestry(id).includes(onlyClassification))?[onlyClassification]:[];
  const fullFrameIds=[...frames.values()].filter(frame=>frame.hasGroupHeader&&(input.frameFullOverrides?.[frame.relMsgId]??automaticFullFrame.includes(frame.relMsgId))).map(frame=>frame.relMsgId);
  const fullFrames=new Set(fullFrameIds);
  for (const edge of input.edges ?? []) {
    if (!['annotation', 'reference', 'notify', 'agree', 'disagree', 'reply'].includes(edge.relationType)) continue;
    const source = ancestry(edge.from.messageId);
    if (!source.length) continue;
    // An arrow is placed with its own source. Its other dependencies remain
    // available to routing, without becoming additional placement parents.
    const targets = new Set<string>(), visited = new Set<string>(), queue = [edge.to.messageId];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      if (visited.has(id)) continue;
      visited.add(id);
      if (cards.has(id) || frames.has(id)) { targets.add(id); break; }
      if (edge.relationType === 'agree' || edge.relationType === 'disagree') continue;
      const own=edgesByRelation.get(id)??[];
      const byTime=(a:string,b:string)=>chronologicalOrder(messages.get(a)??{id:a,createdAt:''},messages.get(b)??{id:b,createdAt:''});
      const sources=[...new Set(own.map(edge=>edge.from.messageId))].filter(source=>source!==id&&!source.startsWith('anon:')).sort(byTime);
      const dependencies=[...new Set(own.map(edge=>edge.to.messageId))].filter(target=>target!==id&&!target.startsWith('anon:')).sort(byTime);
      queue.push(...sources,...dependencies);
    }
    for (const anchor of targets) {
      const target = ancestry(anchor), targetAncestors = new Set(target), scope = source.find(id => targetAncestors.has(id));
      const sourceId = scope ? source[source.indexOf(scope) - 1] : source.at(-1);
      const targetId = scope ? target[target.indexOf(scope) - 1] : target.at(-1);
      if (!sourceId || !targetId || sourceId === targetId) continue;
      // External relationships move the sibling frame as one immutable block;
      // only relationships within that frame can change its member positions.
      const relationType = edge.relationType === 'reply' && anchor !== edge.to.messageId ? 'reference' : edge.relationType;
      const localEdges = scopeEdges.get(scope) ?? [];
      localEdges.push({ ...edge, relationType, from: { ...edge.from, messageId: sourceId }, to: { ...edge.to, messageId: targetId } });
      scopeEdges.set(scope, localEdges);
      if (relationType === 'reply' && !frames.has(edge.to.messageId)) continue;
      const constraints = scopeConstraints.get(scope) ?? [];
      constraints.push(relationType === 'agree' ? [sourceId, targetId] : [targetId, sourceId]);
      scopeConstraints.set(scope, constraints);
    }
  }
  const time = (id: string) => {
    const result = Date.parse(messages.get(id)?.createdAt ?? '');
    return Number.isFinite(result) ? result : 0;
  };
  const order = (a: Item, b: Item) => a.time - b.time
    || (messages.get(a.id)?.sequence ?? 0) - (messages.get(b.id)?.sequence ?? 0) || a.id.localeCompare(b.id);
  const discussionPlacement=(items:Item[],scope:string|undefined)=>{
    if(!input.edges)return {groups:[items],constraintGroups:[items],edges:[],parent:new Map<string,string>()};
    const byId=new Map(items.map(item=>[item.id,item]));
    const localEdges=scopeEdges.get(scope)??[];
    const forest=discussionForest(items.map(item=>({id:item.id,createdAt:new Date(item.time).toISOString(),sequence:messages.get(item.id)?.sequence})),localEdges,messages);
    // Reading keeps its primary forest, while every hard constraint can join
    // placement components and propagate a shift through the affected chain.
    const component=forest.groups.map((_,index)=>index),groupById=new Map(forest.groups.flatMap((group,index)=>group.map(id=>[id,index] as const)));
    const root=(index:number):number=>{while(component[index]!==index){component[index]=component[component[index]];index=component[index];}return index;};
    for(const [left,right] of scopeConstraints.get(scope)??[]){
      const a=groupById.get(left),b=groupById.get(right);if(a===undefined||b===undefined)continue;
      const first=root(a),second=root(b);if(first!==second)component[second]=first;
    }
    const groups=new Map<number,Item[]>();
    forest.groups.forEach((group,index)=>{const key=root(index),values=groups.get(key)??[];values.push(...group.map(id=>byId.get(id)!));groups.set(key,values);});
    return {groups:forest.groups.map(group=>group.map(id=>byId.get(id)!)),constraintGroups:[...groups.values()],parent:forest.parent,
      edges:localEdges.filter(edge=>forest.parent.get(edge.from.messageId)===edge.to.messageId)};
  };
  const positionsForScope = (items: Item[], scope: string | undefined, compact = true, placementEdges?: DemoEdge[]) => {
    if (!input.edges) return siblingColumns(items, [], compact);
    const localIds=new Set(items.map(item=>item.id));
    const localEdges = (placementEdges ?? discussionPlacement(items,scope).edges).filter(edge=>localIds.has(edge.from.messageId)&&localIds.has(edge.to.messageId));
    // Author/reply lane preferences belong to each primary discussion. A new
    // bridge adds constraints without importing another discussion's history.
    const forest=discussionForest(items.map(item=>({id:item.id,createdAt:new Date(item.time).toISOString(),sequence:messages.get(item.id)?.sequence})),localEdges,messages);
    const columns:Record<string,number>={};
    for(const group of forest.groups){
      const ids=new Set(group),groupEdges=localEdges.filter(edge=>ids.has(edge.from.messageId)&&ids.has(edge.to.messageId));
      const normals=group.map(id=>messages.get(id)??{id,author:'',createdAt:'',content:'',kind:'normal' as const}),relIds=new Set<string>();
      const base=computeMinColumnsForAnnoRefRule1(group,groupEdges,relIds);
      const reply=applyReplyLayoutAdjustmentsWithConstraints({normals,edges:groupEdges,baseCol:base.col,baseMaxCol:base.maxCol,relIds});
      const stance=applyAgreeDisagreeColumnOverride({normals,edges:groupEdges,...reply});
      Object.assign(columns,stance.col);
    }
    const constraints=(scopeConstraints.get(scope)??[]).filter(([left,right])=>localIds.has(left)&&localIds.has(right));
    return siblingColumns(items.map(item => ({ ...item, column: columns[item.id] ?? 0 })), constraints, compact);
  };
  const cache = new Map<string, Item>();
  const widthBudgets=new Map<string,number|undefined>();
  const widthBudget=(id:string):number|undefined=>{
    if(fullFrames.has(id))return undefined;
    if(widthBudgets.has(id))return widthBudgets.get(id);
    const own=input.frameViewSizes?.[id]?.width,parent=parents.get(id),available=parent?widthBudget(parent):input.availableFrameWidth;
    const automatic=available===undefined?undefined:Math.max(240,available-GRID_LEFT*2-(parent?FRAME_PAD:0));
    const width=own??(automatic===undefined?undefined:frames.get(id)?.hasGroupHeader?Math.min(automatic,INITIAL_FRAME_MAX_WIDTH):automatic);
    widthBudgets.set(id,width);return width;
  };
  const frameViewportSizes:Record<string,FrameViewSize>={};
  let measuredFrames = 0;
  const measure = (id: string): Item => {
    const cached = cache.get(id);
    if (cached) return cached;
    const frame = frames.get(id);
    const item: Item = {
      id, column: input.colOf[id] ?? 0, time: time(id), frame,
      width: Math.max(CARD_W, input.measuredWidths[id] ?? CARD_W),
      height: Math.max(MIN_CARD_H, input.measuredHeights[id] ?? MIN_CARD_H),
      header: 0, children: [],
    };
    cache.set(id, item);
    if (!frame) return item;
    measuredFrames++;
    const children: Item[] = [];
    for (const child of frame.directCardIds) if (owners.get(child) === id) children.push(measure(child));
    for (const child of frame.childRelMsgIds) if (parents.get(child) === id) children.push(measure(child));
    const declared=messages.get(id)?.parts?.some(part=>part.type==='display');
    const explicitOrder=declared&&(frame.targetLayout==='single-row'||frame.targetLayout==='single-column');
    if(explicitOrder) {
      const positions=new Map([...frame.cardIds].map((member,index)=>[member,index]));
      children.sort((a,b)=>(positions.get(a.id)??Infinity)-(positions.get(b.id)??Infinity)||order(a,b));
    } else children.sort(order);
    const placement=discussionPlacement(children,id);
    const frameOrderConstraint=(scopeConstraints.get(id)??[]).some(([left,right])=>frames.has(left)||frames.has(right));
    const keepDeclaredOrder=explicitOrder&&!frameOrderConstraint&&(!fullFrames.has(id)||placement.edges.length===0);
    const positions = positionsForScope(children, id, true, placement.edges);
    item.column = Math.min(...children.map(child => child.column), item.column);
    item.time = children.length ? Math.min(item.time, ...children.map(child => child.time)) : item.time;
    item.header = frame.hasGroupHeader ? Math.max(56, input.measuredHeights[id] ?? 56) : 0;
    const insideHeader = frame.isMerge || frame.hasCardHeader ? Math.max(MERGE_CARD_H, input.measuredHeights[id] ?? MERGE_CARD_H) + 8 : 0;
    const top = item.header + FRAME_PAD + insideHeader;
    const viewport=fullFrames.has(id)?undefined:input.frameViewSizes?.[id];
    const availableWidth=viewport?.width??widthBudget(id);
    const responsive=availableWidth!==undefined&&frame.hasGroupHeader;
    const frontier = new Frontier();
    let right = GRID_LEFT + CARD_W;
    let bottom = top;
    let rowX = GRID_LEFT;
    const placedY = new Map<string, number>(), targetsBySource = new Map<string, Set<string>>();
    for (const edge of placement.edges) {
      const targets = targetsBySource.get(edge.from.messageId) ?? new Set<string>();
      targets.add(edge.to.messageId); targetsBySource.set(edge.from.messageId, targets);
    }
    if(responsive){
      // Wrap independent discussions, preserving the source/target columns
      // inside each discussion even when a saved flow lists the source first.
      const groups=placement.constraintGroups;
      const available=Math.max(0,availableWidth-GRID_LEFT*2-FRAME_PAD);
      let rowY=top,rowHeight=0,rowColumn=0;
      for(const group of groups){
        const positions=positionsForScope(group,id,true,placement.edges),local=new Frontier();
        const placed:typeof item.children=[];let groupWidth=0,groupHeight=0;
        const ys=new Map<string,number>();
        for(const child of group){
          const x=(positions.xById.get(child.id)??GRID_LEFT)-GRID_LEFT;
          let minimum=0;
          for(const target of targetsBySource.get(child.id)??[])minimum=Math.max(minimum,ys.get(target)??0);
          const y=local.top(x,child.width,minimum);ys.set(child.id,y);local.add(x,child.width,y+child.height+ROW_GAP);
          placed.push({item:child,x,y,column:positions.columns.get(child.id)??0});
          groupWidth=Math.max(groupWidth,x+child.width);groupHeight=Math.max(groupHeight,y+child.height);
        }
        if(rowX>GRID_LEFT&&rowX-GRID_LEFT+groupWidth>available){rowX=GRID_LEFT;rowY+=rowHeight+ROW_GAP;rowHeight=0;rowColumn=0;}
        for(const child of placed)item.children.push({...child,x:rowX+child.x,y:rowY+child.y,column:rowColumn+child.column});
        right=Math.max(right,rowX+groupWidth);bottom=Math.max(bottom,rowY+groupHeight);
        rowX+=groupWidth+COL_GAP;rowHeight=Math.max(rowHeight,groupHeight);
        rowColumn+=Math.max(0,...placed.map(child=>child.column))+1;
      }
    }else for (const child of keepDeclaredOrder?children:placement.groups.flat()) {
      const horizontal = !frame.isMerge && !frameOrderConstraint && frame.targetLayout === 'single-row'&&(!fullFrames.has(id)||placement.edges.length===0);
      const vertical = keepDeclaredOrder && frame.targetLayout === 'single-column';
      const x = horizontal ? rowX : vertical ? GRID_LEFT : positions.xById.get(child.id)!;
      let minimum = top;
      if (!keepDeclaredOrder) for (const target of targetsBySource.get(child.id) ?? []) minimum = Math.max(minimum, placedY.get(target) ?? top);
      const y = horizontal ? top : frontier.top(x, child.width, minimum);
      item.children.push({ item: child, x, y, column: horizontal ? item.children.length : vertical ? 0 : positions.columns.get(child.id)! });
      placedY.set(child.id, y);
      frontier.add(x, child.width, y + child.height + ROW_GAP);
      rowX = x + child.width + COL_GAP;
      right = Math.max(right, x + child.width);
      bottom = Math.max(bottom, y + child.height);
    }
    item.width = Math.max(right + GRID_LEFT, (input.measuredWidths[id] ?? CARD_W) + 24);
    item.height = bottom + FRAME_PAD;
    item.contentWidth=item.width;item.contentHeight=item.height-item.header;
    const firstRows=new Set([...new Set(item.children.map(child=>child.y))].sort((a,b)=>a-b).slice(0,2));
    const twoRowHeight=Math.max(0,...item.children.filter(child=>firstRows.has(child.y)).map(child=>child.y+child.item.height-item.header+FRAME_PAD+14));
    const effectiveViewport=viewport??(frame.hasGroupHeader&&availableWidth!==undefined?{
      width:Math.min(availableWidth,item.contentWidth+14),height:Math.max(120,Math.min(item.contentHeight+14,twoRowHeight||Infinity,INITIAL_FRAME_MAX_HEIGHT)),
    }:undefined);
    if(effectiveViewport){
      item.width=Math.max(240,effectiveViewport.width);item.height=item.header+Math.max(120,effectiveViewport.height);
      frameViewportSizes[id]={width:item.width,height:item.height-item.header};
    }
    return item;
  };
  const roots: Item[] = [];
  for (const frame of frames.values()) if (!parents.has(frame.relMsgId)) roots.push(measure(frame.relMsgId));
  for (const card of cards.values()) if (!owners.has(card.id) && !frames.has(card.id)) roots.push(measure(card.id));
  roots.sort(order);
  const rootByMember = new Map<string, Item>();
  const offsetByMember = new Map<string, number>();
  const indexRoot = (item: Item, root: Item, offset = 0) => {
    rootByMember.set(item.id, root);
    offsetByMember.set(item.id, offset);
    item.children.forEach(child => indexRoot(child.item, root, offset + child.y));
  };
  roots.forEach(root => indexRoot(root, root));
  const layout: Record<string, Box> = {};
  const frameRects: Record<string, Box> = {};
  const frameContentRects: Record<string,Box> = {};
  const colOf = { ...input.colOf };
  const placementOrder: string[] = [];
  const emit = (item: Item, x: number, y: number, column: number) => {
    placementOrder.push(item.id);
    colOf[item.id] = column;
    if (item.frame) {
      frameRects[item.id] = { x, y: y + item.header, width: item.width, height: item.height - item.header };
      frameContentRects[item.id]={x,y:y+item.header,width:item.contentWidth??item.width,height:item.contentHeight??item.height-item.header};
    } else layout[item.id] = { x, y, width: item.width, height: item.height };
    item.children.forEach(child => emit(child.item, x + child.x, y + child.y, column + child.column));
  };
  const rootPlacement=discussionPlacement(roots,undefined);
  const anchors = new Map<string, Map<string, number>>();
  for (const edge of [...input.edges ?? [], ...scopeEdges.get(undefined) ?? []]) {
    const source = rootByMember.get(edge.from.messageId);
    const target = rootByMember.get(edge.to.messageId);
    if (!source || !target || source === target || source.id !== edge.from.messageId) continue;
    if(rootPlacement.parent.get(source.id)!==target.id)continue;
    const targets = anchors.get(source.id) ?? new Map<string, number>();
    targets.set(target.id, Math.max(targets.get(target.id) ?? 0, offsetByMember.get(edge.to.messageId) ?? 0));
    anchors.set(source.id, targets);
  }
  let bottom = GRID_TOP;
  const occupied = new Frontier();
  const structureRanks=new Map<string,number>();
  if (input.structureOrder) {
    const ranks = new Map(input.structureOrder.map((id, index) => [id, index]));
    const rootRanks = new Map<string, number>();
    for (const [id, root] of rootByMember) {
      rootRanks.set(root.id, Math.min(rootRanks.get(root.id) ?? Infinity, ranks.get(id) ?? Infinity));
      structureRanks.set(root.id,rootRanks.get(root.id)!);
    }
  }
  // Solve all constraints within each affected component. Frame widths remain
  // atomic, so moving a frame never stretches its internal member layout.
  const xByRoot=new Map<string,number>(),columns=new Map<string,number>();
  for(const component of rootPlacement.constraintGroups){
    const positions=positionsForScope(component,undefined,!!input.edges,rootPlacement.edges);
    positions.xById.forEach((x,id)=>xByRoot.set(id,x));positions.columns.forEach((column,id)=>columns.set(id,column));
  }
  const groups=rootPlacement.groups;
  if(input.structureOrder){
    const ranks=new Map(input.structureOrder.map((id,index)=>[id,index]));
    const rank=(group:Item[])=>Math.min(...group.map(item=>structureRanks.get(item.id)??ranks.get(item.id)??Infinity));
    groups.sort((a,b)=>rank(a)-rank(b));
  }
  const absoluteY=new Map<string,number>();
  for(const component of groups){
    const frontier=new Frontier(),placedY=new Map<string,number>();
    for(const root of component){
      const x=xByRoot.get(root.id)!;let preferredY=0;
      for(const [target,offset] of anchors.get(root.id)??[])if(placedY.has(target))preferredY=Math.max(preferredY,placedY.get(target)!+offset);
      const y=frontier.top(x,root.width,preferredY);
      placedY.set(root.id,y);frontier.add(x,root.width,y+root.height+ROW_GAP);
    }
    let top=GRID_TOP;
    for(const root of component){
      top=Math.max(top,occupied.top(xByRoot.get(root.id)!,root.width,GRID_TOP)-placedY.get(root.id)!);
      for(const [target,offset] of anchors.get(root.id)??[])if(absoluteY.has(target))top=Math.max(top,absoluteY.get(target)!+offset-placedY.get(root.id)!);
    }
    for(const root of component){
      const x=xByRoot.get(root.id)!,y=top+placedY.get(root.id)!;
      emit(root,x,y,columns.get(root.id)!);absoluteY.set(root.id,y);
      occupied.add(x,root.width,y+root.height+ROW_GAP);bottom=Math.max(bottom,y+root.height);
    }
  }
  return { layout, frameRects, frameContentRects, frameViewportSizes, fullFrameIds, colOf, canvasHeight: bottom + CANVAS_BOTTOM_PAD, measuredFrames, placementOrder };
}
