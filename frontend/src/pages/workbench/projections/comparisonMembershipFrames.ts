import type { DemoEdge, DemoMessage } from '../../../utils/modelBridge';
import { withCorrectionContent } from '../../../utils/modelBridge';
import { projectGraphScene } from '../../../utils/graphProjection';
import { deriveCrossCanvasRelations } from '../../../utils/crossCanvasRelations';
import { isContainerType, type ContainerEffect } from '../model/containerEffect';
import type { projectComparisonSide } from './comparisonGraphProjections';
import { annotationAtReference } from '@gonglun/core';
import { comparisonChanges } from './comparisonChanges';
import { isRejectedRelation } from '../../../utils/relatedMessages';

type Side = NonNullable<ReturnType<typeof projectComparisonSide>>;

/** Rejected containers release their children into the nearest active parent. */
function membershipIndex(effect: ContainerEffect) {
  const direct = new Map(effect.memberships.map(member => [member.containerId, member.targetIds]));
  const children = new Map<string, Set<string>>(), parents = new Map<string, Set<string>>();
  for (const [id, members] of direct) {
    if (effect.rejectedContainerIds.has(id)) continue;
    const visible = new Set<string>(), pending = [...members];
    while (pending.length) {
      const member = pending.pop()!;
      if (member === id || visible.has(member)) continue;
      visible.add(member);
      if (effect.rejectedContainerIds.has(member)) pending.push(...direct.get(member) ?? []);
    }
    children.set(id, visible);
    for (const member of visible) {
      const owners = parents.get(member) ?? new Set<string>();
      owners.add(id); parents.set(member, owners);
    }
  }
  return { direct, children, parents };
}

/** Both sides share only affected messages and the context needed to explain
 * their changes. Unrelated messages from the entering view are omitted. */
