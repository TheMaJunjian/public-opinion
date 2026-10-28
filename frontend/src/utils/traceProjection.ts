import type { DemoEdge, DemoMessage } from './modelBridge';
import { isTraceTextLikeMessage } from './modelBridge';
import { getPresentationSpec } from '../types';
import {traceRange,type TraceDirection} from './traceRange';

export interface TraceContainerMembership {
  containerId: string;
  relationType: DemoEdge['relationType'];
  targetIds: string[];
}

export interface TraceProjectionInput {
  messages: DemoMessage[];
  edges: DemoEdge[];
  containerMemberships?: TraceContainerMembership[];
  excludedRelationIds?: ReadonlySet<string>;
  startIds: string[];
  distance: number;
  depths?: import('./traceRange').TraceDepths;
  direction?: TraceDirection;
  /** Deliberately browsing a traced container is separate from distance traversal. */
  expandedContainerIds?:ReadonlySet<string>;
}

export interface TraceProjection {
  messages: DemoMessage[];
  edges: DemoEdge[];
  distanceMessageIds?: ReadonlySet<string>;
  semanticMessageIds?: ReadonlySet<string>;
  ancestorContainerIds?: ReadonlySet<string>;
  expandableContainerIds: ReadonlySet<string>;
}

function getExpandableContainerIds(messages: DemoMessage[]): ReadonlySet<string> {
  return new Set(
    messages
      .filter(message => message.kind === 'relation'
        && message.relationType
        && getPresentationSpec(message.relationType).isContainer)
      .map(message => message.id),
  );
}

/**
 * Builds the ordinary GraphView input for a trace window.
 * Distance follows directed semantic connections. Rendering dependencies and
 * ancestor containers add context without creating traversal shortcuts.
 */
