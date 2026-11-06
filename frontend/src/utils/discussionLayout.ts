import type { DemoEdge, DemoMessage } from './modelBridge';
import type { DiscussionTextCounts } from './discussionRegionStats';
import { isDiscussionType, type DiscussionType } from './discussionTypes';

export interface DiscussionLayoutItem {
  id: string;
  width: number;
  height: number;
  time?: number;
  sequence?: number;
  /** Visible native frame controls extend beyond the frame rectangle. */
  outset?: number;
  /** Space above the frame for controls that must also clear a region title. */
  topOutset?: number;
}
export interface DiscussionPosition { x: number; y: number; column: number }
export interface DiscussionRegionInput {
  key: string;
  headerWidth?: number;
  targetId: string;
  type: DiscussionType;
  collapsed: boolean;
  directCount: number;
}
export interface DiscussionRegionGeometry extends DiscussionRegionInput {
  x: number; y: number; width: number; height: number; headerHeight: number;
  textCounts?: DiscussionTextCounts;
}
export const DISCUSSION_REGION_HEADER = 24;
export const DISCUSSION_REGION_FOOTER = 24;
export const DISCUSSION_REGION_PADDING = 4;
export const DISCUSSION_REGION_MIN_WIDTH = 200;
type Branch = 'above' | 'right' | 'below' | 'recommend' | 'archive';
const branchOrder: readonly Branch[] = ['above', 'right', 'below', 'recommend', 'archive'];
type Parent = { id: string; branch: Branch; edge: DemoEdge; priority: number; time: number; sequence: number };
type ChildPosition = { id: string; x: number; y: number; column: number };
type Measured = { width: number; height: number; rootX: number; rootY: number; children: ChildPosition[]; regions: DiscussionRegionGeometry[] };
const branches: Partial<Record<DemoEdge['relationType'], { branch: Branch; priority: number }>> = {
  agree: { branch: 'above', priority: 0 }, disagree: { branch: 'below', priority: 0 },
  recommend: { branch: 'recommend', priority: 0 }, archive: { branch: 'archive', priority: 0 },
  reply: { branch: 'right', priority: 1 },
  reference: { branch: 'right', priority: 2 }, annotation: { branch: 'right', priority: 2 }, notify: { branch: 'right', priority: 2 },
};

/**
 * Place measured rectangles, not semantic messages. Edges must already use the
 * native stance/layout projection. Secondary edges remain untouched: the stable
 * primary forest controls position only, never authorship, votes or membership.
 */
