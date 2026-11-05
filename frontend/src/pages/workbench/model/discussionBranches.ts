import type { DemoEdge, DemoMessage } from '../../../utils/modelBridge';
import { projectStanceLayoutEdges } from '../../../utils/stanceLayout';
import { hasDiscussionText, isDiscussionType, type DiscussionType } from '../../../utils/discussionTypes';
export { projectDiscussionLayoutEdges } from '../../../utils/discussionLayoutEdges';

export type DiscussionBranchType = DiscussionType;
export interface DiscussionBranchGroup {
  key: string;
  targetId: string;
  type: DiscussionBranchType;
  directCount: number;
  /** Direct relationship records hidden on this path, not a count of deleted bodies. */
  hiddenCount: number;
  collapsed: boolean;
}
export const discussionBranchKey = (targetId: string, type: DiscussionBranchType) => JSON.stringify([targetId, type]);
const branchType = isDiscussionType;
const containerType = (value?: string) => ['classify', 'summary', 'merge', 'arrange'].includes(value ?? '');
type Arc = { to: string; group?: string };
type Branch = { group: string; target: string; record: string; source?: string };
export interface DiscussionOwnership {
  hiddenAtomIds: readonly string[];
  discussionParents: Readonly<Record<string, string>>;
  discussionOwnerRegions: Readonly<Record<string, string>>;
}

/** Source components retain all their cards, including a closed cycle with no root. */
function rootNodes(ids: readonly string[], graph: ReadonlyMap<string, readonly Arc[]>): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const [from, arcs] of graph) for (const { to } of arcs) {
    const list = reverse.get(to) ?? []; list.push(from); reverse.set(to, list);
  }
  const visited = new Set<string>(), order: string[] = [];
  for (const id of ids) {
    if (visited.has(id)) continue;
    visited.add(id);
    const stack = [{ id, next: 0 }];
    while (stack.length) {
      const current = stack[stack.length - 1], arcs = graph.get(current.id) ?? [];
      if (current.next >= arcs.length) { order.push(current.id); stack.pop(); continue; }
      const next = arcs[current.next++].to;
      if (!visited.has(next)) { visited.add(next); stack.push({ id: next, next: 0 }); }
    }
  }
  const component = new Map<string, number>();
  let count = 0;
  for (let index = order.length - 1; index >= 0; index--) {
    const id = order[index];
    if (component.has(id)) continue;
    const queue = [id]; component.set(id, count);
    for (let cursor = 0; cursor < queue.length; cursor++) for (const parent of reverse.get(queue[cursor]) ?? []) {
      if (component.has(parent)) continue;
      component.set(parent, count); queue.push(parent);
    }
    count++;
  }
  const hasParent = new Set<number>();
  for (const [from, arcs] of graph) for (const { to } of arcs) if (component.get(from) !== component.get(to)) hasParent.add(component.get(to)!);
  return new Set(ids.filter(id => !hasParent.has(component.get(id)!)));
}

