import type { DemoEdge, DemoMessage } from './modelBridge';
import type { RelationTargetLayout } from '../types';
import { CARD_W, MIN_CARD_H, GRID_LEFT, GRID_TOP, COL_GAP, ROW_GAP, FRAME_PAD, MERGE_CARD_H, CANVAS_BOTTOM_PAD } from './layout';

export interface FrameBlock {
  relMsgId: string;
  cardIds: Set<string>;
  directCardIds: Set<string>;
  childRelMsgIds: string[];
  isMerge: boolean;
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
}
interface Item {
  id: string;
  width: number;
  height: number;
  column: number;
  time: number;
  frame?: FrameBlock;
  header: number;
  children: Array<{ item: Item; x: number; y: number }>;
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
  const time = (id: string) => {
    const result = Date.parse(messages.get(id)?.createdAt ?? '');
    return Number.isFinite(result) ? result : 0;
  };
  const order = (a: Item, b: Item) => a.time - b.time || a.id.localeCompare(b.id);
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
    children.sort(order);
    const columns = [...new Set(children.map(child => child.column))].sort((a, b) => a - b);
    const columnIndexes = new Map(columns.map((column, index) => [column, index]));
    item.column = columns[0] ?? item.column;
    item.time = children.length ? Math.min(item.time, ...children.map(child => child.time)) : item.time;
    item.header = frame.hasGroupHeader ? Math.max(56, input.measuredHeights[id] ?? 56) : 0;
    const insideHeader = frame.isMerge ? MERGE_CARD_H + 8 : 0;
    const top = item.header + FRAME_PAD + insideHeader;
    const frontier = new Frontier();
    let right = GRID_LEFT + CARD_W;
    let bottom = top;
    let rowX = GRID_LEFT;
    for (const child of children) {
      const horizontal = !frame.isMerge && frame.targetLayout === 'single-row';
      const x = horizontal ? rowX : GRID_LEFT + (columnIndexes.get(child.column) ?? 0) * (CARD_W + COL_GAP);
      const y = horizontal ? top : frontier.top(x, child.width, top);
      item.children.push({ item: child, x, y });
      frontier.add(x, child.width, y + child.height + ROW_GAP);
      rowX = x + child.width + COL_GAP;
      right = Math.max(right, x + child.width);
      bottom = Math.max(bottom, y + child.height);
    }
    item.width = right + GRID_LEFT;
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
  // Frame widths are already known. Fit external annotations beside their target
  // before placement, avoiding the old full-scene measure/correct/re-measure loop.
  const constraints = new Map<string, Set<string>>();
  for (const edge of input.edges ?? []) {
    if (!['annotation', 'reference', 'notify', 'reply'].includes(edge.relationType)) continue;
    const source = rootByMember.get(edge.from.messageId);
    const target = rootByMember.get(edge.to.messageId);
    if (!source || !target || source === target || (edge.relationType === 'reply' && !frames.has(edge.to.messageId))) continue;
    if (!target.frame && !frames.has(edge.to.messageId)) continue;
    const dependents = constraints.get(target.id) ?? new Set<string>();
    dependents.add(source.id); constraints.set(target.id, dependents);
  }
  const layout: Record<string, Box> = {};
  const frameRects: Record<string, Box> = {};
  const colOf = { ...input.colOf };
  const emit = (item: Item, x: number, y: number) => {
    colOf[item.id] = Math.round((x - GRID_LEFT) / (CARD_W + COL_GAP));
    if (item.frame) {
      frameRects[item.id] = { x, y: y + item.header, width: item.width, height: item.height - item.header };
    } else layout[item.id] = { x, y, width: item.width, height: item.height };
    item.children.forEach(child => emit(child.item, x + child.x, y + child.y));
  };
  const componentParent = new Map(roots.map(root => [root.id, root.id]));
  const find = (id: string): string => {
    let root = id;
    while (componentParent.get(root) !== root) root = componentParent.get(root)!;
    while (id !== root) { const next = componentParent.get(id)!; componentParent.set(id, root); id = next; }
    return root;
  };
  const anchors = new Map<string, Set<string>>();
  for (const edge of input.edges ?? []) {
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
  for (const component of components.values()) {
    // Column numbers express ordering, not reserved empty screen space. Each
    // discussion starts at the left and occupies only its visible columns.
    const columns = [...new Set(component.map(root => root.column))].sort((a, b) => a - b);
    const columnIndexes = new Map(columns.map((column, index) => [column, index]));
    const xByRoot = new Map(component.map(root => [root.id,
      GRID_LEFT + (input.edges ? columnIndexes.get(root.column)! : root.column) * (CARD_W + COL_GAP)]));
    const byId = new Map(component.map(root => [root.id, root]));
    const degree = new Map(component.map(root => [root.id, 0]));
    for (const root of component) for (const id of constraints.get(root.id) ?? []) {
      degree.set(id, (degree.get(id) ?? 0) + 1);
    }
    const ready = component.filter(root => degree.get(root.id) === 0).map(root => root.id);
    for (let index = 0; index < ready.length; index++) {
      const id = ready[index];
      for (const dependent of constraints.get(id) ?? []) {
        const minimum = xByRoot.get(id)! + byId.get(id)!.width + COL_GAP;
        xByRoot.set(dependent, Math.max(xByRoot.get(dependent)!, minimum));
        const remaining = degree.get(dependent)! - 1;
        degree.set(dependent, remaining);
        if (remaining === 0) ready.push(dependent);
      }
    }
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
      emit(root, x, y);
      occupied.add(x, root.width, y + root.height + ROW_GAP);
      bottom = Math.max(bottom, y + root.height);
    }
  }
  return { layout, frameRects, colOf, canvasHeight: bottom + CANVAS_BOTTOM_PAD, measuredFrames };
}
