/**
 * focusContainer.ts — Container expansion logic for focus mode.
 *
 * Extracted from TopicDetailPage.tsx's inline BFS so it can be unit-tested.
 *
 * Container-type relations (CLASSIFY, MERGE, SUMMARY) use a two-level
 * visibility model in focus mode:
 *   1. Container card: shown when the container or its children are within range.
 *   2. Container expansion: children are added to the visible set based on
 *      hop budget and cross-reference detection.
 */

import type { DemoEdge } from './modelBridge';
import { getPresentationSpec } from '../types';

/**
 * Result of resolving container expansion for a single container relation.
 * Exported for testing.
 */
export interface ContainerExpansionResult {
  /** The container relation message ID */
  containerId: string;
  /** Minimum BFS distance from focus to the container or any of its children */
  minDist: number;
  /** Whether the container card/frame should be visible */
  cardVisible: boolean;
  /** Whether the container's children should be expanded into the visible set */
  expanded: boolean;
  /** Child IDs that will be newly added to dist (not already present) */
  newChildren: string[];
}

/**
 * Compute container expansion for a single container, given the current BFS
 * distance map and focusHop.  Pure function — does not mutate dist.
 *
 * @returns The expansion decision for this container, or null if it should not
 *          be visible at all.
 */
export function resolveOneContainer(
  containerId: string,
  children: Set<string>,
  dist: ReadonlyMap<string, number>,
  focusHop: number,
): ContainerExpansionResult | null {
  // Find minimum distance: container itself + all its children
  let minDist = dist.get(containerId);
  for (const childId of children) {
    const d = dist.get(childId);
    if (d !== undefined && (minDist === undefined || d < minDist)) minDist = d;
  }
  if (minDist === undefined) return null;

  // At focusHop=0, only the focus message itself should be visible.
  if (focusHop === 0) return null;

  // Card is visible when minDist is within range
  const cardVisible = true;

  // Expand children when:
  //   - Full expansion: minDist + 1 <= focusHop AND focusHop >= 2
  //   - Cross-reference: minDist > 0 AND children already visible
  const hasVisibleChild = Array.from(children).some(cid => dist.has(cid));
  const fullExpand = minDist + 1 <= focusHop && focusHop >= 2;
  const crossRefExpand = minDist > 0 && hasVisibleChild;
  const expanded = fullExpand || crossRefExpand;

  // Children that would be newly added
  const newChildren: string[] = [];
  if (expanded) {
    for (const childId of children) {
      if (!dist.has(childId)) {
        newChildren.push(childId);
      }
    }
  }

  return { containerId, minDist, cardVisible, expanded, newChildren };
}

/**
 * Apply container expansion logic to the distance map.
 *
 * Processes all container-type edges, groups them by container relation ID,
 * and mutates `dist` in place to add container cards and expanded children.
 *
 * @param dist       BFS distance map (mutated in place)
 * @param edges      All edges (container edges are filtered internally)
 * @param focusHop   Current focus hop distance
 */
export function applyContainerExpansion(
  dist: Map<string, number>,
  edges: DemoEdge[],
  focusHop: number,
): void {
  const containerEdges = edges.filter(e => getPresentationSpec(e.relationType).isContainer);
  if (containerEdges.length === 0) return;

  // Group container edges by relation message ID
  const containerChildMap = new Map<string, Set<string>>();
  for (const e of containerEdges) {
    let children = containerChildMap.get(e.relationMessageId);
    if (!children) {
      children = new Set();
      containerChildMap.set(e.relationMessageId, children);
    }
    if (!e.from.messageId.startsWith('anon:')) children.add(e.from.messageId);
    children.add(e.to.messageId);
  }

  for (const [relMsgId, children] of containerChildMap) {
    const result = resolveOneContainer(relMsgId, children, dist, focusHop);
    if (!result) continue;

    // Add container card to dist
    if (!dist.has(relMsgId)) {
      dist.set(relMsgId, result.minDist);
    }

    // Add newly expanded children
    if (result.expanded) {
      for (const childId of result.newChildren) {
        dist.set(childId, Math.min(result.minDist + 1, focusHop));
      }
    }
  }
}