/** A view-only filter. Original records, endpoint addresses and native edge IDs stay intact. */
export function projectDiscussionBranches(input: { messages: DemoMessage[]; edges: DemoEdge[]; collapsed: readonly string[]; deferVisibilityToLayout?: boolean }): {
  messageIds: Set<string>; edgeIds: Set<string>; groups: DiscussionBranchGroup[]; groupsByTarget: Map<string, DiscussionBranchGroup[]>;
  textTargetIds: Set<string>;
} {
  const { messages, edges } = input, ids = new Set(messages.map(message => message.id));
  const catalog = new Map(messages.map(message => [message.id, message]));
  const collapsed = new Set(input.collapsed), graph = new Map<string, Arc[]>(), pinned = new Set<string>();
  const branches = new Map<string, Branch>(), groups = new Map<string, DiscussionBranchGroup>(), records = new Map<string, Set<string>>();
  const link = (from: string, to: string, group?: string) => {
    if (from === to) return;
    const arcs = graph.get(from) ?? []; arcs.push({ to, ...(group ? { group } : {}) }); graph.set(from, arcs);
  };
  const pin = (id: string) => { if (ids.has(id)) pinned.add(id); };
  for (const message of messages) if (containerType(message.relationType)) pin(message.id);
  const placements = projectStanceLayoutEdges(messages, edges);
  for (let index = 0; index < edges.length; index++) {
    const original = edges[index], edge = placements[index];
    const type = edge.relationType, target = edge.to.messageId, record = edge.relationMessageId;
    const source = ids.has(edge.from.messageId) ? edge.from.messageId
      : hasDiscussionText(catalog.get(record)) ? record : undefined;
    const anonymous = edge.from.messageId.startsWith('anon:');
    if (!branchType(type) || edge.proposalOnly || !ids.has(target) || !ids.has(record) || (!source && !anonymous)) {
      // Non-discussion relationships remain independently reachable. Container
      // membership does not make every descendant a new root of this discussion.
      pin(record); pin(edge.from.messageId);
      if (!['classify', 'summary', 'merge', 'arrange', 'join'].includes(type)) pin(target);
      continue;
    }
    const key = discussionBranchKey(target, type);
    if (!groups.has(key)) groups.set(key, { key, targetId: target, type, directCount: 0, hiddenCount: 0, collapsed: collapsed.has(key) });
    const own = records.get(key) ?? new Set<string>(); own.add(record); records.set(key, own);
    branches.set(original.id, { group: key, target, record, ...(source ? { source } : {}) });
    link(target, record, key);
    if (source) link(record, source);
  }
  // With nothing folded, even malformed/isolated input is displayed as before.
  let messageIds = new Set(ids);
  if (!input.deferVisibilityToLayout && [...groups.values()].some(group => group.collapsed)) {
    messageIds = rootNodes([...ids], graph);
    for (const id of pinned) messageIds.add(id);
    const queue = [...messageIds];
    for (let cursor = 0; cursor < queue.length; cursor++) for (const arc of graph.get(queue[cursor]) ?? []) {
      if (arc.group && collapsed.has(arc.group) || messageIds.has(arc.to)) continue;
      messageIds.add(arc.to); queue.push(arc.to);
    }
  }
  const edgeIds = new Set<string>(), shown = new Map<string, Set<string>>();
  for (const edge of edges) {
    const branch = branches.get(edge.id);
    const visible = branch
      ? !collapsed.has(branch.group) && messageIds.has(branch.target) && messageIds.has(branch.record) && (!branch.source || messageIds.has(branch.source))
      : [edge.relationMessageId, edge.from.messageId, edge.to.messageId].every(id => !ids.has(id) || messageIds.has(id));
    if (!visible) continue;
    edgeIds.add(edge.id);
    if (branch) {
      const own = shown.get(branch.group) ?? new Set<string>(); own.add(branch.record); shown.set(branch.group, own);
    }
  }
  const groupsByTarget = new Map<string, DiscussionBranchGroup[]>();
  for (const group of groups.values()) {
    group.directCount = records.get(group.key)!.size;
    group.hiddenCount = group.directCount - (shown.get(group.key)?.size ?? 0);
    const list = groupsByTarget.get(group.targetId) ?? []; list.push(group); groupsByTarget.set(group.targetId, list);
  }
  // A bodyless vote must not manufacture a card for a relation label merely
  // to host an empty fold control. Find text-bearing paths once, before folds.
  const predecessors = new Map<string, string[]>();
  const connectText = (from: string, to: string) => {
    const list = predecessors.get(to) ?? []; list.push(from); predecessors.set(to, list);
  };
  for (const [from, arcs] of graph) for (const arc of arcs) connectText(from, arc.to);
  for (const edge of edges) if (containerType(edge.relationType)) connectText(edge.relationMessageId, edge.to.messageId);
  const textReachable = new Set(messages.filter(hasDiscussionText).map(message => message.id)), queue = [...textReachable];
  for (let index = 0; index < queue.length; index++) for (const id of predecessors.get(queue[index]) ?? []) {
    if (textReachable.has(id)) continue;
    textReachable.add(id); queue.push(id);
  }
  const textTargetIds = new Set<string>();
  for (const branch of branches.values()) if (textReachable.has(branch.record)) textTargetIds.add(branch.target);
  return { messageIds, edgeIds, groups: [...groups.values()], groupsByTarget, textTargetIds };
}