export function buildTraceProjection(input: TraceProjectionInput): TraceProjection {
  const { messages, edges, containerMemberships = [], excludedRelationIds = new Set<string>(), startIds, distance } = input;
  const messageMap = new Map(messages.map(message => [message.id, message]));
  const traceStartIds = new Set(startIds);
  const traceEdges = edges.filter(edge =>
    !excludedRelationIds.has(edge.relationMessageId) || traceStartIds.has(edge.relationMessageId),
  );
  const representedMembers = new Map<string, Set<string>>();
  for (const edge of traceEdges) {
    const members = representedMembers.get(edge.relationMessageId) ?? new Set<string>();
    members.add(edge.to.messageId); representedMembers.set(edge.relationMessageId, members);
  }
  for (const membership of containerMemberships) {
    if (excludedRelationIds.has(membership.containerId) && !traceStartIds.has(membership.containerId)) continue;
    if (!messageMap.has(membership.containerId)) continue;
    membership.targetIds.forEach((targetId, index) => {
      if (!messageMap.has(targetId)) return;
      const represented = representedMembers.get(membership.containerId) ?? new Set<string>();
      if (represented.has(targetId)) return;
      represented.add(targetId); representedMembers.set(membership.containerId, represented);
      traceEdges.push({
        id: `trace-membership:${membership.containerId}:${targetId}:${index}`,
        relationMessageId: membership.containerId,
        relationType: membership.relationType,
        from: { messageId: `anon:trace:${membership.containerId}`, selection: { kind: 'whole' } },
        to: { messageId: targetId, selection: { kind: 'whole' } },
        relationLabel: membership.relationType,
      });
    });
  }
  const range=traceRange(messages,traceEdges,startIds,input.depths??distance,input.direction??'both');
  const distances=range.distances;
  const visibleIds = new Set<string>(
    [...distances]
      .filter(([id, value]) => value <= distance && isTraceTextLikeMessage(messageMap.get(id)))
      .map(([id]) => id),
  );
  for (const startId of startIds) if (messageMap.has(startId)) visibleIds.add(startId);
  const distanceMessageIds = new Set(visibleIds);
  // Only a selected container may reveal its contents on explicit expansion.
  // Auto-expanding an ancestor of a traced message never enrolls its siblings.
  // These bodies are display context and do not start another distance search.
  const structuralChildren=new Map<string,Set<string>>();
  for(const edge of traceEdges)if(getPresentationSpec(edge.relationType).isContainer){
    const children=structuralChildren.get(edge.relationMessageId)??new Set<string>();children.add(edge.to.messageId);structuralChildren.set(edge.relationMessageId,children);
  }
  const expanded=input.expandedContainerIds??new Set<string>(),expandedPaths=new Set<string>(),contextQueue=[...startIds];
  for(let index=0;index<contextQueue.length;index++){
    const id=contextQueue[index];if(expandedPaths.has(id)||!expanded.has(id)&&!['merge','arrange'].includes(messageMap.get(id)?.relationType??''))continue;
    expandedPaths.add(id);
    for(const child of structuralChildren.get(id)??[]){if(!messageMap.has(child))continue;visibleIds.add(child);contextQueue.push(child);}
  }

  const nonCardRelationIds = new Set(messages
    .filter(message => message.kind === 'relation' && !isTraceTextLikeMessage(message))
    .map(message => message.id));
  const edgesByRelation = new Map<string, DemoEdge[]>();
  for (const edge of traceEdges) {
    const owned = edgesByRelation.get(edge.relationMessageId) ?? [];
    owned.push(edge); edgesByRelation.set(edge.relationMessageId, owned);
  }
  const dependencies = new Map<string, { sourceIds: string[]; targetIds: string[]; completeTargets: boolean; inlineFrame: boolean }>();
  const dependentsByMessage = new Map<string, Set<string>>();
  for (const relationId of nonCardRelationIds) {
    const ownedEdges = edgesByRelation.get(relationId) ?? [];
    const existing = (id: string) => !id.startsWith('anon:') && id !== relationId && messageMap.has(id);
    const sourceIds = [...new Set(ownedEdges.map(edge => edge.from.messageId).filter(existing))];
    const targetIds = [...new Set(ownedEdges.map(edge => edge.to.messageId).filter(existing))];
    const type = messageMap.get(relationId)?.relationType?.toLowerCase();
    const inlineFrame = type === 'merge' || type === 'arrange';
    dependencies.set(relationId, { sourceIds, targetIds, inlineFrame, completeTargets: inlineFrame || type === 'correct' });
    for (const id of [relationId, ...sourceIds, ...targetIds]) {
      const dependents = dependentsByMessage.get(id) ?? new Set<string>();
      dependents.add(relationId); dependentsByMessage.set(id, dependents);
    }
  }
  // Only revisit a relation after one of its dependencies becomes visible.
  const pending = [...nonCardRelationIds];
  const queued = new Set(pending);
  for (let index = 0; index < pending.length; index++) {
    const relationId = pending[index];
    queued.delete(relationId);
    const dependency = dependencies.get(relationId)!;
    const { sourceIds, targetIds, inlineFrame, completeTargets } = dependency;
    const endpoints = [...sourceIds, ...targetIds];
    const shouldComplete = inlineFrame
      ? visibleIds.has(relationId) || targetIds.some(id => visibleIds.has(id))
      : completeTargets
        ? endpoints.some(id => visibleIds.has(id))
        : targetIds.some(id => visibleIds.has(id) && (distances.get(id) ?? Infinity) < distance);
    if (!shouldComplete && !(endpoints.length > 0 && endpoints.every(id => visibleIds.has(id)))) continue;
    for (const id of [relationId, ...sourceIds, ...(completeTargets ? targetIds : [])]) {
      if (visibleIds.has(id)) continue;
      if(inlineFrame&&id!==relationId&&!range.ids.has(id))continue;
      // Completing a connection must not spend another hop outside the trace
      // window. Corrections retain their paired versions as one display unit.
      if (!(completeTargets && !inlineFrame) && isTraceTextLikeMessage(messageMap.get(id))
        && (distances.get(id) ?? Infinity) > distance) continue;
      visibleIds.add(id);
      for (const dependent of dependentsByMessage.get(id) ?? []) if (!queued.has(dependent)) {
        queued.add(dependent); pending.push(dependent);
      }
    }
  }

  // An enclosing organization is context, not another distance hop. Restore
  // only the path to a reached message, never its unvisited siblings.
  const parents = new Map<string, Set<string>>();
  for (const edge of traceEdges) {
    if (!getPresentationSpec(edge.relationType).isContainer || !messageMap.has(edge.relationMessageId)) continue;
    const owners = parents.get(edge.to.messageId) ?? new Set<string>();
    owners.add(edge.relationMessageId); parents.set(edge.to.messageId, owners);
  }
  const ancestorContainerIds = new Set<string>();
  for (const id of visibleIds) for (const parentId of parents.get(id) ?? []) {
    if (parentId === id || traceStartIds.has(parentId)) continue;
    visibleIds.add(parentId);
    if (['classify', 'summary'].includes(messageMap.get(parentId)?.relationType ?? '')) ancestorContainerIds.add(parentId);
  }
  const projectedMessages = messages.filter(message => visibleIds.has(message.id));
  const projectedMessageIds = new Set(projectedMessages.map(message => message.id));
  const projectedEdges = traceEdges.filter(edge => {
    const owner = edge.relationMessageId;
    if (isTraceTextLikeMessage(messageMap.get(owner))) {
      return projectedMessageIds.has(owner) && (!getPresentationSpec(edge.relationType).isContainer || projectedMessageIds.has(edge.to.messageId));
    }
    if (!projectedMessageIds.has(owner)) return false;
    const fromVisible = edge.from.messageId.startsWith('anon:') || projectedMessageIds.has(edge.from.messageId);
    const toVisible = edge.to.messageId.startsWith('anon:') || projectedMessageIds.has(edge.to.messageId);
    return fromVisible && toVisible;
  });

  // Relation labels are ordinary messages. Include them only when their edge
  // survived the same projection, without reintroducing hidden descendants.
  const relationIds = new Set(projectedEdges.map(edge => edge.relationMessageId));
  for (const relationId of relationIds) {
    if (!projectedMessageIds.has(relationId) && messageMap.has(relationId)) {
      projectedMessages.push(messageMap.get(relationId)!);
    }
  }

  return {
    messages: projectedMessages,
    edges: projectedEdges,
    distanceMessageIds,
    semanticMessageIds:range.ids,
    ancestorContainerIds,
    expandableContainerIds: getExpandableContainerIds(projectedMessages),
  };
}

