/**
 * graph.ts — Graph algorithms for the non-linear message view
 *
 * Core philosophy: messages are nodes; relation messages are also messages.
 *
 * This module provides:
 *   buildMessageTree()     - Convert messages + relations into a renderable tree
 *   computeStanceStats()   - Count support/oppose votes per message
 *   buildFocusSubgraph()   - Filter to messages within N hops of a focus set (focus mode)
 *   computeTextHops()      - BFS hop distance between text messages through relations
 */

import type { Message, Relation, MessageNode, StanceStats, TargetRef } from '../types';
import { getPresentationSpec, getTargetMessageIds } from '../types';

// ============================================================
// Tree Building
// ============================================================

/**
 * buildMessageTree — Convert a flat message list + relations into a tree structure.
 *
 * Only relations with formsTrees=true (REPLY, SUPPORT, REBUT, CORRECT, ARRANGE)
 * form parent-child tree connections.
 *
 * Convention:
 *   sourceMessageId  = child  (the message making the claim/response)
 *   targetRef.messageId = parent (the message being responded to)
 *
 * Root nodes: messages with no tree-forming parent relation.
 */
export function buildMessageTree(messages: Message[], relations: Relation[]): MessageNode[] {
  // Only take tree-forming relations that target text messages (not relation messages)
  const treeRels = relations.filter(r => {
    const spec = getPresentationSpec(r.relationType);
    return (
      spec.formsTrees &&
      r.sourceMessageId !== null &&
      r.targetRefs.some(ref => ref.kind === 'message' || ref.kind === 'text-fragment')
    );
  });

  // Build child → parent mapping (take first message target as the parent)
  const childParentMap = new Map<string, { parentId: string; relationType: string; relationId: string }>();

  for (const rel of treeRels) {
    if (!rel.sourceMessageId) continue;
    if (childParentMap.has(rel.sourceMessageId)) continue;
    const firstMessageTarget = rel.targetRefs.find(
      (r): r is Extract<TargetRef, { kind: 'message' | 'text-fragment' }> =>
        r.kind === 'message' || r.kind === 'text-fragment',
    );
    if (!firstMessageTarget) continue;
    childParentMap.set(rel.sourceMessageId, {
      parentId: firstMessageTarget.messageId,
      relationType: rel.relationType,
      relationId: rel.id,
    });
  }

  // Build parentId → children mapping
  const childrenMap = new Map<string, MessageNode[]>();
  for (const [childId, info] of childParentMap.entries()) {
    const msg = messages.find(m => m.id === childId);
    if (!msg) continue;
    const siblings = childrenMap.get(info.parentId) ?? [];
    siblings.push({
      message: msg,
      relationType: info.relationType,
      relationId: info.relationId,
      children: [],
    });
    childrenMap.set(info.parentId, siblings);
  }

  // Recursively build nodes
  function buildNode(msg: Message, relationType?: string, relationId?: string): MessageNode {
    const rawChildren = childrenMap.get(msg.id) ?? [];
    return {
      message: msg,
      relationType,
      relationId,
      children: rawChildren.map(c => buildNode(c.message, c.relationType, c.relationId)),
    };
  }

  // Root nodes: messages that are not children in any tree relation
  const rootMessages = messages.filter(m => !childParentMap.has(m.id));
  return rootMessages.map(m => buildNode(m));
}

// ============================================================
// Stance Statistics
// ============================================================

/**
 * computeStanceStats — Count support/oppose votes for each message.
 *
 * Uses the PresentationSpec stanceEffect to determine which relation types count.
 * This is extensible: adding AGREE/DISAGREE/SUPPORT/REBUT all work automatically.
 *
 * Only counts relations targeting whole messages or text fragments (not relation messages).
 */
export function computeStanceStats(messages: Message[], relations: Relation[]): Map<string, StanceStats> {
  const statsMap = new Map<string, StanceStats>();
  for (const msg of messages) {
    statsMap.set(msg.id, { support: 0, oppose: 0 });
  }

  for (const rel of relations) {
    const spec = getPresentationSpec(rel.relationType);
    if (!spec.stanceEffect) continue;

    for (const ref of rel.targetRefs) {
      if (ref.kind !== 'message' && ref.kind !== 'text-fragment') continue;
      const stats = statsMap.get(ref.messageId);
      if (!stats) continue;
      if (spec.stanceEffect === 'support') stats.support++;
      else if (spec.stanceEffect === 'oppose') stats.oppose++;
    }
  }

  return statsMap;
}

// ============================================================
// Focus Mode — Hop-Based Subgraph Filtering
// ============================================================

/**
 * computeTextHops — BFS to find all text messages within maxHops of the start set.
 *
 * Hop definition (corrected per design spec):
 *   1 hop = one relation message connecting two text messages.
 *   Distance is measured TEXT-MESSAGE to TEXT-MESSAGE through RELATION MESSAGES.
 *
 * Algorithm:
 *   Build an adjacency graph where text messages are nodes.
 *   Two text messages are adjacent if there is ANY relation that:
 *     - Has one as sourceMessageId
 *     - Has the other in its targetRefs (as message or text-fragment)
 *   Then BFS from startSet up to maxHops steps.
 *
 * @returns Set of text message IDs within maxHops of the start set
 */