/** Reveal requested messages through one existing path, retaining unrelated folded branches. */
export function revealDiscussionBranches(input: { messages: DemoMessage[]; edges: DemoEdge[]; collapsed: readonly string[]; messageIds: readonly string[]; ownership?: DiscussionOwnership }): string[] {
  const { messages, edges } = input, collapsed = new Set(input.collapsed);
  if (!collapsed.size || !input.messageIds.length) return [...input.collapsed];
  if (input.ownership) {
    // Navigation follows the same fixed ownership that drew the region. A
    // secondary relationship must not reveal a card by moving it elsewhere.
    const { discussionParents, discussionOwnerRegions } = input.ownership;
    const walk = (id: string) => {
      const seen = new Set<string>();
      for (let current: string | undefined = id; current && !seen.has(current); current = discussionParents[current]) {
        seen.add(current);
        const region = discussionOwnerRegions[current];
        if (region) collapsed.delete(region);
      }
    };
    const requested = new Set(input.messageIds);
    for (const id of requested) walk(id);
    // Bodyless relationship labels have no layout atom of their own.
    for (const edge of projectStanceLayoutEdges(messages, edges)) {
      if (!requested.has(edge.relationMessageId) || discussionOwnerRegions[edge.relationMessageId]
        || !branchType(edge.relationType)) continue;
      // A retained reply can now originate inside a different stance region.
      // Reveal its current endpoints rather than relying on its old type.
      walk(edge.from.messageId);
      walk(edge.to.messageId);
      const key = discussionBranchKey(edge.to.messageId, edge.relationType);
      if (collapsed.has(key)) { collapsed.delete(key); walk(edge.to.messageId); }
    }
    return input.collapsed.filter(key => collapsed.has(key));
  }
  const visible = projectDiscussionBranches(input).messageIds;
  const requested = [...new Set(input.messageIds)].filter(id => !visible.has(id));
  if (!requested.length) return [...input.collapsed];
  const ids = new Set(messages.map(message => message.id)), forward = new Map<string, Arc[]>(), reverse = new Map<string, Arc[]>();
  const link = (from: string, to: string, group?: string) => {
    if (from === to) return;
    const next = forward.get(from) ?? []; next.push({ to, ...(group ? { group } : {}) }); forward.set(from, next);
    const previous = reverse.get(to) ?? []; previous.push({ to: from, ...(group ? { group } : {}) }); reverse.set(to, previous);
  };
  // Build once for the entire navigation request, using the same placement
  // direction as the visibility projection (not the stance's old declaration).
  for (const edge of projectStanceLayoutEdges(messages, edges)) {
    const type = edge.relationType, target = edge.to.messageId, record = edge.relationMessageId;
    const source = ids.has(edge.from.messageId) ? edge.from.messageId : undefined;
    if (!branchType(type) || edge.proposalOnly || !ids.has(target) || !ids.has(record)
      || !source && !edge.from.messageId.startsWith('anon:')) continue;
    link(target, record, discussionBranchKey(target, type));
    if (source) link(record, source);
  }
  for (const target of requested) {
    if (visible.has(target) || !ids.has(target)) continue;
    const queue = [target], seen = new Set(queue), towardTarget = new Map<string, Arc>();
    let ancestor: string | undefined;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor];
      if (visible.has(current)) { ancestor = current; break; }
      for (const parent of reverse.get(current) ?? []) {
        if (seen.has(parent.to)) continue;
        seen.add(parent.to); towardTarget.set(parent.to, { to: current, ...(parent.group ? { group: parent.group } : {}) }); queue.push(parent.to);
      }
    }
    if (ancestor === undefined) continue;
    for (let current = ancestor; towardTarget.has(current);) {
      const next = towardTarget.get(current)!;
      if (next.group) collapsed.delete(next.group);
      current = next.to;
    }
    // Opening one group can reveal several requested messages. Grow the visible
    // set through the now-open arcs instead of projecting the entire file again.
    const revealed = [ancestor];
    for (let cursor = 0; cursor < revealed.length; cursor++) for (const arc of forward.get(revealed[cursor]) ?? []) {
      if (arc.group && collapsed.has(arc.group) || visible.has(arc.to)) continue;
      visible.add(arc.to); revealed.push(arc.to);
    }
  }
  return input.collapsed.filter(key => collapsed.has(key));
}
