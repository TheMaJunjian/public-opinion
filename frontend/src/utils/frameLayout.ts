import type { DemoEdge, DemoMessage } from './modelBridge';
import type { RelationTargetLayout } from '../types';
import { CARD_W, MIN_CARD_H, GRID_LEFT, GRID_TOP, COL_GAP, ROW_GAP, FRAME_PAD, MERGE_CARD_H, CANVAS_BOTTOM_PAD } from './layout';
import { siblingColumns, type ColumnConstraints } from './graphSiblingColumns';
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
export interface SceneLayoutInput {
  normals: DemoMessage[];
  colOf: Record<string, number>;
  measuredHeights: Record<string, number>;
  measuredWidths: Record<string, number>;
  maxCol: number;
  correctedTargetIds?: Set<string>;
  frameBlocks?: FrameBlock[];
  allMessages: DemoMessage[];
  activeTextSelectId?: string | null;
  traceMode?: boolean;
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
  for (const edge of input.edges ?? []) {
    if (!['annotation', 'reference', 'notify', 'agree', 'disagree', 'reply'].includes(edge.relationType)) continue;
    const source = ancestry(edge.from.messageId);
    if (!source.length) continue;
    // A reference to an arrow still depends on both endpoints of that arrow.
    // Expand only layout anchors; preserve the selected relation's identity.
    const targets = new Set<string>(), visited = new Set<string>(), queue = [edge.to.messageId];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      if (visited.has(id)) continue;
      visited.add(id);
      if (cards.has(id) || frames.has(id)) { targets.add(id); continue; }
      if (edge.relationType === 'agree' || edge.relationType === 'disagree') continue;
      for (const own of edgesByRelation.get(id) ?? []) for (const endpoint of [own.from.messageId, own.to.messageId])
        if (!endpoint.startsWith('anon:')) queue.push(endpoint);
    }
    for (const anchor of targets) {
      const target = ancestry(anchor), targetAncestors = new Set(target), scope = source.find(id => targetAncestors.has(id));
      const sourceId = scope ? source[source.indexOf(scope) - 1] : source.at(-1);
      const targetId = scope ? target[target.indexOf(scope) - 1] : target.at(-1);
      if (!sourceId || !targetId || sourceId === targetId) continue;
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
  const order = (a: Item, b: Item) => a.time - b.time || a.id.localeCompare(b.id);
  const positionsForScope = (items: Item[], scope: string | undefined, compact = true) => {
    if (!input.edges) return siblingColumns(items, [], compact);
    const localEdges = scopeEdges.get(scope) ?? [];
    const normals = items.map(item => messages.get(item.id) ?? { id: item.id, author: '', createdAt: '', content: '', kind: 'normal' as const });
    const relIds = new Set<string>();
    const base = computeMinColumnsForAnnoRefRule1(items.map(item => item.id), localEdges, relIds);
    const reply = applyReplyLayoutAdjustmentsWithConstraints({ normals, edges: localEdges, baseCol: base.col, baseMaxCol: base.maxCol, relIds });
    const stance = applyAgreeDisagreeColumnOverride({ normals, edges: localEdges, ...reply });
    return siblingColumns(items.map(item => ({ ...item, column: stance.col[item.id] ?? 0 })), scopeConstraints.get(scope) ?? [], compact);
  };
  const cache = new Map<string, Item>();
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
    if(declared&&(frame.targetLayout==='single-row'||frame.targetLayout==='single-column')) {
      const positions=new Map([...frame.cardIds].map((member,index)=>[member,index]));
      children.sort((a,b)=>(positions.get(a.id)??Infinity)-(positions.get(b.id)??Infinity)||order(a,b));
    } else children.sort(order);
    const positions = positionsForScope(children, id);
    item.column = Math.min(...children.map(child => child.column), item.column);
    item.time = children.length ? Math.min(item.time, ...children.map(child => child.time)) : item.time;
    item.header = frame.hasGroupHeader ? Math.max(56, input.measuredHeights[id] ?? 56) : 0;
    const insideHeader = frame.isMerge || frame.hasCardHeader ? Math.max(MERGE_CARD_H, input.measuredHeights[id] ?? MERGE_CARD_H) + 8 : 0;
    const top = item.header + FRAME_PAD + insideHeader;
    const frontier = new Frontier();
    let right = GRID_LEFT + CARD_W;
    let bottom = top;
    let rowX = GRID_LEFT;
    for (const child of children) {
      const horizontal = !frame.isMerge && frame.targetLayout === 'single-row';
      const x = horizontal ? rowX : positions.xById.get(child.id)!;
      const y = horizontal ? top : frontier.top(x, child.width, top);
      item.children.push({ item: child, x, y, column: horizontal ? item.children.length : positions.columns.get(child.id)! });
      frontier.add(x, child.width, y + child.height + ROW_GAP);
      rowX = x + child.width + COL_GAP;
      right = Math.max(right, x + child.width);
      bottom = Math.max(bottom, y + child.height);
    }
    item.width = Math.max(right + GRID_LEFT, (input.measuredWidths[id] ?? CARD_W) + 24);
    item.height = bottom + FRAME_PAD;
    return item;
  };
  const roots: Item[] = [];
  for (const frame of frames.values()) if (!parents.has(frame.relMsgId)) roots.push(measure(frame.relMsgId));
  for (const card of cards.values()) if (!owners.has(card.id) && !frames.has(card.id)) roots.push(measure(card.id));
  roots.sort(order);
  const rootByMember = new Map<string, Item>();
  const indexRoot = (item: Item, root: Item) => {
    rootByMember.set(item.id, root);
    item.children.forEach(child => indexRoot(child.item, root));
  };
  roots.forEach(root => indexRoot(root, root));
  const layout: Record<string, Box> = {};
  const frameRects: Record<string, Box> = {};
  const colOf = { ...input.colOf };
  const placementOrder: string[] = [];
  const emit = (item: Item, x: number, y: number, column: number) => {
    placementOrder.push(item.id);
    colOf[item.id] = column;
    if (item.frame) {
      frameRects[item.id] = { x, y: y + item.header, width: item.width, height: item.height - item.header };
    } else layout[item.id] = { x, y, width: item.width, height: item.height };
    item.children.forEach(child => emit(child.item, x + child.x, y + child.y, column + child.column));
  };
  const componentParent = new Map(roots.map(root => [root.id, root.id]));
  const find = (id: string): string => {
    let root = id;
    while (componentParent.get(root) !== root) root = componentParent.get(root)!;
    while (id !== root) { const next = componentParent.get(id)!; componentParent.set(id, root); id = next; }
    return root;
  };
  const anchors = new Map<string, Set<string>>();
  for (const edge of [...input.edges ?? [], ...scopeEdges.get(undefined) ?? []]) {
    const source = rootByMember.get(edge.from.messageId);
    const target = rootByMember.get(edge.to.messageId);
    if (!source || !target || source === target) continue;
    componentParent.set(find(source.id), find(target.id));
    const targets = anchors.get(source.id) ?? new Set<string>();
    targets.add(target.id); anchors.set(source.id, targets);
  }
  const components = new Map<string, Item[]>();
  for (const root of roots) {
    // Direct callers without relation data retain the simple column packing API.
    const key = input.edges ? find(root.id) : 'scene';
    const members = components.get(key) ?? [];
    members.push(root); components.set(key, members);
  }
  let bottom = GRID_TOP;
  const occupied = new Frontier();
  const orderedComponents = [...components.values()];
  if (input.structureOrder) {
    const ranks = new Map(input.structureOrder.map((id, index) => [id, index]));
    const rootRanks = new Map<string, number>();
    for (const [id, root] of rootByMember) {
      rootRanks.set(root.id, Math.min(rootRanks.get(root.id) ?? Infinity, ranks.get(id) ?? Infinity));
    }
    const rank = (component: Item[]) => component.reduce((minimum, item) => Math.min(minimum, rootRanks.get(item.id) ?? Infinity), Infinity);
    orderedComponents.sort((a, b) => rank(a) - rank(b));
  }
  for (const component of orderedComponents) {
    // Column numbers express ordering, not reserved empty screen space. Each
    // discussion starts at the left and occupies only its visible columns.
    const positions = positionsForScope(component, undefined, !!input.edges);
    const xByRoot = positions.xById;
    const frontier = new Frontier();
    const placedY = new Map<string, number>();
    for (const root of component) {
      const x = xByRoot.get(root.id)!;
      let preferredY = 0;
      for (const target of anchors.get(root.id) ?? []) preferredY = Math.max(preferredY, placedY.get(target) ?? 0);
      const y = frontier.top(x, root.width, preferredY);
      placedY.set(root.id, y);
      frontier.add(x, root.width, y + root.height + ROW_GAP);
    }
    // Place the whole discussion without splitting its aligned stance rows.
    // Only the intervals it actually occupies block subsequent discussions.
    let top = GRID_TOP;
    for (const root of component) {
      top = Math.max(top, occupied.top(xByRoot.get(root.id)!, root.width, GRID_TOP) - placedY.get(root.id)!);
    }
    for (const root of component) {
      const x = xByRoot.get(root.id)!;
      const y = top + placedY.get(root.id)!;
      emit(root, x, y, positions.columns.get(root.id)!);
      occupied.add(x, root.width, y + root.height + ROW_GAP);
      bottom = Math.max(bottom, y + root.height);
    }
  }
  return { layout, frameRects, colOf, canvasHeight: bottom + CANVAS_BOTTOM_PAD, measuredFrames, placementOrder };
}