export function comparisonMembershipFrames(
  pair: { agree: Side; disagree: Side }, targetId: string,
  filterMessages?: (messages: DemoMessage[]) => DemoMessage[],
) {
  const indices = [membershipIndex(pair.agree.effect), membershipIndex(pair.disagree.effect)];
  const target = pair.agree.effect.relationById.get(targetId);
  const affected = new Set([targetId]), frameAnchors = new Set<string>();
  if (target && !isContainerType(target.relationType)) {
    for (const ref of target.targetRefs) affected.add(ref.kind === 'relation' ? ref.relationId : ref.messageId);
    if (target.sourceMessageId) {
      if (target.relationType.toUpperCase() === 'JOIN') frameAnchors.add(target.sourceMessageId);
      else affected.add(target.sourceMessageId);
    }
  }
  for (const id of new Set(indices.flatMap(index => [...index.parents.keys()]))) {
    const before = indices[0].parents.get(id) ?? new Set(), after = indices[1].parents.get(id) ?? new Set();
    if (before.size !== after.size || [...before].some(parent => !after.has(parent))) affected.add(id);
  }
  const annotated = pair.agree.effect.msgMap.get(targetId);
  if (annotated && annotationAtReference(annotated, { messageId: targetId })) {
    // Keep peers whose order/region changes under the mutually exclusive mark.
    // Otherwise shrinking the canvas to one card would conceal the ordering effect.
    for (const change of comparisonChanges(pair.agree, pair.disagree)) {
      if (change.reasons.includes('顺序或区域')) affected.add(change.id);
    }
  }
  const endpointIds = new Map<string, Set<string>>();
  for (const side of [pair.agree, pair.disagree]) for (const edge of side.effect.edges) {
    if (isContainerType(edge.relationType)) continue;
    const endpoints = endpointIds.get(edge.relationMessageId) ?? new Set<string>();
    for (const id of [edge.from.messageId, edge.to.messageId]) if (!id.startsWith('anon:')) endpoints.add(id);
    endpointIds.set(edge.relationMessageId, endpoints);
  }
  // A moved category can carry many descendants. Include them all once, even
  // when they came from different categories or ownership contains a cycle.
  const pending = [...affected];
  for (let i = 0; i < pending.length; i++) {
    const members = [...indices.flatMap(index => index.direct.get(pending[i]) ?? []), ...endpointIds.get(pending[i]) ?? []];
    for (const member of members) if (!affected.has(member)) {
      affected.add(member); pending.push(member);
    }
  }
  const ids = new Set([...affected, ...frameAnchors]);
  // Collect all affected paths into one tree per side. A shared ancestor has
  // one ID/frame, even when several differences lie inside different children.
  // Do not pull in siblings merely because a parent opens.
  const paths = [...ids];
  for (let i = 0; i < paths.length; i++) for (const index of indices) {
    for (const parent of index.parents.get(paths[i]) ?? []) {
      frameAnchors.add(parent);
      if (!ids.has(parent)) { ids.add(parent); paths.push(parent); }
    }
  }
  for (const id of affected) if (isContainerType(pair.agree.effect.relationById.get(id)?.relationType)) frameAnchors.add(id);

  function project(side: Side, index: ReturnType<typeof membershipIndex>) {
    const { effect } = side;
    const allowed = new Map((filterMessages?.(effect.messages) ?? effect.messages)
      // Review the effective drawing. An inactive annotation has no edge and
      // must not acquire an unrelated body card just to retain its record.
      .filter(message => message.relationType !== 'annotation' || !effect.suppressed.has(message.id))
      .map(message => [message.id, message]));
    const visible = new Set([...ids].filter(id => allowed.has(id)));
    // Recover decorations and connections whose anchors have just become
    // visible, using only this side's effective, filtered records.
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of effect.edges) {
        if (isContainerType(edge.relationType) || visible.has(edge.relationMessageId) || !allowed.has(edge.relationMessageId)
          || !visible.has(edge.to.messageId) || !edge.from.messageId.startsWith('anon:') && !visible.has(edge.from.messageId)) continue;
        visible.add(edge.relationMessageId); changed = true;
      }
      // Rejected connections have no effective edge, but their retained record
      // still explains the relationship between the affected endpoints.
      for (const message of allowed.values()) {
        if (visible.has(message.id) || !isRejectedRelation(message, effect.suppressed)) continue;
        const targets = (message.targetRefs ?? []).map(ref => ref.kind === 'relation' ? ref.relationId : ref.messageId);
        if (!targets.length || targets.some(id => !visible.has(id)) || message.sourceMessageId && !visible.has(message.sourceMessageId)) continue;
        visible.add(message.id); changed = true;
      }
    }
    const expandedFrameIds = new Set([...frameAnchors].filter(id => visible.has(id) && !effect.rejectedContainerIds.has(id)));
    const messages = [...visible].map(id => {
      const message = allowed.get(id)!, version = side.corrections.get(id)?.current;
      return version ? withCorrectionContent(message, version.content, version.changes, version.snapshot) : message;
    });
    const edges: DemoEdge[] = effect.edges.filter(edge => !isContainerType(edge.relationType)
      && visible.has(edge.relationMessageId) && visible.has(edge.to.messageId)
      && (edge.from.messageId.startsWith('anon:') || visible.has(edge.from.messageId)));
    for (const [owner, members] of index.children) {
      if (!visible.has(owner)) continue;
      const relationType = effect.msgMap.get(owner)!.relationType!;
      for (const member of members) if (visible.has(member)) edges.push({
        id: `comparison-membership:${owner}:${member}`, relationMessageId: owner, relationType, relationLabel: relationType,
        from: { messageId: `anon:${owner}`, selection: { kind: 'whole' } },
        to: { messageId: member, selection: { kind: 'whole' } },
      });
    }
    const scene = projectGraphScene({ messages, edges, expandedFrameIds, traceExpandedFrameIds: new Set(),
      isTraceWindow: false, rejectedContainerIds: effect.rejectedContainerIds, rejectedRelationIds: effect.suppressed });
    const crossCanvasRelations = deriveCrossCanvasRelations({ edges: side.context.relatedEdges,
      visibleMessageIds: new Set([...scene.normalIds, ...scene.frameBlocks.map(frame => frame.relMsgId)]), renderedEdges: scene.layoutEdges });
    return { ...side, messages, edges, context: { ...side.context, expandedFrameIds, crossCanvasRelations } };
  }
  return { agree: project(pair.agree, indices[0]), disagree: project(pair.disagree, indices[1]) };
}
