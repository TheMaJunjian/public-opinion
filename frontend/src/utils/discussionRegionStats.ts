import type { DemoMessage } from './modelBridge';
import { hasDiscussionText, isDiscussionType, type DiscussionType } from './discussionTypes';

export interface DiscussionTextCounts {
  total: number;
  agree: number;
  reply: number;
  disagree: number;
  recommend?: number;
  archive?: number;
}
const empty = (): DiscussionTextCounts => ({ total: 0, agree: 0, reply: 0, disagree: 0 });
const add = (target: DiscussionTextCounts, source: DiscussionTextCounts) => {
  target.total += source.total;
  target.agree += source.agree;
  target.reply += source.reply;
  target.disagree += source.disagree;
  if (source.recommend) target.recommend = (target.recommend ?? 0) + source.recommend;
  if (source.archive) target.archive = (target.archive ?? 0) + source.archive;
};

/** Count source bodies on the complete placement forest, independently of folds.
 * Each message contributes once. Explicit placement relations determine its
 * category; only implicit organization membership inherits a parent's type.
 * Two iterative forest passes avoid scanning all descendants for every region.
 */
export function computeDiscussionRegionTextStats({ messages, parents, ownerRegions, regions, frameIds, relationTypes }: {
  messages: readonly DemoMessage[];
  parents: Readonly<Record<string, string>>;
  ownerRegions: Readonly<Record<string, string>>;
  regions: readonly { key: string; type: DiscussionType }[];
  frameIds?: ReadonlySet<string>;
  /** Actual placement relationships; annotations/references never inherit a stance count. */
  relationTypes?: Readonly<Record<string, string>>;
}): Map<string, DiscussionTextCounts> {
  const result = new Map<string, DiscussionTextCounts>(), regionTypes = new Map<string, DiscussionType>();
  for (const region of regions) if (!regionTypes.has(region.key)) {
    regionTypes.set(region.key, region.type); result.set(region.key, empty());
  }
  const byId = new Map<string, DemoMessage>();
  for (const message of messages) if (!byId.has(message.id)) byId.set(message.id, message);
  const ids = new Set(byId.keys()), parentById = new Map<string, string>();
  for (const [id, parent] of Object.entries(parents)) {
    ids.add(id); ids.add(parent);
    if (id !== parent) parentById.set(id, parent);
  }
  const regionById = new Map<string, string>();
  for (const [id, region] of Object.entries(ownerRegions)) {
    ids.add(id);
    if (regionTypes.has(region)) regionById.set(id, region);
  }

  // A malformed parent cycle is cut at one stable ID. Keep every body, while
  // never revisiting or multiplying it in a cyclic subtree.
  const finished = new Set<string>();
  for (const start of ids) {
    if (finished.has(start)) continue;
    const path: string[] = [], offsets = new Map<string, number>();
    let id: string | undefined = start;
    while (id !== undefined && !finished.has(id) && !offsets.has(id)) {
      offsets.set(id, path.length); path.push(id); id = parentById.get(id);
    }
    if (id !== undefined && offsets.has(id)) {
      let cut = id;
      for (let index = offsets.get(id)!; index < path.length; index++) if (path[index] < cut) cut = path[index];
      parentById.delete(cut);
    }
    for (const visited of path) finished.add(visited);
  }
  const children = new Map<string, string[]>(), roots: string[] = [];
  for (const id of ids) {
    const parent = parentById.get(id);
    if (parent === undefined) roots.push(id);
    else { const own = children.get(parent) ?? []; own.push(id); children.set(parent, own); }
  }

  const counts = new Map<string, DiscussionTextCounts>(), order: string[] = [];
  const regionRoots = new Map<string, string[]>(), activeRegions = new Map<string, number>();
  type Visit = { id: string; inherited?: DiscussionType; exit?: boolean };
  const stack: Visit[] = roots.map(id => ({ id }));
  while (stack.length) {
    const visit = stack.pop()!, region = regionById.get(visit.id);
    if (visit.exit) {
      if (region !== undefined) activeRegions.set(region, activeRegions.get(region)! - 1);
      continue;
    }
    const actualType = relationTypes?.[visit.id];
    const type = actualType !== undefined ? isDiscussionType(actualType) ? actualType : undefined
      : region === undefined ? visit.inherited : regionTypes.get(region)!;
    const own = empty();
    if (!frameIds?.has(visit.id) && hasDiscussionText(byId.get(visit.id))) {
      own.total = 1;
      if (type !== undefined) own[type] = 1;
    }
    counts.set(visit.id, own); order.push(visit.id);
    if (region !== undefined) {
      const active = activeRegions.get(region) ?? 0;
      // Repeated membership in the same ancestor region cannot count a subtree twice.
      if (!active) { const ownRoots = regionRoots.get(region) ?? []; ownRoots.push(visit.id); regionRoots.set(region, ownRoots); }
      activeRegions.set(region, active + 1);
    }
    stack.push({ id: visit.id, exit: true });
    for (const child of children.get(visit.id) ?? []) stack.push({ id: child, inherited: type });
  }
  for (let index = order.length - 1; index >= 0; index--) {
    const id = order[index], parent = parentById.get(id);
    if (parent !== undefined) add(counts.get(parent)!, counts.get(id)!);
  }
  for (const [region, ownRoots] of regionRoots) for (const id of ownRoots) add(result.get(region)!, counts.get(id)!);
  return result;
}
