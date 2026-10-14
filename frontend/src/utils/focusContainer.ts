/**
 * traceContainer.ts — Container expansion logic for trace mode.
 *
 * Extracted from TopicDetailPage.tsx's inline BFS so it can be unit-tested.
 *
 * Trace-expandable relations (CLASSIFY, SUMMARY) use a two-level
 * visibility model in trace mode:
 *   1. Container card: shown when the container or its children are within range.
 *   2. Container expansion: children are added to the visible set based on
 *      hop budget and cross-reference detection.
 */

import type { DemoEdge } from './modelBridge';

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
 * distance map and traceDistance.  Pure function — does not mutate dist.
 *
 * @returns The expansion decision for this container, or null if it should not
 *          be visible at all.
 */
export function resolveOneContainer(
  containerId: string,
  children: Set<string>,
  dist: ReadonlyMap<string, number>,
  traceDistance: number,
): ContainerExpansionResult | null {
  // A reachable container is the next text-like node after a reachable child.
  // Keep an explicitly reached container at its existing distance.
  let minDist = dist.get(containerId);
  for (const childId of children) {
    const d = dist.get(childId);
    if (d !== undefined) {
      const containerDist = d + 1;
      if (minDist === undefined || containerDist < minDist) minDist = containerDist;
    }
  }
  if (minDist === undefined) return null;

  // Trace distance starts at 1; a container is expanded in trace mode.
  if (traceDistance < 1 || minDist > traceDistance) return null;

  // Card is visible when minDist is within range
  const cardVisible = true;

  // A trace view embeds the complete container frame whenever the container
  // itself or one of its members is in the visible trace window.
  const hasVisibleChild = Array.from(children).some(cid => dist.has(cid));
  const expanded = hasVisibleChild || dist.has(containerId);

  // Members are the next text-like nodes after the container.
  const newChildren: string[] = [];
  if (expanded && minDist + 1 <= traceDistance) {
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
 * and mutates `dist` in place to add cards and expanded children. MERGE and
 * ARRANGE remain ordinary relations in trace mode.
 *
 * @param dist       BFS distance map (mutated in place)
 * @param edges      All edges (container edges are filtered internally)
 * @param traceDistance   Current trace distance
 */
export function applyContainerExpansion(
  dist: Map<string, number>,
  edges: DemoEdge[],
  traceDistance: number,
  expandedContainerIds?: ReadonlySet<string>,
): void {
  const containerEdges = edges.filter(e => {
    const relationType = e.relationType.toLowerCase();
    return relationType === 'classify' || relationType === 'summary';
  });
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

  // Resolve to a fixed point so an outer container can see an inner container
  // that was discovered later in the same pass.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [relMsgId, children] of containerChildMap) {
      const result = resolveOneContainer(relMsgId, children, dist, traceDistance);
      if (!result) continue;

      // Add container card to dist
      if (!dist.has(relMsgId)) {
        dist.set(relMsgId, result.minDist);
        changed = true;
      }

      const isExplicitlyExpanded = expandedContainerIds === undefined || expandedContainerIds.has(relMsgId);
      // A collapsed trace container is the visible boundary for its direct
      // members. Remove members already reached by BFS so they cannot render
      // beside the collapsed card. Explicitly expanded containers keep them.
      if (result.expanded && !isExplicitlyExpanded) {
        for (const childId of children) {
          // A nested SUMMARY/CLASSIFY is itself the parent's direct card.
          // Only its own projection decides whether its descendants are shown.
          if (!containerChildMap.has(childId) && dist.delete(childId)) changed = true;
        }
      }

      // Add newly expanded children
      if (result.expanded && isExplicitlyExpanded) {
        for (const childId of result.newChildren) {
          const childDistance = Math.min(result.minDist + 1, traceDistance);
          if (dist.get(childId) === undefined || dist.get(childId)! > childDistance) {
            dist.set(childId, childDistance);
            changed = true;
          }
        }
      }
    }
  }
}