export function applyTraceFrameVisibility(
  projection: TraceProjection,
  expandedContainerIds: ReadonlySet<string>,
): TraceProjection {
  const messageMap = new Map(projection.messages.map(message => [message.id, message]));
  const visibleIds = new Set(messageMap.keys());
  const childrenByRelation = new Map<string, Set<string>>();
  for (const edge of projection.edges) {
    const children = childrenByRelation.get(edge.relationMessageId) ?? new Set<string>();
    for (const id of [edge.from.messageId, edge.to.messageId]) {
      if (!id.startsWith('anon:') && id !== edge.relationMessageId && messageMap.has(id)) children.add(id);
    }
    childrenByRelation.set(edge.relationMessageId, children);
  }

  const containerIds = new Set(
    projection.messages
      .filter(message => message.kind === 'relation'
        && ['classify', 'summary'].includes(message.relationType?.toLowerCase() ?? ''))
      .map(message => message.id),
  );
  const frameIds = new Set(projection.messages.filter(message => message.kind === 'relation'
    && ['classify', 'summary', 'merge', 'arrange'].includes(message.relationType?.toLowerCase() ?? ''))
    .map(message => message.id));
  const parentByContainer = new Map<string, string>();
  for (const [parentId, children] of childrenByRelation) {
    if (!frameIds.has(parentId)) continue;
    for (const childId of children) {
      if (frameIds.has(childId) && childId !== parentId && !parentByContainer.has(childId)) {
        let ancestor: string | undefined = parentId;
        while (ancestor && ancestor !== childId) ancestor = parentByContainer.get(ancestor);
        if (ancestor) continue;
        parentByContainer.set(childId, parentId);
      }
    }
  }

  const pruneDescendants = (relationId: string, visited: Set<string>): void => {
    if (visited.has(relationId)) return;
    const nextVisited = new Set(visited).add(relationId);
    for (const childId of childrenByRelation.get(relationId) ?? []) {
      visibleIds.delete(childId);
      if (childrenByRelation.has(childId)) pruneDescendants(childId, nextVisited);
    }
  };
  const resolveContainer = (containerId: string, visited: Set<string>): void => {
    if (visited.has(containerId)) return;
    const nextVisited = new Set(visited).add(containerId);
    for (const childId of childrenByRelation.get(containerId) ?? []) {
      if (containerIds.has(containerId) && !expandedContainerIds.has(containerId)) {
        visibleIds.delete(childId);
        if (childrenByRelation.has(childId)) pruneDescendants(childId, nextVisited);
      } else {
        visibleIds.add(childId);
        if (childrenByRelation.has(childId)) {
          resolveContainer(childId, nextVisited);
        }
      }
    }
  };
  for (const containerId of projection.messages.map(message => message.id).filter(id => frameIds.has(id))) {
    const parentId = parentByContainer.get(containerId);
    // A hidden parent is still an ownership boundary. Resolving its expanded
    // children as roots would restore their members outside the ancestor frame.
    if (!parentId) resolveContainer(containerId, new Set());
  }

  let removedDependency = true;
  while (removedDependency) {
    removedDependency = false;
    const validOwners = new Set(projection.edges.filter(edge =>
      (edge.from.messageId.startsWith('anon:') || visibleIds.has(edge.from.messageId))
      && (edge.to.messageId.startsWith('anon:') || visibleIds.has(edge.to.messageId)))
      .map(edge => edge.relationMessageId));
    for (const edge of projection.edges) {
      if (!visibleIds.has(edge.relationMessageId) || isTraceTextLikeMessage(messageMap.get(edge.relationMessageId)) || validOwners.has(edge.relationMessageId)) continue;
      const relationType = messageMap.get(edge.relationMessageId)?.relationType?.toLowerCase();
      const sourceVisible = edge.from.messageId.startsWith('anon:') || visibleIds.has(edge.from.messageId);
      const targetVisible = edge.to.messageId.startsWith('anon:') || visibleIds.has(edge.to.messageId);
      if (sourceVisible && targetVisible) continue;
      visibleIds.delete(edge.relationMessageId);
      const dependencyIds = relationType === 'correct'
        ? [edge.from.messageId, edge.to.messageId]
        : [edge.from.messageId];
      for (const dependencyId of dependencyIds) {
        if (dependencyId.startsWith('anon:') || projection.distanceMessageIds?.has(dependencyId)) continue;
        visibleIds.delete(dependencyId);
      }
      removedDependency = true;
    }
  }

  const messages = projection.messages.filter(message => visibleIds.has(message.id));
  const edges = projection.edges.filter(edge => {
    if (isTraceTextLikeMessage(messageMap.get(edge.relationMessageId))) return visibleIds.has(edge.relationMessageId);
    return visibleIds.has(edge.relationMessageId)
      && (edge.from.messageId.startsWith('anon:') || visibleIds.has(edge.from.messageId))
      && (edge.to.messageId.startsWith('anon:') || visibleIds.has(edge.to.messageId));
  });
  return {
    messages,
    edges,
    distanceMessageIds: projection.distanceMessageIds,
    semanticMessageIds: projection.semanticMessageIds,
    ancestorContainerIds: projection.ancestorContainerIds,
    expandableContainerIds: getExpandableContainerIds(messages),
  };
}