export function computeTextHops(
  messages: Message[],
  relations: Relation[],
  startSet: Set<string>,
  maxHops: number,
): Set<string> {
  // Build adjacency: messageId → Set<adjacent messageId>
  const adjacency = new Map<string, Set<string>>();
  const messageIds = new Set(messages.map(m => m.id));

  for (const rel of relations) {
    const src = rel.sourceMessageId;
    if (!src || !messageIds.has(src)) continue;

    for (const ref of rel.targetRefs) {
      if (ref.kind !== 'message' && ref.kind !== 'text-fragment') continue;
      const tgt = ref.messageId;
      if (!messageIds.has(tgt)) continue;
      if (src === tgt) continue;

      if (!adjacency.has(src)) adjacency.set(src, new Set());
      if (!adjacency.has(tgt)) adjacency.set(tgt, new Set());
      adjacency.get(src)!.add(tgt);
      adjacency.get(tgt)!.add(src);
    }
  }

  // BFS
  const visited = new Set<string>(startSet);
  let frontier = new Set<string>(startSet);

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier = new Set<string>();
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          nextFrontier.add(neighbor);
        }
      }
    }
    if (nextFrontier.size === 0) break;
    frontier = nextFrontier;
  }

  return visited;
}

/**
 * buildFocusSubgraph — Returns the filtered sets of messages and relations for focus mode.
 *
 * Rules:
 *   1. Only text messages within maxHops of focusMessageIds are shown.
 *   2. A relation is shown only when ALL of its text-message endpoints are visible.
 *      (This includes recursive relations that target relation messages —
 *       those are shown when the text messages on both sides of the chain are visible.)
 *   3. Container-type relations (CLASSIFY, MERGE, SUMMARY) use a two-level visibility
 *      model: the container card is shown when any target is within range; the
 *      container's children are expanded when maxHops >= 2.
 *
 * @param messages       All text messages in the topic
 * @param relations      All relations in the topic
 * @param focusMessageIds  The "seed" message IDs for focus mode
 * @param maxHops        Maximum hop distance from focus set
 */
export function buildFocusSubgraph(
  messages: Message[],
  relations: Relation[],
  focusMessageIds: Set<string>,
  maxHops: number,
): { visibleMessages: Set<string>; visibleRelations: Set<string> } {
  const visibleMessages = computeTextHops(messages, relations, focusMessageIds, maxHops);

  // A relation is visible if:
  // - Its source message is visible, AND
  // - All of its target refs resolve to visible entities:
  //     message/text-fragment targets → the messageId must be visible
  //     relation targets              → the relation must itself be visible (recursive)
  // We resolve this iteratively (fixed-point) because of relation→relation targeting.

  const visibleRelations = new Set<string>();
  const relMap = new Map<string, Relation>(relations.map(r => [r.id, r]));

  // Container-type relations: CLASSIFY, MERGE, SUMMARY
  const CONTAINER_TYPES = new Set(['CLASSIFY', 'MERGE', 'SUMMARY']);

  // First pass: mark relations whose source + all message-targets are visible
  let changed = true;
  while (changed) {
    changed = false;
    for (const rel of relations) {
      if (visibleRelations.has(rel.id)) continue;
      // Relations with no sourceMessageId (pure-stance AGREE/DISAGREE) are always visible
      // if their targets are visible (they have no source to check).
      if (rel.sourceMessageId && !visibleMessages.has(rel.sourceMessageId)) continue;

      const isContainer = CONTAINER_TYPES.has(rel.relationType);

      const allTargetsVisible = rel.targetRefs.every(ref => {
        if (ref.kind === 'message' || ref.kind === 'text-fragment') {
          // For container relations, only need at least one target visible
          // (checked below).  Return true here to not block the every() check.
          if (isContainer) return true;
          return visibleMessages.has(ref.messageId);
        }
        if (ref.kind === 'relation') {
          // The targeted relation must itself be visible
          return visibleRelations.has(ref.relationId) || !relMap.has(ref.relationId);
        }
        return true;
      });

      // For container relations, the relation is visible if at least one
      // text-message target is in the visible set (not all targets).
      if (isContainer) {
        const anyTextTargetVisible = rel.targetRefs.some(ref =>
          (ref.kind === 'message' || ref.kind === 'text-fragment') &&
          visibleMessages.has(ref.messageId)
        );
        if (!anyTextTargetVisible) continue;
      } else if (!allTargetsVisible) {
        continue;
      }

      visibleRelations.add(rel.id);
      changed = true;

      // Container expansion: add ALL text-message targets to the visible set
      // when maxHops >= 2.  This implements the standard two-level model:
      //   distance=1 → container card visible (children hidden)
      //   distance>=2 → container expanded (all children visible)
      //
      // Note: the inline BFS in TopicDetailPage.tsx has a more precise expansion
      // rule that also expands when children are reached through cross-cutting
      // reference edges (minDist > 0 && hasVisibleChild).  That level of
      // precision requires per-message distance tracking not available here.
      if (isContainer && maxHops >= 2) {
        for (const ref of rel.targetRefs) {
          if (ref.kind === 'message' || ref.kind === 'text-fragment') {
            visibleMessages.add(ref.messageId);
          }
        }
      }
    }
  }

  return { visibleMessages, visibleRelations };
}

// ============================================================
// Helpers
// ============================================================

/**
 * getRelationTargetMessageIds — convenience wrapper for finding all text-message
 * IDs referenced by a relation's targetRefs.
 */
export function getRelationTargetMessageIds(relation: Relation): string[] {
  return getTargetMessageIds(relation.targetRefs);
}