export function layoutDiscussion(items: readonly DiscussionLayoutItem[], edges: readonly DemoEdge[],
  { columnGap = 100, rowGap = 38, relationCatalog, regions = [], textIds }: { columnGap?: number; rowGap?: number;
    regions?: readonly DiscussionRegionInput[];
    textIds?: ReadonlySet<string>;
    relationCatalog?: ReadonlyMap<string, Pick<DemoMessage, 'createdAt' | 'sequence'>> } = {}) {
  if (!Number.isFinite(columnGap) || columnGap < 0 || !Number.isFinite(rowGap) || rowGap < 0) throw new Error('讨论布局间距无效');
  const byId = new Map<string, DiscussionLayoutItem>();
  for (const item of items) {
    if (byId.has(item.id)) throw new Error('讨论布局包含重复消息');
    if (!Number.isFinite(item.width) || item.width <= 0 || !Number.isFinite(item.height) || item.height <= 0) throw new Error('讨论布局尺寸无效');
    byId.set(item.id, item);
  }
  const regionsByTarget = new Map<string, Partial<Record<DiscussionRegionInput['type'], DiscussionRegionInput>>>();
  for (const region of regions) {
    if (!byId.has(region.targetId)) continue;
    const own = regionsByTarget.get(region.targetId) ?? {}, previous = own[region.type];
    if (!previous || region.key.localeCompare(previous.key) < 0) own[region.type] = region;
    regionsByTarget.set(region.targetId, own);
  }
  const numeric = (value: number | undefined) => Number.isFinite(value) ? value! : 0;
  const ordered = [...items].sort((a, b) => numeric(a.time) - numeric(b.time)
    || numeric(a.sequence) - numeric(b.sequence) || a.id.localeCompare(b.id));
  const rank = new Map(ordered.map((item, index) => [item.id, index]));
  const chosen = new Map<string, Parent>();
  const candidates: Parent[] = [], latestByPair = new Map<string, Parent>();
  const compare = (a: Parent, b: Parent) => a.priority - b.priority
    // A later active stance may reposition a source that still has its original
    // reply. Without chronology, IDs provide a stable fallback, not a new vote.
    || (a.priority === 0 ? b.time - a.time || b.sequence - a.sequence
      || b.edge.relationMessageId.localeCompare(a.edge.relationMessageId) : 0)
    || rank.get(a.id)! - rank.get(b.id)!
    || a.edge.relationMessageId.localeCompare(b.edge.relationMessageId) || a.edge.id.localeCompare(b.edge.id)
    || a.branch.localeCompare(b.branch);
  for (const edge of edges) {
    const rule = Object.hasOwn(branches, edge.relationType) ? branches[edge.relationType] : undefined;
    const source = edge.from.messageId, target = edge.to.messageId;
    if (!rule || source === target || !byId.has(source) || !byId.has(target)) continue;
    // Ownership always follows the fully expanded layout. Folding its region
    // must not send a shared source to a secondary parent or turn it into a root.
    const record = edge.discussionOrder ?? relationCatalog?.get(edge.relationMessageId);
    const candidate = { id: target, ...rule, edge, time: Date.parse(record?.createdAt ?? '') || 0, sequence: numeric(record?.sequence) };
    if (isDiscussionType(edge.relationType)) {
      const key = JSON.stringify([source, target]), previous = latestByPair.get(key);
      if (!previous || (previous.time-candidate.time || previous.sequence-candidate.sequence || compare(candidate, previous)) < 0) latestByPair.set(key, candidate);
    } else candidates.push(candidate);
  }
  // Multiple active relationships keep their edges. Only the latest relationship
  // between this source and target decides which automatic region owns the card.
  for (const candidate of [...candidates, ...latestByPair.values()]) {
    const source = candidate.edge.from.messageId, previous = chosen.get(source);
    if (!previous || compare(candidate, previous) < 0) chosen.set(source, candidate);
  }
  // Functional-graph cycles are broken once per node, without recursive walks
  // or repeatedly searching an ancestor chain for each candidate edge.
  const finished = new Set<string>();
  for (const item of ordered) {
    if (finished.has(item.id)) continue;
    const path: string[] = [], offsets = new Map<string, number>();
    let id: string | undefined = item.id;
    while (id !== undefined && !finished.has(id) && !offsets.has(id)) {
      offsets.set(id, path.length); path.push(id); id = chosen.get(id)?.id;
    }
    if (id !== undefined && offsets.has(id)) {
      let cut = id;
      for (let index = offsets.get(id)!; index < path.length; index++) if (rank.get(path[index])! < rank.get(cut)!) cut = path[index];
      chosen.delete(cut);
    }
    for (const visited of path) finished.add(visited);
  }
  const children = new Map<string, Record<Branch, string[]>>(), roots: string[] = [];
  for (const item of ordered) {
    const parent = chosen.get(item.id);
    if (!parent) { roots.push(item.id); continue; }
    const siblings = children.get(parent.id) ?? { above: [], right: [], below: [], recommend: [], archive: [] };
    siblings[parent.branch].push(item.id); children.set(parent.id, siblings);
  }
  const traversal = [...roots];
  for (let index = 0; index < traversal.length; index++) {
    const descendants = children.get(traversal[index]);
    if (descendants) for (const branch of branchOrder) for (const id of descendants[branch]) traversal.push(id);
  }
  const measured = new Map<string, Measured>(), ownerRegionById = new Map<string, string>();
  // Resolve text availability and ownership before folds, without computing any
  // hidden subtree's width, height, regions or coordinates.
  const subtreeText = new Map<string, number>();
  for (let index = traversal.length - 1; index >= 0; index--) {
    const id = traversal[index], descendants = children.get(id);
    let count = textIds?.has(id) ? 1 : 0;
    if (descendants) for (const branch of branchOrder) for (const child of descendants[branch]) count += subtreeText.get(child) ?? 0;
    subtreeText.set(id, count);
  }
  for (const [target, own] of regionsByTarget) for (const type of Object.keys(own) as DiscussionType[]) {
    const region = own[type]!;
    const rule = branches[type]!, ids = children.get(target)?.[rule.branch] ?? [];
    const owned = ids.filter(id => chosen.get(id)!.edge.relationType === type);
    if (textIds && !owned.some(id => (subtreeText.get(id) ?? 0) > 0)) { delete own[type]; continue; }
    for (const id of owned) ownerRegionById.set(id, region.key);
  }
  const folded = new Set([...regionsByTarget.values()].flatMap(own => Object.values(own).filter(region => region.collapsed).map(region => region.key)));
  const visibleTraversal = [...roots];
  for (let index = 0; index < visibleTraversal.length; index++) {
    const descendants = children.get(visibleTraversal[index]);
    if (descendants) for (const branch of branchOrder) for (const id of descendants[branch]) {
      if (!folded.has(ownerRegionById.get(id) ?? '')) visibleTraversal.push(id);
    }
  }
  const measureBand = (ids: readonly string[], region: DiscussionRegionInput | undefined) => {
    const band = { width: 0, height: 0, children: [] as ChildPosition[], regions: [] as DiscussionRegionGeometry[] };
    // Only this primary relation's sources belong to the region. References and
    // other right-hand connections keep their ordinary layout outside it.
    const allOwned = region ? ids.filter(id => chosen.get(id)!.edge.relationType === region.type) : [];
    const owned = region?.collapsed ? [] : allOwned;
    const ownedSet = new Set(allOwned);
    if (region) {
      let width = Math.max(DISCUSSION_REGION_MIN_WIDTH, Number.isFinite(region.headerWidth) ? region.headerWidth! : 0), bodyHeight = 0;
      for (const id of owned) {
        const size = measured.get(id)!;
        band.children.push({ id, x: DISCUSSION_REGION_PADDING, y: DISCUSSION_REGION_HEADER + DISCUSSION_REGION_PADDING + bodyHeight, column: 0 });
        width = Math.max(width, size.width + DISCUSSION_REGION_PADDING * 2);
        bodyHeight += size.height + rowGap;
      }
      const height = owned.length ? DISCUSSION_REGION_HEADER + DISCUSSION_REGION_FOOTER + DISCUSSION_REGION_PADDING * 2 + bodyHeight - rowGap : DISCUSSION_REGION_HEADER;
      band.regions.push({ ...region, x: 0, y: 0, width, height, headerHeight: DISCUSSION_REGION_HEADER });
      band.width = width; band.height = height;
    }
    for (const id of ids) {
      if (ownedSet.has(id)) continue;
      const size = measured.get(id)!, y = band.height ? band.height + rowGap : 0;
      band.children.push({ id, x: 0, y, column: 0 });
      band.width = Math.max(band.width, size.width); band.height = y + size.height;
    }
    return band;
  };
  for (let index = visibleTraversal.length - 1; index >= 0; index--) {
    const id = visibleTraversal[index], item = byId.get(id)!, descendants = children.get(id);
    const own = regionsByTarget.get(id);
    const above = measureBand(descendants?.above ?? [], own?.agree), right = measureBand(descendants?.right ?? [], own?.reply), below = measureBand(descendants?.below ?? [], own?.disagree);
    const recommended = measureBand(descendants?.recommend ?? [], own?.recommend), archived = measureBand(descendants?.archive ?? [], own?.archive);
    // A region already supplies the inset around its children. Frame bounds
    // include their own padding; do not add a second ring of empty space here.
    const outset = ownerRegionById.has(id) ? 0 : Math.max(0, item.outset ?? 0);
    const topOutset = Math.max(outset, item.topOutset ?? 0);
    const result: Measured = { width: item.width + outset * 2, height: item.height + topOutset + outset,
      rootX: outset, rootY: topOutset, children: [], regions: [] };
    // Every response advances one column. Stance changes its vertical band,
    // never moves it above/below the original card in the original column.
    let y = 0;
    const x = outset + item.width + columnGap;
    for (const band of [above, right, below, recommended, archived]) {
      if (!band.height) continue;
      result.width = Math.max(result.width, x + band.width);
      for (const child of band.children) result.children.push({ ...child, x: x + child.x, y: y + child.y, column: 1 });
      for (const region of band.regions) result.regions.push({ ...region, x: x + region.x, y: y + region.y });
      result.height = Math.max(result.height, y + band.height);
      y += band.height + rowGap;
    }
    measured.set(id, result);
  }
  const positions = new Map<string, DiscussionPosition>(), order: string[] = [], regionGeometry: DiscussionRegionGeometry[] = [];
  let width = 0, height = 0;
  for (const root of roots) {
    const rootSize = measured.get(root)!;
    const stack = [{ id: root, x: 0, y: height, column: 0 }];
    while (stack.length) {
      const location = stack.pop()!, size = measured.get(location.id)!;
      positions.set(location.id, { x: location.x + size.rootX, y: location.y + size.rootY, column: location.column });
      order.push(location.id);
      for (const region of size.regions) regionGeometry.push({ ...region, x: location.x + region.x, y: location.y + region.y });
      for (let index = size.children.length - 1; index >= 0; index--) {
        const child = size.children[index];
        stack.push({ id: child.id, x: location.x + child.x, y: location.y + child.y, column: location.column + child.column });
      }
    }
    width = Math.max(width, rootSize.width);
    height += rootSize.height + rowGap;
  }
  if (roots.length) height -= rowGap;
  const hiddenIds = ordered.filter(item => !positions.has(item.id)).map(item => item.id);
  return { positions, width, height, order, parent: new Map([...chosen].map(([id, value]) => [id, value.id])),
    parentTypes: new Map([...chosen].map(([id, value]) => [id, value.edge.relationType])),
    ownerRegionById, hiddenIds, regions: regionGeometry, measuredItems: measured.size };
}
